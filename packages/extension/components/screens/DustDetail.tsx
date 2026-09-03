// 8i DUST generation — ring gauge + facts card + explainer, plus registering
// unshielded NIGHT for DUST generation: confirm → pending → success | failure,
// mirroring the Send flow. Registration binds the NIGHT key (DustRegistration),
// so NIGHT received later auto-registers — but each UTXO generates through its
// own on-chain record, which starts after a grace period and reaches the wallet
// via dust sync. Three populations can therefore differ: the balance, the
// flag-registered NIGHT (CTA shows only for the rest), and the NIGHT actually
// generating now (designated = capacity ÷ ratio) — the cap is captioned with
// the last, never the whole balance.

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Moon } from 'lucide-react';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import {
  registerOutcome,
  isSuccessOutcome,
  mayBeProvingFailure,
  type RegisterOutcome,
} from '../../lib/ui/dust-register-outcome';
import { waitPhrase } from '../../lib/ui/wait-phrase';
import type { DustNotYet, NightCoinRow } from '../../lib/messaging/protocol';

/** Why registration is not possible yet, in the user's language. A null wait
 *  means no amount of waiting helps — the holding's ceiling is below the fee. */
function notYetReason(notYet: DustNotYet, labels: { night: string; dust: string }): string {
  if (notYet.secondsUntilAffordable === null) {
    return t('dust_notYetNeedMore', [labels.dust, labels.night]);
  }
  const wait = waitPhrase(notYet.secondsUntilAffordable);
  return t('dust_notYetReason', [labels.dust, labels.night, t(wait.key, wait.args)]);
}
import type { WalletBalances, TxStage } from '@shieldedtech/moth-browser';
import { sendMessage } from '../../lib/messaging/protocol';
import { t } from '../../lib/i18n';
import { useAddressBook } from '../../lib/ui/client';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { AddressPicker } from '../moth/address-picker';
import { DustRingGauge } from '../moth/dust';
import { useSyncRegressionGrace } from '../moth/sync-status';
import { dustView } from '../../lib/ui/dust-view';
import { provingMethodStatus, type ProverType } from '../../lib/ui/proving-method';
import {
  DUST_WALLET_LABEL,
  nativeAssetLabelsForNetwork,
  type NativeAssetLabels,
} from '../../lib/ui/token-labels';
import { formatTokenBalance } from '../../lib/ui/format';
import { NoteCard } from '../moth/note-card';
import { StatusHero, StepChecklist, DetailCard, type StepState } from '../moth/status';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { DialogShell } from '../ui/dialog';

type Step = 'idle' | 'pending' | 'success' | 'failure';
type Mode = 'register' | 'deregister';

/** Quick shape check for a bech32m DUST address (authoritative parsing happens
 *  in core, which rejects invalid receivers). Empty means "use this wallet". */
export function looksLikeDustAddress(value: string): boolean {
  return /^mn_dust[a-z0-9_]*1[a-z0-9]{20,}$/i.test(value.trim());
}

