// Gloam token registry client: turns held shielded colours into display data
// (ticker, name, decimals) from a Gloam registry, and checks each entry before
// the wallet shows it.
//
// A shielded coin carries only a 32-byte colour (raw token type). For Gloam
// tokens the colour is derived, not assigned:
//
//   launch token: rawTokenType(SHA-256(pad32("gloam:v1:token") || launch), contract)
//   sNIGHT:       rawTokenType(pad32("sNIGHT-v1"), snightContract)
//
// (Compact `persistentHash<Vector<2, Bytes<32>>>` over two 32-byte values is
// SHA-256 over their 64-byte concatenation.) So every registry entry can be
// re-derived locally. The registry is an index, never an authority.
//
// Verification levels:
//   - `chain-verified`  colour re-derives AND launch_info on chain matches the
//                       entry's ticker and metadata digest (needs a ChainView).
//   - `colour-verified` colour re-derives from (launch, contract). Proves the
//                       contract mints this colour; does NOT prove the ticker
//                       or name, which the registry operator supplies.
//   - `unverified`      derivation failed or was not possible.
//
// Privacy: there is no per-colour request, on purpose. The client fetches the
// full list, or — when bucket mode is on — only the buckets (first hex digit)
// that held colours fall in. Requests carry no wallet identifiers: no
// credentials, no referrer, and no headers beyond Accept and If-None-Match.
//
// WASM-free: `rawTokenType` is injected by the caller (from the loaded ledger),
// so this module can be imported anywhere. Images are never fetched or returned.

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';

export const GLOAM_TOKENLIST_SCHEMA = 'gloam.tokenlist/v1';
/** Registry of the local Gloam devnet stack. Not a default — the client is opt-in. */
export const GLOAM_DEVNET_REGISTRY_URL = 'http://localhost:8790';
/** Display decimals for Gloam launch tokens (1 token = 10^6 base units). */
export const GLOAM_LAUNCH_DECIMALS = 6;
/** sNIGHT is denominated in whole NIGHT. */
export const GLOAM_QUOTE_DECIMALS = 0;

const LAUNCH_DOMAIN_TAG = 'gloam:v1:token';
const QUOTE_DOMAIN_TAG = 'sNIGHT-v1';
const HEX32 = /^[0-9a-f]{64}$/;
const MAX_TICKER = 16;
const MAX_NAME = 64;

export type GloamTokenKind = 'launch' | 'quote';

/** One registry entry, after validation. Unknown/extra fields (image, links) are dropped. */
export interface GloamTokenEntry {
  color: string;
  kind: GloamTokenKind;
  contract: string;
  launch?: string;
  ticker: string;
  name?: string;
  /** As claimed by the registry. Display uses {@link canonicalDecimals}. */
  decimals: number;
  metadataDigest?: string;
}

export interface GloamTokenList {
  contract: string;
  generatedAt: string;
  version: number;
  tokens: GloamTokenEntry[];
  /** Entries the parser rejected (malformed), for diagnostics. */
  rejected: number;
}

export type VerificationLevel = 'chain-verified' | 'colour-verified' | 'unverified';

/** A held colour the registry knows, ready for display. */
export interface RegistryToken {
  color: string;
  kind: GloamTokenKind;
  ticker: string;
  /** Present only when the entry is at least colour-verified. */
  name?: string;
  /** Display decimals: canonical for the kind when verified, 0 (raw units) when not. */
  decimals: number;
  level: VerificationLevel;
  /** Why the entry is not verified (or not chain-verified), for display/diagnostics. */
  reason?: string;
}

/** Derives a raw token type (hex) — `ledger().rawTokenType` from the wallet's loaded ledger. */
export type RawTokenTypeFn = (domainSep: Uint8Array, contract: string) => string;

/**
 * Public Gloam contract state, read through the wallet's own indexer
 * connection. Optional: without it entries top out at `colour-verified`.
 */
export interface ChainView {
  /** launch_info[launch] (hex), or undefined if absent on chain. */
  launchInfo(launchHex: string): Promise<{ ticker: string; metadataDigest: string } | undefined>;
  /** The Gloam ledger's quote_color. */
  quoteColor?(): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function pad32(tag: string): Uint8Array {
  const bytes = new TextEncoder().encode(tag);
  if (bytes.length > 32) throw new Error(`pad32: "${tag}" is longer than 32 bytes`);
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
}

/** Domain separator of a launch's token: SHA-256(pad32("gloam:v1:token") || launch). */
export function launchDomainSeparator(launch: Uint8Array): Uint8Array {
  if (launch.length !== 32) throw new Error('launch id must be 32 bytes');
  const buf = new Uint8Array(64);
  buf.set(pad32(LAUNCH_DOMAIN_TAG), 0);
  buf.set(launch, 32);
  return sha256(buf);
}

/** Domain separator of sNIGHT: pad32("sNIGHT-v1"). */
export function quoteDomainSeparator(): Uint8Array {
  return pad32(QUOTE_DOMAIN_TAG);
}

/** Colour (hex) of a launch's token, exactly as the Gloam contract derives it. */
export function launchColorOf(launch: Uint8Array, contract: string, rawTokenType: RawTokenTypeFn): string {
  return rawTokenType(launchDomainSeparator(launch), contract).toLowerCase();
}

/** Bucket of a colour: its first hex digit. */
export function bucketOf(color: string): string {
  const d = color[0]?.toLowerCase() ?? '';
  if (!/^[0-9a-f]$/.test(d)) throw new Error('not a hex colour');
  return d;
}

/** Distinct buckets covering `colors`, sorted. Non-hex ids are ignored. */
export function bucketsFor(colors: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const c of colors) if (HEX32.test(c.toLowerCase())) set.add(bucketOf(c));
  return [...set].sort();
}

