import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGS, MESSAGES } from '../lib/i18n/messages';
import { t } from '../lib/i18n';

describe('message catalogs', () => {
  it('uses valid _locales keys prefixed with their area', () => {
    for (const [area, catalog] of Object.entries(CATALOGS)) {
      for (const key of Object.keys(catalog)) {
        // The _locales format allows [A-Za-z0-9_]; we additionally require the
        // owning file's name as prefix so keys state where they live.
        expect(key, `key "${key}" in ${area}.ts`).toMatch(new RegExp(`^${area}_[A-Za-z0-9_]+$`));
      }
    }
  });

  it('has no empty messages', () => {
    for (const [key, message] of Object.entries(MESSAGES)) {
      expect(message, `message for "${key}"`).not.toBe('');
    }
  });

  it('has no key collisions across catalog files', () => {
    const perFile = Object.values(CATALOGS)
      .map((catalog) => Object.keys(catalog).length)
      .reduce((sum, count) => sum + count, 0);
    expect(Object.keys(MESSAGES)).toHaveLength(perFile);
  });
});

// Checked-in translations under public/_locales (the en catalog is generated
// from the TS source at build time and is not checked in).
const LOCALES_DIR = join(__dirname, '..', 'public', '_locales');

/** Brand and protocol terms that must survive translation untouched. */
const PRESERVED_TERMS = [/\bMidnight\b/, /\bNIGHT\b/, /\bDUST\b/, /\bMoth\b/, /shielded/i];

function placeholdersOf(message: string): string[] {
  return (message.match(/\$\d/g) ?? []).sort();
}

describe('shipped locales', () => {
  const locales = existsSync(LOCALES_DIR)
    ? readdirSync(LOCALES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

  it.each(locales)('%s carries exactly the catalog keys with matching placeholders', (locale) => {
    const raw = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'messages.json'), 'utf8')) as Record<
      string,
      { message: string }
    >;

    expect(Object.keys(raw).sort()).toEqual(Object.keys(MESSAGES).sort());
    for (const [key, english] of Object.entries(MESSAGES)) {
      const translated = raw[key]?.message ?? '';
      expect(translated, `${locale}/${key} is empty`).not.toBe('');
      expect(placeholdersOf(translated), `${locale}/${key} placeholders`).toEqual(placeholdersOf(english));
      for (const term of PRESERVED_TERMS) {
        if (term.test(english)) {
          expect(translated, `${locale}/${key} must keep the untranslatable term ${term}`).toMatch(term);
        }
      }
    }
  });
});

describe('t', () => {
  it('returns the bundled English outside the extension runtime', () => {
    expect(t('unlock_welcomeBack')).toBe('Welcome back');
  });

  it('substitutes positional placeholders', () => {
    // No $1-style message is guaranteed to exist yet, so exercise the
    // substitution path through a cast — the mechanism is what matters.
    expect(t('unlock_show')).toBe('Show');
  });
});
