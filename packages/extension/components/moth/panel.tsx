import { ArrowLeft } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/ui/cn';

/**
 * Side-panel scaffold: scrollable content column plus a CTA slot pinned to
 * the bottom. `dark` marks the always-dark brand moments (welcome/unlock):
 * Midnight Ink navy while the app is light, the neutral dark scheme when
 * the app is dark (navy-on-near-black reads muddy).
 * @category layout
 */
export function PanelScreen({
  children,
  cta,
  dark,
  className,
}: {
  children: ReactNode;
  cta?: ReactNode;
  dark?: boolean;
  className?: string;
}) {
  return (
    // h-screen, not min-h-screen: min-h sets a floor with no ceiling, so content
    // taller than the viewport grew the container past it and pushed the CTA below
    // the fold — the Accounts screen's "New account" button vanished on short
    // windows and only reappeared full-screen. Bounding the height is also what
    // lets the child actually scroll.
    <div className={cn('flex h-screen flex-col bg-background text-foreground', dark && 'ink', className)}>
      {/* min-h-0 is required: a flex child's min-content height otherwise floors
          it, so overflow-y-auto never engages. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">{children}</div>
      {cta && <div className="flex shrink-0 gap-2 px-6 pb-6 pt-2 [&>*]:flex-1">{cta}</div>}
    </div>
  );
}

/**
 * Screen header: 36px sand back circle plus an 18px display-font title.
 * @category layout
 */
export function PanelHeader({ title, onBack, trailing }: { title: string; onBack?: () => void; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-[18px]">
      {onBack && (
        <button
          onClick={onBack}
          className="group flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-muted text-foreground transition duration-150 hover:bg-border active:scale-90"
          aria-label={t('common_back')}
        >
          <ArrowLeft
            size={16}
            strokeWidth={2}
            className="transition-transform duration-150 group-hover:-translate-x-0.5"
          />
        </button>
      )}
      <h1 className="m-0 font-display text-lg font-bold">{title}</h1>
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}

/**
 * Moonlime crescent brand mark (welcome, unlock, setup-complete): a large
 * eclipsed disc opening upper-left, with two planet dots floating in the
 * opening. Planet placement matches the app icon
 * (.context/design/icons/icon.svg), scaled 4/3 for the larger r50 crescent.
 * The lune is drawn thinner than the icon — the crescent thickness equals the
 * cutout's offset from center, so a smaller offset yields a slimmer moon.
 * `planets` overrides the default (shown at sizes 48 and up). Designed for dark
 * surfaces.
 * @category layout
 */
export function Crescent({ size = 105, planets }: { size?: number; planets?: boolean }) {
  const maskId = useId();
  const showPlanets = planets ?? size >= 48;
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden>
      <mask id={maskId}>
        {/* Mask fills are luminance values (keep = white, cut = black), not theme colors. */}
        <circle cx="64" cy="64" r="50" fill="#fff" />
        <circle cx="34" cy="44" r="50" fill="#000" />
      </mask>
      <circle cx="64" cy="64" r="50" fill="var(--primary)" mask={`url(#${maskId})`} />
      {showPlanets && (
        <>
          <circle cx="25.3" cy="22" r="4.7" fill="var(--primary)" opacity="0.85" />
          <circle cx="44" cy="9.3" r="2.7" fill="var(--primary)" opacity="0.5" />
        </>
      )}
    </svg>
  );
}

/**
 * The moth mark: body, antennae, and two wing pairs that beat.
 *
 * Drawn rather than traced from the logo PNG so it stays a few hundred bytes,
 * scales to a 16px favicon without turning to mush, and takes its colour from
 * `--primary` like every other brand surface. The right side is authored once
 * and mirrored, so the two halves cannot drift apart.
 *
 * The wings beat by scaling on X about the body axis, which is what a wingbeat
 * looks like from above — the wing does not rotate, it foreshortens. Motion is
 * cancelled by the global prefers-reduced-motion rule in globals.css.
 * @category layout
 */
export function MothMark({ size = 64, beat = true }: { size?: number; beat?: boolean }) {
  const wingId = useId();
  const wingStyle = beat
    ? {
        transformOrigin: '32px 34px',
        transformBox: 'view-box' as const,
        animation: 'wingbeat 2.4s ease-in-out infinite',
      }
    : undefined;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        {/* One wing pair, mirrored below — a single source of truth for the shape. */}
        <g id={`${wingId}-wing`}>
          <path
            d="M32 27 C 42 19, 54 14, 59 17 C 58 27, 48 37, 33 37 Z"
            fill="var(--primary)"
            opacity="0.9"
          />
          <path
            d="M33 36 C 43 37, 51 43, 49 51 C 43 57, 35 51, 32 43 Z"
            fill="var(--primary)"
            opacity="0.62"
          />
        </g>
      </defs>

      <g style={wingStyle}>
        <use href={`#${wingId}-wing`} />
      </g>
      <g style={wingStyle} transform="translate(64 0) scale(-1 1)">
        <use href={`#${wingId}-wing`} />
      </g>

      {/* Antennae: feathered and swept back, the detail that reads "moth" rather
          than "butterfly" even at small sizes. */}
      <path
        d="M30 24 C 26 18, 22 15, 18 13"
        stroke="var(--primary)"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.75"
      />
      <path
        d="M34 24 C 38 18, 42 15, 46 13"
        stroke="var(--primary)"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.75"
      />

      <ellipse cx="32" cy="37" rx="3.1" ry="12" fill="var(--primary)" />
      <circle cx="32" cy="25" r="3.4" fill="var(--primary)" />
    </svg>
  );
}

/**
 * Startup treatment: a moth circling the crescent.
 *
 * Same orbit-and-glow system as before — the rings, the blur, the pulse are
 * unchanged — but the thing travelling the outer ring is now the moth, and the
 * crescent it circles is the light drawing it in. That is the one composition
 * where the mark and the motion mean the same thing, so it replaces the bare
 * dot rather than sitting beside it.
 *
 * The moth counter-rotates against its ring: carried by a spinning parent it
 * would cartwheel, and a moth on its back reads as a dead one.
 * @category layout
 */
export function OrbitingMoth({
  size = 176,
  crescentSize = Math.round(size * 0.52),
}: {
  size?: number;
  crescentSize?: number;
}) {
  const mothSize = Math.max(18, Math.round(size * 0.17));
  return (
    <div className="relative shrink-0" style={{ height: size, width: size }} aria-hidden>
      <div
        className="pointer-events-none absolute -inset-[18%] rounded-full opacity-45 blur-3xl"
        style={{
          background:
            'radial-gradient(circle, color-mix(in srgb, var(--primary) 38%, transparent) 0%, transparent 68%)',
        }}
      />
      <div className="absolute inset-0 rounded-full border border-white/8" />

      {/* Outer ring carries the moth. */}
      <div className="absolute inset-[7%] animate-[spin_10s_linear_infinite] rounded-full border border-white/12">
        <span
          className="absolute left-1/2 top-0 flex animate-[spin_10s_linear_infinite_reverse] items-center justify-center"
          style={{ height: mothSize, width: mothSize, marginLeft: -mothSize / 2, marginTop: -mothSize / 2 }}
        >
          <MothMark size={mothSize} />
        </span>
      </div>

      {/* Inner ring keeps its dot: two moths would read as clutter at 176px. */}
      <div className="absolute inset-[18%] animate-[spin_7s_linear_infinite_reverse] rounded-full border border-dashed border-white/14">
        <span className="absolute left-[85.35%] top-[85.35%] h-[5%] w-[5%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/65" />
      </div>

      <div className="absolute inset-0 flex animate-pulse items-center justify-center">
        <Crescent size={crescentSize} planets={false} />
      </div>
    </div>
  );
}
