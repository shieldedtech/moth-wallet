import { describe, expect, it } from 'vitest';
import { withoutOverrides, type TuiSettings } from '../../src/settings.js';

describe('resetting a network to its default endpoints', () => {
  const settings: TuiSettings = {
    lastNetwork: 'preprod',
    lastWallet: 'alice',
    networkOverrides: {
      preprod: { nodeUrl: 'wss://my-node.example' },
      preview: { indexerUrl: 'https://my-indexer.example/graphql' },
    },
  };

  it("drops only that network's overrides", () => {
    expect(withoutOverrides(settings, 'preprod')).toEqual({
      ...settings,
      networkOverrides: { preview: { indexerUrl: 'https://my-indexer.example/graphql' } },
    });
  });

  it('leaves a network with nothing to reset as it was', () => {
    expect(withoutOverrides(settings, 'devnet')).toEqual(settings);
  });

  it('does not change the settings it was given', () => {
    withoutOverrides(settings, 'preprod');
    expect(settings.networkOverrides.preprod).toEqual({ nodeUrl: 'wss://my-node.example' });
  });
});
