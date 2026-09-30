// Cardano screen — cNIGHT holdings and DUST designation.
//
// Presentational only, in the same shape as dust.tsx: every side effect is a
// prop, so the screen can be rendered in a test without a Blockfrost key or a
// Cardano network behind it.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { SectionHeader } from '../components/SectionHeader.js';
import { HelpFooter, type HelpHint } from '../components/HelpFooter.js';

export interface CardanoStatusView {
  readonly cardanoNetwork: string;
  readonly address: string;
  readonly rewardAddress: string;
  readonly lovelace: bigint;
  readonly cnight: bigint;
  readonly cnightUtxos: number;
  readonly registered: boolean;
  readonly registeredCoinPublicKey: string | null;
  readonly registeredToThisWallet: boolean;
  /** Midnight-side generation view; null until the indexer has caught up. */
  readonly generationRate: string | null;
  /** Seconds until Cardano finality; null means not in a block yet / unknown. */
  readonly secondsRemaining: number | null;
}

/**
 * The Cardano account itself: derived, never created. Reading it is pure — no
 * Blockfrost, no network — which is what lets the screen show someone where to
 * send ADA before they have configured anything.
 */
export interface CardanoAccountView {
  readonly cardanoNetwork: string;
  readonly address: string;
  readonly rewardAddress: string;
  readonly midnightCoinPublicKey: string;
}

/** One Cardano account as the account list shows it. */
export interface CardanoAccountListItem {
  readonly id: string;
  readonly label: string;
  readonly kind: 'derived' | 'imported';
  readonly accountIndex: number;
  readonly active: boolean;
}

export type CardanoActionResult =
  | { success: true; txHash: string }
  | { success: false; error: string };

interface CardanoProps {
  /**
   * Why this wallet has no Cardano account at all — locked, or restored from a
   * hex seed. Nothing on this screen is meaningful in that case, not even the
   * address, because there is no key to derive one from.
   */
  unavailableReason?: string;
  /**
   * Why the chain cannot be read, when the account itself is fine. In practice
   * this is a missing Blockfrost project ID.
   *
   * Kept separate from `unavailableReason` because conflating them created a
   * dead end: funding the account is the first thing anyone does, it needs the
   * address, and the address needs no Blockfrost — so hiding it behind that
   * setting left no way to get started.
   */
  chainUnavailableReason?: string;
  /** Pure derivation. Safe to call before anything is configured. */
  loadAccount: () => Promise<CardanoAccountView>;
  /** Storage-only, so it works while locked out of Blockfrost. */
  loadAccounts: () => Promise<readonly CardanoAccountListItem[]>;
  onSelectAccount: (id: string) => Promise<void>;
  /** Next CIP-1852 index of the wallet's phrase. Rejects on a hex-seed wallet. */
  onAddAccount: () => Promise<void>;
  /**
   * Cardano-only account from a separate phrase.
   *
   * Takes the wallet passphrase too: it encrypts the imported phrase at rest,
   * and the TUI holds an unlocked wallet but deliberately not its passphrase,
   * so the screen has to ask for it rather than reuse something it already has.
   */
  onImportAccount: (mnemonic: string, passphrase: string) => Promise<void>;
  onRemoveAccount: (id: string) => Promise<void>;
  /** Send ADA and/or cNIGHT. Amounts in lovelace and whole cNIGHT. */
  onSend: (to: string, lovelace: bigint, cnight: bigint) => Promise<CardanoActionResult>;
  loadStatus: () => Promise<CardanoStatusView>;
  onRegister: (receiver?: string) => Promise<CardanoActionResult>;
  onDeregister: () => Promise<CardanoActionResult>;
  onUpdate: (receiver: string) => Promise<CardanoActionResult>;
  onBack: () => void;
}

type Action = 'register' | 'deregister' | 'update';

