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

const BLOCKED = 'No Blockfrost project ID';

// The screen shows addresses as `addr1…<last 6>`, so the endings tell the accounts apart.
const ACCOUNTS = {
  a1: { label: 'Account 1', address: `addr1q${'x'.repeat(40)}one111`, reward: `stake1u${'x'.repeat(40)}one111` },
  a2: { label: 'Account 2', address: `addr1q${'x'.repeat(40)}two222`, reward: `stake1u${'x'.repeat(40)}two222` },
} as const;
type AccountId = keyof typeof ACCOUNTS;

const statusFor = (id: AccountId): CardanoStatusDTO => ({
  cardanoNetwork: 'mainnet',
  address: ACCOUNTS[id].address,
  rewardAddress: ACCOUNTS[id].reward,
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
});

let active: AccountId;
let blocked: boolean;
/** Message types whose replies wait for the test to settle them. */
let held: Set<string>;
let pending: Array<{ type: string; settle: () => void }>;

const accountList = () => ({
  accounts: (Object.keys(ACCOUNTS) as AccountId[]).map((id, accountIndex) => ({
    id,
    label: ACCOUNTS[id].label,
    kind: 'derived' as const,
    accountIndex,
  })),
  activeId: active,
});

/** Reads answer with the state at the time they are sent; a select takes effect when it settles. */
function reply(type: string, data: unknown): () => unknown {
  switch (type) {
    case 'cardanoAccountList': {
      const list = accountList();
      return () => list;
    }
    case 'cardanoReceiverAccounts':
      return () => [];
    case 'cardanoAddresses': {
      const { address, reward } = ACCOUNTS[active];
      return () => ({ cardanoNetwork: 'mainnet', address, rewardAddress: reward, stakeKeyHash: '00', paymentKeyHash: '00' });
    }
    case 'cardanoStatusCached':
      return () => null;
    case 'cardanoStatus': {
      const status = statusFor(active);
      const failing = blocked;
      return () => {
        if (failing) throw new Error(BLOCKED);
        return status;
      };
    }
    case 'cardanoAccountSelect':
      return () => {
        active = (data as { id: AccountId }).id;
        return accountList();
      };
    default:
      return () => undefined;
  }
}

async function settle(type: string, nth: number) {
  const entry = pending.filter((p) => p.type === type)[nth]!;
  pending.splice(pending.indexOf(entry), 1);
  await act(async () => entry.settle());
}

let container: HTMLElement;
let root: Root;

async function render() {
  await act(async () => root.render(<Cardano network="mainnet" onBack={() => {}} />));
}

const text = () => container.textContent ?? '';
const heading = () => container.querySelector('h1')?.textContent;
const buttons = () => [...container.querySelectorAll('button')];
const backArrow = () => container.querySelector<HTMLButtonElement>(`button[aria-label="${t('common_back')}"]`)!;
const done = () => buttons().find((b) => b.textContent === t('cardano_accountBack'))!;
const switchButton = () => buttons().find((b) => b.textContent === t('cardano_accountSwitch'))!;
const accountRow = () => buttons().find((b) => b.textContent?.includes(ACCOUNTS[active].label))!;
const statusReads = () => sendMessage.mock.calls.filter(([type]) => type === 'cardanoStatus').length;

beforeEach(() => {
  active = 'a1';
  blocked = false;
  held = new Set();
  pending = [];
  sendMessage.mockReset().mockImplementation(
    (type: string, data: unknown) =>
      new Promise((resolve, reject) => {
        const answer = reply(type, data);
        const run = () => {
          try {
            resolve(answer());
          } catch (err) {
            reject(err);
          }
        };
        if (held.has(type)) pending.push({ type, settle: run });
        else run();
      }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Cardano accounts back arrow', () => {
  // Without a Blockfrost project ID there is no status, so the overview has
  // nothing to show and the back arrow must not land there.
  it('returns to the blocked screen when the chain cannot be read', async () => {
    blocked = true;
    await render();
    expect(text()).toContain(t('cardano_chainUnavailable'));

    await act(async () => accountRow().click());
    expect(heading()).toBe(t('cardano_accountsTitle'));

    await act(async () => backArrow().click());
    expect(heading()).toBe(t('cardano_title'));
    expect(text()).toContain(t('cardano_chainUnavailable'));
    expect(text()).toContain(BLOCKED);
  });

  it('returns to the overview, re-read, when the chain can be read', async () => {
    await render();
    expect(text()).toContain(t('cardano_notRegistered'));

    await act(async () => accountRow().click());
    expect(heading()).toBe(t('cardano_accountsTitle'));

    await act(async () => backArrow().click());
    expect(heading()).toBe(t('cardano_title'));
    expect(text()).toContain(t('cardano_notRegistered'));
    expect(statusReads()).toBe(2);
  });
});

// Leaving the account list while Switch is still running starts a second
// refresh that overlaps the one Switch starts. The earlier one's replies are
// for the old account, so they must not land over the switched-to account.
describe('Cardano accounts left during Switch', () => {
  it.each([
    ['the back arrow', backArrow],
    ['Done', done],
  ])('shows the switched-to account when %s is tapped', async (_, leave) => {
    await render();
    await act(async () => accountRow().click());

    held.add('cardanoAccountSelect').add('cardanoStatus');
    await act(async () => switchButton().click());
    await act(async () => leave().click());
    await settle('cardanoAccountSelect', 0);
    // The switched-to account's read lands first, the old account's last.
    await settle('cardanoStatus', 1);
    await settle('cardanoStatus', 0);

    expect(text()).toContain(ACCOUNTS.a2.label);
    expect(text()).toContain('two222');
    expect(text()).not.toContain(ACCOUNTS.a1.label);
    expect(text()).not.toContain('one111');
  });

  it('ignores an account list read that the refresh after Switch has superseded', async () => {
    await render();
    await act(async () => accountRow().click());

    held.add('cardanoAccountSelect');
    await act(async () => switchButton().click());
    held.add('cardanoAccountList');
    await act(async () => backArrow().click());
    held.delete('cardanoAccountList');
    await settle('cardanoAccountSelect', 0);
    expect(text()).toContain('two222');

    // The list read before the switch committed still names Account 1 as active.
    await settle('cardanoAccountList', 0);
    expect(text()).toContain(ACCOUNTS.a2.label);
    expect(text()).not.toContain(ACCOUNTS.a1.label);
  });
});