export function DustDetail({
  balances,
  txStage,
  proverType,
  network,
  ownDustAddress,
  onBack,
}: {
  balances: WalletBalances | null;
  txStage: TxStage | null;
  proverType: ProverType | null;
  network: string;
  /** This wallet's own DUST address — the default generation receiver. */
  ownDustAddress: string;
  onBack: () => void;
}) {
  const [step, setStep] = useState<Step>('idle');
  const [mode, setMode] = useState<Mode>('register');
  const [confirm, setConfirm] = useState<Mode | null>(null);
  const [receiver, setReceiver] = useState('');
  const [failure, setFailure] = useState('');
  const { entries: book } = useAddressBook();
  const labels = nativeAssetLabelsForNetwork(network);
  // Core returns a null txHash when every NIGHT UTXO was already registered
  // (a benign race with on-chain auto-registration) — word the success page for it.
  const [outcome, setOutcome] = useState<RegisterOutcome>('submitted');
  // Guard against a double-tap on "Register" submitting the same tx twice
  // before the dialog closes — see the note in SendFlow's submit().
  const registeringRef = useRef(false);
  // Latches once the rebuild is requested: the sync restart it triggers takes
  // minutes, and re-requesting it would only start the rescan over.
  const [rebuilding, setRebuilding] = useState(false);
  const dustSynced = useSyncRegressionGrace(
    balances?.syncProgress.dustSynced ?? false,
    balances !== null,
    // Raw dust fraction: a rebuild drops this far enough to bypass the grace,
    // so an explicit rescan is reported instead of being smoothed over.
    balances && balances.subProgress.dust.total > 0
      ? balances.subProgress.dust.applied / balances.subProgress.dust.total
      : undefined,
  );

  if (!balances) {
    return (
      <PanelScreen>
        <PanelHeader title={labels.dust} onBack={onBack} />
        <p className="text-muted-foreground">{t('dust_waitingForSync')}</p>
      </PanelScreen>
    );
  }

  // Evict the dust sync cache and rescan. Spends nothing, so there is no
  // confirm step or pending/success screen — the dust gauge's own syncing
  // overlay reports the rescan, exactly as it does for a normal sync.
  const rebuild = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      await sendMessage('dustRebuild', undefined);
    } catch {
      // Nothing was spent and nothing is stranded: on failure the existing dust
      // cache is either intact or already rebuilding. Let the gauge speak.
      setRebuilding(false);
    }
  };

  const run = async (which: Mode) => {
    if (registeringRef.current) return;
    registeringRef.current = true;
    setConfirm(null);
    setMode(which);
    setStep('pending');
    try {
      if (which === 'register') {
        const trimmed = receiver.trim();
        const { txHash, notYet } = await sendMessage('registerDust', {
          // Empty or the wallet's own address means the default receiver.
          dustAddress: trimmed && trimmed !== ownDustAddress ? trimmed : undefined,
        });
        const outcome = registerOutcome({
          txHash,
          notYet: notYet !== undefined,
          registered: balances.dustGeneration?.registered ?? false,
          nightBalance: balances.unshielded[NIGHT_TOKEN_ID] ?? 0n,
        });
        setOutcome(outcome);
        // 'unavailable' and 'no-night' registered nothing, so they are not
        // success. Routing them to the success screen is the defect this
        // replaces: an unreachable node was reported as "already generating".
        setStep(isSuccessOutcome(outcome) ? 'success' : 'failure');
        if (!isSuccessOutcome(outcome)) {
          setFailure(
            outcome === 'not-yet'
              ? notYetReason(notYet!, labels)
              : outcome === 'no-night'
                ? t('dust_registerNoNight', [labels.night])
                : t('dust_registerUnavailable', [labels.night]),
          );
        }
        registeringRef.current = false;
        return;
      } else {
        await sendMessage('deregisterDust', undefined);
        setOutcome('submitted');
      }
      setStep('success');
    } catch (err) {
      setFailure(String(err instanceof Error ? err.message : err));
      setStep('failure');
    } finally {
      registeringRef.current = false;
    }
  };

  const receiverValid = receiver.trim() === '' || looksLikeDustAddress(receiver);

  if (step === 'pending') return <Pending mode={mode} txStage={txStage} dustLabel={labels.dust} proverType={proverType} />;
  if (step === 'success') {
    return <ActionSuccess mode={mode} outcome={outcome} labels={labels} onDone={onBack} />;
  }
  if (step === 'failure') {
    return (
      <ActionFailure
        mode={mode}
        outcome={outcome}
        reason={failure}
        nightLabel={labels.night}
        onRetry={() => setStep('idle')}
        onHome={onBack}
      />
    );
  }

  const view = dustView(balances, labels, dustSynced);
  const night = balances.unshielded[NIGHT_TOKEN_ID] ?? 0n;
  const registered = balances.dustGeneration?.registered === true;
  const registeredNight = balances.dustGeneration?.registeredNight ?? 0n;
  // NIGHT whose generation records exist now — the true backing of the cap.
  const generating = balances.dustGeneration?.designated ?? 0n;
  const unregistered = night > registeredNight ? night - registeredNight : 0n;
  const notGenerating = night > generating ? night - generating : 0n;
  // Registration state is provisional mid-sync too, so hold the CTA until done.
  const canRegister = balances.syncProgress.dustSynced && unregistered > 0n;

  const openRegister = () => {
    setReceiver(ownDustAddress);
    setConfirm('register');
  };

  return (
    <PanelScreen
      cta={
        canRegister ? (
          <Button size="lg" onClick={openRegister}>
            {registered
              ? t('dust_registerAmount', [formatTokenBalance(unregistered, 6), labels.night])
              : t('dust_startGenerating', [labels.dust])}
          </Button>
        ) : undefined
      }
    >
      <PanelHeader title={labels.dust} onBack={onBack} />
      <div className="relative flex flex-col gap-4" aria-busy={view.syncing}>
        <div className="pt-4">
          <DustRingGauge view={view} labels={labels} />
          <p className="m-0 mt-4 text-center text-sm font-semibold">{t('dust_percentGenerated', [view.percent])}</p>
          <p className="m-0 text-center text-[12.5px] text-muted-foreground">{view.etaText}</p>
        </div>
        <DetailCard
          rows={[
            { label: t('dust_generatedNow'), value: t('dust_amountLabel', [view.current, labels.dust]) },
            {
              label: t('dust_totalPossible'),
              // The cap comes from the NIGHT generating right now — attributing
              // it to the whole balance would misstate what generates.
              sub: registered
                ? t('dust_fromYourNightGenerating', [formatTokenBalance(generating, 6), labels.night])
                : t('dust_fromYourNight', [formatTokenBalance(night, 6), labels.night]),
              value: t('dust_amountLabel', [view.max, labels.dust]),
            },
            { label: t('dust_generationRate'), sub: t('dust_setByNetwork'), value: t('dust_variable') },
            {
              label: t('dust_generationRow'),
              value: registered ? <span className="text-success">{t('dust_registeredGenerating')}</span> : t('dust_notRegistered'),
            },
          ]}
        />
        <NightCoinBreakdown labels={labels} />
        {registered && unregistered > 0n ? (
          <NoteCard icon={Moon}>
            {t('dust_noteUnregisteredSome', [formatTokenBalance(unregistered, 6), labels.night, labels.dust])}
          </NoteCard>
        ) : registered && notGenerating > 0n ? (
          <NoteCard icon={Moon}>
            {t('dust_noteNotGenerating', [formatTokenBalance(notGenerating, 6), labels.night, labels.dust])}
          </NoteCard>
        ) : registered ? (
          <NoteCard icon={Moon}>
            {t('dust_noteRegisteredHold', [labels.night, labels.dust])}
          </NoteCard>
        ) : night > 0n ? (
          <NoteCard icon={Moon}>
            {t('dust_noteRegisterPrompt', [labels.night, labels.dust])}
          </NoteCard>
        ) : (
          <NoteCard icon={Moon}>
            {t('dust_noteNoNight', [labels.dust, labels.night])}
          </NoteCard>
        )}
        {view.canRebuild && (
          <>
            <NoteCard icon={Moon}>{t('dust_rebuildNote', [labels.night, labels.dust])}</NoteCard>
            <Button
              variant="outline"
              className="self-center"
              disabled={rebuilding}
              onClick={() => void rebuild()}
            >
              {t('dust_rebuildRecords', [labels.dust])}
            </Button>
          </>
        )}
        {registered && balances.syncProgress.dustSynced && (
          <Button variant="ghost" className="self-center text-destructive" onClick={() => setConfirm('deregister')}>
            {t('dust_stopGenerating', [labels.dust])}
          </Button>
        )}
        {view.syncing && (
          <div
            role="status"
            aria-live="polite"
            className="absolute -inset-2 z-10 flex flex-col items-center justify-center gap-2.5 rounded-[18px] bg-background/70 backdrop-blur-[3px]"
          >
            <LoaderCircle size={28} strokeWidth={2.5} className="animate-spin text-link" />
            <p className="m-0 text-sm font-semibold">{t('dust_syncingWallet', [DUST_WALLET_LABEL])}</p>
            <p className="m-0 max-w-[220px] text-center text-[12.5px] text-muted-foreground">
              {t('dust_finalAmounts')}
            </p>
          </div>
        )}
      </div>

      <DialogShell
        open={confirm === 'register'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('dust_generateTitle', [labels.dust])}
        actions={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t('common_cancel')}
            </Button>
            <Button disabled={!receiverValid} onClick={() => void run('register')}>
              {t('dust_register')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2.5">
          <p className="m-0">
            {t('dust_generateBodyReceiver', [labels.night, labels.dust])}
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold uppercase tracking-wide">{t('dust_addressLabel', [labels.dust])}</span>
            <AddressPicker
              kind="dust"
              value={receiver}
              onChange={setReceiver}
              entries={book}
              invalid={!receiverValid}
              placeholder="mn_dust…"
              ariaLabel={t('dust_addressLabel', [labels.dust])}
            />
          </label>
          <p className="m-0 text-[12px]">
            {receiverValid
              ? t('dust_receiverHint', [labels.dust])
              : t('dust_receiverInvalid', [labels.dust])}
          </p>
        </div>
      </DialogShell>

      <DialogShell
        open={confirm === 'deregister'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('dust_stopTitle', [labels.dust])}
        actions={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t('common_cancel')}
            </Button>
            <Button variant="soft-destructive" onClick={() => void run('deregister')}>
              {t('dust_stop')}
            </Button>
          </>
        }
      >
        {t('dust_deregisterBody', [labels.night, labels.dust])}
      </DialogShell>
    </PanelScreen>
  );
}

