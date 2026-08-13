import { describe, it, expect } from 'vitest';
import { preseedControl } from '../lib/ui/preseed-control';

// The point of this module is that the on-device build — a chain walk, measured
// at 53.6 min on preprod — is offered in exactly one situation. These pin that
// situation rather than the rendering around it.
describe('preseedControl', () => {
  it('offers the build only when nothing is ready and nothing ships', () => {
    expect(preseedControl({ ready: false, bundled: false })).toBe('offer');
  });

  it('does not offer a build for a network this release ships a reference for', () => {
    // The build would spend an hour arriving at what is already in the package.
    expect(preseedControl({ ready: false, bundled: true })).toBe('included');
  });

  it('reports ready once a reference is in the store, however it got there', () => {
    expect(preseedControl({ ready: true, bundled: true })).toBe('ready');
    expect(preseedControl({ ready: true, bundled: false })).toBe('ready');
  });

  it('shows nothing before the status arrives', () => {
    // Guessing 'offer' flashes an hour-long build offer that the first poll
    // retracts; guessing 'included' claims a reference we have not confirmed.
    expect(preseedControl(null)).toBe('unknown');
  });
});
