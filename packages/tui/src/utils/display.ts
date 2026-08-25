// Display helpers — style mirrors midnight-wallet-cli (Apache-2.0). See NOTICE.

/** Days/hours/minutes remaining until targetDate, or 'Complete' if past. */
export function formatTimeRemaining(targetDate: Date, now: Date = new Date()): string {
  const diffMs = targetDate.getTime() - now.getTime();
  if (diffMs <= 0) return 'Complete';

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Middle-elide `value` to at most `max` columns: `29ed4a05…4b112b94`.
 *
 * Used for raw 64-char token ids. This is not only cosmetic — a row that wraps
 * costs two terminal lines instead of one, which silently breaks the row
 * budgeting in `windowRows` and lets a block overflow the screen anyway.
 */
export function truncateMiddle(value: string, max: number): string {
  if (max <= 1) return value.slice(0, Math.max(0, max));
  if (value.length <= max) return value;
  const keep = max - 1; // one column for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/**
 * Take items until their combined row cost exhausts `budget`.
 *
 * Ink has no viewport: a frame taller than the terminal corrupts its redraw,
 * collapsing lines onto one another (see the note in components/Select.tsx).
 * Every list that grows with chain state therefore needs a hard row bound, and
 * the caller renders `hidden` as an "and N more" line.
 *
 * `cost` defaults to one row per item; pass it for rows that can render taller.
 */
export function windowRows<T>(
  items: readonly T[],
  budget: number,
  cost: (item: T) => number = () => 1,
): { shown: T[]; hidden: number } {
  if (budget <= 0) return { shown: [], hidden: items.length };
  const shown: T[] = [];
  let used = 0;
  for (const item of items) {
    const next = used + cost(item);
    if (next > budget) break;
    used = next;
    shown.push(item);
  }
  return { shown, hidden: items.length - shown.length };
}

/** Row budget and token-id width for one wallet section's balance block. */
export interface BalanceBudget {
  /** Item rows the block may render, the "and N more" line included. */
  maxRows: number;
  /** Columns a token id may occupy before it is middle-elided. */
  tokenWidth: number;
}

/**
 * Fixed rows the Wallet State view spends before any coin: the section header,
 * the network block, and each wallet section's heading, address, sync, pending
 * and margins. Approximate by design — it only has to be close enough that the
 * coin lists cannot be what pushes the frame past the terminal.
 */
const STATE_VIEW_CHROME_ROWS = 26;

/**
 * Columns a token header spends on everything but the token id: the indent (4),
 * the gap after it (2), a wide amount (17, e.g. `1234567890.123456`) and the
 * coin count (14, e.g. `  (1000 coins)`).
 */
const HEADER_OVERHEAD_COLUMNS = 37;

/**
 * Split the terminal's spare height between the wallet sections.
 *
 * The floor of 2 means a very short terminal still shows something rather than
 * an empty block. Such a terminal can still overflow on chrome alone — what
 * this removes is a wallet's coin count deciding whether it overflows.
 */
export function balanceBudget(rows = 24, columns = 80, sections = 3): BalanceBudget {
  const spare = rows - STATE_VIEW_CHROME_ROWS;
  return {
    maxRows: Math.max(2, Math.floor(spare / Math.max(1, sections))),
    // Reserve the header's fixed columns so it never wraps — a wrapped row costs
    // two lines and breaks the row budget above.
    tokenWidth: Math.min(64, Math.max(12, columns - HEADER_OVERHEAD_COLUMNS)),
  };
}
