import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/ui/cn';

/**
 * White card, 18px radius, hairline border, no shadow. Use p-0 plus rows and
 * Separator for list cards. Dark surfaces drop the hairline — the lifted
 * card tone alone separates it (border stays, transparent, so layout holds).
 * @category core
 */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-[18px] border border-border bg-card text-card-foreground dark:border-transparent',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

/**
 * 1px sand row separator, inset 16px, for rows inside list cards.
 * @category core
 */
export function Separator({ className }: { className?: string }) {
  return <div className={cn('mx-4 h-px bg-muted', className)} />;
}

/**
 * Lime-tint pill badge (e.g. "First time connecting", "Shielded").
 * @category core
 */
export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-accent px-2.5 py-1 text-[10.5px] font-semibold text-accent-foreground',
        className,
      )}
      {...props}
    />
  );
}