const STAGE_ORDER: TxStage[] = ['building', 'proving', 'submitting'];

function Pending({
  mode,
  txStage,
  dustLabel,
  proverType,
}: {
  mode: Mode;
  txStage: TxStage | null;
  dustLabel: string;
  proverType: ProverType | null;
}) {
  const activeIndex = txStage ? STAGE_ORDER.indexOf(txStage) : 0;
  const stateFor = (index: number): StepState =>
    index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo';

  return (
    <PanelScreen>
      <StatusHero
        state="pending"
        title={mode === 'register' ? t('dust_registeringFor', [dustLabel]) : t('dust_stoppingGeneration', [dustLabel])}
        sub={
          <>
            {t('dust_pendingSub1')}
            <br />
            {t('dust_pendingSub2')}
          </>
        }
      />
      <Card className="mt-2 p-4">
        <StepChecklist
          steps={[
            { label: mode === 'register' ? t('dust_stepBuilt') : t('dust_stepBuiltTx'), state: stateFor(0) },
            {
              label: t('dust_stepProving'),
              sub: provingMethodStatus(proverType),
              state: stateFor(1),
            },
            { label: t('dust_stepSubmitting'), state: stateFor(2) },
          ]}
        />
      </Card>
    </PanelScreen>
  );
}

function ActionSuccess({
  mode,
  outcome,
  labels,
  onDone,
}: {
  mode: Mode;
  outcome: RegisterOutcome;
  labels: NativeAssetLabels;
  onDone: () => void;
}) {
  const already = outcome === 'already-registered';
  const title =
    mode === 'deregister'
      ? t('dust_generationStopped', [labels.dust])
      : already
        ? t('dust_alreadyGeneratingTitle', [labels.dust])
        : t('dust_generatingTitle', [labels.dust]);
  const sub =
    mode === 'deregister'
      ? t('dust_deregisteredSub', [labels.night, labels.dust])
      : already
        ? t('dust_alreadyGeneratingSub', [labels.night, labels.dust])
        : t('dust_generatingSub', [labels.night, labels.dust]);

  return (
    <PanelScreen cta={<Button size="lg" onClick={onDone}>{t('common_done')}</Button>}>
      <StatusHero state="success" title={title} sub={sub} />
    </PanelScreen>
  );
}

