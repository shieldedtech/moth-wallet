import * as DialogPrimitive from '@radix-ui/react-dialog';
import { type ReactNode } from 'react';
import { cn } from '../../lib/ui/cn';

/**
 * Modal dialog: 20px radius on the paper background, display-font title,
 * ink-tint overlay, equal-width action button pair (e.g. Cancel / Save).
 * @category core
 */
export function DialogShell({
  open,
  onOpenChange,
  title,
  children,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-overlay" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 w-[min(88vw,340px)] -translate-x-1/2 -translate-y-1/2',
            'rounded-[20px] bg-background p-5 shadow-pop focus:outline-none',
          )}
        >
          <DialogPrimitive.Title className="font-display text-xl font-extrabold">{title}</DialogPrimitive.Title>
          {children && <div className="mt-2 text-[13.5px] text-muted-foreground">{children}</div>}
          <div className="mt-5 flex gap-2 [&>*]:flex-1">{actions}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
