// Send flow: 2e Send → 4b Review → 4c Pending → 2i Success | 2j Failure.
// A transaction carries one or more transfer lines, each its own token, amount
// and recipient (typed or picked from the address book) — different tokens to
// different people, shielded and unshielded mixed, all in one atomic tx with a
// single combined DUST fee. A lone line is the ordinary single send. DUST is
// never a transferable token here; it only pays the fee.

import { useEffect, useRef, useState } from 'react';
import { Calculator, Check, ChevronDown, Eye, LoaderCircle, Moon, Plus, Search, TriangleAlert, X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import type { WalletBalances, TxStage } from '@shieldedtech/moth-browser';
import { sendMessage, type SendTokensRequest, type NameResolution, type RelayState } from '../../lib/messaging/protocol';
import { t } from '../../lib/i18n';
import { formatAmount, formatDustFee, formatTokenBalance, parseAmount } from '../../lib/ui/format';
import { useAddressBook, useTokenNames } from '../../lib/ui/client';
import { sendableTokens, type SendableToken } from '../../lib/ui/token-list';
import { buildBatch, type BatchView, type LineView, type OutputDraft } from '../../lib/ui/send-batch';
import { addressPlaceholder, isValidAddress } from '../../lib/ui/address';
import { isShieldedName, shieldedNameOf, hasConfusableChars } from '../../lib/ui/name-resolve';
import { nativeAssetLabelsForNetwork } from '../../lib/ui/token-labels';
import { provingMethodStatus, type ProverType } from '../../lib/ui/proving-method';
import { cn } from '../../lib/ui/cn';
import type { AddressBookEntry } from '../../lib/background/address-book';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Card, Separator } from '../ui/card';
import { RelayStatus } from '../moth/relay-status';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { AddressPicker } from '../moth/address-picker';
import { TokenIcon, truncateAddress } from '../moth/token';
import { NoteCard } from '../moth/note-card';
import { StatusHero, StepChecklist, DetailCard, type StepState } from '../moth/status';

type Step = 'edit' | 'review' | 'pending' | 'success' | 'failure';

export type FeeEstimateState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; fee: string }
  | { status: 'unavailable' };

/** A committed output, frozen at Review so later screens keep naming what was
 *  sent even after balances change. */
export interface OutputSummary {
  symbol: string;
  amount: string;
  to: string;
  kind: 'shielded' | 'unshielded';
}

function newDraft(tokenId: string): OutputDraft {
  return { id: crypto.randomUUID(), tokenId, amount: '', to: '' };
}

function summarize(batch: BatchView): OutputSummary[] {
  return batch.lines.map((line) => ({
    symbol: line.token.symbol,
    amount: line.draft.amount.trim(),
    to: line.draft.to.trim(),
    kind: line.token.kind,
  }));
}