type Mode =
  | { kind: 'loading' }
  | { kind: 'accounts' }
  | { kind: 'importPhrase' }
  | { kind: 'importPassphrase'; mnemonic: string }
  | { kind: 'sendTo'; status: CardanoStatusView }
  | { kind: 'sendAda'; status: CardanoStatusView; to: string }
  | { kind: 'sendCnight'; status: CardanoStatusView; to: string; lovelace: bigint }
  | { kind: 'overview'; status: CardanoStatusView }
  | { kind: 'receiver'; action: Extract<Action, 'register' | 'update'>; status: CardanoStatusView }
  | { kind: 'confirm'; action: Action; status: CardanoStatusView; receiver?: string }
  | { kind: 'processing'; action: Action }
  | { kind: 'result'; action: Action; result: CardanoActionResult }
  | { kind: 'error'; message: string };

const ADA_DECIMALS = 6n;

/** STARs per cNIGHT — six decimal places, as NIGHT has on Midnight. */
const STARS_PER_CNIGHT = 1_000_000n;

function formatAda(lovelace: bigint): string {
  const unit = 10n ** ADA_DECIMALS;
  return `${lovelace / unit}.${(lovelace % unit).toString().padStart(Number(ADA_DECIMALS), '0')}`;
}

/** ADA decimal string → lovelace, or null when it is not a plain decimal. */
function parseAdaInput(value: string): bigint | null {
  const text = value.trim();
  if (text === '') return 0n;
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole!) * 10n ** ADA_DECIMALS + BigInt(frac.padEnd(Number(ADA_DECIMALS), '0'));
}

/**
 * cNIGHT as typed → STARs. "10" means ten cNIGHT, never ten STARs: the
 * on-chain quantity is in STARs (10^6 per cNIGHT), Cardano publishes no
 * decimals, and reading it as whole units sends a ten-thousandth of what the
 * user asked for — successfully.
 */
function parseCnightInput(value: string): bigint | null {
  const text = value.trim();
  if (text === '') return 0n;
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole!) * STARS_PER_CNIGHT + BigInt(frac.padEnd(6, '0'));
}

