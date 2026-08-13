// 4a Unlock — dark panel, crescent, single password field for the active
// account. (9a wrong-password state: red border + error text.)

import { useState } from 'react';
import { t } from '../../lib/i18n';
import { Button } from '../ui/button';
import { PanelScreen, Crescent } from '../moth/panel';

export function Unlock({
  walletName,
  accountName,
  onUnlock,
  onCancel,
}: {
  walletName: string;
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

  const submit = async () => {
    setBusy(true);
    setError(false);
    try {
      await onUnlock(walletName, passphrase);
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
          {accountName ? t('unlock_unlockAccount', [accountName]) : t('unlock_welcomeBack')}
        </h1>
        <p className="m-0 text-[13.5px] text-muted-foreground">
          {accountName ? t('unlock_switchHint') : t('unlock_enterPassword')}
        </p>
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
