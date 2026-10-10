// Cardano / cNIGHT — holdings on Cardano and the DUST designation that turns
// them into DUST on Midnight.
//
// Two chains disagree on purpose here: Cardano confirms a registration in
// seconds, and the Midnight indexer takes minutes to notice it. The screen
// reports both rather than folding them into one flag, because a correct,
// freshly-submitted registration otherwise reads as a failed one.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronRight, LoaderCircle, Link2, TriangleAlert } from 'lucide-react';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../lib/messaging/protocol';
import { t } from '../../lib/i18n';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { NoteCard } from '../moth/note-card';
import { DetailCard, StatusHero } from '../moth/status';
import { DustMeterCard } from '../moth/dust';
import { nativeAssetLabelsForNetwork } from '../../lib/ui/token-labels';
import { truncateAddress } from '../moth/token';
import { DUST_DENOMINATION } from '@shieldedtech/moth-wallet/wallet/balance-format';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';

type Status = Awaited<ReturnType<typeof fetchStatus>>;
type Account = Awaited<ReturnType<typeof fetchAccount>>;
type AccountList = Awaited<ReturnType<typeof fetchAccounts>>;

function fetchAccounts() {
  return sendMessage('cardanoAccountList', undefined);
}

function fetchStatus() {
  return sendMessage('cardanoStatus', undefined);
}

/** Pure derivation in the offscreen document — no Blockfrost, no network. */
function fetchAccount() {
  return sendMessage('cardanoAddresses', undefined);
}

type Mode =
  | { kind: 'loading' }
  | { kind: 'accounts' }
  | { kind: 'import' }
  | { kind: 'rename'; id: string; current: string }
  | { kind: 'send' }
  // The account exists, the chain cannot be read. Distinct from 'unavailable'
  // because the address is still worth showing — funding it is the step that
  // comes before everything else here, and it needs no Blockfrost key.
  | { kind: 'chainBlocked'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'overview' }
  | { kind: 'receiver'; action: 'register' | 'update' }
  // Every action is reviewed before it is signed, as the CLI and TUI do.
  | { kind: 'confirm'; action: Action; dustAddress?: string; send?: SendRequest }
  | { kind: 'pending'; action: Action }
  | { kind: 'done'; action: Action; txHash: string; explorer: string; cleared?: number }
  | { kind: 'failed'; action: Action; message: string };

type Action = 'register' | 'deregister' | 'update' | 'send';

interface SendRequest {
  readonly to: string;
  readonly lovelace: bigint;
  readonly cnight: bigint;
}

