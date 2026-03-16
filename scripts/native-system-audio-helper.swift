import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

private enum HelperError: Error, CustomStringConvertible {
    case invalidArguments(String)
    case unsupportedPlatform(String)
    case missingTarget(String)
    case streamFailure(String)

    var description: String {
        switch self {
        case .invalidArguments(let message),
             .unsupportedPlatform(let message),
             .missingTarget(let message),
             .streamFailure(let message):
            return message
        }
    }
}

private struct OutputWriter {
    static func printJSON(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let text = String(data: data, encoding: .utf8) else {
            return
        }

        print(text)
        fflush(stdout)
    }

    static func printError(_ message: String) {
        printJSON(["type": "error", "message": message])
    }
}

private struct Arguments {
    let command: String
    let options: [String: String]

    init() {
        let values = Array(CommandLine.arguments.dropFirst())
        self.command = values.first ?? "status"
        var parsed: [String: String] = [:]
        var index = 1
        while index < values.count {
            let key = values[index]
            if key.hasPrefix("--"), index + 1 < values.count {
                parsed[key] = values[index + 1]
                index += 2
            } else {
                index += 1
            }
        }
        self.options = parsed
    }

    func value(for option: String) -> String? {
        options["--\(option)"]
    }
}

@available(macOS 13.0, *)
private func permissionStatus() async -> String {
    if CGPreflightScreenCaptureAccess() {
        return "granted"
    }

    do {
        _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        return "granted"
    } catch {
        let message = error.localizedDescription.lowercased()
        if message.contains("declined tcc") || message.contains("not authorized") {
            return "denied"
        }
    }

    return "not-determined"
}

private func requestScreenCapturePermission() async -> String {
    if CGPreflightScreenCaptureAccess() {
        return "granted"
    }

    let granted = CGRequestScreenCaptureAccess()
    if granted {
        return "granted"
    }

    if #available(macOS 13.0, *) {
        return await permissionStatus()
    }

    return "unknown"
}

private func requestPermissionIfNeeded() {
    if !CGPreflightScreenCaptureAccess() {
        _ = CGRequestScreenCaptureAccess()
    }
}

@available(macOS 13.0, *)
private func listTargets() async throws {
    requestPermissionIfNeeded()
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let displays = content.displays.map { display in
        [
            "id": String(display.displayID),
            "name": "Display \(display.displayID)",
            "displayId": String(display.displayID),
            "isDefault": display == content.displays.first
        ]
    }
    let applications = content.applications
        .filter { app in app.bundleIdentifier != Bundle.main.bundleIdentifier }
        .map { app in
            [
                "id": String(app.processID),
                "name": app.applicationName,
                "bundleId": app.bundleIdentifier
            ]
        }

    OutputWriter.printJSON([
        "displays": displays,
        "applications": applications
    ])
}

@available(macOS 13.0, *)
private final class NativeAudioCaptureCoordinator: NSObject, SCStreamOutput, SCStreamDelegate {
    private let sourceKind: String
    private let targetId: String
    private let bundleId: String?
    private let outputDir: URL
    private let sourceId: String
    private let segmentDuration: TimeInterval = 5
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private let queue = DispatchQueue(label: "native-system-audio-helper.audio")

    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var currentSamples: [Int16] = []
    private var currentSegmentStartedAt = Date()
    private var segmentIndex = 0
    private var isStopping = false
    private var reconnectAttempts = 0

    init(sourceKind: String, targetId: String, bundleId: String?, outputDir: URL, sourceId: String) {
        self.sourceKind = sourceKind
        self.targetId = targetId
        self.bundleId = bundleId
        self.outputDir = outputDir
        self.sourceId = sourceId
    }

    func start() async throws {
        requestPermissionIfNeeded()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let filter = makeFilter(from: content) else {
            throw HelperError.missingTarget("Could not find target \(targetId) for \(sourceKind).")
        }

        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 16_000
        configuration.channelCount = 1
        configuration.queueDepth = 1
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
        self.currentSegmentStartedAt = Date()
        try await stream.startCapture()
    }

    func stop() async {
        isStopping = true
        if let stream {
            try? await stream.stopCapture()
        }
        flushSegment(force: true)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        if shouldReconnect(for: error) {
            reconnectAttempts += 1
            OutputWriter.printJSON([
                "type": "warning",
                "message": "Native capture connection was interrupted. Reconnecting..."
            ])
            Task {
                do {
                    try await restartCapture()
                } catch {
                    OutputWriter.printError(error.localizedDescription)
                }
            }
            return
        }

        OutputWriter.printError(error.localizedDescription)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else {
            return
        }

        do {
            try process(sampleBuffer: sampleBuffer)
        } catch {
            OutputWriter.printError(error.localizedDescription)
        }
    }

