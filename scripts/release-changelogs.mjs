// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import {globSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const rootDir = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
const changelogPaths = globSync('packages/*/CHANGELOG.md', {cwd: rootDir}).sort();

if (changelogPaths.length === 0) {
  throw new Error(`no package changelogs found under ${rootDir}`);
}

for (const changelogPath of changelogPaths) {
  const absolutePath = resolve(rootDir, changelogPath);
  const contents = readFileSync(absolutePath, 'utf8');
  const normalized = contents.replace(/^[\t ]+$/gmu, '');
  if (normalized !== contents) writeFileSync(absolutePath, normalized);
}
