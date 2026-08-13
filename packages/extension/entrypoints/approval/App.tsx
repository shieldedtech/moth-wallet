// Fallback approval window (used when the side panel can't be opened).
// Thin wrapper over the shared Approval screen.

import { useSession, useWallets } from '../../lib/ui/client';
import { Approval } from '../../components/screens/Approval';

export function App() {
  const id = new URLSearchParams(window.location.search).get('id') ?? '';
  const session = useSession();
  const { wallets } = useWallets();

  if (!session.status || wallets === null) return null;

  return (
    <Approval
      approvalId={id}
      walletName={session.status.walletName ?? wallets.find((w) => w.active)?.name ?? null}
      network={session.status.network}
      locked={session.status.locked}
      onResolved={() => window.close()}
      onUnlocked={() => void session.refresh()}
    />
  );
}
