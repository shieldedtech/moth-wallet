// View-model for the activity feed (8c/9d and Home's recent list): filtering,
// day grouping, and per-row presentation derived from ActivityEntry. Pure
// functions so tests can pin the mapping without rendering.

import type { ActivityEntry, ActivityDelta } from '@shieldedtech/moth-browser';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import { t } from '../i18n';
import { formatDust, formatNightAmount, formatTokenBalance } from './format';
import type { NativeAssetLabels } from './token-labels';

export type ActivityFilter = 'all' | 'sent' | 'received' | 'dust';

export const ACTIVITY_FILTERS: ActivityFilter[] = ['all', 'sent', 'received', 'dust'];

/** Swaps move value both ways, so they appear under Sent and Received alike. */
export function filterActivity(entries: ActivityEntry[], filter: ActivityFilter): ActivityEntry[] {
  if (filter === 'all') return entries;
  return entries.filter((entry) =>
    entry.kind === filter || (entry.kind === 'swap' && (filter === 'sent' || filter === 'received')),
  );
}

export interface ActivityGroup {
  label: string;
  entries: ActivityEntry[];
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(timestamp: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY_MS);
}

function groupLabel(timestamp: Date | null, now: Date): string {
  if (!timestamp) return t('activity_groupEarlier');
  const days = daysAgo(timestamp, now);
  if (days <= 0) return t('activity_groupToday');
  if (days === 1) return t('activity_groupYesterday');
  if (days < 7) return t('activity_groupThisWeek');
  if (timestamp.getFullYear() === now.getFullYear() && timestamp.getMonth() === now.getMonth()) {
    return t('activity_groupThisMonth');
  }
  const month = timestamp.toLocaleDateString('en-GB', { month: 'long' });
  return timestamp.getFullYear() === now.getFullYear() ? month : `${month} ${timestamp.getFullYear()}`;
}

