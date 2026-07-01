#!/usr/bin/env node
/**
 * cluster-events.mjs
 * 
 * Performs multi-dimensional correlation analysis to identify
 * distinct event populations (clusters).
 * 
 * Usage: node cluster-events.mjs <investigation-dir>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const investigationDir = process.argv[2];

if (!investigationDir) {
  console.error('Usage: node cluster-events.mjs <investigation-dir>');
  process.exit(1);
}

const classifiedPath = join(investigationDir, 'classified.json');
const featuresPath = join(investigationDir, 'features.json');

// Try classified first, fall back to features
let eventsData;
if (existsSync(classifiedPath)) {
  eventsData = JSON.parse(readFileSync(classifiedPath, 'utf8'));
} else if (existsSync(featuresPath)) {
  eventsData = JSON.parse(readFileSync(featuresPath, 'utf8'));
} else {
  console.error('No classified.json or features.json found.');
  console.error('Run extract-features.mjs or the classifier agent first.');
  process.exit(1);
}

/**
 * Group events by a field, returning counts
 */
function groupBy(events, field) {
  const groups = {};
  for (const event of events) {
    const value = getNestedValue(event, field) || 'unknown';
    groups[value] = (groups[value] || 0) + 1;
  }
  return groups;
}

/**
 * Get nested object value by dot-separated path
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

/**
 * Calculate correlation strength (concentration)
 */
function calculateConcentration(groups) {
  const total = Object.values(groups).reduce((a, b) => a + b, 0);
  if (total === 0) return { dominant: null, concentration: 0 };
  
  const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  const dominant = sorted[0][0];
  const concentration = sorted[0][1] / total;
  
  return { dominant, concentration };
}

/**
 * Build hourly histogram
 */
function buildHourlyHistogram(events) {
  const histogram = {};
  for (let h = 0; h < 24; h++) {
    histogram[h.toString().padStart(2, '0')] = 0;
  }
  
  for (const event of events) {
    const hour = new Date(event.timestamp).getHours().toString().padStart(2, '0');
    histogram[hour]++;
  }
  
  return histogram;
}

/**
 * Build daily histogram
 */
function buildDailyHistogram(events) {
  const histogram = {};
  
  for (const event of events) {
    const date = event.timestamp.split('T')[0];
    histogram[date] = (histogram[date] || 0) + 1;
  }
  
  return histogram;
}

/**
 * Find distinct start dates for patterns
 */
function findDistinctStartDates(events, categories) {
  const startDates = {};
  
  for (const category of Object.keys(categories)) {
    const categoryEvents = events.filter(e => 
      (e.classification_label || e.features?.category) === category
    );
    
    if (categoryEvents.length > 0) {
      categoryEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      startDates[category] = categoryEvents[0].timestamp;
    }
  }
  
  return startDates;
}

/**
 * Detect anomalous spikes in time series
 */
function detectSpikes(dailyHistogram) {
  const values = Object.values(dailyHistogram);
  if (values.length < 3) return [];
  
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = Math.sqrt(
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
  );
  
  const threshold = mean + 2 * stdDev;
  
  return Object.entries(dailyHistogram)
    .filter(([_, count]) => count > threshold)
    .map(([date, count]) => ({
      date,
      count,
      deviation: ((count - mean) / stdDev).toFixed(2)
    }));
}

/**
 * Build cross-tabulation matrix
 */
function buildCrossTab(events, field1, field2) {
  const matrix = {};
  
  for (const event of events) {
    const v1 = getNestedValue(event, field1) || 'unknown';
    const v2 = getNestedValue(event, field2) || 'unknown';
    
    if (!matrix[v1]) matrix[v1] = {};
    matrix[v1][v2] = (matrix[v1][v2] || 0) + 1;
  }
  
  return matrix;
}

/**
 * Identify clusters based on correlations
 */
