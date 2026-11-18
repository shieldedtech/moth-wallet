// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../lib/background/approvals';
import { t } from '../lib/i18n';

const sendMessage = vi.fn();
vi.mock('../lib/messaging/protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/messaging/protocol')>()),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));
vi.mock('../lib/ui/client', () => ({ useTokenNames: () => ({ names: {} }) }));

const { Approval } = await import('../components/screens/Approval');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'approval-a';
const B = 'approval-b';
const derive = (id: string, domain: string): PendingApproval => ({
  id,
  kind: 'deriveAppSecret',
  origin: 'https://dapp.example',
  payload: { domain },
  createdAt: 0,
});

/** approvalGet answers that a test settles by hand, so it can act while one is still loading. */
const answers = new Map<string, (approval: PendingApproval | null) => void>();

let container: HTMLElement;
let root: Root;

function render(approvalId: string) {
  act(() =>
    root.render(
      <Approval
        approvalId={approvalId}
        walletName="w"
        network="preprod"
        locked={false}
        onResolved={() => {}}
        onUnlocked={() => {}}
      />,
    ),
  );
}

async function answer(id: string, approval: PendingApproval | null) {
  await act(async () => answers.get(id)!(approval));
}

const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const resolves = () => sendMessage.mock.calls.filter(([type]) => type === 'approvalResolve').map(([, data]) => data);

describe('Approval decisions', () => {
  beforeEach(() => {
    answers.clear();
    sendMessage.mockReset().mockImplementation((type: string, data: { id: string }) => {
      if (type === 'approvalGet') return new Promise((resolve) => answers.set(data.id, (approval) => resolve({ approval })));
      return Promise.resolve(undefined);
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // The request on screen can be dropped (its page closed) while the next one loads.
  // Leaving its buttons live would let a click land on a request the user never saw.
  it('offers no decision while the next request is loading', async () => {
    render(A);
    await answer(A, derive(A, 'seat:a'));
    expect(button(t('approval_allow'))).toBeDefined();

    render(B);
    expect(container.textContent).not.toContain('seat:a');
    expect(button(t('approval_allow'))).toBeUndefined();
    expect(button(t('approval_reject'))).toBeUndefined();

    await answer(B, derive(B, 'seat:b'));
    expect(container.textContent).toContain('seat:b');
    await act(async () => button(t('approval_allow'))!.click());
    expect(resolves()).toEqual([{ id: B, approved: true }]);
  });

  it('ignores a late answer for a request the panel has moved past', async () => {
    render(A);
    render(B);
    await answer(B, derive(B, 'seat:b'));
    await answer(A, derive(A, 'seat:a'));

    expect(container.textContent).toContain('seat:b');
    expect(container.textContent).not.toContain('seat:a');
    await act(async () => button(t('approval_reject'))!.click());
    expect(resolves()).toEqual([{ id: B, approved: false }]);
  });
});
