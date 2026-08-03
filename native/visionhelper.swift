// visionhelper — local screen OCR and camera presence detection.
//
//   visionhelper ocr        -> JSON of every text run on screen, with coordinates
//   visionhelper presence   -> JSON: is someone sitting in front of the camera
//
// Both run entirely on-device through Apple's Vision framework. OCR matters for
// two reasons: reading the screen no longer costs an image upload to the model
// (fast enough to poll), and it yields clickable coordinates for text in apps
// that expose no accessibility tree — Chrome and Brave especially.
//
// Coordinates are logical points, top-left origin: the same space cliclick uses,
// so a text run's centre can be clicked directly.

import Foundation
import Vision
import CoreGraphics
import AppKit
import AVFoundation
import ScreenCaptureKit

func jsonString(_ s: String) -> String {
    var out = "\""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\t": out += "\\t"
        case "\r": out += "\\r"
        default:
            if c.value < 0x20 { out += String(format: "\\u%04x", c.value) }
            else { out.unicodeScalars.append(c) }
        }
    }
    return out + "\""
}

// MARK: - screen capture

/// One display, and where it sits in the global coordinate space.
struct DisplayInfo {
    let index: Int
    let id: CGDirectDisplayID
    /// Bounds in the space cliclick clicks in: points, top-left origin, with
    /// the primary display at (0,0) and others offset around it.
    let bounds: CGRect
    let isPrimary: Bool
}

/// Every attached display, in ScreenCaptureKit's order.
///
/// CGDisplayBounds is the authority for placement rather than NSScreen: it
/// reports the top-left-origin global space that mouse coordinates use, while
/// NSScreen reports AppKit's bottom-left-origin one. Mixing the two puts a
/// click the wrong distance from the top of a secondary display.
func listDisplays() -> [DisplayInfo] {
    var out: [DisplayInfo] = []
    let done = DispatchSemaphore(value: 0)

    Task {
        defer { done.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            for (i, d) in content.displays.enumerated() {
                out.append(DisplayInfo(
                    index: i,
                    id: d.displayID,
                    bounds: CGDisplayBounds(d.displayID),
                    isPrimary: CGDisplayIsMain(d.displayID) != 0))
            }
        } catch {
            FileHandle.standardError.write(
                "display list error: \(error.localizedDescription)\n".data(using: .utf8)!)
        }
    }

    _ = done.wait(timeout: .now() + 10)
    return out
}

/// Grab one display through ScreenCaptureKit.
///
/// CGDisplayCreateImage was the obvious choice but Apple obsoleted it in
/// macOS 15, so this is the only supported single-frame path now. It is async,
/// which a CLI has no use for, so the semaphore bridges it back to sync.
///
/// `index` selects which display; it used to be hardcoded to `.first`, which
/// meant everything Jarvis read came from one screen however many were
/// attached, and text found on a second monitor was reported at coordinates
/// belonging to the first.
func captureDisplay(index: Int) -> (image: CGImage, info: DisplayInfo)? {
    var result: CGImage?
    var chosen: DisplayInfo?
    let done = DispatchSemaphore(value: 0)

    Task {
        defer { done.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            guard index >= 0, index < content.displays.count else { return }
            let display = content.displays[index]
            chosen = DisplayInfo(
                index: index,
                id: display.displayID,
                bounds: CGDisplayBounds(display.displayID),
                isPrimary: CGDisplayIsMain(display.displayID) != 0)

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            // Capture at native pixels; coordinates are normalised back to
            // logical points when the text boxes are emitted.
            config.width = display.width
            config.height = display.height
            result = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config)
        } catch {
            FileHandle.standardError.write(
                "capture error: \(error.localizedDescription)\n".data(using: .utf8)!)
        }
    }

    _ = done.wait(timeout: .now() + 10)
    guard let img = result, let info = chosen else { return nil }
    return (img, info)
}

func runListDisplays() {
    let displays = listDisplays()
    let rows = displays.map { d in
        """
        {"index":\(d.index),"id":\(d.id),\
        "x":\(Int(d.bounds.origin.x)),"y":\(Int(d.bounds.origin.y)),\
        "width":\(Int(d.bounds.width)),"height":\(Int(d.bounds.height)),\
        "primary":\(d.isPrimary)}
        """
    }
    print("{\"displays\":[\(rows.joined(separator: ","))]}")
}

// MARK: - OCR

