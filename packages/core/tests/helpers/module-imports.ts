// Shared module-specifier parsing for the bundle-boundary guards in this repo
// (core, browser and extension each assert a different rule over the same
// primitives). Lives here because core/tests/helpers is where shared fixtures
// already live; the boundary suites import it by relative path.
//
// Why regexes rather than a real parser: the assertions only need module
// specifiers, the inputs are this repo's own sources and tsc output, and adding a
// parser dependency to make a cheap guard heavier is a poor trade. What the
// guards cannot afford is a *silent* miss — a boundary test that stops seeing an
// import is indistinguishable from a boundary that holds. So comments are removed
// by a scanner rather than dodged by anchoring, imports that cannot be read are
// reported instead of skipped, and the statement patterns are tightened to the
// cases this codebase actually contains.

import { builtinModules } from 'node:module';

const BUILTINS = new Set(builtinModules);

/**
 * Replace every comment with spaces, preserving length and newlines so that
 * line-anchored patterns and match indices still line up with the original.
 *
 * Tracks string and template literals so that `//` inside `'wss://host'` is not
 * mistaken for a comment. It does not track regex literals, so a regex containing
 * an escaped slash could confuse it — verified absent from every file these
 * guards scan, and a mis-strip there would surface as a parse failure rather than
 * a silent pass, because the self-check assertions in each suite would notice.
 */
export function stripComments(source: string): string {
  const out = source.split('');
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    switch (state) {
      case 'code':
        if (char === '/' && next === '/') {
          state = 'line';
          out[i] = out[i + 1] = ' ';
          i++;
        } else if (char === '/' && next === '*') {
          state = 'block';
          out[i] = out[i + 1] = ' ';
          i++;
        } else if (char === "'") state = 'single';
        else if (char === '"') state = 'double';
        else if (char === '`') state = 'template';
        break;
      case 'line':
        if (char === '\n') state = 'code';
        else out[i] = ' ';
        break;
      case 'block':
        if (char === '*' && next === '/') {
          state = 'code';
          out[i] = out[i + 1] = ' ';
          i++;
        } else if (char !== '\n') out[i] = ' ';
        break;
      case 'single':
        if (char === '\\') i++;
        else if (char === "'") state = 'code';
        break;
      case 'double':
        if (char === '\\') i++;
        else if (char === '"') state = 'code';
        break;
      case 'template':
        if (char === '\\') i++;
        else if (char === '`') state = 'code';
        break;
    }
  }
  return out.join('');
}

/**
 * `import x from 'm'`, `export { x } from 'm'`, `export * from 'm'`.
 *
 * The gap before `from` excludes quotes and semicolons so that a preceding
 * side-effect import (`import 'node:fs';`) is not swallowed into the next
 * statement's `from` clause and lost. The tempered `(?!\n[ \t]*(?:import|export))`
 * does the same job for statements that end without a semicolon: without it, a
 * `export type Foo = …` with no trailing semicolon absorbs the *following*
 * statement and mislabels its real value import as an erased type-only one.
 * Newlines are otherwise allowed, so multi-line named import lists still match.
 */
const FROM_STATEMENT =
  /^[ \t]*(?:import|export)\b(?:(?!\n[ \t]*(?:import|export)\b)[^'";])*?\bfrom[ \t]*['"]([^'"]+)['"]/gm;

/** `import 'm'` — imported for side effects only. */
const SIDE_EFFECT_STATEMENT = /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm;

/**
 * `import('m')` with a literal specifier, tolerating a trailing comma and
 * arbitrary wrapping — a formatter moving a long call onto several lines must not
 * blind the guard.
 *
 * Leading bundler pragmas need no handling here because `stripComments` has
 * already replaced them with spaces, which `\s*` absorbs. Matching them in this
 * pattern as well would nest a lazy quantifier inside a repetition group, which
 * backtracks exponentially on a run of overlapping block-comment delimiters — a
 * real ReDoS that CodeQL flagged, and pointless work besides.
 */
const DYNAMIC_LITERAL = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*,?\s*\)/g;

/** Any `import(` call, literal or not. */
const DYNAMIC_ANY = /\bimport\s*\(([^)]*)\)/g;

/** A statement-level `import type` / `export type`, which the compiler erases. */
const TYPE_ONLY_STATEMENT = /^[ \t]*(?:import|export)[ \t]+type\b/;

/**
 * Whether an `import(` occurrence is really the dynamic-import operator.
 *
 * `import` is a legal method name, and `WalletManager` uses it — `async import(name,
 * mnemonic, passphrase, network)` matches a naive `import\s*\(` and would otherwise
 * be reported as an unfollowable dynamic import. Three cheap discriminators cover
 * every shape in this repo: a member call is preceded by a dot, a function or
 * method named `import` is preceded by `async`/`function`, and a declaration's
 * parameter list is followed by a body brace rather than by more expression.
 */
