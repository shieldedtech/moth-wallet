// Guard: user-facing copy must come from the i18n catalogs (lib/i18n), never
// from literals in the UI source. Walks every component/entrypoint .tsx AST
// and fails on JSX text nodes and user-facing attributes that carry prose, so
// a hardcoded string can't make it past CI. Exceptions are rare and explicit —
// add to ALLOWED below with a reason.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const UI_ROOTS = ['components', 'entrypoints'];
const PACKAGE_ROOT = join(__dirname, '..');

/** Attributes whose values are shown to (or read aloud for) the user. */
const USER_FACING_ATTRIBUTES = new Set(['placeholder', 'aria-label', 'title', 'alt']);

/** Deliberate literal exceptions, each with a reason to exist. */
const ALLOWED: RegExp[] = [
  /^mn_/, // address-format hints (mn_addr…, mn_shield-addr…) — not prose
  /^N$/, // the NIGHT token glyph letter
  /^MOTH$/, // the wordmark on the setup shell — a brand mark, never translated
];

/** Prose = two or more consecutive letters; symbols, digits and single glyphs pass. */
function looksLikeProse(text: string): boolean {
  const trimmed = text.trim();
  if (!/[A-Za-z]{2,}/.test(trimmed)) return false;
  return !ALLOWED.some((pattern) => pattern.test(trimmed));
}

/**
 * Whole surfaces exempt from the catalogs, each with a reason.
 *
 * entrypoints/debug — the phase-timings instrument. A developer tool reached only
 * by typing its URL, never linked from the wallet UI. Its labels are metric names
 * ("first balances emission", "Δ"), so translating them would put developer
 * vocabulary into the shipped user catalogs and force three translations per
 * metric rename.
 */
const EXCLUDED_DIRS = [join('entrypoints', 'debug')];

function listTsxFiles(dir: string): string[] {
  if (EXCLUDED_DIRS.some((excluded) => dir.endsWith(excluded))) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTsxFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** Template literal text outside ${…} holes. */
function templateText(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
}

function findViolations(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];

  const report = (node: ts.Node, text: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    violations.push(`${relative(PACKAGE_ROOT, file)}:${line + 1} "${text.trim()}"`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && looksLikeProse(node.text)) {
      report(node, node.text);
    }
    if (ts.isJsxAttribute(node) && USER_FACING_ATTRIBUTES.has(node.name.getText())) {
      const value = node.initializer;
      if (value && ts.isStringLiteral(value) && looksLikeProse(value.text)) {
        report(value, value.text);
      }
      if (value && ts.isJsxExpression(value) && value.expression) {
        const expr = value.expression;
        if (ts.isStringLiteral(expr) && looksLikeProse(expr.text)) report(expr, expr.text);
        if (ts.isTemplateLiteral(expr) && looksLikeProse(templateText(expr))) report(expr, templateText(expr));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return violations;
}

describe('no hardcoded UI strings', () => {
  it('keeps all user-facing copy in the i18n catalogs', () => {
    const violations = UI_ROOTS.flatMap((root) => listTsxFiles(join(PACKAGE_ROOT, root))).flatMap(findViolations);

    expect(
      violations,
      `Found hardcoded UI strings — move them to lib/i18n/messages/ and render with t():\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
