export type WalletErrorCategory =
  | 'NETWORK_ERROR'
  | 'WALLET_ERROR'
  | 'PROOF_ERROR'
  | 'TIMEOUT'
  | 'INVALID_INPUT';

export class WalletError extends Error {
  readonly category: WalletErrorCategory;

  constructor(category: WalletErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WalletError';
    this.category = category;
  }
}

export class NetworkError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('NETWORK_ERROR', message, cause);
    this.name = 'NetworkError';
  }
}

export class ProofError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('PROOF_ERROR', message, cause);
    this.name = 'ProofError';
  }
}

export class TimeoutError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('TIMEOUT', message, cause);
    this.name = 'TimeoutError';
  }
}

export class InvalidInputError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('INVALID_INPUT', message, cause);
    this.name = 'InvalidInputError';
  }
}

/**
 * A submission that never made it into the pool, carrying the node's or the
 * relay's own words as its message rather than the wallet SDK's fixed
 * `"Transaction submission error"` placeholder.
 *
 * Exists because every surface — the extension's failure screen, the CLI's
 * error line, the daemon's RPC reply — shows `error.message` and nothing
 * else, so a reason that lives only in a nested `cause` is a reason nobody
 * ever reads. The original error stays on `cause` untouched.
 */
export class TransactionSubmissionError extends WalletError {
  constructor(message: string, cause?: unknown) {
    super('NETWORK_ERROR', message, cause);
    this.name = 'TransactionSubmissionError';
  }
}

/**
 * Every distinct message in an error's cause chain, outermost first.
 *
 * The wallet SDK reports a node's verdict through nested Effect
 * `Data.TaggedError`s whose own messages are fixed placeholder strings. A
 * rejected submission arrives as `"Transaction submission error"` (from
 * `wallet-sdk-capabilities/submission`) wrapping `"Transaction submission
 * failed"` (from `wallet-sdk-node-client`) wrapping the only member of the
 * chain that says anything at all — the node's own
 * `1010: Invalid Transaction: Custom error: 170`, or the relay's
 * `Could not connect within specified time range (5s)`.
 *
 * So `error.message` on a submission failure is a constant: it tells a user
 * nothing, and it tells a classifier nothing either. Anything that reads a
 * reason out of a submission failure — what to show, whether to retry,
 * whether this is the known wedged-dust-ledger signature — has to work off
 * the whole chain instead, which is what this returns.
 *
 * `failure` is followed alongside `cause` because Effect's fiber wrappers
 * carry the underlying error under that name.
 */
export function errorChainMessages(error: unknown, maxDepth = 8): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < maxDepth; depth++) {
    const message = messageOf(current);
    // Skip anything an outer link already said, verbatim or as part of a
    // longer line — including a message this function itself produced, so
    // re-flattening an already-flattened error does not stutter.
    if (message && !messages.some((seen) => seen.includes(message))) messages.push(message);
    const wrapper = current as {cause?: unknown; failure?: unknown};
    current = wrapper.cause ?? wrapper.failure;
  }
  return messages;
}

/**
 * The whole cause chain as one line: what to match patterns against, and what
 * to show in place of a wrapper's placeholder text. Reads outside-in, so the
 * node's verdict lands at the end where the detail belongs.
 */
export function errorChainMessage(error: unknown, maxDepth = 8): string {
  return errorChainMessages(error, maxDepth).join(': ');
}

function messageOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (typeof value === 'object' && value !== null) {
    const {message} = value as {message?: unknown};
    if (typeof message === 'string') return message;
    // A plain object with no message still beats dropping the only link in
    // the chain that carried the reason — cap it so one opaque RPC payload
    // can't crowd out everything around it.
    try {
      return JSON.stringify(value).slice(0, 500);
    } catch {
      return '';
    }
  }
  return String(value);
}
