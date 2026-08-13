import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/ui/cn';

const VARIANTS = {
  info: { card: 'bg-accent text-accent-foreground', circle: 'bg-primary/60 text-accent-foreground' },
  neutral: {
    // Dark trades the sand-on-sand monotone for the lime family.
    card: 'bg-muted text-foreground dark:bg-accent dark:text-accent-foreground',
    circle: 'bg-secondary text-secondary-foreground dark:text-primary',
  },
  error: { card: 'bg-error-tint text-error-text', circle: 'bg-destructive/15 text-destructive' },
} as const;

/**
 * Note card: info (lime tint), neutral (sand), error (red tint); leading
 * icon in a colored circle, 13px body. No left-border accent, no title.
 * @category core
 */
export function NoteCard({
  variant = 'info',
  icon: Icon,
  children,
  className,
}: {
  variant?: keyof typeof VARIANTS;
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  const styles = VARIANTS[variant];
  return (
    <div className={cn('flex items-start gap-3 rounded-[14px] p-3.5', styles.card, className)}>
      <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', styles.circle)}>
        <Icon size={14} strokeWidth={2} />
      </span>
      <p className="m-0 text-[13px] leading-[1.4]">{children}</p>
    </div>
  );
}
