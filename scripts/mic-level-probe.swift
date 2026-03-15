import AVFoundation
import AudioToolbox
import CoreMedia
import Foundation

struct AudioDeviceInfo: Codable {
    let name: String
    let uniqueId: String
}

struct ProbeEvent: Codable {
    let type: String
    let deviceName: String
    let level: Double?
    let peak: Double?
    let message: String?
}

func emitJsonLine<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(value) else {
        return
    }

    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func listAudioDevices() {
    let discoverySession = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.microphone, .external],
        mediaType: .audio,
        position: .unspecified
    )

    let devices = discoverySession.devices.map {
        AudioDeviceInfo(name: $0.localizedName, uniqueId: $0.uniqueID)
    }

    emitJsonLine(devices)
}

final class AudioLevelProbe: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let targetDevice: AVCaptureDevice
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "stream-topic-copilot.mic-probe")
    private var lastEmissionAt = Date.distantPast

    init(targetDevice: AVCaptureDevice) {
        self.targetDevice = targetDevice
        super.init()
    }

    func start() throws {
        session.beginConfiguration()

        let input = try AVCaptureDeviceInput(device: targetDevice)
        if session.canAddInput(input) {
          session.addInput(input)
        } else {
          throw NSError(domain: "MicLevelProbe", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to add the selected microphone as a capture input."])
        }

        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]
        output.setSampleBufferDelegate(self, queue: queue)

        if session.canAddOutput(output) {
            session.addOutput(output)
        } else {
            throw NSError(domain: "MicLevelProbe", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unable to add the audio output for the microphone probe."])
        }

        session.commitConfiguration()
        session.startRunning()

        emitJsonLine(ProbeEvent(type: "ready", deviceName: targetDevice.localizedName, level: nil, peak: nil, message: "probe-started"))
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            return
        }

        let dataLength = CMBlockBufferGetDataLength(dataBuffer)
        if dataLength <= 0 {
            return
        }

        let sampleCount = dataLength / MemoryLayout<Int16>.size
        var samples = [Int16](repeating: 0, count: sampleCount)
        let status = samples.withUnsafeMutableBytes { bytes in
            CMBlockBufferCopyDataBytes(dataBuffer, atOffset: 0, dataLength: dataLength, destination: bytes.baseAddress!)
        }

        if status != noErr || sampleCount == 0 {
            return
        }

        var sumSquares = 0.0
        var peak = 0.0

        for sample in samples {
            let normalized = Double(sample) / Double(Int16.max)
            let absolute = abs(normalized)
            peak = max(peak, absolute)
            sumSquares += normalized * normalized
        }

        let rms = sqrt(sumSquares / Double(sampleCount))
        let now = Date()
        if now.timeIntervalSince(lastEmissionAt) < 0.1 {
            return
        }

        lastEmissionAt = now
        let scaledLevel = min(1.0, rms * 6.0)
        emitJsonLine(ProbeEvent(type: "level", deviceName: targetDevice.localizedName, level: scaledLevel, peak: peak, message: nil))
    }
}

@main
struct MicLevelProbeMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let command = arguments.first else {
            fputs("Usage: mic-level-probe <list|probe <device-name|unique-id>>\n", stderr)
            exit(64)
        }

        switch command {
        case "list":
            listAudioDevices()
            exit(0)
        case "probe":
            let selector = arguments.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !selector.isEmpty else {
                fputs("Usage: mic-level-probe probe <device-name|unique-id>\n", stderr)
                exit(64)
            }

            let discoverySession = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.microphone, .external],
                mediaType: .audio,
                position: .unspecified
            )
            guard let device = discoverySession.devices.first(where: { $0.uniqueID == selector || $0.localizedName == selector }) else {
                fputs("Audio device not found: \(selector)\n", stderr)
                exit(1)
            }

            do {
                let probe = AudioLevelProbe(targetDevice: device)
                try probe.start()
                dispatchMain()
            } catch {
                fputs("\(error.localizedDescription)\n", stderr)
                exit(1)
            }
        default:
            fputs("Usage: mic-level-probe <list|probe <device-name|unique-id>>\n", stderr)
            exit(64)
        }
    }
}
