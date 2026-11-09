import AVFoundation
import UIKit

/// Full-screen camera that reads one QR code, then calls `onResult` with its text (nil if cancelled).
final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onResult: ((String?) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            addOverlay(message: "The camera isn't available on this device.")
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            addOverlay(message: "The camera isn't available right now.")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        previewLayer = preview

        addOverlay(message: "Point your camera at the QR code on the host screen")
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput,
                                    didOutput metadataObjects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        guard let text = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        Task { @MainActor in self.finish(with: text) }
    }

    private func finish(with text: String?) {
        guard !finished else { return }
        finished = true
        if text != nil { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        onResult?(text)
    }

    @objc private func cancelTapped() {
        finish(with: nil)
    }

    // MARK: Overlay: a viewfinder frame, a hint and a Cancel button

    private func addOverlay(message: String) {
        let frame = UIView()
        frame.translatesAutoresizingMaskIntoConstraints = false
        frame.layer.borderColor = UIColor.white.cgColor
        frame.layer.borderWidth = 4
        frame.layer.cornerRadius = 28
        frame.isUserInteractionEnabled = false

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = message
        label.textColor = .white
        label.font = .systemFont(ofSize: 18, weight: .semibold)
        label.textAlignment = .center
        label.numberOfLines = 0

        var config = UIButton.Configuration.filled()
        config.title = "Cancel"
        config.baseBackgroundColor = UIColor(red: 0.992, green: 0.976, blue: 0.953, alpha: 1)
        config.baseForegroundColor = UIColor(red: 0.290, green: 0.173, blue: 0.114, alpha: 1)
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 32, bottom: 12, trailing: 32)
        let cancel = UIButton(configuration: config)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        view.addSubview(frame)
        view.addSubview(label)
        view.addSubview(cancel)
        let preferredWidth = frame.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.7)
        preferredWidth.priority = .defaultHigh // gives way to the 320pt cap on big screens
        NSLayoutConstraint.activate([
            frame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            frame.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -30),
            preferredWidth,
            frame.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
            frame.heightAnchor.constraint(equalTo: frame.widthAnchor),

            label.topAnchor.constraint(equalTo: frame.bottomAnchor, constant: 24),
            label.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),

            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
    }
}
