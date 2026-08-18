#!/usr/bin/env node

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';

import {
  DEFAULT_NETWORKS,
  initSdk,
  preseedReferenceStatus,
  refreshEmptyRefCache,
  resolveLedgerVersion,
} from '@shieldedtech/moth-wallet';

import {preparePreseed} from './lib/prepare-preseed.mjs';

const {values} = parseArgs({
  options: {
    network: {type: 'string'},
    summary: {type: 'string'},
  },
});

if (!values.network) {
  const known = Object.keys(DEFAULT_NETWORKS).join('|');
  console.error(`Usage: node scripts/prepare-preseed.mjs --network <${known}> [--summary <path>]`);
  process.exit(2);
}

try {
  // Load the SDK generation and ledger this network speaks; the sync below
  // reaches both seams.
  const selected = DEFAULT_NETWORKS[values.network];
  if (selected) await initSdk(resolveLedgerVersion(selected));

  const result = await preparePreseed(values.network, {
    networks: DEFAULT_NETWORKS,
    status: preseedReferenceStatus,
    refresh: refreshEmptyRefCache,
    onProgress: (message) => console.error(message),
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;

  if (values.summary) {
    const summaryPath = resolve(values.summary);
    mkdirSync(dirname(summaryPath), {recursive: true});
    writeFileSync(summaryPath, output, {mode: 0o600});
  }

  process.stdout.write(output);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
