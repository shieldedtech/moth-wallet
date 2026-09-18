// Collapse and verify the DUST state of one pre-seed bundle directory.
//
// A bundle directory is what scripts/export-preseed.mjs writes and the extension
// ships: manifest.json beside shielded.dat.gz, unshielded.dat.gz and dust.dat.gz.
// This rewrites dust.dat.gz and the manifest's record of it, and nothing else, and
// only once every check below has passed. The transform itself, and why the dust
// trees need collapsing at all, live in core:
// packages/core/src/sync/dust-reference-collapse.ts.
//
// Core's collapse functions are passed in rather than imported, so the tests can
// run this against core's source without a build — the same arrangement as
// scripts/lib/prepare-preseed.mjs.

import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';

export const BUNDLE_PARTS = ['shielded', 'unshielded', 'dust'];

const WITNESS_STREAMS = {shielded: 'zswapLedgerEvents', dust: 'dustLedgerEvents'};

export class BundleCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleCheckError';
  }
}

function readManifest(dir) {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new BundleCheckError(`${dir}: no manifest.json`);
  const text = readFileSync(path, 'utf8');
  try {
    return {path, text, manifest: JSON.parse(text)};
  } catch (err) {
    throw new BundleCheckError(`${dir}: manifest.json is not JSON (${err.message})`);
  }
}

function checkManifest(dir, manifest, expectedNetwork) {
  if (typeof manifest.network !== 'string' || manifest.network === '') {
    throw new BundleCheckError(`${dir}: manifest has no network`);
  }
  if (expectedNetwork !== undefined && manifest.network !== expectedNetwork) {
    throw new BundleCheckError(`${dir}: manifest is for ${manifest.network}, not ${expectedNetwork}`);
  }
  if (!Number.isSafeInteger(manifest.height) || manifest.height <= 0) {
    throw new BundleCheckError(`${dir}: manifest height ${manifest.height} is unusable`);
  }
  // The extension refuses a bundle without both witnesses, and core refuses a
  // malformed one on import. Catch either here, before a bundle that would be
  // refused is ever committed.
  for (const [part, stream] of Object.entries(WITNESS_STREAMS)) {
    const witness = manifest.witnesses?.[part];
    const valid =
      witness !== null &&
      typeof witness === 'object' &&
      witness.stream === stream &&
      Number.isSafeInteger(witness.id) &&
      witness.id > 0 &&
      typeof witness.digest === 'string' &&
      /^[0-9a-f]{16}$/.test(witness.digest);
    if (!valid) {
      throw new BundleCheckError(`${dir}: manifest has no valid ${part} witness ({stream: "${stream}", id, digest})`);
    }
  }
}

function readPart(dir, part) {
  const path = join(dir, `${part}.dat.gz`);
  if (!existsSync(path)) throw new BundleCheckError(`${dir}: missing ${part}.dat.gz`);
  const gz = readFileSync(path);
  let json;
  try {
    json = gunzipSync(gz).toString('utf8');
    JSON.parse(json);
  } catch (err) {
    throw new BundleCheckError(`${dir}: ${part}.dat.gz is not gzipped JSON (${err.message})`);
  }
  return {path, gz, json};
}

/** Write via a temporary file and a rename, so a reader never sees half a file. */
function writeAtomically(path, data) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

/**
 * Collapse one bundle's dust state, or with `check`, prove it already is.
 *
 * Checks before anything is written, and throws a BundleCheckError at the first
 * failure, leaving the directory untouched:
 *
 * - manifest.json is JSON, for the expected network, with a usable height and a
 *   valid shielded and dust witness
 * - all three parts are present and are gzipped JSON
 * - the manifest records the shielded and unshielded files that are actually there
 * - the dust state has a usable cursor, and core's collapse accepts and verifies
 *   it (same roots, balance and UTXOs; survives a round trip; same frontier)
 * - the exact bytes about to be written decompress to the verified state, which
 *   core reads back to the same roots, no UTXOs and the same cursor
 *
 * With `check`, a dust state that is not already collapsed, or a manifest that
 * does not record the dust file it ships, is a failure instead of a rewrite.
 *
 * Writes dust.dat.gz first and the manifest second. Interrupted between the two,
 * the bundle fails `check` (the manifest misstates the dust file) until re-run.
 */
