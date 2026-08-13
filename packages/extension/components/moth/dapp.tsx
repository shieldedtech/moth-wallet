import { Check, X } from 'lucide-react';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/ui/cn';

/**
 * Moth + site avatar pair for the dApp connect screen.
 * @category dapp
 */
export function SitePair({ origin }: { origin: string }) {
  const letter = originHost(origin).charAt(0).toUpperCase() || '?';
  return (
    <div className="flex items-center justify-center pt-8">
      <span className="z-10 flex h-11 w-11 items-center justify-center rounded-full bg-secondary font-display font-bold text-primary">
        D
      </span>
      <span className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full bg-muted font-display font-bold text-foreground">
        {letter}
      </span>
    </div>
  );
}

/**
 * White pill with the site's initial and domain (approve screen).
 * @category dapp
 */
export function SiteChip({ origin }: { origin: string }) {
  const host = originHost(origin);
  return (
    <div className="flex justify-center pt-8">
      <span className="flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-1.5 pr-3.5">
        <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-muted font-display text-[12px] font-bold">
          {host.charAt(0).toUpperCase() || '?'}
        </span>
        <span className="text-[13.5px] font-semibold">{host}</span>
      </span>
    </div>
  );
}

export function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * "This site can / it can't" permission cards: green check circles vs
 * red X circles with 14px rows.
 * @category dapp
 */
export function PermissionList({ can, cant }: { can: string[]; cant: string[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      <PermissionCard label={t('dapp_siteCan')} items={can} allowed />
      <PermissionCard label={t('dapp_siteCant')} items={cant} allowed={false} />
    </div>
  );
}

function PermissionCard({ label, items, allowed }: { label: string; items: string[]; allowed: boolean }) {
  return (
    <div className="rounded-[18px] border border-border bg-card p-4">
      <p className="section-label m-0 mb-2.5">{label}</p>
      <div className="flex flex-col gap-2.5">
        {items.map((item) => (
          <div key={item} className="flex items-center gap-2.5 text-sm">
            <span
              className={cn(
                'flex h-[26px] w-[26px] items-center justify-center rounded-full',
                // Status pair — success-tint (not brand accent) so both sides
                // leave the red/green axis together under .colorblind.
                allowed ? 'bg-success-tint text-link' : 'bg-error-tint text-destructive',
              )}
            >
              {allowed ? <Check size={13} strokeWidth={2.5} /> : <X size={13} strokeWidth={2.5} />}
            </span>
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
