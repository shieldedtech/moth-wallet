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

const { Cardano } = await import('../components/screens/Cardano');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADDRESS = 'addr1qexampleaddress';
const REWARD = 'stake1uexamplerewardaddress';
const BLOCKED = 'No Blockfrost project ID';

const accountList = {
  accounts: [{ id: 'a1', label: 'Account 1', kind: 'derived', accountIndex: 0 }],
  activeId: 'a1',
};

const derived = {
  cardanoNetwork: 'mainnet',
  address: ADDRESS,
  rewardAddress: REWARD,
  stakeKeyHash: '00',
  paymentKeyHash: '00',
};

const status = {
  cardanoNetwork: 'mainnet',
  address: ADDRESS,
  rewardAddress: REWARD,
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

let container: HTMLElement;
let root: Root;
let readStatus: () => Promise<unknown>;

async function render() {
  await act(async () => root.render(<Cardano network="mainnet" onBack={() => {}} />));
}

const heading = () => container.querySelector('h1')?.textContent;
const backArrow = () => container.querySelector<HTMLButtonElement>(`button[aria-label="${t('common_back')}"]`)!;
const accountRow = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Account 1'))!;
const statusReads = () => sendMessage.mock.calls.filter(([type]) => type === 'cardanoStatus').length;

describe('Cardano accounts back arrow', () => {
  beforeEach(() => {
    sendMessage.mockReset().mockImplementation((type: string) => {
      switch (type) {
        case 'cardanoAccountList':
          return Promise.resolve(accountList);
        case 'cardanoReceiverAccounts':
          return Promise.resolve([]);
        case 'cardanoAddresses':
          return Promise.resolve(derived);
        case 'cardanoStatus':
          return readStatus();
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

  // Without a Blockfrost project ID there is no status, so the overview has
  // nothing to show and the back arrow must not land there.
  it('returns to the blocked screen when the chain cannot be read', async () => {
    readStatus = () => Promise.reject(new Error(BLOCKED));
    await render();
    expect(container.textContent).toContain(t('cardano_chainUnavailable'));

    await act(async () => accountRow().click());
    expect(heading()).toBe(t('cardano_accountsTitle'));

    await act(async () => backArrow().click());
    expect(heading()).toBe(t('cardano_title'));
    expect(container.textContent).toContain(t('cardano_chainUnavailable'));
    expect(container.textContent).toContain(BLOCKED);
  });

  it('returns to the overview, re-read, when the chain can be read', async () => {
    readStatus = () => Promise.resolve(status);
    await render();
    expect(container.textContent).toContain(t('cardano_notRegistered'));

    await act(async () => accountRow().click());
    expect(heading()).toBe(t('cardano_accountsTitle'));

    await act(async () => backArrow().click());
    expect(heading()).toBe(t('cardano_title'));
    expect(container.textContent).toContain(t('cardano_notRegistered'));
    expect(statusReads()).toBe(2);
  });
});
