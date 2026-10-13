import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: WalletModel

    var body: some View {
        ZStack {
            // The engine's web view must be in the window to keep running; it is never shown.
            if let engine = model.engine {
                EngineView(engine: engine).frame(width: 1, height: 1).opacity(0).allowsHitTesting(false)
            }
            content
        }
        .alert("Something went wrong", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.error ?? "")
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .starting:
            ProgressView("Starting Moth…")
        case .failed(let message):
            ContentUnavailableView("Moth could not start", systemImage: "exclamationmark.triangle", description: Text(message))
        case .welcome:
            WelcomeView()
        case .backup(let mnemonic):
            BackupView(mnemonic: mnemonic)
        case .locked:
            LockedView()
        case .unlocked:
            HomeView()
        }
    }
}

private struct EngineView: UIViewRepresentable {
    let engine: Engine
    func makeUIView(context: Context) -> UIView { engine.webView }
    func updateUIView(_ view: UIView, context: Context) {}
}

struct LockedView: View {
    @EnvironmentObject private var model: WalletModel

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "lock.fill").font(.system(size: 48)).foregroundStyle(Theme.moonlime)
            Text("Moth is locked").font(.title2.bold())
            Spacer()
            Button(model.busy ? "Unlocking…" : "Unlock") { Task { await model.unlock() } }
                .buttonStyle(PrimaryButton())
                .disabled(model.busy)
        }
        .padding(24)
        // Prompt straight away on launch and after setup, as other wallets do.
        .task { if model.shouldPromptOnAppear() { await model.unlock() } }
    }
}
