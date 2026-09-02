// Yarn 4 constraints: keep every workspace pinned to the Midnight version
// train declared in midnight-versions.json.
//
// Why exact pins and not ranges: several of these packages are WASM-backed.
// A caret range is *supposed* to mean "any API-compatible version", but two
// API-compatible copies of a WASM module are two distinct module instances,
// so a value built by one fails the other's `instanceof` check. That surfaces
// as `expected instance of StateValue` at call time — long after install and
// type-checking have both passed. Ranges cannot express "exactly one copy",
// so we forbid them here and verify the resolved tree separately in
// scripts/check-midnight-versions.mjs.
//
//   yarn constraints        check (exits non-zero on drift)
//   yarn constraints --fix  rewrite manifests to match the train

const TRAIN = require('./midnight-versions.json').npm;

const MIDNIGHT_SCOPES = ['@midnight-ntwrk/', '@midnightntwrk/'];
const isMidnight = (ident) => MIDNIGHT_SCOPES.some((s) => ident.startsWith(s));

module.exports = {
  async constraints({Yarn}) {
    for (const dep of Yarn.dependencies()) {
      if (!isMidnight(dep.ident)) continue;

      const want = TRAIN[dep.ident];

      // A Midnight package nobody has added to the train. Refuse it rather
      // than let it float: this is how a stray transitive-looking dep ends up
      // being the second WASM instance.
      if (want === undefined) {
        dep.error(
          `${dep.ident} is not declared in midnight-versions.json.\n` +
          `Add it to "npm" (and to "singleInstance" if it is WASM-backed) ` +
          `so it moves with the rest of the train, then re-run yarn constraints.`,
        );
        continue;
      }

      if (dep.range !== want) {
        dep.update(want);
        dep.error(
          `${dep.ident} must be pinned to exactly ${want} ` +
          `(from midnight-versions.json); found "${dep.range}". ` +
          `Run \`yarn constraints --fix\`. Do not bump this in isolation — ` +
          `the Midnight compiler, runtime and SDK move as one set.`,
        );
      }
    }
  },
};
