#!/usr/bin/env node
/**
 * extract-features.mjs
 * 
 * Extracts analysis features from collected events based on their type.
 * 
 * Usage: node extract-features.mjs <investigation-dir>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const investigationDir = process.argv[2];

if (!investigationDir) {
  console.error('Usage: node extract-features.mjs <investigation-dir>');
  process.exit(1);
}

const eventsPath = join(investigationDir, 'events.json');
if (!existsSync(eventsPath)) {
  console.error(`events.json not found in ${investigationDir}`);
  console.error('Run ingest-events.mjs first.');
  process.exit(1);
}

const eventsData = JSON.parse(readFileSync(eventsPath, 'utf8'));

/**
 * Extract features from crash events
 */
function extractCrashFeatures(event) {
  const raw = typeof event.raw === 'string' ? event.raw : JSON.stringify(event.raw);
  const rawLower = raw.toLowerCase();
  
  // Signal type
  let signal = null;
  const signalMatch = raw.match(/SIG(SEGV|ABRT|BUS|FPE|ILL|TRAP|KILL)/i);
  if (signalMatch) signal = 'SIG' + signalMatch[1].toUpperCase();
  
  // Fault address
  let faultAddress = null;
  let faultAddressType = null;
  const addrMatch = raw.match(/(?:fault|address|rip|pc)[=:\s]+(?:0x)?([0-9a-f]+)/i);
  if (addrMatch) {
    faultAddress = addrMatch[1];
    const addr = parseInt(faultAddress, 16);
    if (addr === 0) faultAddressType = 'null';
    else if (addr < 0x1000) faultAddressType = 'low-address';
    else if (addr % 8 !== 0) faultAddressType = 'misaligned';
    else faultAddressType = 'valid-range';
  }
  
  // Stack fingerprint (hash of top frames)
  let stackFingerprint = null;
  const frameMatches = raw.match(/(?:at |#\d+\s+|in )([a-zA-Z_][a-zA-Z0-9_:]+)\s*\(/g);
  if (frameMatches) {
    const frames = frameMatches.slice(0, 5).join('|');
    stackFingerprint = createHash('md5').update(frames).digest('hex').substring(0, 8);
  }
  
  // Register state hints
  const registerState = {
    rspAligned: !rawLower.includes('rsp') || !rawLower.includes('misalign'),
    hasNullRegisters: rawLower.includes('0x0') || rawLower.includes('null'),
    hasStackCorruption: rawLower.includes('stack') && (rawLower.includes('corrupt') || rawLower.includes('smash'))
  };
  
  // Crash category
  let category = 'unknown-crash';
  if (rawLower.includes('return') && rawLower.includes('null')) category = 'return-to-null';
  else if (rawLower.includes('misalign') || rawLower.includes('unalign')) category = 'misaligned-stack';
  else if (faultAddressType === 'null') category = 'null-pointer-deref';
  else if (rawLower.includes('double free')) category = 'double-free';
  else if (rawLower.includes('use after free') || rawLower.includes('use-after-free')) category = 'use-after-free';
  else if (rawLower.includes('heap') && rawLower.includes('corrupt')) category = 'heap-corruption';
  else if (rawLower.includes('stack overflow')) category = 'stack-overflow';
  else if (signal === 'SIGABRT') category = 'assertion-abort';
  else if (signal === 'SIGFPE') category = 'arithmetic-error';
  else if (signal === 'SIGBUS') category = 'bus-error';
  
  return {
    type: 'crash',
    signal,
    fault_address: faultAddress,
    fault_address_type: faultAddressType,
    stack_fingerprint: stackFingerprint,
    register_state: registerState,
    category
  };
}

/**
 * Extract features from log error events
 */
function extractLogFeatures(event) {
  const raw = typeof event.raw === 'string' ? event.raw : JSON.stringify(event.raw);
  const rawLower = raw.toLowerCase();
  
  // Error code
  let errorCode = null;
  const codeMatch = raw.match(/(?:error|code|status)[=:\s]+(\d{3,}|[A-Z_]+\d*)/i);
  if (codeMatch) errorCode = codeMatch[1];
  
  // HTTP status if present
  let httpStatus = null;
  const httpMatch = raw.match(/(?:status|http)[=:\s]+(\d{3})/i);
  if (httpMatch) httpStatus = parseInt(httpMatch[1]);
  
  // Message hash (normalized)
  const normalizedMsg = raw
    .replace(/\d+/g, 'N')           // Replace numbers
    .replace(/[a-f0-9]{8,}/gi, 'H') // Replace hex strings
    .replace(/\s+/g, ' ')           // Normalize whitespace
    .substring(0, 200);
  const messageHash = createHash('md5').update(normalizedMsg).digest('hex').substring(0, 8);
  
  // Component detection
  let component = null;
  const compMatch = raw.match(/\[([a-zA-Z]+(?:Service|Handler|Controller|Manager)?)\]/);
  if (compMatch) component = compMatch[1];
  
  // Severity
  let severity = 'unknown';
  if (rawLower.includes('fatal') || rawLower.includes('critical')) severity = 'critical';
  else if (rawLower.includes('error')) severity = 'error';
  else if (rawLower.includes('warn')) severity = 'warning';
  else if (rawLower.includes('info')) severity = 'info';
  
  // Error category
  let category = 'unknown-error';
  if (rawLower.includes('timeout') || rawLower.includes('timed out')) category = 'timeout';
  else if (rawLower.includes('connection refused')) category = 'connection-refused';
  else if (rawLower.includes('connection reset')) category = 'connection-reset';
  else if (rawLower.includes('auth') && rawLower.includes('fail')) category = 'auth-failed';
  else if (rawLower.includes('permission denied')) category = 'permission-denied';
  else if (rawLower.includes('not found') || httpStatus === 404) category = 'not-found';
  else if (rawLower.includes('out of memory') || rawLower.includes('oom')) category = 'out-of-memory';
  else if (rawLower.includes('rate limit') || httpStatus === 429) category = 'rate-limited';
  else if (rawLower.includes('ssl') || rawLower.includes('tls') || rawLower.includes('certificate')) category = 'tls-error';
  else if (rawLower.includes('dns') || rawLower.includes('resolve')) category = 'dns-error';
  else if (httpStatus >= 500) category = 'server-error';
  else if (httpStatus >= 400) category = 'client-error';
  
  return {
    type: 'log',
    error_code: errorCode,
    http_status: httpStatus,
    message_hash: messageHash,
    component,
    severity,
    category
  };
}

/**
 * Extract features from metric events
 */
function extractMetricFeatures(event) {
  const raw = typeof event.raw === 'string' ? event.raw : event.raw;
  const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const rawLower = rawStr.toLowerCase();
  
  // Extract numeric values
  const extractNumber = (pattern) => {
    const match = rawStr.match(pattern);
    return match ? parseFloat(match[1]) : null;
  };
  
  const latencyP50 = extractNumber(/p50[=:\s]+(\d+(?:\.\d+)?)/i);
  const latencyP95 = extractNumber(/p95[=:\s]+(\d+(?:\.\d+)?)/i);
  const latencyP99 = extractNumber(/p99[=:\s]+(\d+(?:\.\d+)?)/i);
  const throughput = extractNumber(/(?:throughput|qps|rps)[=:\s]+(\d+(?:\.\d+)?)/i);
  const errorRate = extractNumber(/(?:error_rate|error%)[=:\s]+(\d+(?:\.\d+)?)/i);
  const cpuUsage = extractNumber(/cpu[=:\s]+(\d+(?:\.\d+)?)/i);
  const memoryUsage = extractNumber(/(?:memory|mem)[=:\s]+(\d+(?:\.\d+)?)/i);
  
  // Metric category
  let category = 'normal';
  if (latencyP99 && latencyP99 > 1000) category = 'high-latency';
  else if (errorRate && errorRate > 5) category = 'high-error-rate';
  else if (cpuUsage && cpuUsage > 90) category = 'cpu-saturation';
  else if (memoryUsage && memoryUsage > 90) category = 'memory-saturation';
  
  return {
    type: 'metric',
    latency_p50: latencyP50,
    latency_p95: latencyP95,
    latency_p99: latencyP99,
    throughput,
    error_rate: errorRate,
    cpu_usage: cpuUsage,
    memory_usage: memoryUsage,
    category
  };
}

/**
 * Extract features from test failure events
 */
function extractTestFeatures(event) {
  const raw = typeof event.raw === 'string' ? event.raw : JSON.stringify(event.raw);
  const rawLower = raw.toLowerCase();
  
  // Test name
  let testName = null;
  const nameMatch = raw.match(/(?:test|it|describe|spec)[=:\s]+["']?([a-zA-Z0-9_\s]+)/i);
  if (nameMatch) testName = nameMatch[1].trim();
  
  // Failure message hash
  const failureMatch = raw.match(/(?:error|failure|assert)[=:\s]+(.+?)(?:\n|$)/i);
  const failureMsg = failureMatch ? failureMatch[1] : raw;
  const failureHash = createHash('md5').update(failureMsg.substring(0, 100)).digest('hex').substring(0, 8);
  
  // Assertion type
  let assertionType = 'unknown';
  if (rawLower.includes('assertequal') || rawLower.includes('tobe')) assertionType = 'equality';
  else if (rawLower.includes('asserttrue') || rawLower.includes('tobetruthy')) assertionType = 'boolean';
  else if (rawLower.includes('assertnull') || rawLower.includes('tobenull')) assertionType = 'null-check';
  else if (rawLower.includes('assertthrows') || rawLower.includes('tothrow')) assertionType = 'exception';
  else if (rawLower.includes('timeout')) assertionType = 'timeout';
  
  // Failure category
  let category = 'unknown-test-failure';
  if (rawLower.includes('timeout')) category = 'test-timeout';
  else if (rawLower.includes('connection') || rawLower.includes('network')) category = 'test-network-issue';
  else if (rawLower.includes('fixture') || rawLower.includes('setup')) category = 'test-setup-failed';
  else if (rawLower.includes('flaky') || rawLower.includes('intermittent')) category = 'flaky-test';
  else if (rawLower.includes('assert')) category = 'assertion-failed';
  
  return {
    type: 'test',
    test_name: testName,
    failure_hash: failureHash,
    assertion_type: assertionType,
    category
  };
}

/**
 * Main extraction logic
 */
function main() {
  console.log('Epidemiological Feature Extraction');
  console.log('───────────────────────────────────');
  console.log(`Events: ${eventsData.events.length}`);
  console.log('');
  
  const typeStats = { crash: 0, log: 0, metric: 0, test: 0 };
  const categoryStats = {};
  
  const featuredEvents = eventsData.events.map(event => {
    let features;
    
    switch (event.source_type) {
      case 'crash':
        features = extractCrashFeatures(event);
        typeStats.crash++;
        break;
      case 'metric':
        features = extractMetricFeatures(event);
        typeStats.metric++;
        break;
      case 'test':
        features = extractTestFeatures(event);
        typeStats.test++;
        break;
      default:
        features = extractLogFeatures(event);
        typeStats.log++;
    }
    
    // Count categories
    categoryStats[features.category] = (categoryStats[features.category] || 0) + 1;
    
    return {
      id: event.id,
      timestamp: event.timestamp,
      source: event.source,
      metadata: event.metadata,
      features
    };
  });
  
  const output = {
    extraction_metadata: {
      slug: eventsData.collection_metadata.slug,
      extracted_at: new Date().toISOString(),
      total_events: featuredEvents.length,
      type_distribution: typeStats,
      category_distribution: categoryStats
    },
    events: featuredEvents
  };
  
  const outputPath = join(investigationDir, 'features.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  console.log('Extraction Complete');
  console.log('───────────────────');
  console.log(`Total events: ${featuredEvents.length}`);
  console.log(`Output: ${outputPath}`);
  console.log('');
  console.log('Type distribution:');
  Object.entries(typeStats).forEach(([type, count]) => {
    if (count > 0) console.log(`  ${type}: ${count}`);
  });
  console.log('');
  console.log('Top categories:');
  Object.entries(categoryStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([cat, count]) => {
      console.log(`  ${cat}: ${count}`);
    });
}

main();
