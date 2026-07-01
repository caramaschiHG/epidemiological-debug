#!/usr/bin/env node
/**
 * crash-extractor.mjs
 * 
 * Specialized feature extractor for crash/core dump events.
 * Extracts signal types, fault addresses, stack fingerprints, and register states.
 */

import { createHash } from 'crypto';

/**
 * Extract features from a crash event
 * @param {Object} event - The event object with raw content
 * @returns {Object} Extracted crash features
 */
export function extractCrashFeatures(event) {
  const raw = typeof event.raw === 'string' ? event.raw : JSON.stringify(event.raw);
  const rawLower = raw.toLowerCase();
  
  return {
    type: 'crash',
    signal: extractSignal(raw),
    fault_address: extractFaultAddress(raw),
    fault_address_type: classifyFaultAddress(raw),
    stack_fingerprint: extractStackFingerprint(raw),
    top_frames: extractTopFrames(raw, 5),
    register_state: extractRegisterState(raw),
    crash_type: classifyCrashType(raw),
    category: determineCrashCategory(raw)
  };
}

/**
 * Extract signal type from crash content
 */
function extractSignal(content) {
  const signalPatterns = [
    /signal\s+(\d+)\s*\((\w+)\)/i,
    /SIG(\w+)/,
    /received\s+signal\s+(\w+)/i,
    /terminated\s+by\s+signal\s+(\d+)/i
  ];
  
  for (const pattern of signalPatterns) {
    const match = content.match(pattern);
    if (match) {
      const sig = match[2] || match[1];
      if (/^\d+$/.test(sig)) {
        // Convert signal number to name
        const signalNames = {
          '1': 'SIGHUP', '2': 'SIGINT', '3': 'SIGQUIT', '4': 'SIGILL',
          '5': 'SIGTRAP', '6': 'SIGABRT', '7': 'SIGBUS', '8': 'SIGFPE',
          '9': 'SIGKILL', '10': 'SIGUSR1', '11': 'SIGSEGV', '12': 'SIGUSR2',
          '13': 'SIGPIPE', '14': 'SIGALRM', '15': 'SIGTERM'
        };
        return signalNames[sig] || `SIGNAL_${sig}`;
      }
      return sig.toUpperCase().startsWith('SIG') ? sig.toUpperCase() : `SIG${sig.toUpperCase()}`;
    }
  }
  
  // Infer from content
  if (content.includes('SEGV') || content.toLowerCase().includes('segmentation')) return 'SIGSEGV';
  if (content.includes('ABRT') || content.toLowerCase().includes('abort')) return 'SIGABRT';
  if (content.includes('BUS')) return 'SIGBUS';
  if (content.includes('FPE')) return 'SIGFPE';
  if (content.includes('ILL')) return 'SIGILL';
  
  return null;
}

/**
 * Extract fault address from crash content
 */
