// Streamable-HTTP host for the MCP server — the "operator runs the
// server, clients connect to a URL" mode. Where stdio ties the server's
// lifetime to one spawning client, this binds a loopback port and
// serves any number of MCP sessions against the same unlocked wallet.
//
// Sessions follow the MCP Streamable HTTP spec: an initialize POST with
// no Mcp-Session-Id creates a session (one McpServer + transport pair —
// registration is cheap; the wallet runtime behind them is shared), and
// every later request routes by that header.
//
// Loopback-only is enforced by the command before this module runs (the
// transport is unencrypted and unauthenticated — same rule as the
// daemon's TCP bind, minus the API keys: local kernel trust only). DNS
// rebinding protection rejects requests whose Host header isn't a
// loopback form, so a hostile web page can't reach the port through a
// rebound domain.

import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

export interface McpHttpOptions {
  /** Loopback host to bind (validated by the caller). */
  readonly host: string;
  /** Port to bind; 0 picks a free port. */
  readonly port: number;
  /** Builds a fresh McpServer per MCP session. */
  readonly createMcpServer: () => McpServer;
  readonly log: (msg: string) => void;
}

export interface McpHttpHandle {
  /** Full MCP endpoint URL, e.g. http://127.0.0.1:8765/mcp */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const MCP_PATH = '/mcp';

function writeJsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({jsonrpc: '2.0', error: {code: -32000, message}, id: null}));
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpHandle> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let actualPort = opts.port;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== MCP_PATH) {
      writeJsonError(res, 404, `not found — the MCP endpoint is ${MCP_PATH}`);
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const transport = sessions.get(sessionId);
      if (!transport) {
        writeJsonError(res, 404, 'session not found — it may have expired; reinitialize');
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      writeJsonError(res, 400, 'missing Mcp-Session-Id header — initialize with a POST first');
      return;
    }

    // No session header on a POST: an initialize request starting a new
    // session. Each session gets its own McpServer + transport pair;
    // the wallet runtime they close over is shared.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
        opts.log(`session ${sid.slice(0, 8)}… opened (${sessions.size} active)`);
      },
      enableDnsRebindingProtection: true,
      allowedHosts: [
        `127.0.0.1:${actualPort}`,
        `localhost:${actualPort}`,
        `[::1]:${actualPort}`,
      ],
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.delete(sid)) {
        opts.log(`session ${sid.slice(0, 8)}… closed (${sessions.size} active)`);
      }
    };
    const mcpServer = opts.createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    // A non-initialize POST lands here too; the SDK rejects it without
    // assigning a session id — drop the orphaned pair.
    if (!transport.sessionId) {
      await transport.close().catch(() => {});
    }
  };

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      opts.log(`request error: ${err instanceof Error ? err.message : String(err)}`);
      writeJsonError(res, 500, 'internal server error');
    });
  });

  await new Promise<void>((resolveOuter, rejectOuter) => {
    httpServer.once('error', rejectOuter);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off('error', rejectOuter);
      resolveOuter();
    });
  });
  const address = httpServer.address();
  if (address && typeof address === 'object') actualPort = address.port;

  return {
    url: `http://${opts.host}:${actualPort}${MCP_PATH}`,
    port: actualPort,
    close: async () => {
      // Order: stop new connections, end every session (closes its
      // SSE streams), then sever any kept-alive sockets so close()
      // can complete.
      const closing = new Promise<void>((resolveOuter) => {
        httpServer.close(() => resolveOuter());
      });
      await Promise.all(
        [...sessions.values()].map((t) => t.close().catch(() => {})),
      );
      sessions.clear();
      httpServer.closeAllConnections();
      await closing;
    },
  };
}
