// Maps wallet balances onto the DUST meter/gauge view model. Lives apart from
// the moth/dust.tsx view components so they stay free of wallet-SDK imports.

import { NIGHT_TOKEN_ID, type WalletBalances } from '@shieldedtech/moth-browser';
import { t } from '../i18n';
import { shouldRepairDustView } from '../offscreen/dust-heal';
import { formatDust } from './format';
import type { NativeAssetLabels } from './token-labels';

export interface DustView {
  current: string;
  max: string;
  percent: number;
  etaText: string;
  /** True while the dust sub-wallet is still syncing — amounts are provisional. */
  syncing: boolean;
  /** Registered and holding value, but the records that define the cap have not
   *  been applied — the cap is UNKNOWN, not zero. Callers must show this instead
   *  of a percentage of nothing, or a real balance reads as "3,301.04 of 0". */
  capacityUnknown: boolean;
  /** The wallet holds NIGHT, but none of it is registered for generation — so
   *  it has capacity available to it and is not using it. Distinct from holding
   *  no NIGHT at all, which is what the "waiting" copy is for. */
  unregisteredNight: boolean;
  /** True when the local dust view looks stale enough to be worth rebuilding:
   *  registered NIGHT old enough that its generation records must exist, yet
   *  still missing from the local capacity. Offers the rebuild; never runs it. */
  canRebuild: boolean;
}

export function dustView(
  balances: WalletBalances,
  labels: NativeAssetLabels,
  dustSynced = balances.syncProgress.dustSynced,
): DustView {
  const generation = balances.dustGeneration;
  const current = balances.dust;
  const max = generation?.limit ?? 0n;
  const percent = max > 0n ? Math.min(100, Number((current * 100n) / max)) : 0;
  const syncing = !dustSynced;

  // NIGHT is unshielded-only — the shielded wallet never holds it.
  const night = balances.unshielded[NIGHT_TOKEN_ID] ?? 0n;
  // Registered NIGHT is what actually generates. A wallet can hold NIGHT with
  // none of it registered, and that is the case the old copy could not express:
  // it reported "Waiting for NIGHT" whenever capacity was zero, which is also
  // true of a funded wallet that simply has not registered yet. Being told to
  // wait for something you already have is worse than being told nothing.
  const registered = generation?.registered === true;
  const unregisteredNight = night > 0n && !registered;

  // A cap of zero on a registered wallet that holds value is missing records,
  // not an empty allowance. The value clause is defensive: core only reports
  // `registered` off a registered NIGHT UTXO, so it already implies night > 0n.
  const capacityUnknown = registered && max === 0n && (current > 0n || night > 0n);

  // Computed before the ETA, which uses it to tell a genuinely stale view from
  // one that is merely settling.
  //
  // lastHealAt is null: the old cooldown existed to stop an automatic repair
  // from looping. A rebuild the user asked for needs no cooldown.
  //
  // Note the predicate's pending-dust guard is inert here — serializeForClients
  // strips `coins` before balances reach the panel, so client-side this reduces
  // to "synced, registered, deficit, newest registration older than the grace
  // period". That is the right gate for *offering* a rebuild; the engine-side
  // guards still apply to running one.
  const canRebuild = shouldRepairDustView(balances, Date.now(), null);

  // Mid-sync amounts move as coins apply, so never claim "Fully generated"
  // (or an ETA) until the dust sub-wallet has caught up.
  //
  // Ordered so the fallback is reached only when nothing better applies; every
  // override used to be gated on `max > 0n`, which left a registered wallet with
  // no cap showing "not registered yet".
  //
  // A missing cap is only an error once it has outlived the settling window.
  // Core reports `registered, limit: 0n` for the whole normal gap between
  // registering and the first dust coin applying, so calling that "records
  // missing" — with no rebuild offered, beside a note saying generation starts
  // on its own — reproduces the contradiction this is meant to remove.
  // `canRebuild` already encodes exactly that staleness test.
  let etaText: string;
  if (syncing) etaText = t('dust_etaSyncing');
  else if (capacityUnknown) etaText = canRebuild ? t('dust_etaRecordsMissing') : t('dust_etaRecordsSettling');
  else if (max > 0n && percent >= 100) etaText = t('dust_etaFullyGenerated');
  else if (max > 0n && generation) {
    const fill = generation.fillTime;
    const ms = fill.getTime() - Date.now();
    // Scale the unit to the magnitude: NIGHT holdings can put "full" weeks out,
    // where a raw hour count ("167 hours") reads worse than "7 days".
    if (ms <= 0) {
      etaText = t('dust_etaFullyGenerated');
    } else if (ms < 3_600_000) {
      const min = Math.max(1, Math.round(ms / 60_000));
      etaText = t('dust_etaFullInMin', [min]);
    } else if (ms < 48 * 3_600_000) {
      const hours = Math.round(ms / 3_600_000);
      etaText = hours > 1 ? t('dust_etaFullInHours', [hours]) : t('dust_etaFullInHour');
    } else {
      // The days branch starts at 48 hours, so the count is always plural.
      const days = Math.round(ms / 86_400_000);
      etaText = t('dust_etaFullInDays', [days]);
    }
  } else if (night > 0n && !registered) {
    etaText = t('dust_etaNotRegistered', [labels.night]);
  } else {
    etaText = t('dust_etaWaitingFor', [labels.night]);
  }

  return {
    current: formatDust(current),
    max: formatDust(max),
    percent,
    etaText,
    syncing,
    capacityUnknown,
    unregisteredNight,
    canRebuild,
  };
}
