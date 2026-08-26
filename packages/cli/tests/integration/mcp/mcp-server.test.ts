// Integration coverage for `moth mcp`.
//
// Two tiers, following the daemon suite's convention:
//
//   * No-devnet tier — runs everywhere. Speaks real MCP to a spawned
//     `moth mcp` subprocess using the SDK client over stdio. Every
//     frame the client parses is implicit proof that stdout carries
//     nothing but JSON-RPC (the whole point of the stdout guard).
//     Sync flounders offline by design; read tools that don't need the
//     facade must still work.
//
//   * Devnet tier — gated on MOTH_DEVNET_URL, network `undeployed`.
//     Funds a wallet via the shared harness, then exercises the spend
//     path end-to-end: wait_for_sync, a real transfer, and the
//     max-spend refusal.

import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DEVNET_URL,
  MOTH_BIN,
  NETWORK,
  cleanupTestWallet,
  getReceiveAddress,
  runMoth,
  runMothJson,
  setupTestWallet,
} from '../daemon/helpers.js';

const PASSPHRASE = process.env.MOTH_PASSPHRASE ?? 'daemon-test-passphrase-12345';

const READ_TOOLS = [
  'wallet_status',
  'wallet_balances',
  'wallet_addresses',
  'wallet_activity',
  'wallet_list',
  'wait_for_sync',
];
const SPEND_TOOLS = ['transfer_tokens', 'estimate_transfer_fee', 'dust_register', 'dust_deregister'];

interface McpHandle {
  client: Client;
  close(): Promise<void>;
}

/** Spawn `moth mcp` for the wallet and connect an MCP client to it. */
async function connectMcp(
  walletName: string,
  opts: {spend?: boolean; balancing?: boolean} = {},
): Promise<McpHandle> {
  const args = ['mcp', '--wallet', walletName, '--network', NETWORK];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MOTH_PASSPHRASE: PASSPHRASE,
  };
  if (opts.spend) {
    args.push('--auto-approve', '--max-spend', '1000');
    if (opts.balancing) args.push('--allow-balancing');
    env.MOTH_DAEMON_AUTO_APPROVE = '1';
  } else {
    delete env.MOTH_DAEMON_AUTO_APPROVE;
  }
  const transport = new StdioClientTransport({
    command: MOTH_BIN,
    args,
    env,
    stderr: 'pipe',
  });
  const client = new Client({name: 'mcp-test', version: '0.0.0'});
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

/** Run `moth mcp` expecting a pre-handshake exit; returns exit code + stderr.
 *  cwd is a temp dir so a repo .env can't leak MOTH_PASSPHRASE etc. into
 *  the negative cases. */
