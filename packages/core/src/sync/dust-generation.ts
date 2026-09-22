// DUST generation summary: how much DUST the wallet can hold, backed by which
// NIGHT, and when it fills — plus the spendable balance a booked fee hides.
//
// WASM-free on purpose, like progress.ts: wallet-sync.ts reads plain values off
// the facade state and hands them here, so the arithmetic is unit-testable
// without loading the ledger.

export interface DustGeneration {
  balance: bigint;
  designated: bigint;
  ratePerDay: bigint;
  limit: bigint;
  fillTime: Date;
  numUtxos: number;
  registered: boolean;
  /** NIGHT (raw STAR) actually registered for generation — the sum of the
   *  registered UTXOs. Balance beyond this contributes no DUST capacity until
   *  it, too, is registered. */
  registeredNight: bigint;
  /** Creation time of the newest registered NIGHT UTXO, or null when none.
   *  Lets callers distinguish "generation records still settling" (recent)
   *  from a stale local dust view (old UTXOs with no records). */
  newestRegisteredAt: Date | null;
}

/** A NIGHT UTXO registered for DUST generation, as the unshielded sub-wallet reports it. */
export interface RegisteredNightUtxo {
  value: bigint;
  /** Creation time, or null when the SDK reported none. */
  ctime: Date | null;
}

/** A DUST coin as the dust sub-wallet reports it, available or booked as a spend. */
export interface DustCoinSnapshot {
  /** Ceiling this coin generates toward: its backing NIGHT times the DUST ratio. */
  maxCap: bigint;
  /** What it holds now, already accounting for decay once `dtime` is set. */
  generatedNow: bigint;
  /** Specks per second it generates while its backing NIGHT is unspent. */
  rate: bigint;
  /** Set once the backing NIGHT UTXO was spent: the coin only decays from then on. */
  dtime: Date | null;
}

export interface DustGenerationParams {
  nightDustRatio: bigint;
  generationDecayRate: bigint;
  timeToCapSeconds: bigint;
}

export interface DustGenerationInput {
  /** Spendable DUST right now, booked fee inputs included (see spendableDust). */
  balance: bigint;
  registeredNight: ReadonlyArray<RegisteredNightUtxo>;
  dustCoins: ReadonlyArray<DustCoinSnapshot>;
  params: DustGenerationParams;
  now: Date;
}

const sum = (values: ReadonlyArray<bigint>): bigint => values.reduce((total, v) => total + v, 0n);

const latest = (dates: ReadonlyArray<Date | null>): Date | null =>
  dates.reduce<Date | null>((newest, d) => (d && (!newest || d > newest) ? d : newest), null);

/**
 * The DUST the wallet can actually spend, counting the coins booked as fee
 * inputs of a transaction still in flight.
 *
 * Paying a fee moves the WHOLE coin out of the ledger's spendable set until the
 * transaction lands, and the change only arrives with the chain event. Leaving
 * those coins out drops the displayed balance by the size of the coin rather
 * than the size of the fee — with largest-coin-first selection, the largest
 * drop available. The booked list only ever holds coins this wallet spent, so
 * this cannot over-count a receipt; it overstates by the fee itself, which the
 * change corrects within a block.
 */
export function spendableDust(available: bigint, bookedCoins: ReadonlyArray<{generatedNow: bigint}>): bigint {
  return available + sum(bookedCoins.map((c) => c.generatedNow));
}

/**
 * Seconds for a coin to reach its cap, or null when it never will.
 *
 * Exported because every surface that shows a coin's own countdown needs it:
 * the SDK's `maxCapReachedAt` is the coin's creation time plus the whole
 * time-to-cap however full the coin already is, and a spend resets that
 * creation time, so it overstates the wait after every send.
 */
export function secondsUntilFull(coin: {maxCap: bigint; generatedNow: bigint; rate: bigint}): bigint | null {
  const remaining = coin.maxCap - coin.generatedNow;
  if (remaining <= 0n) return 0n;
  if (coin.rate <= 0n) return null;
  // Round up: a partial second still has to elapse.
  return (remaining + coin.rate - 1n) / coin.rate;
}

/**
 * Summarise DUST generation from the registered NIGHT UTXOs and the DUST coins
 * the local dust view knows of.
 *
 * The cap is what registered NIGHT backs. The dust sub-wallet's coins are not a
 * stable source for it: a spent coin leaves `availableCoins` the moment a
 * transaction is submitted, a coin whose backing NIGHT was spent keeps its full
 * `maxCap` while it decays, and the dust and unshielded sub-wallets apply the
 * same transaction at different moments. Callers pass the NIGHT UTXOs booked as
 * inputs of an in-flight transaction along with the available ones, as the
 * displayed NIGHT balance does, so a submission leaves the cap where it was
 * until the transaction lands.
 *
 * The fill time is derived from how full each coin is and how fast it fills,
 * never from the SDK's `maxCapReachedAt`. That field is `ctime` plus the full
 * time-to-cap whatever the coin already holds, and every spend gives the change
 * coin a fresh `ctime`, so a wallet sitting at 39% was told "full in about 7
 * days" — the figure for a coin starting from nothing — after each send.
 */
export function summarizeDustGeneration({
  balance,
  registeredNight,
  dustCoins,
  params,
  now,
}: DustGenerationInput): DustGeneration {
  const registeredNightValue = sum(registeredNight.map((u) => u.value));
  // Decaying coins generate nothing, so they back no capacity.
  const generating = dustCoins.filter((c) => c.dtime === null && c.maxCap > 0n);
  const recordedCap = sum(generating.map((c) => c.maxCap));
  const nightCap = registeredNightValue * params.nightDustRatio;
  // Either sub-wallet may be the first to learn of new NIGHT, so take the
  // larger reading — never a double count, and never zero while one of them
  // still knows the backing NIGHT.
  const limit = nightCap > recordedCap ? nightCap : recordedCap;
  const ratio = params.nightDustRatio;
  const backing = ratio > 0n ? limit / ratio : 0n;

  // Registered NIGHT whose generation record has not reached the local view
  // yet has no coin to measure, so allow it the full climb from nothing.
  const waits = generating.map(secondsUntilFull).filter((s): s is bigint => s !== null);
  if (nightCap > recordedCap) waits.push(params.timeToCapSeconds);
  const longestWait = waits.reduce<bigint | null>((max, s) => (max === null || s > max ? s : max), null);

  return {
    balance,
    designated: ratio > 0n ? recordedCap / ratio : 0n,
    ratePerDay: backing * params.generationDecayRate * 86_400n,
    limit,
    fillTime: longestWait === null ? new Date(0) : new Date(now.getTime() + Number(longestWait) * 1000),
    numUtxos: generating.length,
    registered: registeredNight.length > 0 || generating.length > 0,
    registeredNight: registeredNightValue,
    newestRegisteredAt: latest(registeredNight.map((u) => u.ctime)),
  };
}
