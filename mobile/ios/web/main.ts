// Moth mobile (iOS): moth's unmodified browser build, running in a WKWebView, proving
// through the native in-app proof server (http://127.0.0.1:<port>, injected by the host).
import {
  createMothBrowser,
  startWalletSync,
  buildTransferTransaction,
  submitFinalizedTransaction,
  designateForDust,
  deriveWalletKeys,
  IdbSyncStateStore,
  NIGHT_TOKEN_ID,
  type SyncedWallet,
  type WalletBalances,
  type NetworkConfig,
} from '@shieldedtech/moth-browser';
import { installBundledReference } from 'moth-ext/offscreen/bundled-preseed';
import { parseNightAmount, formatNightAmount } from '@shieldedtech/moth-wallet/wallet/night-amount';

declare global {
  interface Window {
    MOTH_PROVER_URL?: string;
    webkit?: { messageHandlers?: Record<string, { postMessage(v: unknown): void }> };
  }
}

const NETWORK = 'preprod';
const WALLET = 'phone';
// Testnet spike only: a fixed keystore passphrase so the run is unattended.
const PASS = 'moth-mobile-spike-preprod';
const MAIN_THREAD_BATCH = { size: 50, timeout: 100, spacing: 20 };
const T0 = performance.now();

const $ = (id: string) => document.getElementById(id)!;

// Status line at the top. Restoring cached DUST state runs on the main thread and blocks
// it for about a minute, so the message is painted before that starts; the spinner is a
// CSS transform animation, which keeps turning while JavaScript is blocked.
function status(msg: string, busy = true) {
  const el = $('status');
  el.textContent = msg;
  el.className = busy ? 'busy' : 'done';
}
// moth's progress messages, reworded for the status line (the log keeps moth's originals).
function statusText(m: string): string {
  if (/dust wallet|dust state/i.test(m)) return 'Loading DUST state… (about a minute; the screen will not respond until it finishes)';
  return m.replace(/^○\s*/, '');
}
const painted = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const secs = (t: number) => ((performance.now() - t) / 1000).toFixed(1);

function log(msg: string) {
  const line = `[${secs(T0).padStart(6)}s] ${msg}`;
  $('log').textContent = line + '\n' + $('log').textContent;
  // Mirrored to the native host so the Mac can read it over the device console.
  window.webkit?.messageHandlers?.log?.postMessage(line);
}

const proverUrl = window.MOTH_PROVER_URL ?? 'http://127.0.0.1:6300';
const moth = createMothBrowser({
  network: NETWORK,
  indexerUrl: 'https://indexer.preprod.shielded.tools/api/v4/graphql',
  prover: { type: 'server', url: proverUrl },
});
const network: NetworkConfig = moth.config;

let seedHex = '';
let synced: SyncedWallet | null = null;
let addresses: { shielded: string; unshielded: string; dust: string } | null = null;