function ActionFailure({
  mode,
  outcome,
  reason,
  nightLabel,
  onRetry,
  onHome,
}: {
  mode: Mode;
  outcome: RegisterOutcome | null;
  reason: string;
  nightLabel: string;
  onRetry: () => void;
  onHome: () => void;
}) {
  // Not a failure: nothing was attempted on-chain and nothing is wrong. Saying
  // "That didn't go through" over a wallet that simply needs to age is what made
  // this look like a broken wallet.
  const notYet = outcome === 'not-yet';
  return (
    <PanelScreen
      cta={
        <div className="flex flex-col gap-1">
          <Button size="lg" onClick={onRetry}>{t('dust_tryAgain')}</Button>
          <Button variant="ghost" onClick={onHome}>{t('dust_backToHome')}</Button>
        </div>
      }
    >
      <StatusHero
        state="failure"
        title={notYet ? t('dust_notYetTitle') : t('dust_failureTitle')}
        sub={
          notYet
            ? t('dust_notYetSub', [nightLabel])
            : mode === 'register'
              ? t('dust_failureSub', [nightLabel])
              : t('dust_deregisterFailureSub', [nightLabel])
        }
      />
      <DetailCard
        rows={[{ label: t('dust_reason'), value: reason || t('dust_unknownError'), error: true }]}
        footnote={mayBeProvingFailure(outcome) ? t('dust_provingFootnote') : undefined}
      />
    </PanelScreen>
  );
}