    private func makeFilter(from content: SCShareableContent) -> SCContentFilter? {
        guard let primaryDisplay = content.displays.first else {
            return nil
        }

        if sourceKind == "native-display-audio" {
            guard let display = content.displays.first(where: { String($0.displayID) == targetId }) else {
                return nil
            }
            return SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        }

        let app = content.applications.first(where: { String($0.processID) == targetId })
            ?? content.applications.first(where: { $0.bundleIdentifier == bundleId })
        guard let app else {
            return nil
        }

        let appWindows = content.windows.filter { window in
            if window.owningApplication?.processID == app.processID {
                return true
            }
            if let bundleId, window.owningApplication?.bundleIdentifier == bundleId {
                return true
            }
            return false
        }
        let display = displayForAppWindows(appWindows, displays: content.displays) ?? primaryDisplay
        return SCContentFilter(display: display, including: [app], exceptingWindows: [])
    }

    private func displayForAppWindows(_ windows: [SCWindow], displays: [SCDisplay]) -> SCDisplay? {
        guard !windows.isEmpty, !displays.isEmpty else {
            return nil
        }

        var bestDisplay: SCDisplay?
        var bestOverlap: CGFloat = 0

        for window in windows {
            for display in displays {
                let overlap = window.frame.intersection(display.frame)
                let area = max(0, overlap.width) * max(0, overlap.height)
                if area > bestOverlap {
                    bestOverlap = area
                    bestDisplay = display
                }
            }
        }

        return bestDisplay
    }

    private func shouldReconnect(for error: Error) -> Bool {
        guard !isStopping, (sourceKind == "native-app-audio" || sourceKind == "native-display-audio"), reconnectAttempts < 4 else {
            return false
        }

        let message = error.localizedDescription.lowercased()
        return message.contains("application connection being interrupted")
            || message.contains("application connection invalid")
    }

    private func restartCapture() async throws {
        if let stream {
            try? await stream.stopCapture()
            self.stream = nil
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let filter = makeFilter(from: content) else {
            throw HelperError.missingTarget("Could not reconnect target \(bundleId ?? targetId) for \(sourceKind).")
        }

        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 16_000
        configuration.channelCount = 1
        configuration.queueDepth = 1
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
    }

    private func process(sampleBuffer: CMSampleBuffer) throws {
        guard let pcmBuffer = sampleBuffer.toPCMBuffer() else {
            return
        }

        if converter == nil {
            converter = AVAudioConverter(from: pcmBuffer.format, to: targetFormat)
        }

        guard let converted = convertBuffer(pcmBuffer) else {
            return
        }

        append(buffer: converted)
    }

    private func convertBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else {
            return nil
        }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let frameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCapacity) else {
            return nil
        }

        var sourceBuffer: AVAudioPCMBuffer? = buffer
        var error: NSError?
        let status = converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if let next = sourceBuffer {
                sourceBuffer = nil
                outStatus.pointee = .haveData
                return next
            }

            outStatus.pointee = .noDataNow
            return nil
        }

        guard error == nil else {
            OutputWriter.printError(error?.localizedDescription ?? "Audio conversion failed.")
            return nil
        }
        guard status == .haveData || status == .inputRanDry else {
            return nil
        }

        return outputBuffer
    }

    private func append(buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.int16ChannelData?[0] else {
            return
        }

        let frameCount = Int(buffer.frameLength)
        let samples = Array(UnsafeBufferPointer(start: channel, count: frameCount))
        currentSamples.append(contentsOf: samples)

        let rms = rootMeanSquare(samples)
        OutputWriter.printJSON([
            "type": "level",
            "sourceId": sourceId,
            "level": rms
        ])

        if Date().timeIntervalSince(currentSegmentStartedAt) >= segmentDuration {
            flushSegment(force: false)
        }
    }

    private func flushSegment(force: Bool) {
        if currentSamples.isEmpty && !force {
            return
        }

        guard !currentSamples.isEmpty else {
            currentSegmentStartedAt = Date()
            return
        }

        segmentIndex += 1
        let endedAt = Date()
        let fileURL = outputDir.appendingPathComponent(String(format: "segment-%03d.wav", segmentIndex))
        do {
            try writeWaveFile(samples: currentSamples, to: fileURL, sampleRate: 16_000)
            OutputWriter.printJSON([
                "type": "segment",
                "sourceId": sourceId,
                "path": fileURL.path,
                "startedAt": ISO8601DateFormatter().string(from: currentSegmentStartedAt),
                "endedAt": ISO8601DateFormatter().string(from: endedAt)
            ])
        } catch {
            OutputWriter.printError(error.localizedDescription)
        }

        currentSamples.removeAll(keepingCapacity: true)
        currentSegmentStartedAt = endedAt
    }
}

