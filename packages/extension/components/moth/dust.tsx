import { ChevronRight, LoaderCircle, Moon } from 'lucide-react';
import { t } from '../../lib/i18n';
import type { DustView } from '../../lib/ui/dust-view';
import {
  DUST_WALLET_LABEL,
  type NativeAssetLabels,
} from '../../lib/ui/token-labels';

/**
 * Ink card showing the DUST level: moon icon, current of max, Moonlime
 * progress bar, percent and ETA captions. The whole card is a button.
 * While the dust sub-wallet syncs, a translucent overlay dims the moving
 * numbers so they read as provisional.
 * @category money
 */
export function DustMeterCard({
  view,
  labels,
  onOpen,
}: {
  view: DustView;
  /** Required deliberately: defaulting to testnet labels renders tNIGHT/tDUST
   *  on mainnet, and does it silently. A missing prop should not compile. */
  labels: NativeAssetLabels;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      aria-busy={view.syncing}
      className="group relative w-full cursor-pointer rounded-[18px] border-0 bg-secondary p-4 text-left text-secondary-foreground transition duration-150 hover:brightness-110 active:scale-[0.99]"
    >
      {view.syncing && (
        <span className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-[18px] bg-secondary/80 text-[13px] font-semibold backdrop-blur-[2px]">
          <LoaderCircle size={15} strokeWidth={2.5} className="animate-spin text-primary" />
          {t('dust_syncingWallet', [DUST_WALLET_LABEL])}
        </span>
      )}
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/25 text-primary">
          <Moon size={16} strokeWidth={2} />
        </span>
        <span className="flex-1">
          <span className="block text-sm font-semibold">{labels.dust}</span>
          <span className="block text-xs text-white/60">{t('dust_paysYourFees')}</span>
        </span>
        <span className="text-sm font-semibold">
          {view.current} <span className="text-white/50">{t('dust_ofMax', [view.max])}</span>
        </span>
        <ChevronRight
          size={16}
          className="text-white/50 transition-transform duration-150 group-hover:translate-x-0.5"
        />
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/16">
        <div className="h-full rounded-full bg-primary" style={{ width: `${view.percent}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-white/60">
        <span>{t('dust_percentGenerated', [view.percent])}</span>
        <span>{view.etaText}</span>
      </div>
    </button>
  );
}

/**
 * 196px conic ring gauge: Moonlime arc on sand, moon icon plus the current
 * amount in the center.
 * @category money
 */
export function DustRingGauge({
  view,
  labels,
}: {
  view: DustView;
  /** Required deliberately: defaulting to testnet labels renders tNIGHT/tDUST
   *  on mainnet, and does it silently. A missing prop should not compile. */
  labels: NativeAssetLabels;
}) {
  const angle = (view.percent / 100) * 360;
  // Bricolage Grotesque extrabold runs ~0.62em per tabular digit; scale the
  // headline down for longer amounts so it stays inside the 160px inner circle
  // instead of spilling across the ring.
  const amountPx = Math.min(38, Math.floor(152 / (Math.max(1, view.current.length) * 0.62)));
  return (
    <div
      className="mx-auto flex h-[196px] w-[196px] items-center justify-center rounded-full"
      style={{ background: `conic-gradient(var(--primary) ${angle}deg, var(--muted) ${angle}deg)` }}
    >
      <div className="flex h-[160px] w-[160px] flex-col items-center justify-center gap-1 rounded-full bg-background px-3">
        {/* Brand glyph, not a link: must stay green under .colorblind. */}
        <Moon size={18} strokeWidth={2} className="text-accent-foreground" />
        <span
          className="font-display font-extrabold leading-none tabular-nums whitespace-nowrap"
          style={{ fontSize: `${amountPx}px` }}
        >
          {view.current}
        </span>
        <span className="max-w-full text-center text-[12.5px] text-muted-foreground">{t('dust_ofMaxWithLabel', [view.max, labels.dust])}</span>
      </div>
    </div>
  );
}
