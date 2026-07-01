#!/usr/bin/env node
/**
 * metric-extractor.mjs
 * 
 * Specialized feature extractor for performance metric events.
 * Extracts latency percentiles, throughput, error rates, and resource usage.
 */

/**
 * Extract features from a metric event
 * @param {Object} event - The event object with raw content
 * @returns {Object} Extracted metric features
 */
export function extractMetricFeatures(event) {
  const raw = typeof event.raw === 'string' ? event.raw : event.raw;
  const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
  
  // Try to parse as structured metric first
  let structured = null;
  if (typeof raw === 'object') {
    structured = raw;
  } else {
    try {
      structured = JSON.parse(rawStr);
    } catch (e) {
      // Not JSON, will extract from text
    }
  }
  
  return {
    type: 'metric',
    metric_name: extractMetricName(rawStr, structured),
    latency_p50: extractLatencyPercentile(rawStr, structured, 50),
    latency_p95: extractLatencyPercentile(rawStr, structured, 95),
    latency_p99: extractLatencyPercentile(rawStr, structured, 99),
    latency_max: extractLatencyMax(rawStr, structured),
    throughput: extractThroughput(rawStr, structured),
    error_rate: extractErrorRate(rawStr, structured),
    error_count: extractErrorCount(rawStr, structured),
    cpu_usage: extractResourceUsage(rawStr, structured, 'cpu'),
    memory_usage: extractResourceUsage(rawStr, structured, 'memory'),
    disk_usage: extractResourceUsage(rawStr, structured, 'disk'),
    saturation_type: detectSaturation(rawStr, structured),
    category: determineMetricCategory(rawStr, structured)
  };
}

/**
 * Extract metric name
 */