/**
 * Paths to request for these held colours. Full-list mode is one path,
 * regardless of holdings. Bucket mode requests only the held buckets. No path
 * ever names a colour.
 */
export function registryPaths(heldColors: Iterable<string>, useBuckets: boolean): string[] {
  const held = [...heldColors].filter((c) => HEX32.test(c.toLowerCase()));
  if (held.length === 0) return [];
  if (!useBuckets) return ['/v1/tokens'];
  return bucketsFor(held).map((d) => `/v1/tokens/buckets/${d}`);
}

/** Display decimals by kind (6 launch / 0 sNIGHT). The registry's own figure is not trusted. */
export function canonicalDecimals(kind: GloamTokenKind): number {
  return kind === 'launch' ? GLOAM_LAUNCH_DECIMALS : GLOAM_QUOTE_DECIMALS;
}

/** The colour's short hash shown next to a ticker (tickers are not unique). */
export function shortColor(color: string): string {
  return `${color.slice(0, 8)}…`;
}

/**
 * Format base units with `decimals` places, trimming trailing zeros. Pure and
 * locale-free, for surfaces without their own formatter.
 */
export function formatTokenUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Strip control and bidi-override characters from registry text; cap its length. */
function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, max);
}

/** Validate a registry base URL (http/https only); returns it without trailing slash, or null. */
export function parseRegistryUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return trimmed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseEntry(raw: unknown): GloamTokenEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const hex = (v: unknown) => (typeof v === 'string' && HEX32.test(v) ? v : undefined);
  const color = hex(e.color);
  const contract = hex(e.contract);
  const kind = e.kind === 'launch' || e.kind === 'quote' ? e.kind : undefined;
  if (!color || !contract || !kind) return null;
  if (typeof e.ticker !== 'string') return null;
  const ticker = cleanText(e.ticker, MAX_TICKER);
  if (!ticker) return null;
  if (typeof e.decimals !== 'number' || !Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > 18) return null;
  const launch = hex(e.launch);
  if (kind === 'launch' && !launch) return null;
  const name = typeof e.name === 'string' ? cleanText(e.name, MAX_NAME) : '';
  const metadataDigest = hex(e.metadataDigest);
  return {
    color,
    kind,
    contract,
    ...(launch ? { launch } : {}),
    ticker,
    ...(name ? { name } : {}),
    decimals: e.decimals,
    ...(metadataDigest ? { metadataDigest } : {}),
  };
}

