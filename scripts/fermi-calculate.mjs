#!/usr/bin/env node
/**
 * fermi-calculate.mjs
 * 
 * Performs Fermi estimation calculations to validate hypotheses.
 * 
 * Usage: node fermi-calculate.mjs <investigation-dir>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const investigationDir = process.argv[2];

if (!investigationDir) {
  console.error('Usage: node fermi-calculate.mjs <investigation-dir>');
  process.exit(1);
}

const hypothesesPath = join(investigationDir, 'hypotheses.json');
const clustersPath = join(investigationDir, 'clusters.json');

if (!existsSync(hypothesesPath)) {
  console.error('hypotheses.json not found. Run hypothesis generation first.');
  process.exit(1);
}

const hypothesesData = JSON.parse(readFileSync(hypothesesPath, 'utf8'));
const clustersData = existsSync(clustersPath) 
  ? JSON.parse(readFileSync(clustersPath, 'utf8')) 
  : null;

/**
 * Common Fermi estimation formulas
 */
const fermiFormulas = {
  /**
   * Race condition probability
   * P(race) = vulnerable_window / trigger_period
   */
  raceCondition: (params) => {
    const { vulnerable_window_seconds, trigger_period_seconds, operations_per_second, fleet_size } = params;
    
    const pRacePerOp = vulnerable_window_seconds / trigger_period_seconds;
    const pRacePerSecond = operations_per_second * pRacePerOp;
    const mtbfSeconds = 1 / pRacePerSecond;
    const eventsPerDayPerHost = 86400 / mtbfSeconds;
    const eventsPerDayFleet = eventsPerDayPerHost * (fleet_size || 1);
    
    return {
      formula: 'P(race) = window / period × ops/sec × 86400 × fleet',
      steps: [
        `P(race per op) = ${vulnerable_window_seconds} / ${trigger_period_seconds} = ${pRacePerOp.toExponential(2)}`,
        `P(race per sec) = ${operations_per_second} × ${pRacePerOp.toExponential(2)} = ${pRacePerSecond.toExponential(2)}`,
        `MTBF = 1 / ${pRacePerSecond.toExponential(2)} = ${mtbfSeconds.toExponential(2)} seconds`,
        `Events/day/host = 86400 / ${mtbfSeconds.toExponential(2)} = ${eventsPerDayPerHost.toFixed(2)}`,
        `Events/day (fleet) = ${eventsPerDayPerHost.toFixed(2)} × ${fleet_size || 1} = ${eventsPerDayFleet.toFixed(2)}`
      ],
      expected_rate: {
        value: eventsPerDayFleet,
        unit: 'events per day'
      }
    };
  },
  
  /**
   * Hardware failure rate
   * Events = affected_hosts × operations/sec × failure_probability × 86400
   */
  hardwareFailure: (params) => {
    const { affected_hosts, operations_per_second, observed_events_per_day } = params;
    
    // Back-calculate implied failure rate
    const impliedProbability = observed_events_per_day / (affected_hosts * operations_per_second * 86400);
    
    // Compare to known baselines
    const eccRate = 1e-12;  // With ECC
    const noEccRate = 1e-7; // Without ECC
    
    const ratioToEcc = impliedProbability / eccRate;
    const ratioToNoEcc = impliedProbability / noEccRate;
    
    return {
      formula: 'Implied P(failure) = observed / (hosts × ops/sec × 86400)',
      steps: [
        `Implied P(failure) = ${observed_events_per_day} / (${affected_hosts} × ${operations_per_second} × 86400)`,
        `= ${impliedProbability.toExponential(2)} per operation`,
        `Ratio to ECC baseline (10⁻¹²): ${ratioToEcc.toExponential(2)}x`,
        `Ratio to non-ECC baseline (10⁻⁷): ${ratioToNoEcc.toExponential(2)}x`
      ],
      expected_rate: {
        value: observed_events_per_day,
        unit: 'events per day (observed)'
      },
      analysis: ratioToEcc > 1e5 
        ? 'Implied rate far exceeds ECC baseline - likely faulty hardware'
        : ratioToNoEcc < 10 
          ? 'Implied rate within non-ECC baseline - could be random'
          : 'Implied rate elevated - possible hardware degradation'
    };
  },
  
  /**
   * Resource exhaustion rate
   * Events = requests/sec × P(exhaustion) × 86400
   */
  resourceExhaustion: (params) => {
    const { requests_per_second, resource_limit, average_usage, usage_stddev } = params;
    
    // Assume normal distribution, calculate P(usage > limit)
    // Using approximation for simplicity
    const zScore = (resource_limit - average_usage) / (usage_stddev || average_usage * 0.1);
    const pExhaustion = Math.exp(-0.5 * zScore * zScore) / Math.sqrt(2 * Math.PI);
    
    const eventsPerDay = requests_per_second * pExhaustion * 86400;
    
    return {
      formula: 'P(exhaustion) ≈ normal_tail(limit, mean, stddev)',
      steps: [
        `Z-score = (${resource_limit} - ${average_usage}) / ${usage_stddev || average_usage * 0.1} = ${zScore.toFixed(2)}`,
        `P(exhaustion) ≈ ${pExhaustion.toExponential(2)}`,
        `Events/day = ${requests_per_second} × ${pExhaustion.toExponential(2)} × 86400 = ${eventsPerDay.toFixed(2)}`
      ],
      expected_rate: {
        value: eventsPerDay,
        unit: 'events per day'
      }
    };
  },
  
  /**
   * Generic rate calculation
   */
  generic: (params) => {
    const { probability_per_operation, operations_per_second, fleet_size } = params;
    
    const eventsPerSecond = probability_per_operation * operations_per_second * (fleet_size || 1);
    const eventsPerDay = eventsPerSecond * 86400;
    
    return {
      formula: 'Events/day = P(event) × ops/sec × fleet × 86400',
      steps: [
        `Events/sec = ${probability_per_operation} × ${operations_per_second} × ${fleet_size || 1}`,
        `= ${eventsPerSecond.toExponential(2)}`,
        `Events/day = ${eventsPerSecond.toExponential(2)} × 86400 = ${eventsPerDay.toFixed(2)}`
      ],
      expected_rate: {
        value: eventsPerDay,
        unit: 'events per day'
      }
    };
  }
};

