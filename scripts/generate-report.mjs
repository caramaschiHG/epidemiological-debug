#!/usr/bin/env node
/**
 * generate-report.mjs
 * 
 * Generates the final epidemiological debug report in Markdown format.
 * 
 * Usage: node generate-report.mjs <investigation-dir>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const investigationDir = process.argv[2];

if (!investigationDir) {
  console.error('Usage: node generate-report.mjs <investigation-dir>');
  process.exit(1);
}

// Read all available data files
const files = {
  state: join(investigationDir, 'STATE.md'),
  events: join(investigationDir, 'events.json'),
  features: join(investigationDir, 'features.json'),
  classified: join(investigationDir, 'classified.json'),
  clusters: join(investigationDir, 'clusters.json'),
  hypotheses: join(investigationDir, 'hypotheses.json'),
  fermi: join(investigationDir, 'fermi-validation.json')
};

const data = {};
for (const [key, path] of Object.entries(files)) {
  if (existsSync(path)) {
    if (path.endsWith('.json')) {
      data[key] = JSON.parse(readFileSync(path, 'utf8'));
    } else {
      data[key] = readFileSync(path, 'utf8');
    }
  }
}

/**
 * Format number with appropriate precision
 */
function formatNumber(n) {
  if (n === null || n === undefined) return 'N/A';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  if (n < 0.01) return n.toExponential(2);
  return n.toFixed(2);
}

/**
 * Generate executive summary section
 */
function generateExecutiveSummary() {
  const slug = data.clusters?.cluster_metadata?.slug || basename(investigationDir);
  const totalEvents = data.events?.collection_metadata?.total_events || 
                      data.clusters?.cluster_metadata?.total_events || 0;
  const clusterCount = data.clusters?.clusters?.length || 0;
  const plausibleCount = data.fermi?.fermi_metadata?.plausible_count || 0;
  const timeRange = data.events?.collection_metadata?.time_range || {};
  
  return `# Epidemiological Debug Report

## Investigation: ${slug}

**Generated:** ${new Date().toISOString()}
**Period:** ${timeRange.start || 'unknown'} — ${timeRange.end || 'now'}
**Methodology:** Population-level analysis following OpenAI Core Dump Epidemiology

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Total Events Analyzed | ${formatNumber(totalEvents)} |
| Distinct Clusters Identified | ${clusterCount} |
| Hypotheses Validated | ${data.fermi?.fermi_metadata?.hypotheses_validated || 0} |
| Plausible Root Causes | ${plausibleCount} |

${clusterCount > 1 
  ? `**Key Finding:** What appeared to be a single problem is actually **${clusterCount} distinct issues**:
${data.clusters?.clusters?.map((c, i) => `${i + 1}. ${c.name}`).join('\n') || ''}` 
  : clusterCount === 1 
    ? `**Key Finding:** Analysis identified a single coherent cluster of events.`
    : `**Warning:** No clear clusters identified. Consider gathering more data.`}
`;
}

/**
 * Generate population analysis section
 */
function generatePopulationAnalysis() {
  if (!data.clusters?.clusters) return '';
  
  let md = `
---

## Population Analysis

### Cluster Overview

| # | Cluster | Events | % | Primary Characteristic |
|---|---------|--------|---|------------------------|
`;

  data.clusters.clusters.forEach((cluster, i) => {
    const mainFeature = cluster.distinctive_features?.[0] || 'N/A';
    md += `| ${i + 1} | ${cluster.name} | ${cluster.event_count} | ${cluster.percentage}% | ${mainFeature} |\n`;
  });

  md += `
### Detailed Cluster Analysis
`;

  for (const cluster of data.clusters.clusters) {
    md += `
#### Cluster: ${cluster.name}

**Event Count:** ${cluster.event_count} (${cluster.percentage}% of total)

**Distinctive Characteristics:**
${cluster.distinctive_features?.map(f => `- ${f}`).join('\n') || '- None identified'}

**Temporal Pattern:**
- Start Date: ${cluster.temporal_pattern?.start_date || 'Unknown'}
- End Date: ${cluster.temporal_pattern?.end_date || 'Ongoing'}

**Infrastructure Correlation:**
| Dimension | Dominant Value | Concentration |
|-----------|----------------|---------------|
| Host | ${cluster.infrastructure_correlation?.host?.dominant || 'N/A'} | ${((cluster.infrastructure_correlation?.host?.concentration || 0) * 100).toFixed(0)}% |
| Region | ${cluster.infrastructure_correlation?.region?.dominant || 'N/A'} | ${((cluster.infrastructure_correlation?.region?.concentration || 0) * 100).toFixed(0)}% |
| Version | ${cluster.infrastructure_correlation?.version?.dominant || 'N/A'} | ${((cluster.infrastructure_correlation?.version?.concentration || 0) * 100).toFixed(0)}% |

`;
  }

  return md;
}

/**
 * Generate hypothesis section
 */
