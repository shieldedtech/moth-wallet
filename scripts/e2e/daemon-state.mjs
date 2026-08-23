// Read balances from a RUNNING daemon instead of starting a second sync.
//
// In daemon mode the daemon holds the wallet unlocked and synced; running
// `moth balance` alongside it would spin up a competing sync over the same
// store. The daemon already answers `getState`, so ask it — and emit the
// SAME JSON shape `moth balance --output json` produces, so the harness can
// read both with one set of jq paths.
//
// There is no `moth daemon state` command (getState is reachable over the
// socket but nothing in the CLI calls it), which is why this file exists.
//
// Usage: node scripts/e2e/daemon-state.mjs <networkId> <walletName>
// Exit:  0 ok, 3 no daemon reachable, 4 daemon not ready
import { connectDaemon, daemonSocketPath } from '@shieldedtech/moth-wallet';

const NIGHT = '0'.repeat(64);
const [networkId, walletName] = process.argv.slice(2);

if (!networkId || !walletName) {
  process.stderr.write('usage: daemon-state.mjs <networkId> <walletName>\n');
  process.exit(2);
}

const socket = daemonSocketPath(networkId, walletName);
const client = await connectDaemon(socket, { defaultTimeoutMs: 60_000 });
if (!client) {
  process.stderr.write(`no daemon answering at ${socket}\n`);
  process.exit(3);
}

try {
  const s = await client.call('getState');
  if (!s?.ready) {
    process.stderr.write(`daemon at ${socket} reports not ready\n`);
    process.exit(4);
  }
  const un = s.balances?.unshielded ?? {};
  const sh = s.balances?.shielded ?? {};
  const u = BigInt(un[NIGHT] ?? '0');
  const h = BigInt(sh[NIGHT] ?? '0');
  const other = [
    ...Object.entries(un).filter(([k]) => k !== NIGHT)
      .map(([tokenId, amount]) => ({ tokenId, type: 'unshielded', amount: String(amount) })),
    ...Object.entries(sh).filter(([k]) => k !== NIGHT)
      .map(([tokenId, amount]) => ({ tokenId, type: 'shielded', amount: String(amount) })),
  ];
  process.stdout.write(JSON.stringify({
    wallet: s.walletName ?? walletName,
    network: s.networkId ?? networkId,
    synced: Boolean(s.synced),
    source: 'daemon.getState',
    balances: {
      night: { unshielded: String(u), shielded: String(h), total: String(u + h) },
      dust: String(s.balances?.dust ?? '0'),
      otherTokens: other,
    },
  }, null, 2) + '\n');
} finally {
  client.close();
}
