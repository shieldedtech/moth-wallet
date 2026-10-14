# Moth for iOS: how it's wired

Moth is three parts in three languages:

| Part | Language | Where | What it does |
|---|---|---|---|
| App and UI | Swift / SwiftUI | `mobile/ios/Moth/` | Every screen, the Keychain and Face ID handling, the DApp browser, the approval sheets |
| Wallet engine | TypeScript, run as JavaScript and WebAssembly | `mobile/ios/engine/` plus moth's `packages/` | moth's own wallet worker, unchanged: sync, balances, building transactions, the ledger. It runs inside a hidden WebView with no visible UI. |
| Prover | Rust | `mobile/ios/native/`, `mobile/ios/proof-server/` | Makes zero-knowledge proofs on the phone, compiled into the app |

## Components

![Moth for iOS: components, by language](architecture.svg)

Notes on the wiring:

- **The seed never reaches Swift.** Swift reads a random passphrase from the Keychain (Face ID or passcode) and hands it to the engine, which decrypts the keystore and keeps the seed in its session for as long as the wallet is unlocked. Locking, or sending the app to the background, drops it.
- **The engine page has no port.** `EngineScheme` serves it from the app bundle at `moth://engine/`. Its storage (IndexedDB) belongs to that origin, so the origin must never change without a migration.
- **Proofs use loopback for now.** The wallet SDK's prover client accepts only `http(s)` URLs, so the worker calls the in-app proof server at `127.0.0.1:6300`. The same endpoints are reachable in-process at `moth://engine/prover/*`; moving proofs there needs a fetch-based prover client in moth core.
- **DApps are isolated.** The browser uses its own website data store, so DApp pages can't reach the engine's storage. Each call's origin comes from WebKit's record of the frame, never from the page.

## A send

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as SendView<br/>(Swift)
    participant Model as WalletModel<br/>(Swift)
    participant Page as Engine page<br/>(TS, moth://engine)
    participant Worker as Wallet worker<br/>(TS + WASM)
    participant Prover as Proof server<br/>(Rust, in-app)
    participant Node as Midnight node

    User->>UI: amount, recipient, Review
    UI->>Model: estimateFee(transfer)
    Model->>Page: window.moth.estimateFee(...)
    Page->>Worker: os/estimateTransferFee
    Worker-->>UI: fee in DUST
    User->>UI: Send
    UI->>Model: send(transfer)
    Model->>Page: window.moth.send(...)
    Page->>Worker: os/sendTokens (session seed added here)
    Worker->>Worker: build and balance tx (ledger WASM)
    Worker->>Prover: POST /prove (127.0.0.1:6300)
    Prover-->>Worker: proof
    Worker->>Node: submit
    Worker-->>Page: tx hash, then stage events
    Page-->>Model: txStage events
    Model-->>UI: "Submitted" + hash
```

## A DApp call

```mermaid
sequenceDiagram
    autonumber
    participant DApp as DApp page
    participant Inject as inject.js<br/>window.midnight.moth
    participant Browser as DAppBrowser<br/>(Swift)
    participant Model as WalletModel<br/>(Swift)
    participant Page as Engine page<br/>connector.ts
    participant Sheet as ApprovalView<br/>(Swift)
    participant Worker as Wallet worker

    DApp->>Inject: connect("preprod")
    Inject->>Browser: mothConnector.postMessage({method, paramsJson})
    Browser->>Browser: origin = frameInfo.securityOrigin (main frame only)
    Browser->>Model: connectorRequest(origin, method, params)
    Model->>Page: connector.request(origin, ...)
    Page-->>Model: approval event (connect)
    Model->>Sheet: show approval
    Sheet->>Model: Connect
    Model->>Page: connector.resolve(id, true)
    Page->>Page: grant origin for this network
    Page-->>Browser: {ok: true}
    Browser-->>Inject: reply
    Inject-->>DApp: ConnectedAPI
    DApp->>Inject: getUnshieldedAddress()
    Inject->>Browser: request
    Browser->>Model: connectorRequest
    Model->>Page: connector.request
    Page-->>DApp: address (from the unlocked session)
    Note over Page,Worker: balance, transfer, intent and submit calls<br/>go through an approval, then to the worker
```

## Build

```mermaid
flowchart LR
    PKGS["moth packages/<br/>yarn build"] --> BE["scripts/build-engine.sh<br/>tsc · vite · esbuild"]
    LEDGER["scripts/build-ledger-wasm.sh<br/>ledger-v8 + DUST-restore fix"] --> BE
    PRESEED["packages/extension/public/preseed"] --> BE
    BE --> DIST["engine/dist<br/>page · worker · WASM · inject.js · preseed"]
    CARGO["scripts/build-native.sh<br/>cargo, per platform"] --> LIB["libmoth_native.a"]
    ICON["scripts/build-app-icon.sh"] --> ASSETS["Assets.xcassets"]
    DIST --> XC["Xcode: Moth.xcodeproj"]
    LIB --> XC
    ASSETS --> XC
    PARAMS["~/.cache/midnight/zk-params"] -->|"scripts/bundle-resources.sh"| XC
    XC --> APP["Moth.app"]
```
