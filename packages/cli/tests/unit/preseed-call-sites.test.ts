// Guard: every startWalletSync call must pass a birthday.
//
// The pre-seed gate is `(isNewWallet || birthday)`, so a call site that omits the
// 6th argument silently never pre-seeds — the wallet walks the chain from genesis
// however good a reference is sitting in the store, with no warning and no error.
// That is exactly how the birthday ended up written to disk and read by nobody:
// eleven CLI commands and the TUI hook all called it with three to five
// arguments, so no surface but the extension could ever pre-seed.
//
// Walks the AST rather than grepping, because the calls are multi-line and the
// argument that matters is positional.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/** Packages whose sync call sites must supply a birthday. */
const ROOTS = [
  join(__dirname, '..', '..', 'src'),
  join(__dirname, '..', '..', '..', 'tui', 'src'),
];

/** Position of `birthday` in startWalletSync(keys, network, onProgress, name, isNew, birthday). */
const BIRTHDAY_ARG_INDEX = 5;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly argCount: number;
}

function syncCallSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf-8');
      if (!text.includes('startWalletSync')) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'startWalletSync'
        ) {
          found.push({
            file: relative(join(__dirname, '..', '..', '..', '..'), file),
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            argCount: node.arguments.length,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

describe('startWalletSync call sites', () => {
  it('finds the call sites at all, so a rename cannot make this test vacuous', () => {
    expect(syncCallSites().length).toBeGreaterThan(5);
  });

  it('every call passes a birthday, or no wallet on that surface can pre-seed', () => {
    const missing = syncCallSites().filter((site) => site.argCount <= BIRTHDAY_ARG_INDEX);
    expect(
      missing.map((site) => `${site.file}:${site.line} passes ${site.argCount} args`),
      'these call sites omit the birthday, so they always sync from genesis',
    ).toEqual([]);
  });
});

// Issue #48: the same "whichever surface remembers" hazard, on the write side.
// `manager.generate(name, passphrase, network, birthday?)` writes both
// createdAtHeight and birthdays only when the 4th argument is present, so a
// generate call that omits it produces an account that syncs from genesis while
// claiming in the README to get a birthday automatically. Core cannot supply it
// itself without doing network I/O in the keystore layer, so the guard is here
// instead: every wallet-generate call must pass one.
const GENERATE_BIRTHDAY_ARG_INDEX = 3;

function walletGenerateCallSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf-8');
      if (!/\.generate\(/.test(text)) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'generate' &&
          // walletManager.generate / manager.generate / wallet.generate — not the
          // daemon key store's unrelated generate(label, scopes).
          /wallet|manager/i.test(node.expression.expression.getText())
        ) {
          found.push({
            file: relative(join(__dirname, '..', '..', '..', '..'), file),
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            argCount: node.arguments.length,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

describe('wallet generate call sites', () => {
  it('finds them, so a rename cannot make this vacuous', () => {
    expect(walletGenerateCallSites().length).toBeGreaterThan(1);
  });

  it('every call passes a birthday, or the account it creates syncs from genesis', () => {
    const missing = walletGenerateCallSites().filter((site) => site.argCount <= GENERATE_BIRTHDAY_ARG_INDEX);
    expect(
      missing.map((site) => `${site.file}:${site.line} passes ${site.argCount} args`),
      'these create accounts with no birthday, contradicting the documented behaviour',
    ).toEqual([]);
  });
});
