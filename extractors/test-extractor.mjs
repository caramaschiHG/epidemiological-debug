#!/usr/bin/env node
/**
 * test-extractor.mjs
 * 
 * Specialized feature extractor for test failure events.
 * Extracts test names, failure patterns, assertion types, and flakiness indicators.
 */

import { createHash } from 'crypto';

/**
 * Extract features from a test failure event
 * @param {Object} event - The event object with raw content
 * @returns {Object} Extracted test features
 */
export function extractTestFeatures(event) {
  const raw = typeof event.raw === 'string' ? event.raw : JSON.stringify(event.raw);
  
  return {
    type: 'test',
    test_name: extractTestName(raw),
    test_suite: extractTestSuite(raw),
    test_file: extractTestFile(raw),
    failure_message: extractFailureMessage(raw),
    failure_hash: extractFailureHash(raw),
    assertion_type: extractAssertionType(raw),
    expected_value: extractExpectedValue(raw),
    actual_value: extractActualValue(raw),
    error_type: extractErrorType(raw),
    duration_ms: extractDuration(raw),
    retry_count: extractRetryCount(raw),
    is_flaky: detectFlakiness(raw),
    failure_location: extractFailureLocation(raw),
    category: determineTestCategory(raw)
  };
}

/**
 * Extract test name
 */
