// DUST generation summary: how much DUST the wallet can hold, backed by which
// NIGHT, and when it fills.
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
  maxCap: bigint;
  maxCapReachedAt: Date;
  /** Set once the backing NIGHT UTXO was spent: the coin only decays from then on. */
  dtime: Date | null;
}

export interface DustGenerationParams {
  nightDustRatio: bigint;
  generationDecayRate: bigint;
  timeToCapSeconds: bigint;
}

export interface DustGenerationInput {
  /** Spendable DUST right now. */
  balance: bigint;
  registeredNight: ReadonlyArray<RegisteredNightUtxo>;
  dustCoins: ReadonlyArray<DustCoinSnapshot>;
  params: DustGenerationParams;
}

const sum = (values: ReadonlyArray<bigint>): bigint => values.reduce((total, v) => total + v, 0n);

const latest = (dates: ReadonlyArray<Date | null>): Date | null =>
  dates.reduce<Date | null>((newest, d) => (d && (!newest || d > newest) ? d : newest), null);

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
 */
export function summarizeDustGeneration({balance, registeredNight, dustCoins, params}: DustGenerationInput): DustGeneration {
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

  const fillTime =
    latest([
      ...generating.map((c) => c.maxCapReachedAt),
      ...registeredNight.map((u) => (u.ctime ? new Date(u.ctime.getTime() + Number(params.timeToCapSeconds) * 1000) : null)),
    ]) ?? new Date(0);

  return {
    balance,
    designated: ratio > 0n ? recordedCap / ratio : 0n,
    ratePerDay: backing * params.generationDecayRate * 86_400n,
    limit,
    fillTime,
    numUtxos: generating.length,
    registered: registeredNight.length > 0 || generating.length > 0,
    registeredNight: registeredNightValue,
    newestRegisteredAt: latest(registeredNight.map((u) => u.ctime)),
  };
}
