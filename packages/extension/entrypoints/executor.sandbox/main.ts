// The capsule executor: the one page of this extension that compiles text, so the only one where
// contract code may run. It is a sandbox page (manifest `sandbox.pages`, with the hand-written CSP
// in wxt.config.ts): an opaque origin, no extension API, reached by nothing but the port the
// offscreen document transfers to it. The page's script is the capsule runtime's own, which
// refuses to serve from anywhere less confined.

import { startExecutorPage } from '@shieldedtech/capsule-host-browser/executor-page';

startExecutorPage();