/**
 * Select appropriate formula based on hypothesis type
 */
function selectFormula(hypothesis) {
  const name = (hypothesis.name || hypothesis.hypothesis || '').toLowerCase();
  
  if (name.includes('race') || name.includes('signal') || name.includes('interrupt')) {
    return 'raceCondition';
  }
  if (name.includes('hardware') || name.includes('corruption') || name.includes('host')) {
    return 'hardwareFailure';
  }
  if (name.includes('exhaust') || name.includes('memory') || name.includes('resource')) {
    return 'resourceExhaustion';
  }
  return 'generic';
}

/**
 * Calculate observed rate from cluster data
 */
function calculateObservedRate(clusterId, clustersData) {
  if (!clustersData) return null;
  
  const cluster = clustersData.clusters.find(c => c.cluster_id === clusterId);
  if (!cluster) return null;
  
  const startDate = new Date(cluster.temporal_pattern.start_date);
  const endDate = new Date(cluster.temporal_pattern.end_date);
  const daysSpan = Math.max(1, (endDate - startDate) / (1000 * 60 * 60 * 24));
  
  return {
    value: cluster.event_count / daysSpan,
    unit: 'events per day',
    total_events: cluster.event_count,
    days_span: daysSpan
  };
}

/**
 * Calculate log ratio and verdict
 */
function calculateVerdict(expected, observed) {
  if (!expected || !observed || expected.value === 0 || observed.value === 0) {
    return {
      log_ratio: null,
      within_order_of_magnitude: false,
      verdict: 'INSUFFICIENT_DATA'
    };
  }
  
  const logRatio = Math.abs(Math.log10(expected.value / observed.value));
  
  return {
    log_ratio: logRatio,
    within_order_of_magnitude: logRatio < 1,
    verdict: logRatio < 1 ? 'PLAUSIBLE' : 'IMPLAUSIBLE'
  };
}

/**
 * Main Fermi calculation logic
 */
