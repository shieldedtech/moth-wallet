// The seed's sub-accounts — the MIP's accounts: numbered by the runtime, labelled by the user, each
// a set of capsules of its own for the same contracts, all paid for by this wallet. The current one
// is what a site connects to; switching leaves the sites' sessions to lapse, so each reconnects and
// is asked afresh under the new one. Shown at the top of Contract capsules.

import { useState } from 'react';
import { cn } from '../../lib/ui/cn';
import { t } from '../../lib/i18n';
import type { CapsuleAccountsDTO } from '../../lib/capsule/protocol';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';

export type SubAccountChange = { select: number } | { create: string } | { rename: { number: number; label: string } };

export function SubAccounts({ accounts, onChange }: { accounts: CapsuleAccountsDTO; onChange: (change: SubAccountChange) => void }) {
  const [editing, setEditing] = useState<'new' | 'rename' | null>(null);
  const [label, setLabel] = useState('');
  const current = accounts.accounts.find((a) => a.number === accounts.current);

  const done = () => {
    setEditing(null);
    setLabel('');
  };
  const submit = () => {
    if (editing === 'new') onChange({ create: label });
    else if (editing === 'rename' && current !== undefined) onChange({ rename: { number: current.number, label } });
    done();
  };

  return (
    <Card className="flex flex-col gap-2 px-4 py-3">
      <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{t('capsule_accountsTitle')}</span>
      <div className="flex flex-wrap gap-1.5">
        {accounts.accounts.map((account) => (
          <button
            key={account.number}
            type="button"
            onClick={() => account.number !== accounts.current && onChange({ select: account.number })}
            aria-pressed={account.number === accounts.current}
            title={t('capsule_accountsNumber', [account.number])}
            className={cn(
              'h-8 cursor-pointer rounded-full border-0 px-3.5 text-[13px] font-semibold transition duration-150 active:scale-[0.97]',
              account.number === accounts.current
                ? 'bg-secondary text-secondary-foreground dark:bg-primary dark:text-primary-foreground'
                : 'bg-muted text-foreground hover:bg-border',
            )}
          >
            {account.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setEditing('new');
            setLabel('');
          }}
          className="h-8 cursor-pointer rounded-full border-0 bg-muted px-3.5 text-[13px] font-semibold text-foreground transition duration-150 hover:bg-border"
        >
          {t('capsule_accountsNew')}
        </button>
      </div>
      {editing !== null ? (
        <div className="flex items-center gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            placeholder={editing === 'new' ? t('capsule_accountsLabelPlaceholder') : (current?.label ?? '')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') done();
            }}
          />
          <Button size="sm" onClick={submit}>
            {editing === 'new' ? t('capsule_accountsAdd') : t('capsule_accountsSave')}
          </Button>
          <Button size="sm" variant="ghost" onClick={done}>
            {t('capsule_accountsCancel')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] text-muted-foreground">{t('capsule_accountsNote')}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing('rename');
              setLabel(current?.label ?? '');
            }}
          >
            {t('capsule_accountsRename')}
          </Button>
        </div>
      )}
    </Card>
  );
}
