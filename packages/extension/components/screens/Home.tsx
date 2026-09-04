// 2d Home (and 9c fresh-wallet variant): balance header, Send/Receive,
// DUST meter card, asset groups. Fiat/day-change omitted (no price oracle).
// Shielded token rows open a naming dialog — names are local display metadata
// (see lib/background/token-names.ts).

import { useState } from 'react';
import { ArrowDown, ArrowUp, Settings as SettingsIcon } from 'lucide-react';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { t } from '../../lib/i18n';
import { formatTokenBalance } from '../../lib/ui/format';
import { nativeAssetLabelsForNetwork } from '../../lib/ui/token-labels';
import { useActivity, useTokenNames } from '../../lib/ui/client';
import { activityRowView } from '../../lib/ui/activity-view';
import { Button } from '../ui/button';
import { Card, Separator } from '../ui/card';
import { Input } from '../ui/input';
import { DialogShell } from '../ui/dialog';
import { PanelScreen } from '../moth/panel';
import { TokenIcon } from '../moth/token';
import { DustMeterCard } from '../moth/dust';
import { ActivityRow } from '../moth/activity';
import { SyncStatus, useSyncRegressionGrace } from '../moth/sync-status';
import { RelayStatus } from '../moth/relay-status';
import type { RelayState } from '../../lib/messaging/protocol';
import { dustView } from '../../lib/ui/dust-view';
import { syncStatusView } from '../../lib/ui/sync-view';
import type { Screen } from './navigation';
import { networkLabel } from './NetworkConfig';