function extractTestName(content) {
  const patterns = [
    // Jest/Mocha/Vitest: test("name", ...) or it("name", ...)
    /(?:test|it)\s*\(\s*["'`]([^"'`]+)["'`]/i,
    // describe + it combination
    /(?:describe|context)\s*\(\s*["'`]([^"'`]+)["'`].*?(?:test|it)\s*\(\s*["'`]([^"'`]+)["'`]/is,
    // pytest: test_function_name
    /def\s+(test_[a-zA-Z0-9_]+)/,
    // JUnit: @Test ... void testMethodName
    /@Test[^}]*void\s+([a-zA-Z0-9_]+)/,
    // Go: func TestFunctionName
    /func\s+(Test[A-Z][a-zA-Z0-9_]*)/,
    // Generic test name extraction
    /test[_\s]?name[=:\s]+["']?([a-zA-Z0-9_\s]+)/i,
    /failed[:\s]+["']?([a-zA-Z0-9_\s]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      // If we have describe + it, combine them
      if (match[2]) {
        return `${match[1]} > ${match[2]}`;
      }
      return match[1].trim();
    }
  }
  
  return null;
}

/**
 * Extract test suite name
 */
function extractTestSuite(content) {
  const patterns = [
    /(?:describe|suite|context)\s*\(\s*["'`]([^"'`]+)["'`]/i,
    /test\s*suite[=:\s]+["']?([a-zA-Z0-9_\s]+)/i,
    /class\s+([A-Z][a-zA-Z0-9_]*Test)/
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1].trim();
  }
  
  return null;
}

/**
 * Extract test file path
 */
function extractTestFile(content) {
  const patterns = [
    /(?:at|in|file)\s+([^\s:]+\.(?:test|spec)\.[jt]sx?)/i,
    /([^\s:]+_test\.(?:py|go|rb))/i,
    /([^\s:]+Test\.(?:java|kt|cs))/i,
    /([^\s:]+\.test\.[jt]s)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Extract failure message
 */
function extractFailureMessage(content) {
  const patterns = [
    /(?:error|failure|assert(?:ion)?)[:\s]+(.+?)(?:\n|$)/i,
    /(?:expected|got|actual)[:\s]+(.+?)(?:\n|$)/i,
    /message[:\s]+["']?(.+?)["']?(?:\n|$)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1].trim().substring(0, 200);
  }
  
  // Return first non-empty line as fallback
  const lines = content.split('\n').filter(l => l.trim());
  return lines[0]?.substring(0, 200) || null;
}

/**
 * Extract normalized failure hash for grouping
 */
function extractFailureHash(content) {
  const message = extractFailureMessage(content) || content;
  
  // Normalize the message
  const normalized = message
    .replace(/\d+/g, 'N')           // Numbers
    .replace(/0x[0-9a-f]+/gi, 'H')  // Hex values
    .replace(/["'][^"']*["']/g, 'S') // Strings
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
  
  return createHash('md5').update(normalized).digest('hex').substring(0, 12);
}

/**
 * Extract assertion type
 */
function extractAssertionType(content) {
  const contentLower = content.toLowerCase();
  
  // Equality assertions
  if (/assert(?:equals?|strictequal|deepequal)|tobe\(|toequal\(/i.test(content)) return 'equality';
  if (/assertsame|tobestrictlyequal/i.test(content)) return 'strict-equality';
  if (/assertdeepequal|tomatchobject/i.test(content)) return 'deep-equality';
  
  // Boolean assertions
  if (/assert(?:true|false)|tobe(?:truthy|falsy)/i.test(content)) return 'boolean';
  
  // Null/undefined assertions
  if (/assert(?:null|notnull|undefined|defined)|tobe(?:null|undefined|defined)/i.test(content)) return 'null-check';
  
  // Exception assertions
  if (/assert(?:throws?|raises?|exception)|tothrow/i.test(content)) return 'exception';
  
  // Contains/includes assertions
  if (/assert(?:contains?|includes?)|tocontain|toinclude/i.test(content)) return 'contains';
  
  // Comparison assertions
  if (/assert(?:greater|less|between)|tobe(?:greater|less)than/i.test(content)) return 'comparison';
  
  // Match assertions
  if (/assertmatches?|tomatch/i.test(content)) return 'pattern-match';
  
  // Timeout
  if (contentLower.includes('timeout')) return 'timeout';
  
  return 'unknown';
}

/**
 * Extract expected value from assertion
 */
function extractExpectedValue(content) {
  const patterns = [
    /expected[:\s]+["']?([^"'\n]+)["']?/i,
    /expect\([^)]*\)\.to(?:be|equal|match)\(([^)]+)\)/i,
    /assertEqual\([^,]+,\s*([^)]+)\)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1].trim().substring(0, 100);
  }
  
  return null;
}

/**
 * Extract actual value from assertion
 */
function extractActualValue(content) {
  const patterns = [
    /(?:actual|received|got)[:\s]+["']?([^"'\n]+)["']?/i,
    /but\s+(?:was|got|received)[:\s]+["']?([^"'\n]+)["']?/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1].trim().substring(0, 100);
  }
  
  return null;
}

/**
 * Extract error type
 */
function extractErrorType(content) {
  const patterns = [
    /([A-Z][a-zA-Z]+Error)/,
    /([A-Z][a-zA-Z]+Exception)/,
    /error[:\s]+([A-Z][a-zA-Z]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Extract test duration in milliseconds
 */
function extractDuration(content) {
  const patterns = [
    /duration[:\s]+(\d+(?:\.\d+)?)\s*ms/i,
    /took\s+(\d+(?:\.\d+)?)\s*ms/i,
    /time[:\s]+(\d+(?:\.\d+)?)\s*ms/i,
    /(\d+(?:\.\d+)?)\s*ms/i,
    /duration[:\s]+(\d+(?:\.\d+)?)\s*s/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      let value = parseFloat(match[1]);
      // Convert seconds to ms if needed
      if (pattern.source.includes('\\s*s')) value *= 1000;
      return value;
    }
  }
  
  return null;
}

/**
 * Extract retry count
 */
function extractRetryCount(content) {
  const patterns = [
    /retry[:\s]+(\d+)/i,
    /retries[:\s]+(\d+)/i,
    /attempt[:\s]+(\d+)/i,
    /(\d+)\s*(?:of|\/)\s*\d+\s*retries/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return parseInt(match[1]);
  }
  
  return null;
}

/**
 * Detect if test appears to be flaky
 */
function detectFlakiness(content) {
  const contentLower = content.toLowerCase();
  
  // Explicit flaky markers
  if (contentLower.includes('flaky') || contentLower.includes('intermittent')) return true;
  
  // Retry indicators
  const retryCount = extractRetryCount(content);
  if (retryCount && retryCount > 0) return true;
  
  // Timing-related failures
  if (contentLower.includes('race condition') || contentLower.includes('timing')) return true;
  
  // Network/external dependency failures
  if (contentLower.includes('network') || contentLower.includes('external')) return true;
  
  return false;
}

/**
 * Extract failure location (file:line)
 */
function extractFailureLocation(content) {
  const patterns = [
    /at\s+([^\s]+:\d+(?::\d+)?)/,
    /([^\s]+\.(?:js|ts|py|java|go|rb):\d+)/,
    /line\s+(\d+)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Determine test category for classification
 */
function determineTestCategory(content) {
  const contentLower = content.toLowerCase();
  const assertionType = extractAssertionType(content);
  const isFlaky = detectFlakiness(content);
  
  // Flaky tests
  if (isFlaky) return 'flaky-test';
  
  // Timeout failures
  if (assertionType === 'timeout' || contentLower.includes('timeout')) return 'test-timeout';
  
  // Network/connection issues
  if (contentLower.includes('connection') || contentLower.includes('network')) return 'test-network-issue';
  
  // Setup/teardown failures
  if (contentLower.includes('setup') || contentLower.includes('beforeeach') || contentLower.includes('beforeall')) return 'test-setup-failed';
  if (contentLower.includes('teardown') || contentLower.includes('aftereach') || contentLower.includes('afterall')) return 'test-teardown-failed';
  
  // Fixture issues
  if (contentLower.includes('fixture') || contentLower.includes('mock')) return 'test-fixture-issue';
  
  // Assertion failures by type
  if (assertionType === 'equality') return 'assertion-equality-failed';
  if (assertionType === 'exception') return 'assertion-exception-failed';
  if (assertionType === 'null-check') return 'assertion-null-failed';
  if (assertionType === 'boolean') return 'assertion-boolean-failed';
  
  // Generic assertion failure
  if (contentLower.includes('assert')) return 'assertion-failed';
  
  // Error during test
  if (contentLower.includes('error') || contentLower.includes('exception')) return 'test-error';
  
  return 'test-failure-unknown';
}

// CLI support
if (process.argv[1].endsWith('test-extractor.mjs')) {
  const input = process.argv[2];
  if (input) {
    try {
      const event = JSON.parse(input);
      console.log(JSON.stringify(extractTestFeatures(event), null, 2));
    } catch (e) {
      console.log(JSON.stringify(extractTestFeatures({ raw: input }), null, 2));
    }
  }
}

export default extractTestFeatures;
