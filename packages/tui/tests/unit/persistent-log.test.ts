import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLog, getLogPath } from '../../src/persistent-log.js';

// The log once ignored MOTH_HOME and wrote to ~/.moth whatever the root was.
describe('persistent log', () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.MOTH_HOME;
    home = mkdtempSync(join(tmpdir(), 'moth-home-'));
    process.env.MOTH_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.MOTH_HOME;
    else process.env.MOTH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it('writes moth.log under MOTH_HOME', () => {
    appendLog('info', 'hello');
    expect(getLogPath()).toBe(join(home, 'moth.log'));
    expect(readFileSync(join(home, 'moth.log'), 'utf-8')).toContain('hello');
  });
});
