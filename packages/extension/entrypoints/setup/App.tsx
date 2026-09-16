// Full-tab setup flow (section 02 of the design + setup-network template):
// create:  3b Phrase backup (1 of 3) → Network (2 of 3) → 8a Password (3 of 3) → 3c Done
// import:  4d Words (1 of 3) → Network (2 of 3) → 8a Password (3 of 3) → 3c Done
//
// The 3a Welcome screen (create-vs-import) only renders when the tab is
// opened without a ?mode — the panel button that opened the tab already made
// that choice. Back from step 1 still returns to it, so the mode can be
// switched without reopening the tab.
//
// Create shows the phrase first: the words are generated up front (nothing is
// persisted yet) so the user can back them up, then the wallet is created from
// that same phrase once they've chosen a network and set a password.
//
// The network choice (with optional custom endpoints) applies to the account
// being created — networks are per-account, and existing accounts keep theirs.
// It's also saved as the wallet-wide selection, which the new account
// immediately embodies: it unlocks as the active account right after, and
// unlocking any other account re-aligns the selection to that account.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, Globe, TriangleAlert } from 'lucide-react';
import { browser } from 'wxt/browser';
// Subpath import (not the moth-browser barrel): mnemonic generation is pure JS
// (@scure BIP-39), so it stays out of the ledger WASM the barrel would drag in —
// generating the phrase in-page keeps "Create" instant.
import { generateMnemonic24 } from '@shieldedtech/moth-wallet/wallet/mnemonic';
// Same reason, same subpath rule: the seed shape-check is pure string work, so
// validating as the user pastes must not drag the ledger WASM into this tab.
import { checkHexSeed, type HexSeedCheck } from '@shieldedtech/moth-wallet/wallet/hex-seed';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import { holdSetupPort } from '../../lib/ui/setup-port';
import { DEFAULT_SETTINGS } from '../../lib/background/settings';
import { copySecret } from '../../lib/ui/clipboard';
import { formatSeedPhrase, splitSeedPhrase } from '../../lib/ui/seed-phrase';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Crescent, OrbitingMoth } from '../../components/moth/panel';
import { nativeAssetLabelsForNetwork } from '../../lib/ui/token-labels';
import { NoteCard } from '../../components/moth/note-card';
import { WordChipGrid, WordInputGrid } from '../../components/moth/words';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { useNetworkConfig, NetworkFields, type SupportedNetwork } from '../../components/screens/NetworkConfig';

type Mode = 'create' | 'import';
/** Which backup artifact the person restoring is holding. */
type ImportKind = 'phrase' | 'seed';
type Step = 'welcome' | 'words' | 'password' | 'network' | 'phrase' | 'done';

// Step CTAs are ink pills in light; on dark surfaces that reads muted for the
// screen's one primary action, so dark swaps them to full Moonlime.
const STEP_CTA = 'dark:bg-primary dark:text-primary-foreground';

