// Address book management: a named list of shielded / unshielded / DUST
// addresses, offered as recipient/receiver choices in Send and DUST designation
// (see the AddressPicker). The kind is auto-detected from the address, so the
// user only supplies a name and the address itself.

import { useState } from 'react';
import { Ellipsis } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { t } from '../../lib/i18n';
import { useAddressBook } from '../../lib/ui/client';
import { addressKind, addressKindLabel, isValidAddress, type AddressKind } from '../../lib/ui/address';
import type { AddressBookEntry } from '../../lib/background/address-book';
import { Button } from '../ui/button';
import { Card, Separator } from '../ui/card';
import { Input } from '../ui/input';
import { DialogShell } from '../ui/dialog';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { truncateAddress } from '../moth/token';

type Editing = { entry?: AddressBookEntry } | null;

export function AddressBook({ onBack }: { onBack: () => void }) {
  const { entries, save, remove } = useAddressBook();
  const [editing, setEditing] = useState<Editing>(null);

  return (
    <PanelScreen cta={<Button size="lg" onClick={() => setEditing({})}>{t('addressBook_addAddress')}</Button>}>
      <PanelHeader title={t('addressBook_title')} onBack={onBack} />
      <p className="m-0 text-[13px] text-muted-foreground">
        {t('addressBook_intro')}
      </p>

      {entries.length === 0 ? (
        <Card className="p-0">
          <p className="m-0 px-4 py-[15px] text-[12.5px] text-muted-foreground">
            {t('addressBook_empty')}
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          {entries.map((entry, index) => (
            <div key={entry.id}>
              {index > 0 && <Separator />}
              <div className="flex items-center gap-3 px-4 py-[13px]">
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">{entry.name}</span>
                    <KindBadge kind={entry.kind} />
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {truncateAddress(entry.address)}
                  </span>
                </span>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent transition duration-150 hover:bg-muted active:scale-90"
                      aria-label={t('addressBook_actionsFor', [entry.name])}
                    >
                      <Ellipsis size={16} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      className="w-40 rounded-[14px] border border-border bg-card p-1.5 shadow-pop"
                    >
                      <MenuItem label={t('addressBook_edit')} onClick={() => setEditing({ entry })} />
                      <MenuItem label={t('addressBook_delete')} destructive onClick={() => void remove(entry.id)} />
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </div>
          ))}
        </Card>
      )}

      {editing && (
        <EntryDialog
          entry={editing.entry}
          onCancel={() => setEditing(null)}
          onSave={async (data) => {
            await save(data);
            setEditing(null);
          }}
        />
      )}
    </PanelScreen>
  );
}

function KindBadge({ kind }: { kind: AddressKind }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-1.5 text-[10px] font-bold tracking-[0.02em] text-muted-foreground">
      {addressKindLabel(kind)}
    </span>
  );
}

function EntryDialog({
  entry,
  onCancel,
  onSave,
}: {
  entry?: AddressBookEntry;
  onCancel: () => void;
  onSave: (data: { id?: string; name: string; address: string; kind: AddressKind }) => Promise<void>;
}) {
  const [name, setName] = useState(entry?.name ?? '');
  const [address, setAddress] = useState(entry?.address ?? '');
  const [saving, setSaving] = useState(false);

  // Classify by prefix, then require a valid bech32m checksum: a typo'd
  // address (right prefix, bad checksum) is treated as unrecognized so it
  // can't be saved and fail later at send time.
  const prefixKind = addressKind(address);
  const kind = prefixKind && isValidAddress(prefixKind, address) ? prefixKind : null;
  const addressTouched = address.trim().length > 0;
  const valid = name.trim().length > 0 && kind !== null;

  const save = () => {
    if (!valid || !kind) return;
    setSaving(true);
    void onSave({ id: entry?.id, name, address, kind });
  };

  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onCancel()}
      title={entry ? t('addressBook_editTitle') : t('addressBook_addTitle')}
      actions={
        <>
          <Button variant="outline" onClick={onCancel}>{t('common_cancel')}</Button>
          <Button disabled={!valid} loading={saving} onClick={save}>{t('common_save')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold uppercase tracking-wide">{t('addressBook_name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={t('addressBook_namePlaceholder')} autoFocus />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold uppercase tracking-wide">{t('addressBook_address')}</span>
          <Input
            mono
            value={address}
            invalid={addressTouched && kind === null}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t('addressBook_addressPlaceholder')}
            aria-label={t('addressBook_addressAria')}
          />
        </label>
        <p className="m-0 text-[12px]">
          {kind
            ? t('addressBook_detected', [addressKindLabel(kind)])
            : addressTouched
              ? t('addressBook_notMidnight')
              : t('addressBook_autoRecognized')}
        </p>
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
