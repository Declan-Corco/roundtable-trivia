import SwiftUI
import WebKit

/// Load state shared between the web view and the SwiftUI screen around it.
@MainActor
final class WebViewModel: ObservableObject {
    @Published var hasLoaded = false
    @Published var error: String?
    weak var webView: WKWebView?

    func retry() {
        error = nil
        guard let webView else { return }
        webView.load(URLRequest(url: webView.url ?? AppConfig.startURL))
    }
}

struct WebView: UIViewRepresentable {
    @ObservedObject var model: WebViewModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "haptic")
        contentController.addUserScript(
            WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.websiteDataStore = .default() // keeps the player's session so they rejoin after a relaunch
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "RoundtableApp/1.0"

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true } // Safari > Develop menu
        #endif

        model.webView = webView
        webView.load(URLRequest(url: AppConfig.startURL))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    /// Runs before the site's own scripts:
    /// - routes the web Vibration API (unsupported in iOS web views) to native haptics
    /// - tags the page so the site can hide browser-only controls (e.g. the Fullscreen button)
    static let bridgeScript = """
    (function () {
      navigator.vibrate = function (pattern) {
        try {
          var pulses = Array.isArray(pattern) ? Math.ceil(pattern.length / 2) : 1;
          window.webkit.messageHandlers.haptic.postMessage(pulses);
        } catch (e) {}
        return true;
      };
      document.documentElement.classList.add('ios-app');
    })();
    """

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private let model: WebViewModel

        init(model: WebViewModel) {
            self.model = model
        }

        // MARK: Haptics bridge

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "haptic" else { return }
            let pulses = (message.body as? Int) ?? 1
            if pulses > 1 {
                UINotificationFeedbackGenerator().notificationOccurred(.success) // e.g. a correct answer
            } else {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred() // e.g. tapping an answer
            }
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
            let scheme = url.scheme?.lowercased() ?? ""
            if ["about", "blob", "data"].contains(scheme) || AppConfig.isInternal(url) {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url) // other sites, mailto:, tel: → Safari / system
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.hasLoaded = true
            model.error = nil
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            show(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            show(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload() // iOS killed the page in the background; bring it back
        }

        private func show(_ error: Error) {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            model.error = nsError.domain == NSURLErrorDomain
                ? "Check your internet connection, then try again."
                : "Something went wrong loading the game (\(nsError.localizedDescription))."
        }

        // MARK: Windows and dialogs

        /// Links that open a new window (target="_blank") load in place, or in Safari if external.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                if AppConfig.isInternal(url) { webView.load(navigationAction.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        /// alert() — without this, web views silently ignore it.
        func webView(_ webView: WKWebView,
                     runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping () -> Void) {
            guard let presenter = topViewController(of: webView) else { return completionHandler() }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            presenter.present(alert, animated: true)
        }

        /// confirm() — used by the host's "End game" button. Without this it would always return false.
        func webView(_ webView: WKWebView,
                     runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (Bool) -> Void) {
            guard let presenter = topViewController(of: webView) else { return completionHandler(false) }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .destructive) { _ in completionHandler(true) })
            presenter.present(alert, animated: true)
        }

        private func topViewController(of view: UIView) -> UIViewController? {
            var controller = view.window?.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller
        }
    }
}
