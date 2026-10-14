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
        .background(TouchObserver { model.noteActivity() }.frame(width: 0, height: 0))
        .alert("Something went wrong", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.error ?? "")
        }
        .alert("DUST", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
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
            MothLogo(size: 112)
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

/// Reports every touch in the window, for auto-lock. Its recognizer fails as soon as a touch
/// begins, so it never delays or cancels a control's own gestures.
private struct TouchObserver: UIViewRepresentable {
    let onTouch: () -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            if !(window.gestureRecognizers ?? []).contains(where: { $0 is Recognizer }) {
                window.addGestureRecognizer(Recognizer(onTouch: onTouch))
            }
        }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}

    private final class Recognizer: UIGestureRecognizer {
        let onTouch: () -> Void

        init(onTouch: @escaping () -> Void) {
            self.onTouch = onTouch
            super.init(target: nil, action: nil)
            cancelsTouchesInView = false
            delaysTouchesBegan = false
            delaysTouchesEnded = false
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            onTouch()
            state = .failed
        }
    }
}
