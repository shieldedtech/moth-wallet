import SwiftUI

struct LogsView: View {
    @State private var text = ""

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text.isEmpty ? "No log entries yet." : text)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                Color.clear.frame(height: 1).id("end")
            }
            .onAppear {
                text = DebugLog.read()
                proxy.scrollTo("end")
            }
        }
        .navigationTitle("Logs")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { text = DebugLog.read() }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                ShareLink(item: DebugLog.url) { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("Share logs")
                Button("Clear", role: .destructive) {
                    DebugLog.clear()
                    text = ""
                }
            }
        }
    }
}