/** Entries must already be sorted newest first; groups keep that order. */
export function groupActivity(entries: ActivityEntry[], now = new Date()): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const entry of entries) {
    const label = groupLabel(entry.timestamp, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Row presentation
// ---------------------------------------------------------------------------

export type ActivityIcon = 'sent' | 'received' | 'swap' | 'dust' | 'pending' | 'failed';

export interface ActivityRowView {
  key: string;
  icon: ActivityIcon;
  title: string;
  sub: string;
  /** Signed display amount ("+120 NIGHT"), or null when nothing moved. */
  amount: string | null;
  tone: 'positive' | 'negative' | 'muted';
}

function shortAddress(address: string): string {
  if (address.length <= 13) return address;
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

/**
 * Display name for a token.
 *
 * Prefers the name the user gave it. A raw token id is meaningless to read —
 * "-2 24419f09…" in a feed says nothing about what moved — and the wallet
 * already knows the name because the user typed it. Falls back to a truncated
 * id when unnamed, which is the best available handle.
 *
 * `names` is keyed by token id. Lookup is case-insensitive and ignores a `0x`
 * prefix, since ids reach us from several sources with inconsistent formatting.
 */
function tokenName(
  delta: ActivityDelta,
  labels: NativeAssetLabels,
  names?: Record<string, string>,
): string {
  if (delta.kind === 'unshielded' && delta.tokenType === NIGHT_TOKEN_ID) return labels.night;
  const named = lookupTokenName(delta.tokenType, names);
  if (named) return named;
  return `${delta.tokenType.slice(0, 8)}…`;
}

function lookupTokenName(
  tokenType: string,
  names?: Record<string, string>,
): string | undefined {
  if (!names) return undefined;
  const direct = names[tokenType];
  if (direct) return direct;
  const wanted = tokenType.replace(/^0x/i, '').toLowerCase();
  for (const [id, name] of Object.entries(names)) {
    if (id.replace(/^0x/i, '').toLowerCase() === wanted && name) return name;
  }
  return undefined;
}

function magnitude(delta: ActivityDelta): string {
  const raw = delta.amount < 0n ? -delta.amount : delta.amount;
  if (delta.kind === 'unshielded' && delta.tokenType === NIGHT_TOKEN_ID) return formatNightAmount(raw);
  // Grouped, matching the asset rows on Home. Ungrouped here would show the same
  // minted-token holding as "123,456" in its asset row and "+123456" in the feed
  // two cards below — the split this formatter exists to remove.
  return formatTokenBalance(raw, 0);
}

function signedAmount(delta: ActivityDelta, labels: NativeAssetLabels, names?: Record<string, string>): string {
  return `${delta.amount < 0n ? '-' : '+'}${magnitude(delta)} ${tokenName(delta, labels, names)}`;
}

// The design's times are 24-hour ("09:58") and its dates day-first ("12 Jun");
// en-GB matches both and keeps output identical across machines.
function timeOfDay(timestamp: Date): string {
  return timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function subFor(entry: ActivityEntry, now: Date): string {
  const when = entry.timestamp;
  let base = '';
  if (when) {
    const days = daysAgo(when, now);
    if (days <= 1) base = timeOfDay(when);
    else if (days < 7) base = when.toLocaleDateString('en-GB', { weekday: 'long' });
    else base = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  if (entry.pending) return base ? t('activity_subPending', [base]) : t('activity_pending');
  if (entry.status === 'FAILURE') return base ? t('activity_subFailed', [base]) : t('activity_failed');
  return base;
}

export function activityRowView(
  entry: ActivityEntry,
  labels: NativeAssetLabels,
  now = new Date(),
  /** User-assigned token names, keyed by token id. Optional so existing
   *  callers and tests keep working; without it ids render as before. */
  tokenNames?: Record<string, string>,
): ActivityRowView {
  const failed = entry.status === 'FAILURE';
  const positives = entry.deltas.filter((delta) => delta.amount > 0n);
  const negatives = entry.deltas.filter((delta) => delta.amount < 0n);

  let title: string;
  let amountDelta: ActivityDelta | undefined;
  switch (entry.kind) {
    case 'sent': {
      // A single transaction can carry several transfers (batch send). Use the
      // greater of the visible output count and the number of distinct tokens
      // moved — either exceeding one means more than one recipient/token, which
      // a single-recipient title would misrepresent.
      const transfers = Math.max(entry.outputs ?? 0, negatives.length);
      if (transfers > 1) {
        title = entry.pending
          ? t('activity_sendingTransfers', [transfers])
          : t('activity_sentTransfers', [transfers]);
        // Show a signed amount only when every transfer moved the same token
        // (its deltas aggregate to one); a mixed-token batch has no single figure.
        amountDelta = negatives.length === 1 ? negatives[0] : undefined;
      } else {
        amountDelta = negatives[0];
        if (entry.counterparty) {
          const target = shortAddress(entry.counterparty);
          title = entry.pending ? t('activity_sendingTo', [target]) : t('activity_sentTo', [target]);
        } else if (amountDelta) {
          const token = tokenName(amountDelta, labels, tokenNames);
          title = entry.pending ? t('activity_sendingToken', [token]) : t('activity_sentToken', [token]);
        } else {
          title = entry.pending ? t('activity_sending') : t('activity_sent');
        }

      }
      break;
    }
    case 'received': {
      amountDelta = positives[0];
      title = entry.counterparty
        ? t('activity_receivedFrom', [shortAddress(entry.counterparty)])
        : amountDelta
          ? t('activity_receivedToken', [tokenName(amountDelta, labels, tokenNames)])
          : t('activity_received');
      break;
    }
    case 'swap': {
      amountDelta = positives[0];
      const gave = negatives[0];
      title =
        gave && amountDelta
          ? t('activity_swappedFor', [tokenName(gave, labels, tokenNames), tokenName(amountDelta, labels, tokenNames)])
          : t('activity_swappedTokens');
      break;
    }
    case 'dust': {
      if (entry.dustDelta < 0n) title = t('activity_networkFeePaid');
      else title = t('activity_dustRegistration', [labels.dust]);
      break;
    }
  }

  let amount: string | null = null;
  if (amountDelta) amount = signedAmount(amountDelta, labels, tokenNames);
  else if (entry.dustDelta !== 0n) {
    amount = `${entry.dustDelta < 0n ? '-' : '+'}${formatDust(
      entry.dustDelta < 0n ? -entry.dustDelta : entry.dustDelta,
    )} ${labels.dust}`;
  }

  const gained = amountDelta ? amountDelta.amount > 0n : entry.dustDelta > 0n;
  return {
    key: entry.hash,
    icon: failed ? 'failed' : entry.pending ? 'pending' : entry.kind,
    title,
    sub: subFor(entry, now),
    amount,
    tone: entry.pending || failed ? 'muted' : gained ? 'positive' : 'negative',
  };
}
