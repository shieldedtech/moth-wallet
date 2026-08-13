import { describe, expect, it } from 'vitest';
import { splitSeedPhrase, formatSeedPhrase } from '../lib/ui/seed-phrase';

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('splitSeedPhrase', () => {
  it('splits the ordinary space-separated phrase', () => {
    expect(splitSeedPhrase(PHRASE)).toEqual(PHRASE.split(' '));
  });

  it('splits a comma-separated phrase — the shape a spreadsheet hands back', () => {
    expect(splitSeedPhrase('abandon,ability,able')).toEqual(['abandon', 'ability', 'able']);
    expect(splitSeedPhrase('abandon, ability, able')).toEqual(['abandon', 'ability', 'able']);
  });

  it('splits on newlines and tabs, so a phrase off a printed backup pastes', () => {
    expect(splitSeedPhrase('abandon\nability\r\nable\tabout')).toEqual(['abandon', 'ability', 'able', 'about']);
  });

  it('tolerates mixed and repeated separators', () => {
    expect(splitSeedPhrase(' abandon ,,  ability;\n able , ')).toEqual(['abandon', 'ability', 'able']);
  });

  it('drops position numbers so a copied numbered grid round-trips back in', () => {
    expect(splitSeedPhrase('1 abandon 2 ability 3 able')).toEqual(['abandon', 'ability', 'able']);
    expect(splitSeedPhrase('1. abandon, 2. ability, 3. able')).toEqual(['abandon', 'ability', 'able']);
    expect(splitSeedPhrase('1) abandon 2) ability')).toEqual(['abandon', 'ability']);
    expect(splitSeedPhrase('(1) abandon (2) ability')).toEqual(['abandon', 'ability']);
  });

  it('never drops a real word — no BIP39 word is numeric, so only indices go', () => {
    // The guard is "purely numeric", not "contains a digit": a word that merely
    // sits next to a number must survive intact.
    expect(splitSeedPhrase('12 abandon12 ability')).toEqual(['abandon12', 'ability']);
  });

  it('returns nothing for empty or separator-only input', () => {
    expect(splitSeedPhrase('')).toEqual([]);
    expect(splitSeedPhrase('   ')).toEqual([]);
    expect(splitSeedPhrase(' , ; \n ')).toEqual([]);
  });

  it('leaves case alone so a wrong word fails validation instead of being guessed at', () => {
    expect(splitSeedPhrase('Abandon ABILITY')).toEqual(['Abandon', 'ABILITY']);
  });

  it('round-trips its own output', () => {
    expect(splitSeedPhrase(formatSeedPhrase(PHRASE.split(' ')))).toEqual(PHRASE.split(' '));
  });
});

describe('formatSeedPhrase', () => {
  it('joins with single spaces — the form every import field expects', () => {
    expect(formatSeedPhrase(['abandon', 'ability', 'able'])).toBe('abandon ability able');
  });

  it('collapses padding from a partly-filled grid rather than emitting blanks', () => {
    expect(formatSeedPhrase(['abandon', '', '  ', 'able'])).toBe('abandon able');
  });

  it('trims stray whitespace on individual cells', () => {
    expect(formatSeedPhrase([' abandon ', 'ability\n'])).toBe('abandon ability');
  });

  it('carries no position numbers', () => {
    const out = formatSeedPhrase(PHRASE.split(' '));
    expect(out).toBe(PHRASE);
    expect(/\d/.test(out)).toBe(false);
  });
});
