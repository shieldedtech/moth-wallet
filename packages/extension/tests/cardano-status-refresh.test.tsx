// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../lib/i18n';
import type { CardanoStatusDTO } from '../lib/messaging/protocol';

const sendMessage = vi.fn();
vi.mock('../lib/messaging/protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/messaging/protocol')>()),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

const { Cardano } = await import('../components/screens/Cardano');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accountList = {
  accounts: [{ id: 'a1', label: 'Account 1', kind: 'derived', accountIndex: 0 }],
  activeId: 'a1',
};

const derived = {
  cardanoNetwork: 'Mainnet',
  address: 'addr1qexampleaddress',
  rewardAddress: 'stake1uexamplerewardaddress',
  stakeKeyHash: '00',
  paymentKeyHash: '00',
};

const unregistered: CardanoStatusDTO = {
  cardanoNetwork: 'Mainnet',
  address: derived.address,
  rewardAddress: derived.rewardAddress,
  lovelace: '0',
  cnight: '0',
  cnightUtxos: 0,
  registered: false,
  registeredDustAddress: null,
  registeredToThisWallet: false,
  registrationUtxo: null,
  generationRate: null,
  currentCapacity: null,
  maxCapacity: null,
  generatingFrom: null,
  secondsRemaining: null,
  midnightValid: null,
  registrationCount: 0,
  legacyDustAddress: false,
};

const registered: CardanoStatusDTO = {
  ...unregistered,
  registered: true,
  registeredDustAddress: '73'.padEnd(66, '0'),
  registeredToThisWallet: true,
  registrationUtxo: `${'ab'.repeat(32)}#0`,
  registrationCount: 1,
};

/** Status reads the test answers by hand, in whatever order it likes. */
let reads: Array<{ resolve: (s: CardanoStatusDTO) => void; reject: (e: Error) => void }>;
let cached: { status: CardanoStatusDTO; readAt: number } | null;

let container: HTMLElement;
let root: Root;

async function render() {
  await act(async () => root.render(<Cardano network="mainnet" onBack={() => {}} />));
}

const text = () => container.textContent ?? '';
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!;

describe('Cardano status refresh', () => {
  beforeEach(() => {
    reads = [];
    cached = null;
    sendMessage.mockReset().mockImplementation((type: string) => {
      switch (type) {
        case 'cardanoAccountList':
          return Promise.resolve(accountList);
        case 'cardanoReceiverAccounts':
          return Promise.resolve([]);
        case 'cardanoAddresses':
          return Promise.resolve(derived);
        case 'cardanoStatusCached':
          return Promise.resolve(cached);
        case 'cardanoStatus':
          return new Promise((resolve, reject) => reads.push({ resolve, reject }));
        default:
          return Promise.resolve(undefined);
      }
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the last status at once and replaces it when the fresh read lands', async () => {
    cached = { status: unregistered, readAt: Date.now() - 60_000 };
    await render();

    expect(text()).toContain(t('cardano_notRegistered'));
    expect(text()).toContain(t('cardano_refreshing'));

    await act(async () => reads[0]!.resolve(registered));
    expect(text()).toContain(t('cardano_registered'));
    expect(text()).not.toContain(t('cardano_refreshing'));
  });

  it('keeps the last status, and says so, when the fresh read fails', async () => {
    cached = { status: unregistered, readAt: Date.now() - 60_000 };
    await render();

    await act(async () => reads[0]!.reject(new Error('Blockfrost answered 500 while listing UTXOs.')));
    expect(text()).toContain(t('cardano_notRegistered'));
    expect(text()).toContain(t('cardano_refreshFailed'));
    expect(text()).toContain('Blockfrost answered 500');
    expect(text()).not.toContain(t('cardano_refreshing'));
  });

  it('waits on the chain when there is nothing cached, showing the address meanwhile', async () => {
    await render();
    expect(text()).toContain(t('cardano_readingChain'));
    expect(text()).toContain(t('cardano_addressRow'));

    await act(async () => reads[0]!.resolve(unregistered));
    expect(text()).toContain(t('cardano_notRegistered'));
    expect(text()).not.toContain(t('cardano_refreshing'));
  });

  it('ignores a read that a later refresh has superseded', async () => {
    cached = { status: unregistered, readAt: Date.now() - 60_000 };
    await render();

    // Into the account list and back out, which re-reads.
    await act(async () => button('Account 1').click());
    await act(async () => button(t('cardano_accountBack')).click());
    expect(reads).toHaveLength(2);

    await act(async () => reads[1]!.resolve(registered));
    await act(async () => reads[0]!.resolve(unregistered));
    expect(text()).toContain(t('cardano_registered'));
    expect(text()).not.toContain(t('cardano_notRegistered'));
  });
});
