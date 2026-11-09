import SwiftUI

struct ContentView: View {
    @StateObject private var model = WebViewModel()

    var body: some View {
        ZStack {
            Color.rtPaper.ignoresSafeArea()

            // The site draws its own bottom bar using env(safe-area-inset-bottom), so the web view runs
            // under the home indicator; at the top it stops below the status bar / notch.
            WebView(model: model)
                .ignoresSafeArea(.container, edges: .bottom)
                .opacity(model.hasLoaded ? 1 : 0)
                .animation(.easeOut(duration: 0.25), value: model.hasLoaded)

            if !model.hasLoaded && model.error == nil {
                Image("LaunchLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 200, height: 200)
            }

            if let message = model.error {
                OfflineView(message: message) { model.retry() }
                    .transition(.opacity)
            }
        }
    }
}

/// Shown when the server can't be reached (no internet, server down).
struct OfflineView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image("LaunchLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 120, height: 120)
                .opacity(0.9)
            Text("Can't reach the table")
                .font(.title2.weight(.bold))
                .foregroundColor(.rtBrown)
            Text(message)
                .font(.body)
                .multilineTextAlignment(.center)
                .foregroundColor(.rtMuted)
            Button(action: retry) {
                Text("Try again")
                    .font(.headline)
                    .padding(.horizontal, 28)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(.rtRed)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.rtPaper.ignoresSafeArea())
    }
}
