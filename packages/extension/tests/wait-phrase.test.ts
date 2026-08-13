import { describe, it, expect } from 'vitest';
import { waitPhrase } from '../lib/ui/wait-phrase';
import { MESSAGES } from '../lib/i18n/messages';

describe('waitPhrase', () => {
  it('never says zero', () => {
    // The caller only asks when there is a wait, so rounding one down to "0
    // seconds" would read as a bug rather than as "almost ready".
    expect(waitPhrase(0)).toEqual({ key: 'dust_waitSeconds', args: ['1'] });
    expect(waitPhrase(0.4)).toEqual({ key: 'dust_waitSeconds', args: ['1'] });
  });

  it('picks a unit that suits the magnitude', () => {
    expect(waitPhrase(37)).toEqual({ key: 'dust_waitSeconds', args: ['37'] });
    expect(waitPhrase(363)).toEqual({ key: 'dust_waitMinutes', args: ['6'] });
    expect(waitPhrase(3_629)).toEqual({ key: 'dust_waitHour' });
    expect(waitPhrase(28_559)).toEqual({ key: 'dust_waitHours', args: ['8'] });
    expect(waitPhrase(200_000)).toEqual({ key: 'dust_waitDays', args: ['2'] });
  });

  it('reads an hour-ish wait as "an hour" rather than a count', () => {
    // The measured 10-NIGHT case is 3,629s. "about 1 hours" would be wrong in
    // English and awkward to translate.
    expect(waitPhrase(3_600).key).toBe('dust_waitHour');
    expect(waitPhrase(5_399).key).toBe('dust_waitHour');
    expect(waitPhrase(5_400)).toEqual({ key: 'dust_waitHours', args: ['2'] });
  });

  it('uses keys that exist in the catalog with matching placeholders', () => {
    // A phrase referring to a missing key, or passing an argument to a string
    // with no $1, fails silently at render time — the user sees a raw key or a
    // dangling sentence. Cheaper to catch here.
    for (const seconds of [1, 59, 60, 3_599, 3_600, 5_400, 86_400, 1_000_000]) {
      const { key, args } = waitPhrase(seconds);
      const template: string | undefined = (MESSAGES as Record<string, string>)[key];
      expect(template, `missing catalog key: ${key}`).toBeDefined();
      expect(template!.includes('$1'), `${key} placeholder vs args`).toBe(args !== undefined);
    }
  });
});
