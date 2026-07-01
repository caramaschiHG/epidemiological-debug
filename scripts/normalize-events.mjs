#!/usr/bin/env node
/**
 * normalize-events.mjs
 * 
 * Normalizes events from various formats into a unified structure.
 * Can be run standalone or is called by ingest-events.mjs.
 * 
 * Usage: node normalize-events.mjs <input-file> <output-file>
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';

const inputFile = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile || !outputFile) {
  console.error('Usage: node normalize-events.mjs <input-file> <output-file>');
  process.exit(1);
}

/**
 * Timestamp extraction patterns
 */
const timestampPatterns = [
  // ISO 8601
  /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  // RFC 2822
  /(\w{3},?\s+\d{1,2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2})/,
  // Common log format
  /\[(\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2}\s[+-]\d{4})\]/,
  // Syslog
  /^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/,
  // Unix timestamp (seconds)
  /\b(\d{10})\b/,
  // Unix timestamp (milliseconds)
  /\b(\d{13})\b/,
  // YYYY-MM-DD HH:MM:SS
  /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/
];

/**
 * Extract timestamp from text
 */
function extractTimestamp(text) {
  for (const pattern of timestampPatterns) {
    const match = text.match(pattern);
    if (match) {
      const ts = match[1];
      
      // Handle unix timestamps
      if (/^\d{10}$/.test(ts)) {
        return new Date(parseInt(ts) * 1000).toISOString();
      }
      if (/^\d{13}$/.test(ts)) {
        return new Date(parseInt(ts)).toISOString();
      }
      
      // Try to parse as date
      try {
        const date = new Date(ts);
        if (!isNaN(date.getTime())) {
          return date.toISOString();
        }
      } catch (e) {
        // Continue to next pattern
      }
    }
  }
  
  return new Date().toISOString();
}

/**
 * Extract metadata fields from text
 */
function extractMetadata(text) {
  const metadata = {
    host: null,
    region: null,
    version: null,
    hardware_sku: null
  };
  
  // Host patterns
  const hostPatterns = [
    /host[=:]\s*["']?([a-zA-Z0-9._-]+)/i,
    /hostname[=:]\s*["']?([a-zA-Z0-9._-]+)/i,
    /server[=:]\s*["']?([a-zA-Z0-9._-]+)/i,
    /node[=:]\s*["']?([a-zA-Z0-9._-]+)/i
  ];
  
  for (const pattern of hostPatterns) {
    const match = text.match(pattern);
    if (match) {
      metadata.host = match[1];
      break;
    }
  }
  
  // Region patterns
  const regionPatterns = [
    /region[=:]\s*["']?([a-zA-Z0-9-]+)/i,
    /datacenter[=:]\s*["']?([a-zA-Z0-9-]+)/i,
    /dc[=:]\s*["']?([a-zA-Z0-9-]+)/i,
    /(us-east-\d|us-west-\d|eu-west-\d|eu-central-\d|ap-northeast-\d|ap-southeast-\d)/i
  ];
  
  for (const pattern of regionPatterns) {
    const match = text.match(pattern);
    if (match) {
      metadata.region = match[1];
      break;
    }
  }
  
  // Version patterns
  const versionPatterns = [
    /version[=:]\s*["']?v?(\d+\.\d+\.\d+)/i,
    /release[=:]\s*["']?v?(\d+\.\d+\.\d+)/i,
    /v(\d+\.\d+\.\d+)/,
    /(\d+\.\d+\.\d+[-+][a-zA-Z0-9.]+)/
  ];
  
  for (const pattern of versionPatterns) {
    const match = text.match(pattern);
    if (match) {
      metadata.version = match[1];
      break;
    }
  }
  
  // Hardware SKU patterns
  const skuPatterns = [
    /sku[=:]\s*["']?([a-zA-Z0-9_-]+)/i,
    /hardware[=:]\s*["']?([a-zA-Z0-9_-]+)/i,
    /instance[_-]?type[=:]\s*["']?([a-zA-Z0-9._-]+)/i
  ];
  
  for (const pattern of skuPatterns) {
    const match = text.match(pattern);
    if (match) {
      metadata.hardware_sku = match[1];
      break;
    }
  }
  
  return metadata;
}

/**
 * Detect event type from content
 */
function detectEventType(content) {
  const contentLower = content.toLowerCase();
  
  // Crash indicators
  const crashIndicators = [
    'sigsegv', 'sigabrt', 'sigbus', 'sigfpe', 'sigill',
    'segmentation fault', 'core dump', 'stack trace',
    'assertion failed', 'abort', 'fatal error'
  ];
  
  for (const indicator of crashIndicators) {
    if (contentLower.includes(indicator)) return 'crash';
  }
  
  // Test failure indicators
  const testIndicators = [
    'test failed', 'test error', 'assertion error',
    'expected', 'actual', 'assertequal', 'asserttrue'
  ];
  
  for (const indicator of testIndicators) {
    if (contentLower.includes(indicator)) return 'test';
  }
  
  // Metric indicators
  const metricIndicators = [
    'latency', 'throughput', 'percentile', 'p99', 'p95', 'p50',
    'cpu', 'memory', 'disk', 'network', 'gauge', 'counter'
  ];
  
  for (const indicator of metricIndicators) {
    if (contentLower.includes(indicator)) return 'metric';
  }
  
  return 'log';
}

/**
 * Generate unique event ID
 */
function generateId(content) {
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Normalize a single event
 */
function normalizeEvent(raw, source = 'unknown') {
  const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
  
  return {
    id: generateId(content),
    timestamp: extractTimestamp(content),
    source: source,
    source_type: detectEventType(content),
    raw: raw,
    metadata: extractMetadata(content)
  };
}

/**
 * Main normalization logic
 */
function main() {
  console.log('Normalizing events...');
  
  const content = readFileSync(inputFile, 'utf8');
  const events = [];
  
  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(content);
    
    if (Array.isArray(parsed)) {
      // Array of events
      for (const item of parsed) {
        events.push(normalizeEvent(item, inputFile));
      }
    } else if (parsed.events && Array.isArray(parsed.events)) {
      // Object with events array
      for (const item of parsed.events) {
        events.push(normalizeEvent(item, inputFile));
      }
    } else {
      // Single object
      events.push(normalizeEvent(parsed, inputFile));
    }
  } catch (e) {
    // Not JSON, treat as line-delimited text
    const lines = content.split('\n').filter(l => l.trim());
    
    for (const line of lines) {
      // Try to parse each line as JSON
      try {
        const obj = JSON.parse(line);
        events.push(normalizeEvent(obj, inputFile));
      } catch (e2) {
        // Plain text line
        events.push(normalizeEvent(line, inputFile));
      }
    }
  }
  
  // Deduplicate
  const uniqueEvents = Array.from(
    new Map(events.map(e => [e.id, e])).values()
  );
  
  const output = {
    normalization_metadata: {
      input_file: inputFile,
      normalized_at: new Date().toISOString(),
      total_events: uniqueEvents.length,
      duplicates_removed: events.length - uniqueEvents.length
    },
    events: uniqueEvents
  };
  
  writeFileSync(outputFile, JSON.stringify(output, null, 2));
  
  console.log(`Normalized ${uniqueEvents.length} events`);
  console.log(`Output: ${outputFile}`);
}

main();
