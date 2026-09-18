// Register synchronously: ledger imports contain top-level WASM awaits, and
// Chrome can deliver the initial message before those imports finish loading.
import type {ReferenceJob, ReferenceJobMessage} from './reference-job-types';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<ReferenceJob>) => void;
  postMessage: (message: ReferenceJobMessage) => void;
};
scope.onmessage = ({data}) => {
  void (async () => {
    try {
      const {buildReference} = await import('./reference-builder');
      const snapshot = await buildReference(data);
      scope.postMessage({kind: 'complete', snapshot});
    } catch {
      scope.postMessage({kind: 'failed'});
    }
  })();
};