export function App() {
  // The panel already asked create-vs-import (GetStarted's buttons, the
  // account switcher's "new account"), so an explicit ?mode skips the 3a
  // Welcome choice and lands on that flow's first step. Welcome still shows
  // for a bare /setup.html, and Back from step 1 returns to it.
  const modeParam = new URLSearchParams(window.location.search).get('mode');
  const initialMode: Mode | null = modeParam === 'create' || modeParam === 'import' ? modeParam : null;
  const [mode, setMode] = useState<Mode>(initialMode ?? 'create');
  const [step, setStep] = useState<Step>(initialMode === 'create' ? 'phrase' : initialMode === 'import' ? 'words' : 'welcome');
  const [words, setWords] = useState<string[]>(Array(24).fill(''));
  // A wallet created from a raw hex seed has no mnemonic and cannot be given
  // one (BIP-39's phrase-to-seed step is one-way), so restoring it needs a
  // second input, not a cleverer parse of the word grid.
  const [importKind, setImportKind] = useState<ImportKind>('phrase');
  const [seedInput, setSeedInput] = useState('');
  const seedCheck = checkHexSeed(seedInput);
  // Matches DEFAULT_SETTINGS: never start an account on a value-bearing network.
  const [network, setNetwork] = useState<SupportedNetwork>('preprod');
  const [mnemonic, setMnemonic] = useState(() => (initialMode === 'create' ? generateMnemonic24() : ''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasWallets, setHasWallets] = useState(false);
  // User-chosen display label for the new account (free-form; empty falls back
  // to the auto-assigned "Account N"). Stored as the wallet's label — the
  // storage name stays the immutable "Account-N" key.
  const [accountName, setAccountName] = useState('');
  const [walletCount, setWalletCount] = useState(0);
  // Held open so the side panel shows its "finish setup in the tab" screen for
  // the whole flow. Released only once setup is fully complete (the Done step,
  // or tab close) so the panel flips to the new account after the phrase backup
  // is done — not while the secret phrase is still on screen.
  const releaseSetupPort = useRef<(() => void) | null>(null);

  useEffect(() => {
    void sendMessage('walletList', undefined).then((wallets) => {
      setHasWallets(wallets.length > 0);
      setWalletCount(wallets.length);
    });
    const release = holdSetupPort();
    releaseSetupPort.current = release;
    return () => {
      if (releaseSetupPort.current === release) releaseSetupPort.current = null;
      release();
    };
  }, []);

  // Setup is done: release the port so the panel flips to the new account.
  const finish = () => {
    const release = releaseSetupPort.current;
    releaseSetupPort.current = null;
    release?.();
  };

  // Begin a create: generate the phrase to show before we ask for anything.
  // It's pure-JS and instant, so no loading state — nothing is persisted yet;
  // walletCreate later stores this same phrase.
  const startCreate = () => {
    setMode('create');
    setError('');
    setMnemonic(generateMnemonic24());
    setStep('phrase');
  };

  const finishSetup = async (passphrase: string, network: SupportedNetwork) => {
    setBusy(true);
    setError('');
    try {
      // The storage name keys the keystore and must match [a-zA-Z0-9_-]+, so it
      // stays the auto-assigned "Account-N". The user's chosen name is applied
      // as the wallet's free-form label (rendered everywhere via accountLabel).
      const existing = await sendMessage('walletList', undefined);
      const taken = new Set(existing.map((wallet) => wallet.name));
      let index = existing.length + 1;
      while (taken.has(`Account-${index}`)) index += 1;
      const storageName = `Account-${index}`;
      const label = accountName.trim();
      if (mode === 'create') {
        // Persist the phrase the user already backed up on the phrase step.
        await sendMessage('walletCreate', { name: storageName, passphrase, network, mnemonic });
      } else {
        await sendMessage(
          'walletImport',
          importKind === 'seed'
            ? { name: storageName, seed: seedInput.trim(), passphrase, network }
            : { name: storageName, mnemonic: words.join(' ').trim(), passphrase, network },
        );
      }
      // Set the label before unlocking so the session picks it up immediately.
      if (label) await sendMessage('walletRename', { name: storageName, label });
      await sendMessage('sessionUnlock', { name: storageName, passphrase });
      finish();
      setStep('done');
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      // Surface the failure on the password step, which renders the error.
      setStep('password');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'welcome') {
    return (
      <Welcome
        onCreate={startCreate}
        onImport={() => {
          setMode('import');
          setError('');
          setStep('words');
        }}
      />
    );
  }

  if (step === 'words') {
    const incomplete = importKind === 'seed' ? !seedCheck.ok : words.some((w) => !w);
    return (
      <Shell progress={{ current: 1, total: 3 }} onBack={() => setStep('welcome')}>
        <h1 className="m-0 font-display text-[38px] font-extrabold">{t('setup_importTitle')}</h1>
        <p className="mt-2 text-[16.5px] text-muted-foreground">
          {importKind === 'seed' ? t('setup_importSeedSubtitle') : t('setup_importSubtitle')}
        </p>
        {/* Both methods on one screen rather than a "which do you have?" step
            first: anyone restoring already knows which artifact they hold, so
            that step would cost a click and gather nothing. */}
        <div className="pt-6">
          <Tabs value={importKind} onValueChange={(v) => { setImportKind(v as ImportKind); setError(''); }}>
            <TabsList>
              <TabsTrigger value="phrase">{t('setup_importKindPhrase')}</TabsTrigger>
              <TabsTrigger value="seed">{t('setup_importKindSeed')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {importKind === 'seed' ? (
          <div className="flex flex-col gap-2 pt-6">
            {/* Deliberately NOT a password field. A seed has no checksum, so
                reading it back against a backup is the only way to catch a
                bad paste — masking it removes the one available check. */}
            <textarea
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              rows={3}
              aria-label={t('setup_importSeedLabel')}
              placeholder={t('setup_importSeedPlaceholder')}
              className="w-full resize-none break-all rounded-xl border border-border bg-card px-3 py-2.5 font-mono text-[13px] outline-none focus:border-ring"
            />
            <SeedFieldNote check={seedCheck} touched={seedInput.trim().length > 0} />
          </div>
        ) : (
          <>
            <div className="pt-6">
              <WordInputGrid words={words} onChange={setWords} />
            </div>
            <button
              onClick={() =>
                void navigator.clipboard.readText().then((text) => {
                  const parts = splitSeedPhrase(text).slice(0, 24);
                  setWords([...parts, ...Array(Math.max(0, 24 - parts.length)).fill('')]);
                })
              }
              className="mt-3 cursor-pointer self-start border-0 bg-transparent p-0 text-sm font-semibold text-link"
            >
              {t('setup_pastePhrase')}
            </button>
          </>
        )}
        {error && <p className="m-0 pt-2 text-sm text-destructive">{error}</p>}
        <div className="flex justify-end pt-8">
          <Button variant="secondary" size="lg" className={STEP_CTA} disabled={incomplete} onClick={() => setStep('network')}>
            {t('setup_continue')}
          </Button>
        </div>
      </Shell>
    );
  }

  if (step === 'phrase') {
    return (
      <PhraseStep
        progress={{ current: 1, total: 3 }}
        onBack={() => setStep('welcome')}
        mnemonic={mnemonic}
        onDone={() => setStep('network')}
      />
    );
  }

  if (step === 'network') {
    return (
      <NetworkStep
        progress={{ current: 2, total: 3 }}
        busy={busy}
        firstRun={!hasWallets}
        onBack={() => setStep(mode === 'create' ? 'phrase' : 'words')}
        onContinue={(chosen) => {
          setNetwork(chosen);
          setStep('password');
        }}
      />
    );
  }

  if (step === 'password') {
    return (
      <PasswordStep
        progress={{ current: 3, total: 3 }}
        busy={busy}
        error={error}
        name={accountName}
        onNameChange={setAccountName}
        defaultName={`Account ${walletCount + 1}`}
        recoveredBy={mode === 'import' && importKind === 'seed' ? 'seed' : 'phrase'}
        onBack={() => setStep('network')}
        onSubmit={(value) => {
          void finishSetup(value, network);
        }}
      />
    );
  }

  return <Done />;
}

function Welcome({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div className="ink flex min-h-screen flex-col bg-background text-foreground">
      <div className="px-10 pt-8">
        <span className="font-display text-[17px] font-bold text-primary">MOTH</span>
      </div>
      <div className="mx-auto flex w-full max-w-[1040px] flex-1 items-center gap-16 px-10">
        <div className="flex max-w-[520px] flex-col items-start gap-6">
          <h1 className="m-0 font-display text-[72px] font-extrabold leading-[1.02]">
            {t('setup_taglineLine1')}
            <br />
            {t('setup_taglineLine2')}
          </h1>
          <p className="m-0 text-lg text-muted-foreground">
            {t('setup_intro', [nativeAssetLabelsForNetwork(DEFAULT_SETTINGS.network).night])}
          </p>
          <div className="flex gap-3 pt-2">
            <Button size="lg" onClick={onCreate}>{t('setup_createWallet')}</Button>
            <Button variant="outline" size="lg" className="border-white/40 text-foreground" onClick={onImport}>
              {t('setup_alreadyHaveOne')}
            </Button>
          </div>
          <p className="m-0 text-[12.5px] text-muted-foreground">
            {t('setup_freeToCreate')} {t('setup_devNote')}
          </p>
        </div>
        <div className="hidden flex-1 justify-center md:flex">
          <OrbitingMoth size={360} crescentSize={190} />
        </div>
      </div>
    </div>
  );
}

function Shell({
  children,
  progress,
  onBack,
}: {
  children: React.ReactNode;
  progress: { current: number; total: number };
  onBack?: () => void;
}) {
  const pct = (progress.current / progress.total) * 100;
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="flex items-center justify-between px-10 pt-8">
        <span className="font-display text-[17px] font-bold">MOTH</span>
        <div className="flex items-center gap-3">
          <div className="h-1.5 w-[200px] overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[12.5px] text-muted-foreground">
            {t('setup_stepProgress', [progress.current, progress.total])}
          </span>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[600px] flex-1 flex-col justify-center px-6 py-12">
        {onBack && (
          <button
            onClick={onBack}
            className="mb-6 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-0 bg-muted"
            aria-label={t('common_back')}
          >
            <ArrowLeft size={16} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function PasswordStep({
  progress,
  busy,
  error,
  name,
  onNameChange,
  defaultName,
  recoveredBy,
  onBack,
  onSubmit,
}: {
  progress: { current: number; total: number };
  busy: boolean;
  error: string;
  name: string;
  onNameChange: (value: string) => void;
  /** Placeholder showing the auto-assigned name used when left blank. */
  defaultName: string;
  /**
   * Which artifact CAN recover this account, for the subtitle. The password
   * never can, and saying "only your 24 words can" to someone who restored
   * from a hex seed points them at a phrase that does not exist for them.
   */
  recoveredBy: 'phrase' | 'seed';
  onBack: () => void;
  onSubmit: (passphrase: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = password.length >= 8 && confirm === password;

  return (
    <Shell progress={progress} onBack={onBack}>
      <h1 className="m-0 font-display text-[38px] font-extrabold">{t('setup_passwordTitle')}</h1>
      <p className="mt-2 text-[16.5px] text-muted-foreground">
        {recoveredBy === 'seed' ? t('setup_passwordSubtitleSeed') : t('setup_passwordSubtitle')}
      </p>
      <div className="flex max-w-[420px] flex-col gap-4 pt-6">
        <div>
          <label htmlFor="setup-name" className="mb-1.5 block text-[13px] text-muted-foreground">
            {t('setup_accountNameLabel')}
          </label>
          <Input
            id="setup-name"
            value={name}
            maxLength={30}
            placeholder={defaultName}
            onChange={(e) => onNameChange(e.target.value)}
          />
          <p className="m-0 mt-1.5 text-[12.5px] text-muted-foreground">
            {t('setup_accountNameHint')}
          </p>
        </div>
        <div>
          <label htmlFor="setup-password" className="mb-1.5 block text-[13px] text-muted-foreground">
            {t('setup_passwordLabel')}
          </label>
          <div className="relative">
            <Input
              id="setup-password"
              type={show ? 'text' : 'password'}
              value={password}
              invalid={tooShort}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-16"
            />
            <button
              onClick={() => setShow(!show)}
              className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer border-0 bg-transparent text-[13px] text-muted-foreground"
            >
              {show ? t('setup_hide') : t('setup_show')}
            </button>
          </div>
          <p className={`m-0 mt-1.5 text-[12.5px] ${tooShort ? 'text-destructive' : 'text-muted-foreground'}`}>
            {t('setup_passwordHint')}
          </p>
        </div>
        <div>
          <label htmlFor="setup-confirm" className="mb-1.5 block text-[13px] text-muted-foreground">
            {t('setup_confirmPasswordLabel')}
          </label>
          <div className="relative">
            <Input
              id="setup-confirm"
              type="password"
              value={confirm}
              invalid={mismatch}
              onChange={(e) => setConfirm(e.target.value)}
              className="pr-10"
            />
            {confirm.length > 0 && !mismatch && (
              <Check size={16} strokeWidth={2.5} className="absolute right-4 top-1/2 -translate-y-1/2 text-success" />
            )}
          </div>
          {mismatch && <p className="m-0 mt-1.5 text-[12.5px] text-destructive">{t('setup_passwordMismatch')}</p>}
        </div>
        {error && <p className="m-0 text-sm text-destructive">{error}</p>}
        <div className="flex justify-end pt-4">
          <Button variant="secondary" size="lg" className={STEP_CTA} disabled={!valid} loading={busy} onClick={() => onSubmit(password)}>
            {busy ? t('setup_settingUp') : t('setup_continue')}
          </Button>
        </div>
      </div>
    </Shell>
  );
}

// Choose a network (design template setup-network), rendered in the full-tab
// setup Shell like every other step. The named network list is shared with
// Settings → Network (see NetworkConfig); only SUPPORTED_NETWORKS are offered,
// and mainnet among those only with developer mode on. This step defaults to
// preprod, the network with a bundled pre-seed reference. The choice
// becomes the NEW account's network — existing accounts keep theirs. It is
// also saved as the default selection for the new account flow.

function NetworkStep({
  progress,
  busy,
  firstRun,
  onBack,
  onContinue,
}: {
  progress: { current: number; total: number };
  busy: boolean;
  firstRun: boolean;
  onBack: () => void;
  onContinue: (network: SupportedNetwork) => void | Promise<void>;
}) {
  const net = useNetworkConfig();
  const [saving, setSaving] = useState(false);
  const working = saving || busy;

  const save = async () => {
    setSaving(true);
    try {
      await net.save();
      await onContinue(net.network);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Shell progress={progress} onBack={onBack}>
      <h1 className="m-0 font-display text-[38px] font-extrabold">{t('setup_networkTitle')}</h1>
      <p className="mt-2 text-[16.5px] text-muted-foreground">
        {firstRun ? t('setup_networkFirstRun') : t('setup_networkNewAccount')}
      </p>
      <div className="flex max-w-[520px] flex-col gap-5 pt-6">
        <NetworkFields state={net} />
        <NoteCard variant="neutral" icon={Globe}>
          {t('setup_networkNote')}
        </NoteCard>
        <div className="flex justify-end pt-2">
          <Button variant="secondary" size="lg" className={STEP_CTA} disabled={!net.valid} loading={working} onClick={() => void save()}>
            {working ? t('setup_settingUp') : t('setup_continue')}
          </Button>
        </div>
      </div>
    </Shell>
  );
}

function PhraseStep({
  mnemonic,
  onDone,
  progress,
  onBack,
}: {
  mnemonic: string;
  onDone: () => void;
  progress: { current: number; total: number };
  onBack: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = useMemo(() => mnemonic.split(' '), [mnemonic]);

  // Copies the 24 words space-separated and nothing else — no positions, which
  // is what hand-selecting the grid used to produce. That form is what every
  // wallet's import field expects, this one included.
  const copy = async () => {
    await copySecret(formatSeedPhrase(words));
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <Shell progress={progress} onBack={onBack}>
      <h1 className="m-0 font-display text-[38px] font-extrabold">{t('setup_phraseTitle')}</h1>
      <p className="mt-2 text-[16.5px] text-muted-foreground">
        {t('setup_phraseSubtitle')}
      </p>
      <div className="pt-6">
        <WordChipGrid words={words} />
      </div>
      <button
        onClick={() => void copy()}
        className="mt-3 flex cursor-pointer items-center gap-1.5 self-start border-0 bg-transparent p-0 text-sm font-semibold text-link"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? t('setup_copyPhraseDone') : t('setup_copyPhrase')}
      </button>
      <div className="pt-4">
        <NoteCard icon={TriangleAlert}>
          {t('setup_phraseWarning')}
        </NoteCard>
      </div>
      <div className="flex items-center justify-between pt-5">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="h-[18px] w-[18px] accent-secondary dark:accent-primary"
          />
          {t('setup_phraseSavedCheckbox')}
        </label>
        <Button variant="secondary" size="lg" className={STEP_CTA} disabled={!saved} onClick={onDone}>
          {t('setup_continue')}
        </Button>
      </div>
    </Shell>
  );
}

function Done() {
  // Opening the side panel needs a user gesture, so it happens on this click.
  const closeTab = async () => {
    try {
      const current = await browser.windows.getCurrent();
      await (browser as any).sidePanel?.open?.({ windowId: current.id });
    } catch {
      /* user can open it from the toolbar */
    }
    window.close();
  };

  return (
    <div className="ink flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-6 text-center text-foreground">
      <OrbitingMoth size={200} crescentSize={104} />
      <h1 className="m-0 font-display text-[56px] font-extrabold">{t('setup_doneTitle')}</h1>
      <p className="m-0 text-lg text-muted-foreground">
        {t('setup_doneLine1')}
        <br />
        {t('setup_doneLine2')}
      </p>
      <div className="pt-2">
        <Button variant="outline" size="lg" className="border-white/40 text-foreground" onClick={() => void closeTab()}>
          {t('setup_closeTab')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Inline feedback under the seed field.
 *
 * The standing note is the important one, and it shows whenever seed mode is
 * open rather than only on error: a hex seed carries no checksum, so there is
 * no wrong-seed error to wait for. A single altered character restores a
 * different, valid, empty wallet and reports nothing. Shape problems are all
 * that can be detected, and an unusual-but-valid length is the likeliest sign
 * of a truncated paste — worth flagging, not worth refusing, since a wallet
 * genuinely created at that length must stay recoverable.
 */
function SeedFieldNote({check, touched}: {check: HexSeedCheck; touched: boolean}) {
  if (touched && !check.ok && check.problem !== 'empty') {
    return <p className="m-0 text-[12.5px] text-destructive">{seedProblemText(check)}</p>;
  }
  return (
    <>
      {check.ok && check.unusualLength && (
        <p className="m-0 text-[12.5px] text-destructive">
          {t('setup_importSeedUnusualLength', [String(check.bytes)])}
        </p>
      )}
      <p className="m-0 text-[12.5px] text-muted-foreground">{t('setup_importSeedNoChecksum')}</p>
    </>
  );
}

function seedProblemText(check: HexSeedCheck): string {
  switch (check.problem) {
    case 'not-hex':
      return t('setup_importSeedErrNotHex');
    case 'odd-length':
      return t('setup_importSeedErrOddLength');
    case 'too-short':
      return t('setup_importSeedErrTooShort', [String(check.bytes)]);
    case 'too-long':
      return t('setup_importSeedErrTooLong', [String(check.bytes)]);
    default:
      return '';
  }
}