// Balances arrive in base units: NIGHT in STAR (10^6 per NIGHT), DUST in SPECK (10^15 per
// DUST). Other tokens have no protocol decimals, so they show as raw integers, labeled by a
// color derived from the token id plus its short id.
const SPECKS_PER_DUST = 10n ** 15n;
function fmtDust(specks: bigint, places = 6): string {
  const whole = specks / SPECKS_PER_DUST;
  const frac = ((specks % SPECKS_PER_DUST) * 10n ** BigInt(places)) / SPECKS_PER_DUST;
  return `${whole.toLocaleString('en-US')}.${frac.toString().padStart(places, '0')}`;
}
function fmtNight(stars: bigint): string {
  const [w, f] = formatNightAmount(stars).split('.');
  return `${BigInt(w).toLocaleString('en-US')}.${(f ?? '').padEnd(6, '0')}`;
}
function tokenColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 50%)`;
}
function row(label: string, amount: string, sub = '', color = '') {
  const swatch = color ? `<span class="sw" style="background:${color}"></span>` : '';
  return `<div class="tok">${swatch}<span class="name">${label}</span><span class="sub">${sub}</span><span class="amt">${amount}</span></div>`;
}
function renderBalances(b: WalletBalances) {
  const rows = [row('NIGHT', fmtNight(BigInt(b.unshielded[NIGHT_TOKEN_ID] ?? 0)), 'unshielded')];
  for (const [k, v] of Object.entries(b.unshielded)) if (k !== NIGHT_TOKEN_ID) rows.push(row(`${k.slice(0, 8)}…`, BigInt(v).toLocaleString('en-US'), 'unshielded token', tokenColor(k)));
  for (const [k, v] of Object.entries(b.shielded)) rows.push(row(`${k.slice(0, 8)}…`, BigInt(v).toLocaleString('en-US'), 'shielded token', tokenColor(k)));
  rows.push(row('DUST', fmtDust(BigInt(b.dust)), 'fees'));
  const progress = `shielded ${pct(b.subProgress.shielded)} · unshielded ${pct(b.subProgress.unshielded)} · dust ${pct(b.subProgress.dust)}`;
  $('bal').innerHTML = rows.join('') + `<div class="prog">${b.synced ? 'synced' : 'syncing'} — ${progress}</div>`;
}
function balanceLine(b: WalletBalances): string {
  const parts = [`NIGHT ${fmtNight(BigInt(b.unshielded[NIGHT_TOKEN_ID] ?? 0))}`];
  for (const [k, v] of Object.entries(b.unshielded)) if (k !== NIGHT_TOKEN_ID) parts.push(`${k.slice(0, 8)}… ${v} (unshielded)`);
  for (const [k, v] of Object.entries(b.shielded)) parts.push(`${k.slice(0, 8)}… ${v} (shielded)`);
  parts.push(`DUST ${fmtDust(BigInt(b.dust))}`);
  return parts.join(' · ');
}
function pct(p: { applied: number; total: number }) {
  return p.total ? `${Math.round((100 * p.applied) / p.total)}%` : '–';
}

async function ensureWallet() {
  const existing = (await moth.wallets.list()).find((w) => w.name === WALLET);
  let info = existing;
  if (!info) {
    const tip = (await moth.indexer.getBlock())?.height;
    info = await moth.wallets.generate(WALLET, PASS, NETWORK, tip);
    log(`created wallet, birthday height ${tip}`);
  } else {
    log(`existing wallet, birthday ${await moth.wallets.birthdayOn(WALLET, NETWORK)}`);
  }
  const t = performance.now();
  // Stored wallet info carries only the primary (unshielded) address; unlock derives the rest.
  const u = await moth.wallets.unlock(WALLET, PASS);
  const a = u.addresses;
  const pick = (e: { bech32m: Record<string, string> }) => e.bech32m[NETWORK] ?? Object.values(e.bech32m)[0] ?? '';
  addresses = { shielded: pick(a.zswap), unshielded: u.address, dust: pick(a.dust) };
  u.lock();
  $('addr').textContent = `unshielded ${addresses.unshielded}\nshielded ${addresses.shielded}`;
  log(`ADDRESSES ${JSON.stringify(addresses)}`);
  seedHex = await moth.wallets.exportSeedHex(WALLET, PASS);
  log(`unlocked in ${secs(t)}s`);
}

async function sync() {
  ($('sync') as HTMLButtonElement).disabled = true;
  const t = performance.now();
  const tRef = performance.now();
  await installBundledReference(NETWORK, new IdbSyncStateStore());
  log(`pre-seed reference installed in ${secs(tRef)}s`);
  const birthday = await moth.wallets.birthdayOn(WALLET, NETWORK);
  status('Restoring wallet state…');
  await painted();
  let lastMsg = '';
  synced = await startWalletSync(
    deriveWalletKeys(seedHex),
    network,
    (m) => { if (m !== lastMsg) { lastMsg = m; log(m); if (!m.startsWith('●')) status(statusText(m)); } },
    WALLET,
    false,
    birthday,
    { syncStore: new IdbSyncStateStore(), batchUpdates: MAIN_THREAD_BATCH },
  );
  let reported = false;
  let lastBal = '';
  synced.subscribe((b) => {
    renderBalances(b);
    const line = balanceLine(b);
    if (line !== lastBal) { lastBal = line; log(`BALANCE ${line}`); }
    if (b.synced) status('Synced', false);
    if (b.synced && !reported) {
      reported = true;
      log(`SYNCED in ${secs(t)}s from tap`);
    }
  });
  for (const id of ['send', 'dust']) ($(id) as HTMLButtonElement).disabled = false;
}

async function send() {
  if (!synced || !addresses) return;
  const kind = ($('kind') as HTMLSelectElement).value as 'shielded' | 'unshielded';
  const to = ($('to') as HTMLInputElement).value.trim() || (kind === 'shielded' ? addresses.shielded : addresses.unshielded);
  let tokenId = ($('token') as HTMLInputElement).value.trim();
  if (!tokenId) tokenId = kind === 'unshielded' ? NIGHT_TOKEN_ID : Object.keys(synced.balances.shielded)[0] ?? NIGHT_TOKEN_ID;
  // NIGHT is typed in NIGHT (6 decimals, converted to STARs); other tokens have no known
  // decimals, so they stay in base units.
  const raw = ($('amount') as HTMLInputElement).value.trim();
  let amount: bigint;
  try {
    amount = tokenId === NIGHT_TOKEN_ID ? parseNightAmount(raw) : BigInt(raw);
    if (amount <= 0n) throw new Error('amount must be positive');
  } catch (e) {
    log(`send refused: ${(e as Error).message}`);
    return;
  }
  const t = performance.now();
  let tStage = t;
  log(`send ${tokenId === NIGHT_TOKEN_ID ? `${formatNightAmount(amount)} NIGHT (${amount} STAR)` : `${amount} base units of ${tokenId.slice(0, 8)}…`} ${kind} → ${to.slice(0, 24)}…`);
  try {
    const finalized = await buildTransferTransaction(
      synced.facade, deriveWalletKeys(seedHex), NETWORK,
      [{ type: kind, tokenId, amount, to }],
      (stage) => { log(`stage ${stage} (+${secs(tStage)}s)`); tStage = performance.now(); },
    );
    log(`built + proven in ${secs(t)}s`);
    const hash = await submitFinalizedTransaction(synced.facade, finalized);
    log(`SUBMITTED ${hash} total ${secs(t)}s`);
  } catch (e) {
    log(`send failed: ${(e as Error).message}`);
  }
}

async function registerDust() {
  if (!synced) return;
  const t = performance.now();
  try {
    const hash = await designateForDust(synced.facade, seedHex, NETWORK, undefined, (s) => log(`dust stage ${s}`));
    log(`DUST registration ${hash ?? '(nothing to register)'} in ${secs(t)}s`);
  } catch (e) {
    log(`dust registration failed: ${(e as Error).message}`);
  }
}

$('sync').onclick = () => void sync().catch((e) => { log(`sync failed: ${e?.message ?? e}`); status(`Sync failed: ${e?.message ?? e}`, false); });
$('send').onclick = () => void send();
$('dust').onclick = () => void registerDust();
$('copy').onclick = () => {
  if (addresses) window.webkit?.messageHandlers?.log?.postMessage(`ADDRESSES ${JSON.stringify(addresses)}`);
  log('addresses sent to device log');
};

(async () => {
  log(`prover ${proverUrl}`);
  const r = await fetch(`${proverUrl}/version`).then((r) => r.text()).catch((e) => `unreachable: ${e}`);
  log(`proof server version ${r}`);
  // Reachability checks, using the same transports moth uses: GraphQL over HTTPS for the
  // indexer, JSON-RPC over WebSocket for the node. (Plain HTTPS GETs to the node fail here
  // because it sends no CORS headers; WebSockets are not subject to CORS.)
  {
    const t = performance.now();
    try {
      const r = await fetch(network.indexerUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"{ block { height } }"}', signal: AbortSignal.timeout(20000) });
      log(`indexer ${r.status} in ${secs(t)}s ${(await r.text()).slice(0, 80)}`);
    } catch (e) {
      log(`indexer ERROR ${(e as Error).message} after ${secs(t)}s`);
    }
  }
  {
    const t = performance.now();
    const res = await new Promise<string>((resolve) => {
      const ws = new WebSocket(network.nodeUrl.replace(/^http/, 'ws'));
      const timer = setTimeout(() => { ws.close(); resolve('ERROR timeout after 20s'); }, 20000);
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }));
      ws.onmessage = (e) => { clearTimeout(timer); ws.close(); resolve(String(e.data).slice(0, 100)); };
      ws.onerror = () => { clearTimeout(timer); resolve('ERROR WebSocket failed'); };
    });
    log(`node RPC in ${secs(t)}s ${res}`);
  }
  status('Unlocking wallet…');
  await ensureWallet();
  for (const id of ['sync', 'copy']) ($(id) as HTMLButtonElement).disabled = false;
  // Auto-start sync so an unattended launch measures cold-start-to-synced.
  if (new URLSearchParams(location.search).get('autosync') !== '0') void sync().catch((e) => log(`sync failed: ${e?.message ?? e}`));
})().catch((e) => { log(`startup failed: ${e?.message ?? e}`); status(`Startup failed: ${e?.message ?? e}`, false); });