@available(macOS 13.0, *)
private extension CMSampleBuffer {
    func toPCMBuffer() -> AVAudioPCMBuffer? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(self),
              let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return nil
        }

        let audioFormat = AVAudioFormat(streamDescription: streamDescription)
        let sampleCount = CMSampleBufferGetNumSamples(self)
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: audioFormat!, frameCapacity: AVAudioFrameCount(sampleCount)) else {
            return nil
        }
        pcmBuffer.frameLength = pcmBuffer.frameCapacity

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            self,
            at: 0,
            frameCount: Int32(sampleCount),
            into: pcmBuffer.mutableAudioBufferList
        )
        guard status == noErr else {
            return nil
        }

        return pcmBuffer
    }
}

private func rootMeanSquare(_ samples: [Int16]) -> Double {
    guard !samples.isEmpty else {
        return 0
    }

    let total = samples.reduce(0.0) { partial, sample in
        let normalized = Double(sample) / Double(Int16.max)
        return partial + (normalized * normalized)
    }
    return min(1.0, sqrt(total / Double(samples.count)))
}

private func writeWaveFile(samples: [Int16], to url: URL, sampleRate: Int) throws {
    var data = Data()
    let byteRate = sampleRate * 2
    let blockAlign: UInt16 = 2
    let bitsPerSample: UInt16 = 16
    let payloadSize = samples.count * MemoryLayout<Int16>.size
    let riffSize = 36 + payloadSize

    data.append("RIFF".data(using: .ascii)!)
    data.append(littleEndian(UInt32(riffSize)))
    data.append("WAVE".data(using: .ascii)!)
    data.append("fmt ".data(using: .ascii)!)
    data.append(littleEndian(UInt32(16)))
    data.append(littleEndian(UInt16(1)))
    data.append(littleEndian(UInt16(1)))
    data.append(littleEndian(UInt32(sampleRate)))
    data.append(littleEndian(UInt32(byteRate)))
    data.append(littleEndian(blockAlign))
    data.append(littleEndian(bitsPerSample))
    data.append("data".data(using: .ascii)!)
    data.append(littleEndian(UInt32(payloadSize)))

    for sample in samples {
        data.append(littleEndian(UInt16(bitPattern: sample)))
    }

    try data.write(to: url)
}

private func littleEndian(_ value: UInt16) -> Data {
    var copy = value.littleEndian
    return Data(bytes: &copy, count: MemoryLayout<UInt16>.size)
}

private func littleEndian(_ value: UInt32) -> Data {
    var copy = value.littleEndian
    return Data(bytes: &copy, count: MemoryLayout<UInt32>.size)
}

@main
struct NativeSystemAudioHelperMain {
    static func main() async {
        let arguments = Arguments()

        do {
            switch arguments.command {
            case "status":
                if #available(macOS 13.0, *) {
                    print(await permissionStatus())
                } else {
                    print("unavailable")
                }
            case "request":
                if #available(macOS 13.0, *) {
                    print(await requestScreenCapturePermission())
                } else {
                    print("unavailable")
                }
            case "list":
                guard #available(macOS 13.0, *) else {
                    throw HelperError.unsupportedPlatform("ScreenCaptureKit requires macOS 13 or newer.")
                }
                try await listTargets()
            case "capture":
                guard #available(macOS 13.0, *) else {
                    throw HelperError.unsupportedPlatform("ScreenCaptureKit requires macOS 13 or newer.")
                }
                let kind = arguments.value(for: "kind") ?? ""
                let targetId = arguments.value(for: "target-id") ?? ""
                let sourceId = arguments.value(for: "source-id") ?? targetId
                let bundleId = arguments.value(for: "bundle-id")
                let outputDirValue = arguments.value(for: "output-dir") ?? ""
                guard !kind.isEmpty, !targetId.isEmpty, !outputDirValue.isEmpty else {
                    throw HelperError.invalidArguments("Usage: native-system-audio-helper capture --kind <kind> --target-id <id> --source-id <source-id> --output-dir <path>")
                }

                let coordinator = NativeAudioCaptureCoordinator(
                    sourceKind: kind,
                    targetId: targetId,
                    bundleId: bundleId,
                    outputDir: URL(fileURLWithPath: outputDirValue, isDirectory: true),
                    sourceId: sourceId
                )
                try await coordinator.start()

                let signalQueue = DispatchQueue(label: "native-system-audio-helper.signal")
                signal(SIGTERM, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
                source.setEventHandler {
                    Task {
                        await coordinator.stop()
                        exit(0)
                    }
                }
                source.resume()

                dispatchMain()
            default:
                throw HelperError.invalidArguments("Usage: native-system-audio-helper [status|request|list|capture]")
            }
        } catch {
            fputs("\(error)\n", stderr)
            exit(1)
        }
    }
}
