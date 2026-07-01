#!/usr/bin/env node
/**
 * ingest-events.mjs
 * 
 * Collects events from various data sources and normalizes them
 * into a unified format for epidemiological analysis.
 * 
 * Usage: node ingest-events.mjs <investigation-dir> [options]
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { execSync } from 'child_process';

const investigationDir = process.argv[2];

if (!investigationDir) {
  console.error('Usage: node ingest-events.mjs <investigation-dir>');
  process.exit(1);
}

// Read STATE.md to get data sources
const statePath = join(investigationDir, 'STATE.md');
if (!existsSync(statePath)) {
  console.error(`STATE.md not found in ${investigationDir}`);
  process.exit(1);
}

const stateContent = readFileSync(statePath, 'utf8');

/**
 * Parse data sources from STATE.md
 */
function parseDataSources(content) {
  const sources = [];
  const lines = content.split('\n');
  let inDataSources = false;
  
  for (const line of lines) {
    if (line.includes('## Data Sources')) {
      inDataSources = true;
      continue;
    }
    if (inDataSources && line.startsWith('## ')) {
      break;
    }
    if (inDataSources && line.startsWith('- ')) {
      const match = line.match(/- (.+?):\s*`?([^`]+)`?/);
      if (match) {
        sources.push({
          type: match[1].toLowerCase().trim(),
          path: match[2].trim()
        });
      }
    }
  }
  
  return sources;
}

/**
 * Parse time range from STATE.md
 */
function parseTimeRange(content) {
  const startMatch = content.match(/- Start:\s*(.+)/);
  const endMatch = content.match(/- End:\s*(.+)/);
  
  return {
    start: startMatch ? new Date(startMatch[1].trim()) : null,
    end: endMatch ? new Date(endMatch[1].trim()) : new Date()
  };
}

/**
 * Generate unique ID for an event
 */
function generateEventId(content) {
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Extract timestamp from various log formats
 */
function extractTimestamp(line) {
  // ISO 8601
  let match = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (match) return new Date(match[1]).toISOString();
  
  // Common log format: [DD/Mon/YYYY:HH:MM:SS +ZZZZ]
  match = line.match(/\[(\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2}\s[+-]\d{4})\]/);
  if (match) return new Date(match[1].replace(/(\d{2})\/(\w+)\/(\d{4})/, '$2 $1, $3')).toISOString();
  
  // Syslog format: Mon DD HH:MM:SS
  match = line.match(/^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/);
  if (match) {
    const now = new Date();
    return new Date(`${match[1]} ${now.getFullYear()}`).toISOString();
  }
  
  // Unix timestamp
  match = line.match(/(\d{10})(\.\d+)?/);
  if (match) return new Date(parseInt(match[1]) * 1000).toISOString();
  
  // Timestamp in milliseconds
  match = line.match(/(\d{13})/);
  if (match) return new Date(parseInt(match[1])).toISOString();
  
  return new Date().toISOString();
}

/**
 * Extract metadata from log line
 */
function extractMetadata(line, filePath) {
  const metadata = {
    host: null,
    region: null,
    version: null,
    hardware_sku: null
  };
  
  // Host extraction
  let match = line.match(/host[=:]\s*["']?([a-zA-Z0-9._-]+)/i);
  if (match) metadata.host = match[1];
  
  match = line.match(/hostname[=:]\s*["']?([a-zA-Z0-9._-]+)/i);
  if (match) metadata.host = match[1];
  
  // Try to extract from path
  if (!metadata.host) {
    const pathMatch = filePath.match(/\/([a-z]+-[a-z]+-\d+-\d+)\//i);
    if (pathMatch) metadata.host = pathMatch[1];
  }
  
  // Region extraction
  match = line.match(/region[=:]\s*["']?([a-zA-Z0-9-]+)/i);
  if (match) metadata.region = match[1];
  
  match = line.match(/(us-east-\d|us-west-\d|eu-west-\d|ap-northeast-\d)/i);
  if (match) metadata.region = match[1];
  
  // Version extraction
  match = line.match(/version[=:]\s*["']?v?(\d+\.\d+\.\d+)/i);
  if (match) metadata.version = match[1];
  
  match = line.match(/v(\d+\.\d+\.\d+)/);
  if (match) metadata.version = match[1];
  
  return metadata;
}

/**
 * Detect event type from content
 */
function detectEventType(content) {
  const contentLower = content.toLowerCase();
  
  // Crash indicators
  if (contentLower.includes('sigsegv') || 
      contentLower.includes('sigabrt') ||
      contentLower.includes('core dump') ||
      contentLower.includes('segmentation fault') ||
      contentLower.includes('stack trace')) {
    return 'crash';
  }
  
  // Test failure indicators
  if (contentLower.includes('assertion') ||
      contentLower.includes('test failed') ||
      contentLower.includes('expected') ||
      contentLower.match(/fail(ed|ure|ing)?.*test/)) {
    return 'test';
  }
  
  // Metric indicators
  if (contentLower.includes('latency') ||
      contentLower.includes('throughput') ||
      contentLower.includes('percentile') ||
      contentLower.includes('p99') ||
      contentLower.includes('p95')) {
    return 'metric';
  }
  
  // Default to log
  return 'log';
}

/**
 * Collect events from log files
 */
function collectFromLogs(sourcePath, timeRange) {
  const events = [];
  
  if (!existsSync(sourcePath)) {
    console.error(`Source path does not exist: ${sourcePath}`);
    return events;
  }
  
  const stats = statSync(sourcePath);
  const files = stats.isDirectory() 
    ? readdirSync(sourcePath).map(f => join(sourcePath, f)).filter(f => {
        const ext = extname(f).toLowerCase();
        return ['.log', '.txt', '.json', '.jsonl', ''].includes(ext);
      })
    : [sourcePath];
  
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      
      for (const line of lines) {
        const timestamp = extractTimestamp(line);
        const eventTime = new Date(timestamp);
        
        // Filter by time range
        if (timeRange.start && eventTime < timeRange.start) continue;
        if (timeRange.end && eventTime > timeRange.end) continue;
        
        const event = {
          id: generateEventId(line),
          timestamp: timestamp,
          source: basename(file),
          source_type: detectEventType(line),
          raw: line,
          metadata: extractMetadata(line, file)
        };
        
        events.push(event);
      }
    } catch (err) {
      console.error(`Error reading ${file}: ${err.message}`);
    }
  }
  
  return events;
}

/**
 * Collect events from JSON/JSONL files
 */
function collectFromJson(sourcePath, timeRange) {
  const events = [];
  
  if (!existsSync(sourcePath)) {
    console.error(`Source path does not exist: ${sourcePath}`);
    return events;
  }
  
  const content = readFileSync(sourcePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const timestamp = obj.timestamp || obj.time || obj['@timestamp'] || new Date().toISOString();
      const eventTime = new Date(timestamp);
      
      // Filter by time range
      if (timeRange.start && eventTime < timeRange.start) continue;
      if (timeRange.end && eventTime > timeRange.end) continue;
      
      const event = {
        id: generateEventId(line),
        timestamp: new Date(timestamp).toISOString(),
        source: basename(sourcePath),
        source_type: detectEventType(JSON.stringify(obj)),
        raw: obj,
        metadata: {
          host: obj.host || obj.hostname || null,
          region: obj.region || obj.datacenter || null,
          version: obj.version || null,
          hardware_sku: obj.hardware_sku || obj.sku || null
        }
      };
      
      events.push(event);
    } catch (err) {
      // Not valid JSON, try as regular log line
      const timestamp = extractTimestamp(line);
      events.push({
        id: generateEventId(line),
        timestamp: timestamp,
        source: basename(sourcePath),
        source_type: detectEventType(line),
        raw: line,
        metadata: extractMetadata(line, sourcePath)
      });
    }
  }
  
  return events;
}

/**
 * Main collection logic
 */
function main() {
  const sources = parseDataSources(stateContent);
  const timeRange = parseTimeRange(stateContent);
  
  console.log('Epidemiological Event Collection');
  console.log('─────────────────────────────────');
  console.log(`Investigation: ${basename(investigationDir)}`);
  console.log(`Sources: ${sources.length}`);
  console.log(`Time range: ${timeRange.start?.toISOString() || 'all'} — ${timeRange.end?.toISOString() || 'now'}`);
  console.log('');
  
  const allEvents = [];
  const sourceStats = [];
  
  for (const source of sources) {
    console.log(`Collecting from: ${source.path}`);
    
    let events = [];
    
    if (source.type.includes('json') || source.path.endsWith('.json') || source.path.endsWith('.jsonl')) {
      events = collectFromJson(source.path, timeRange);
    } else {
      events = collectFromLogs(source.path, timeRange);
    }
    
    sourceStats.push({
      path: source.path,
      type: source.type,
      events_collected: events.length
    });
    
    allEvents.push(...events);
    console.log(`  Collected: ${events.length} events`);
  }
  
  // Deduplicate by ID
  const uniqueEvents = Array.from(
    new Map(allEvents.map(e => [e.id, e])).values()
  );
  
  // Calculate metadata completeness
  const metadataCompleteness = {
    host: (uniqueEvents.filter(e => e.metadata.host).length / uniqueEvents.length * 100).toFixed(1) + '%',
    region: (uniqueEvents.filter(e => e.metadata.region).length / uniqueEvents.length * 100).toFixed(1) + '%',
    version: (uniqueEvents.filter(e => e.metadata.version).length / uniqueEvents.length * 100).toFixed(1) + '%'
  };
  
  // Build output
  const output = {
    collection_metadata: {
      slug: basename(investigationDir),
      collected_at: new Date().toISOString(),
      time_range: {
        start: timeRange.start?.toISOString() || null,
        end: timeRange.end?.toISOString() || null
      },
      sources: sourceStats,
      total_events: uniqueEvents.length,
      duplicates_removed: allEvents.length - uniqueEvents.length,
      metadata_completeness: metadataCompleteness
    },
    events: uniqueEvents
  };
  
  // Write output
  const outputPath = join(investigationDir, 'events.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  console.log('');
  console.log('Collection Complete');
  console.log('───────────────────');
  console.log(`Total events: ${uniqueEvents.length}`);
  console.log(`Duplicates removed: ${allEvents.length - uniqueEvents.length}`);
  console.log(`Output: ${outputPath}`);
  console.log('');
  console.log('Metadata completeness:');
  console.log(`  Host: ${metadataCompleteness.host}`);
  console.log(`  Region: ${metadataCompleteness.region}`);
  console.log(`  Version: ${metadataCompleteness.version}`);
  
  // Gate check
  console.log('');
  if (uniqueEvents.length < 10) {
    console.log('⚠️  WARNING: Sample size too small for epidemiological analysis');
    console.log('   Consider traditional debugging or collecting more data.');
  } else if (uniqueEvents.length > 10000) {
    console.log(`ℹ️  Large dataset (${uniqueEvents.length} events). Analysis may take several minutes.`);
  } else {
    console.log('✅ Sample size adequate for epidemiological analysis');
  }
}

main();
