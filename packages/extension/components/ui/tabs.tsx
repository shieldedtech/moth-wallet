import * as TabsPrimitive from '@radix-ui/react-tabs';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/ui/cn';

/**
 * Pill tab switcher (Radix Tabs themed): TabsList is a sand rounded-full
 * track; the active TabsTrigger becomes an Ink pill. Used for the Receive
 * shielded/unshielded address switch.
 * @category core
 */
export const Tabs = TabsPrimitive.Root;

/**
 * Sand rounded-full track holding the triggers.
 * @category core
 */
export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('inline-flex w-full rounded-full bg-muted p-1', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

/**
 * One tab pill; active state renders Ink with white text.
 * @category core
 */
export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex-1 rounded-full py-2 text-[13px] font-semibold text-muted-foreground transition-colors cursor-pointer',
      'data-[state=active]:bg-secondary data-[state=active]:text-secondary-foreground',
      // Dark marks the active pill with solid Moonlime (selection language),
      // matching the Settings theme highlighter.
      'dark:data-[state=active]:bg-primary dark:data-[state=active]:text-primary-foreground',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

/**
 * Per-tab content region (unstyled Radix passthrough).
 * @category core
 */
export const TabsContent = TabsPrimitive.Content;
