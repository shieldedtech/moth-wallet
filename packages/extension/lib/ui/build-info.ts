// When this bundle was produced, injected at build time by `define` in
// wxt.config.ts. It identifies the *artifact*, not the build invocation: a
// turbo cache hit restores a byte-identical `.output`, and the timestamp it
// carries is the one that content was actually compiled at. So a stamp that
// does not move means nothing in the extension's inputs changed.
//
// `declare` rather than a global .d.ts keeps the name local to this module.
// Under vitest there is no `define` pass, so the identifier is simply
// undeclared — `typeof` on an undeclared binding is legal and yields
// 'undefined', which is why this is written as a typeof guard and not a
// direct read.
declare const __MOTH_BUILD_TIME__: string;

/** ISO-8601 UTC instant the bundle was built, or '' outside a real build. */
export const BUILD_TIME: string =
  typeof __MOTH_BUILD_TIME__ === 'string' ? __MOTH_BUILD_TIME__ : '';

/**
 * The build stamp as shown in the UI: local date + time, no seconds, in the
 * viewer's locale. Returns null when there is no stamp (tests, or a bundle
 * built before this existed) so callers render nothing rather than "Invalid
 * Date".
 */
export function formatBuildTime(iso: string = BUILD_TIME): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
