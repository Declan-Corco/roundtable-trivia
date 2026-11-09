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

    /// A link that opened the app → the page to show.
    /// - `https://round-table.site/join?pin=…` (universal link from the Camera) → itself
    /// - `roundtable://join?pin=…` (the "Open in app" link) → `https://round-table.site/join?pin=…`
    static func resolve(_ url: URL) -> URL? {
        switch url.scheme?.lowercased() {
        case "roundtable":
            var components = URLComponents(url: startURL, resolvingAgainstBaseURL: false)
            let parts = ([url.host ?? ""] + url.pathComponents).filter { !$0.isEmpty && $0 != "/" }
            components?.path = "/" + parts.joined(separator: "/")
            components?.query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.query
            return components?.url
        case "https", "http":
            return isInternal(url) ? url : nil
        default:
            return nil
        }
    }

    /// Text from a scanned QR code → the join page to open, or nil if it isn't a roundtable game.
    static func joinURL(fromScanned text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), url.scheme != nil {
            if let resolved = resolve(url) { return resolved }
            // A join code from another roundtable server (e.g. a LAN test server): reuse its PIN here.
            if let pin = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "pin" })?.value {
                return join(pin: pin)
            }
            return nil
        }
        return join(pin: trimmed) // a bare 6-digit PIN
    }

    private static func join(pin: String) -> URL? {
        let digits = pin.filter(\.isNumber)
        guard digits.count == 6 else { return nil }
        var components = URLComponents(url: startURL, resolvingAgainstBaseURL: false)
        components?.path = "/join"
        components?.queryItems = [URLQueryItem(name: "pin", value: digits)]
        return components?.url
    }
}

extension Color {
    static let rtPaper = Color(red: 0.992, green: 0.976, blue: 0.953)
    static let rtBrown = Color(red: 0.290, green: 0.173, blue: 0.114)
    static let rtMuted = Color(red: 0.545, green: 0.424, blue: 0.345)
    static let rtRed = Color(red: 0.941, green: 0.306, blue: 0.216)
}