export function SendFlow({
  walletName,
  network,
  balances,
  txStage,
  proverType,
  relayState,
  onExit,
  onActivity,
}: {
  /** Resolved display name for the account (label or formatted storage name). */
  walletName: string;
  network: string;
  balances: WalletBalances | null;
  txStage: TxStage | null;
  proverType: ProverType | null;
  relayState: RelayState | null;
  onExit: () => void;
  /** Open the activity feed (Success screen's "View in activity"). */
  onActivity?: () => void;
}) {
  const [step, setStep] = useState<Step>('edit');
  const [drafts, setDrafts] = useState<OutputDraft[]>(() => [newDraft(NIGHT_TOKEN_ID)]);
  // Resolved `.shielded` recipients, cached by bare name. See docs/adr/0002.
  const [resolutions, setResolutions] = useState<Record<string, NameResolution | 'resolving'>>({});
  const [txHash, setTxHash] = useState('');
  const [submittedAt, setSubmittedAt] = useState('');
  const [failure, setFailure] = useState('');
  // A finalized transaction has a fixed hash, so firing submit twice sends
  // identical bytes and the node rejects the duplicate ("already imported").
  // A synchronous ref locks out re-entry even for a double-tap that lands
  // before setStep('pending') swaps the Review screen out.
  const submittingRef = useRef(false);

  const labels = nativeAssetLabelsForNetwork(network);
  const { names: tokenNames } = useTokenNames();
  const { entries: book } = useAddressBook();
  const tokens = sendableTokens(balances, labels, tokenNames);

  const resolutionForTo = (to: string): NameResolution | 'resolving' | undefined => {
    const name = shieldedNameOf(to);
    return name ? resolutions[name] : undefined;
  };

  // Forward-resolve any `.shielded` recipients (debounced, cached by bare name)
  // via the background resolver. Addresses pass through untouched.
  useEffect(() => {
    const names = [...new Set(drafts.map((d) => shieldedNameOf(d.to)).filter((n): n is string => n !== null))];
    const pending = names.filter((n) => resolutions[n] === undefined);
    if (pending.length === 0) return;
    setResolutions((prev) => {
      const next = { ...prev };
      for (const n of pending) next[n] = 'resolving';
      return next;
    });
    const timer = setTimeout(() => {
      for (const n of pending) {
        void sendMessage('resolveName', { name: n })
          .then((r) => setResolutions((prev) => ({ ...prev, [n]: r })))
          .catch(() =>
            setResolutions((prev) => ({
              ...prev,
              [n]: { name: n, address: null, verifiedLevel: 'unverified', expiryEpoch: null, error: 'Resolution failed.' },
            })),
          );
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [drafts, resolutions]);

  // Substitute a resolved address in for validation + send. buildBatch then
  // validates it against the token's kind, so an unresolved name or a
  // non-Midnight record simply isn't sendable (safe-degrade). The input still
  // shows the typed name — see `displayTo` on TransferLine.
  const effectiveDrafts = drafts.map((draft) => {
    const r = resolutionForTo(draft.to);
    return r && r !== 'resolving' && r.address ? { ...draft, to: r.address } : draft;
  });
  const batch = buildBatch(effectiveDrafts, tokens);

  // Frozen at Review so the review/pending/success screens keep describing the
  // committed outputs even as balances change under them.
  const [sent, setSent] = useState<{ outputs: OutputSummary[]; requests: SendTokensRequest[] }>({
    outputs: [],
    requests: [],
  });

  // On the edit step the estimate follows the live batch; afterwards it follows
  // the committed requests (Review still shows the fee).
  const estimateRequests = step === 'edit' ? (batch.valid ? batch.requests : null) : sent.requests;
  const feeEstimate = useBatchFeeEstimate(estimateRequests);

  const review = () => {
    setSent({ outputs: summarize(batch), requests: batch.requests });
    setStep('review');
  };

  const submit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setStep('pending');
    try {
      const result = await sendMessage('sendTokens', { outputs: sent.requests });
      setTxHash(result.txHash);
      setSubmittedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setStep('success');
    } catch (err) {
      setFailure(String(err instanceof Error ? err.message : err));
      setStep('failure');
    } finally {
      submittingRef.current = false;
    }
  };

  if (step === 'pending') return <Pending outputs={sent.outputs} dustLabel={labels.dust} txStage={txStage} proverType={proverType} />;
  if (step === 'success') {
    return (
      <Success
        outputs={sent.outputs}
        txHash={txHash}
        submittedAt={submittedAt}
        onDone={onExit}
        onActivity={onActivity}
      />
    );
  }
  if (step === 'failure') {
    return <Failure outputs={sent.outputs} reason={failure} onRetry={() => setStep('edit')} onHome={onExit} />;
  }
  if (step === 'review') {
    return (
      <Review
        outputs={sent.outputs}
        from={walletName}
        dustLabel={labels.dust}
        feeEstimate={feeEstimate}
        onBack={() => setStep('edit')}
        onSend={() => void submit()}
      />
    );
  }

  return (
    <Edit
      drafts={drafts}
      setDrafts={setDrafts}
      batch={batch}
      tokens={tokens}
      book={book}
      resolutionForTo={resolutionForTo}
      dustLabel={labels.dust}
      feeEstimate={feeEstimate}
      relayState={relayState}
      onBack={onExit}
      onReview={review}
    />
  );
}

function useBatchFeeEstimate(requests: SendTokensRequest[] | null): FeeEstimateState {
  const [estimate, setEstimate] = useState<FeeEstimateState>({ status: 'idle' });
  const requestId = useRef(0);
  const requestKey =
    requests && requests.length > 0
      ? requests.map((r) => `${r.type}:${r.tokenId}:${r.amount}:${r.to}`).join('|')
      : '';

  useEffect(() => {
    const id = ++requestId.current;
    if (!requests || requests.length === 0) {
      setEstimate({ status: 'idle' });
      return;
    }

    setEstimate({ status: 'loading' });
    const timer = setTimeout(() => {
      void sendMessage('estimateTransferFee', { outputs: requests }).then(
        ({ fee }) => {
          if (requestId.current === id) setEstimate({ status: 'ready', fee });
        },
        () => {
          if (requestId.current === id) setEstimate({ status: 'unavailable' });
        },
      );
    }, 400);

    return () => {
      clearTimeout(timer);
      // Invalidate an already-started request as well as a pending debounce so
      // an unmounted flow can never receive a late state update.
      if (requestId.current === id) requestId.current += 1;
    };
  }, [requestKey]);

  return estimate;
}

// Render a raw amount as an editable input value. Integer tokens (decimals 0)
// pass through untouched; decimal tokens strip the trailing fractional zeros so
// "Max" fills a clean number rather than "5.000000". The zero-strip must not
// touch integers — it would eat the trailing zeros of "100".
function toInputAmount(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  return formatAmount(raw, decimals).replace(/\.?0+$/, '') || '0';
}

export function Edit({
  drafts,
  setDrafts,
  batch,
  tokens,
  book,
  resolutionForTo,
  dustLabel,
  feeEstimate,
  relayState,
  onBack,
  onReview,
}: {
  drafts: OutputDraft[];
  setDrafts: (update: (prev: OutputDraft[]) => OutputDraft[]) => void;
  batch: BatchView;
  tokens: SendableToken[];
  book: AddressBookEntry[];
  resolutionForTo: (to: string) => NameResolution | 'resolving' | undefined;
  dustLabel: string;
  feeEstimate: FeeEstimateState;
  relayState?: RelayState | null;
  onBack: () => void;
  onReview: () => void;
}) {
  const patch = (id: string, change: Partial<OutputDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...change } : d)));
  const addLine = () =>
    setDrafts((prev) => [...prev, newDraft(prev[prev.length - 1]?.tokenId ?? NIGHT_TOKEN_ID)]);
  const removeLine = (id: string) => setDrafts((prev) => prev.filter((d) => d.id !== id));

  const multiple = drafts.length > 1;

  return (
    <PanelScreen
      cta={
        <Button size="lg" disabled={!batch.valid} onClick={onReview}>
          {multiple ? t('send_reviewCount', [drafts.length]) : t('send_reviewTransfer')}
        </Button>
      }
    >
      <PanelHeader title={t('send_title')} onBack={onBack} />

      {/* Repeated here, not just on Home: the panel can be deep-linked into Send
          by a dApp approval, and a compose screen that hides a known-broken
          broadcast path is how someone ends up debugging a signed transfer that
          never had anywhere to go. */}
      <RelayStatus state={relayState ?? null} />

      {batch.lines.map((line, index) => (
        <TransferLine
          key={line.draft.id}
          index={index}
          line={line}
          displayTo={drafts[index]?.to ?? line.draft.to}
          resolution={resolutionForTo(drafts[index]?.to ?? line.draft.to)}
          tokens={tokens}
          book={book}
          removable={multiple}
          onChange={(change) => patch(line.draft.id, change)}
          onRemove={() => removeLine(line.draft.id)}
        />
      ))}

      <button
        type="button"
        onClick={addLine}
        className="flex cursor-pointer items-center justify-center gap-1.5 self-start border-0 bg-transparent p-0 text-[13px] font-semibold text-link transition duration-150 hover:opacity-75"
      >
        <Plus size={15} strokeWidth={2.5} /> {t('send_addAnother')}
      </button>

      <FeeEstimateCard estimate={feeEstimate} dustLabel={dustLabel} />

      <NoteCard variant="neutral" icon={TriangleAlert}>
        {t('send_oneTransactionNote', [dustLabel])}
      </NoteCard>
    </PanelScreen>
  );
}

