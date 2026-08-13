#!/usr/bin/env npx tsx
//
// Proof Server Witness Extraction Probe
// ======================================
// Attempts to extract private witness data from a Midnight proof server
// through multiple attack vectors. The proof server sees witness data
// during ZK proof generation — this script tests whether any of it leaks.
//
// Usage:
//   npx tsx scripts/proof-server-witness-probe.ts [proof-server-url]
//
// Default: http://localhost:6300
//
// Attack vectors tested:
//   1. Response body analysis — does /prove return more than just the proof?
//   2. Error message leakage — do malformed inputs leak witness structure?
//   3. Timing side channels — does proof time correlate with witness values?
//   4. Endpoint enumeration — are there undocumented debug/dump endpoints?
//   5. Header leakage — do response headers expose internal state?
//   6. Partial proof replay — can we submit a valid proof and get witness back?
//   7. Payload boundary probing — how does the server handle edge-case inputs?
//

const PROOF_SERVER = process.argv[2] ?? 'http://localhost:6300';
const TIMEOUT_MS = 30_000;

interface ProbeResult {
  name: string;
  vector: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  finding: string;
  detail?: string;
  raw?: string;
}

const results: ProbeResult[] = [];

function report(r: ProbeResult) {
  results.push(r);
  const icon = { info: '·', low: '○', medium: '●', high: '◉', critical: '◈' }[r.severity];
  const color = { info: '\x1b[90m', low: '\x1b[36m', medium: '\x1b[33m', high: '\x1b[31m', critical: '\x1b[35m' }[r.severity];
  console.error(`${color}${icon} [${r.severity.toUpperCase()}] ${r.name}\x1b[0m`);
  console.error(`  ${r.finding}`);
  if (r.detail) console.error(`  ${r.detail}`);
  console.error();
}

async function fetchSafe(url: string, opts?: RequestInit): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch {
    return null;
  }
}

async function fetchBytes(url: string, opts?: RequestInit): Promise<{ status: number; headers: Headers; body: Uint8Array; text: string } | null> {
  const res = await fetchSafe(url, opts);
  if (!res) return null;
  const buf = await res.arrayBuffer();
  const body = new Uint8Array(buf);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
  return { status: res.status, headers: res.headers, body, text };
}

