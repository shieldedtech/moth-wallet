import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, LoaderCircle, Moon, X } from 'lucide-react';
import { cn } from '../../lib/ui/cn';
import type { ActivityIcon, ActivityRowView } from '../../lib/ui/activity-view';

const ICONS: Record<ActivityIcon, typeof ArrowUpRight> = {
  sent: ArrowUpRight,
  received: ArrowDownLeft,
  swap: ArrowLeftRight,
  dust: Moon,
  pending: LoaderCircle,
  failed: X,
};

/**
 * One activity feed row (8c and Home's recent list): 36px sand icon circle,
 * title + when, signed amount on the right (green when value came in, muted
 * while pending or after a failure).
 * @category money
 */
export function ActivityRow({ view }: { view: ActivityRowView }) {
  const Icon = ICONS[view.icon];
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          view.icon === 'failed' ? 'bg-error-tint text-destructive' : 'bg-muted text-foreground',
        )}
      >
        <Icon size={15} strokeWidth={2} className={view.icon === 'pending' ? 'animate-spin' : undefined} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{view.title}</span>
        {view.sub && <span className="block text-[12.5px] text-muted-foreground">{view.sub}</span>}
      </span>
      {view.amount && (
        <span
          className={cn(
            'shrink-0 text-[13px] font-semibold',
            view.tone === 'positive' && 'text-success',
            view.tone === 'muted' && 'text-muted-foreground',
          )}
        >
          {view.amount}
        </span>
      )}
    </div>
  );
}
