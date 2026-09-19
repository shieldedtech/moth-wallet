/**
 * The one place mainnet is refused.
 *
 * This used to live inside `BaseCommand.getNetworkConfig`, which meant it only
 * ran for commands that resolved a network config — and the commands that matter
 * most did not. `moth wallet generate --network mainnet` derived mainnet
 * addresses, wrote a keystore, printed a recovery phrase and exited 0, with no
 * warning shown (issue #25). A guard placed in one consumer is not a guard; it is
 * a convention that happens to hold wherever someone remembered it.
 *
 * So the refusal is attached to the `--network` flag itself, which every command
 * inherits through `BaseCommand.baseFlags`, and to the config key that can store
 * a default network. Those are the two ways a network id enters the CLI.
 */

const BANNER =
  '\n' +
  '  ╔══════════════════════════════════════════════════════════════╗\n' +
  '  ║                         WARNING                            ║\n' +
  '  ║                                                            ║\n' +
  '  ║  Moth is a reference wallet for development and testing.   ║\n' +
  '  ║  It should NOT be used with real funds on mainnet.         ║\n' +
  '  ║                                                            ║\n' +
  '  ║  Use Lace or another commercial wallet for mainnet.        ║\n' +
  '  ╚══════════════════════════════════════════════════════════════╝\n' +
  '\n';

/** True for the network ids that mean "real funds". */
export function isMainnet(networkId: string | undefined): boolean {
  return networkId === 'mainnet';
}

/**
 * Print the refusal and stop.
 *
 * `process.exit` rather than a thrown error on purpose. This runs from flag
 * parsing as well as from command bodies, and oclif maps thrown errors to its own
 * exit codes and formatting — which would make the exit status depend on where
 * the refusal happened to fire. A refusal should look the same from everywhere,
 * and 1 is what it has always been.
 */
export function refuseMainnet(): never {
  process.stderr.write(BANNER);
  process.exit(1);
}

/** Refuse if `networkId` names mainnet; otherwise return it unchanged. */
export function assertNotMainnet(networkId: string): string {
  if (isMainnet(networkId)) refuseMainnet();
  return networkId;
}
