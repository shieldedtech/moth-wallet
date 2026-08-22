import {describe, expect, it} from 'vitest';
import {indexerWsUrl} from '../../../src/network/first-activity.js';

// The module's own logic is a subscription loop, which is exercised against the
// live indexer rather than mocked. What is worth pinning here is the endpoint
// derivation it shares with first-activity — a single definition, so a change to
// either cannot silently diverge.
describe('dust generations endpoint', () => {
  it('shares one ws-url derivation with first-activity', () => {
    expect(indexerWsUrl('https://indexer.preprod.midnight.network/api/v4/graphql')).toBe(
      'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    );
  });
});
