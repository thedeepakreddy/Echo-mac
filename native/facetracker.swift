import Foundation
import Vision
import AVFoundation

func runFaceTracker() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        break
    case .notDetermined:
        let gate = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .video) { ok in
            granted = ok
            gate.signal()
        }
        _ = gate.wait(timeout: .now() + 30)
        if !granted { exit(5) }
    default:
        exit(5)
    }

    let session = AVCaptureSession()
    session.sessionPreset = .high

    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else { exit(4) }
    guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { exit(5) }
    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    let queue = DispatchQueue(label: "jarvis.facetracker")

    final class Grabber: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
        let request = VNDetectFaceLandmarksRequest()
        
        func captureOutput(_ o: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from c: AVCaptureConnection) {
            guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            let handler = VNImageRequestHandler(cvPixelBuffer: pb, options: [:])
            try? handler.perform([request])
            
            guard let face = request.results?.first else { return }
            guard let landmarks = face.landmarks else { return }
            guard let nose = landmarks.nose?.normalizedPoints.first else { return }
            
            // The points are relative to the bounding box of the face.
            // We need to map them back to the image coordinates.
            let x = face.boundingBox.origin.x + (nose.x * face.boundingBox.size.width)
            let y = face.boundingBox.origin.y + (nose.y * face.boundingBox.size.height)
            
            var blink = false
            if let leftEye = landmarks.leftEye?.normalizedPoints, let rightEye = landmarks.rightEye?.normalizedPoints {
                // simple blink heuristic: eye bounding box height
                let lHeight = leftEye.map { $0.y }.max()! - leftEye.map { $0.y }.min()!
                let rHeight = rightEye.map { $0.y }.max()! - rightEye.map { $0.y }.min()!
                if lHeight < 0.02 && rHeight < 0.02 {
                    blink = true
                }
            }

            print("{\"x\":\(String(format: "%.4f", x)),\"y\":\(String(format: "%.4f", y)),\"blink\":\(blink)}")
            fflush(stdout)
        }
    }

    let grabber = Grabber()
    output.setSampleBufferDelegate(grabber, queue: queue)
    guard session.canAddOutput(output) else { exit(6) }
    session.addOutput(output)

    session.startRunning()
    RunLoop.main.run()
}

runFaceTracker()