function extractMetricName(content, structured) {
  if (structured?.name) return structured.name;
  if (structured?.metric) return structured.metric;
  if (structured?.metric_name) return structured.metric_name;
  
  const patterns = [
    /metric[=:\s]+["']?([a-zA-Z_][a-zA-Z0-9_.]+)/i,
    /name[=:\s]+["']?([a-zA-Z_][a-zA-Z0-9_.]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Extract latency percentile value
 */
function extractLatencyPercentile(content, structured, percentile) {
  // Check structured data first
  const pKey = `p${percentile}`;
  const pctKey = `percentile_${percentile}`;
  const latencyKey = `latency_p${percentile}`;
  
  if (structured) {
    if (structured[pKey] !== undefined) return parseFloat(structured[pKey]);
    if (structured[pctKey] !== undefined) return parseFloat(structured[pctKey]);
    if (structured[latencyKey] !== undefined) return parseFloat(structured[latencyKey]);
    if (structured.latency?.[pKey] !== undefined) return parseFloat(structured.latency[pKey]);
    if (structured.percentiles?.[percentile] !== undefined) return parseFloat(structured.percentiles[percentile]);
  }
  
  // Extract from text
  const patterns = [
    new RegExp(`p${percentile}[=:\\s]+([\\d.]+)`, 'i'),
    new RegExp(`${percentile}(?:th)?\\s*(?:percentile|pct)[=:\\s]+([\\d.]+)`, 'i'),
    new RegExp(`latency[_.]?p${percentile}[=:\\s]+([\\d.]+)`, 'i')
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return parseFloat(match[1]);
  }
  
  return null;
}

/**
 * Extract maximum latency
 */
function extractLatencyMax(content, structured) {
  if (structured?.max !== undefined) return parseFloat(structured.max);
  if (structured?.latency_max !== undefined) return parseFloat(structured.latency_max);
  if (structured?.latency?.max !== undefined) return parseFloat(structured.latency.max);
  
  const patterns = [
    /max[_\s]?latency[=:\s]+([\d.]+)/i,
    /latency[_\s]?max[=:\s]+([\d.]+)/i,
    /maximum[=:\s]+([\d.]+)\s*ms/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return parseFloat(match[1]);
  }
  
  return null;
}

/**
 * Extract throughput (QPS/RPS)
 */
function extractThroughput(content, structured) {
  if (structured?.throughput !== undefined) return parseFloat(structured.throughput);
  if (structured?.qps !== undefined) return parseFloat(structured.qps);
  if (structured?.rps !== undefined) return parseFloat(structured.rps);
  if (structured?.requests_per_second !== undefined) return parseFloat(structured.requests_per_second);
  
  const patterns = [
    /throughput[=:\s]+([\d.]+)/i,
    /qps[=:\s]+([\d.]+)/i,
    /rps[=:\s]+([\d.]+)/i,
    /requests?[_\s]?(?:per[_\s]?)?(?:second|sec|s)[=:\s]+([\d.]+)/i,
    /([\d.]+)\s*(?:req|requests?)\/s/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return parseFloat(match[1]);
  }
  
  return null;
}

/**
 * Extract error rate (percentage)
 */
function extractErrorRate(content, structured) {
  if (structured?.error_rate !== undefined) return parseFloat(structured.error_rate);
  if (structured?.errorRate !== undefined) return parseFloat(structured.errorRate);
  if (structured?.error_percentage !== undefined) return parseFloat(structured.error_percentage);
  
  const patterns = [
    /error[_\s]?rate[=:\s]+([\d.]+)/i,
    /error[_\s]?(?:percent|pct|%)[=:\s]+([\d.]+)/i,
    /([\d.]+)%?\s*error/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return parseFloat(match[1]);
  }
  
  return null;
}

/**
 * Extract error count
 */
function extractErrorCount(content, structured) {
  if (structured?.error_count !== undefined) return parseInt(structured.error_count);
  if (structured?.errors !== undefined) return parseInt(structured.errors);
  if (structured?.error_total !== undefined) return parseInt(structured.error_total);
  
  const patterns = [
    /error[_\s]?count[=:\s]+(\d+)/i,
    /errors[=:\s]+(\d+)/i,
    /(\d+)\s*errors?/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return parseInt(match[1]);
  }
  
  return null;
}

/**
 * Extract resource usage percentage
 */
function extractResourceUsage(content, structured, resource) {
  const keys = {
    cpu: ['cpu', 'cpu_usage', 'cpu_percent', 'cpuUsage'],
    memory: ['memory', 'mem', 'memory_usage', 'mem_usage', 'memoryUsage', 'mem_percent'],
    disk: ['disk', 'disk_usage', 'disk_percent', 'diskUsage']
  };
  
  for (const key of keys[resource] || []) {
    if (structured?.[key] !== undefined) return parseFloat(structured[key]);
  }
  
  const patterns = {
    cpu: [
      /cpu[_\s]?(?:usage|percent|%)?[=:\s]+([\d.]+)/i,
      /([\d.]+)%?\s*cpu/i
    ],
    memory: [
      /(?:memory|mem)[_\s]?(?:usage|percent|%)?[=:\s]+([\d.]+)/i,
      /([\d.]+)%?\s*(?:memory|mem)/i
    ],
    disk: [
      /disk[_\s]?(?:usage|percent|%)?[=:\s]+([\d.]+)/i,
      /([\d.]+)%?\s*disk/i
    ]
  };
  
  for (const pattern of patterns[resource] || []) {
    const match = content.match(pattern);
    if (match) return parseFloat(match[1]);
  }
  
  return null;
}

/**
 * Detect saturation type
 */
function detectSaturation(content, structured) {
  const cpu = extractResourceUsage(content, structured, 'cpu');
  const memory = extractResourceUsage(content, structured, 'memory');
  const disk = extractResourceUsage(content, structured, 'disk');
  
  if (cpu && cpu > 90) return 'cpu';
  if (memory && memory > 90) return 'memory';
  if (disk && disk > 90) return 'disk';
  
  const contentLower = content.toLowerCase();
  if (contentLower.includes('cpu') && (contentLower.includes('high') || contentLower.includes('saturat'))) return 'cpu';
  if (contentLower.includes('memory') && (contentLower.includes('high') || contentLower.includes('saturat'))) return 'memory';
  if (contentLower.includes('disk') && (contentLower.includes('high') || contentLower.includes('saturat'))) return 'disk';
  
  return null;
}

/**
 * Determine metric category for classification
 */
function determineMetricCategory(content, structured) {
  const latencyP99 = extractLatencyPercentile(content, structured, 99);
  const latencyP95 = extractLatencyPercentile(content, structured, 95);
  const errorRate = extractErrorRate(content, structured);
  const saturation = detectSaturation(content, structured);
  const throughput = extractThroughput(content, structured);
  
  // Check for anomalies
  if (latencyP99 && latencyP99 > 1000) return 'high-latency-p99';
  if (latencyP95 && latencyP95 > 500) return 'high-latency-p95';
  if (errorRate && errorRate > 5) return 'high-error-rate';
  if (saturation === 'cpu') return 'cpu-saturation';
  if (saturation === 'memory') return 'memory-saturation';
  if (saturation === 'disk') return 'disk-saturation';
  
  // Check content for explicit anomalies
  const contentLower = content.toLowerCase();
  if (contentLower.includes('spike') || contentLower.includes('surge')) return 'traffic-spike';
  if (contentLower.includes('degradation') || contentLower.includes('degraded')) return 'performance-degradation';
  if (contentLower.includes('timeout')) return 'timeout-increase';
  if (contentLower.includes('slow')) return 'slowdown';
  
  // If we have metrics but no anomaly, it's normal
  if (latencyP99 || throughput || errorRate) return 'metric-normal';
  
  return 'metric-unknown';
}

// CLI support
if (process.argv[1].endsWith('metric-extractor.mjs')) {
  const input = process.argv[2];
  if (input) {
    try {
      const event = JSON.parse(input);
      console.log(JSON.stringify(extractMetricFeatures(event), null, 2));
    } catch (e) {
      console.log(JSON.stringify(extractMetricFeatures({ raw: input }), null, 2));
    }
  }
}

export default extractMetricFeatures;
