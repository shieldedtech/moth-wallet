import { Eye, Moon } from 'lucide-react';
import { cn } from '../../lib/ui/cn';

export type TokenKind = 'night' | 'dust' | 'shielded' | 'unshielded';

/**
 * Token circle: NIGHT = Ink circle with a lime N; shielded and DUST = lime-tint
 * circle with a green moon; other unshielded tokens = lime-tint circle with an
 * eye (the Receive screen's "visible on the network" mark).
 * @category money
 */
export function TokenIcon({ kind, size = 40, className }: { kind: TokenKind; size?: number; className?: string }) {
  if (kind === 'night') {
    return (
      <span
        className={cn('flex items-center justify-center rounded-full bg-secondary font-display font-bold text-primary', className)}
        style={{ width: size, height: size, fontSize: size * 0.33 }}
      >
        N
      </span>
    );
  }
  const Glyph = kind === 'unshielded' ? Eye : Moon;
  return (
    <span
      className={cn(
        // Brand identity, not status: accent-foreground stays green under .colorblind.
        'flex items-center justify-center rounded-full bg-accent text-accent-foreground',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Glyph size={size * 0.42} strokeWidth={2} />
    </span>
  );
}

export function truncateAddress(address: string, head = 8, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
