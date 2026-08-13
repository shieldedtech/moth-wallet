import { pathToFileURL } from 'node:url';
import { parseArgs } from './args-parser.js';
import { InvalidInputError } from '../types/errors.js';

export interface ResolveInitialPrivateStateOptions {
  /** Optional verbose logger for surfacing which private-state source was used. */
  onVerbose?: (message: string) => void;
}

/**
 * Resolve the initial private state to run a contract's constructor against.
 *
 * Precedence (first match wins):
 *   1. `privateStateFlag` — JSON or @file.json, parsed with the same convention as `--args`
 *   2. the witness module's zero-arg `makeInitialPrivateState()` factory, if exported
 *   3. the witness module's plain `initialPrivateState` export, if present
 *   4. `{}` (preserves the no-private-state default)
 *
 * @param privateStateFlag Raw value of the `--private-state` flag (JSON or `@file.json`).
 * @param witnessPath      Absolute path to the witness JS module, if `--witnesses` was given.
 */
export async function resolveInitialPrivateState(
  privateStateFlag: string | undefined,
  witnessPath: string | undefined,
  options: ResolveInitialPrivateStateOptions = {},
): Promise<unknown> {
  if (privateStateFlag) {
    return parseArgs(privateStateFlag);
  }

  if (!witnessPath) {
    return {};
  }

  let witnessModule: Record<string, unknown>;
  try {
    witnessModule = (await import(pathToFileURL(witnessPath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new InvalidInputError(
      `Failed to load witness module at ${witnessPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const makeInitialPrivateState = witnessModule.makeInitialPrivateState;
  if (makeInitialPrivateState !== undefined) {
    if (typeof makeInitialPrivateState !== 'function') {
      throw new InvalidInputError(
        `Witness module ${witnessPath} exports "makeInitialPrivateState" but it is not a function.`,
      );
    }
    options.onVerbose?.('Using initial private state from witness module makeInitialPrivateState()');
    return (makeInitialPrivateState as () => unknown)();
  }

  if (witnessModule.initialPrivateState !== undefined) {
    options.onVerbose?.('Using initial private state from witness module initialPrivateState export');
    return witnessModule.initialPrivateState;
  }

  return {};
}
