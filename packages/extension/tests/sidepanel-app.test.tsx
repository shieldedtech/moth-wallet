import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletInfo } from '@shieldedtech/moth-browser';
import type { SessionStatus } from '../lib/messaging/protocol';

// The panel shell's first paint, with the background answering what it answers
// from storage (the session) and the wallet worker answering nothing yet (the
// account list) — which is the state for the minutes a preprod restore holds it.
let status: SessionStatus | null;
let wallets: WalletInfo[] | null;
vi.mock('../lib/ui/client', () => ({
  useSession: () => ({ status, refresh: vi.fn(), unlock: vi.fn(), lock: vi.fn() }),
  useWallets: () => ({ wallets, refresh: vi.fn(), markActive: vi.fn() }),
  usePanelEvents: () => ({
    balances: null,
    syncMessage: 'Restoring dust state from cache...',
    txStage: null,
    approvalId: null,
    setupOpen: false,
    relayState: null,
    reset: vi.fn(),
  }),
  useSelectedProverType: () => ({ proverType: null, refresh: vi.fn() }),
  useRegisterNudge: () => false,
}));

const { App } = await import('../entrypoints/sidepanel/App');

describe('side panel before the wallet worker answers', () => {
  beforeEach(() => {
    status = { locked: false, walletName: 'Account-1', network: 'preprod' };
    wallets = null;
  });

  it('renders the loading screen with Settings rather than a blank panel', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('Getting things ready');
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('aria-label="Network: Preprod"');
  });

  it('still renders the loading screen once the account list arrives', () => {
    wallets = [{ name: 'Account-1', active: true } as WalletInfo];

    expect(renderToStaticMarkup(<App />)).toContain('aria-label="Settings"');
  });

  it('shows a loading screen, not a blank panel, while locked', () => {
    status = { locked: true, network: 'preprod' };

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('Getting things ready');
    expect(html).not.toContain('aria-label="Settings"');
  });
});
