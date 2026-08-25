// Smoke coverage for things that fail before any command body runs.
//
// `moth config` shipped unusable: it declared an optional positional argument
// (`action`) ahead of a required one (`key`), which @oclif/core rejects, so every
// invocation died at spec validation (#53). Nothing caught it because no test
// invoked the command at all.
//
// Two probes, and it is worth being precise about what each one can see:
//
//   * `--help` renders without validating positional-argument ORDER. Measured:
//     with the bad spec in place, `moth config --help` prints help perfectly
//     happily, while bare `moth config` reports "Invalid argument spec". So the
//     help sweep below catches broken flags, examples and imports — but it would
//     NOT have caught the bug that prompted it.
//   * The order rule itself is therefore checked statically, from source. That is
//     the probe that bites.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI_ROOT = join(__dirname, '..', '..');
const ENTRY = join(CLI_ROOT, 'dist', 'index.js');
const COMMANDS_DIR = join(CLI_ROOT, 'src', 'commands');

interface CommandSource {
  /** Command id as typed, e.g. `wallet generate`. */
  readonly id: string;
  readonly source: string;
}

function allCommands(dir = COMMANDS_DIR, prefix = ''): CommandSource[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return allCommands(join(dir, entry.name), `${prefix}${entry.name} `);
    if (!entry.name.endsWith('.ts')) return [];
    return [{
      id: `${prefix}${entry.name.replace(/\.ts$/, '')}`,
      source: readFileSync(join(dir, entry.name), 'utf-8'),
    }];
  });
}

const commands = allCommands();

describe('positional argument order', () => {
  it('found commands to check, so this cannot pass vacuously', () => {
    expect(commands.length).toBeGreaterThan(20);
  });

  // The #53 regression, checked from source because no runtime probe short of a
  // bare invocation sees it — and invoking every command bare would run them.
  it('never declares an optional positional argument before a required one', () => {
    const offenders: string[] = [];

    for (const { id, source } of commands) {
      const block = /static override args\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(source);
      if (!block) continue;

      // One entry per `name: Args.<type>({ ... })`, in declaration order.
      const entries = [...block[1].matchAll(/(\w+)\s*:\s*Args\.\w+\(\{([\s\S]*?)\}\)/g)];
      let seenOptional: string | null = null;
      for (const [, name, body] of entries) {
        const required = /required\s*:\s*true/.test(body);
        if (!required) seenOptional ??= name;
        else if (seenOptional) offenders.push(`${id}: required "${name}" follows optional "${seenOptional}"`);
      }
    }

    expect(
      offenders,
      'oclif rejects this outright — with the earlier argument absent, a single value is ambiguous, so every invocation of the command fails at spec validation',
    ).toEqual([]);
  });
});

describe('every command renders help', () => {
  beforeAll(() => {
    if (!existsSync(ENTRY)) throw new Error('run `yarn build` in packages/cli first — this exercises the built CLI');
  });

  // Catches a broken flag definition, a bad example, or an import that throws on
  // load. Deliberately not claimed to catch argument-order problems: it does not.
  it.each(commands.map((c) => c.id))('renders help for `%s`', async (id) => {
    // A throwaway HOME so a smoke run never reads or writes real wallet state.
    const home = mkdtempSync(join(tmpdir(), 'moth-smoke-'));
    let result: { code: number; out: string };
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, ...id.split(' '), '--help'], {
        timeout: 60_000,
        env: { ...process.env, HOME: home },
      });
      result = { code: 0, out: stdout + stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      result = { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
    expect({ id, code: result.code, out: result.out.slice(0, 300) }).toMatchObject({ code: 0 });
  }, 70_000);
});
