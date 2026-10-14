import SwiftUI

@main
struct MothApp: App {
    @StateObject private var model = WalletModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(Theme.accent)
                // iOS snapshots the screen for the app switcher once the app is inactive.
                .overlay { if scenePhase != .active { PrivacyCover() } }
                .task { await model.start() }
                // iOS suspends the engine in the background anyway; locking there means
                // the seed is never left in memory behind the app switcher.
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { Task { await model.lock() } }
                }
        }
    }
}

private struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Rectangle().fill(.background)
            Image(systemName: "lock.fill").font(.system(size: 48)).foregroundStyle(Theme.accent)
        }
        .ignoresSafeArea()
    }
}

enum Theme {
    /// Moth's primary colour (packages/extension/assets/globals.css), for fills behind ink text.
    static let moonlime = Color(red: 0xAE / 255, green: 0xEB / 255, blue: 0x6B / 255)
    static let ink = Color(red: 0x1C / 255, green: 0x1F / 255, blue: 0x36 / 255)

    /// Text, icon and control tint. Moonlime is only 1.3:1 on light backgrounds, so light mode
    /// uses a deep green (6.3:1 on white, 5.7:1 on grouped backgrounds); dark mode keeps Moonlime.
    static let accent = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xAE / 255, green: 0xEB / 255, blue: 0x6B / 255, alpha: 1)
            : UIColor(red: 0x3D / 255, green: 0x6B / 255, blue: 0x1F / 255, alpha: 1)
    })
}

/// The app-icon tile, for the welcome and lock screens.
struct MothLogo: View {
    var size: CGFloat = 96

    var body: some View {
        Image("MothLogo")
            .resizable()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous))
            .shadow(color: .black.opacity(0.15), radius: 8, y: 4)
            .accessibilityHidden(true)
    }
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
