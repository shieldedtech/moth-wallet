// Recipient/receiver field: type an address, paste one, or pick a saved one of
// the matching kind from the address book. Shared by the Send flow (per line)
// and the DUST designation dialog. Validation of the shape stays with the
// caller (it knows which kind is required); this only surfaces the choices.

import { useState } from 'react';
import { BookUser } from 'lucide-react';
import { t } from '../../lib/i18n';
import { addressKindLabel, type AddressKind } from '../../lib/ui/address';
import type { AddressBookEntry } from '../../lib/background/address-book';
import { Input } from '../ui/input';
import { DialogShell } from '../ui/dialog';
import { Button } from '../ui/button';
import { truncateAddress } from './token';

export function AddressPicker({
  kind,
  value,
  onChange,
  entries,
  invalid,
  placeholder,
  autoFocus,
  ariaLabel,
}: {
  /** Only entries of this kind are offered, and pasted text is not filtered. */
  kind: AddressKind;
  value: string;
  onChange: (value: string) => void;
  entries: AddressBookEntry[];
  invalid?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const matching = entries.filter((e) => e.kind === kind);
  const matched = matching.find((e) => e.address.trim() === value.trim());

  const paste = async () => {
    try {
      onChange((await navigator.clipboard.readText()).trim());
    } catch {
      /* clipboard denied */
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Input
          mono
          invalid={invalid}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          className="pr-16"
        />
        <button
          type="button"
          onClick={() => void paste()}
          className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer border-0 bg-transparent text-[13px] font-semibold text-link"
        >
          {t('addressBook_paste')}
        </button>
      </div>
      <div className="flex min-h-[18px] items-center justify-between gap-2">
        {matched ? (
          <span className="truncate text-[12.5px] text-success">✓ {matched.name}</span>
        ) : (
          <span />
        )}
        {matching.length > 0 && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex shrink-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[13px] font-semibold text-link"
          >
            <BookUser size={14} strokeWidth={2.25} />
            {t('addressBook_openPicker')}
          </button>
        )}
      </div>

      {pickerOpen && (
        <PickerDialog
          kind={kind}
          entries={matching}
          onCancel={() => setPickerOpen(false)}
          onSelect={(address) => {
            onChange(address);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

function PickerDialog({
  kind,
  entries,
  onSelect,
  onCancel,
}: {
  kind: AddressKind;
  entries: AddressBookEntry[];
  onSelect: (address: string) => void;
  onCancel: () => void;
}) {
  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onCancel()}
      title={t('addressBook_pickerTitle', [addressKindLabel(kind)])}
      actions={<Button variant="outline" onClick={onCancel}>{t('common_cancel')}</Button>}
    >
      <div className="-mx-1 max-h-[50vh] overflow-y-auto px-1">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelect(entry.address)}
            className="flex w-full flex-col items-start gap-0.5 rounded-xl border-0 bg-transparent px-2.5 py-2.5 text-left transition-colors hover:bg-muted"
          >
            <span className="truncate text-sm font-semibold text-foreground">{entry.name}</span>
            <span className="block truncate font-mono text-[12px] text-muted-foreground">
              {truncateAddress(entry.address)}
            </span>
          </button>
        ))}
      </div>
    </DialogShell>
  );
}