function main() {
  console.log('Epidemiological Fermi Validation');
  console.log('─────────────────────────────────');
  console.log('');
  
  const validations = [];
  let plausibleCount = 0;
  let implausibleCount = 0;
  
  for (const clusterHypothesis of hypothesesData.cluster_hypotheses || []) {
    const primaryHypId = clusterHypothesis.primary_hypothesis;
    const primaryHyp = clusterHypothesis.hypotheses.find(h => h.id === primaryHypId);
    
    if (!primaryHyp) continue;
    
    console.log(`Validating: ${primaryHyp.name}`);
    
    // Select formula
    const formulaType = selectFormula(primaryHyp);
    const formula = fermiFormulas[formulaType];
    
    // Get parameters (may need estimation)
    const params = primaryHyp.fermi_parameters || {};
    
    // Provide defaults for missing parameters
    const filledParams = {
      vulnerable_window_seconds: params.vulnerable_window_seconds || 1e-9,
      trigger_period_seconds: params.trigger_period_seconds || params.signal_period_seconds || 0.01,
      operations_per_second: params.operations_per_second || 1000,
      fleet_size: params.fleet_size || params.affected_hosts || 1,
      affected_hosts: params.affected_hosts || 1,
      observed_events_per_day: params.observed_events_per_day || 100,
      probability_per_operation: params.probability_per_operation || 1e-6,
      ...params
    };
    
    // Calculate expected rate
    const calculation = formula(filledParams);
    
    // Get observed rate
    const observedRate = calculateObservedRate(clusterHypothesis.cluster_id, clustersData) || {
      value: filledParams.observed_events_per_day,
      unit: 'events per day (estimated)'
    };
    
    // Calculate verdict
    const comparison = calculateVerdict(calculation.expected_rate, observedRate);
    
    if (comparison.verdict === 'PLAUSIBLE') plausibleCount++;
    else if (comparison.verdict === 'IMPLAUSIBLE') implausibleCount++;
    
    validations.push({
      cluster_id: clusterHypothesis.cluster_id,
      hypothesis_id: primaryHyp.id,
      hypothesis_name: primaryHyp.name,
      formula_type: formulaType,
      parameters: filledParams,
      calculation: {
        formula: calculation.formula,
        steps: calculation.steps,
        expected_rate: calculation.expected_rate
      },
      observed_rate: observedRate,
      comparison: {
        expected: calculation.expected_rate.value,
        observed: observedRate.value,
        log_ratio: comparison.log_ratio,
        within_order_of_magnitude: comparison.within_order_of_magnitude
      },
      verdict: comparison.verdict,
      confidence_notes: calculation.analysis || 
        (comparison.verdict === 'PLAUSIBLE' 
          ? 'Expected rate is within order of magnitude of observed'
          : comparison.verdict === 'IMPLAUSIBLE'
            ? 'Expected rate differs by more than 10x from observed'
            : 'Insufficient data for quantitative validation')
    });
    
    console.log(`  Formula: ${formulaType}`);
    console.log(`  Expected: ${calculation.expected_rate.value.toFixed(2)} ${calculation.expected_rate.unit}`);
    console.log(`  Observed: ${observedRate.value.toFixed(2)} ${observedRate.unit}`);
    console.log(`  Verdict: ${comparison.verdict === 'PLAUSIBLE' ? '✅' : comparison.verdict === 'IMPLAUSIBLE' ? '❌' : '⚠️'} ${comparison.verdict}`);
    console.log('');
  }
  
  const output = {
    fermi_metadata: {
      slug: hypothesesData.hypothesis_metadata?.slug || basename(investigationDir),
      validated_at: new Date().toISOString(),
      hypotheses_validated: validations.length,
      plausible_count: plausibleCount,
      implausible_count: implausibleCount
    },
    validations
  };
  
  const outputPath = join(investigationDir, 'fermi-validation.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  console.log('Fermi Validation Complete');
  console.log('─────────────────────────');
  console.log(`Hypotheses validated: ${validations.length}`);
  console.log(`Plausible: ${plausibleCount}`);
  console.log(`Implausible: ${implausibleCount}`);
  console.log(`Output: ${outputPath}`);
}

main();
