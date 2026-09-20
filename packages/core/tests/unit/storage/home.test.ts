import {describe, it, expect, afterEach} from 'vitest';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {mothHome, MOTH_HOME_ENV} from '../../../src/storage/home.js';

const original = process.env[MOTH_HOME_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[MOTH_HOME_ENV];
  else process.env[MOTH_HOME_ENV] = original;
});

describe('mothHome', () => {
  it('defaults to ~/.moth when MOTH_HOME is unset', () => {
    delete process.env[MOTH_HOME_ENV];
    expect(mothHome()).toBe(join(homedir(), '.moth'));
  });

  it('defaults when MOTH_HOME is empty or whitespace', () => {
    process.env[MOTH_HOME_ENV] = '';
    expect(mothHome()).toBe(join(homedir(), '.moth'));
    process.env[MOTH_HOME_ENV] = '   ';
    expect(mothHome()).toBe(join(homedir(), '.moth'));
  });

  it('honours an absolute MOTH_HOME', () => {
    process.env[MOTH_HOME_ENV] = '/tmp/moth-test-root';
    expect(mothHome()).toBe('/tmp/moth-test-root');
  });

  it('trims surrounding whitespace', () => {
    process.env[MOTH_HOME_ENV] = '  /tmp/moth-test-root  ';
    expect(mothHome()).toBe('/tmp/moth-test-root');
  });

  it('rejects a relative MOTH_HOME rather than resolving it', () => {
    // A cwd-relative home resolves differently per process — the daemon, the
    // CLI and a supervisor rarely share a working directory, and three
    // different roots orphans keystores.
    process.env[MOTH_HOME_ENV] = 'relative/moth';
    expect(() => mothHome()).toThrow(/absolute path/);
  });

  it('rejects a bare directory name', () => {
    process.env[MOTH_HOME_ENV] = '.moth';
    expect(() => mothHome()).toThrow(/absolute path/);
  });

  it('re-reads the environment on every call', () => {
    // Captured at import instead of per call, a process that sets MOTH_HOME
    // after module load would silently use the wrong root.
    process.env[MOTH_HOME_ENV] = '/tmp/first';
    expect(mothHome()).toBe('/tmp/first');
    process.env[MOTH_HOME_ENV] = '/tmp/second';
    expect(mothHome()).toBe('/tmp/second');
  });
});
