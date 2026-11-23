// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../lib/i18n';

const sendMessage = vi.fn();
vi.mock('../lib/messaging/protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/messaging/protocol')>()),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

const { Cardano, STATUS_TIMEOUT_MS } = await import('../components/screens/Cardano');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADDRESS = 'addr1q9vmhusye6ljddgtwd5pa30u4wxqhql0qdhuy2fq4u8hcxp0j3afwydnc63flgmr8wn85w472cnke3vh8tf4a0p3a7qsd2l4df';
const account = {
  cardanoNetwork: 'Mainnet',
  address: ADDRESS,
  rewardAddress: 'stake1uyheg75hzxeudg5l5d3nhfn682l9vfmvcktn4567hsc7lqgupwt64',
  stakeKeyHash: 'aa',
  paymentKeyHash: 'bb',
};

let container: HTMLElement;
let root: Root;

/** Lets every pending promise callback and the re-renders they cause run. */
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

describe('Cardano screen while the chain read is slow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMessage.mockReset().mockImplementation((type: string) => {
      switch (type) {
        case 'cardanoAccountList':
          return Promise.resolve({ accounts: [], activeId: '' });
        case 'cardanoAddresses':
          return Promise.resolve(account);
        case 'cardanoReceiverAccounts':
          return Promise.resolve([]);
        case 'cardanoBalance':
          return Promise.resolve({ lovelace: '1176630', cnight: '1000000000', cnightUtxos: 1 });
        case 'cardanoStatus':
          return new Promise(() => {}); // never answers
        default:
          return Promise.reject(new Error(`unexpected ${type}`));
      }
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('shows the derived address before the status read answers', async () => {
    act(() => root.render(<Cardano network="mainnet" onBack={() => {}} />));
    await flush();

    expect(container.textContent).toContain(t('cardano_readingChain'));
    expect(container.textContent).toContain(ADDRESS.slice(-6));
    expect(container.textContent).not.toContain(t('cardano_loading'));
  });

  it('shows ADA and cNIGHT before the registration read answers', async () => {
    act(() => root.render(<Cardano network="mainnet" onBack={() => {}} />));
    await flush();

    expect(container.textContent).toContain('1.17663');
    expect(container.textContent).toContain('1000');
    expect(container.textContent).toContain(t('cardano_readingChain'));
  });

  it('turns a status read that never answers into an error with a retry', async () => {
    act(() => root.render(<Cardano network="mainnet" onBack={() => {}} />));
    await flush();

    await act(async () => vi.advanceTimersByTime(STATUS_TIMEOUT_MS));
    await flush();

    expect(container.textContent).toContain(t('cardano_errorStatusTimeout'));
    expect(container.textContent).not.toContain(t('cardano_readingChain'));
    expect(container.textContent).toContain(ADDRESS.slice(-6));
    expect(container.textContent).toContain('1.17663');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === t('cardano_retry'))).toBe(true);
  });
});
