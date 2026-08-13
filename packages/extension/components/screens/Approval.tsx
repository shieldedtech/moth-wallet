// 2g Connect / 2k Approve transaction — shared by the side panel and the
// fallback approval window. Offers inline unlock when locked.

import { useEffect, useState } from 'react';
import { Moon, TriangleAlert } from 'lucide-react';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import { accountLabel } from '../../lib/ui/format';
import { nativeAssetLabelsForNetwork } from '../../lib/ui/token-labels';
import type { PendingApproval } from '../../lib/background/approvals';
import { Button } from '../ui/button';
import { Badge, Card, Separator } from '../ui/card';
import { Input } from '../ui/input';
import { PanelScreen } from '../moth/panel';
import { SitePair, SiteChip, PermissionList, originHost } from '../moth/dapp';
import { NoteCard } from '../moth/note-card';
import { DetailCard } from '../moth/status';
import { TokenIcon, truncateAddress } from '../moth/token';

interface TransferPayload {
  outputs: Array<{ kind: string; type: string; value: string; recipient: string }>;
}

interface SignDataPayload {
  encoding: string;
  message: string;
}

interface DeriveAppSecretPayload {
  domain: string;
}

const NIGHT_ID = '0'.repeat(64);

export function Approval({
  approvalId,
  walletName,
  walletLabel,
  network,
  locked,
  onResolved,
  onUnlocked,
}: {
  /** Storage name of the account (used for unlock); never shown directly. */
  walletName: string | null;
  /** User-chosen display label, when set. */
  walletLabel?: string;
  approvalId: string;
  network: string;
  locked: boolean;
  onResolved: () => void;
  onUnlocked: () => void;
}) {
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [missing, setMissing] = useState(false);
  const shownName = walletName ? accountLabel(walletName, walletLabel) : null;

  useEffect(() => {
    void sendMessage('approvalGet', { id: approvalId }).then(({ approval }) => {
      setApproval(approval);
      setMissing(!approval);
    });
  }, [approvalId]);

  const decide = async (approved: boolean) => {
    await sendMessage('approvalResolve', { id: approvalId, approved });
    onResolved();
  };

  if (missing) {
    return (
      <PanelScreen cta={<Button size="lg" onClick={onResolved}>{t('common_close')}</Button>}>
        <p className="pt-12 text-center text-muted-foreground">{t('approval_requestExpired')}</p>
      </PanelScreen>
    );
  }
  if (!approval) return <PanelScreen>{null}</PanelScreen>;

  const host = originHost(approval.origin);
  const labels = nativeAssetLabelsForNetwork(network);

  return (
    <PanelScreen
      cta={
        locked ? undefined : (
          <>
            <Button variant="outline" size="lg" onClick={() => void decide(false)}>
              {approval.kind === 'connect' ? t('common_cancel') : t('approval_reject')}
            </Button>
            <Button size="lg" onClick={() => void decide(true)}>
              {approval.kind === 'connect'
                ? t('approval_connect')
                : approval.kind === 'signData'
                  ? t('approval_sign')
                  : approval.kind === 'deriveAppSecret'
                    ? t('approval_allow')
                    : t('approval_approve')}
            </Button>
          </>
        )
      }
    >
      {approval.kind === 'connect' ? (
        <>
          <SitePair origin={approval.origin} />
          <div className="text-center">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-tight">
              {t('approval_connectTo')}
              <br />
              {t('approval_connectToHost', [host])}
            </h1>
            <div className="pt-2.5">
              <Badge>{t('approval_firstTimeConnecting')}</Badge>
            </div>
          </div>
          <PermissionList
            can={[t('approval_canSeeAddresses'), t('approval_canAskApprove')]}
            cant={[t('approval_cantMoveMoney'), t('approval_cantSeeBalances')]}
          />
          {shownName && (
            <div className="flex items-center gap-3 px-1">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary font-display text-[13px] font-bold">
                {shownName.charAt(0).toUpperCase()}
              </span>
              <span className="text-sm">
                {t('approval_connectingAs')} <strong>{shownName}</strong>
              </span>
            </div>
          )}
        </>
      ) : approval.kind === 'signData' ? (
        <>
          <SiteChip origin={approval.origin} />
          <div className="text-center">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-tight">{t('approval_signTitle')}</h1>
            <p className="m-0 pt-1.5 text-[13.5px] text-muted-foreground">
              {t('approval_signSubtitle', [host])}
            </p>
          </div>
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{t('approval_messageLabel')}</span>
              <Badge>{(approval.payload as SignDataPayload).encoding}</Badge>
            </div>
            <p className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[13px] leading-snug">
              {(approval.payload as SignDataPayload).message || t('approval_emptyMessage')}
            </p>
          </Card>
          <NoteCard icon={Moon}>
            {t('approval_signNote')}
          </NoteCard>
        </>
      ) : approval.kind === 'deriveAppSecret' ? (
        <>
          <SiteChip origin={approval.origin} />
          <div className="text-center">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-tight">{t('approval_deriveTitle')}</h1>
            <p className="m-0 pt-1.5 text-[13.5px] text-muted-foreground">
              {t('approval_deriveSubtitle', [host])}
            </p>
          </div>
          <Card className="p-4">
            <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{t('approval_deriveLabelLabel')}</span>
            <p className="m-0 mt-1 break-all font-mono text-[13px] leading-snug">
              {(approval.payload as DeriveAppSecretPayload).domain}
            </p>
          </Card>
          <NoteCard icon={Moon}>
            {t('approval_deriveNote')}
          </NoteCard>
        </>
      ) : approval.kind === 'balance' ? (
        <>
          <SiteChip origin={approval.origin} />
          <div className="text-center">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-tight">{t('approval_approveTitle')}</h1>
            <p className="m-0 pt-1.5 text-[13.5px] text-muted-foreground">
              {t('approval_balanceSubtitle', [host])}
            </p>
          </div>
          <DetailCard
            rows={[
              { label: t('approval_fromLabel'), value: shownName ?? '—' },
              { label: t('approval_networkFeeLabel'), value: t('approval_paidIn', [labels.dust]) },
            ]}
          />
          <NoteCard icon={TriangleAlert}>
            {t('approval_balanceNote')}
          </NoteCard>
        </>
      ) : (
        <>
          <SiteChip origin={approval.origin} />
          <div className="text-center">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-tight">{t('approval_approveTitle')}</h1>
            <p className="m-0 pt-1.5 text-[13.5px] text-muted-foreground">{t('approval_transferSubtitle')}</p>
          </div>
          <Card className="p-0">
            {(approval.payload as TransferPayload).outputs.map((out, index) => (
              <div key={index}>
                {index > 0 && <Separator />}
                <div className="flex items-center gap-3 px-4 py-[15px]">
                  <TokenIcon kind={out.type === NIGHT_ID ? 'night' : 'shielded'} />
                  <span className="flex-1">
                    <span className="block text-[12px] text-muted-foreground">{t('approval_youSend')}</span>
                    <span className="block text-[15px] font-bold">
                      {formatRaw(out.value)} {out.type === NIGHT_ID ? labels.night : truncateAddress(out.type, 6, 0)}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{truncateAddress(out.recipient)}</span>
                </div>
              </div>
            ))}
          </Card>
          <DetailCard
            rows={[
              { label: t('approval_networkFeeLabel'), value: t('approval_paidIn', [labels.dust]) },
              ...(shownName ? [{ label: t('approval_usingLabel'), value: shownName }] : []),
            ]}
          />
          <NoteCard icon={Moon}>
            {t('approval_transferNote')}
          </NoteCard>
        </>
      )}

      {locked && <ApprovalUnlock walletName={walletName} onUnlocked={onUnlocked} />}
    </PanelScreen>
  );
}

