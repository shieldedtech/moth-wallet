// 4a Unlock — dark panel, crescent, single password field for the active
// account. (9a wrong-password state: red border + error text.)

import { useState } from 'react';
import { t } from '../../lib/i18n';
import { Button } from '../ui/button';
import { PanelScreen, Crescent } from '../moth/panel';

export function Unlock({
  walletName,
  accountName,
  accounts,
  onUnlock,
  onCancel,
}: {
  walletName: string;
  /** Every account available to unlock. When more than one exists the user
   *  picks; without this the screen silently unlocks whichever is active, which
   *  after deleting the active account is a different one than they expect —
   *  and the only symptom is a rejected password. */
  accounts?: ReadonlyArray<{ name: string; label?: string; network: string }>;
  /** Display label of the account being unlocked. Shown when switching so the
   *  target is unambiguous; omitted on a cold unlock (generic welcome). */
  accountName?: string;
  onUnlock: (name: string, passphrase: string) => Promise<unknown>;
  /** When set, a Cancel control returns without unlocking. Provided only while
   *  switching accounts (a live session waits underneath); omitted for a cold
   *  or forced unlock, where there is nothing to return to. */
  onCancel?: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // Holds only an explicit choice. What gets unlocked is derived below, so a
  // selection can never outlive the account it named: deleting the active
  // account changes the list under a mounted screen, and useState would happily
  // keep pointing at the account that just went away.
  const [chosen, setChosen] = useState<string | null>(null);

  const choices = accounts && accounts.length > 1 ? accounts : null;
  const exists = (name: string | null) => name !== null && (accounts ?? []).some((a) => a.name === name);
  // Preference order: an explicit choice that still exists, then the account the
  // panel considers active, then whatever is left. With one account remaining
  // after a deletion this lands on it without the user choosing again.
  const target = exists(chosen)
    ? (chosen as string)
    : exists(walletName)
      ? walletName
      : (accounts?.[0]?.name ?? walletName);

  // Always name what is being unlocked. The generic "Welcome back" was only
  // unambiguous with a single account: after deleting the active one the panel
  // promotes another silently, and a correct password for the account the user
  // had in mind is rejected by a different one with nothing on screen to say so.
  const targetAccount = (accounts ?? []).find((a) => a.name === target);
  const targetLabel = targetAccount?.label?.trim() || targetAccount?.name || accountName || walletName;

  const submit = async () => {
    setBusy(true);
    setError(false);
    try {
      await onUnlock(target, passphrase);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelScreen dark>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <Crescent />
        <h1 className="m-0 font-display text-[28px] font-extrabold">
          {t('unlock_unlockAccount', [targetLabel])}
        </h1>
        <p className="m-0 text-[13.5px] text-muted-foreground">
          {choices ? t('unlock_chooseAccount') : onCancel ? t('unlock_switchHint') : t('unlock_enterPassword')}
        </p>
        {choices ? (
          <div className="flex w-full flex-col gap-1.5" role="radiogroup" aria-label={t('unlock_chooseAccount')}>
            {choices.map((account) => {
              const active = account.name === target;
              return (
                <button
                  key={account.name}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setChosen(account.name);
                    setError(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-2xl border px-4 py-2.5 text-left transition-colors duration-150 ${
                    active ? 'border-foreground bg-white/10' : 'border-input bg-white/5 hover:bg-white/8'
                  }`}
                >
                  <span className="truncate text-sm font-semibold">{account.label?.trim() || account.name}</span>
                  <span className="ml-3 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {account.network}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="relative w-full">
          <input
            type={show ? 'text' : 'password'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && passphrase && void submit()}
            className={`h-12 w-full rounded-2xl border bg-white/8 px-4 pr-16 text-foreground transition-colors duration-150 focus:outline-none ${
              error ? 'border-error-border' : 'border-input focus:border-foreground'
            }`}
            placeholder={t('unlock_passwordPlaceholder')}
            autoFocus
          />
          <button
            onClick={() => setShow(!show)}
            className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer border-0 bg-transparent text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            {show ? t('unlock_hide') : t('unlock_show')}
          </button>
        </div>
        {error && <p className="m-0 text-[13px] text-error-text">{t('unlock_wrongPassword')}</p>}
        <Button size="lg" className="w-full" disabled={!passphrase} loading={busy} onClick={() => void submit()}>
          {busy ? t('unlock_unlocking') : t('unlock_unlock')}
        </Button>
        {onCancel && (
          <button
            onClick={onCancel}
            disabled={busy}
            className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:cursor-default disabled:opacity-50"
          >
            {t('common_cancel')}
          </button>
        )}
      </div>
    </PanelScreen>
  );
}