function TransferLine({
  index,
  line,
  displayTo,
  resolution,
  tokens,
  book,
  removable,
  onChange,
  onRemove,
}: {
  index: number;
  line: LineView;
  /** What the user actually typed (the batch line's draft holds the resolved
   *  address for a `.shielded` name; the input must still show the name). */
  displayTo: string;
  /** Resolution state for a `.shielded` recipient, if this line is one. */
  resolution?: NameResolution | 'resolving';
  tokens: SendableToken[];
  book: AddressBookEntry[];
  removable: boolean;
  onChange: (change: Partial<OutputDraft>) => void;
  onRemove: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { token, draft } = line;
  const isName = isShieldedName(displayTo);
  const showAmountError = draft.amount.trim().length > 0 && !line.amountValid;
  // For a `.shielded` name the raw input isn't an address — the resolution
  // status below replaces the address-shape error.
  const showAddressError = !isName && displayTo.trim().length > 6 && !line.addressValid;

  const setMax = () => onChange({ amount: toInputAmount(token.balance, token.decimals) });

  return (
    <Card className="flex flex-col gap-3 p-3.5">
      <div className="flex items-center justify-between">
        <TokenTrigger token={token} onClick={() => setPickerOpen(true)} />
        {removable && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('send_removeTransfer', [index + 1])}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition duration-150 hover:bg-muted active:scale-90"
          >
            <X size={15} strokeWidth={2.5} />
          </button>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2">
          <Input
            value={draft.amount}
            invalid={showAmountError || line.overspent}
            inputMode={token.decimals <= 0 ? 'numeric' : 'decimal'}
            placeholder={t('send_amountPlaceholder')}
            aria-label={t('send_amountLabel')}
            onChange={(e) => onChange({ amount: e.target.value })}
          />
          <Button variant="chip" size="sm" onClick={setMax}>{t('send_max')}</Button>
        </div>
        <p className="m-0 mt-1.5 text-[12.5px] text-muted-foreground">
          {t('send_balanceOf', [formatTokenBalance(token.balance, token.decimals), token.symbol])}
        </p>
        {line.overspent ? (
          <p className="m-0 mt-1 text-[12.5px] text-destructive">
            {t('send_overspent', [token.symbol])}
          </p>
        ) : (
          showAmountError && <p className="m-0 mt-1 text-[12.5px] text-destructive">{t('send_moreThanBalance')}</p>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-[13px] text-muted-foreground">{t('send_to')}</p>
        <AddressPicker
          kind={token.kind}
          value={displayTo}
          onChange={(value) => onChange({ to: value })}
          entries={book}
          invalid={showAddressError}
          placeholder={addressPlaceholder(token.kind)}
          ariaLabel={t('send_recipientAddress')}
        />
        {showAddressError && (
          <p className="m-0 mt-0.5 text-[12.5px] text-destructive">
            {t('send_addressKindInvalid', [token.kind])}
          </p>
        )}
        {isName && (
          <NameResolveStatus name={shieldedNameOf(displayTo) ?? ''} kind={token.kind} resolution={resolution} />
        )}
      </div>

      <TokenPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        tokens={tokens}
        selectedId={token.id}
        onSelect={(id) => onChange({ tokenId: id })}
      />
    </Card>
  );
}

/** Send-to-name resolution status shown under a `.shielded` recipient. Forward
 *  resolution only; the send is gated on a valid Midnight address (safe-degrade).
 *  See docs/adr/0002. */
function NameResolveStatus({
  name,
  kind,
  resolution,
}: {
  name: string;
  kind: 'shielded' | 'unshielded';
  resolution?: NameResolution | 'resolving';
}) {
  const confusable = hasConfusableChars(name);
  const resolved =
    resolution && resolution !== 'resolving' && !resolution.error && resolution.address
      ? resolution
      : null;
  const sendable = resolved ? isValidAddress(kind, resolved.address!) : false;

  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {confusable && (
        <p className="m-0 text-[12.5px] text-destructive">{t('send_nameConfusable')}</p>
      )}
      {resolution === undefined || resolution === 'resolving' ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">{t('send_nameResolving')}</p>
      ) : resolution.error ? (
        <p className="m-0 text-[12.5px] text-destructive">{resolution.error}</p>
      ) : resolved && sendable ? (
        <p className="m-0 text-[12.5px] text-success">
          {t('send_nameResolved', [truncateAddress(resolved.address!)])}
          {resolved.verifiedLevel === 'verified' ? ` · ${t('send_nameVerified')}` : ''}
        </p>
      ) : (
        <p className="m-0 text-[12.5px] text-destructive">{t('send_nameUnsendable')}</p>
      )}
    </div>
  );
}

function TokenTrigger({ token, onClick }: { token: SendableToken; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer items-center gap-2 rounded-full border-0 bg-secondary py-1.5 pl-1.5 pr-3 text-secondary-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/70"
    >
      <PillGlyph token={token} />
      <span className="max-w-[120px] truncate text-[15px] font-bold">{token.symbol}</span>
      <ChevronDown size={14} strokeWidth={2.5} />
    </button>
  );
}

// The glyph inside the ink pill: NIGHT keeps its inverted lime circle with an
// ink N; other tokens get a lime-tint circle with a moon (shielded) or eye
// (unshielded) — the same private/visible marks used on the Receive screen.
function PillGlyph({ token }: { token: SendableToken }) {
  if (token.id === NIGHT_TOKEN_ID) {
    return (
      <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-primary font-display text-[13px] font-bold text-primary-foreground">
        N
      </span>
    );
  }
  const Glyph = token.kind === 'shielded' ? Moon : Eye;
  return (
    <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-primary/25 text-primary">
      <Glyph size={15} strokeWidth={2} />
    </span>
  );
}

function TokenPickerDialog({
  open,
  onOpenChange,
  tokens,
  selectedId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tokens: SendableToken[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Start each open with a clean search so a stale filter never hides tokens.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const q = query.trim().toLowerCase();
  const matches = (t: SendableToken) =>
    !q ||
    t.symbol.toLowerCase().includes(q) ||
    t.name.toLowerCase().includes(q) ||
    t.id.toLowerCase().includes(q);
  const unshielded = tokens.filter((t) => t.kind === 'unshielded' && matches(t));
  const shielded = tokens.filter((t) => t.kind === 'shielded' && matches(t));
  const empty = unshielded.length === 0 && shielded.length === 0;

  const choose = (id: string) => {
    onSelect(id);
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-overlay" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            searchRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 flex max-h-[80vh] w-[min(88vw,340px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[20px] bg-background p-4 shadow-pop focus:outline-none"
        >
          <DialogPrimitive.Title className="m-0 px-1 font-display text-lg font-extrabold">{t('send_chooseToken')}</DialogPrimitive.Title>
          <div className="relative mt-3">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('send_searchPlaceholder')}
              aria-label={t('send_searchTokens')}
              className="h-11 pl-10"
            />
          </div>
          <div className="-mx-1 mt-3 flex-1 overflow-y-auto px-1">
            {empty ? (
              <p className="m-0 px-2.5 py-6 text-center text-[13px] text-muted-foreground">{t('send_noTokensMatch', [query])}</p>
            ) : (
              <>
                <TokenGroup label={t('send_groupUnshielded')} tokens={unshielded} selectedId={selectedId} onChoose={choose} />
                <TokenGroup label={t('send_groupShielded')} tokens={shielded} selectedId={selectedId} onChoose={choose} />
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function TokenGroup({
  label,
  tokens,
  selectedId,
  onChoose,
}: {
  label: string;
  tokens: SendableToken[];
  selectedId: string;
  onChoose: (id: string) => void;
}) {
  if (tokens.length === 0) return null;
  return (
    <div className="mb-1">
      <p className="section-label m-0 px-2.5 py-1.5">{label}</p>
      {tokens.map((t) => {
        const active = t.id === selectedId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChoose(t.id)}
            className={cn(
              'flex w-full items-center gap-3 rounded-xl border-0 bg-transparent px-2.5 py-2.5 text-left transition-colors hover:bg-muted',
              active && 'bg-selected hover:bg-selected',
            )}
          >
            <TokenIcon kind={t.id === NIGHT_TOKEN_ID ? 'night' : t.kind} size={32} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{t.symbol}</span>
              <span className="block truncate text-[12px] text-muted-foreground">{t.name}</span>
            </span>
            <span className="text-sm font-semibold">{formatTokenBalance(t.balance, t.decimals)}</span>
            {active && <Check size={15} strokeWidth={2.5} />}
          </button>
        );
      })}
    </div>
  );
}

export function Review({
  outputs,
  from,
  dustLabel,
  feeEstimate,
  onBack,
  onSend,
}: {
  outputs: OutputSummary[];
  from: string;
  dustLabel: string;
  feeEstimate: FeeEstimateState;
  onBack: () => void;
  onSend: () => void;
}) {
  const waitingForEstimate = feeEstimate.status === 'idle' || feeEstimate.status === 'loading';
  const single = outputs.length === 1 ? outputs[0] : null;
  const feeLine = feeEstimate.status === 'ready'
    ? t('send_feeReady', [formatDustFee(BigInt(feeEstimate.fee)), dustLabel])
    : t('send_dustFeeLabel', [dustLabel]);

  return (
    <PanelScreen
      cta={
        <div className="flex flex-col gap-1">
          <Button size="lg" disabled={waitingForEstimate} onClick={onSend}>
            {waitingForEstimate ? t('send_estimatingFee') : t('send_sendNow')}
          </Button>
          <Button variant="ghost" onClick={onBack}>{t('common_back')}</Button>
        </div>
      }
    >
      <PanelHeader title={t('send_reviewTitle')} onBack={onBack} />
      <div className="pt-4 text-center">
        <p className="m-0 text-[13px] text-muted-foreground">
          {single ? t('send_youreSending') : t('send_youreSendingCount', [outputs.length])}
        </p>
        {single && (
          <p className="m-0 font-display text-[44px] font-extrabold leading-tight">
            {single.amount} <span className="text-xl text-foreground/45">{single.symbol}</span>
          </p>
        )}
      </div>

      <Card className="p-0">
        {outputs.map((out, index) => (
          <div key={index}>
            {index > 0 && <Separator />}
            <div className="flex items-center gap-3 px-4 py-[13px]">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{t('send_amountSymbol', [out.amount, out.symbol])}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{truncateAddress(out.to)}</span>
              </span>
              <span className="text-[11px] font-bold uppercase tracking-[0.02em] text-muted-foreground">
                {out.kind === 'shielded' ? t('send_groupShielded') : t('send_groupUnshielded')}
              </span>
            </div>
          </div>
        ))}
      </Card>

      <DetailCard
        rows={[{ label: t('send_from'), value: from }]}
        total={{ label: t('send_networkFee'), value: feeLine }}
      />
      <FeeEstimateCard estimate={feeEstimate} dustLabel={dustLabel} />
      <NoteCard variant="neutral" icon={TriangleAlert}>
        {t('send_checkAddresses')}
      </NoteCard>
    </PanelScreen>
  );
}

/** A high-trust fee treatment shared by the edit and review steps. */
export function FeeEstimateCard({
  estimate,
  dustLabel,
}: {
  estimate: FeeEstimateState;
  dustLabel: string;
}) {
  const ready = estimate.status === 'ready';
  const value = ready
    ? t('send_feeReady', [formatDustFee(BigInt(estimate.fee)), dustLabel])
    : estimate.status === 'loading'
      ? t('send_feeCalculating')
      : estimate.status === 'unavailable'
        ? t('send_feeUnavailable')
        : t('send_feeIdle');
  const note = ready
    ? t('send_feeNoteReady')
    : estimate.status === 'loading'
      ? t('send_feeNoteLoading', [dustLabel])
      : estimate.status === 'unavailable'
        ? t('send_feeNoteUnavailable', [dustLabel])
        : t('send_feeNoteIdle');

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'rounded-[18px] border p-3.5 transition-colors',
        ready ? 'border-primary/35 bg-selected' : 'border-border bg-card',
      )}
    >
      <div className="flex items-center gap-3">
        <span className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          ready ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}>
          {estimate.status === 'loading'
            ? <LoaderCircle size={17} strokeWidth={2.25} className="animate-spin" />
            : <Calculator size={17} strokeWidth={2.25} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">{t('send_networkFee')}</span>
            <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-foreground">
              {t('send_estimateBadge')}
            </span>
          </span>
          <span className={cn(
            'mt-0.5 block text-[15px] font-bold tabular-nums',
            estimate.status === 'unavailable' && 'text-muted-foreground',
          )}>
            {value}
          </span>
        </span>
      </div>
      <p className="mb-0 mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">{note}</p>
    </div>
  );
}

const STAGE_ORDER: TxStage[] = ['building', 'proving', 'submitting'];

/** "3 transfers", or the single output's "5 tNIGHT". */
function outputsLabel(outputs: OutputSummary[]): string {
  if (outputs.length === 1) return t('send_amountSymbol', [outputs[0].amount, outputs[0].symbol]);
  return t('send_transfersCount', [outputs.length]);
}

export function Pending({
  outputs,
  dustLabel,
  txStage,
  proverType,
}: {
  outputs: OutputSummary[];
  dustLabel: string;
  txStage: TxStage | null;
  proverType: ProverType | null;
}) {
  void dustLabel;
  const activeIndex = txStage ? STAGE_ORDER.indexOf(txStage) : 0;
  const stateFor = (index: number): StepState =>
    index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo';

  return (
    <PanelScreen>
      <StatusHero
        state="pending"
        title={t('send_sending', [outputsLabel(outputs)])}
        sub={
          <>
            {t('send_pendingSubTime')}
            <br />
            {t('send_pendingSubClose')}
          </>
        }
      />
      <Card className="mt-2 p-4">
        <StepChecklist
          steps={[
            { label: t('send_stepBuilt'), state: stateFor(0) },
            {
              label: t('send_stepProving'),
              sub: provingMethodStatus(proverType),
              state: stateFor(1),
            },
            { label: t('send_stepSubmitting'), state: stateFor(2) },
          ]}
        />
      </Card>
    </PanelScreen>
  );
}

function Success({
  outputs,
  txHash,
  submittedAt,
  onDone,
  onActivity,
}: {
  outputs: OutputSummary[];
  txHash: string;
  submittedAt: string;
  onDone: () => void;
  onActivity?: () => void;
}) {
  const anyShielded = outputs.some((o) => o.kind === 'shielded');
  return (
    <PanelScreen
      cta={
        <div className="flex flex-col gap-1">
          <Button size="lg" onClick={onDone}>{t('common_done')}</Button>
          {onActivity && (
            <Button variant="ghost" onClick={onActivity}>{t('send_viewInActivity')}</Button>
          )}
        </div>
      }
    >
      <StatusHero
        state="success"
        title={
          outputs.length === 1
            ? t('send_onItsWaySingle', [outputsLabel(outputs)])
            : t('send_onTheirWayMulti', [outputsLabel(outputs)])
        }
        sub={anyShielded ? t('send_successSubShielded') : t('send_successSubUnshielded')}
      />
      <DetailCard
        rows={[
          ...(outputs.length === 1
            ? [{ label: t('send_to'), value: truncateAddress(outputs[0].to), mono: true }]
            : [{ label: t('send_transfers'), value: String(outputs.length) }]),
          { label: t('send_transaction'), value: truncateAddress(txHash, 10, 6), mono: true },
          { label: t('send_status'), value: <span className="text-success">{t('send_submittedAt', [submittedAt])}</span> },
        ]}
      />
    </PanelScreen>
  );
}

function Failure({
  outputs,
  reason,
  onRetry,
  onHome,
}: {
  outputs: OutputSummary[];
  reason: string;
  onRetry: () => void;
  onHome: () => void;
}) {
  return (
    <PanelScreen
      cta={
        <div className="flex flex-col gap-1">
          <Button size="lg" onClick={onRetry}>{t('send_tryAgain')}</Button>
          <Button variant="ghost" onClick={onHome}>{t('send_backToHome')}</Button>
        </div>
      }
    >
      <StatusHero
        state="failure"
        title={t('send_failureTitle')}
        sub={
          outputs.length === 1
            ? t('send_failureSubSingle', [outputsLabel(outputs)])
            : t('send_failureSubMulti', [outputsLabel(outputs)])
        }
      />
      <DetailCard
        rows={[{ label: t('send_reason'), value: reason || t('send_unknownError'), error: true }]}
        footnote={t('send_provingFootnote')}
      />
    </PanelScreen>
  );
}
