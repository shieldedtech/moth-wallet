import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, parseAppearance, resolveClasses } from '../lib/ui/theme';

describe('parseAppearance', () => {
  it('round-trips a stored appearance', () => {
    expect(parseAppearance(JSON.stringify({ theme: 'dark', colorblind: true }))).toEqual({
      theme: 'dark',
      colorblind: true,
    });
  });

  it('falls back to defaults for missing, corrupt or unknown values', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{not json')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('"dark"')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance(JSON.stringify({ theme: 'sepia', colorblind: 'yes' }))).toEqual(
      DEFAULT_APPEARANCE,
    );
  });
});

describe('resolveClasses', () => {
  it('follows the OS only when the preference is system', () => {
    expect(resolveClasses({ theme: 'system', colorblind: false }, true).dark).toBe(true);
    expect(resolveClasses({ theme: 'system', colorblind: false }, false).dark).toBe(false);
    expect(resolveClasses({ theme: 'light', colorblind: false }, true).dark).toBe(false);
    expect(resolveClasses({ theme: 'dark', colorblind: false }, false).dark).toBe(true);
  });

  it('applies the color-blind axis independently of the scheme', () => {
    expect(resolveClasses({ theme: 'light', colorblind: true }, false)).toEqual({
      dark: false,
      colorblind: true,
    });
    expect(resolveClasses({ theme: 'dark', colorblind: true }, false)).toEqual({
      dark: true,
      colorblind: true,
    });
  });
});
