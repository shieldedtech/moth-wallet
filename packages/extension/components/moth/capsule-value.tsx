// A contract value in the panel's own idiom, from the blueprint's presentation of it by type: a
// number with its digits grouped, a flag or an enum member as a pill, bytes and addresses as a
// truncated hash with a copy button, a Maybe's nothing in words, and collections, structs and
// maps as nested rows. Nothing here knows the language's types; the presenter did that.

import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import type { Presented } from '@shieldedtech/capsule-blueprint';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/ui/cn';
import { Badge } from '../ui/card';
import { truncateAddress } from './token';

/** Digits beyond this are a field element or a hash in disguise: shown truncated, copied whole. */
const GROUPED_DIGITS = 24;

/** Whether a presented value fits on the row's own line, or needs rows of its own below it. */
export function isInline(value: Presented): boolean {
  return value.kind !== 'items' && value.kind !== 'fields' && value.kind !== 'pairs';
}

function copy(value: string): void {
  void navigator.clipboard.writeText(value).then(() => toast(t('capsule_valueCopied')));
}

function Copyable({ shown, whole }: { shown: string; whole: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[13px]" title={whole}>
      {shown}
      <button
        type="button"
        onClick={() => copy(whole)}
        aria-label={t('capsule_valueCopy')}
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition hover:bg-muted active:scale-90"
      >
        <Copy size={12} />
      </button>
    </span>
  );
}

/** A scalar on one line. */
function Inline({ value }: { value: Presented }) {
  switch (value.kind) {
    case 'number':
      return value.text.length > GROUPED_DIGITS ? (
        <Copyable shown={truncateAddress(value.text, 8, 6)} whole={value.text} />
      ) : (
        <span className="font-mono text-[13px]">{BigInt(value.text).toLocaleString('en-US')}</span>
      );
    case 'flag':
      return value.value ? (
        <Badge>{t('capsule_valueYes')}</Badge>
      ) : (
        <Badge className="bg-muted text-muted-foreground">{t('capsule_valueNo')}</Badge>
      );
    case 'name':
      return <Badge>{value.text}</Badge>;
    case 'hex':
      return value.hex === '' ? (
        <span className="text-[13px] text-muted-foreground">{t('capsule_valueEmptyBytes')}</span>
      ) : (
        <Copyable shown={truncateAddress(value.hex, 10, 6)} whole={value.hex} />
      );
    case 'text':
      return <span className={cn('break-all text-[13px]', value.mono && 'font-mono')}>{value.text}</span>;
    case 'none':
      return <span className="text-[13px] italic text-muted-foreground">{t('capsule_valueNone')}</span>;
    default:
      return null;
  }
}

/** Rows below a label: each element, field or pair of a compound value, nested as deep as it goes. */
function Rows({ value, depth }: { value: Presented; depth: number }) {
  const entries: Array<{ key: string; label: string; muted?: boolean; value: Presented }> =
    value.kind === 'items'
      ? value.items.map((item, i) => ({ key: String(i), label: `#${i}`, muted: true, value: item }))
      : value.kind === 'fields'
        ? value.fields.map((field) => ({ key: field.name, label: field.name, value: field.value }))
        : value.kind === 'pairs'
          ? value.pairs.map((pair, i) => ({ key: String(i), label: keyText(pair.key), value: pair.value }))
          : [];
  if (entries.length === 0) {
    return <span className="block text-[13px] italic text-muted-foreground">{t('capsule_valueEmpty')}</span>;
  }
  return (
    <div className={cn('flex flex-col gap-1.5', depth > 0 && 'border-l-2 border-muted pl-3')}>
      {entries.map((entry) => (
        <div key={entry.key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className={cn('text-[13px]', entry.muted ? 'text-muted-foreground' : 'font-medium')}>{entry.label}</span>
            {isInline(entry.value) ? (
              <span className="text-right">
                <Inline value={entry.value} />
              </span>
            ) : (
              <span className="text-[12px] text-muted-foreground">{countOf(entry.value)}</span>
            )}
          </div>
          {isInline(entry.value) ? null : <Rows value={entry.value} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
}

/** A map's key as a row label: a number or a name as itself, bytes truncated, anything else as text. */
function keyText(key: Presented): string {
  switch (key.kind) {
    case 'number':
      return key.text.length > GROUPED_DIGITS ? truncateAddress(key.text, 8, 6) : BigInt(key.text).toLocaleString('en-US');
    case 'name':
    case 'text':
      return key.text;
    case 'hex':
      return truncateAddress(key.hex, 10, 6);
    case 'flag':
      return key.value ? t('capsule_valueYes') : t('capsule_valueNo');
    case 'none':
      return t('capsule_valueNone');
    default:
      return countOf(key);
  }
}

/** What a compound value says beside its label: how many of what it holds. */
export function countOf(value: Presented): string {
  switch (value.kind) {
    case 'items':
      return t('capsule_valueItems', [value.items.length]);
    case 'pairs':
      return t('capsule_valueEntries', [value.pairs.length]);
    case 'fields':
      return t('capsule_valueFields', [value.fields.length]);
    default:
      return '';
  }
}

/**
 * One value: inline when it is a scalar, as nested rows otherwise. The caller lays out the label;
 * `isInline` tells it which of the two it is getting.
 */
export function CapsuleValue({ value }: { value: Presented }) {
  return isInline(value) ? <Inline value={value} /> : <Rows value={value} depth={0} />;
}