/**
 * Per-coin NIGHT breakdown, fetched on demand.
 *
 * The aggregate figures above cannot distinguish the two reasons registration
 * finds nothing to do — every coin already registered, versus every coin booked
 * by a transaction that has not settled — because the displayed balance folds
 * booked coins in. Telling them apart previously meant opening the TUI, the only
 * surface carrying per-coin flags.
 *
 * Collapsed by default: it answers a question most people never ask, and the
 * fetch touches the offscreen host.
 */
function NightCoinBreakdown({ labels }: { labels: NativeAssetLabels }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NightCoinRow[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void sendMessage('dustNightCoins', undefined)
      .then((r) => {
        if (live) setRows(r);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [open]);

  const booked = (rows ?? []).filter((r) => r.booked);
  const bookedTotal = booked.reduce((sum, r) => sum + BigInt(r.valueStars), 0n);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="bg-transparent p-0 text-[12.5px] font-semibold text-muted-foreground underline"
      >
        {open ? t('dust_coinsHide') : t('dust_coinsShow')}
      </button>
      {open && rows !== null && (
        <div className="mt-2">
          <p className="m-0 mb-1 text-[12.5px] font-semibold">{t('dust_coinsTitle', [labels.night])}</p>
          {rows.length === 0 ? (
            <p className="m-0 text-[12.5px] text-muted-foreground">{t('dust_coinsEmpty', [labels.night])}</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {rows.map((r, i) => (
                <li key={`${r.valueStars}-${i}`} className="flex items-baseline justify-between py-0.5 text-[12.5px]">
                  <span className="tabular-nums">
                    {formatTokenBalance(BigInt(r.valueStars), 6)} {labels.night}
                  </span>
                  <span className={r.booked ? 'text-warning' : r.registered ? 'text-success' : 'text-muted-foreground'}>
                    {r.booked
                      ? t('dust_coinsBooked')
                      : r.registered
                        ? t('dust_coinsRegistered')
                        : t('dust_coinsUnregistered')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* The case that produces "not available to register" while the
              balance still shows the NIGHT. Named, so it is not a mystery. */}
          {bookedTotal > 0n && (
            <p className="m-0 mt-1 text-[12.5px] text-muted-foreground">
              {t('dust_coinsBookedNote', [formatTokenBalance(bookedTotal, 6), labels.night])}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
