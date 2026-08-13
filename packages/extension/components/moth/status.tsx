import { Check, LoaderCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/ui/cn';

/**
 * Centered status moment: 88px circle (lime check, red-tint X, or spinner)
 * plus a 30px display-font title and optional sub line.
 * @category feedback
 */
export function StatusHero({
  state,
  title,
  sub,
}: {
  state: 'success' | 'failure' | 'pending';
  title: string;
  sub?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 pt-12 text-center">
      <span
        className={cn(
          'flex h-[88px] w-[88px] items-center justify-center rounded-full',
          state === 'success' && 'bg-primary text-primary-foreground',
          state === 'failure' && 'bg-error-tint text-destructive',
          state === 'pending' && 'bg-muted text-foreground',
        )}
      >
        {state === 'success' && <Check size={36} strokeWidth={2.5} />}
        {state === 'failure' && <X size={36} strokeWidth={2.5} />}
        {state === 'pending' && <LoaderCircle size={36} strokeWidth={2.5} className="animate-spin" />}
      </span>
      <h1 className="m-0 font-display text-[30px] font-extrabold leading-tight">{title}</h1>
      {sub && <p className="m-0 text-[14.5px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export type StepState = 'done' | 'active' | 'todo';

/**
 * Pending-state checklist: done (lime check circle), active (spinner), todo
 * (sand ring at 45% opacity), with optional sub lines.
 * @category feedback
 */
export function StepChecklist({ steps }: { steps: Array<{ label: string; sub?: string; state: StepState }> }) {
  return (
    <div className="flex flex-col gap-4">
      {steps.map((step) => (
        <div key={step.label} className="flex items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full',
              step.state === 'done' && 'bg-primary text-primary-foreground',
              step.state === 'active' && 'text-foreground',
              step.state === 'todo' && 'border border-muted',
            )}
          >
            {step.state === 'done' && <Check size={14} strokeWidth={2.5} />}
            {step.state === 'active' && <LoaderCircle size={20} strokeWidth={2} className="animate-spin" />}
          </span>
          <span className={cn(step.state === 'todo' && 'opacity-45')}>
            <span className="block text-sm font-semibold">{step.label}</span>
            {step.sub && <span className="block text-[12.5px] text-muted-foreground">{step.sub}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Label/value rows card (fees, tx summaries): 13.5px rows, optional row sub
 * lines, optional bold total row and footnote.
 * @category money
 */
export function DetailCard({
  rows,
  footnote,
  total,
}: {
  rows: Array<{ label: string; value: ReactNode; sub?: string; mono?: boolean; error?: boolean }>;
  footnote?: string;
  total?: { label: string; value: string };
}) {
  return (
    <div className="rounded-[18px] border border-border bg-card p-3.5">
      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 text-[13.5px]">
            <span className="text-muted-foreground">
              {row.label}
              {row.sub && <span className="block text-[11.5px]">{row.sub}</span>}
            </span>
            <span className={cn('text-right font-medium', row.mono && 'font-mono text-[13px]', row.error && 'text-destructive')}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
      {total && (
        <>
          <div className="my-2.5 h-px bg-muted" />
          <div className="flex items-baseline justify-between text-[13.5px] font-bold">
            <span>{total.label}</span>
            <span>{total.value}</span>
          </div>
        </>
      )}
      {footnote && <p className="mb-0 mt-2.5 text-xs text-muted-foreground">{footnote}</p>}
    </div>
  );
}
