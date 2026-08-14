#!/usr/bin/env node

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';

import {
  DEFAULT_NETWORKS,
  preseedReferenceStatus,
  refreshEmptyRefCache,
} from '@shieldedtech/moth-wallet';

import {preparePreseed} from './lib/prepare-preseed.mjs';

const {values} = parseArgs({
  options: {
    network: {type: 'string'},
    summary: {type: 'string'},
  },
});

if (!values.network) {
  console.error('Usage: node scripts/prepare-preseed.mjs --network <preview|preprod> [--summary <path>]');
  process.exit(2);
}

try {
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
