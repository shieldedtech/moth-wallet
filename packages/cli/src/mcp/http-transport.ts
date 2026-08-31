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
// Two listeners, same framing:
//
//   - A **Unix socket** (`--transport socket`), chmod 0600 after bind. Access
//     control is the kernel's, exactly as the daemon's own socket transport does
//     it, so no API keys and no TLS are involved and a hostile web page cannot
//     reach it at all — browsers cannot open Unix sockets. This is the one to
//     prefer, and the only one spend tools are allowed on.
//   - A **loopback TCP port** (`--transport http`), for clients that can only
//     take a URL. Unencrypted and unauthenticated, so any process or user on the
//     host can drive it: read-only, enforced by the command. DNS-rebinding
//     protection rejects requests whose Host header isn't a loopback form, so a
//     rebound domain can't reach the port either.
//
// Loopback-only for TCP is enforced by the command before this module runs.

import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {chmod, stat, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

/** Where to listen. Unix is preferred; TCP exists for URL-only clients. */
export type McpBind =
  | {readonly kind: 'unix'; readonly socketPath: string}
  /** Loopback host + port, both validated by the caller. Port 0 picks a free one. */
  | {readonly kind: 'tcp'; readonly host: string; readonly port: number};

export interface McpHttpOptions {
  readonly bind: McpBind;
  /** Builds a fresh McpServer per MCP session. */
  readonly createMcpServer: () => McpServer;
  readonly log: (msg: string) => void;
}

export interface McpHttpHandle {
  /** How to reach it: `http://127.0.0.1:8765/mcp`, or `unix:/path/to.sock` */
  readonly url: string;
  /** Bound TCP port, or 0 for a Unix socket. */
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
  const {bind} = opts;
  let actualPort = bind.kind === 'tcp' ? bind.port : 0;

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
      // Only meaningful for the TCP listener: a browser cannot open a Unix
      // socket, so there is no rebinding path to protect against — and the Host
      // header a socket client sends is arbitrary, so checking it would reject
      // legitimate clients for no gain.
      ...(bind.kind === 'tcp'
        ? {
            enableDnsRebindingProtection: true,
            allowedHosts: [
              `127.0.0.1:${actualPort}`,
              `localhost:${actualPort}`,
              `[::1]:${actualPort}`,
            ],
          }
        : {}),
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

  if (bind.kind === 'unix') {
    // A socket file left by a killed process would fail the bind with EADDRINUSE
    // even though nothing is listening. Remove it only when it is a socket and
    // nothing answers on it — never a regular file, which would be someone
    // else's data.
    try {
      const info = await stat(bind.socketPath);
      if (!info.isSocket()) {
        throw new Error(
          `refusing to bind ${bind.socketPath}: it exists and is not a socket`,
        );
      }
      await unlink(bind.socketPath);
      opts.log(`removed a stale socket at ${bind.socketPath}`);
    } catch (err) {
      const code = (err as {code?: string}).code;
      if (code !== 'ENOENT') {
        if (code === undefined) throw err;
        // EACCES and friends: let listen() produce the real diagnostic.
      }
    }
  }

  await new Promise<void>((resolveOuter, rejectOuter) => {
    httpServer.once('error', rejectOuter);
    const onListening = () => {
      httpServer.off('error', rejectOuter);
      resolveOuter();
    };
    if (bind.kind === 'unix') httpServer.listen(bind.socketPath, onListening);
    else httpServer.listen(bind.port, bind.host, onListening);
  });

  if (bind.kind === 'unix') {
    // The whole security model of this transport: the socket is created with the
    // process umask, which is typically too permissive. Same tightening the
    // daemon does to its own socket.
    await chmod(bind.socketPath, 0o600);
  } else {
    const address = httpServer.address();
    if (address && typeof address === 'object') actualPort = address.port;
  }

  const url =
    bind.kind === 'unix'
      ? `unix:${bind.socketPath}`
      : `http://${bind.host}:${actualPort}${MCP_PATH}`;

  return {
    url,
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
