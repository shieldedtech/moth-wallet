// Setup tabs can outlive an MV3 service-worker instance. Keep their presence
// port attached across worker restarts so the side panel receives the eventual
// setup-complete transition instead of retaining a stale waiting screen.

import { browser, type Browser } from 'wxt/browser';
import { SETUP_PORT } from '../messaging/protocol';

type Port = Browser.runtime.Port;

const RECONNECT_DELAY_MS = 500;

/** Hold the setup-presence port until the returned release function is called. */
export function holdSetupPort(
  connect: () => Port = () => browser.runtime.connect({ name: SETUP_PORT }),
  reconnectDelayMs = RECONNECT_DELAY_MS,
): () => void {
  let port: Port | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let released = false;

  const scheduleReconnect = () => {
    if (released || retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      open();
    }, reconnectDelayMs);
  };

  const open = () => {
    if (released) return;
    try {
      const next = connect();
      port = next;
      next.onDisconnect.addListener(() => {
        if (port !== next) return;
        port = null;
        scheduleReconnect();
      });
    } catch {
      scheduleReconnect();
    }
  };

  open();

  return () => {
    if (released) return;
    released = true;
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    const current = port;
    port = null;
    try {
      current?.disconnect();
    } catch {
      /* already gone */
    }
  };
}
