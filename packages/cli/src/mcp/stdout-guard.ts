// Under the MCP stdio transport, stdout carries JSON-RPC frames and
// nothing else — a single stray line corrupts the channel and the
// client drops the connection. Core's installLogSuppression only
// filters a curated noise list; the @polkadot logger and any un-listed
// SDK console.log still reach stdout. So the command claims the real
// stdout for the transport and reroutes everything else to stderr.
//
// Must be installed BEFORE startWalletSync: log suppression binds
// whatever process.stdout.write is at first-sync time, so installing
// the guard first means suppression stacks harmlessly on top of the
// rerouted writer.

import {Writable} from 'node:stream';

/**
 * Claim the process's real stdout for exclusive use and return it as a
 * Writable (hand this to StdioServerTransport). After this call, any
 * other code writing to process.stdout — console.log, SDK loggers,
 * stray prints — is forwarded to stderr instead.
 */
export function guardStdout(): Writable {
  const rawWrite = process.stdout.write.bind(process.stdout);

  const raw = new Writable({
    write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      rawWrite(chunk, encoding, callback);
    },
  });

  process.stdout.write = ((
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    if (typeof encodingOrCb === 'function') {
      return process.stderr.write(chunk, encodingOrCb);
    }
    return process.stderr.write(chunk, encodingOrCb, cb);
  }) as typeof process.stdout.write;

  return raw;
}
