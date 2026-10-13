import SwiftUI

struct WelcomeView: View {
    @EnvironmentObject private var model: WalletModel
    @State private var restoring = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Your recovery phrase").font(.title2.bold())
                Text("Write these words down, in order, and keep them offline. They are the only way to restore this wallet if you lose this phone. Moth will not show them again.")
                    .foregroundStyle(.secondary)
                let words = mnemonic.split(separator: " ")
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 10) {
                    ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                        HStack(spacing: 8) {
                            Text("\(index + 1)").foregroundStyle(.secondary).monospacedDigit().frame(width: 24, alignment: .trailing)
                            Text(word).font(.body.monospaced())
                        }
                    }
                }
                .padding()
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                .privacySensitive()
                Toggle("I have written down all \(words.count) words", isOn: $confirmed)
                Button("Continue") { model.finishBackup() }
                    .buttonStyle(PrimaryButton())
                    .disabled(!confirmed)
            }
            .padding(24)
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
