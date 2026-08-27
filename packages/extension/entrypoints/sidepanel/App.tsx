// Side panel shell: session-aware navigation across the design's screens.
// dApp approvals take over the panel while pending.

import { useEffect, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { useSession, useWallets, usePanelEvents, useSelectedProverType, useSlowSync } from '../../lib/ui/client';
import { accountLabel } from '../../lib/ui/format';
import type { Screen } from '../../components/screens/navigation';
import { GetStarted, openSetupTab } from '../../components/screens/GetStarted';
import { SetupInProgress } from '../../components/screens/SetupInProgress';
import { Unlock } from '../../components/screens/Unlock';
import { WalletLoading } from '../../components/screens/WalletLoading';
import { Home } from '../../components/screens/Home';
import { SendFlow } from '../../components/screens/SendFlow';
import { Receive } from '../../components/screens/Receive';
import { Activity } from '../../components/screens/Activity';
import { DustDetail } from '../../components/screens/DustDetail';
import { Accounts } from '../../components/screens/Accounts';
import { Settings } from '../../components/screens/Settings';
import { ConnectedSites } from '../../components/screens/ConnectedSites';
import { NetworkConfig } from '../../components/screens/NetworkConfig';
import { AddressBook } from '../../components/screens/AddressBook';
import { Approval } from '../../components/screens/Approval';

export function App() {
  const session = useSession();
  const { wallets, refresh: refreshWallets } = useWallets();
  const events = usePanelEvents();
  const prover = useSelectedProverType(session.status?.network);
  const slowSync = useSlowSync(!events.balances);
  const [screen, setScreen] = useState<Screen>('home');
  // Set when the user asks to switch accounts: the target's storage name. The
  // current session stays alive and syncing until this unlock succeeds, so
  // cancelling returns to the still-unlocked current account.
  const [unlockTarget, setUnlockTarget] = useState<string | null>(null);

  // New wallets can be created from the setup tab while the panel is open.
  useEffect(() => {
    const onFocus = () => void refreshWallets();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshWallets]);

  // Locking invalidates the streamed balances — drop them so an account
  // switch never shows the previous account's numbers after unlock.
  const locked = session.status?.locked;
  const resetEvents = events.reset;
  useEffect(() => {
    if (locked) {
      resetEvents();
      // A cold/forced lock supersedes any in-progress switch prompt.
      setUnlockTarget(null);
    }
  }, [locked, resetEvents]);

  // When the setup tab finishes (or closes), pick up whatever it did — a new
  // account is created AND unlocked over there. Transition-guarded so the
  // mount-time `false` doesn't double the initial fetches.
  const setupOpen = events.setupOpen;
  const sessionRefresh = session.refresh;
  const setupWasOpen = useRef(false);
  useEffect(() => {
    if (setupWasOpen.current && !setupOpen) {
      void refreshWallets();
      void sessionRefresh();
    }
    setupWasOpen.current = setupOpen;
  }, [setupOpen, refreshWallets, sessionRefresh]);

  if (!session.status || wallets === null) return null;

  // Screens that only display the account show the user-set label (falling
  // back to the formatted storage name); unlock flows keep the storage name.
  const activeWallet = wallets.find((w) => w.active);
  const activeDisplayName = session.status.walletName
    ? accountLabel(session.status.walletName, session.status.walletLabel)
    : null;

  if (events.approvalId) {
    return (
      <>
        <Approval
          approvalId={events.approvalId}
          walletName={session.status.walletName ?? activeWallet?.name ?? null}
          walletLabel={session.status.walletLabel ?? activeWallet?.label}
          network={session.status.network}
          locked={session.status.locked}
          onResolved={() => void session.refresh()}
          onUnlocked={() => void session.refresh()}
        />
        <Toaster position="bottom-center" theme="system" />
      </>
    );
  }

  if (events.setupOpen) return <SetupInProgress />;

  if (wallets.length === 0) return <GetStarted />;

  if (session.status.locked) {
    const activeName = wallets.find((w) => w.active)?.name ?? wallets[0]!.name;
    return (
      <Unlock
        walletName={activeName}
        // With more than one account the screen must ask which. Deleting the
        // active account promotes another silently, and an unlock aimed at the
        // wrong account looks exactly like a wrong password.
        accounts={wallets.map((w) => ({ name: w.name, label: w.label, network: w.network }))}
        onUnlock={async (name, passphrase) => {
          await session.unlock(name, passphrase);
          setScreen('home');
        }}
      />
    );
  }

  // Switching accounts: prompt for the target while the current account stays
  // unlocked and syncing. Cancel drops back to it unchanged; a successful
  // unlock swaps the session (and active account) over.
  if (unlockTarget) {
    const target = wallets.find((w) => w.name === unlockTarget);
    return (
      <Unlock
        walletName={unlockTarget}
        accountName={target ? accountLabel(target.name, target.label) : undefined}
        onUnlock={async (name, passphrase) => {
          await session.unlock(name, passphrase);
          setUnlockTarget(null);
          await refreshWallets();
          setScreen('home');
        }}
        onCancel={() => setUnlockTarget(null)}
      />
    );
  }

  // The loading screen short-circuits the router, so a failed sync used to be a
  // dead end: it told the user to check the network and gave them no way to get
  // there. Let the network screen through, and let the failure open it.
  if (!events.balances && screen !== 'network-config') {
    return (
      <WalletLoading
        syncMessage={events.syncMessage}
        slow={slowSync}
        onOpenNetwork={() => setScreen('network-config')}
      />
    );
  }

  const shared = {
    navigate: setScreen,
    back: () => setScreen('home'),
  };

  return (
    <>
      {screen === 'home' && (
        <Home
          walletName={activeDisplayName!}
          network={session.status.network}
          balances={events.balances}
          syncMessage={events.syncMessage}
          relayState={events.relayState}
          navigate={setScreen}
        />
      )}
      {screen === 'send' && (
        <SendFlow
          walletName={activeDisplayName!}
          network={session.status.network}
          balances={events.balances}
          txStage={events.txStage}
          proverType={prover.proverType}
          relayState={events.relayState}
          onExit={shared.back}
          onActivity={() => setScreen('activity')}
        />
      )}
      {screen === 'receive' && <Receive status={session.status} onBack={shared.back} />}
      {screen === 'activity' && (
        <Activity network={session.status.network} balances={events.balances} onBack={shared.back} />
      )}
      {screen === 'dust' && (
        <DustDetail
          balances={events.balances}
          txStage={events.txStage}
          proverType={prover.proverType}
          network={session.status.network}
          ownDustAddress={session.status.addresses?.dust?.bech32m?.[session.status.network] ?? ''}
          onBack={shared.back}
        />
      )}
      {screen === 'accounts' && (
        <Accounts
          wallets={wallets}
          activeName={session.status.walletName!}
          onBack={shared.back}
          onChanged={async () => {
            await Promise.all([refreshWallets(), session.refresh()]);
            setScreen('home');
          }}
          onRenamed={async () => {
            await Promise.all([refreshWallets(), session.refresh()]);
          }}
          onSwitched={(name) => setUnlockTarget(name)}
          onNewAccount={() => openSetupTab()}
        />
      )}
      {screen === 'settings' && <Settings onBack={shared.back} navigate={setScreen} />}
      {screen === 'connected-sites' && <ConnectedSites onBack={() => setScreen('settings')} />}
      {screen === 'address-book' && <AddressBook onBack={() => setScreen('settings')} />}
      {screen === 'network-config' && (
        <NetworkConfig
          onBack={() => setScreen('settings')}
          onSaved={async () => {
            // The background has already reset state and launched the new
            // network sync. Navigate immediately; refresh account/session
            // metadata while the loading screen waits for fresh balances.
            setScreen('home');
            await Promise.all([refreshWallets(), session.refresh(), prover.refresh()]);
          }}
        />
      )}
      <Toaster position="bottom-center" theme="system" />
    </>
  );
}