function identifyClusters(events, correlations) {
  const clusters = [];
  const assigned = new Set();
  
  // Get classification label
  const getLabel = (e) => e.classification_label || e.features?.category || 'unknown';
  
  // Group by classification first
  const byLabel = groupBy(events, 'classification_label');
  const byCategory = events.reduce((acc, e) => {
    const cat = getLabel(e);
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(e);
    return acc;
  }, {});
  
  let clusterId = 0;
  
  for (const [category, categoryEvents] of Object.entries(byCategory)) {
    if (categoryEvents.length < 5) continue;  // Minimum cluster size
    
    // Check for infrastructure concentration
    const hostGroups = groupBy(categoryEvents, 'metadata.host');
    const regionGroups = groupBy(categoryEvents, 'metadata.region');
    const versionGroups = groupBy(categoryEvents, 'metadata.version');
    
    const hostConc = calculateConcentration(hostGroups);
    const regionConc = calculateConcentration(regionGroups);
    const versionConc = calculateConcentration(versionGroups);
    
    // Determine cluster characteristics
    const distinctiveFeatures = [];
    let clusterName = category;
    
    if (hostConc.concentration > 0.8 && hostConc.dominant !== 'unknown') {
      distinctiveFeatures.push(`${(hostConc.concentration * 100).toFixed(0)}% from host ${hostConc.dominant}`);
      clusterName = `${category}-host-${hostConc.dominant}`;
    }
    
    if (regionConc.concentration > 0.8 && regionConc.dominant !== 'unknown') {
      distinctiveFeatures.push(`${(regionConc.concentration * 100).toFixed(0)}% from region ${regionConc.dominant}`);
      if (!clusterName.includes('host')) {
        clusterName = `${category}-region-${regionConc.dominant}`;
      }
    }
    
    if (versionConc.concentration > 0.8 && versionConc.dominant !== 'unknown') {
      distinctiveFeatures.push(`${(versionConc.concentration * 100).toFixed(0)}% from version ${versionConc.dominant}`);
      if (!clusterName.includes('host') && !clusterName.includes('region')) {
        clusterName = `${category}-version-${versionConc.dominant}`;
      }
    }
    
    // Temporal pattern
    categoryEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const startDate = categoryEvents[0].timestamp;
    const endDate = categoryEvents[categoryEvents.length - 1].timestamp;
    
    distinctiveFeatures.push(`Started ${startDate.split('T')[0]}`);
    
    clusterId++;
    clusters.push({
      cluster_id: `cluster-${clusterId}`,
      name: clusterName,
      category: category,
      event_count: categoryEvents.length,
      percentage: ((categoryEvents.length / events.length) * 100).toFixed(1),
      distinctive_features: distinctiveFeatures,
      temporal_pattern: {
        start_date: startDate,
        end_date: endDate,
        distribution: 'computed'
      },
      infrastructure_correlation: {
        host: hostConc,
        region: regionConc,
        version: versionConc
      },
      event_ids: categoryEvents.map(e => e.id)
    });
  }
  
  // Sort by event count descending
  clusters.sort((a, b) => b.event_count - a.event_count);
  
  return clusters;
}

/**
 * Main clustering logic
 */
function main() {
  const events = eventsData.events;
  
  console.log('Epidemiological Cluster Analysis');
  console.log('─────────────────────────────────');
  console.log(`Events: ${events.length}`);
  console.log('');
  
  // Build correlation data
  console.log('Building correlations...');
  
  const labelField = events[0].classification_label ? 'classification_label' : 'features.category';
  
  const correlations = {
    byLabel: groupBy(events, labelField),
    byHost: groupBy(events, 'metadata.host'),
    byRegion: groupBy(events, 'metadata.region'),
    byVersion: groupBy(events, 'metadata.version')
  };
  
  // Temporal analysis
  console.log('Analyzing temporal patterns...');
  
  const hourlyHistogram = buildHourlyHistogram(events);
  const dailyHistogram = buildDailyHistogram(events);
  const spikes = detectSpikes(dailyHistogram);
  const startDates = findDistinctStartDates(events, correlations.byLabel);
  
  // Cross-tabulations
  console.log('Building cross-tabulations...');
  
  const crossTabs = {
    label_by_host: buildCrossTab(events, labelField, 'metadata.host'),
    label_by_region: buildCrossTab(events, labelField, 'metadata.region'),
    label_by_version: buildCrossTab(events, labelField, 'metadata.version')
  };
  
  // Identify clusters
  console.log('Identifying clusters...');
  
  const clusters = identifyClusters(events, correlations);
  
  // Calculate coverage
  const eventsInClusters = clusters.reduce((sum, c) => sum + c.event_count, 0);
  const coveragePercentage = ((eventsInClusters / events.length) * 100).toFixed(1);
  
  // Build output
  const output = {
    cluster_metadata: {
      slug: eventsData.extraction_metadata?.slug || eventsData.classification_metadata?.slug || basename(investigationDir),
      analyzed_at: new Date().toISOString(),
      total_events: events.length,
      clusters_identified: clusters.length,
      events_in_clusters: eventsInClusters,
      coverage_percentage: coveragePercentage
    },
    clusters,
    correlation_matrices: crossTabs,
    temporal_analysis: {
      hourly_histogram: hourlyHistogram,
      daily_histogram: dailyHistogram,
      distinct_start_dates: startDates,
      spikes
    }
  };
  
  const outputPath = join(investigationDir, 'clusters.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  // Report
  console.log('');
  console.log('Cluster Analysis Complete');
  console.log('─────────────────────────');
  console.log(`Total events: ${events.length}`);
  console.log(`Distinct clusters: ${clusters.length}`);
  console.log(`Events explained: ${eventsInClusters} (${coveragePercentage}%)`);
  console.log(`Output: ${outputPath}`);
  console.log('');
  console.log('Clusters:');
  
  clusters.forEach((cluster, i) => {
    console.log(`  ${i + 1}. ${cluster.name}: ${cluster.event_count} events (${cluster.percentage}%)`);
    cluster.distinctive_features.forEach(f => {
      console.log(`     - ${f}`);
    });
  });
  
  console.log('');
  console.log('Key questions answered:');
  console.log(`  - Distinct bugs: ${clusters.length} cluster(s) identified`);
  console.log(`  - Distinct start dates: ${Object.keys(startDates).length > 1 ? 'Yes' : 'No'}`);
  console.log(`  - Spikes detected: ${spikes.length > 0 ? `Yes (${spikes.length})` : 'No'}`);
  
  // Check for host concentration
  const hostConcentrated = clusters.some(c => c.infrastructure_correlation.host.concentration > 0.8);
  console.log(`  - Host concentration: ${hostConcentrated ? 'Yes (possible hardware issue)' : 'No'}`);
}

main();
