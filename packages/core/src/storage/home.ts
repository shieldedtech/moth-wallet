// Resolution of the moth home directory.
//
// Everything moth persists — keystores, sync cache, daemon sockets — lives
// under one root. That root is `~/.moth` unless MOTH_HOME says otherwise.
//
// The env var exists for callers that run several isolated moth instances
// from one account: integration tests that must not touch a developer's real
// wallets, and supervisors like spartacus-bot that manage a pool of wallets
// out of a dedicated directory. Both the storage adapter and the daemon
// socket path resolve through here, so a MOTH_HOME move keeps a wallet and
// its socket together — split them and a daemon binds a socket the client
// never looks for.
//
// Resolved per call rather than captured at import, so a process that sets
// MOTH_HOME after module load still gets the directory it asked for.

import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';

export const MOTH_HOME_ENV = 'MOTH_HOME';

/**
 * The moth home directory: MOTH_HOME when set to a non-empty absolute path,
 * otherwise `~/.moth`.
 *
 * A relative MOTH_HOME is rejected rather than resolved against the cwd —
 * the daemon, the CLI and a supervisor rarely share a working directory, and
 * silently resolving to three different roots is how keystores get orphaned.
 */
export function mothHome(): string {
  const raw = process.env[MOTH_HOME_ENV]?.trim();
  if (!raw) return join(homedir(), '.moth');
  if (!isAbsolute(raw)) {
    throw new Error(
      `${MOTH_HOME_ENV} must be an absolute path (got ${JSON.stringify(raw)}). ` +
        'A relative home resolves differently per working directory, which orphans keystores.',
    );
  }
  return raw;
}
