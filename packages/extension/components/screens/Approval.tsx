// 2g Connect / 2k Approve transaction — shared by the side panel and the
// fallback approval window. Offers inline unlock when locked.

import { useEffect, useState } from 'react';
import { Moon, TriangleAlert } from 'lucide-react';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import { useTokenNames } from '../../lib/ui/client';
import { accountLabel } from '../../lib/ui/format';
import { nativeAssetLabelsForNetwork } from '../../lib/ui/token-labels';
import { txSummaryRows } from '../../lib/ui/tx-summary-view';
import type { PendingApproval } from '../../lib/background/approvals';
import type { BalanceApprovalPayload, TransferApprovalPayload } from '../../lib/background/connector-handlers';
import type { CardanoSignApprovalPayload } from '../../lib/messaging/protocol';
import type { CardanoTxSummary } from '@shieldedtech/moth-wallet/cardano/cip30';
import { Button } from '../ui/button';
import { Badge, Card, Separator } from '../ui/card';
import { Input } from '../ui/input';
import { PanelScreen } from '../moth/panel';
import { SitePair, SiteChip, PermissionList, originHost } from '../moth/dapp';
import { NoteCard } from '../moth/note-card';
import { DetailCard } from '../moth/status';
import { TokenIcon, truncateAddress } from '../moth/token';

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
  const { names: tokenNames } = useTokenNames();
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
            can={CONNECT_CAN.map((key) => t(key))}
            cant={CONNECT_CANT.map((key) => t(key))}
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
      ) : approval.kind === 'cardanoSign' ? (
        <>
          <SiteChip origin={approval.origin} />
          <div className="text-center">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-tight">
              {t('approval_cardanoSignTitle')}
            </h1>
            <p className="m-0 pt-1.5 text-[13.5px] text-muted-foreground">
              {t('approval_cardanoSignSubtitle', [host])}
            </p>
          </div>
          <DetailCard rows={cardanoSignRows(approval.payload as Partial<CardanoSignApprovalPayload>)} />
          {(approval.payload as Partial<CardanoSignApprovalPayload>).preview?.tx && (
            <DetailCard rows={cardanoTxRows((approval.payload as CardanoSignApprovalPayload).preview.tx!)} />
          )}
          {(approval.payload as Partial<CardanoSignApprovalPayload>).preview?.payload && (
            <Card className="p-4">
              <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('approval_cardanoMessageLabel')}
              </span>
              <p
                className={`m-0 mt-1 whitespace-pre-wrap break-all text-[13px] leading-snug ${
                  (approval.payload as CardanoSignApprovalPayload).preview.payload!.kind === 'hex' ? 'font-mono' : ''
                }`}
              >
                {(approval.payload as CardanoSignApprovalPayload).preview.payload!.value}
              </p>
            </Card>
          )}
          <NoteCard variant="error" icon={TriangleAlert}>
            {t('approval_cardanoSignWarning')}
          </NoteCard>
        </>
      ) : approval.kind === 'balance' ? (
        <>
          <SiteChip origin={approval.origin} />
          <div className="text-center">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-tight">{t('approval_approveTitle')}</h1>
            <p className="m-0 pt-1.5 text-[13.5px] text-muted-foreground">
              {(approval.payload as BalanceApprovalPayload).payFees !== false
                ? t('approval_balanceSubtitle', [host])
                : t('approval_balanceSubtitleNoFees', [host])}
            </p>
          </div>
          <BalanceSummary
            payload={approval.payload as BalanceApprovalPayload}
            host={host}
            labels={labels}
            tokenNames={tokenNames}
          />
          <DetailCard
            rows={[
              { label: t('approval_fromLabel'), value: shownName ?? '—' },
              {
                label: t('approval_networkFeeLabel'),
                value: feeValue((approval.payload as BalanceApprovalPayload).payFees, labels.dust),
              },
              ...((approval.payload as BalanceApprovalPayload).summary?.contractActions
                ? [
                    {
                      label: t('approval_contractCallsLabel'),
                      value: String((approval.payload as BalanceApprovalPayload).summary?.contractActions),
                    },
                  ]
                : []),
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
          <TransferRows payload={approval.payload as TransferApprovalPayload} nightLabel={labels.night} />
          <DetailCard
            rows={[
              {
                label: t('approval_networkFeeLabel'),
                value: feeValue((approval.payload as TransferApprovalPayload).payFees, labels.dust),
              },
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

function feeValue(payFees: boolean, dustLabel: string): string {
  return payFees !== false ? t('approval_paidIn', [dustLabel]) : t('approval_notPaidByWallet');
}

/**
 * What a dApp-built transaction takes from the wallet, token by token, before
 * the user approves balancing it. The one thing this screen must never do is
 * stay quiet: no summary means a visible warning, and a summary with nothing in
 * it says so in words.
 */
function BalanceSummary({
  payload,
  host,
  labels,
  tokenNames,
}: {
  payload: BalanceApprovalPayload;
  host: string;
  labels: ReturnType<typeof nativeAssetLabelsForNetwork>;
  tokenNames: Record<string, string>;
}) {
  if (!payload.summary) {
    return (
      <NoteCard icon={TriangleAlert}>
        {t('approval_summaryUnavailable', [host])}
      </NoteCard>
    );
  }
  const rows = txSummaryRows(payload.summary, labels, tokenNames);
  if (rows.length === 0) {
    return (
      <Card className="p-4">
        <p className="m-0 text-[13.5px] text-muted-foreground">
          {payload.payFees !== false ? t('approval_spendsNothing') : t('approval_spendsNothingNoFees')}
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-0">
      {rows.map((row, index) => (
        <div key={`${row.direction}-${row.symbol}-${index}`}>
          {index > 0 && <Separator />}
          <div className="flex items-center gap-3 px-4 py-[15px]">
            <TokenIcon kind={row.icon} />
            <span className="flex-1">
              <span className="block text-[12px] text-muted-foreground">
                {row.direction === 'pay' ? t('approval_youPay') : t('approval_youGetBack')}
              </span>
              <span className="block text-[15px] font-bold">
                {row.amount} {row.symbol}
              </span>
            </span>
            {row.detail && <span className="font-mono text-xs text-muted-foreground">{row.detail}</span>}
          </div>
        </div>
      ))}
    </Card>
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

/**
 * The token rows of a transfer approval. For `makeTransfer` the outputs are what
 * the user sends. For `makeIntent` the inputs are what the wallet gives up, so
 * they are what the user sends, and the outputs are listed as payments out with
 * their recipients — never under "You send", which would hide the inputs.
 */
export function TransferRows({ payload, nightLabel }: { payload: TransferApprovalPayload; nightLabel: string }) {
  const amount = (type: string, value: string) =>
    `${formatRaw(value)} ${type === NIGHT_ID ? nightLabel : truncateAddress(type, 6, 0)}`;
  const intent = payload.inputs !== undefined;
  const rows = [
    ...(payload.inputs ?? []).map((input) => ({
      label: t('approval_youSend'), type: input.type, value: input.value, recipient: null as string | null,
    })),
    ...payload.outputs.map((out) => ({
      label: intent ? t('approval_intentPaysOut') : t('approval_youSend'),
      type: out.type,
      value: out.value,
      recipient: out.recipient,
    })),
  ];
  return (
    <Card className="p-0">
      {rows.map((row, index) => (
        <div key={index}>
          {index > 0 && <Separator />}
          <div className="flex items-center gap-3 px-4 py-[15px]">
            <TokenIcon kind={row.type === NIGHT_ID ? 'night' : 'shielded'} />
            <span className="flex-1">
              <span className="block text-[12px] text-muted-foreground">{row.label}</span>
              <span className="block text-[15px] font-bold">{amount(row.type, row.value)}</span>
            </span>
            {row.recipient && (
              <span className="font-mono text-xs text-muted-foreground">{truncateAddress(row.recipient)}</span>
            )}
          </div>
        </div>
      ))}
    </Card>
  );
}

/**
 * What the connect screen says a granted site can and cannot do. It must match
 * what the connector serves without a further prompt; a test holds it to that.
 */
export const CONNECT_CAN = ['approval_canSeeAddresses', 'approval_canSeeBalances', 'approval_canAskApprove'] as const;
export const CONNECT_CANT = ['approval_cantMoveMoney'] as const;

/** Which key, on which network, a CIP-30 request would sign with. */
export function cardanoSignRows(payload: Partial<CardanoSignApprovalPayload>) {
  const account = payload.accountLabel
    ? payload.accountKind === 'imported'
      ? t('approval_cardanoAccountImported', [payload.accountLabel])
      : payload.accountLabel
    : '—';
  return [
    { label: t('approval_cardanoMethodLabel'), value: payload.method ?? '—' },
    { label: t('approval_cardanoNetworkLabel'), value: payload.cardanoNetwork ?? '—' },
    { label: t('approval_cardanoWalletLabel'), value: payload.walletName ?? '—' },
    { label: t('approval_cardanoAccountLabel'), value: account },
  ];
}

/** What a decoded Cardano transaction does to this wallet, one row per fact. */
export function cardanoTxRows(tx: CardanoTxSummary) {
  const ada = (value: string) => t('approval_cardanoAda', [value]);
  return [
    { label: t('approval_cardanoNetChange'), value: ada(tx.netAda) },
    { label: t('approval_cardanoSpent'), value: ada(tx.spentAda) },
    { label: t('approval_cardanoFee'), value: ada(tx.feeAda) },
    ...tx.outputs.map((out, index) => ({
      label: out.toThisWallet ? t('approval_cardanoOutputOwn', [index + 1]) : t('approval_cardanoOutput', [index + 1]),
      value: out.assets > 0 ? t('approval_cardanoAdaAssets', [out.ada, out.assets]) : ada(out.ada),
      sub: truncateAddress(out.address),
    })),
    ...(tx.foreignInputs > 0 ? [{ label: t('approval_cardanoForeignInputs'), value: String(tx.foreignInputs) }] : []),
    ...(tx.certificates.length > 0
      ? [{ label: t('approval_cardanoCertificates'), value: tx.certificates.join(', '), error: true }]
      : []),
    ...tx.withdrawals.map((w) => ({
      label: t('approval_cardanoWithdrawal'),
      value: ada(w.ada),
      sub: truncateAddress(w.rewardAddress),
      error: !w.own,
    })),
    ...(tx.mintPolicies > 0 ? [{ label: t('approval_cardanoMinting'), value: String(tx.mintPolicies) }] : []),
    {
      label: t('approval_cardanoSignsWith'),
      value: tx.signsWith.length === 0
        ? t('approval_cardanoSignsNothing')
        : tx.signsWith.map((key) => (key === 'stake' ? t('approval_cardanoStakeKey') : t('approval_cardanoPaymentKey'))).join(', '),
    },
  ];
}
