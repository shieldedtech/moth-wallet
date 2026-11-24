---
"@shieldedtech/moth-extension": patch
---

Fix local (WASM) proving that never finished. The proof worker imported zkir at module load, and zkir-v2 2.2.0 instantiates its WASM with a top-level await; a module worker can deliver messages before that await settles, so the pool's first job could arrive before the worker's message handler existed and be dropped. Every proof then waited without asking for a key until the pool's timeout. zkir is now imported on the first job, so the handler is in place before any message, and an e2e test checks the built worker instantiates no WASM at load and answers a job posted the moment it starts.
