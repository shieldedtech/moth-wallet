// Validates a batch of transfer lines and turns them into send requests. Kept
// apart from the SendFlow view (like token-list.ts / dust-view.ts) so the
// per-line and aggregate rules stay WASM-free and unit-testable. Each line is
// its own token + amount + recipient; the whole batch is one transaction.

import type { SendTokensRequest } from '../messaging/protocol';
import type { SendableToken } from './token-list';
import { isValidAddress } from './address';
import { parseAmount } from './format';

export interface OutputDraft {
  /** Stable local key for React lists (not sent to the chain). */
  id: string;
  tokenId: string;
  amount: string;
  to: string;
}

export interface LineView {
  draft: OutputDraft;
  token: SendableToken;
  /** Amount parses to a positive value within this token's balance. */
  amountValid: boolean;
  /** Recipient looks like an address of this token's kind. */
  addressValid: boolean;
  /** This token's total across all lines exceeds its balance. */
  overspent: boolean;
  /** Non-null only when the line is individually sendable. */
  request: SendTokensRequest | null;
}

export interface BatchView {
  lines: LineView[];
  /** At least one line and every line is a valid, non-overspending request. */
  valid: boolean;
  /** The outputs to estimate/submit, present only when `valid`. */
  requests: SendTokensRequest[];
}

function parsePositive(token: SendableToken, amount: string): bigint | null {
  try {
    const raw = amount.trim() ? parseAmount(amount, token.decimals) : 0n;
    return raw > 0n ? raw : null;
  } catch {
    return null;
  }
}

export function buildBatch(drafts: OutputDraft[], tokens: SendableToken[]): BatchView {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const fallback = tokens[0];

  const parsed = drafts.map((draft) => {
    const token = byId.get(draft.tokenId) ?? fallback;
    return { draft, token, raw: parsePositive(token, draft.amount), addressValid: isValidAddress(token.kind, draft.to) };
  });

  // Aggregate each token's committed amount across lines — two lines spending
  // the same token must together stay within its balance.
  const totals = new Map<string, bigint>();
  for (const p of parsed) if (p.raw !== null) totals.set(p.token.id, (totals.get(p.token.id) ?? 0n) + p.raw);

  const lines: LineView[] = parsed.map((p) => {
    const amountValid = p.raw !== null && p.raw <= p.token.balance;
    const overspent = (totals.get(p.token.id) ?? 0n) > p.token.balance;
    const request: SendTokensRequest | null =
      amountValid && p.addressValid && !overspent
        ? { type: p.token.kind, tokenId: p.token.id, amount: p.raw!.toString(), to: p.draft.to.trim() }
        : null;
    return { draft: p.draft, token: p.token, amountValid, addressValid: p.addressValid, overspent, request };
  });

  const valid = lines.length > 0 && lines.every((l) => l.request !== null);
  return { lines, valid, requests: valid ? lines.map((l) => l.request!) : [] };
}