function formatRaw(value: string): string {
  try {
    const raw = BigInt(value);
    const whole = raw / 1_000_000n;
    const fraction = raw % 1_000_000n;
    return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`;
  } catch {
    return value;
  }
}

function ApprovalUnlock({ walletName, onUnlocked }: { walletName: string | null; onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(walletName ?? '');

  useEffect(() => {
    if (!name) {
      void sendMessage('walletList', undefined).then((wallets) => {
        setName(wallets.find((w) => w.active)?.name ?? wallets[0]?.name ?? '');
      });
    }
  }, [name]);

  const submit = async () => {
    setBusy(true);
    setError(false);
    try {
      await sendMessage('sessionUnlock', { name, passphrase });
      onUnlocked();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-[18px] bg-muted p-4">
      <p className="m-0 text-sm font-semibold">{t('approval_unlockToContinue')}</p>
      <Input
        type="password"
        placeholder={t('approval_passwordPlaceholder')}
        value={passphrase}
        invalid={error}
        onChange={(e) => setPassphrase(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && passphrase && void submit()}
      />
      {error && <p className="m-0 text-[12.5px] text-destructive">{t('approval_wrongPassword')}</p>}
      <Button disabled={!passphrase} loading={busy} onClick={() => void submit()}>
        {busy ? t('approval_unlocking') : t('approval_unlock')}
      </Button>
    </div>
  );
}
