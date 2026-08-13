// Extension-side persistence for the phase-timings recorder.
//
// The recorder itself — the delta arithmetic, the enabled cache, the bounded
// history, the never-throw policy — lives in core (diagnostics/timings.ts) and is
// shared with the CLI, TUI and daemon. This file is only the storage half: a
// TimingStore backed by extension storage, plus the module-level recorder the
// background wires its call sites to.
//
// Deliberately storage.local, not ExtensionSettings and not storage.session:
//   - storage.local survives service-worker restarts and offscreen teardown, and
//     the interesting runs (unlock, first sync) span both.
//   - it is readable with NO wallet and NO unlocked session, which is the point:
//     the phases most worth measuring (wallet creation, the reference build) all
//     happen before a first wallet exists, and the panel shows GetStarted then, so
//     nothing behind Settings can reach them.
//
// What is recorded is labels, durations and sizes. Never addresses, amounts, token
// ids or wallet names — a timings file should be safe to paste into an issue.

import { browser } from 'wxt/browser';
import {
  createTimingRecorder,
  DEFAULT_MAX_ENTRIES,
  type TimingEntry,
  type TimingStore,
} from '@shieldedtech/moth-wallet/diagnostics/timings';

const ENABLED_KEY = 'debug.timings.enabled';
const ENTRIES_KEY = 'debug.timings.entries';

export type { TimingEntry };
export const MAX_ENTRIES = DEFAULT_MAX_ENTRIES;

const store: TimingStore = {
  async isEnabled() {
    const stored = await browser.storage.local.get(ENABLED_KEY);
    return stored[ENABLED_KEY] === true;
  },
  async setEnabled(on) {
    await browser.storage.local.set({ [ENABLED_KEY]: on });
  },
  async read() {
    const stored = await browser.storage.local.get(ENTRIES_KEY);
    const entries = stored[ENTRIES_KEY];
    return Array.isArray(entries) ? (entries as TimingEntry[]) : [];
  },
  async write(entries) {
    await browser.storage.local.set({ [ENTRIES_KEY]: entries });
  },
  async clear() {
    await browser.storage.local.remove(ENTRIES_KEY);
  },
};

const recorder = createTimingRecorder(store);

/** Append one stamped phase. No-op when disabled, so call sites need no guard. */
export const record = recorder.record;
export const getTimings = recorder.list;
export const clearTimings = recorder.clear;
export const setTimingsEnabled = recorder.setEnabled;
export const timingsEnabled = recorder.isEnabled;