function extractFaultAddress(content) {
  const patterns = [
    /fault\s+(?:at\s+)?(?:address\s+)?(?:0x)?([0-9a-fA-F]+)/i,
    /address\s+(?:0x)?([0-9a-fA-F]+)/i,
    /(?:rip|pc|eip)\s*[=:]\s*(?:0x)?([0-9a-fA-F]+)/i,
    /at\s+(?:0x)?([0-9a-fA-F]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  
  return null;
}

/**
 * Classify fault address type
 */
function classifyFaultAddress(content) {
  const addr = extractFaultAddress(content);
  if (!addr) return null;
  
  const addrNum = parseInt(addr, 16);
  
  if (addrNum === 0) return 'null';
  if (addrNum < 0x1000) return 'low-address';
  if (addrNum % 8 !== 0) return 'misaligned';
  if (addrNum > 0x7fffffffffff) return 'kernel-space';
  
  return 'valid-range';
}

/**
 * Extract stack fingerprint (hash of top frames)
 */
function extractStackFingerprint(content) {
  const frames = extractTopFrames(content, 5);
  if (frames.length === 0) return null;
  
  const fingerprint = frames.map(f => f.function || f.raw).join('|');
  return createHash('md5').update(fingerprint).digest('hex').substring(0, 12);
}

/**
 * Extract top N stack frames
 */
function extractTopFrames(content, n = 5) {
  const frames = [];
  
  // Pattern for common stack trace formats
  const framePatterns = [
    // GDB style: #0 function (args) at file:line
    /#(\d+)\s+(?:0x[0-9a-f]+\s+in\s+)?([a-zA-Z_][a-zA-Z0-9_:]*)\s*\([^)]*\)(?:\s+at\s+([^:]+):(\d+))?/gi,
    // Linux addr2line style: function+offset at file:line
    /([a-zA-Z_][a-zA-Z0-9_:]*)\+0x[0-9a-f]+\s+at\s+([^:]+):(\d+)/gi,
    // Java style: at package.Class.method(File.java:line)
    /at\s+([a-zA-Z_][a-zA-Z0-9_.]+)\(([^:]+):(\d+)\)/gi,
    // Python style: File "path", line N, in function
    /File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi,
    // Simple function name extraction
    /(?:in|at|from)\s+([a-zA-Z_][a-zA-Z0-9_:]+)\s*\(/gi
  ];
  
  for (const pattern of framePatterns) {
    let match;
    pattern.lastIndex = 0;
    
    while ((match = pattern.exec(content)) !== null && frames.length < n) {
      frames.push({
        raw: match[0],
        function: match[2] || match[1] || match[3],
        file: match[3] || match[2] || null,
        line: match[4] || match[3] || match[2] || null
      });
    }
    
    if (frames.length >= n) break;
  }
  
  return frames.slice(0, n);
}

/**
 * Extract register state information
 */
function extractRegisterState(content) {
  const state = {
    rsp_aligned: true,
    rbp_valid: true,
    rip_valid: true,
    has_null_registers: false,
    has_suspicious_values: false
  };
  
  const contentLower = content.toLowerCase();
  
  // Check for misaligned stack
  if (contentLower.includes('misalign') || contentLower.includes('unalign')) {
    state.rsp_aligned = false;
    state.has_suspicious_values = true;
  }
  
  // Check for null values
  const nullPatterns = [
    /(?:rip|pc|eip)\s*[=:]\s*(?:0x)?0+\b/i,
    /(?:rsp|sp|esp)\s*[=:]\s*(?:0x)?0+\b/i,
    /(?:rbp|bp|ebp)\s*[=:]\s*(?:0x)?0+\b/i
  ];
  
  for (const pattern of nullPatterns) {
    if (pattern.test(content)) {
      state.has_null_registers = true;
      state.has_suspicious_values = true;
      
      if (/rip|pc|eip/i.test(pattern.source)) state.rip_valid = false;
      if (/rbp|bp|ebp/i.test(pattern.source)) state.rbp_valid = false;
    }
  }
  
  // Check for stack corruption indicators
  if (contentLower.includes('stack') && 
      (contentLower.includes('corrupt') || contentLower.includes('smash') || contentLower.includes('overflow'))) {
    state.has_suspicious_values = true;
  }
  
  return state;
}

/**
 * Classify crash type
 */
function classifyCrashType(content) {
  const contentLower = content.toLowerCase();
  
  if (contentLower.includes('return') && contentLower.includes('null')) return 'return-to-null';
  if (contentLower.includes('misalign') && contentLower.includes('stack')) return 'misaligned-stack';
  if (contentLower.includes('double free')) return 'double-free';
  if (contentLower.includes('use after free') || contentLower.includes('use-after-free')) return 'use-after-free';
  if (contentLower.includes('heap') && contentLower.includes('corrupt')) return 'heap-corruption';
  if (contentLower.includes('stack') && contentLower.includes('overflow')) return 'stack-overflow';
  if (contentLower.includes('buffer') && contentLower.includes('overflow')) return 'buffer-overflow';
  if (contentLower.includes('null') && contentLower.includes('pointer')) return 'null-pointer';
  if (contentLower.includes('assert')) return 'assertion';
  
  const signal = extractSignal(content);
  if (signal === 'SIGSEGV') return 'segfault';
  if (signal === 'SIGABRT') return 'abort';
  if (signal === 'SIGBUS') return 'bus-error';
  if (signal === 'SIGFPE') return 'arithmetic';
  
  return 'unknown';
}

/**
 * Determine crash category for classification
 */
function determineCrashCategory(content) {
  const crashType = classifyCrashType(content);
  const faultType = classifyFaultAddress(content);
  
  // High-specificity categories
  if (crashType === 'return-to-null') return 'return-to-null';
  if (crashType === 'misaligned-stack') return 'misaligned-stack';
  if (crashType === 'double-free') return 'double-free';
  if (crashType === 'use-after-free') return 'use-after-free';
  if (crashType === 'heap-corruption') return 'heap-corruption';
  if (crashType === 'stack-overflow') return 'stack-overflow';
  if (crashType === 'buffer-overflow') return 'buffer-overflow';
  
  // Fault address based categories
  if (faultType === 'null') return 'null-pointer-deref';
  if (faultType === 'misaligned') return 'misaligned-access';
  if (faultType === 'low-address') return 'low-address-access';
  
  // Signal based categories
  if (crashType === 'abort') return 'assertion-abort';
  if (crashType === 'arithmetic') return 'arithmetic-error';
  if (crashType === 'bus-error') return 'bus-error';
  if (crashType === 'segfault') return 'segfault-unknown';
  
  return 'crash-unknown';
}

// CLI support
if (process.argv[1].endsWith('crash-extractor.mjs')) {
  const input = process.argv[2];
  if (input) {
    try {
      const event = JSON.parse(input);
      console.log(JSON.stringify(extractCrashFeatures(event), null, 2));
    } catch (e) {
      console.log(JSON.stringify(extractCrashFeatures({ raw: input }), null, 2));
    }
  }
}

export default extractCrashFeatures;
