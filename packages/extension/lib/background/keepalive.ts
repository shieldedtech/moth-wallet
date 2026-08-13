// MV3 service workers are killed after ~30s of inactivity. This is NOT what
// keeps the wallet alive in the background — sync stops and the offscreen
// document is torn down when no window is open (see sync-service teardown). The
// keepalive is strictly op-scoped: it guards only in-flight operations (panel
// sends, dApp connector builds/submits — beginOp/endOp) and pending approvals
// against mid-operation SW suspension. Remote proving has silent gaps that
// exceed the 30s idle timeout; if the SW died there we'd lose the response
// channel and report failure for a tx that may have already landed. Refcounted
// so overlapping consumers compose. It is never held while idle, so it cannot
// delay the exit-when-no-window policy.

import { browser } from 'wxt/browser';

let refCount = 0;
let interval: ReturnType<typeof setInterval> | null = null;

export function acquireKeepalive(): void {
  refCount++;
  if (!interval) {
    interval = setInterval(() => {
      void browser.runtime.getPlatformInfo();
    }, 20_000);
  }
}

export function releaseKeepalive(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && interval) {
    clearInterval(interval);
    interval = null;
  }
}