export function collapseBundle(dir, {collapseDustReference, inspectDustSnapshot, network, check = false, now = new Date()}) {
  const {path: manifestPath, text: manifestText, manifest} = readManifest(dir);
  checkManifest(dir, manifest, network);

  const parts = Object.fromEntries(BUNDLE_PARTS.map((part) => [part, readPart(dir, part)]));
  for (const part of ['shielded', 'unshielded']) {
    const recorded = manifest.parts?.[part];
    const {gz, json} = parts[part];
    if (recorded?.gzipBytes !== gz.byteLength || recorded?.bytes !== Buffer.byteLength(json, 'utf8')) {
      throw new BundleCheckError(`${dir}: manifest does not record the ${part}.dat.gz it ships`);
    }
  }

  const dust = parts.dust;
  const cursor = JSON.parse(dust.json).offset;
  if (cursor === undefined || !/^\d+$/.test(String(cursor)) || BigInt(cursor) <= 0n) {
    throw new BundleCheckError(`${dir}: dust state has no usable cursor (offset ${cursor})`);
  }

  let collapsed;
  try {
    collapsed = collapseDustReference(dust.json, now);
  } catch (err) {
    throw new BundleCheckError(`${dir}: dust state refused — ${err.message}`);
  }
  const {json, report} = collapsed;

  // Verify the bytes that would actually ship, through the calls a restore makes,
  // rather than the string they were made from.
  const gz = report.changed ? gzipSync(Buffer.from(json, 'utf8'), {level: 9}) : dust.gz;
  const shipped = gunzipSync(gz).toString('utf8');
  if (shipped !== json) {
    throw new BundleCheckError(`${dir}: the compressed dust state does not decompress to the verified one`);
  }
  const summary = inspectDustSnapshot(shipped);
  if (
    summary.utxos !== 0 ||
    summary.generationRoot !== report.generationRoot ||
    summary.commitmentRoot !== report.commitmentRoot ||
    summary.stateBytes !== report.stateBytesAfter ||
    JSON.parse(shipped).offset !== cursor
  ) {
    throw new BundleCheckError(`${dir}: the dust state read back from the compressed bytes is not the verified one`);
  }

  const nextManifestText = `${JSON.stringify(
    {...manifest, parts: {...manifest.parts, dust: {bytes: Buffer.byteLength(json, 'utf8'), gzipBytes: gz.byteLength}}},
    null,
    2,
  )}\n`;
  const manifestStale = nextManifestText !== manifestText;

  if (check) {
    if (report.changed) {
      throw new BundleCheckError(
        `${dir}: dust state is not collapsed (${report.stateBytesBefore} B; collapses to ${report.stateBytesAfter} B). ` +
          `Run: node scripts/collapse-preseed.mjs --dir ${dir}`,
      );
    }
    if (manifestStale) throw new BundleCheckError(`${dir}: manifest does not record the dust.dat.gz it ships`);
  } else {
    if (report.changed) writeAtomically(dust.path, gz);
    if (manifestStale) writeAtomically(manifestPath, nextManifestText);
  }

  return {
    network: manifest.network,
    height: manifest.height,
    cursor: String(cursor),
    changed: report.changed,
    wrote: !check && (report.changed || manifestStale),
    stateBytesBefore: report.stateBytesBefore,
    stateBytesAfter: report.stateBytesAfter,
    gzipBytesBefore: dust.gz.byteLength,
    gzipBytesAfter: gz.byteLength,
    generationFirstFree: String(report.generationFirstFree),
    commitmentFirstFree: String(report.commitmentFirstFree),
    generationRoot: String(report.generationRoot),
    commitmentRoot: String(report.commitmentRoot),
  };
}