function runMcpExpectExit(args: string[], env: NodeJS.ProcessEnv): {exitCode: number; stderr: string} {
  try {
    execFileSync(MOTH_BIN, ['mcp', ...args], {
      env,
      cwd: tmpdir(),
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {exitCode: 0, stderr: ''};
  } catch (err) {
    const e = err as {status?: number; stderr?: Buffer | string};
    return {exitCode: e.status ?? 1, stderr: e.stderr?.toString() ?? ''};
  }
}

function structured(res: {structuredContent?: unknown}): Record<string, any> {
  expect(res.structuredContent, 'expected structuredContent on tool result').toBeTruthy();
  return res.structuredContent as Record<string, any>;
}

describe('moth mcp (no devnet required)', () => {
  let walletName: string;
  let address: string;
  let shieldedAddress: string;
  let dustAddress: string;

  beforeAll(() => {
    walletName = `mcp-ro-${Date.now()}`;
    type AddressBundle = {bech32m?: Record<string, string>};
    const gen = runMothJson<{
      addresses?: {nightExternal?: AddressBundle; zswap?: AddressBundle; dust?: AddressBundle};
    }>(
      ['wallet', 'generate', '--name', walletName, '--network', NETWORK],
      {MOTH_PASSPHRASE: PASSPHRASE},
    );
    expect(gen.exitCode, `wallet generate failed: ${gen.raw.stderr}`).toBe(0);
    address = gen.data?.addresses?.nightExternal?.bech32m?.[NETWORK] ?? '';
    shieldedAddress = gen.data?.addresses?.zswap?.bech32m?.[NETWORK] ?? '';
    dustAddress = gen.data?.addresses?.dust?.bech32m?.[NETWORK] ?? '';
    expect(address).toBeTruthy();
    expect(shieldedAddress).toBeTruthy();
    expect(dustAddress).toBeTruthy();
  }, 120_000);

  afterAll(() => {
    runMoth(['wallet', 'remove', walletName, '--yes'], {MOTH_PASSPHRASE: PASSPHRASE});
  });

  describe('consent gate (fail fast before the handshake)', () => {
    const baseEnv = {...process.env, MOTH_PASSPHRASE: PASSPHRASE};

    it('exits 2 when --auto-approve lacks MOTH_DAEMON_AUTO_APPROVE=1', () => {
      const env = {...baseEnv};
      delete env.MOTH_DAEMON_AUTO_APPROVE;
      const r = runMcpExpectExit(
        ['--wallet', walletName, '--network', NETWORK, '--auto-approve', '--max-spend', '10'],
        env,
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('MOTH_DAEMON_AUTO_APPROVE');
    });

    it('exits 2 when --auto-approve lacks --max-spend', () => {
      const r = runMcpExpectExit(
        ['--wallet', walletName, '--network', NETWORK, '--auto-approve'],
        {...baseEnv, MOTH_DAEMON_AUTO_APPROVE: '1'},
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--max-spend');
    });

    it('exits 2 on a malformed --max-spend', () => {
      const r = runMcpExpectExit(
        ['--wallet', walletName, '--network', NETWORK, '--auto-approve', '--max-spend', 'lots'],
        {...baseEnv, MOTH_DAEMON_AUTO_APPROVE: '1'},
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--max-spend');
    });

    it('exits 2 when --allow-balancing lacks the spend gate (its cap cannot see balanced amounts)', () => {
      const env = {...baseEnv};
      delete env.MOTH_DAEMON_AUTO_APPROVE;
      const r = runMcpExpectExit(
        ['--wallet', walletName, '--network', NETWORK, '--allow-balancing'],
        env,
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--allow-balancing');
    });

    it('exits 2 without MOTH_PASSPHRASE (stdin is the protocol channel)', () => {
      const env = {...process.env};
      delete env.MOTH_PASSPHRASE;
      const r = runMcpExpectExit(['--wallet', walletName, '--network', NETWORK], env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('MOTH_PASSPHRASE');
    });
  });

  describe('read-only server over real MCP stdio', () => {
    let mcp: McpHandle;

    beforeAll(async () => {
      mcp = await connectMcp(walletName);
    }, 120_000);

    afterAll(async () => {
      await mcp?.close();
    });

    it('lists exactly the read tools when spend is not armed', async () => {
      const {tools} = await mcp.client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...READ_TOOLS].sort());
      for (const spendTool of SPEND_TOOLS) {
        expect(names).not.toContain(spendTool);
      }
    });

    it('wallet_addresses returns night, shielded, and dust addresses before sync completes', async () => {
      const res = await mcp.client.callTool({name: 'wallet_addresses', arguments: {}});
      expect(res.isError).toBeFalsy();
      const s = structured(res);
      expect(s.wallet).toBe(walletName);
      expect(s.network).toBe(NETWORK);
      expect(s.addresses.night).toBe(address);
      expect(s.addresses.shielded).toBe(shieldedAddress);
      expect(s.addresses.dust).toBe(dustAddress);
      expect(s.addresses.shielded).toMatch(/^mn_shield-addr_/);
      expect(s.addresses.dust).toMatch(/^mn_dust_/);
      // The text block must carry the full payload — some MCP clients
      // surface only text to the model, and the shielded/dust addresses
      // were invisible there when the text was a bare summary.
      const text = (res.content as Array<{type: string; text?: string}>)
        .map((c) => c.text ?? '')
        .join(' ');
      expect(text).toContain(shieldedAddress);
      expect(text).toContain(dustAddress);
    });

    it('wallet_list includes the served wallet', async () => {
      const res = await mcp.client.callTool({name: 'wallet_list', arguments: {}});
      expect(res.isError).toBeFalsy();
      const s = structured(res);
      expect(s.served).toBe(walletName);
      const names = (s.wallets as Array<{name: string}>).map((w) => w.name);
      expect(names).toContain(walletName);
    });

    it('wallet_status reports sync state instead of hanging or dying offline', async () => {
      const res = await mcp.client.callTool({name: 'wallet_status', arguments: {}});
      expect(res.isError).toBeFalsy();
      const s = structured(res);
      expect(['starting', 'ready', 'failed']).toContain(s.syncState);
      expect(typeof s.ready).toBe('boolean');
    });

    it('wait_for_sync returns on timeout instead of throwing', async () => {
      const res = await mcp.client.callTool({name: 'wait_for_sync', arguments: {timeoutMs: 1000}});
      expect(res.isError).toBeFalsy();
      const s = structured(res);
      expect(typeof s.everSynced).toBe('boolean');
      expect(typeof s.elapsedMs).toBe('number');
    });
  });

  describe('http transport (operator-run server, clients connect by URL)', () => {
    it('requires --bind', () => {
      const r = runMcpExpectExit(
        ['--wallet', walletName, '--network', NETWORK, '--transport', 'http'],
        {...process.env, MOTH_PASSPHRASE: PASSPHRASE},
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--bind');
    });

    it('refuses a non-loopback bind', () => {
      const r = runMcpExpectExit(
        ['--wallet', walletName, '--network', NETWORK, '--transport', 'http', '--bind', '0.0.0.0:18999'],
        {...process.env, MOTH_PASSPHRASE: PASSPHRASE},
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('loopback');
    });

    it('serves concurrent MCP sessions at the bound URL and exits cleanly on SIGTERM', async () => {
      const {spawn} = await import('node:child_process');
      const {StreamableHTTPClientTransport} = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      // Port 0: the OS picks a free port; the server prints the real URL.
      const child = spawn(
        MOTH_BIN,
        ['mcp', '--wallet', walletName, '--network', NETWORK, '--transport', 'http', '--bind', '127.0.0.1:0'],
        {env: {...process.env, MOTH_PASSPHRASE: PASSPHRASE}, stdio: ['ignore', 'pipe', 'pipe']},
      );
      let stderrBuf = '';
      child.stderr.on('data', (c: Buffer) => (stderrBuf += c.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

      try {
        const deadline = Date.now() + 60_000;
        let url: string | null = null;
        while (!url && Date.now() < deadline) {
          url = stderrBuf.match(/listening at (http:\/\/\S+)/)?.[1] ?? null;
          if (!url) await new Promise((r) => setTimeout(r, 200));
        }
        expect(url, `server never printed its URL; stderr: ${stderrBuf.slice(-500)}`).toBeTruthy();

        const clientA = new Client({name: 'http-a', version: '0'});
        await clientA.connect(new StreamableHTTPClientTransport(new URL(url!)));
        const {tools} = await clientA.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());

        const res = await clientA.callTool({name: 'wallet_addresses', arguments: {}});
        expect(res.isError).toBeFalsy();
        expect(structured(res).addresses.night).toBe(address);

        // A second, concurrent session against the same server.
        const clientB = new Client({name: 'http-b', version: '0'});
        await clientB.connect(new StreamableHTTPClientTransport(new URL(url!)));
        const statusRes = await clientB.callTool({name: 'wallet_status', arguments: {}});
        expect(statusRes.isError).toBeFalsy();

        await clientA.close();
        await clientB.close();
      } finally {
        child.kill('SIGTERM');
      }
      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('http server did not exit within 20s of SIGTERM')), 20_000),
        ),
      ]);
      expect(code).toBe(0);
    }, 120_000);
  });

  it('shuts down on stdin EOF instead of leaking an unlocked wallet', async () => {
    // Regression: the SDK's StdioServerTransport only listens for
    // 'data'/'error' on stdin — never 'end' — so without the command's
    // own EOF watch, a client that exits without killing the server
    // left the process (and the unlocked wallet) alive indefinitely.
    const {spawn} = await import('node:child_process');
    const child = spawn(MOTH_BIN, ['mcp', '--wallet', walletName, '--network', NETWORK], {
      env: {...process.env, MOTH_PASSPHRASE: PASSPHRASE},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '0'}},
      }) + '\n',
    );
    // Wait for the handshake response, then close stdin.
    const deadline = Date.now() + 60_000;
    while (!stdout.includes('"result"') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(stdout, 'no initialize response before closing stdin').toContain('"result"');
    child.stdin.end();

    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('server did not exit within 30s of stdin EOF')), 30_000),
      ),
    ]);
    expect(code).toBe(0);
    // Every stdout line must have been a JSON-RPC frame.
    for (const line of stdout.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 120_000);

  it('registers spend tools when the consent gate passes — but not balance_transaction', async () => {
    const mcp = await connectMcp(walletName, {spend: true});
    try {
      const {tools} = await mcp.client.listTools();
      const names = tools.map((t) => t.name);
      for (const tool of [...READ_TOOLS, ...SPEND_TOOLS]) {
        expect(names).toContain(tool);
      }
      // Balancing/submitting sign or send uncapped externally-built
      // transactions and need their own arming flag on top of the spend gate.
      expect(names).not.toContain('balance_transaction');
      expect(names).not.toContain('submit_transaction');
    } finally {
      await mcp.close();
    }
  }, 120_000);

  it('registers balance_transaction and submit_transaction only under --allow-balancing', async () => {
    const mcp = await connectMcp(walletName, {spend: true, balancing: true});
    try {
      const {tools} = await mcp.client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('balance_transaction');
      expect(names).toContain('submit_transaction');
    } finally {
      await mcp.close();
    }
  }, 120_000);
});

