import Foundation
import SwiftUI

enum AppConfig {
    /// The roundtable server the app opens. Set with the `RT_SERVER_URL` build setting in project.yml
    /// (or pass `RT_SERVER_URL=...` to scripts/build-ipa.sh); it ends up in Info.plist as `RTServerURL`.
    static let startURL: URL = {
        if let value = Bundle.main.object(forInfoDictionaryKey: "RTServerURL") as? String,
           let url = URL(string: value.trimmingCharacters(in: .whitespaces)),
           url.scheme != nil {
            return url
        }
        return URL(string: "https://round-table.site")!
    }()

    /// Pages on the roundtable server stay in the app; everything else opens in Safari.
    static func isInternal(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased(), let home = startURL.host?.lowercased() else { return false }
        return host == home || host == "www." + home || "www." + host == home
    }
}

extension Color {
    static let rtPaper = Color(red: 0.992, green: 0.976, blue: 0.953)
    static let rtBrown = Color(red: 0.290, green: 0.173, blue: 0.114)
    static let rtMuted = Color(red: 0.545, green: 0.424, blue: 0.345)
    static let rtRed = Color(red: 0.941, green: 0.306, blue: 0.216)
}
