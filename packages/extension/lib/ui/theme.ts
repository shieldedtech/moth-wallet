// Appearance: two independent axes applied as classes on <html>.
// - `dark` — color scheme, either forced or following the OS. The always-dark
//   brand moments (PanelScreen's `dark` prop, setup tab) carry the separate
//   `ink` class: Midnight Ink navy while the scheme is light, deferring to
//   the neutral dark palette when the scheme is dark.
// - `colorblind` — swaps red/green status hues for Okabe–Ito blue/vermillion
//   (see globals.css), composing with either scheme.
//
// Persisted in localStorage (shared by the side panel, setup tab and approval
// window — same extension origin) so it applies synchronously at boot with no
// flash, and syncs to other open extension pages via the storage event.

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Appearance {
  theme: ThemePreference;
  colorblind: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', colorblind: false };

const STORAGE_KEY = 'appearance';

/** Tolerant parse of a persisted appearance value (bad data → defaults). */
export function parseAppearance(raw: string | null): Appearance {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_APPEARANCE;
    const candidate = parsed as Partial<Appearance>;
    return {
      theme: candidate.theme === 'light' || candidate.theme === 'dark' ? candidate.theme : 'system',
      colorblind: candidate.colorblind === true,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** The <html> classes an appearance resolves to. Pure — unit-testable. */
export function resolveClasses(
  appearance: Appearance,
  systemDark: boolean,
): { dark: boolean; colorblind: boolean } {
  return {
    dark: appearance.theme === 'dark' || (appearance.theme === 'system' && systemDark),
    colorblind: appearance.colorblind,
  };
}

export function loadAppearance(): Appearance {
  // localStorage is absent outside extension pages (e.g. the node test env).
  if (typeof localStorage === 'undefined') return DEFAULT_APPEARANCE;
  return parseAppearance(localStorage.getItem(STORAGE_KEY));
}

export function saveAppearance(appearance: Appearance): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  apply();
}

function systemMedia(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

function apply(): void {
  const classes = resolveClasses(loadAppearance(), systemMedia().matches);
  document.documentElement.classList.toggle('dark', classes.dark);
  document.documentElement.classList.toggle('colorblind', classes.colorblind);
}

/** Apply the stored appearance and keep it live (OS scheme changes, edits made
 *  from another extension page). Call once per UI entrypoint before render. */
export function initAppearance(): void {
  apply();
  systemMedia().addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) apply();
  });
}