function generateHypothesisSection() {
  if (!data.hypotheses?.cluster_hypotheses) return '';
  
  let md = `
---

## Hypotheses and Validation

`;

  for (const ch of data.hypotheses.cluster_hypotheses) {
    const primaryHyp = ch.hypotheses.find(h => h.id === ch.primary_hypothesis);
    const fermiResult = data.fermi?.validations?.find(v => v.cluster_id === ch.cluster_id);
    
    md += `
### ${ch.cluster_name}

**Primary Hypothesis:** ${primaryHyp?.name || 'Unknown'}
**Confidence:** ${primaryHyp?.confidence || 'Unknown'}

**Evidence Supporting:**
${primaryHyp?.evidence_for?.map(e => `- ${e}`).join('\n') || '- None documented'}

**Evidence Against:**
${primaryHyp?.evidence_against?.map(e => `- ${e}`).join('\n') || '- None documented'}

`;

    if (fermiResult) {
      const verdictEmoji = fermiResult.verdict === 'PLAUSIBLE' ? '✅' : 
                          fermiResult.verdict === 'IMPLAUSIBLE' ? '❌' : '⚠️';
      
      md += `
**Fermi Validation:** ${verdictEmoji} ${fermiResult.verdict}

| Metric | Value |
|--------|-------|
| Expected Rate | ${formatNumber(fermiResult.comparison.expected)} events/day |
| Observed Rate | ${formatNumber(fermiResult.comparison.observed)} events/day |
| Log₁₀ Ratio | ${fermiResult.comparison.log_ratio?.toFixed(2) || 'N/A'} |

**Calculation:**
\`\`\`
${fermiResult.calculation.steps.join('\n')}
\`\`\`

`;
    }
  }

  return md;
}

/**
 * Generate recommendations section
 */
function generateRecommendations() {
  if (!data.clusters?.clusters || !data.fermi?.validations) return '';
  
  const recommendations = [];
  
  for (const cluster of data.clusters.clusters) {
    const fermiResult = data.fermi.validations.find(v => v.cluster_id === cluster.cluster_id);
    
    if (fermiResult?.verdict === 'PLAUSIBLE') {
      const hostConc = cluster.infrastructure_correlation?.host?.concentration || 0;
      const hostName = cluster.infrastructure_correlation?.host?.dominant;
      
      if (hostConc > 0.8 && hostName && hostName !== 'unknown') {
        recommendations.push({
          priority: 1,
          cluster: cluster.name,
          action: `Investigate/denylist host ${hostName}`,
          impact: `Resolve ~${cluster.percentage}% of events`
        });
      } else {
        recommendations.push({
          priority: 2,
          cluster: cluster.name,
          action: `Investigate root cause: ${fermiResult.hypothesis_name}`,
          impact: `Resolve ~${cluster.percentage}% of events`
        });
      }
    }
  }
  
  recommendations.sort((a, b) => a.priority - b.priority);
  
  let md = `
---

## Recommendations

| Priority | Cluster | Action | Expected Impact |
|----------|---------|--------|-----------------|
`;

  recommendations.forEach((r, i) => {
    md += `| ${i + 1} | ${r.cluster} | ${r.action} | ${r.impact} |\n`;
  });

  return md;
}

/**
 * Generate data quality section
 */
function generateDataQuality() {
  const metadata = data.events?.collection_metadata;
  if (!metadata) return '';
  
  return `
---

## Data Quality Assessment

### Collection Statistics

| Metric | Value |
|--------|-------|
| Total Events | ${metadata.total_events} |
| Sources | ${metadata.sources?.length || 0} |
| Duplicates Removed | ${metadata.duplicates_removed || 0} |

### Metadata Completeness

| Field | Coverage |
|-------|----------|
| Host | ${metadata.metadata_completeness?.host || 'N/A'} |
| Region | ${metadata.metadata_completeness?.region || 'N/A'} |
| Version | ${metadata.metadata_completeness?.version || 'N/A'} |

### Sources

${metadata.sources?.map(s => `- **${s.path}**: ${s.events_collected} events`).join('\n') || 'No source information available'}
`;
}

/**
 * Generate methodology section
 */
function generateMethodology() {
  return `
---

## Methodology

This investigation followed the epidemiological debugging methodology described in
OpenAI's "Core dump epidemiology: fixing an 18-year-old bug" (June 2026).

### Key Principles Applied

1. **Population-Level Analysis:** Analyzed ALL events, not samples
2. **Multi-Dimensional Correlation:** Checked time, host, region, version
3. **Cluster Identification:** Looked for distinct populations in the data
4. **Hypothesis Grounding:** All hypotheses based on observed correlations
5. **Fermi Validation:** Quantitatively validated primary hypotheses

### Validation Criterion

A hypothesis is considered **PLAUSIBLE** if:
\`\`\`
|log₁₀(expected_rate / observed_rate)| < 1
\`\`\`
i.e., the expected rate is within one order of magnitude of observed.

---

## Appendix: Raw Data Paths

- Events: \`${files.events}\`
- Features: \`${files.features}\`
- Classified: \`${files.classified}\`
- Clusters: \`${files.clusters}\`
- Hypotheses: \`${files.hypotheses}\`
- Fermi Validation: \`${files.fermi}\`

---

*Report generated by epidemiological-debug skill*
*Methodology: OpenAI Core Dump Epidemiology (2026)*
`;
}

/**
 * Main report generation
 */
function main() {
  console.log('Generating Epidemiological Debug Report');
  console.log('───────────────────────────────────────');
  
  const report = [
    generateExecutiveSummary(),
    generatePopulationAnalysis(),
    generateHypothesisSection(),
    generateRecommendations(),
    generateDataQuality(),
    generateMethodology()
  ].join('\n');
  
  const outputPath = join(investigationDir, 'EPIDEMIOLOGICAL-REPORT.md');
  writeFileSync(outputPath, report);
  
  console.log(`Report generated: ${outputPath}`);
  console.log('');
  
  // Also print summary to stdout
  const clusterCount = data.clusters?.clusters?.length || 0;
  const plausibleCount = data.fermi?.fermi_metadata?.plausible_count || 0;
  
  console.log('Report Summary');
  console.log('──────────────');
  console.log(`Clusters identified: ${clusterCount}`);
  console.log(`Plausible root causes: ${plausibleCount}`);
  
  if (data.clusters?.clusters) {
    console.log('');
    console.log('Top findings:');
    data.clusters.clusters.slice(0, 3).forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.name} (${c.percentage}% of events)`);
    });
  }
}

main();
