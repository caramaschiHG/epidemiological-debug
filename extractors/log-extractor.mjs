#!/usr/bin/env node
/**
 * log-extractor.mjs
 * 
 * Specialized feature extractor for application log error events.
 * Extracts error codes, message patterns, components, and severity levels.
 */

import { createHash } from 'crypto';

/**
 * Extract features from a log error event
 * @param {Object} event - The event object with raw content
 * @returns {Object} Extracted log features
 */
export function extractLogFeatures(event) {
  const raw = typeof event.raw === 'string' ? event.raw : JSON.stringify(event.raw);
  
  return {
    type: 'log',
    error_code: extractErrorCode(raw),
    http_status: extractHttpStatus(raw),
    message_hash: extractMessageHash(raw),
    message_pattern: extractMessagePattern(raw),
    component: extractComponent(raw),
    severity: extractSeverity(raw),
    exception_type: extractExceptionType(raw),
    category: determineLogCategory(raw)
  };
}

/**
 * Extract error code from log content
 */
function extractErrorCode(content) {
  const patterns = [
    /error[_\s]?code[=:\s]+["']?([A-Z0-9_]+)/i,
    /code[=:\s]+["']?([A-Z][A-Z0-9_]+)/i,
    /\[([A-Z][A-Z0-9_]{2,})\]/,
    /E([A-Z]{2,})/
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

/**
 * Extract HTTP status code
 */
function extractHttpStatus(content) {
  const patterns = [
    /status[=:\s]+(\d{3})/i,
    /http[_\s]?(?:status|code)[=:\s]+(\d{3})/i,
    /response[=:\s]+(\d{3})/i,
    /\s(\d{3})\s+(?:OK|Created|Accepted|Bad Request|Unauthorized|Forbidden|Not Found|Internal Server Error)/i,
    /returned?\s+(\d{3})/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const code = parseInt(match[1]);
      if (code >= 100 && code < 600) {
        return code;
      }
    }
  }
  
  return null;
}

/**
 * Extract normalized message hash for grouping similar messages
 */
function extractMessageHash(content) {
  const normalized = normalizeMessage(content);
  return createHash('md5').update(normalized).digest('hex').substring(0, 12);
}

/**
 * Normalize message for pattern matching
 */
function normalizeMessage(content) {
  return content
    // Remove timestamps
    .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, 'TIMESTAMP')
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    // Remove hex strings
    .replace(/0x[0-9a-f]{6,}/gi, 'HEX')
    .replace(/\b[0-9a-f]{32,}\b/gi, 'HASH')
    // Remove IDs and numbers
    .replace(/\b\d{4,}\b/g, 'N')
    .replace(/id[=:]\s*\d+/gi, 'id=N')
    // Remove IP addresses
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, 'IP')
    // Remove file paths
    .replace(/\/[\w\-./]+\.\w+/g, 'PATH')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

/**
 * Extract message pattern (template)
 */
function extractMessagePattern(content) {
  const normalized = normalizeMessage(content);
  
  // Further reduce to pattern
  return normalized
    .replace(/TIMESTAMP/g, '{ts}')
    .replace(/UUID/g, '{uuid}')
    .replace(/HEX/g, '{hex}')
    .replace(/HASH/g, '{hash}')
    .replace(/\bN\b/g, '{n}')
    .replace(/IP/g, '{ip}')
    .replace(/PATH/g, '{path}')
    .substring(0, 100);
}

/**
 * Extract component/service name
 */
function extractComponent(content) {
  const patterns = [
    /\[([A-Za-z][A-Za-z0-9_-]*(?:Service|Handler|Controller|Manager|Worker|Client|Server)?)\]/,
    /component[=:\s]+["']?([A-Za-z][A-Za-z0-9_-]+)/i,
    /service[=:\s]+["']?([A-Za-z][A-Za-z0-9_-]+)/i,
    /module[=:\s]+["']?([A-Za-z][A-Za-z0-9_-]+)/i,
    /logger[=:\s]+["']?([A-Za-z][A-Za-z0-9._-]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

/**
 * Extract log severity level
 */
function extractSeverity(content) {
  const contentLower = content.toLowerCase();
  
  // Check for explicit level markers
  const levelPatterns = [
    /level[=:\s]+["']?(fatal|critical|error|warn(?:ing)?|info|debug|trace)/i,
    /\[(fatal|critical|error|warn(?:ing)?|info|debug|trace)\]/i,
    /\b(fatal|critical|error|warn(?:ing)?|info|debug|trace)\b/i
  ];
  
  for (const pattern of levelPatterns) {
    const match = content.match(pattern);
    if (match) {
      const level = match[1].toLowerCase();
      if (level === 'warning') return 'warn';
      return level;
    }
  }
  
  // Infer from content
  if (contentLower.includes('fatal') || contentLower.includes('critical')) return 'critical';
  if (contentLower.includes('error') || contentLower.includes('exception') || contentLower.includes('failed')) return 'error';
  if (contentLower.includes('warn')) return 'warn';
  
  return 'unknown';
}

/**
 * Extract exception/error type
 */
function extractExceptionType(content) {
  const patterns = [
    // Java/Kotlin style: java.lang.NullPointerException
    /([a-z]+\.)+([A-Z][a-zA-Z]+Exception)/,
    // Python style: ValueError, KeyError
    /([A-Z][a-zA-Z]+Error)/,
    // Go style: error type
    /error\s+type[=:\s]+["']?([a-zA-Z]+)/i,
    // Generic exception
    /([A-Z][a-zA-Z]+Exception)/
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[match.length - 1] || match[1];
    }
  }
  
  return null;
}

/**
 * Determine log category for classification
 */
function determineLogCategory(content) {
  const contentLower = content.toLowerCase();
  const httpStatus = extractHttpStatus(content);
  
  // Network/connectivity issues
  if (contentLower.includes('timeout') || contentLower.includes('timed out')) return 'timeout';
  if (contentLower.includes('connection refused')) return 'connection-refused';
  if (contentLower.includes('connection reset')) return 'connection-reset';
  if (contentLower.includes('host unreachable') || contentLower.includes('no route')) return 'host-unreachable';
  if (contentLower.includes('network') && contentLower.includes('error')) return 'network-error';
  
  // Authentication/authorization
  if (contentLower.includes('auth') && (contentLower.includes('fail') || contentLower.includes('denied'))) return 'auth-failed';
  if (contentLower.includes('permission denied') || contentLower.includes('access denied')) return 'permission-denied';
  if (contentLower.includes('unauthorized') || httpStatus === 401) return 'unauthorized';
  if (contentLower.includes('forbidden') || httpStatus === 403) return 'forbidden';
  
  // Resource issues
  if (contentLower.includes('not found') || httpStatus === 404) return 'not-found';
  if (contentLower.includes('out of memory') || contentLower.includes('oom')) return 'out-of-memory';
  if (contentLower.includes('disk full') || contentLower.includes('no space')) return 'disk-full';
  if (contentLower.includes('rate limit') || httpStatus === 429) return 'rate-limited';
  if (contentLower.includes('quota') && contentLower.includes('exceed')) return 'quota-exceeded';
  
  // TLS/SSL issues
  if (contentLower.includes('ssl') || contentLower.includes('tls') || contentLower.includes('certificate')) return 'tls-error';
  
  // DNS issues
  if (contentLower.includes('dns') || contentLower.includes('resolve') || contentLower.includes('nxdomain')) return 'dns-error';
  
  // Database issues
  if (contentLower.includes('database') || contentLower.includes('db ') || contentLower.includes('sql')) {
    if (contentLower.includes('connection')) return 'db-connection-error';
    if (contentLower.includes('timeout')) return 'db-timeout';
    if (contentLower.includes('deadlock')) return 'db-deadlock';
    return 'db-error';
  }
  
  // HTTP status categories
  if (httpStatus) {
    if (httpStatus >= 500) return 'server-error';
    if (httpStatus >= 400) return 'client-error';
  }
  
  // Generic error
  if (contentLower.includes('error') || contentLower.includes('exception') || contentLower.includes('fail')) {
    return 'error-generic';
  }
  
  return 'log-unknown';
}

// CLI support
if (process.argv[1].endsWith('log-extractor.mjs')) {
  const input = process.argv[2];
  if (input) {
    try {
      const event = JSON.parse(input);
      console.log(JSON.stringify(extractLogFeatures(event), null, 2));
    } catch (e) {
      console.log(JSON.stringify(extractLogFeatures({ raw: input }), null, 2));
    }
  }
}

export default extractLogFeatures;
