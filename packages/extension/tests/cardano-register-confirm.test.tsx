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

const SHIELDED = 'mn_shield-addr1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfevkcq';
const DUST = 'mn_dust1wvg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3z97x8jh';
const DUST_BYTES = `73${'11'.repeat(32)}`;

const receiverAccount = {
  name: 'Account-7', // storage name, never shown
  label: 'cover-mainnet-0',
  shieldedAddress: SHIELDED,
  dustAddress: DUST,
  dustAddressBytes: DUST_BYTES,
};
const notYetOpened = { ...receiverAccount, name: 'Account-8', label: 'old-account', dustAddress: '', dustAddressBytes: '' };

const status = {
  cardanoNetwork: 'Mainnet',
  address: 'addr1q9vmhusye6ljddgtwd5pa30u4wxqhql0qdhuy2fq4u8hcxp0j3afwydnc63flgmr8wn85w472cnke3vh8tf4a0p3a7qsd2l4df',
  rewardAddress: 'stake1uyheg75hzxeudg5l5d3nhfn682l9vfmvcktn4567hsc7lqgupwt64',
  stakeKeyHash: 'aa',
  paymentKeyHash: 'bb',
  lovelace: '5000000',
  cnight: '100000000',
  cnightUtxos: 1,
  registered: false,
  registeredDustAddress: null,
  registrationUtxo: null,
  generationRate: null,
  currentCapacity: null,
  maxCapacity: null,
  generatingFrom: null,
  secondsRemaining: null,
  midnightValid: null,
  registrationCount: 0,
  legacyDustAddress: false,
  registeredToThisWallet: false,
};

let container: HTMLElement;
let root: Root;

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});
const buttons = () => [...container.querySelectorAll('button')];
const click = async (el: Element | undefined) => {
  expect(el).toBeDefined();
  await act(async () => (el as HTMLElement).click());
  await flush();
};

let answerStatus: ((value: unknown) => void) | null = null;

describe('Registering cNIGHT to another Midnight account', () => {
  beforeEach(() => {
    sendMessage.mockReset().mockImplementation((type: string) => {
      switch (type) {
        case 'cardanoAccountList':
          return Promise.resolve({ accounts: [{ id: 'd0', label: 'Account 1', kind: 'derived', accountIndex: 0 }], activeId: 'd0' });
        case 'cardanoAddresses':
          return Promise.resolve(status);
        case 'cardanoReceiverAccounts':
          return Promise.resolve([receiverAccount, notYetOpened]);
        case 'cardanoBalance':
          return Promise.resolve({ lovelace: status.lovelace, cnight: status.cnight, cnightUtxos: 1 });
        case 'cardanoStatus':
          // Held open when a test wants to act while the read is out.
          return answerStatus === null ? Promise.resolve(status) : new Promise((r) => { answerStatus = r; });
        case 'cardanoResolveReceiver':
          return Promise.resolve({ dustAddressBytes: DUST_BYTES });
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
  });

  async function openPicker() {
    act(() => root.render(<Cardano network="mainnet" onBack={() => {}} />));
    await flush();
    await click(buttons().find((b) => b.textContent === t('cardano_register')));
  }

  it('lists each account by its DUST address, not its shielded one', async () => {
    await openPicker();

    const row = buttons().find((b) => b.textContent?.includes('cover-mainnet-0'))!;
    expect(row.textContent).toContain(DUST.slice(-6));
    expect(row.textContent).not.toContain(SHIELDED.slice(-6));
  });

  it('does not let an account with no DUST address yet be picked', async () => {
    await openPicker();

    const row = buttons().find((b) => b.textContent?.includes('old-account'))!;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain(t('cardano_receiverNoDustAddress'));
  });

  it('confirms with the label and DUST address that were picked', async () => {
    await openPicker();
    await click(buttons().find((b) => b.textContent?.includes('cover-mainnet-0')));
    await click(buttons().find((b) => b.textContent === t('cardano_confirm')));

    const text = container.textContent ?? '';
    expect(text).toContain(t('cardano_confirmTitle'));
    expect(text).toContain('cover-mainnet-0');
    expect(text).toContain(DUST.slice(-6));
    expect(text).not.toContain('Account-7');
    expect(text).toContain(t('cardano_confirmAccountLabel'));
    expect(text).toContain(t('cardano_registerRotationNote', ['Account 1']));
  });
});

describe('Opening the account manager while the registration is read', () => {
  beforeEach(() => {
    answerStatus = () => {};
    sendMessage.mockImplementation((type: string) => {
      switch (type) {
        case 'cardanoAccountList':
          return Promise.resolve({ accounts: [{ id: 'd0', label: 'Account 1', kind: 'derived', accountIndex: 0 }], activeId: 'd0' });
        case 'cardanoAddresses':
          return Promise.resolve(status);
        case 'cardanoReceiverAccounts':
          return Promise.resolve([receiverAccount]);
        case 'cardanoBalance':
          return Promise.resolve({ lovelace: status.lovelace, cnight: status.cnight, cnightUtxos: 1 });
        case 'cardanoStatus':
          return new Promise((r) => { answerStatus = r; });
        default:
          return Promise.reject(new Error(`unexpected ${type}`));
      }
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    answerStatus = null;
    act(() => root.unmount());
    container.remove();
  });

  it('stays on the account manager when the read finishes, and goes back to the reading screen before it does', async () => {
    act(() => root.render(<Cardano network="mainnet" onBack={() => {}} />));
    await flush();
    expect(container.textContent).toContain(t('cardano_readingChain'));

    await click(buttons().find((b) => b.textContent?.includes('Account 1')));
    expect(container.textContent).toContain(t('cardano_accountsTitle'));

    // Back before the read answers: the reading screen, not an empty overview.
    await click(container.querySelector('header button, button[aria-label]') ?? buttons()[0]);
    expect(container.textContent).toContain(t('cardano_readingChain'));

    await click(buttons().find((b) => b.textContent?.includes('Account 1')));
    await act(async () => answerStatus!(status));
    await flush();
    // The answer arrives while the manager is open: it stays open.
    expect(container.textContent).toContain(t('cardano_accountsTitle'));
  });
});
