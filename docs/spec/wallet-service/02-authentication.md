---
status: draft
last-updated: 2026-06-23
---

# 02 — Authentication

## Stage 1 (today, Unix socket)

No daemon-layer AuthN. The Unix socket lives at `~/.moth/sync/<network>/<wallet>.sock`, mode `0600`, inside a `0700` directory. Kernel UID enforcement is the AuthN — only the daemon's own UID can `connect(2)` the socket. Same-host attackers in other UIDs are blocked; same-UID attackers with `ptrace` capabilities can read the daemon's memory anyway, so authenticating them at the socket would be theatre.

## Stage 2 (today, TCP transport)

API key authentication, enforced by the daemon's protocol layer.

### Wire shape

- Token format: `<id>.<secret>` where `id` is 8 hex chars (the first 4 bytes of the secret, hex-encoded) and `secret` is 64 hex chars (32 random bytes from `node:crypto.randomBytes`).
- Presentation: the client issues an `auth` RPC after the version handshake, before any other method:
  ```json
  { "id": "<n>", "method": "auth", "params": { "token": "<id>.<secret>" } }
  ```
- On success the daemon stores `apiKeyId` and `label` on the per-connection context and unlocks every other method on that connection for the rest of its lifetime.
- On failure the server returns `{ error: { code: "UNAUTHORIZED", message: "auth failed" } }` and the connection stays unauthenticated. The client typically closes and retries with the right token.
- Every non-`auth` method on an unauthenticated connection returns `UNAUTHORIZED` with a hint to call `auth` first.

### Storage

Each key lives as one file at `~/.moth/api-keys/<id>.key`, mode `0600`, in a `0700` directory. Record shape:

```json
{
  "id": "df4eb46c",
  "label": "ci-bot",
  "salt": "<32 hex chars>",
  "hashedSecret": "<64 hex chars: sha256(salt || secret)>",
  "createdAt": "2026-06-23T10:17:00.848Z",
  "revokedAt": "2026-06-23T11:00:00.000Z",
  "scopes": ["write"]
}
```

The plaintext secret is shown to the operator **once** by `moth daemon key gen` and never persisted in recoverable form. Lose it and the only recovery is regenerating.

### Hash choice

SHA-256 with a per-record 16-byte salt. The secret is 32 bytes of CSPRNG output — brute-forcing is not viable, so the additional CPU/memory cost of Argon2id is not worth it. The hash exists to defend against a leaked file (where an attacker can read the record but does not have the daemon process's wire-token cache); a stretched hash would slow that down marginally without changing the outcome.

Verification uses `crypto.timingSafeEqual` on the hex bytes so a malformed-but-similar token cannot leak prefix length via timing. A dummy-hash branch fires on every "early reject" path (malformed token, unknown id, revoked record) so the verifier's timing profile is uniform regardless of which check failed.

### Path-traversal defense

The id field of an incoming token is regex-validated as `^[0-9a-f]{8}$` BEFORE any filesystem operation. A token like `../etc/passwd.deadbeef` rejects with no disk touch. Belt-and-suspenders: the IO boundary also resolves the final path and verifies it stays a descendant of the api-keys directory.

### CLI

| Command | Purpose |
|---|---|
| `moth daemon key gen --label "<purpose>"` | Generate, persist, print the plaintext token ONCE on stdout. |
| `moth daemon key list` | Show id, label, scopes, createdAt, revoked status. Never shows the plaintext secret. |
| `moth daemon key revoke <id>` | Stamp `revokedAt`. Record stays so old audit lines still reference a real id; the daemon's verifier rejects every future auth attempt with that id. |

### Server-side policy

`moth daemon serve --transport tcp` refuses to bind unless `ApiKeyStore.hasActiveKey()` returns true. Without keys the operator would be exposing every write verb to anyone reachable on the port. Loopback bind is still TCP and still subject to the same gate — there is no "only block off-loopback" override.

Unix transport runs without an auth handler by default (kernel UID is the AuthN). A future `--require-auth` flag could opt Unix in for parity with TCP; today the option is not exposed.

### Audit trail

Every authenticated RPC entry in `daemon-audit.log` carries:

```json
{
  "transport": "tcp",
  "apiKeyId": "df4eb46c",
  "connId": 17
}
```

alongside the existing `verb / summary / decision / outcome` fields. Operators can answer "what did key X do" by grepping the JSONL.

### Bootstrap

The operator generates the first API key with `moth daemon key gen --label "<purpose>"`. This is a local-only operation — it runs on the same host as the daemon will run on, has no network dependencies, and produces a token before the daemon is started. The chicken-and-egg "need a key to start the daemon, but can't get one without the daemon" problem doesn't apply.

### Pinning to a specific wallet

A key authorises every method on the daemon it authenticates to. Because the daemon is one-process-per-wallet (D-ARCH-2 in [01-architecture.md](./01-architecture.md)), a key is implicitly pinned to that daemon's wallet. Cross-wallet authorisation would require either a multi-wallet daemon (rejected in D-ARCH-2) or a per-wallet key namespace; not in scope today.

## Stage 3 (proposed)

- **TLS termination at a reverse proxy** in front of the daemon's loopback bind. nginx / Caddy handle cert rotation (Let's Encrypt automation works fine), terminate TLS, optionally verify client certs (mTLS), and forward the cleartext `auth`-frame payload to the daemon's loopback port.
- **mTLS as an optional second factor**: when the proxy verifies client certs, it sets a trusted header that the daemon's auth handler can read. The handler still requires a valid API key in addition to the cert — defense in depth, not OR.
- **Token rotation procedure**: same `gen` / `revoke` flow but coordinated with the consumer (Web2 service) so traffic shifts to the new token before the old one is revoked.

## Stage 4 (proposed)

- **OAuth2 client credentials** for multi-tenant cases where the operator is also running an IdP (Auth0, Okta, an in-house issuer). The daemon trusts a JWT signed by the IdP's well-known key. The `auth` RPC takes the JWT in `params.token` and the verifier swaps out — same protocol shape, different validation logic.
- **Per-tenant key namespaces**: in multi-tenant deployments each tenant's daemon has its own `~/.moth/api-keys/` (or KMS-backed equivalent). The tenant router uses the JWT's audience claim to pick which daemon to forward to.

## Open questions

- **Replay protection**: should the `auth` RPC include a nonce + timestamp to prevent a replay-on-stale-token attack? Today the TLS transport at stage 3 prevents replay over the wire; stage 2 loopback has the same guarantee within a host. But a stage-2.5 "TCP without TLS, over a private network" deployment could be vulnerable. Defer to stage 3 design.
- **Long-running session keys**: tokens never expire today. Should they? An optional `expiresAt` field on `ApiKeyRecord` is cheap to add; the question is whether short-lived tokens are useful without a key-rotation automation tier (which is stage 4 territory).
- **Per-call vs per-connection auth**: the current model is "auth once per connection." An alternative is "auth on every RPC." Per-call would let the daemon revoke mid-session, but client complexity goes up and the auditing story changes. Probably not worth the trouble — the operator can `daemon key revoke` and the next connect fails; existing connections continue until they close. Park.
- **Anonymous read for `getState`**: a public dashboard that polls balances might want unauthenticated read. No — even read leaks sync progress + balances. Operators who want a dashboard should provision a dedicated read-class key (waits for stage-2.5 scopes).
- **Federated auth**: can a key issued by a Web2 app's IdP map to the daemon's policy, or do we always need a daemon-side registration step? Stage 4 problem; not blocking.
