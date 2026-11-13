// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

// Guard: a native <select> list paints its options from their own colors, not
// the page surface, so every palette must give them an opaque, readable pair.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'assets', 'globals.css'), 'utf8');

/** The palettes a <select> can render under; later entries fall back to :root. */
const PALETTES = {
  light: ':root',
  dark: '.dark',
  ink: ':where(:root:not(.dark)) .ink',
} as const;

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no "${selector}" block in globals.css`);
  return css.slice(start, css.indexOf('}', start));
}

function declaration(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(body)?.[1].trim();
}

function token(palette: string, name: string): string {
  const value = declaration(block(palette), name) ?? declaration(block(':root'), name);
  if (!value) throw new Error(`${name} is not defined for ${palette}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const optionRule = /@layer base\s*\{[^]*?\boption\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const optionToken = (property: string) =>
  /^var\((--[\w-]+)\)$/.exec(declaration(optionRule, property) ?? '')?.[1];

describe('native <select> option colors', () => {
  it('styles options from theme tokens', () => {
    expect(optionToken('background-color')).toBeDefined();
    expect(optionToken('color')).toBeDefined();
  });

  it.each(Object.entries(PALETTES))('reads in the %s palette', (_, selector) => {
    const background = token(selector, optionToken('background-color')!);
    const text = token(selector, optionToken('color')!);
    expect(background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(text).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(background, text)).toBeGreaterThanOrEqual(4.5);
  });
});