/** Parse a `gloam.tokenlist/v1` document. Throws on a wrong schema; drops malformed entries. */
export function parseTokenList(body: unknown): GloamTokenList {
  if (!body || typeof body !== 'object') throw new Error('token list: not an object');
  const b = body as Record<string, unknown>;
  if (b.schema !== GLOAM_TOKENLIST_SCHEMA) throw new Error(`token list: unexpected schema ${JSON.stringify(b.schema)}`);
  if (typeof b.contract !== 'string' || !HEX32.test(b.contract)) throw new Error('token list: bad contract');
  if (!Array.isArray(b.tokens)) throw new Error('token list: tokens is not an array');
  const tokens: GloamTokenEntry[] = [];
  let rejected = 0;
  for (const raw of b.tokens) {
    const entry = parseEntry(raw);
    if (entry) tokens.push(entry);
    else rejected++;
  }
  return {
    contract: b.contract,
    generatedAt: typeof b.generatedAt === 'string' ? b.generatedAt : '',
    version: typeof b.version === 'number' ? b.version : 0,
    tokens,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface Verdict {
  level: VerificationLevel;
  reason?: string;
}

/** Re-derive the entry's colour from (launch, contract) — or (sNIGHT tag, contract) for the quote token. */
export function verifyColor(entry: GloamTokenEntry, rawTokenType: RawTokenTypeFn): Verdict {
  let derived: string;
  try {
    derived =
      entry.kind === 'launch'
        ? launchColorOf(hexToBytes(entry.launch!), entry.contract, rawTokenType)
        : rawTokenType(quoteDomainSeparator(), entry.contract).toLowerCase();
  } catch {
    return { level: 'unverified', reason: 'colour could not be derived' };
  }
  return derived === entry.color
    ? { level: 'colour-verified' }
    : { level: 'unverified', reason: 'colour does not derive from (launch, contract)' };
}

/** Full check: colour derivation, then (with a ChainView) on-chain launch_info / quote_color. */
export async function verifyEntry(
  entry: GloamTokenEntry,
  rawTokenType: RawTokenTypeFn,
  chain?: ChainView,
): Promise<Verdict> {
  const colour = verifyColor(entry, rawTokenType);
  if (colour.level !== 'colour-verified' || !chain) return colour;
  try {
    if (entry.kind === 'quote') {
      if (!chain.quoteColor) return { level: 'colour-verified', reason: 'quote colour not readable from chain' };
      const q = await chain.quoteColor();
      return q === entry.color
        ? { level: 'chain-verified' }
        : { level: 'unverified', reason: 'not the contract quote colour' };
    }
    const info = await chain.launchInfo(entry.launch!);
    if (!info) return { level: 'unverified', reason: 'launch not on chain' };
    if (info.ticker !== entry.ticker) return { level: 'unverified', reason: 'ticker differs from chain' };
    if (entry.metadataDigest && info.metadataDigest !== entry.metadataDigest) {
      return { level: 'unverified', reason: 'metadata digest differs from chain' };
    }
    return { level: 'chain-verified' };
  } catch {
    return { level: 'colour-verified', reason: 'chain state unavailable' };
  }
}

const RANK: Record<VerificationLevel, number> = { 'chain-verified': 2, 'colour-verified': 1, unverified: 0 };

/**
 * Match registry entries against held colours and verify each match. Entries
 * for colours the wallet does not hold are ignored. When several entries claim
 * one colour, the best-verified wins (first on a tie).
 */
export async function resolveHeldTokens(
  entries: readonly GloamTokenEntry[],
  heldColors: Iterable<string>,
  rawTokenType: RawTokenTypeFn,
  chain?: ChainView,
): Promise<Record<string, RegistryToken>> {
  const held = new Set([...heldColors].map((c) => c.toLowerCase()));
  const out: Record<string, RegistryToken> = {};
  for (const entry of entries) {
    if (!held.has(entry.color)) continue;
    const verdict = await verifyEntry(entry, rawTokenType, chain);
    const prior = out[entry.color];
    if (prior && RANK[prior.level] >= RANK[verdict.level]) continue;
    out[entry.color] = {
      color: entry.color,
      kind: entry.kind,
      ticker: entry.ticker,
      ...(verdict.level !== 'unverified' && entry.name ? { name: entry.name } : {}),
      // An unverified entry's kind is the registry's word only, so its amount
      // is shown raw rather than scaled by a decimals figure nobody checked.
      decimals: verdict.level === 'unverified' ? 0 : canonicalDecimals(entry.kind),
      level: verdict.level,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export interface GloamRegistryClientOptions {
  baseUrl: string;
  /** Request only held buckets instead of the full list. */
  useBuckets?: boolean;
  fetch?: typeof fetch;
}

interface CacheSlot {
  etag: string | null;
  list: GloamTokenList;
}

export interface GloamRegistryClient {
  /** Fetch (or revalidate) every path needed for these held colours; returns the merged entries. */
  entriesFor(heldColors: Iterable<string>): Promise<GloamTokenEntry[]>;
  readonly baseUrl: string;
  readonly useBuckets: boolean;
}

/**
 * Create a registry client. Responses are cached per path and revalidated with
 * If-None-Match, so polling an unchanged registry costs a 304.
 */
export function createGloamRegistryClient(options: GloamRegistryClientOptions): GloamRegistryClient {
  const baseUrl = parseRegistryUrl(options.baseUrl);
  if (!baseUrl) throw new Error('Gloam registry URL must be an http(s) URL');
  const useBuckets = options.useBuckets === true;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const cache = new Map<string, CacheSlot>();

  async function load(path: string): Promise<GloamTokenList> {
    const slot = cache.get(path);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (slot?.etag) headers['if-none-match'] = slot.etag;
    const res = await doFetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (res.status === 304 && slot) return slot.list;
    if (!res.ok) throw new Error(`Gloam registry returned ${res.status} for ${path}`);
    const list = parseTokenList(await res.json());
    cache.set(path, { etag: res.headers.get('etag'), list });
    return list;
  }

  return {
    baseUrl,
    useBuckets,
    async entriesFor(heldColors) {
      const paths = registryPaths(heldColors, useBuckets);
      const lists = await Promise.all(paths.map(load));
      return lists.flatMap((l) => l.tokens);
    },
  };
}

