#!/usr/bin/env node
//
// Wallet Daemon Probe
// ===================
// Smoke-tests the TUI-hosted wallet daemon by connecting to its Unix
// socket and issuing an arbitrary RPC call. Pure Node — no build step,
// no tsx, no external deps. The protocol framing is reimplemented
// inline so this script keeps working even when the wallet packages
// aren't built.
//
// Usage:
//   node scripts/daemon-probe.mjs --wallet <name> [--network preprod]
//   node scripts/daemon-probe.mjs --wallet <name> --call clearSyncCache
//   node scripts/daemon-probe.mjs --wallet <name> --call getState --pretty
//
// Defaults: --network preprod, --call getState.
//
// Examples:
//   # Print sync progress + balances from the running TUI
//   node scripts/daemon-probe.mjs --wallet bobbyknight
//
//   # Trigger the L3 confirmation modal in the TUI; this call hangs
//   # until you answer y/n in the TUI window.
//   node scripts/daemon-probe.mjs --wallet bobbyknight --call clearSyncCache
//
// Exit codes:
//   0  success — call returned a result
//   1  daemon connect failed, malformed reply, or call rejected with error
//   2  bad usage (missing flags)

import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {join} from 'node:path';
import {homedir} from 'node:os';

const {values} = parseArgs({
  options: {
    network: {type: 'string', default: 'preprod'},
    wallet: {type: 'string'},
    call: {type: 'string', default: 'getState'},
    params: {type: 'string', default: '{}'},
    pretty: {type: 'boolean', default: false},
    'timeout-ms': {type: 'string', default: '15000'},
  },
});

if (!values.wallet) {
  console.error('error: --wallet <name> required');
  console.error('usage: node scripts/daemon-probe.mjs --wallet <name> [--network preprod] [--call getState] [--params \'{}\']');
  process.exit(2);
}

const socketPath = join(homedir(), '.moth', 'sync', values.network, `${values.wallet}.sock`);
const timeoutMs = Number(values['timeout-ms']) || 15000;
let params;
try {
  params = JSON.parse(values.params);
} catch (err) {
  console.error(`error: --params is not valid JSON: ${err.message}`);
  process.exit(2);
}

console.error(`probe → ${socketPath}`);

const sock = createConnection(socketPath);

sock.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(`error: no socket at ${socketPath} — is the TUI running with wallet "${values.wallet}" on ${values.network}?`);
  } else if (err.code === 'ECONNREFUSED') {
    console.error(`error: socket file exists but nothing is listening (${socketPath}) — stale leftover from a crashed TUI`);
  } else {
    console.error(`connect error: ${err.code ?? ''} ${err.message}`);
  }
  process.exit(1);
});

// Wire format (must match packages/core/src/daemon/protocol.ts):
//   4-byte big-endian uint32 payload length, then UTF-8 JSON.
function encodeFrame(frame) {
  const json = Buffer.from(JSON.stringify(frame), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

let buffer = Buffer.alloc(0);
const pending = new Map();

sock.on('data', (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32BE(0);
    if (buffer.length < 4 + len) break;
    const payload = buffer.subarray(4, 4 + len).toString('utf-8');
    buffer = buffer.subarray(4 + len);
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch (err) {
      console.error(`malformed frame from daemon: ${err.message}`);
      sock.destroy();
      process.exit(1);
    }
    if (frame.type !== 'response') {
      console.error(`unexpected frame.type=${frame.type} from daemon`);
      continue;
    }
    const waiter = pending.get(frame.id);
    if (!waiter) continue;
    pending.delete(frame.id);
    clearTimeout(waiter.timer);
    if (frame.error) waiter.reject(frame.error);
    else waiter.resolve(frame.result);
  }
});

function call(method, p) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject({code: 'TIMEOUT', message: `${method} timed out after ${timeoutMs}ms`});
    }, timeoutMs);
    pending.set(id, {resolve, reject, timer});
    sock.write(encodeFrame({id, type: 'request', method, params: p}));
  });
}

sock.on('connect', async () => {
  try {
    const version = await call('version');
    console.error(`handshake: protocol=${version.protocol} daemon=${version.daemon}`);

    const result = await call(values.call, params);
    process.stdout.write(JSON.stringify(result, null, values.pretty ? 2 : 0));
    process.stdout.write('\n');
    sock.end();
    process.exit(0);
  } catch (err) {
    if (err && err.code && err.message) {
      console.error(`error: [${err.code}] ${err.message}`);
    } else {
      console.error(`error: ${err}`);
    }
    sock.destroy();
    process.exit(1);
  }
});
