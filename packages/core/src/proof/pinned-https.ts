import { createHash } from 'node:crypto';
import * as https from 'node:https';
import type { RequestOptions } from 'node:https';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';
import * as pkijs from 'pkijs';

const HANDSHAKE_MS = 10_000;

/** The live certificate's SPKI is a different key from the one PCR 15 commits to. */
export class SpkiMismatchError extends Error {
  constructor(presented: string, pinned: string) {
    super(`presented SPKI ${presented} does not match the pinned ${pinned}`);
    this.name = 'SpkiMismatchError';
  }
}

/** SHA-256 of the certificate's SubjectPublicKeyInfo, the same encoding phase 5 uses. */
export function spkiSha256(certDer: Uint8Array): string {
  const copy = new Uint8Array(certDer);
  const cert = pkijs.Certificate.fromBER(copy.buffer as ArrayBuffer);
  const spkiDer = new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER(false));
  return createHash('sha256').update(spkiDer).digest('hex');
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Checks the peer certificate inside the TLS handshake, before the request
 * body is written. Trust is the pin: `rejectUnauthorized` is off, and a
 * certificate whose SPKI differs is destroyed in the handshake callback.
 */
class PinnedAgent extends https.Agent {
  /** Set when the handshake rejects the peer. The request may also see a socket hang-up from the destroyed socket; this is the error to surface. */
  handshakeError: Error | null = null;

  constructor(private readonly expected: string) {
    super({ keepAlive: false, rejectUnauthorized: false });
  }

  override createConnection(
    options: RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex {
    const host = String(options.host ?? options.hostname ?? '').replace(/^\[|\]$/g, '');
    const port = Number(options.port ?? 443);
    let settled = false;
    const done = (error: Error | null, socket: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      if (error) socket.destroy();
      callback?.(error, socket);
    };
    const socket = tls.connect(
      {
        host,
        port,
        rejectUnauthorized: false,
        servername: isIpLiteral(host) ? undefined : host,
      },
      () => {
        clearTimeout(timer);
        try {
          const raw = socket.getPeerCertificate(true).raw;
          const presented = raw ? spkiSha256(raw) : '';
          if (presented !== this.expected) {
            const mismatch = new SpkiMismatchError(presented || '(none)', this.expected);
            this.handshakeError = mismatch;
            done(mismatch, socket);
            return;
          }
          done(null, socket);
        } catch (cause) {
          done(cause instanceof Error ? cause : new Error(String(cause)), socket);
        }
      },
    );
    const timer = setTimeout(() => {
      done(new Error(`TLS handshake to ${host}:${port} timed out`), socket);
    }, HANDSHAKE_MS);
    socket.on('error', (error) => {
      clearTimeout(timer);
      done(error, socket);
    });
    return socket;
  }
}

/**
 * HTTPS request pinned to `pin`. A mismatch rejects from the handshake, which
 * is before the body is written to the socket.
 */
export function pinnedRequest(
  baseUrl: string,
  path: '/check' | '/prove' | '/ready',
  method: 'GET' | 'POST',
  body: Uint8Array | undefined,
  pin: string,
  timeoutMs: number,
): Promise<{ status: number; body: Uint8Array }> {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/$/, '') + path;
  const agent = new PinnedAgent(pin.toLowerCase());

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, result?: { status: number; body: Uint8Array }) => {
      if (settled) return;
      settled = true;
      agent.destroy();
      if (error) reject(error);
      else resolve(result!);
    };

    const req = https.request(
      url,
      {
        method,
        agent,
        rejectUnauthorized: false,
        headers: body ? { 'content-type': 'application/octet-stream' } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error) => finish(error));
        res.on('end', () => {
          finish(null, { status: res.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks)) });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(new Error(`${method} ${path} timed out`));
    });
    req.on('error', (error) => finish(agent.handshakeError ?? error));
    if (body) req.write(Buffer.from(body));
    req.end();
  });
}
