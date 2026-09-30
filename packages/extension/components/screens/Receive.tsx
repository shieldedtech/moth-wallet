// 2f/8f Receive — shielded/unshielded/DUST tabs, QR card, copy → toast.
//
// The DUST tab is deliberately not a "receive" in the transfer sense: DUST
// cannot be sent, so nobody can pay you at this address. It is here because it
// is still the address that answers "where does my DUST go?", and it has to be
// copyable — registering another wallet's NIGHT, or a Cardano stake key, to
// generate DUST *to this wallet* takes exactly this value. It had no home in
// the extension at all, while the TUI showed it on the keys screen.

import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Eye, Fuel, Moon } from 'lucide-react';
import { t } from '../../lib/i18n';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { NoteCard } from '../moth/note-card';
import { truncateAddress } from '../moth/token';
import { accountLabel } from '../../lib/ui/format';
import type { SessionStatus } from '../../lib/messaging/protocol';

/** Middle-truncate a bech32m address, keeping the full human-readable prefix. */
function displayAddress(address: string): string {
  const sep = address.indexOf('1');
  return truncateAddress(address, sep > 0 ? sep + 1 : 10, 6);
}

export function Receive({ status, onBack }: { status: SessionStatus; onBack: () => void }) {
  const [tab, setTab] = useState<'shielded' | 'unshielded' | 'dust'>('unshielded');

  const addressFor = (kind: typeof tab): string => {
    const role = kind === 'shielded' ? 'zswap' : kind === 'dust' ? 'dust' : 'nightExternal';
    const encoded = status.addresses?.[role]?.bech32m ?? {};
    return encoded[status.network] ?? Object.values(encoded)[0] ?? '';
  };
  const address = addressFor(tab);

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    toast(t('receive_addressCopied'));
  };

  return (
    <PanelScreen>
      <PanelHeader title={t('receive_title')} onBack={onBack} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="unshielded">{t('receive_unshieldedTab')}</TabsTrigger>
          <TabsTrigger value="shielded">{t('receive_shieldedTab')}</TabsTrigger>
          <TabsTrigger value="dust">{t('receive_dustTab')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card className="rounded-[24px] p-6">
        <div className="flex flex-col items-center gap-4">
          {/* The QR keeps literal dark-on-white colors in both themes — scanners
              need the contrast — so it sits on its own white plate. */}
          <div className="relative rounded-2xl bg-white p-3">
            {address && <QRCodeSVG value={address} size={216} bgColor="#ffffff" fgColor="#1C1F36" />}
            <span
              className={`absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full ring-4 ring-white ${
                tab === 'shielded' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'
              }`}
            >
              {tab === 'shielded' ? <Moon size={22} strokeWidth={2} />
                : tab === 'dust' ? <Fuel size={22} strokeWidth={2} />
                : <Eye size={22} strokeWidth={2} />}
            </span>
          </div>
          <p className="m-0 font-display text-[15px] font-bold">
            {t(tab === 'shielded' ? 'receive_shieldedAddressOf'
              : tab === 'dust' ? 'receive_dustAddressOf'
              : 'receive_unshieldedAddressOf', [
              accountLabel(status.walletName ?? '', status.walletLabel),
            ])}
          </p>
          <p className="m-0 font-mono text-[13px] text-muted-foreground">
            {address ? displayAddress(address) : t('receive_addressUnavailable')}
          </p>
          <Button variant="secondary" className="w-full" disabled={!address} onClick={() => void copy()}>
            {t('receive_copyAddress')}
          </Button>
        </div>
      </Card>

      {tab === 'shielded' ? (
        <NoteCard icon={Moon}>{t('receive_shieldedNote')}</NoteCard>
      ) : tab === 'dust' ? (
        <NoteCard variant="neutral" icon={Fuel}>
          {t('receive_dustNote')}
        </NoteCard>
      ) : (
        <NoteCard variant="neutral" icon={Eye}>
          {t('receive_unshieldedNote')}
        </NoteCard>
      )}
    </PanelScreen>
  );
}
