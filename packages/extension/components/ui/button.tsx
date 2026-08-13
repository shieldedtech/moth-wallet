import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { cn } from '../../lib/ui/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition duration-150 ease-out cursor-pointer active:scale-[0.97] disabled:cursor-default disabled:bg-disabled-fill disabled:text-disabled-text/55 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/70',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:brightness-95',
        secondary: 'bg-secondary text-secondary-foreground hover:opacity-90',
        outline: 'border-[1.5px] border-foreground bg-transparent text-foreground hover:bg-muted/60',
        ghost: 'bg-transparent text-link hover:bg-accent',
        'soft-destructive': 'bg-error-tint text-destructive hover:brightness-95',
        chip: 'bg-muted text-foreground hover:bg-border',
      },
      size: {
        lg: 'h-14 px-6 text-[15px]',
        default: 'h-12 px-5 text-sm',
        sm: 'h-9 px-3.5 text-[13px]',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Async-in-progress state. Keeps the button's variant colors (so it doesn't
   * flash to the disabled fill mid-press), shows a spinner, and blocks further
   * clicks. Use this for busy/submitting instead of folding it into `disabled`,
   * which would trigger the disabled styling the instant the button is pressed.
   */
  loading?: boolean;
}

/**
 * Pill button. Variants: default (Moonlime), secondary (Ink), outline, ghost
 * (green text link), soft-destructive (only in remove dialogs), chip (sand).
 * Sizes: lg h-14 (primary CTA), default h-12, sm h-9 (chips), icon.
 * One primary per screen, pinned to the panel bottom.
 * @category core
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', loading = false, disabled, onClick, children, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      // `disabled` stays for the genuine "can't act yet" state (its sand
      // styling is intended there). While `loading` we keep the button
      // enabled-looking but inert, so pressing it never flickers to that fill.
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? undefined : onClick}
      className={cn(buttonVariants({ variant, size }), loading && 'pointer-events-none', className)}
      {...props}
    >
      {loading && <LoaderCircle size={16} strokeWidth={2.5} className="animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
