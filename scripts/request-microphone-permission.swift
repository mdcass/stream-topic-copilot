import AVFoundation
import Foundation

@main
struct RequestMicrophonePermission {
    static func main() async {
        let mode = CommandLine.arguments.dropFirst().first ?? "status"
        switch mode {
        case "request":
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            print(granted ? "granted" : "denied")
            exit(granted ? 0 : 1)
        case "status":
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized:
                print("granted")
                exit(0)
            case .notDetermined:
                print("not-determined")
                exit(2)
            case .denied, .restricted:
                print("denied")
                exit(1)
            @unknown default:
                print("unknown")
                exit(3)
            }
        default:
            fputs("Usage: request-microphone-permission [status|request]\n", stderr)
            exit(64)
        }
    }
}
