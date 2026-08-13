// Dashboard hub — the single top-level screen. Hosts the state view and all
// sub-views (send/deploy/mint/contract/keys/dust/network/logs). Letter
// shortcuts switch sub-views; Esc returns to state. Pattern mirrors
// midnight-wallet-cli's DashboardScreen.

import React, { useState } from 'react';
import { Box, useInput } from 'ink';
import { StateView } from './StateView.js';
import { HelpFooter, type HelpHint } from '../../components/HelpFooter.js';
import type { WalletState, NetworkState } from '../../types.js';
import type { ChainStatus } from '../../hooks/useChainStatus.js';
import type { WalletCoinDetails, SubWalletProgress } from '@shieldedtech/moth-wallet';

type View =
  | 'state'
  | 'send'
  | 'deploy'
  | 'mint'
  | 'contract'
  | 'keys'
  | 'dust'
  | 'network'
  | 'logs';

interface ShortcutDef {
  key: string;
  view: View;
  label: string;
}

const SHORTCUTS: ShortcutDef[] = [
  { key: 's', view: 'send',     label: 'send' },
  { key: 'd', view: 'deploy',   label: 'deploy' },
  { key: 'm', view: 'mint',     label: 'mint' },
  { key: 'c', view: 'contract', label: 'contract' },
  { key: 'k', view: 'keys',     label: 'keys' },
  { key: 'u', view: 'dust',     label: 'dust' },
  { key: 'n', view: 'network',  label: 'network' },
  { key: 'l', view: 'logs',     label: 'logs' },
];

interface DashboardHubProps {
  // State view + status data
  wallet: WalletState | null;
  isUnlocked: boolean;
  network: NetworkState;
  chain: ChainStatus;
  paused?: boolean;
  addresses?: { unshielded: string; shielded: string; dust: string };
  shieldedBalances?: Record<string, bigint>;
  unshieldedBalances?: Record<string, bigint>;
  dustBalance?: bigint;
  coins?: WalletCoinDetails;
  subProgress?: SubWalletProgress;
  unreadLogs?: number;

  // Sub-view renderers — each gets a back handler that returns to state.
  renderSend: (onBack: () => void) => React.ReactNode;
  renderDeploy: (onBack: () => void) => React.ReactNode;
  renderMint: (onBack: () => void) => React.ReactNode;
  renderContract: (onBack: () => void) => React.ReactNode;
  renderKeys: (onBack: () => void) => React.ReactNode;
  renderDust: (onBack: () => void) => React.ReactNode;
  renderNetwork: (onBack: () => void) => React.ReactNode;
  renderLogs: (onBack: () => void) => React.ReactNode;

  onQuit: () => void;
  onViewLogs?: () => void;
}

export function DashboardHub(props: DashboardHubProps) {
  const [currentView, setCurrentView] = useState<View>('state');

  // Letter shortcuts only fire when we're on the state view. Sub-views own
  // their own input (text fields, selects, etc.). Esc handled in app.tsx
  // for any view; we provide back-to-state via the render-prop callback.
  useInput((input) => {
    if (currentView !== 'state') return;
    if (input === 'q') { props.onQuit(); return; }
    const hit = SHORTCUTS.find((s) => s.key === input);
    if (hit) {
      setCurrentView(hit.view);
      if (hit.view === 'logs') props.onViewLogs?.();
    }
  });

  const onBack = () => setCurrentView('state');

  if (currentView === 'send')     return <>{props.renderSend(onBack)}</>;
  if (currentView === 'deploy')   return <>{props.renderDeploy(onBack)}</>;
  if (currentView === 'mint')     return <>{props.renderMint(onBack)}</>;
  if (currentView === 'contract') return <>{props.renderContract(onBack)}</>;
  if (currentView === 'keys')     return <>{props.renderKeys(onBack)}</>;
  if (currentView === 'dust')     return <>{props.renderDust(onBack)}</>;
  if (currentView === 'network')  return <>{props.renderNetwork(onBack)}</>;
  if (currentView === 'logs')     return <>{props.renderLogs(onBack)}</>;

  return (
    <Box flexDirection="column">
      <StateView
        wallet={props.wallet}
        network={props.network}
        chain={props.chain}
        isUnlocked={props.isUnlocked}
        paused={props.paused}
        addresses={props.addresses}
        shieldedBalances={props.shieldedBalances}
        unshieldedBalances={props.unshieldedBalances}
        dustBalance={props.dustBalance}
        coins={props.coins}
        subProgress={props.subProgress}
      />

      <Box paddingX={2}>
        <HelpFooter
          hints={[
            ...SHORTCUTS.map<HelpHint>((s) => ({
              key: s.key,
              label: s.label,
              ...(s.view === 'logs' && (props.unreadLogs ?? 0) > 0
                ? { badge: String(props.unreadLogs) }
                : {}),
            })),
            { key: 'q', label: 'quit' },
          ]}
        />
      </Box>
    </Box>
  );
}