func runOCR(fast: Bool, displayIndex: Int) {
    guard let shot = captureDisplay(index: displayIndex) else {
        print(#"{"error":"screen-capture-failed","hint":"grant Screen Recording permission, or that display does not exist"}"#)
        exit(2)
    }
    let image = shot.image

    // The captured display's own logical size and its offset in the global
    // space. Both come from CGDisplayBounds rather than NSScreen.main: asking
    // "the main screen" for the size of a DIFFERENT display is how text on a
    // secondary monitor ended up with primary-monitor coordinates.
    let logicalW = shot.info.bounds.width
    let logicalH = shot.info.bounds.height
    let originX = shot.info.bounds.origin.x
    let originY = shot.info.bounds.origin.y

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.usesLanguageCorrection = !fast

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        print("{\"error\":\(jsonString(error.localizedDescription))}")
        exit(3)
    }

    guard let observations = request.results else {
        print(#"{"lines":[]}"#)
        exit(0)
    }

    var rows: [String] = []
    for obs in observations {
        guard let candidate = obs.topCandidates(1).first else { continue }
        let text = candidate.string
        if text.trimmingCharacters(in: .whitespaces).isEmpty { continue }

        // Vision returns a normalised box with origin at BOTTOM-left; the screen
        // coordinate space Jarvis clicks in has its origin at the TOP-left.
        //
        // The display's origin is added here so the emitted numbers are GLOBAL
        // coordinates — directly clickable whichever screen the text is on. On
        // a single display the origin is (0,0) and this changes nothing.
        let b = obs.boundingBox
        let x = originX + b.minX * logicalW
        let w = b.width * logicalW
        let h = b.height * logicalH
        let y = originY + (1 - b.maxY) * logicalH

        rows.append("""
        {"text":\(jsonString(text)),"x":\(Int(x)),"y":\(Int(y)),\
        "w":\(Int(w)),"h":\(Int(h)),\
        "cx":\(Int(x + w / 2)),"cy":\(Int(y + h / 2)),\
        "display":\(shot.info.index),\
        "confidence":\(String(format: "%.2f", candidate.confidence))}
        """)
    }

    print("""
    {"width":\(Int(logicalW)),"height":\(Int(logicalH)),\
    "display":\(shot.info.index),"originX":\(Int(originX)),"originY":\(Int(originY)),\
    "primary":\(shot.info.isPrimary),\
    "lines":[\(rows.joined(separator: ","))]}
    """)
}

// MARK: - presence

/// Take one frame from the default camera and count faces.
func runPresence(timeoutSeconds: Double) {
    // Ask for camera access explicitly. Without this the status stays
    // notDetermined, capture silently yields no frames, and the failure looks
    // like a broken camera rather than a missing permission. macOS attributes
    // the grant to whichever app launched this helper.
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
        if !granted {
            print(#"{"error":"camera-denied","hint":"grant Camera permission to the app running Jarvis"}"#)
            exit(5)
        }
    default:
        print(#"{"error":"camera-denied","hint":"enable Camera in System Settings > Privacy & Security"}"#)
        exit(5)
    }

    let session = AVCaptureSession()
    session.sessionPreset = .medium

    guard let device = AVCaptureDevice.default(for: .video) else {
        print(#"{"error":"no-camera"}"#)
        exit(4)
    }
    configureForLowLight(device)
    guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
        print(#"{"error":"camera-unavailable","hint":"grant Camera permission"}"#)
        exit(5)
    }
    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    let queue = DispatchQueue(label: "jarvis.presence")

    /// Collects several frames rather than one.
    ///
    /// Taking the very first frame was the bug behind "I can't see you" while
    /// hand tracking worked perfectly: a camera's opening frames are black or
    /// badly under-exposed while gain and white balance settle, and a face
    /// cannot be found in a black frame. Gesture tracking never noticed because
    /// it runs continuously and sees hundreds of frames.
    final class Grabber: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
        var frames: [CVPixelBuffer] = []
        let semaphore = DispatchSemaphore(value: 0)
        private var seen = 0
        private let skip: Int
        private let want: Int

        init(skip: Int, want: Int) {
            self.skip = skip
            self.want = want
        }

        func captureOutput(_ o: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from c: AVCaptureConnection) {
            seen += 1
            // Let the sensor settle before believing anything it produces.
            guard seen > skip, frames.count < want,
                  let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            frames.append(pb)
            if frames.count >= want { semaphore.signal() }
        }
    }

    let grabber = Grabber(skip: 12, want: 5)
    output.setSampleBufferDelegate(grabber, queue: queue)
    guard session.canAddOutput(output) else { print(#"{"error":"no-output"}"#); exit(6) }
    session.addOutput(output)

    session.startRunning()
    _ = grabber.semaphore.wait(timeout: .now() + timeoutSeconds)
    session.stopRunning()

    let frames = grabber.frames
    guard !frames.isEmpty else {
        print(#"{"error":"no-frame","hint":"camera produced no usable frames"}"#)
        exit(7)
    }

    // A face missed in one frame often appears in the next — blinking, motion
    // blur, a hand passing. Take the best answer across the sample rather than
    // trusting a single reading.
    var bestFaces = 0
    var bestProminence = 0.0
    var brightest = 0.0

    for pixels in frames {
        brightest = max(brightest, averageLuma(pixels))
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixels, options: [:])
        guard (try? handler.perform([request])) != nil else { continue }
        let faces = request.results ?? []
        if faces.count > bestFaces { bestFaces = faces.count }
        for f in faces {
            bestProminence = max(bestProminence, Double(f.boundingBox.width * f.boundingBox.height))
        }
    }

    // Report the light level too: "I can't see you" is far more useful when it
    // can add "the room looks very dark".
    let dark = brightest < 0.06
    print("""
    {"present":\(bestFaces > 0),"faces":\(bestFaces),\
    "prominence":\(String(format: "%.3f", bestProminence)),\
    "brightness":\(String(format: "%.3f", brightest)),\
    "dark":\(dark),"framesExamined":\(frames.count)}
    """)
}

/// Mean luminance of a frame, 0-1. Used to tell "nobody there" from "too dark to tell".
func averageLuma(_ buffer: CVPixelBuffer) -> Double {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }

    // Plane 0 of a bi-planar YUV buffer is luma; for BGRA fall back to plane 0
    // bytes, which is close enough for a light/dark judgement.
    guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return 0 }
    let height = CVPixelBufferGetHeightOfPlane(buffer, 0)
    let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    let width = CVPixelBufferGetWidthOfPlane(buffer, 0)
    let ptr = base.assumingMemoryBound(to: UInt8.self)

    var total = 0
    var samples = 0
    // Sample a grid rather than every pixel; this runs per frame.
    for y in stride(from: 0, to: height, by: 8) {
        for x in stride(from: 0, to: width, by: 8) {
            total += Int(ptr[y * bytesPerRow + x])
            samples += 1
        }
    }
    return samples > 0 ? Double(total) / Double(samples) / 255.0 : 0
}

/**
 * Give the camera the best chance in a dim room.
 *
 * Face detection fails far more often from under-exposure than from anything
 * about the face itself, and the defaults optimise for smooth video rather than
 * for recognising someone lit only by a monitor.
 */
func configureForLowLight(_ device: AVCaptureDevice) {
    guard (try? device.lockForConfiguration()) != nil else { return }
    defer { device.unlockForConfiguration() }

    if device.isExposureModeSupported(.continuousAutoExposure) {
        device.exposureMode = .continuousAutoExposure
    }
    if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
        device.whiteBalanceMode = .continuousAutoWhiteBalance
    }
    // HDR and manual exposure duration would help more, but both are iOS-only;
    // on macOS continuous auto-exposure is the whole of what is available.
}

// MARK: - gestures

func runGestures() {
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
    let queue = DispatchQueue(label: "jarvis.gestures")

    final class Grabber: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
        let request = VNDetectHumanHandPoseRequest()
        override init() {
            request.maximumHandCount = 1
            super.init()
        }
        
        func captureOutput(_ o: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from c: AVCaptureConnection) {
            guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            let handler = VNImageRequestHandler(cvPixelBuffer: pb, options: [:])
            try? handler.perform([request])
            
            guard let hand = request.results?.first else { return }
            guard let indexTip = try? hand.recognizedPoint(.indexTip), indexTip.confidence > 0.5 else { return }
            let thumbTip = try? hand.recognizedPoint(.thumbTip)
            
            var pinch = false
            if let thumb = thumbTip, thumb.confidence > 0.5 {
                let dist = hypot(indexTip.location.x - thumb.location.x, indexTip.location.y - thumb.location.y)
                pinch = dist < 0.04
            }
            
            print("{\"x\":\(String(format: "%.4f", indexTip.location.x)),\"y\":\(String(format: "%.4f", indexTip.location.y)),\"pinch\":\(pinch)}")
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

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
switch args.first ?? "ocr" {
case "ocr":
    let idx = args.firstIndex(of: "--display").flatMap { i in
        i + 1 < args.count ? Int(args[i + 1]) : nil
    } ?? 0
    runOCR(fast: args.contains("--fast"), displayIndex: idx)
case "displays":
    runListDisplays()
case "presence":
    let t = args.firstIndex(of: "--timeout").flatMap { i in
        i + 1 < args.count ? Double(args[i + 1]) : nil
    } ?? 3.0
    runPresence(timeoutSeconds: t)
case "gestures":
    runGestures()
default:
    print(#"{"error":"unknown-command"}"#)
    exit(1)
}
