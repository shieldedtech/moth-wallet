// The build stamp is the answer to "is the extension I just reloaded the one I
// compiled?", so the thing that matters is that it never renders something
// misleading: no "Invalid Date", and no bare "Built" for a bundle that carries
// no stamp (vitest, or an older build).

import { describe, expect, it } from 'vitest';
import { BUILD_TIME, formatBuildTime } from '../lib/ui/build-info';

describe('build stamp', () => {
  it('is empty outside a real build, because vitest runs no define pass', () => {
    expect(BUILD_TIME).toBe('');
  });

  it('renders nothing when the bundle carries no stamp', () => {
    expect(formatBuildTime('')).toBeNull();
  });

  it('renders nothing rather than "Invalid Date" for an unparseable stamp', () => {
    expect(formatBuildTime('not-a-date')).toBeNull();
  });

  it('renders a stamped build as a readable local date and time', () => {
    const shown = formatBuildTime('2026-09-16T19:44:01.000Z');
    expect(shown).not.toBeNull();
    // Rendered in the runner's locale/zone, so assert the parts that hold
    // everywhere rather than an exact string.
    expect(shown).toMatch(/2026/);
    expect(shown).toMatch(/\d{1,2}:\d{2}/);
  });
});
