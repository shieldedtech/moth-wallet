import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/ui/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}

/**
 * Text input: h-12, rounded-2xl, white bg; focus = ink border, no ring.
 * `mono` for addresses/code, `invalid` for the error state (red border).
 * @category core
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, mono, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        // Constant 1px border (color-only focus) — bumping the width on focus
        // nudges the text by half a pixel, which reads as a flicker.
        'h-12 w-full rounded-2xl border border-input bg-card px-4 text-foreground transition-colors duration-150 placeholder:text-muted-foreground',
        'focus:outline-none focus:border-foreground',
        mono && 'font-mono text-sm',
        invalid && 'border-error-border focus:border-destructive',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