function isDynamicImportCall(code: string, index: number, matched: string): boolean {
  let before = index - 1;
  while (before >= 0 && /\s/.test(code[before])) before--;
  if (before >= 0 && code[before] === '.') return false;
  if (/\b(?:async|function)$/.test(code.slice(Math.max(0, before - 8), before + 1))) return false;

  let after = index + matched.length;
  while (after < code.length && /\s/.test(code[after])) after++;
  return code[after] !== '{';
}

export interface ModuleImport {
  specifier: string;
  /** Dynamic imports resolve only if their enclosing code path runs. */
  kind: 'static' | 'dynamic';
  /** False for a statement-level `import type`, which costs a bundle nothing. */
  survivesCompilation: boolean;
}

/** Every module specifier in `source` whose target can be read, classified. */
export function moduleImports(source: string): ModuleImport[] {
  const code = stripComments(source);
  const found: ModuleImport[] = [];
  for (const pattern of [FROM_STATEMENT, SIDE_EFFECT_STATEMENT]) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      found.push({
        specifier: match[1],
        kind: 'static',
        // A side-effect import has no bindings to erase, so it always survives.
        survivesCompilation: !TYPE_ONLY_STATEMENT.test(match[0]),
      });
    }
  }
  DYNAMIC_LITERAL.lastIndex = 0;
  for (const match of code.matchAll(DYNAMIC_LITERAL)) {
    if (match.index === undefined || !isDynamicImportCall(code, match.index, match[0])) continue;
    found.push({ specifier: match[1], kind: 'dynamic', survivesCompilation: true });
  }
  return found;
}

/**
 * The argument expressions of `import(...)` calls whose specifier is *not* a
 * literal, in source order — `await import(specifier)` and friends.
 *
 * These are the imports a static walk cannot follow, and this codebase uses the
 * pattern deliberately to keep bundlers from resolving Node-only modules. A guard
 * that walks an import graph has to surface them: an edge it cannot see is
 * otherwise indistinguishable from an edge that is not there, and whatever sits
 * on the far side is unguarded without anyone knowing.
 */
export function opaqueDynamicImports(source: string): string[] {
  const code = stripComments(source);
  const literals = new Set<number>();
  DYNAMIC_LITERAL.lastIndex = 0;
  for (const match of code.matchAll(DYNAMIC_LITERAL)) {
    if (match.index !== undefined) literals.add(match.index);
  }
  const opaque: string[] = [];
  DYNAMIC_ANY.lastIndex = 0;
  for (const match of code.matchAll(DYNAMIC_ANY)) {
    if (match.index === undefined || literals.has(match.index)) continue;
    if (!isDynamicImportCall(code, match.index, match[0])) continue;
    opaque.push(match[1].trim());
  }
  return opaque;
}

/** Specifiers of imports that survive compilation, static and dynamic. */
export function runtimeSpecifiers(source: string): string[] {
  return moduleImports(source)
    .filter(entry => entry.survivesCompilation)
    .map(entry => entry.specifier);
}

/** Every readable specifier, including erased type-only imports. */
export function allSpecifiers(source: string): string[] {
  return moduleImports(source).map(entry => entry.specifier);
}

/**
 * Whether `specifier` names a Node builtin, with or without the `node:` prefix.
 *
 * Both spellings break a browser bundle identically, and the un-prefixed one is
 * what a contributor copying from older Node code writes, so testing for the
 * prefix alone would miss the more likely mistake. Derived from
 * `node:module`'s own list rather than a hand-maintained set.
 */
export function isPlatformBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return BUILTINS.has(bare) || BUILTINS.has(bare.split('/')[0]);
}

/** True when `specifier` is the package `pkg` or a subpath of it. */
export function isFrom(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * True when `specifier` comes from any Midnight package.
 *
 * Deliberately scope-wide rather than a list of package names: the published
 * names carry version suffixes that move (`@midnight-ntwrk/ledger-v8`,
 * `@midnight-ntwrk/compact-js`, `@midnight-ntwrk/onchain-runtime-v3`), and a list
 * that names `@midnight-ntwrk/ledger` matches none of them while looking like it
 * does. Every package under these scopes either carries WASM or pulls in
 * something that does, so the scope is the right granularity for a module that
 * must stay WASM-free.
 */
export function isMidnightPackage(specifier: string): boolean {
  return specifier.startsWith('@midnight-ntwrk/') || specifier.startsWith('@midnightntwrk/');
}