describe.skipIf(!DEVNET_URL)('moth mcp (devnet spend path)', () => {
  let walletName: string;
  let address: string;
  let mcp: McpHandle;

  beforeAll(async () => {
    walletName = await setupTestWallet('mcp-spend', NETWORK);
    address = getReceiveAddress(walletName, NETWORK);
    mcp = await connectMcp(walletName, {spend: true});
    const res = await mcp.client.callTool(
      {name: 'wait_for_sync', arguments: {timeoutMs: 240_000}},
      undefined,
      {timeout: 270_000},
    );
    const s = structured(res);
    expect(s.everSynced, `wallet never synced: ${JSON.stringify(s)}`).toBe(true);
  }, 600_000);

  afterAll(async () => {
    await mcp?.close();
    cleanupTestWallet(walletName);
  });

  it('reports the airdropped NIGHT balance', async () => {
    const res = await mcp.client.callTool({name: 'wallet_balances', arguments: {}});
    expect(res.isError).toBeFalsy();
    const s = structured(res);
    expect(BigInt(s.night.total)).toBeGreaterThan(0n);
  });

  it('transfers NIGHT within the cap and returns a txId', async () => {
    // DUST accrual pays the fee — wait until enough has generated.
    await waitForDustViaMcp(mcp);
    const res = await mcp.client.callTool(
      {name: 'transfer_tokens', arguments: {to: address, amountNight: '1'}},
      undefined,
      {timeout: 300_000},
    );
    expect(res.isError, `transfer failed: ${JSON.stringify(res.content)}`).toBeFalsy();
    const s = structured(res);
    expect(s.txId).toBeTruthy();
  }, 420_000);

  it('refuses a NIGHT transfer above --max-spend with UNAUTHORIZED', async () => {
    const res = await mcp.client.callTool(
      {name: 'transfer_tokens', arguments: {to: address, amountNight: '5000'}},
      undefined,
      {timeout: 120_000},
    );
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{type: string; text?: string}>)
      .map((c) => c.text ?? '')
      .join(' ');
    expect(text).toContain('UNAUTHORIZED');
    expect(text).toContain('max-spend');
  }, 180_000);

  it('rejects malformed transfer inputs without touching the wallet', async () => {
    const res = await mcp.client.callTool({
      name: 'transfer_tokens',
      arguments: {to: address, amountNight: '1', amountRaw: '1'},
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{type: string; text?: string}>)
      .map((c) => c.text ?? '')
      .join(' ');
    expect(text).toContain('INVALID_PARAMS');
  });

  /** Poll wallet_balances over MCP until enough DUST has accrued to pay
   *  a typical fee (same threshold as the daemon harness's waitForDust). */
  async function waitForDustViaMcp(handle: McpHandle, timeoutMs = 300_000): Promise<void> {
    const minDust = 10_000_000_000n;
    const deadline = Date.now() + timeoutMs;
    let last = '0';
    while (Date.now() < deadline) {
      const res = await handle.client.callTool({name: 'wallet_balances', arguments: {}});
      if (!res.isError) {
        last = (structured(res).dust?.speck as string) ?? '0';
        if (BigInt(last) >= minDust) return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`DUST never reached ${minDust} within ${timeoutMs}ms (last=${last})`);
  }
});
