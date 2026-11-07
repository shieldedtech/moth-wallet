import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { pinnedRequest, spkiSha256, SpkiMismatchError } from '../../../src/proof/pinned-https.js';

const dir = mkdtempSync(join(tmpdir(), 'moth-pin-'));
const keyPath = join(dir, 'key.pem');
const certPath = join(dir, 'cert.pem');

execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
  '-days', '1', '-nodes', '-subj', '/CN=localhost',
], { stdio: 'ignore' });

const pin = spkiSha256(execFileSync('openssl', ['x509', '-in', certPath, '-outform', 'DER']));

let requests = 0;
const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (socket: TLSSocket) => {
    socket.on('data', () => {
      requests += 1;
      socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
    });
  },
);

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('tls test server has no port');
const baseUrl = `https://127.0.0.1:${address.port}`;

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pinnedRequest', () => {
  it('sends the body when the peer SPKI matches the pin', async () => {
    requests = 0;
    const response = await pinnedRequest(baseUrl, '/check', 'POST', new Uint8Array([1, 2, 3]), pin, 5_000);
    expect(response.status).toBe(200);
    expect(requests).toBe(1);
  });

  it('sends nothing when the peer SPKI differs from the pin', async () => {
    requests = 0;
    const wrong = createHash('sha256').update('other').digest('hex');
    await expect(pinnedRequest(baseUrl, '/check', 'POST', new Uint8Array([9]), wrong, 5_000))
      .rejects.toBeInstanceOf(SpkiMismatchError);
    expect(requests).toBe(0);
  });
});
