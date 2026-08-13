// 2l Accounts (mapped onto named wallets) + 8e Remove dialog + Rename dialog.
// Renaming sets a display label on the wallet's metadata — the storage name
// (keystore/sync-cache key) never changes. Switching account locks first
// (each account has its own password).

import { useState } from 'react';
import { Check, Copy, Ellipsis, Globe, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { WalletInfo } from '@shieldedtech/moth-browser';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import { accountLabel } from '../../lib/ui/format';
import { Button } from '../ui/button';
import { Card, Separator } from '../ui/card';
import { DialogShell } from '../ui/dialog';
import { Input } from '../ui/input';
import { NoteCard } from '../moth/note-card';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { truncateAddress } from '../moth/token';
import { WordChipGrid } from '../moth/words';
import { copySecret } from '../../lib/ui/clipboard';
import { formatSeedPhrase } from '../../lib/ui/seed-phrase';
import { networkLabel } from './NetworkConfig';

const AVATAR_BG = [
  'bg-primary text-primary-foreground',
  'bg-secondary text-secondary-foreground dark:text-primary',
  'bg-muted',
];

export function Accounts({
  wallets,
  activeName,
  onBack,
  onChanged,
  onRenamed,
  onSwitched,
  onNewAccount,
}: {
  wallets: WalletInfo[];
  activeName: string;
  onBack: () => void;
  onChanged: () => Promise<void>;
  /** Refresh account/session metadata after a rename (stays on this screen). */
  onRenamed: () => Promise<void>;
  /** Request switching to another account — the shell prompts for its password
   *  with the current session still active until that unlock succeeds. */
  onSwitched: (name: string) => void;
  onNewAccount: () => void;
}) {
  const [removing, setRemoving] = useState<WalletInfo | null>(null);
  const [renaming, setRenaming] = useState<WalletInfo | null>(null);
  const [revealing, setRevealing] = useState<WalletInfo | null>(null);

  // Requesting a switch does NOT lock the current account: it asks the shell to
  // prompt for the target's password with the current session still alive
  // underneath, so cancelling the prompt leaves the user where they were. The
  // active flag and session only change once that unlock succeeds.
  const switchTo = (wallet: WalletInfo) => {
    if (wallet.name === activeName) return;
    onSwitched(wallet.name);
  };

  const remove = async (wallet: WalletInfo) => {
    await sendMessage('walletRemove', { name: wallet.name });
    setRemoving(null);
    await onChanged();
  };

  const rename = async (wallet: WalletInfo, label: string) => {
    await sendMessage('walletRename', { name: wallet.name, label });
    setRenaming(null);
    await onRenamed();
  };

  return (
    <PanelScreen cta={<Button size="lg" onClick={onNewAccount}>{t('accounts_newAccount')}</Button>}>
      <PanelHeader title={t('accounts_title')} onBack={onBack} />
      <p className="m-0 text-[13px] text-muted-foreground">
        {t('accounts_intro')}
      </p>
      <Card className="p-0">
        {wallets.map((wallet, index) => (
          <div key={wallet.name}>
            {index > 0 && <Separator />}
            <div className="flex items-center gap-3 px-4 py-[15px]">
              <button
                onClick={() => switchTo(wallet)}
                className="flex flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left transition-transform duration-150 active:scale-[0.99]"
              >
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-full font-display font-bold ${AVATAR_BG[index % AVATAR_BG.length]}`}
                >
                  {accountLabel(wallet.name, wallet.label).charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">{accountLabel(wallet.name, wallet.label)}</span>
                    <AccountNetworkBadge network={wallet.network} />
                  </span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {truncateAddress(wallet.address)}
                  </span>
                </span>
              </button>
              {wallet.name === activeName && (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-secondary-foreground dark:text-primary">
                  <Check size={13} strokeWidth={2.5} />
                </span>
              )}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent transition duration-150 hover:bg-muted active:scale-90" aria-label={t('accounts_menuAria')}>
                    <Ellipsis size={16} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    className="w-48 rounded-[14px] border border-border bg-card p-1.5 shadow-pop"
                  >
                    <MenuItem label={t('accounts_renameMenu')} onClick={() => setRenaming(wallet)} />
                    <MenuItem label={t('accounts_revealMenu')} onClick={() => setRevealing(wallet)} />
                    <MenuItem label={t('accounts_removeMenu')} destructive onClick={() => setRemoving(wallet)} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>
        ))}
      </Card>
      <p className="m-0 text-[12.5px] text-muted-foreground">
        {t('accounts_removeNote')}
      </p>

      {renaming && (
        <RenameDialog
          wallet={renaming}
          onCancel={() => setRenaming(null)}
          onSave={(label) => void rename(renaming, label)}
        />
      )}

      {revealing && (
        <RevealPhraseDialog
          wallet={revealing}
          onClose={() => setRevealing(null)}
          onReveal={(passphrase) =>
            sendMessage('walletExportPhrase', { name: revealing.name, passphrase })
          }
        />
      )}

      <DialogShell
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('accounts_removeTitle', [accountLabel(removing?.name ?? '', removing?.label)])}
        actions={
          <>
            <Button variant="outline" onClick={() => setRemoving(null)}>{t('common_cancel')}</Button>
            <Button variant="soft-destructive" onClick={() => removing && void remove(removing)}>{t('common_remove')}</Button>
          </>
        }
      >
        {t('accounts_removeBody')}
      </DialogShell>
    </PanelScreen>
  );
}

function AccountNetworkBadge({ network }: { network: string }) {
  const label = networkLabel(network);

  return (
    <span
      aria-label={t('accounts_networkAria', [label])}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 text-[10px] font-bold tracking-[0.02em] text-muted-foreground"
    >
      <Globe size={9} strokeWidth={2.5} />
      {label}
    </span>
  );
}

function RenameDialog({
  wallet,
  onCancel,
  onSave,
}: {
  wallet: WalletInfo;
  onCancel: () => void;
  onSave: (label: string) => void;
}) {
  const [label, setLabel] = useState(accountLabel(wallet.name, wallet.label));
  const [saving, setSaving] = useState(false);

  const save = () => {
    setSaving(true);
    onSave(label);
  };

  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onCancel()}
      title={t('accounts_renameTitle', [accountLabel(wallet.name, wallet.label)])}
      actions={
        <>
          <Button variant="outline" onClick={onCancel}>{t('common_cancel')}</Button>
          <Button loading={saving} onClick={save}>{t('common_save')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !saving && save()}
          maxLength={30}
          placeholder={t('accounts_namePlaceholder')}
          aria-label={t('accounts_namePlaceholder')}
          autoFocus
        />
        <p className="m-0 text-[12px]">
          {t('accounts_renameHint')}
        </p>
      </div>
    </DialogShell>
  );
}

export type RevealedSecret = { kind: 'mnemonic' | 'seed'; value: string };

/** Revealed-secret body: word chips for a mnemonic, a mono hex block (with an
 *  explanatory note) for hex-imported accounts. 3 columns — the panel dialog
 *  is too narrow for setup's 4 and clips longer words. Exported for tests. */
export function RevealedSecretView({ secret }: { secret: RevealedSecret }) {
  const copy = async () => {
    // A mnemonic is normalised to single spaces on the way out; a hex seed has
    // no words to join and goes verbatim. Both then get the shared
    // copy-and-auto-clear treatment (see lib/ui/clipboard.ts).
    const value = secret.kind === 'mnemonic' ? formatSeedPhrase(secret.value.split(' ')) : secret.value;
    await copySecret(value);
    toast(t('accounts_revealCopied'));
  };

  return (
    <div className="flex flex-col gap-3">
      {secret.kind === 'mnemonic' ? (
        <WordChipGrid words={secret.value.split(' ')} columns={3} />
      ) : (
        <>
          <p className="m-0 text-[12.5px] text-muted-foreground">{t('accounts_revealSeedNote')}</p>
          <code className="break-all rounded-xl border border-border bg-card px-3 py-2 font-mono text-[12.5px]">
            {secret.value}
          </code>
        </>
      )}
      <Button variant="outline" onClick={() => void copy()}>
        <Copy size={14} /> {t('accounts_revealCopy')}
      </Button>
      <NoteCard variant="error" icon={TriangleAlert}>
        {t('accounts_revealWarning')}
      </NoteCard>
    </div>
  );
}

/** Password-gated reveal of an account's backup secret. The password is only
 *  held while the prompt is open and the decrypt happens in the offscreen
 *  key-holder — a wrong password rejects and surfaces inline. */
export function RevealPhraseDialog({
  wallet,
  onReveal,
  onClose,
}: {
  wallet: WalletInfo;
  onReveal: (passphrase: string) => Promise<RevealedSecret>;
  onClose: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const title = t('accounts_revealTitle', [accountLabel(wallet.name, wallet.label)]);

  const reveal = async () => {
    setBusy(true);
    setError('');
    try {
      setRevealed(await onReveal(passphrase));
    } catch {
      setError(t('accounts_revealWrongPassword'));
    } finally {
      setBusy(false);
      setPassphrase('');
    }
  };

  if (revealed) {
    return (
      <DialogShell
        open
        onOpenChange={(open) => !open && onClose()}
        title={title}
        actions={<Button onClick={onClose}>{t('common_done')}</Button>}
      >
        <RevealedSecretView secret={revealed} />
      </DialogShell>
    );
  }

  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      actions={
        <>
          <Button variant="outline" onClick={onClose}>{t('common_cancel')}</Button>
          <Button loading={busy} disabled={!passphrase} onClick={() => void reveal()}>
            {t('accounts_revealButton')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && passphrase && !busy && void reveal()}
          placeholder={t('accounts_revealPasswordPlaceholder')}
          aria-label={t('accounts_revealPasswordPlaceholder')}
          autoFocus
        />
        {error ? (
          <p className="m-0 text-[12px] text-destructive">{error}</p>
        ) : (
          <p className="m-0 text-[12px]">{t('accounts_revealHint')}</p>
        )}
      </div>
    </DialogShell>
  );
}

function MenuItem({ label, onClick, destructive }: { label: string; onClick: () => void; destructive?: boolean }) {
  return (
    <DropdownMenu.Item
      onSelect={onClick}
      className={`cursor-pointer rounded-lg px-3 py-2 text-sm outline-none transition-colors duration-100 data-[highlighted]:bg-muted ${
        destructive ? 'text-destructive' : ''
      }`}
    >
      {label}
    </DropdownMenu.Item>
  );
}