/** STARs → cNIGHT for display, trailing zeros trimmed. */
function formatCnight(stars: bigint): string {
  const whole = stars / STARS_PER_CNIGHT;
  const frac = (stars % STARS_PER_CNIGHT).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Coarse above an hour, precise below — mirrors core's describeCountdown. */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'now';
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function shorten(value: string, head = 12, tail = 8): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function Cardano({
  unavailableReason,
  chainUnavailableReason,
  loadAccount,
  loadAccounts,
  onSelectAccount,
  onSend,
  onAddAccount,
  onImportAccount,
  onRemoveAccount,
  loadStatus,
  onRegister,
  onDeregister,
  onUpdate,
  onBack,
}: CardanoProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  // Loaded separately from the status, and kept even when the status fails:
  // the address is the one thing someone needs before anything works, and it
  // costs nothing to produce.
  const [account, setAccount] = useState<CardanoAccountView | null>(null);
  const [accounts, setAccounts] = useState<readonly CardanoAccountListItem[]>([]);
  const [accountCursor, setAccountCursor] = useState(0);
  const [importInput, setImportInput] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [sendInput, setSendInput] = useState('');
  const [accountError, setAccountError] = useState<string | undefined>();
  const [accountBusy, setAccountBusy] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const [receiverInput, setReceiverInput] = useState('');
  const [receiverError, setReceiverError] = useState<string | undefined>();

  // The loaders arrive as inline arrows, so their identity changes on every
  // render of the parent. Keying effects on them made each run schedule the
  // next one — the screen flickered between "Reading Cardano state..." and the
  // overview forever, and re-queried Blockfrost each time round. Refs give the
  // effects something stable to depend on while still calling the latest
  // function; same pattern as useDaemonHost.
  const loadStatusRef = useRef(loadStatus);
  loadStatusRef.current = loadStatus;
  const loadAccountRef = useRef(loadAccount);
  loadAccountRef.current = loadAccount;
  const loadAccountsRef = useRef(loadAccounts);
  loadAccountsRef.current = loadAccounts;

  const refresh = useCallback(async () => {
    setMode({ kind: 'loading' });
    try {
      setMode({ kind: 'overview', status: await loadStatusRef.current() });
    } catch (err) {
      setMode({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    if (unavailableReason) return;
    let cancelled = false;
    loadAccountRef.current()
      .then(a => { if (!cancelled) setAccount(a); })
      .catch(() => { /* derivation failing is already covered by unavailableReason */ });
    // Storage-only, so it resolves even when nothing else on this screen can.
    loadAccountsRef.current()
      .then(list => { if (!cancelled) setAccounts(list); })
      .catch(() => { if (!cancelled) setAccounts([]); });
    return () => { cancelled = true; };
  }, [unavailableReason]);

  useEffect(() => {
    // Chain reads need Blockfrost; the account above does not. Skipping the
    // status call here is what lets the screen render the address instead of
    // an error someone cannot act on yet.
    if (unavailableReason || chainUnavailableReason) return;
    void refresh();
  }, [refresh, unavailableReason, chainUnavailableReason]);

  // Which actions make sense depends entirely on whether a registration
  // exists: offering "deregister" on an unregistered stake key is an error the
  // user only discovers after a round trip to Blockfrost.
  const actionsFor = (status: CardanoStatusView): { id: Action; label: string; description: string }[] =>
    status.registered
      ? [
          { id: 'update', label: 'Update', description: 'send DUST to a different Midnight address' },
          { id: 'deregister', label: 'Deregister', description: 'stop generating DUST from this cNIGHT' },
        ]
      : [{ id: 'register', label: 'Register', description: 'generate DUST from this cNIGHT' }];

  /** Run an account mutation, then reload the list and the screen under it. */
  const runAccountAction = async (fn: () => Promise<void>) => {
    setAccountBusy(true);
    setAccountError(undefined);
    try {
      await fn();
      setAccounts(await loadAccounts());
      // The active account may have changed, so the address and the status on
      // the screen behind this one are now for the wrong account.
      const next = await loadAccount().catch(() => null);
      if (next) setAccount(next);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccountBusy(false);
    }
  };

  const submitImportPhrase = (value: string) => {
    const phrase = value.trim().replace(/\s+/g, ' ');
    if (phrase.split(' ').length < 12) {
      setAccountError('Expected a 12 or 24 word BIP-39 recovery phrase.');
      return;
    }
    setImportInput('');
    setImportPassphrase('');
    setAccountError(undefined);
    setMode({ kind: 'importPassphrase', mnemonic: phrase });
  };

  const submitImportPassphrase = async (value: string) => {
    if (mode.kind !== 'importPassphrase') return;
    if (!value) {
      setAccountError('The wallet passphrase is required.');
      return;
    }
    const { mnemonic } = mode;
    await runAccountAction(() => onImportAccount(mnemonic, value));
    setImportPassphrase('');
    setMode({ kind: 'accounts' });
  };

  const submitSendTo = (value: string) => {
    if (mode.kind !== 'sendTo') return;
    const to = value.trim();
    // Shape only — core checks the network id, which is the mistake that
    // actually loses funds.
    if (!to.startsWith('addr')) {
      setAccountError('Expected a Cardano address starting with addr.');
      return;
    }
    setSendInput('');
    setAccountError(undefined);
    setMode({ kind: 'sendAda', status: mode.status, to });
  };

  const submitSendAda = (value: string) => {
    if (mode.kind !== 'sendAda') return;
    const lovelace = parseAdaInput(value);
    if (lovelace === null) {
      setAccountError('Enter an ADA amount with at most 6 decimal places, or leave blank.');
      return;
    }
    setSendInput('');
    setAccountError(undefined);
    setMode({ kind: 'sendCnight', status: mode.status, to: mode.to, lovelace });
  };

  const submitSendCnight = async (value: string) => {
    if (mode.kind !== 'sendCnight') return;
    const cnight = parseCnightInput(value);
    if (cnight === null) {
      setAccountError('Enter a cNIGHT amount with at most 6 decimal places, or leave blank.');
      return;
    }
    if (mode.lovelace === 0n && cnight === 0n) {
      setAccountError('Nothing to send — enter an ADA amount, a cNIGHT amount, or both.');
      return;
    }
    const { to, lovelace } = mode;
    setSendInput('');
    setMode({ kind: 'processing', action: 'register' });
    const result = await onSend(to, lovelace, cnight);
    setMode({ kind: 'result', action: 'register', result });
  };

  const submit = async (action: Action, receiver?: string) => {
    setMode({ kind: 'processing', action });
    const result =
      action === 'register'
        ? await onRegister(receiver)
        : action === 'deregister'
          ? await onDeregister()
          : await onUpdate(receiver ?? '');
    setMode({ kind: 'result', action, result });
  };

  const submitReceiver = (raw: string) => {
    const value = raw.trim().replace(/^0x/, '').toLowerCase();
    if (mode.kind !== 'receiver') return;
    if (mode.action === 'register' && value.length === 0) {
      // Empty means "this wallet", which is the common case for register.
      setMode({ kind: 'confirm', action: 'register', status: mode.status });
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(value)) {
      setReceiverError('Expected a Midnight coin public key: 32 bytes of hex (64 characters)');
      return;
    }
    setMode({ kind: 'confirm', action: mode.action, status: mode.status, receiver: value });
  };

  useInput((input, key) => {
    // The account list is reachable from every state, including the ones where
    // nothing else works — switching account is often the fix.
    if (
      mode.kind !== 'accounts'
      && mode.kind !== 'importPhrase'
      && mode.kind !== 'importPassphrase'
      && mode.kind !== 'sendTo'
      && mode.kind !== 'sendAda'
      && mode.kind !== 'sendCnight'
      && input === 'a'
      && !accountBusy
    ) {
      setAccountError(undefined);
      setAccountCursor(Math.max(0, accounts.findIndex(a => a.active)));
      setMode({ kind: 'accounts' });
      return;
    }

    if (mode.kind === 'accounts') {
      if (accountBusy) return;
      if (key.escape) { setMode({ kind: 'loading' }); void refresh(); return; }
      if (key.upArrow) { setAccountCursor(i => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setAccountCursor(i => Math.min(accounts.length - 1, i + 1)); return; }
      if (key.return) {
        const target = accounts[accountCursor];
        if (target && !target.active) void runAccountAction(() => onSelectAccount(target.id));
        return;
      }
      if (input === 'n') { void runAccountAction(onAddAccount); return; }
      if (input === 'i') {
        setImportInput('');
        setAccountError(undefined);
        setMode({ kind: 'importPhrase' });
        return;
      }
      if (input === 'x') {
        const target = accounts[accountCursor];
        if (target && accounts.length > 1) void runAccountAction(() => onRemoveAccount(target.id));
        return;
      }
      return;
    }

    if (mode.kind === 'sendTo' || mode.kind === 'sendAda' || mode.kind === 'sendCnight') {
      if (key.escape) {
        setSendInput('');
        setAccountError(undefined);
        setMode({ kind: 'overview', status: mode.status });
      }
      return; // the text input owns the rest
    }

    if (mode.kind === 'importPhrase' || mode.kind === 'importPassphrase') {
      if (key.escape) {
        // Drop both secrets on cancel rather than leaving them in state for
        // the next time this screen opens.
        setImportInput('');
        setImportPassphrase('');
        setAccountError(undefined);
        setMode({ kind: 'accounts' });
      }
      return; // the text input owns the rest
    }

    if (unavailableReason || chainUnavailableReason) {
      if (key.escape) onBack();
      return;
    }

    if (key.escape) {
      switch (mode.kind) {
        case 'loading':
        case 'overview':
        case 'error':
          onBack();
          return;
        case 'receiver':
        case 'confirm':
          setReceiverError(undefined);
          setMode({ kind: 'overview', status: mode.status });
          return;
        case 'processing':
          // Deliberately not cancellable: the transaction may already be on
          // its way to the node, and a screen that pretends otherwise is worse
          // than one that makes you wait.
          return;
        case 'result':
          void refresh();
          return;
      }
    }

    if (mode.kind === 'error') {
      if (key.return || input === 'r') void refresh();
      return;
    }

    if (mode.kind === 'overview') {
      const actions = actionsFor(mode.status);
      if (input === 'r') { void refresh(); return; }
      if (input === 's') {
        setSendInput('');
        setAccountError(undefined);
        setMode({ kind: 'sendTo', status: mode.status });
        return;
      }
      if (key.upArrow) { setActionIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setActionIndex((i) => Math.min(actions.length - 1, i + 1)); return; }
      if (key.return) {
        const chosen = actions[Math.min(actionIndex, actions.length - 1)];
        if (!chosen) return;
        if (chosen.id === 'deregister') {
          setMode({ kind: 'confirm', action: 'deregister', status: mode.status });
        } else {
          setReceiverInput('');
          setReceiverError(undefined);
          setMode({ kind: 'receiver', action: chosen.id, status: mode.status });
        }
      }
      return;
    }

    if (mode.kind === 'confirm' && key.return) {
      void submit(mode.action, mode.receiver);
      return;
    }

    if (mode.kind === 'result') {
      void refresh();
    }
  });

  // Render ------------------------------------------------------------------

  /**
   * The account block. Shown in every state that has one, including the states
   * where the chain cannot be read — funding this address is the step that
   * comes before everything else on this screen.
   */
  const renderAccount = () => {
    if (!account) return null;
    return (
      <Box flexDirection="column">
        <Text bold>Your Cardano account</Text>
        <Box>
          <Text dimColor>{'Network'.padEnd(14)}</Text>
          <Text>{account.cardanoNetwork}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Address'.padEnd(14)}</Text>
          <Text>{account.address}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Stake addr'.padEnd(14)}</Text>
          <Text>{account.rewardAddress}</Text>
        </Box>
        <Box marginTop={1}>
          {/* The question this answers is "where do I create one?" — nowhere.
              Saying so is cheaper than the support thread. */}
          <Text dimColor>
            Derived from this wallet's recovery phrase (CIP-1852 account 0). There is no
            separate Cardano account to create and nothing extra to back up.
          </Text>
        </Box>
        <Box>
          <Text dimColor>Send ADA and cNIGHT to the address above to get started.</Text>
        </Box>
      </Box>
    );
  };

  const body = () => {
    if (unavailableReason) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">Cardano is not available for this wallet.</Text>
          <Box marginTop={1}><Text dimColor>{unavailableReason}</Text></Box>
        </Box>
      );
    }

    if (chainUnavailableReason) {
      return (
        <Box flexDirection="column">
          {renderAccount()}
          <Box marginTop={1}><Text color="yellow">Cardano balances and registration cannot be read yet.</Text></Box>
          <Box><Text dimColor>{chainUnavailableReason}</Text></Box>
        </Box>
      );
    }

    if (mode.kind === 'accounts') {
      return (
        <Box flexDirection="column">
          <Text bold>Accounts</Text>
          <Box marginTop={1} flexDirection="column">
            {accounts.length === 0 && <Text dimColor>No accounts found.</Text>}
            {accounts.map((a, i) => {
              const hi = i === accountCursor;
              return (
                <Box key={a.id}>
                  <Text color={hi ? 'cyan' : undefined} bold={hi}>
                    {hi ? '\u203a ' : '  '}{a.label.padEnd(20)}
                  </Text>
                  <Text dimColor>
                    {a.kind === 'imported' ? 'imported' : `from phrase, index ${a.accountIndex}`}
                  </Text>
                  {a.active && <Text color="green">{'  \u2190 active'}</Text>}
                </Box>
              );
            })}
          </Box>
          {accountBusy && (
            <Box marginTop={1}>
              <Spinner type="dots" />
              <Text color="yellow"> Working...</Text>
            </Box>
          )}
          {accountError && <Box marginTop={1}><Text color="red">{accountError}</Text></Box>}
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>n — add an account from this wallet's recovery phrase (nothing extra to back up)</Text>
            <Text dimColor>i — import a Cardano-only account from a separate phrase (back that phrase up yourself)</Text>
          </Box>
        </Box>
      );
    }

    if (mode.kind === 'importPhrase') {
      return (
        <Box flexDirection="column">
          <Text bold>Import a Cardano-only account</Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>It will not hold Midnight funds, and this wallet's recovery</Text>
            <Text dimColor>phrase does NOT restore it — keep that phrase safe yourself.</Text>
          </Box>
          <Box marginTop={1}>
            <Text>{'\u203a '}</Text>
            {/* Masked: a TUI sits in a terminal that may be shared or recorded. */}
            <TextInput
              value={importInput}
              mask="*"
              onChange={(v) => { setImportInput(v); setAccountError(undefined); }}
              onSubmit={submitImportPhrase}
            />
          </Box>
          {accountBusy && (
            <Box marginTop={1}>
              <Spinner type="dots" />
              <Text color="yellow"> Importing...</Text>
            </Box>
          )}
          {accountError && <Box marginTop={1}><Text color="red">{accountError}</Text></Box>}
        </Box>
      );
    }

    if (mode.kind === 'sendTo' || mode.kind === 'sendAda' || mode.kind === 'sendCnight') {
      const prompt =
        mode.kind === 'sendTo'
          ? 'Destination Cardano address'
          : mode.kind === 'sendAda'
            ? `ADA to send (available ${formatAda(mode.status.lovelace)}) — blank for none`
            : `cNIGHT to send (available ${formatCnight(mode.status.cnight)}) — blank for none`;
      const onSubmit =
        mode.kind === 'sendTo'
          ? submitSendTo
          : mode.kind === 'sendAda'
            ? submitSendAda
            : submitSendCnight;
      return (
        <Box flexDirection="column">
          <Text bold>Send on Cardano</Text>
          {mode.kind !== 'sendTo' && (
            <Box>
              <Text dimColor>{'To  '}</Text>
              <Text>{shorten(mode.to, 20, 10)}</Text>
            </Box>
          )}
          <Box marginTop={1}><Text>{prompt}</Text></Box>
          <Box>
            <Text>{'\u203a '}</Text>
            <TextInput
              value={sendInput}
              onChange={(v) => { setSendInput(v); setAccountError(undefined); }}
              onSubmit={onSubmit}
            />
          </Box>
          {mode.kind === 'sendCnight' && mode.status.registered && (
            <Box marginTop={1}>
              <Text color="yellow">
                This account is registered for DUST — cNIGHT you send stops generating.
              </Text>
            </Box>
          )}
          {accountError && <Box marginTop={1}><Text color="red">{accountError}</Text></Box>}
        </Box>
      );
    }

    if (mode.kind === 'importPassphrase') {
      return (
        <Box flexDirection="column">
          <Text bold>Wallet passphrase</Text>
          <Box marginTop={1}>
            <Text dimColor>Encrypts the imported phrase on this machine.</Text>
          </Box>
          <Box marginTop={1}>
            <Text>{'\u203a '}</Text>
            <TextInput
              value={importPassphrase}
              mask="*"
              onChange={(v) => { setImportPassphrase(v); setAccountError(undefined); }}
              onSubmit={submitImportPassphrase}
            />
          </Box>
          {accountBusy && (
            <Box marginTop={1}>
              <Spinner type="dots" />
              <Text color="yellow"> Importing...</Text>
            </Box>
          )}
          {accountError && <Box marginTop={1}><Text color="red">{accountError}</Text></Box>}
        </Box>
      );
    }

    switch (mode.kind) {
      case 'loading':
        return (
          <Box>
            <Spinner type="dots" />
            <Text color="yellow"> Reading Cardano state...</Text>
          </Box>
        );

      case 'error':
        return (
          <Box flexDirection="column">
            <Text color="red">{mode.message}</Text>
            <Box marginTop={1}><Text dimColor>Press r or Enter to retry.</Text></Box>
          </Box>
        );

      case 'overview': {
        const s = mode.status;
        const actions = actionsFor(s);
        return (
          <Box flexDirection="column">
            <Box flexDirection="column">
              <Box>
                <Text dimColor>{'Address'.padEnd(14)}</Text>
                <Text>{s.address}</Text>
              </Box>
              <Box>
                <Text dimColor>{'Stake addr'.padEnd(14)}</Text>
                <Text>{s.rewardAddress}</Text>
              </Box>
              <Box>
                <Text dimColor>{'ADA'.padEnd(14)}</Text>
                <Text>{formatAda(s.lovelace)}</Text>
              </Box>
              <Box>
                <Text dimColor>{'cNIGHT'.padEnd(14)}</Text>
                <Text bold>{formatCnight(s.cnight)}</Text>
                <Text dimColor>{`  (${s.cnightUtxos} UTXO${s.cnightUtxos === 1 ? '' : 's'})`}</Text>
              </Box>
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text dimColor>{'DUST status'.padEnd(14)}</Text>
                {s.registered ? (
                  <Text color={s.registeredToThisWallet ? 'green' : 'yellow'}>
                    {s.registeredToThisWallet ? 'registered' : 'registered to ANOTHER wallet'}
                  </Text>
                ) : (
                  <Text dimColor>not registered</Text>
                )}
              </Box>
              {s.registered && s.registeredCoinPublicKey && (
                <Box>
                  <Text dimColor>{'DUST to'.padEnd(14)}</Text>
                  <Text>{shorten(s.registeredCoinPublicKey, 16, 8)}</Text>
                </Box>
              )}
              <Box>
                <Text dimColor>{'Generating'.padEnd(14)}</Text>
                {/* A reported rate of exactly "0" is the indexer saying it has
                    credited nothing yet, not a real rate — DUST accrues from
                    registration, so a bare 0 reads as broken. */}
                {s.generationRate && s.generationRate !== '0' ? (
                  <Text>{s.generationRate}</Text>
                ) : (
                  <Text dimColor>accruing since registration</Text>
                )}
              </Box>
              {s.registered && (
                <Box>
                  <Text dimColor>{'Usable'.padEnd(14)}</Text>
                  {/* Unknown is its own state: null means the registration is
                      not in a block yet, which must not read as "now". */}
                  {s.secondsRemaining === null ? (
                    <Text dimColor>waiting for confirmation</Text>
                  ) : s.secondsRemaining > 0 ? (
                    <Text color="yellow">{`in about ${formatCountdown(s.secondsRemaining)}`}</Text>
                  ) : (
                    <Text color="green">now</Text>
                  )}
                </Box>
              )}
            </Box>

            {s.cnight === 0n && (
              <Box marginTop={1}>
                <Text color="yellow">No cNIGHT held — registration needs at least one cNIGHT UTXO.</Text>
              </Box>
            )}

            <Box marginTop={1} flexDirection="column">
              <Text bold>Actions</Text>
              {actions.map((a, i) => {
                const hi = i === Math.min(actionIndex, actions.length - 1);
                return (
                  <Box key={a.id}>
                    <Text color={hi ? 'cyan' : undefined} bold={hi}>
                      {hi ? '› ' : '  '}{a.label.padEnd(12)}
                    </Text>
                    <Text dimColor>{a.description}</Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        );
      }

      case 'receiver':
        return (
          <Box flexDirection="column">
            <Text bold>
              {mode.action === 'register'
                ? 'Midnight coin public key to generate DUST to'
                : 'New Midnight coin public key'}
            </Text>
            {mode.action === 'register' && (
              <Text dimColor>Leave blank to use this wallet.</Text>
            )}
            <Box marginTop={1}>
              <Text>{'› '}</Text>
              <TextInput
                value={receiverInput}
                onChange={(v) => { setReceiverInput(v); setReceiverError(undefined); }}
                onSubmit={submitReceiver}
              />
            </Box>
            {receiverError && <Box marginTop={1}><Text color="red">{receiverError}</Text></Box>}
          </Box>
        );

      case 'confirm': {
        const s = mode.status;
        return (
          <Box flexDirection="column">
            <Text bold>Confirm</Text>
            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text dimColor>{'Action'.padEnd(14)}</Text>
                <Text>{mode.action}</Text>
              </Box>
              <Box>
                <Text dimColor>{'Cardano net'.padEnd(14)}</Text>
                <Text>{s.cardanoNetwork}</Text>
              </Box>
              <Box>
                <Text dimColor>{'DUST to'.padEnd(14)}</Text>
                <Text>{mode.receiver ? shorten(mode.receiver, 16, 8) : 'this wallet'}</Text>
              </Box>
              <Box>
                <Text dimColor>{'cNIGHT moved'.padEnd(14)}</Text>
                <Text>{`${formatCnight(s.cnight)} across ${s.cnightUtxos} UTXO${s.cnightUtxos === 1 ? '' : 's'}`}</Text>
              </Box>
            </Box>
            <Box marginTop={1}>
              {/* Spending every cNIGHT UTXO is what makes the change take
                  effect immediately. It looks alarming in a wallet, so it is
                  stated here rather than discovered in a block explorer. */}
              <Text dimColor>
                Every cNIGHT UTXO is spent back to this address, which is what applies the change.
              </Text>
            </Box>
          </Box>
        );
      }

      case 'processing':
        return (
          <Box>
            <Spinner type="dots" />
            <Text color="yellow">{` Submitting ${mode.action} to Cardano...`}</Text>
          </Box>
        );

      case 'result':
        return mode.result.success ? (
          <Box flexDirection="column">
            <Text color="green">{`Cardano ${mode.action} submitted.`}</Text>
            <Box marginTop={1}>
              <Text dimColor>{'Tx  '}</Text>
              <Text>{mode.result.txHash}</Text>
            </Box>
            {mode.action !== 'deregister' && (
              <Box marginTop={1}>
                <Text dimColor>DUST generation starts once the Midnight indexer observes it.</Text>
              </Box>
            )}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color="red">{`Cardano ${mode.action} failed.`}</Text>
            <Box marginTop={1}><Text>{mode.result.error}</Text></Box>
          </Box>
        );
    }
  };

  const hints = (): HelpHint[] => {
    if (unavailableReason) return [{ key: 'esc', label: 'back' }];
    // Reachable even here: switching to a working account is often the fix.
    if (chainUnavailableReason) return [{ key: 'a', label: 'accounts' }, { key: 'esc', label: 'back' }];
    if (mode.kind === 'accounts') {
      return [
        { key: '↑↓', label: 'select' },
        { key: 'enter', label: 'switch to' },
        { key: 'n', label: 'add' },
        { key: 'i', label: 'import' },
        ...(accounts.length > 1 ? [{ key: 'x', label: 'remove' }] : []),
        { key: 'esc', label: 'back' },
      ];
    }
    if (mode.kind === 'sendTo' || mode.kind === 'sendAda' || mode.kind === 'sendCnight') {
      return [
        { key: 'enter', label: mode.kind === 'sendCnight' ? 'send' : 'continue' },
        { key: 'esc', label: 'cancel' },
      ];
    }
    if (mode.kind === 'importPhrase') {
      return [{ key: 'enter', label: 'continue' }, { key: 'esc', label: 'cancel' }];
    }
    if (mode.kind === 'importPassphrase') {
      return [{ key: 'enter', label: 'import' }, { key: 'esc', label: 'cancel' }];
    }
    switch (mode.kind) {
      case 'overview':
        return [
          { key: '↑↓', label: 'select' },
          { key: 'enter', label: 'run' },
          { key: 's', label: 'send' },
          { key: 'a', label: 'accounts' },
          { key: 'r', label: 'refresh' },
          { key: 'esc', label: 'back' },
        ];
      case 'receiver':
        return [{ key: 'enter', label: 'continue' }, { key: 'esc', label: 'cancel' }];
      case 'confirm':
        return [{ key: 'enter', label: 'submit' }, { key: 'esc', label: 'cancel' }];
      case 'processing':
        return [];
      case 'result':
        return [{ key: 'any', label: 'back to overview' }];
      case 'error':
        return [{ key: 'r', label: 'retry' }, { key: 'esc', label: 'back' }];
      default:
        return [{ key: 'esc', label: 'back' }];
    }
  };

  return (
    <Box flexDirection="column" paddingX={2}>
      <SectionHeader
        title="Cardano · cNIGHT"
        hint={accounts.find(a => a.active)?.label ?? 'DUST designation'}
      />
      {body()}
      <HelpFooter hints={hints()} />
    </Box>
  );
}
