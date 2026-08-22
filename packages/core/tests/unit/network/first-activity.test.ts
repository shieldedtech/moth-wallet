import {describe, expect, it} from 'vitest';
import {indexerWsUrl} from '../../../src/network/first-activity.js';

describe('indexerWsUrl', () => {
  it('upgrades https to wss and appends the subscription path', () => {
    expect(indexerWsUrl('https://indexer.preprod.midnight.network/api/v4/graphql')).toBe(
      'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    );
  });

  it('upgrades plain http for a local indexer', () => {
    expect(indexerWsUrl('http://localhost:8088/api/v4/graphql')).toBe('ws://localhost:8088/api/v4/graphql/ws');
  });

  it('does not double the separator when the URL already ends in a slash', () => {
    expect(indexerWsUrl('https://indexer.example/api/v4/graphql/')).toBe('wss://indexer.example/api/v4/graphql/ws');
  });
});
