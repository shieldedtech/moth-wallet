// Production Web Worker smoke test with real browser WASM and a local indexer
// fixture. Run after yarn build. CHROME_BIN selects a Chromium executable.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import WebSocket, {WebSocketServer} from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'packages/extension/.output/chrome-mv3');
const workerAsset = (await readdir(join(output, 'assets'))).find(name => /^reference-worker-.*\.js$/.test(name));
assert(workerAsset, 'Build the extension before testing its reference worker');
const fixture = join(root, 'packages/extension/public/preseed/preview');
const manifest = JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8'));
const snapshot = Object.fromEntries(await Promise.all(['shielded', 'unshielded', 'dust'].map(async part =>
  [part, gunzipSync(await readFile(join(fixture, `${part}.dat.gz`))).toString()])));
const profile = await mkdtemp(join(tmpdir(), 'moth-worker-smoke-'));
let chrome, cdp;
const requests = [];
const server = createServer(async (request, response) => {
  requests.push(request.url);
  try {
    if (request.url === '/graphql') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({data: {block: {height: manifest.height + 1, hash: 'fixture', timestamp: 0, protocolVersion: 0}}}));
    } else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<script>
        window.resultPromise = new Promise((resolve, reject) => {
          const snapshot = ${JSON.stringify(snapshot)};
          const before = JSON.stringify(snapshot);
          const worker = new Worker('/assets/${workerAsset}', {type: 'module'});
          let ticks = 0;
          const timer = setInterval(() => ticks++, 1);
          const deadline = setTimeout(() => {worker.terminate(); reject(Error('Worker timed out'));}, 60000);
          const finish = () => {clearInterval(timer); clearTimeout(deadline); worker.terminate();};
          worker.onerror = event => {finish(); reject(Error(event.message));};
          worker.onmessage = ({data}) => {
            if (data.kind === 'progress') return;
            finish();
            resolve({data, ticks, unchanged: JSON.stringify(snapshot) === before});
          };
          worker.postMessage({kind: 'contribute', network: {id: 'preview', indexerUrl: location.origin + '/graphql'}, snapshot, source: null});
        });
      </script>`);
    } else {
      const path = resolve(output, '.' + new URL(request.url, 'http://localhost').pathname);
      if (!path.startsWith(output + sep)) {response.writeHead(403).end(); return;}
      response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      response.end(await readFile(path));
    }
  } catch {response.writeHead(404).end();}
});
const wss = new WebSocketServer({server});
wss.on('connection', socket => socket.on('message', raw => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'connection_init') socket.send(JSON.stringify({type: 'connection_ack'}));
  if (message.type === 'subscribe') {
    const [, stream, id] = /(zswapLedgerEvents|dustLedgerEvents)\(id: (\d+)\)/.exec(message.payload.query);
    socket.send(JSON.stringify({type: 'next', id: message.id, payload: {data: {[stream]: {id: Number(id), raw: 'deadbeef'}}}}));
  }
}));

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  chrome = spawn(process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(Error('Chrome startup timed out')), 15000);
    let log = '';
    chrome.once('error', error => {clearTimeout(timer); reject(error);});
    chrome.stderr.on('data', bytes => {
      log += bytes.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(log);
      if (match) {clearTimeout(timer); resolveEndpoint(match[1]);}
    });
  });
  cdp = new WebSocket(endpoint);
  await once(cdp, 'open');
  let serial = 0;
  const pending = new Map();
  cdp.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {pending.delete(id); reject(Error(`${method} timed out`));}, 70000);
    pending.set(id, {resolve: resolveCall, reject, timer});
    cdp.send(JSON.stringify({id, method, params, sessionId}));
  });
  const {targetId} = await call('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await call('Target.attachToTarget', {targetId, flatten: true});
  await call('Page.enable', {}, sessionId);
  const loaded = new Promise((resolveLoad, reject) => {
    const timer = setTimeout(() => {cdp.off('message', listener); reject(Error('Page load timed out'));}, 15000);
    const listener = raw => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) {
        clearTimeout(timer); cdp.off('message', listener); resolveLoad();
      }
    };
    cdp.on('message', listener);
  });
  await call('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/`}, sessionId);
  await loaded;
  const evaluation = await call('Runtime.evaluate', {
    expression: `new Promise((resolve, reject) => {
      const timer = setInterval(() => {if (window.resultPromise) {clearInterval(timer); window.resultPromise.then(resolve, reject);}}, 10);
      setTimeout(() => {clearInterval(timer); reject(Error('Page timed out'));}, 65000);
    })`, awaitPromise: true, returnByValue: true,
  }, sessionId);
  assert(!evaluation.exceptionDetails, JSON.stringify({exception: evaluation.exceptionDetails, requests}));
  const result = evaluation.result.value;
  assert.equal(result.data.kind, 'complete');
  assert(result.data.snapshot, 'Worker declined an empty valid snapshot');
  assert.equal(result.data.snapshot.height, manifest.height + 1);
  assert.equal(result.unchanged, true);
  assert(result.ticks > 0, 'Page did not remain responsive during optimization');
  for (const part of ['shielded', 'dust']) assert.equal(result.data.snapshot.witnesses[part].digest.length, 16);
  assert.notDeepEqual(JSON.parse(result.data.snapshot.shielded).publicKeys, JSON.parse(snapshot.shielded).publicKeys);
  console.log(`Production reference worker passed: browser WASM, identity replacement, witnesses, immutable input; ${result.ticks} page timer ticks during work.`);
} finally {
  cdp?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit');
    chrome.kill();
    const killTimer = setTimeout(() => chrome.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killTimer);
  }
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close();
  await rm(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
}