/** Lovelace are 6dp. Rendered, never rounded. */
function formatAda(lovelace: string): string {
  const value = BigInt(lovelace);
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * SPECK → DUST. The indexer reports capacities in SPECK (10^15 per DUST), the
 * same units the dApp runs through specksToTDust.
 *
 * Trailing zeros are trimmed but the value is never rounded up: this is a
 * balance, and showing more than someone has is the one error that matters.
 */
function formatDust(speck: string): string {
  const value = BigInt(speck);
  const whole = value / DUST_DENOMINATION;
  const frac = (value % DUST_DENOMINATION).toString().padStart(15, '0').replace(/0+$/, '');
  // Six places is plenty to see accrual move without turning into noise.
  return frac ? `${whole}.${frac.slice(0, 6)}` : `${whole}`;
}

/**
 * cNIGHT for display. The on-chain quantity is in STARs (10^6 per cNIGHT);
 * Cardano publishes no decimals and the asset has no registry entry, so an
 * explorer shows the raw integer and this is the only place the scale is known.
 */
function formatCnight(stars: string): string {
  const value = BigInt(stars);
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** cNIGHT as typed → STARs. "10" means ten cNIGHT, never ten STARs. */
function parseCnightInput(value: string): bigint | null {
  const text = value.trim();
  if (text === '') return 0n;
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

/** Accrued as a percentage of the ceiling; 0 when the ceiling is unknown. */
function capacityPercent(current: string, max: string | null): number {
  if (!max || max === '0') return 0;
  const pct = (BigInt(current) * 100n) / BigInt(max);
  return Math.min(100, Number(pct));
}

/** Coarse above an hour, precise below — matches core's describeCountdown. */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return t('cardano_usableAnyMoment');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function shorten(value: string): string {
  return value.length <= 22 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`;
}

/**
 * Middle-truncate a bech32 address keeping the whole human-readable prefix, the
 * same way the Receive screen does — the prefix is what tells you which network
 * and which kind of address you are looking at, so it must not be cut.
 *
 * A Cardano base address is 103 characters. In a side panel it has to be
 * truncated and copied, never laid out in full: putting one in a label/value
 * row is what made this screen overflow its own card.
 */
function displayAddress(address: string): string {
  const sep = address.indexOf('1');
  return truncateAddress(address, sep > 0 ? sep + 1 : 10, 6);
}

export function Cardano({
  network,
  onBack,
}: {
  /** MIDNIGHT network id — decides tDUST vs DUST naming, not the Cardano one. */
  network: string;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [status, setStatus] = useState<Status | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [receiver, setReceiver] = useState('');
  const [receiverError, setReceiverError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountList | null>(null);
  const [importPhrase, setImportPhrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importLabel, setImportLabel] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [sendAda, setSendAda] = useState('');
  const [sendCnight, setSendCnight] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   * Midnight accounts offered as DUST receivers.
   *
   * The DUST address comes out of each account's *public* addresses,
   * so every account can be offered without unlocking it — which matters,
   * because the account holding the cNIGHT is usually not the one being paid.
   */
  const [midnightAccounts, setMidnightAccounts] = useState<
    ReadonlyArray<{
      name: string;
      label: string;
      shieldedAddress: string;
      dustAddress: string;
      dustAddressBytes: string;
    }>
  >([]);
  // Ticks once a minute so the countdown moves without re-querying the chain.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!status?.secondsRemaining) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [status?.secondsRemaining]);

  const refresh = useCallback(async () => {
    setMode({ kind: 'loading' });
    // Derivation first, and independently. It is the one call that works before
    // anything is configured, so a failure here means there is genuinely no
    // Cardano account — locked wallet, or one restored from a hex seed.
    // The account list is independent of every other call: it is storage-only,
    // so it works while locked out of Blockfrost and while the chain is down.
    await fetchAccounts().then(setAccounts).catch(() => setAccounts(null));
    // Derived offscreen: the decode needs the ledger WASM, which has no place
    // in the panel bundle.
    await sendMessage('cardanoReceiverAccounts', undefined)
      .then(setMidnightAccounts)
      .catch(() => setMidnightAccounts([]));
    let derived: Account;
    try {
      derived = await fetchAccount();
      setAccount(derived);
    } catch (err) {
      setMode({ kind: 'unavailable', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    try {
      setStatus(await fetchStatus());
      setMode({ kind: 'overview' });
    } catch (err) {
      // The background names this one: no Blockfrost project ID. The account
      // above is still good, so the screen keeps it on display.
      setMode({ kind: 'chainBlocked', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: Action, dustAddress?: string, send?: SendRequest) => {
    setMode({ kind: 'pending', action });
    try {
      const result =
        action === 'send'
          ? await sendMessage('cardanoSend', {
              to: send!.to,
              lovelace: send!.lovelace.toString(),
              cnight: send!.cnight.toString(),
            })
          : action === 'register'
          ? await sendMessage('cardanoRegister', dustAddress ? { dustAddress } : undefined)
          : action === 'deregister'
            ? await sendMessage('cardanoDeregister', undefined)
            : await sendMessage('cardanoUpdate', { dustAddress: dustAddress! });
      if (action === 'send') {
        setSendTo('');
        setSendAda('');
        setSendCnight('');
        toast(t('cardano_sendSent'));
      }
      setMode({
        kind: 'done',
        action,
        txHash: result.txHash,
        explorer: result.explorer,
        // Only cardanoDeregister returns a count; the union does not narrow
        // usefully across four different message results.
        ...(() => {
          const cleared = (result as { cleared?: number }).cleared;
          return cleared === undefined ? {} : { cleared };
        })(),
      });
    } catch (err) {
      setMode({ kind: 'failed', action, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const submitReceiver = async (action: 'register' | 'update') => {
    const raw = receiver.trim();
    if (action === 'register' && raw === '') {
      setMode({ kind: 'confirm', action: 'register' });
      return;
    }
    try {
      // Resolved in the background: it accepts a shielded address as well as
      // raw hex, and names the DUST-address mistake specifically.
      const { dustAddressBytes } = await sendMessage('cardanoResolveReceiver', { input: raw });
      // Refused here rather than by the builder. Core rejects a no-op update
      // too, but arriving at it through the pending screen presents a
      // pre-flight refusal as a failed transaction.
      if (action === 'update' && dustAddressBytes === status?.registeredDustAddress) {
        setReceiverError(t('cardano_receiverUnchanged'));
        return;
      }
      setMode({ kind: 'confirm', action, dustAddress: dustAddressBytes });
    } catch (err) {
      setReceiverError(err instanceof Error ? err.message : t('cardano_receiverInvalid'));
    }
  };

  const header = <PanelHeader title={t('cardano_title')} onBack={onBack} />;

  if (mode.kind === 'loading') {
    return (
      <PanelScreen>
        {header}
        <div className="flex items-center gap-2 pt-8 text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span>{t('cardano_loading')}</span>
        </div>
      </PanelScreen>
    );
  }

  /**
   * One address, truncated with a copy button. Its job is to be copied, not
   * read — so it gets a full-width row of its own rather than the right-hand
   * column of a label/value pair, which a 103-character address overflows.
   */
  const addressRow = (label: string, value: string) => (
    <div className="flex flex-col gap-1">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{displayAddress(value)}</span>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => toast(t('cardano_addressCopied')));
          }}
        >
          {t('cardano_copy')}
        </Button>
      </div>
    </div>
  );

  const accountCard = (network: string, address: string, rewardAddress: string) => (
    <Card className="flex flex-col gap-3 p-3.5">
      <div className="flex items-baseline justify-between text-[13.5px]">
        <span className="text-muted-foreground">{t('cardano_networkRow')}</span>
        <span className="font-medium">{network}</span>
      </div>
      {addressRow(t('cardano_addressRow'), address)}
      {addressRow(t('cardano_stakeAddressRow'), rewardAddress)}
      <p className="m-0 text-xs text-muted-foreground">{t('cardano_accountDerived')}</p>
    </Card>
  );

  const accountPanel = account && (
    <>
      {accountCard(account.cardanoNetwork, account.address, account.rewardAddress)}
      <NoteCard variant="info" icon={Link2}>
        {t('cardano_accountFundHint')}
      </NoteCard>
    </>
  );

  const activeAccount = accounts?.accounts.find((a) => a.id === accounts.activeId);

  /** One tappable row naming the active account, opening the manager. */
  const accountSwitcher = accounts && accounts.accounts.length > 0 && (
    <button
      onClick={() => setMode({ kind: 'accounts' })}
      className="group flex w-full cursor-pointer items-center justify-between rounded-[18px] border border-border bg-card px-4 py-3 text-left transition duration-150 hover:bg-muted"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{activeAccount?.label}</span>
        <span className="text-[12.5px] text-muted-foreground">
          {activeAccount?.kind === 'imported'
            ? t('cardano_accountImportedTag')
            : t('cardano_accountDerivedTag')}
        </span>
      </span>
      <ChevronRight size={15} className="shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" />
    </button>
  );

  const runAccountAction = async (fn: () => Promise<AccountList>, toastKey: Parameters<typeof t>[0]) => {
    setBusy(true);
    try {
      setAccounts(await fn());
      toast(t(toastKey));
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (mode.kind === 'send') {
    // ADA is 6dp; cNIGHT is a whole-unit token. Parsing here keeps a typo from
    // reaching the builder, where it surfaces as a coin-selection failure.
    const toLovelace = (value: string): bigint | null => {
      const text = value.trim();
      if (text === '') return 0n;
      if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
      const [whole, frac = ''] = text.split('.');
      return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
    };
    const toCnight = parseCnightInput;

    const submitSend = () => {
      const lovelace = toLovelace(sendAda);
      const cnight = toCnight(sendCnight);
      if (lovelace === null || cnight === null) {
        setSendError(t('cardano_sendBadAmount'));
        return;
      }
      if (lovelace === 0n && cnight === 0n) {
        setSendError(t('cardano_sendNothing'));
        return;
      }
      if (!sendTo.trim().startsWith('addr')) {
        setSendError(t('cardano_sendBadAddress'));
        return;
      }
      setSendError(null);
      setMode({ kind: 'confirm', action: 'send', send: { to: sendTo.trim(), lovelace, cnight } });
    };

    return (
      <PanelScreen
        cta={
          <>
            <Button variant="secondary" onClick={() => setMode({ kind: 'overview' })}>
              {t('cardano_cancel')}
            </Button>
            <Button onClick={submitSend}>{t('cardano_send')}</Button>
          </>
        }
      >
        <PanelHeader title={t('cardano_sendTitle')} onBack={() => setMode({ kind: 'overview' })} />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('cardano_sendTo')}</span>
          <Input
            value={sendTo}
            placeholder={t('cardano_sendToPlaceholder')}
            onChange={(e) => { setSendTo(e.target.value); setSendError(null); }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('cardano_sendAda')}</span>
          <Input
            inputMode="decimal"
            value={sendAda}
            onChange={(e) => { setSendAda(e.target.value); setSendError(null); }}
          />
          {status && (
            <span className="text-xs text-muted-foreground">
              {t('cardano_sendAvailable', [formatAda(status.lovelace)])}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('cardano_sendCnight')}</span>
          <Input
            inputMode="decimal"
            value={sendCnight}
            onChange={(e) => { setSendCnight(e.target.value); setSendError(null); }}
          />
          {status && (
            <span className="text-xs text-muted-foreground">
              {t('cardano_sendAvailable', [formatCnight(status.cnight)])}
            </span>
          )}
        </label>
        {status?.registered && toCnight(sendCnight) !== null && (toCnight(sendCnight) ?? 0n) > 0n && (
          <NoteCard variant="error" icon={TriangleAlert}>
            {t('cardano_sendRegisteredWarning')}
          </NoteCard>
        )}
        {sendError && <p className="m-0 text-xs text-destructive">{sendError}</p>}
      </PanelScreen>
    );
  }

  if (mode.kind === 'rename') {
    const submitRename = async () => {
      const label = renameDraft.trim();
      if (!label) {
        setRenameError(t('cardano_accountNameEmpty'));
        return;
      }
      const { id } = mode;
      await runAccountAction(
        () => sendMessage('cardanoAccountRename', { id, label }),
        'cardano_accountRenamed',
      );
      setMode({ kind: 'accounts' });
    };

    return (
      <PanelScreen
        cta={
          <>
            <Button variant="secondary" onClick={() => setMode({ kind: 'accounts' })}>
              {t('cardano_cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void submitRename()}>
              {t('cardano_accountRename')}
            </Button>
          </>
        }
      >
        <PanelHeader title={t('cardano_accountRenameTitle')} onBack={() => setMode({ kind: 'accounts' })} />
        <label className="flex flex-col gap-1.5 pt-2">
          <span className="text-sm font-medium">{t('cardano_accountLabel')}</span>
          <Input
            autoFocus
            value={renameDraft}
            onChange={(e) => { setRenameDraft(e.target.value); setRenameError(null); }}
          />
          {renameError && <span className="text-xs text-destructive">{renameError}</span>}
        </label>
      </PanelScreen>
    );
  }

  if (mode.kind === 'accounts') {
    return (
      <PanelScreen cta={<Button onClick={() => void refresh()}>{t('cardano_accountBack')}</Button>}>
        <PanelHeader title={t('cardano_accountsTitle')} onBack={() => setMode({ kind: 'overview' })} />

        <Card className="flex flex-col gap-1 p-2">
          {accounts?.accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded-[14px] px-2 py-2">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{a.label}</span>
                <span className="text-[12px] text-muted-foreground">
                  {a.kind === 'imported' ? t('cardano_accountImportedTag') : t('cardano_accountDerivedTag')}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {a.id === accounts.activeId ? (
                  <span className="text-[12px] font-medium text-muted-foreground">{t('cardano_accountActive')}</span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void runAccountAction(
                        () => sendMessage('cardanoAccountSelect', { id: a.id }),
                        'cardano_accountActive',
                      )
                    }
                  >
                    {t('cardano_accountSwitch')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setRenameDraft(a.label);
                    setRenameError(null);
                    setMode({ kind: 'rename', id: a.id, current: a.label });
                  }}
                >
                  {t('cardano_accountRename')}
                </Button>
                {(accounts.accounts.length > 1) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      // Destroys the only copy of an imported phrase held here,
                      // so it asks even though nothing else on this screen does.
                      if (!window.confirm(t('cardano_accountRemoveConfirm'))) return;
                      void runAccountAction(
                        () => sendMessage('cardanoAccountRemove', { id: a.id }),
                        'cardano_accountRemoved',
                      );
                    }}
                  >
                    {t('cardano_accountRemove')}
                  </Button>
                )}
              </span>
            </div>
          ))}
        </Card>

        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void runAccountAction(
              () => sendMessage('cardanoAccountAdd', undefined),
              'cardano_accountAdded',
            )
          }
        >
          {t('cardano_accountAdd')}
        </Button>
        <p className="m-0 text-xs text-muted-foreground">{t('cardano_accountAddHint')}</p>

        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setImportPhrase('');
            setImportPassphrase('');
            setImportLabel('');
            setImportError(null);
            setMode({ kind: 'import' });
          }}
        >
          {t('cardano_accountImport')}
        </Button>
        <p className="m-0 text-xs text-muted-foreground">{t('cardano_accountImportHint')}</p>
      </PanelScreen>
    );
  }

  if (mode.kind === 'import') {
    const submitImport = async () => {
      const phrase = importPhrase.trim().replace(/\s+/g, ' ');
      if (phrase.split(' ').length < 12) {
        setImportError(t('cardano_accountInvalidPhrase'));
        return;
      }
      if (!importPassphrase) {
        setImportError(t('cardano_accountPassphraseRequired'));
        return;
      }
      setBusy(true);
      try {
        setAccounts(
          await sendMessage('cardanoAccountImport', {
            mnemonic: phrase,
            passphrase: importPassphrase,
            ...(importLabel.trim() ? { label: importLabel.trim() } : {}),
          }),
        );
        // Clear the secrets from component state the moment they are no longer
        // needed; the screen keeps neither after a successful import.
        setImportPhrase('');
        setImportPassphrase('');
        toast(t('cardano_accountImported'));
        await refresh();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    };

    return (
      <PanelScreen
        cta={
          <>
            <Button variant="secondary" onClick={() => setMode({ kind: 'accounts' })}>
              {t('cardano_cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void submitImport()}>
              {t('cardano_accountImport')}
            </Button>
          </>
        }
      >
        <PanelHeader title={t('cardano_accountImport')} onBack={() => setMode({ kind: 'accounts' })} />
        <NoteCard variant="error" icon={TriangleAlert}>
          {t('cardano_accountImportHint')}
        </NoteCard>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('cardano_accountImportPhrase')}</span>
          <Input
            type="password"
            value={importPhrase}
            placeholder={t('cardano_accountImportPhrasePlaceholder')}
            onChange={(e) => { setImportPhrase(e.target.value); setImportError(null); }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('cardano_accountImportPassphrase')}</span>
          <Input
            type="password"
            value={importPassphrase}
            onChange={(e) => { setImportPassphrase(e.target.value); setImportError(null); }}
          />
          <span className="text-xs text-muted-foreground">{t('cardano_accountImportPassphraseHint')}</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('cardano_accountLabel')}</span>
          <Input value={importLabel} onChange={(e) => setImportLabel(e.target.value)} />
        </label>
        {importError && <p className="m-0 text-xs text-destructive">{importError}</p>}
      </PanelScreen>
    );
  }

  if (mode.kind === 'chainBlocked') {
    return (
      <PanelScreen cta={<Button onClick={() => void refresh()}>{t('cardano_retry')}</Button>}>
        {header}
        {accountSwitcher}
        {accountPanel}
        <NoteCard variant="error" icon={TriangleAlert}>
          {t('cardano_chainUnavailable')} {mode.message}
        </NoteCard>
      </PanelScreen>
    );
  }

  if (mode.kind === 'unavailable') {
    return (
      <PanelScreen cta={<Button onClick={() => void refresh()}>{t('cardano_retry')}</Button>}>
        {header}
        <NoteCard variant="error" icon={TriangleAlert}>
          {mode.message}
        </NoteCard>
      </PanelScreen>
    );
  }

  if (mode.kind === 'confirm') {
    const { action, dustAddress, send } = mode;
    const back = () => setMode(action === 'send' ? { kind: 'send' } : { kind: 'overview' });
    const actionLabel = {
      send: t('cardano_send'),
      register: t('cardano_register'),
      deregister: t('cardano_deregister'),
      update: t('cardano_update'),
    }[action];
    const receiverName = dustAddress
      ? midnightAccounts.find((a) => a.dustAddressBytes === dustAddress)?.name ?? truncateAddress(dustAddress)
      : t('cardano_confirmThisWallet');
    const rows = [
      { label: t('cardano_confirmActionLabel'), value: actionLabel },
      { label: t('cardano_confirmNetworkLabel'), value: status?.cardanoNetwork ?? account?.cardanoNetwork ?? '—' },
      { label: t('cardano_confirmAccountLabel'), value: activeAccount?.label ?? '—' },
      ...(send
        ? [
            { label: t('cardano_sendTo'), value: displayAddress(send.to), mono: true },
            {
              label: t('cardano_sendAda'),
              value: send.lovelace > 0n ? formatAda(send.lovelace.toString()) : t('cardano_confirmMinAda'),
            },
            ...(send.cnight > 0n ? [{ label: t('cardano_sendCnight'), value: formatCnight(send.cnight.toString()) }] : []),
          ]
        : []),
      ...(action === 'register' || action === 'update'
        ? [{ label: t('cardano_confirmDustToLabel'), value: receiverName }]
        : []),
      ...(action !== 'send' && status
        ? [{ label: t('cardano_confirmCnightMovedLabel'), value: formatCnight(status.cnight) }]
        : []),
    ];
    return (
      <PanelScreen
        cta={
          <>
            <Button variant="secondary" onClick={back}>{t('cardano_cancel')}</Button>
            <Button onClick={() => void run(action, dustAddress, send)}>{t('cardano_confirm')}</Button>
          </>
        }
      >
        <PanelHeader title={t('cardano_confirmTitle')} onBack={back} />
        <DetailCard rows={rows} />
        {action === 'deregister' && (
          <NoteCard variant="error" icon={TriangleAlert}>{t('cardano_confirmDeregisterNote')}</NoteCard>
        )}
        {action === 'send' && status?.registered && (send?.cnight ?? 0n) > 0n && (
          <NoteCard variant="error" icon={TriangleAlert}>{t('cardano_sendRegisteredWarning')}</NoteCard>
        )}
        {action !== 'send' && (
          <NoteCard variant="info" icon={Link2}>{t('cardano_rotationNote')}</NoteCard>
        )}
      </PanelScreen>
    );
  }

  if (mode.kind === 'pending') {
    return (
      <PanelScreen>
        {header}
        <StatusHero state="pending" title={t('cardano_submitting')} />
      </PanelScreen>
    );
  }

  if (mode.kind === 'done') {
    return (
      <PanelScreen cta={<Button onClick={() => void refresh()}>{t('common_done')}</Button>}>
        {header}
        <StatusHero state="success" title={t('cardano_submitted')} />

        {/* The hash is what someone chases the transaction with, so it gets a
            copy button and a link rather than being truncated into a dead row. */}
        <Card className="flex flex-col gap-2 p-3.5">
          <span className="text-[12.5px] text-muted-foreground">{t('cardano_txRow')}</span>
          <span className="break-all font-mono text-[12.5px]">{mode.txHash}</span>
          <div className="flex gap-2 [&>*]:flex-1">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(mode.txHash).then(() => toast(t('cardano_txCopied')));
              }}
            >
              {t('cardano_copy')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { void browser.tabs.create({ url: mode.explorer }); }}
            >
              {t('cardano_viewInExplorer')}
            </Button>
          </div>
        </Card>

        {/* Only the two actions that start or move a registration. A send and a
            deregistration have nothing to do with DUST starting up, and saying
            so after an ADA transfer is just wrong. */}
        {(mode.action === 'register' || mode.action === 'update') && (
          <NoteCard variant="info" icon={Link2}>
            {t('cardano_afterRegisterNote')}
          </NoteCard>
        )}
        {/* Naming the count matters when it is more than one: that is the
            duplicate state, and clearing it is what makes registering work. */}
        {mode.action === 'deregister' && mode.cleared !== undefined && mode.cleared > 1 && (
          <NoteCard variant="info" icon={Link2}>
            {t('cardano_deregisteredCleared', [mode.cleared])}
          </NoteCard>
        )}
      </PanelScreen>
    );
  }

  if (mode.kind === 'failed') {
    // `refresh` returns to the overview rather than retrying the action, so the
    // button says so. "Try again" on a button that does not try again is worse
    // than no button.
    return (
      <PanelScreen cta={<Button onClick={() => void refresh()}>{t('common_back')}</Button>}>
        {header}
        <StatusHero state="failure" title={t('cardano_notSubmitted')} />
        <NoteCard variant="error" icon={TriangleAlert}>
          {mode.message}
        </NoteCard>
      </PanelScreen>
    );
  }

  if (mode.kind === 'receiver') {
    const action = mode.action;
    return (
      <PanelScreen
        cta={
          <>
            <Button variant="secondary" onClick={() => setMode({ kind: 'overview' })}>
              {t('cardano_cancel')}
            </Button>
            <Button onClick={() => void submitReceiver(action)}>{t('cardano_confirm')}</Button>
          </>
        }
      >
        {header}

        {/* Picking beats typing: a DUST address is long, and a typo can still
            decode to a valid address that pays DUST to nobody. */}
        {midnightAccounts.length > 0 && (
          <Card className="flex flex-col gap-1 p-2">
            <span className="px-2 pt-1 text-[12.5px] text-muted-foreground">
              {t('cardano_receiverPickAccount')}
            </span>
            {midnightAccounts.map((a) => (
              <button
                key={a.name}
                onClick={() => { setReceiver(a.dustAddress); setReceiverError(null); }}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-[14px] border-0 bg-transparent px-2 py-2 text-left transition duration-150 hover:bg-muted"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{a.label}</span>
                  <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                    {displayAddress(a.shieldedAddress)}
                  </span>
                </span>
                {receiver === a.dustAddress && (
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    {t('cardano_receiverSelected')}
                  </span>
                )}
              </button>
            ))}
          </Card>
        )}

        <label className="flex flex-col gap-1.5 pt-2">
          <span className="text-sm font-medium">{t('cardano_receiverLabel')}</span>
          <Input
            value={receiver}
            placeholder={t('cardano_receiverPlaceholder')}
            onChange={(e) => {
              setReceiver(e.target.value);
              setReceiverError(null);
            }}
          />
          {action === 'register' && (
            <span className="text-xs text-muted-foreground">{t('cardano_receiverUseThisWallet')}</span>
          )}
          {receiverError && <span className="text-xs text-destructive">{receiverError}</span>}
        </label>
        <NoteCard variant="info" icon={Link2}>
          {t('cardano_rotationNote')}
        </NoteCard>
      </PanelScreen>
    );
  }

  if (!status) return null;

  const designation = !status.registered
    ? t('cardano_notRegistered')
    : status.registeredToThisWallet
      ? t('cardano_registered')
      : t('cardano_registeredElsewhere');

  const hasCnight = BigInt(status.cnight) > 0n;
  // Testnet vs mainnet naming (tDUST / DUST), from the Midnight network.
  const labels = nativeAssetLabelsForNetwork(network);
  // Only when the registration points at an account this wallet knows. A
  // registration to someone else's key has a DUST address we cannot name.
  const registeredDustAddress =
    midnightAccounts.find((a) => a.dustAddressBytes === status.registeredDustAddress)?.dustAddress || '';

  return (
    <PanelScreen
      cta={
        status.registered ? (
          <>
            <Button variant="secondary" onClick={() => setMode({ kind: 'confirm', action: 'deregister' })}>
              {t('cardano_deregister')}
            </Button>
            <Button
              onClick={() => {
                setReceiver('');
                setReceiverError(null);
                setMode({ kind: 'receiver', action: 'update' });
              }}
            >
              {t('cardano_update')}
            </Button>
          </>
        ) : (
          <Button
            disabled={!hasCnight}
            onClick={() => {
              setReceiver('');
              setReceiverError(null);
              setMode({ kind: 'receiver', action: 'register' });
            }}
          >
            {t('cardano_register')}
          </Button>
        )
      }
    >
      {header}
      {accountSwitcher}

      {accountCard(status.cardanoNetwork, status.address, status.rewardAddress)}

      {/* The same meter the home screen uses for DUST overall, scoped to what
          this cNIGHT generates. Rendered without onOpen: there is nowhere
          further to go from here, and a chevron that does nothing is worse
          than none. */}
      {status.registered && status.currentCapacity !== null && (
        <DustMeterCard
          labels={labels}
          subtitle={t('cardano_meterSubtitle')}
          view={{
            current: formatDust(status.currentCapacity),
            max: status.maxCapacity ? formatDust(status.maxCapacity) : '0',
            percent: capacityPercent(status.currentCapacity, status.maxCapacity),
            etaText:
              status.secondsRemaining === null
                ? t('cardano_usableUnknown')
                : status.secondsRemaining > 0
                  ? t('cardano_usableIn', [formatCountdown(status.secondsRemaining)])
                  : t('cardano_usableNow'),
            syncing: false,
            // A missing or zero ceiling is unknown, not zero — the same rule
            // the native meter follows, and it stops a real balance rendering
            // as "31,884.99 of 0".
            capacityUnknown: !status.maxCapacity || status.maxCapacity === '0',
            unregisteredNight: false,
            canRebuild: false,
          }}
        />
      )}

      {/* Where the generated DUST actually lands. "This wallet" alone does not
          let anyone check it, and it is the value you hand to someone else. */}
      {registeredDustAddress && (
        <Card className="flex flex-col gap-2 p-3.5">
          <span className="text-[12.5px] text-muted-foreground">{t('cardano_dustAddressRow')}</span>
          <span className="break-all font-mono text-[12.5px]">{registeredDustAddress}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(registeredDustAddress)
                .then(() => toast(t('cardano_addressCopied')));
            }}
          >
            {t('cardano_copy')}
          </Button>
        </Card>
      )}

      <DetailCard
        rows={[
          { label: t('cardano_adaRow'), value: formatAda(status.lovelace) },
          {
            label: t('cardano_cnightRow'),
            value: formatCnight(status.cnight),
            sub:
              status.cnightUtxos === 1
                ? t('cardano_cnightUtxosOne')
                : t('cardano_cnightUtxos', [status.cnightUtxos]),
          },
          {
            label: t('cardano_designationRow'),
            value: designation,
            error: status.registered && !status.registeredToThisWallet,
          },
          ...(status.registered && status.registeredDustAddress
            ? [
                {
                  label: t('cardano_dustToRow'),
                  value: status.registeredToThisWallet
                    ? t('cardano_dustToThisWallet')
                    : shorten(status.registeredDustAddress),
                  mono: !status.registeredToThisWallet,
                },
              ]
            : []),
          // Only while registered. An unregistered stake key generates nothing
          // by definition, so a "Generating 0" row states the obvious in a way
          // that reads like a fault.
          ...(status.registered
            ? [
                {
                  label: t('cardano_generatingRow'),
                  // Generation begins at registration — it is being *usable*
                  // that waits for finality. A reported rate of exactly "0" is
                  // the indexer saying it has not credited anything yet, not a
                  // real rate, and rendering it as a bare 0 reads as broken.
                  // The rate is SPECK per second, like the capacities above.
                  value:
                    status.generationRate && status.generationRate !== '0'
                      ? t('cardano_generationRateValue', [formatDust(status.generationRate), labels.dust])
                      : t('cardano_generatingAccruing'),
                },
                {
                  // The state that was invisible: Cardano-side "Registered"
                  // said nothing about whether Midnight had ingested it, and a
                  // rejected registration looked identical to a pending one.
                  label: t('cardano_midnightRow'),
                  value:
                    status.midnightValid === true
                      ? t('cardano_midnightLive')
                      : status.midnightValid === false
                        ? t('cardano_midnightRejected')
                        : t('cardano_midnightPending'),
                  error: status.midnightValid === false,
                },
                {
                  label: t('cardano_usableRow'),
                  // Three states, not two. Null means the registration is not
                  // in a block yet or Blockfrost could not say — unknown, which
                  // must not be shown as "Now".
                  value:
                    status.secondsRemaining === null
                      ? t('cardano_usableUnknown')
                      : status.secondsRemaining > 0
                        ? t('cardano_usableIn', [formatCountdown(status.secondsRemaining)])
                        : t('cardano_usableNow'),
                },
              ]
            : []),
        ]}
        {...(status.registered && status.midnightValid !== true
          ? {
              footnote:
                status.midnightValid === false
                  ? t('cardano_midnightRejectedHint')
                  : status.secondsRemaining !== null && status.secondsRemaining > 0
                    ? t('cardano_finalityHint')
                    : t('cardano_midnightPendingHint'),
            }
          : {})}
      />

      {/* One note, not two. Whether you can register and what registering does
          are the same question at this point in the screen. */}
      <Button
        variant="secondary"
        onClick={() => {
          setSendTo('');
          setSendAda('');
          setSendCnight('');
          setSendError(null);
          setMode({ kind: 'send' });
        }}
      >
        {t('cardano_send')}
      </Button>

      {/* Only when there is something to say. Once registered, the Deregister
          button already says what deregistering does — a note repeating it is
          noise. */}
      {status.registrationCount > 1 && (
        <NoteCard variant="error" icon={TriangleAlert}>
          {t('cardano_multipleRegistrations', [status.registrationCount])}
        </NoteCard>
      )}

      {/* Valid on Cardano, invisible to Midnight. Without this the screen shows
          a healthy registration and the only symptom is DUST that never
          arrives — the failure that cost twelve hours to find. */}
      {status.legacyDustAddress && (
        <NoteCard variant="error" icon={TriangleAlert}>
          {t('cardano_legacyDustAddress')}
        </NoteCard>
      )}

      {!hasCnight ? (
        <NoteCard variant="error" icon={TriangleAlert}>
          {t('cardano_errorNoCnight')}
        </NoteCard>
      ) : !status.registered ? (
        <NoteCard variant="info" icon={Link2}>
          {t('cardano_registerHint')}
        </NoteCard>
      ) : null}
    </PanelScreen>
  );
}
