// The SDK records a submitted transaction as pending before it is sent, and as
// rejected when it will never land. Neither write moves a sync counter, so a
// host that re-reads history only when sync applies something never shows them.

/** The two history writes that record a submission's own fate. */
interface SubmissionVerdictWriter {
  gotPending(entry: {hash: string}): Promise<void>;
  gotRejected(entry: {hash: string}): Promise<void>;
}

/**
 * Make `storage` report each pending or rejected entry it records, once the
 * write has succeeded. The storage is changed in place and returned, so every
 * other method keeps working on the same instance.
 */
export function notifyOnSubmissionVerdicts<S extends SubmissionVerdictWriter>(
  storage: S,
  onChange: (hash: string) => void
): S {
  const notify = (hash: string) => {
    try {
      onChange(hash);
    } catch {
      /* a listener must never fail the SDK's own write */
    }
  };
  const gotPending = storage.gotPending.bind(storage);
  const gotRejected = storage.gotRejected.bind(storage);
  storage.gotPending = async (entry) => {
    await gotPending(entry);
    notify(entry.hash);
  };
  storage.gotRejected = async (entry) => {
    await gotRejected(entry);
    notify(entry.hash);
  };
  return storage;
}
