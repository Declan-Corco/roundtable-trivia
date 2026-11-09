import SwiftUI

/// roundtable for iOS: a native shell around the roundtable website.
/// The game itself (host screen, joining, answering) is the same site players use in a browser,
/// so the app always matches the server without needing an App Store update.
@main
struct RoundtableApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.light)
                .onAppear {
                    // Keep the screen on: a phone that dims mid-question is a missed answer,
                    // and a host screen shouldn't go to sleep during a game.
                    UIApplication.shared.isIdleTimerDisabled = true
                }
        }
    }
}