// ---------------------------------------------------------------------------
// 1. Endpoint enumeration — look for undocumented debug/dump endpoints
// ---------------------------------------------------------------------------
async function probeEndpoints() {
  const paths = [
    // Standard
    '/', '/ready', '/version', '/health', '/prove', '/check',
    // Debug / admin (common patterns)
    '/debug', '/debug/vars', '/debug/pprof', '/debug/pprof/heap',
    '/debug/pprof/goroutine', '/debug/pprof/trace',
    '/dump', '/state', '/witness', '/witnesses', '/cache',
    '/internal', '/internal/state', '/internal/witness',
    '/admin', '/admin/dump', '/admin/cache', '/admin/keys',
    '/metrics', '/prometheus', '/stats',
    '/env', '/config', '/info',
    // Proof-specific
    '/prove/status', '/prove/last', '/prove/cache', '/prove/replay',
    '/check/last', '/check/cache',
    '/keys', '/prover-keys', '/verifier-keys', '/circuit', '/circuits',
    '/transcript', '/transcripts',
    '/memory', '/mem', '/heap',
    // OpenAPI / docs
    '/openapi', '/openapi.json', '/swagger', '/swagger.json', '/docs', '/api',
    // Common framework defaults
    '/.well-known', '/actuator', '/actuator/health', '/actuator/env',
    '/graphql', '/ws', '/websocket',
  ];

  const found: string[] = [];
  const known = new Set(['/', '/ready', '/version', '/health']);

  for (const path of paths) {
    const res = await fetchSafe(`${PROOF_SERVER}${path}`);
    if (!res) continue;
    if (res.status < 400 && !known.has(path)) {
      const body = await res.text();
      found.push(`${path} → ${res.status} (${body.length} bytes)`);
      report({
        name: `Undocumented endpoint: ${path}`,
        vector: 'endpoint-enumeration',
        severity: body.length > 100 ? 'medium' : 'low',
        finding: `${path} returned HTTP ${res.status} with ${body.length} bytes`,
        detail: body.length < 500 ? body.slice(0, 500) : `First 200 chars: ${body.slice(0, 200)}...`,
      });
    }
  }

  if (found.length === 0) {
    report({
      name: 'Endpoint enumeration',
      vector: 'endpoint-enumeration',
      severity: 'info',
      finding: `No undocumented endpoints found (tested ${paths.length} paths)`,
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Header analysis — check for information leakage in HTTP headers
// ---------------------------------------------------------------------------
async function probeHeaders() {
  const sensitive = ['x-witness', 'x-state', 'x-private', 'x-debug', 'x-trace',
    'x-request-id', 'x-internal', 'server', 'x-powered-by', 'x-runtime'];

  for (const endpoint of ['/', '/ready', '/version']) {
    const res = await fetchSafe(`${PROOF_SERVER}${endpoint}`);
    if (!res) continue;

    const leaked: string[] = [];
    for (const name of sensitive) {
      const val = res.headers.get(name);
      if (val) leaked.push(`${name}: ${val}`);
    }

    // Check all headers for anything unexpected
    const allHeaders: string[] = [];
    res.headers.forEach((val, key) => {
      allHeaders.push(`${key}: ${val}`);
    });

    if (leaked.length > 0) {
      report({
        name: `Header leakage on ${endpoint}`,
        vector: 'header-leakage',
        severity: 'low',
        finding: `Sensitive headers found: ${leaked.join(', ')}`,
      });
    }

    report({
      name: `Headers on ${endpoint}`,
      vector: 'header-analysis',
      severity: 'info',
      finding: `${allHeaders.length} headers: ${allHeaders.join('; ')}`,
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Error message analysis — malformed inputs to /prove and /check
// ---------------------------------------------------------------------------
async function probeErrorLeakage() {
  const payloads: Array<{ name: string; body: Uint8Array | string }> = [
    { name: 'empty body', body: new Uint8Array(0) },
    { name: '1 byte', body: new Uint8Array([0x00]) },
    { name: '4 bytes zeros', body: new Uint8Array([0, 0, 0, 0]) },
    { name: 'midnight header prefix', body: new TextEncoder().encode('midnight:') },
    { name: 'proof-preimage tag', body: new TextEncoder().encode('midnight:(proof-preimage-versioned,') },
    { name: 'transaction v9 tag', body: new TextEncoder().encode('midnight:transaction[v9]') },
    { name: 'large random payload', body: crypto.getRandomValues(new Uint8Array(1024)) },
    { name: 'large zero payload', body: new Uint8Array(4096) },
    { name: 'JSON payload', body: '{"witness": "extract"}' },
    { name: 'CBOR-like header', body: new Uint8Array([0xd9, 0xd9, 0xf7]) },
    // Try to trigger stack traces
    { name: 'null bytes repeated', body: new Uint8Array(65536) },
    { name: 'max uint32 length prefix', body: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00]) },
  ];

  for (const { name, body } of payloads) {
    for (const endpoint of ['/prove', '/check']) {
      const res = await fetchBytes(`${PROOF_SERVER}${endpoint}`, {
        method: 'POST',
        body: body as BodyInit,
      });
      if (!res) continue;

      const hasStackTrace = /at\s+\w+\s*\(|panic|stacktrace|backtrace|\.rs:\d+|\.go:\d+/i.test(res.text);
      const hasWitnessRef = /witness|private.?state|secret|key|preimage|transcript/i.test(res.text);
      const hasPathLeak = /\/home\/|\/usr\/|\/opt\/|\/app\/|\/src\//i.test(res.text);

      if (hasStackTrace) {
        report({
          name: `Stack trace leak on ${endpoint} (${name})`,
          vector: 'error-leakage',
          severity: 'medium',
          finding: `Server returned a stack trace for ${name} input`,
          raw: res.text.slice(0, 1000),
        });
      }

      if (hasWitnessRef) {
        report({
          name: `Witness reference in error on ${endpoint} (${name})`,
          vector: 'error-leakage',
          severity: 'high',
          finding: `Error response references witness/private data for ${name} input`,
          raw: res.text.slice(0, 1000),
        });
      }

      if (hasPathLeak) {
        report({
          name: `Path disclosure on ${endpoint} (${name})`,
          vector: 'error-leakage',
          severity: 'low',
          finding: `Error response contains filesystem paths`,
          raw: res.text.slice(0, 500),
        });
      }

      // Log all non-trivial error responses
      if (res.text.length > 5 && res.status >= 400) {
        report({
          name: `Error response: ${endpoint} (${name})`,
          vector: 'error-analysis',
          severity: 'info',
          finding: `HTTP ${res.status}, ${res.body.length} bytes`,
          detail: res.text.slice(0, 500),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Response body analysis on /prove — check if proof contains witness data
// ---------------------------------------------------------------------------
async function probeProveResponse() {
  // Send a structurally plausible but invalid proof request to see
  // what the response body structure looks like
  const fakePayloads = [
    // Minimal transaction-like structure
    new Uint8Array([
      // "midnight:" prefix
      ...new TextEncoder().encode('midnight:'),
      // followed by random data that could be a transaction envelope
      ...crypto.getRandomValues(new Uint8Array(256)),
    ]),
    // Just the version tag
    new Uint8Array([
      ...new TextEncoder().encode('midnight:transaction[v9]'),
      ...new Uint8Array(512),
    ]),
  ];

  for (let i = 0; i < fakePayloads.length; i++) {
    const res = await fetchBytes(`${PROOF_SERVER}/prove`, {
      method: 'POST',
      body: fakePayloads[i] as BodyInit,
    });
    if (!res) continue;

    // If we somehow got a 200, the server processed our fake input
    if (res.status === 200) {
      report({
        name: `Proof server accepted fake payload ${i}`,
        vector: 'response-analysis',
        severity: 'critical',
        finding: `Server returned 200 for fake input — response may contain derived witness data`,
        detail: `Response: ${res.body.length} bytes. First 100 hex: ${Buffer.from(res.body.slice(0, 100)).toString('hex')}`,
      });
    }

    // Check if error response body contains structured data beyond a simple error string
    if (res.status >= 400 && res.body.length > 200) {
      const hasJson = res.text.startsWith('{') || res.text.startsWith('[');
      report({
        name: `Large error response from /prove (payload ${i})`,
        vector: 'response-analysis',
        severity: hasJson ? 'medium' : 'low',
        finding: `${res.body.length} byte error response (${hasJson ? 'JSON structured' : 'text'})`,
        detail: res.text.slice(0, 500),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Timing analysis — measure if proof time varies with input structure
// ---------------------------------------------------------------------------
async function probeTimingChannels() {
  const payloads = [
    { name: 'zeros-256', data: new Uint8Array(256) },
    { name: 'zeros-1024', data: new Uint8Array(1024) },
    { name: 'zeros-4096', data: new Uint8Array(4096) },
    { name: 'random-256', data: crypto.getRandomValues(new Uint8Array(256)) },
    { name: 'random-1024', data: crypto.getRandomValues(new Uint8Array(1024)) },
    { name: 'midnight-prefix-256', data: new Uint8Array([...new TextEncoder().encode('midnight:'), ...new Uint8Array(247)]) },
  ];

  const timings: Array<{ name: string; ms: number; status: number }> = [];

  // Run each payload 3 times
  for (const { name, data } of payloads) {
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const res = await fetchSafe(`${PROOF_SERVER}/prove`, {
        method: 'POST',
        body: data as BodyInit,
      });
      const elapsed = performance.now() - start;
      timings.push({ name, ms: elapsed, status: res?.status ?? 0 });
    }
  }

  // Group by name and compute stats
  const groups = new Map<string, number[]>();
  for (const t of timings) {
    if (!groups.has(t.name)) groups.set(t.name, []);
    groups.get(t.name)!.push(t.ms);
  }

  const stats: string[] = [];
  let maxDelta = 0;
  const means: number[] = [];

  for (const [name, times] of groups) {
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const stddev = Math.sqrt(times.reduce((a, t) => a + (t - mean) ** 2, 0) / times.length);
    means.push(mean);
    stats.push(`${name}: mean=${mean.toFixed(1)}ms stddev=${stddev.toFixed(1)}ms`);
  }

  if (means.length > 1) {
    maxDelta = Math.max(...means) - Math.min(...means);
  }

  report({
    name: 'Timing analysis on /prove',
    vector: 'timing-channel',
    severity: maxDelta > 100 ? 'medium' : maxDelta > 20 ? 'low' : 'info',
    finding: `Max timing delta across payloads: ${maxDelta.toFixed(1)}ms`,
    detail: stats.join('\n  '),
  });
}

// ---------------------------------------------------------------------------
// 6. HTTP method probing — try unexpected methods
// ---------------------------------------------------------------------------
async function probeHttpMethods() {
  const methods = ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE'];

  for (const endpoint of ['/prove', '/check']) {
    for (const method of methods) {
      const res = await fetchBytes(`${PROOF_SERVER}${endpoint}`, { method });
      if (!res) continue;

      if (res.status < 400 && method !== 'OPTIONS' && method !== 'HEAD') {
        report({
          name: `Unexpected method accepted: ${method} ${endpoint}`,
          vector: 'method-probing',
          severity: 'medium',
          finding: `${method} ${endpoint} returned HTTP ${res.status}`,
          detail: res.text.slice(0, 300),
        });
      }

      // TRACE can echo back the request including internal headers
      if (method === 'TRACE' && res.status === 200) {
        report({
          name: `TRACE enabled on ${endpoint}`,
          vector: 'method-probing',
          severity: 'medium',
          finding: 'TRACE method is enabled — can be used for request echo attacks',
          detail: res.text.slice(0, 500),
        });
      }

      // Check CORS on OPTIONS
      if (method === 'OPTIONS') {
        const allowOrigin = res.headers.get('access-control-allow-origin');
        const allowMethods = res.headers.get('access-control-allow-methods');
        if (allowOrigin === '*') {
          report({
            name: `Permissive CORS on ${endpoint}`,
            vector: 'cors-analysis',
            severity: 'low',
            finding: `CORS allows all origins (Access-Control-Allow-Origin: *)`,
            detail: `Allowed methods: ${allowMethods ?? 'not specified'}`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Content-Type manipulation — can we change how the server interprets input?
// ---------------------------------------------------------------------------
async function probeContentTypes() {
  const types = [
    'application/json',
    'application/cbor',
    'application/x-protobuf',
    'text/plain',
    'application/xml',
    'application/octet-stream',
    'multipart/form-data',
  ];

  const body = new Uint8Array([...new TextEncoder().encode('midnight:'), ...new Uint8Array(128)]);

  for (const ct of types) {
    const res = await fetchBytes(`${PROOF_SERVER}/prove`, {
      method: 'POST',
      body: body as BodyInit,
      headers: { 'Content-Type': ct },
    });
    if (!res) continue;

    // Check if different content types produce different error messages
    // (would indicate the server parses differently based on type)
    if (res.text.length > 5) {
      report({
        name: `Content-Type probe: ${ct}`,
        vector: 'content-type-manipulation',
        severity: 'info',
        finding: `HTTP ${res.status}, ${res.body.length} bytes`,
        detail: res.text.slice(0, 200),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.error('═══════════════════════════════════════════════════════════');
  console.error(' Midnight Proof Server Witness Extraction Probe');
  console.error(` Target: ${PROOF_SERVER}`);
  console.error('═══════════════════════════════════════════════════════════\n');

  // Verify proof server is reachable
  const health = await fetchSafe(`${PROOF_SERVER}/ready`);
  if (!health || health.status !== 200) {
    console.error(`Proof server not reachable at ${PROOF_SERVER}`);
    process.exit(1);
  }
  const version = await fetchSafe(`${PROOF_SERVER}/version`);
  const versionText = version ? await version.text() : 'unknown';
  console.error(`Proof server v${versionText.trim()} is online.\n`);

  console.error('--- Phase 1: Endpoint enumeration ---\n');
  await probeEndpoints();

  console.error('--- Phase 2: Header analysis ---\n');
  await probeHeaders();

  console.error('--- Phase 3: HTTP method probing ---\n');
  await probeHttpMethods();

  console.error('--- Phase 4: Error message analysis ---\n');
  await probeErrorLeakage();

  console.error('--- Phase 5: Response body analysis ---\n');
  await probeProveResponse();

  console.error('--- Phase 6: Content-Type manipulation ---\n');
  await probeContentTypes();

  console.error('--- Phase 7: Timing analysis ---\n');
  await probeTimingChannels();

  // Summary
  console.error('\n═══════════════════════════════════════════════════════════');
  console.error(' Summary');
  console.error('═══════════════════════════════════════════════════════════\n');

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of results) bySeverity[r.severity]++;

  console.error(`  Total findings: ${results.length}`);
  if (bySeverity.critical) console.error(`  \x1b[35m◈ Critical: ${bySeverity.critical}\x1b[0m`);
  if (bySeverity.high) console.error(`  \x1b[31m◉ High:     ${bySeverity.high}\x1b[0m`);
  if (bySeverity.medium) console.error(`  \x1b[33m● Medium:   ${bySeverity.medium}\x1b[0m`);
  if (bySeverity.low) console.error(`  \x1b[36m○ Low:      ${bySeverity.low}\x1b[0m`);
  console.error(`  \x1b[90m· Info:     ${bySeverity.info}\x1b[0m`);

  const witnessExtracted = results.some(r =>
    r.severity === 'critical' || (r.severity === 'high' && r.vector === 'error-leakage'));

  console.error();
  if (witnessExtracted) {
    console.error('  \x1b[31mWitness data may be extractable. See findings above.\x1b[0m');
  } else {
    console.error('  No witness extraction vectors found.');
    console.error('  The proof server does not appear to leak private witness data');
    console.error('  through HTTP responses, error messages, or timing channels.');
  }
  console.error();

  // JSON report to stdout
  console.log(JSON.stringify({
    target: PROOF_SERVER,
    version: versionText.trim(),
    timestamp: new Date().toISOString(),
    summary: bySeverity,
    witnessExtractionPossible: witnessExtracted,
    findings: results,
  }, null, 2));
}

main().catch(err => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
