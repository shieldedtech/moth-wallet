import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';
import { BALANCES_PORT, SETUP_PORT } from '../lib/messaging/protocol';
import { registerHandlers, enforceAutoLock } from '../lib/background/handlers';
import { applyNodeAuthHeader } from '../lib/background/node-auth-header';
import { registerConnectorHandlers } from '../lib/background/connector-handlers';
import { watchApprovalWindows } from '../lib/background/approvals';
import { getSession } from '../lib/background/session';
import { addPort, addSetupPort, startSync, registerSyncEvents, reconcileStartup } from '../lib/background/sync-service';
import { getNetworkConfig, getSettings } from '../lib/background/settings';
import { AUTO_LOCK_ALARM, armAutoLock } from '../lib/background/auto-lock';

export default defineBackground({
  // A classic (non-module) service worker: it deliberately imports NO WASM.
  // The ledger WASM (whose top-level await a service worker cannot contain)
  // runs in the offscreen document instead — see lib/offscreen/wallet-host.ts.
  main() {
    // Chrome-only: clicking the toolbar icon opens the side panel.
    // Firefox opens the sidebar via sidebar_action instead.
    (browser as any).sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

    registerHandlers();
    // Install the node auth header rule before sync can dial. A service worker
    // restart loses dynamic rules' effect on nothing (they persist), but the
    // rule must also follow a changed node URL, so it is re-derived here from
    // whatever settings currently say.
    void getNetworkConfig()
      .then((config) => applyNodeAuthHeader(config.nodeUrl, config.nodeAuthHeader))
      .catch(() => {});
    registerConnectorHandlers();
    registerSyncEvents();
    watchApprovalWindows();
    reconcileStartup();

    // Inactivity auto-lock: the alarm wakes this worker (even after suspension)
    // to check whether the configured window elapsed. Re-arm on startup so a
    // session that survived an SW restart keeps its clock; the extension may
    // have been updated (which clears alarms) while unlocked.
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === AUTO_LOCK_ALARM) void enforceAutoLock();
    });
    void (async () => {
      if (await getSession()) armAutoLock((await getSettings()).autoLockMinutes);
    })();

    // A UI surface opened its live-balances port: start (or resume) sync for
    // the unlocked wallet and stream updates until the last port closes.
    browser.runtime.onConnect.addListener((port) => {
      if (port.name === SETUP_PORT) {
        addSetupPort(port);
        return;
      }
      if (port.name !== BALANCES_PORT) return;
      addPort(port);
      void (async () => {
        const session = await getSession();
        if (!session) return;
        const network = await getNetworkConfig();
        await startSync(session, network).catch((err) => {
          try {
            port.postMessage({ kind: 'syncMessage', message: `Sync failed: ${err}` });
          } catch {
            /* port closed */
          }
        });
      })();
    });
  },
});
