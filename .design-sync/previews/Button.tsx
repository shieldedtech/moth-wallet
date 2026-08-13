import { Button } from '@shieldedtech/moth-extension';
import { ArrowDown, ArrowUp } from 'lucide-react';

export const PrimaryCta = () => (
  <Button size="lg" className="w-full">
    Review transfer
  </Button>
);

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>
      <ArrowUp size={15} strokeWidth={2.5} /> Send
    </Button>
    <Button variant="secondary">
      <ArrowDown size={15} strokeWidth={2.5} /> Receive
    </Button>
    <Button variant="outline">Cancel</Button>
    <Button variant="ghost">View in activity</Button>
    <Button variant="soft-destructive">Remove</Button>
  </div>
);

export const AmountChips = () => (
  <div className="flex gap-2">
    <Button variant="chip" size="sm">25%</Button>
    <Button variant="chip" size="sm">50%</Button>
    <Button variant="chip" size="sm">Max</Button>
  </div>
);

export const Disabled = () => (
  <Button size="lg" className="w-full" disabled>
    Waiting for DUST · ~12 min
  </Button>
);
