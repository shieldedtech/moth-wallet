import SwiftUI

struct WelcomeView: View {
    @EnvironmentObject private var model: WalletModel
    @State private var restoring = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            MothLogo(size: 112)
            Text("Moth").font(.system(size: 48, weight: .bold))
            Text("A Midnight wallet. Preprod testnet only.")
                .foregroundStyle(.secondary)
            Spacer()
            Button(model.busy ? "Creating…" : "Create a new wallet") { Task { await model.create() } }
                .buttonStyle(PrimaryButton())
                .disabled(model.busy)
            Button("I have a recovery phrase") { restoring = true }
                .foregroundStyle(.primary)
                .padding(.vertical, 8)
                .disabled(model.busy)
        }
        .padding(24)
        .sheet(isPresented: $restoring) { RestoreView() }
    }
}

struct BackupView: View {
    @EnvironmentObject private var model: WalletModel
    let mnemonic: String
    @State private var confirmed = false
    @State private var captured = UIScreen.main.isCaptured
    @State private var screenshotTaken = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Your recovery phrase").font(.title2.bold())
                if captured || screenshotTaken {
                    Label(captured ? "Your screen is being recorded or mirrored. Stop before writing these words down."
                                   : "A screenshot of these words is a copy anyone with your photos can use. Delete it.",
                          systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                Text("Write these words down, in order, and keep them offline. They are the only way to restore this wallet if you lose this phone. Moth will not show them again.")
                    .foregroundStyle(.secondary)
                PhraseGrid(phrase: mnemonic)
                let words = mnemonic.split(separator: " ")
                Toggle("I have written down all \(words.count) words", isOn: $confirmed)
                Button("Continue") { model.finishBackup() }
                    .buttonStyle(PrimaryButton())
                    .disabled(!confirmed)
            }
            .padding(24)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)) { _ in
            captured = UIScreen.main.isCaptured
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
            screenshotTaken = true
        }
    }
}

struct RestoreView: View {
    @EnvironmentObject private var model: WalletModel
    @Environment(\.dismiss) private var dismiss
    @State private var phrase = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $phrase)
                        .frame(minHeight: 140)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .privacySensitive()
                } footer: {
                    Text("Enter your 24 words separated by spaces. A restored wallet scans the chain from the start, so its first sync takes longer.")
                }
            }
            .navigationTitle("Restore")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Restore") {
                        Task {
                            await model.restore(phrase: phrase)
                            if model.error == nil { dismiss() }
                        }
                    }
                    .disabled(phrase.split(whereSeparator: \.isWhitespace).count < 12 || model.busy)
                }
            }
        }
    }
}

/// A recovery phrase as numbered words, two columns.
struct PhraseGrid: View {
    let phrase: String

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 10) {
            ForEach(Array(phrase.split(separator: " ").enumerated()), id: \.offset) { index, word in
                HStack(spacing: 8) {
                    Text("\(index + 1)").foregroundStyle(.secondary).monospacedDigit().frame(width: 24, alignment: .trailing)
                    Text(word).font(.body.monospaced())
                }
            }
        }
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .privacySensitive()
    }
}

/// Shows the active account's recovery phrase again, for writing it down.
struct ShowPhraseView: View {
    @EnvironmentObject private var model: WalletModel
    @Environment(\.dismiss) private var dismiss
    @State private var phrase: String?
    @State private var captured = UIScreen.main.isCaptured

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Write these words down, in order, and keep them offline. Anyone who sees them can take this account's funds.")
                        .foregroundStyle(.secondary)
                    if captured {
                        Label("Your screen is being recorded or mirrored.", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                    if let phrase {
                        if phrase.contains(" ") {
                            PhraseGrid(phrase: phrase)
                        } else {
                            Text("This account was imported from a seed, not a phrase:").foregroundStyle(.secondary)
                            Text(phrase).font(.body.monospaced()).textSelection(.enabled).privacySensitive()
                        }
                    } else {
                        ProgressView()
                    }
                }
                .padding(24)
            }
            .navigationTitle("Recovery phrase")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                do {
                    phrase = try await model.recoveryPhrase()
                } catch {
                    if case VaultError.canceled = error {} else { model.error = error.localizedDescription }
                    dismiss()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)) { _ in
                captured = UIScreen.main.isCaptured
            }
        }
    }
}
