import SwiftUI

@main
struct MothApp: App {
    @StateObject private var model = WalletModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(Theme.moonlime)
                .task { await model.start() }
                // iOS suspends the engine in the background anyway; locking there means
                // the seed is never left in memory behind the app switcher.
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { Task { await model.lock() } }
                }
        }
    }
}

enum Theme {
    /// Moth's primary colour (packages/extension/assets/globals.css).
    static let moonlime = Color(red: 0xAE / 255, green: 0xEB / 255, blue: 0x6B / 255)
    static let ink = Color(red: 0x1C / 255, green: 0x1F / 255, blue: 0x36 / 255)
}

struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.moonlime.opacity(configuration.isPressed ? 0.7 : 1))
            .foregroundStyle(Theme.ink)
            .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}