export function Home({
  walletName,
  network,
  balances,
  syncMessage,
  relayState,
  navigate,
}: {
  /** Resolved display name for the account (label or formatted storage name). */
  walletName: string;
  network: string;
  balances: WalletBalances | null;
  syncMessage: string;
  relayState: RelayState | null;
  navigate: (screen: Screen) => void;
}) {
  // NIGHT is an unshielded-only token — the shielded wallet never holds it, so
  // total NIGHT is just the unshielded balance.
  const night = balances?.unshielded[NIGHT_TOKEN_ID] ?? 0n;
  const unshieldedTokens = Object.entries(balances?.unshielded ?? {}).filter(([id]) => id !== NIGHT_TOKEN_ID);
  const shieldedTokens = Object.entries(balances?.shielded ?? {}).filter(([id]) => id !== NIGHT_TOKEN_ID);
  const fresh =
    balances !== null && night === 0n && unshieldedTokens.length === 0 && shieldedTokens.length === 0;
  const labels = nativeAssetLabelsForNetwork(network);
  const activity = useActivity(balances);
  const { names: tokenNames, rename: renameToken } = useTokenNames();
  const [namingToken, setNamingToken] = useState<string | null>(null);
  const dustSynced = useSyncRegressionGrace(
    balances?.syncProgress.dustSynced ?? false,
    balances !== null,
    // Raw dust fraction: a rebuild drops this far enough to bypass the grace,
    // so an explicit rescan is reported instead of being smoothed over.
    balances && balances.subProgress.dust.total > 0
      ? balances.subProgress.dust.applied / balances.subProgress.dust.total
      : undefined,
  );

  return (
    <PanelScreen>
      <div className="flex min-w-0 items-center gap-2 pt-[18px]">
        <button
          onClick={() => navigate('accounts')}
          aria-label={t('home_viewAccountsAria')}
          className="flex min-w-0 max-w-[210px] cursor-pointer items-center gap-2 rounded-full border-0 bg-muted py-1.5 pl-1.5 pr-3 text-left text-foreground transition duration-150 hover:opacity-75 active:scale-[0.97]"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary font-display text-[13px] font-bold text-primary-foreground">
            {walletName.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 truncate text-[13.5px] font-semibold">{walletName}</span>
          <NetworkBadge network={network} />
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {balances && <SyncStatus view={syncStatusView(balances)} />}
          <button
            onClick={() => navigate('settings')}
            className="group flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-0 bg-muted transition duration-150 hover:bg-border active:scale-90"
            aria-label={t('home_settingsAria')}
          >
            <SettingsIcon
              size={16}
              strokeWidth={2}
              className="transition-transform duration-300 ease-out group-hover:rotate-90"
            />
          </button>
        </div>
      </div>

      <div className="pt-2">
        <p className="m-0 text-[13px] text-muted-foreground">{t('home_totalBalance')}</p>
        <p className="m-0 font-display text-[42px] font-extrabold leading-tight">
          {balances ? formatTokenBalance(night, 6) : '—'} <span className="text-lg text-foreground/45">{labels.night}</span>
        </p>
        {!balances && <p className="m-0 text-xs text-muted-foreground">{syncMessage || t('home_connecting')}</p>}
      </div>

      {/* Above the actions, not below: it is the reason Send will fail, so it
          has to be read before the button is reached. */}
      <RelayStatus state={relayState} />

      <div className="flex gap-2">
        <Button className="flex-1" disabled={fresh} onClick={() => navigate('send')}>
          <ArrowUp size={15} strokeWidth={2.5} /> {t('home_send')}
        </Button>
        <Button variant={fresh ? 'default' : 'secondary'} className="flex-1" onClick={() => navigate('receive')}>
          <ArrowDown size={15} strokeWidth={2.5} /> {t('home_receive')}
        </Button>
      </div>

      {/* Always shown once balances exist. Hiding it made an empty wallet look
          like it had no DUST mechanism at all, and hiding it from a wallet that
          holds DUST but no NIGHT reported nothing while the total was non-zero.
          The card says which state it is in; the panel does not decide by
          omission. */}
      {balances && (
        <DustMeterCard
          view={dustView(balances, labels, dustSynced)}
          labels={labels}
          onOpen={() => navigate('dust')}
        />
      )}

      {fresh ? (
        <div className="rounded-[18px] bg-accent p-4">
          <p className="m-0 text-sm font-semibold text-accent-foreground">{t('home_addFirstTitle', [labels.night])}</p>
          <p className="mb-3 mt-1 text-[13px] text-accent-foreground/80">
            {t('home_addFirstBody', [labels.night])}
          </p>
          <Button size="sm" variant="secondary" onClick={() => navigate('receive')}>
            {t('home_showMyAddress')}
          </Button>
        </div>
      ) : (
        <>
          <div>
            <p className="m-0 mb-2 font-display text-[15px] font-bold">{t('home_unshielded')}</p>
            <Card className="p-0">
              <AssetRow kind="night" name={labels.night} sub="Midnight" amount={formatTokenBalance(night, 6)} />
              {unshieldedTokens.map(([id, value]) => (
                <div key={id}>
                  <Separator />
                  <AssetRow
                    kind="unshielded"
                    name={tokenNames[id] ?? `${id.slice(0, 8)}…`}
                    sub={tokenNames[id] ? t('home_unshieldedTokenWithId', [`${id.slice(0, 8)}…`]) : t('home_unshieldedToken')}
                    amount={formatTokenBalance(value, 0)}
                    onClick={() => setNamingToken(id)}
                  />
                </div>
              ))}
            </Card>
          </div>
          <div>
            <p className="m-0 mb-2 font-display text-[15px] font-bold">{t('home_shielded')}</p>
            <Card className="p-0">
              {shieldedTokens.length === 0 ? (
                <p className="m-0 px-4 py-[15px] text-[12.5px] text-muted-foreground">
                  {t('home_noShieldedTokens')}
                </p>
              ) : (
                shieldedTokens.map(([id, value], index) => (
                  <div key={id}>
                    {index > 0 && <Separator />}
                    <AssetRow
                      kind="shielded"
                      name={tokenNames[id] ?? `${id.slice(0, 8)}…`}
                      sub={tokenNames[id] ? t('home_shieldedTokenWithId', [`${id.slice(0, 8)}…`]) : t('home_shieldedToken')}
                      amount={formatTokenBalance(value, 0)}
                      onClick={() => setNamingToken(id)}
                    />
                  </div>
                ))
              )}
            </Card>
          </div>
        </>
      )}

      {namingToken && (
        <TokenNameDialog
          tokenId={namingToken}
          currentName={tokenNames[namingToken] ?? ''}
          onCancel={() => setNamingToken(null)}
          onSave={async (name) => {
            await renameToken(namingToken, name);
            setNamingToken(null);
          }}
        />
      )}

      {activity !== null && activity.length > 0 && (
        <div className="pb-2">
          <div className="mb-1 flex items-center justify-between">
            <p className="m-0 font-display text-[15px] font-bold">{t('home_recentActivity')}</p>
            <button
              onClick={() => navigate('activity')}
              className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-link transition duration-150 hover:opacity-75"
            >
              {t('home_seeAll')}
            </button>
          </div>
          {activity.slice(0, 2).map((entry) => (
            <ActivityRow key={entry.hash} view={activityRowView(entry, labels)} />
          ))}
        </div>
      )}
    </PanelScreen>
  );
}

function NetworkBadge({ network }: { network: string }) {
  const label = networkLabel(network);

  return (
    <span
      aria-label={t('home_networkAria', [label])}
      className="shrink-0 rounded-full bg-card/80 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.04em] text-muted-foreground"
    >
      {label}
    </span>
  );
}

function AssetRow({
  kind,
  name,
  sub,
  amount,
  onClick,
}: {
  kind: 'night' | 'shielded' | 'unshielded';
  name: string;
  sub: string;
  amount: string;
  /** Makes the row interactive (used to open the token naming dialog). */
  onClick?: () => void;
}) {
  const content = (
    <>
      <TokenIcon kind={kind} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{name}</span>
        <span className="block truncate text-[12.5px] text-muted-foreground">{sub}</span>
      </span>
      <span className="text-sm font-semibold">{amount}</span>
    </>
  );
  if (!onClick) return <div className="flex items-center gap-3 px-4 py-[15px]">{content}</div>;
  return (
    <button
      onClick={onClick}
      aria-label={t('home_nameTokenAria', [name])}
      className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-[15px] text-left transition duration-150 hover:bg-muted/60 active:scale-[0.99]"
    >
      {content}
    </button>
  );
}

function TokenNameDialog({
  tokenId,
  currentName,
  onCancel,
  onSave,
}: {
  tokenId: string;
  currentName: string;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);

  const save = () => {
    setSaving(true);
    void onSave(name);
  };

  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onCancel()}
      title={t('home_nameTokenTitle')}
      actions={
        <>
          <Button variant="outline" onClick={onCancel}>{t('common_cancel')}</Button>
          <Button loading={saving} onClick={save}>{t('common_save')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="m-0 break-all font-mono text-[11.5px]">{tokenId}</p>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !saving && save()}
          maxLength={30}
          placeholder={t('home_nameTokenPlaceholder')}
          aria-label={t('home_tokenNameAria')}
          autoFocus
        />
        <p className="m-0 text-[12px]">
          {t('home_nameTokenHint')}
        </p>
      </div>
    </DialogShell>
  );
}
