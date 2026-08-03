// handtracker — turns your hand into a pointing device.
//
//   handtracker gestures
//
// Emits one JSON line per detected frame:
//   {"x":0.51,"y":0.62,"fingers":1,"tap":false,"pinching":false,"swipe":"none","confidence":0.93}
//
// Gestures:
//   1 finger        move the cursor
//   pinch (thumb+index)  click
//   3 fingers       move as a group to swipe (scroll)
//
// Coordinates are Vision's normalised space (0-1, origin bottom-left); the
// caller maps them to screen points. The image is mirrored by default so moving
// your hand right moves the cursor right — a front camera sees you reversed,
// and without this the control feels backwards.
//
// Two things decide whether this feels good or unusable: how the pointer is
// smoothed, and how reliably fingers are counted. Both get more care below than
// a naive version would need, because a cursor that lags or a click that fires
// by accident makes the feature worse than no feature.
//
// Runs entirely on-device with Vision's hand-pose model. Nothing is recorded.

import Foundation
import AVFoundation
import Vision

// MARK: - tuning

/// Below this, Vision is guessing at the joint and the position is noise.
let MIN_CONFIDENCE: Float = 0.5

/// A finger counts as extended when its tip is this much further from the wrist
/// than its middle joint. A ratio beats an absolute distance: it holds whether
/// the hand is close to the camera or far from it.
let EXTENDED_RATIO: CGFloat = 1.15

/// How close thumb and index must come to count as a pinch, measured as a
/// FRACTION OF HAND SIZE rather than an absolute distance. An absolute
/// threshold only works at one distance from the camera: lean back and a real
/// pinch stops registering, lean in and your resting hand starts clicking.
let PINCH_RATIO: CGFloat = 0.32
/// Release must exceed this before another pinch counts, so one deliberate
/// pinch is one click even as the fingers wobble around the threshold.
let PINCH_RELEASE_RATIO: CGFloat = 0.45
/// After a click, ignore pinches briefly — one gesture, one click.
let TAP_COOLDOWN_MS: Double = 350

/// How far the three-finger group must travel to count as a swipe, as a
/// fraction of the frame.
let SWIPE_DISTANCE: CGFloat = 0.12
/// A swipe must happen within this long, or it is a slow drift.
let SWIPE_WINDOW_MS: Double = 700
let SWIPE_COOLDOWN_MS: Double = 600

let MIRROR = !CommandLine.arguments.contains("--no-mirror")

// MARK: - One Euro filter
//
// A fixed smoothing factor forces a bad trade: smooth enough to kill the jitter
// and the cursor lags behind your hand; responsive enough to keep up and it
// shakes when you try to hold still. This varies smoothing with speed — heavy
// when the hand is nearly still, light when it travels — so the pointer is both
// steady while aiming and immediate while moving. It is the standard filter for
// exactly this problem.

final class LowPass {
    private var value: CGFloat?
    func filter(_ x: CGFloat, alpha: CGFloat) -> CGFloat {
        let out = value.map { alpha * x + (1 - alpha) * $0 } ?? x
        value = out
        return out
    }
    func reset() { value = nil }
    var last: CGFloat? { value }
}

final class OneEuro {
    private let minCutoff: CGFloat
    private let beta: CGFloat
    private let dCutoff: CGFloat
    private let xf = LowPass()
    private let dxf = LowPass()
    private var lastTime: CFAbsoluteTime?

    init(minCutoff: CGFloat = 1.0, beta: CGFloat = 0.02, dCutoff: CGFloat = 1.0) {
        self.minCutoff = minCutoff
        self.beta = beta
        self.dCutoff = dCutoff
    }

    private func alpha(_ cutoff: CGFloat, _ dt: CGFloat) -> CGFloat {
        let tau = 1 / (2 * .pi * cutoff)
        return 1 / (1 + tau / dt)
    }

    func filter(_ x: CGFloat, at now: CFAbsoluteTime) -> CGFloat {
        guard let prev = lastTime else {
            lastTime = now
            return xf.filter(x, alpha: 1)
        }
        let dt = CGFloat(max(1.0 / 120.0, now - prev))
        lastTime = now

        let dx = (x - (xf.last ?? x)) / dt
        let edx = dxf.filter(dx, alpha: alpha(dCutoff, dt))
        // The faster the hand moves, the less it is smoothed.
        let cutoff = minCutoff + beta * abs(edx)
        return xf.filter(x, alpha: alpha(cutoff, dt))
    }

    func reset() {
        xf.reset()
        dxf.reset()
        lastTime = nil
    }
}

// MARK: - camera permission

func ensureCameraAccess() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        return
    case .notDetermined:
        let gate = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .video) { ok in
            granted = ok
            gate.signal()
        }
        _ = gate.wait(timeout: .now() + 30)
        if granted { return }
        FileHandle.standardError.write("camera permission denied\n".data(using: .utf8)!)
        exit(3)
    default:
        FileHandle.standardError.write("camera permission denied\n".data(using: .utf8)!)
        exit(3)
    }
}

/// Hand joints vanish from an under-exposed frame long before a face does, so
/// give the sensor every chance in a dim room.
func configureForLowLight(_ device: AVCaptureDevice) {
    guard (try? device.lockForConfiguration()) != nil else { return }
    defer { device.unlockForConfiguration() }
    if device.isExposureModeSupported(.continuousAutoExposure) {
        device.exposureMode = .continuousAutoExposure
    }
    if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
        device.whiteBalanceMode = .continuousAutoWhiteBalance
    }
}

// MARK: - tracking

final class Tracker: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let request = VNDetectHumanHandPoseRequest()
    private let fx = OneEuro()
    private let fy = OneEuro()

    // Pinch: thumb meets index. Held as a latch so the click fires once on the
    // way in, not repeatedly while the fingers stay together.
    private var pinching = false
    private var lastTapAt: CFAbsoluteTime = 0

    // Swipe: where the three-finger group started, and when.
    private var swipeOrigin: CGPoint?
    private var swipeSince: CFAbsoluteTime?
    private var lastSwipeAt: CFAbsoluteTime = 0

    override init() {
        super.init()
        request.maximumHandCount = 1
    }

    private func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        hypot(a.x - b.x, a.y - b.y)
    }

    /// Is this finger extended? Measured against the wrist, so it holds at any
    /// distance from the camera and any rotation of the hand.
    private func extended(
        _ points: [VNHumanHandPoseObservation.JointName: VNRecognizedPoint],
        tip: VNHumanHandPoseObservation.JointName,
        pip: VNHumanHandPoseObservation.JointName,
        wrist: CGPoint
    ) -> Bool {
        guard let t = points[tip], let p = points[pip],
              t.confidence >= MIN_CONFIDENCE, p.confidence >= MIN_CONFIDENCE else { return false }
        let tipD = dist(CGPoint(x: t.location.x, y: t.location.y), wrist)
        let pipD = dist(CGPoint(x: p.location.x, y: p.location.y), wrist)
        return pipD > 0 && tipD / pipD > EXTENDED_RATIO
    }

    func captureOutput(_ o: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from c: AVCaptureConnection) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up, options: [:])
        guard (try? handler.perform([request])) != nil,
              let hand = request.results?.first,
              let all = try? hand.recognizedPoints(.all),
              let wristPt = all[.wrist], wristPt.confidence >= MIN_CONFIDENCE,
              let indexPt = all[.indexTip], indexPt.confidence >= MIN_CONFIDENCE
        else {
            // Hand left the frame: forget everything, so the cursor does not
            // leap across the screen when it reappears somewhere else.
            fx.reset(); fy.reset()
            pinching = false; swipeOrigin = nil; swipeSince = nil
            return
        }

        let now = CFAbsoluteTimeGetCurrent()
        let wrist = CGPoint(x: wristPt.location.x, y: wristPt.location.y)

        let isIndex  = extended(all, tip: .indexTip,  pip: .indexPIP,  wrist: wrist)
        let isMiddle = extended(all, tip: .middleTip, pip: .middlePIP, wrist: wrist)
        let isRing   = extended(all, tip: .ringTip,   pip: .ringPIP,   wrist: wrist)
        let isLittle = extended(all, tip: .littleTip, pip: .littlePIP, wrist: wrist)
        let fingers = [isIndex, isMiddle, isRing, isLittle].filter { $0 }.count

        let rawX = MIRROR ? 1 - indexPt.location.x : indexPt.location.x
        let rawY = indexPt.location.y
        let x = fx.filter(rawX, at: now)
        let y = fy.filter(rawY, at: now)

        var tap = false
        var swipe = "none"

        // ---- pinch: thumb meets index to click ----
        // Scaled by hand size so it behaves the same near the camera or far
        // from it. The wrist-to-index-knuckle span is a stable stand-in for
        // "how big is this hand on screen right now".
        if let thumbPt = all[.thumbTip], let indexMCP = all[.indexMCP],
           thumbPt.confidence >= MIN_CONFIDENCE, indexMCP.confidence >= MIN_CONFIDENCE {
            let handSpan = dist(CGPoint(x: indexMCP.location.x, y: indexMCP.location.y), wrist)
            let gap = dist(CGPoint(x: thumbPt.location.x, y: thumbPt.location.y),
                           CGPoint(x: indexPt.location.x, y: indexPt.location.y))
            let ratio = handSpan > 0 ? gap / handSpan : 99

            if !pinching, ratio < PINCH_RATIO {
                pinching = true
                // Fire on the way IN, so the click lands the instant you pinch
                // rather than when you let go.
                if (now - lastTapAt) * 1000 > TAP_COOLDOWN_MS {
                    tap = true
                    lastTapAt = now
                }
            } else if pinching, ratio > PINCH_RELEASE_RATIO {
                // A wider gap to release than to engage: without that margin the
                // fingers hovering near the threshold machine-gun clicks.
                pinching = false
            }
        }

        // ---- three fingers: the group's travel is a swipe ----
        if fingers >= 3 {
            let group = CGPoint(x: rawX, y: rawY)
            if swipeOrigin == nil {
                swipeOrigin = group
                swipeSince = now
            } else if let origin = swipeOrigin, let since = swipeSince {
                let dx = group.x - origin.x
                let dy = group.y - origin.y
                if (now - since) * 1000 > SWIPE_WINDOW_MS {
                    // Too slow to be a swipe — start measuring again from here.
                    swipeOrigin = group
                    swipeSince = now
                } else if (now - lastSwipeAt) * 1000 > SWIPE_COOLDOWN_MS,
                          abs(dx) > SWIPE_DISTANCE || abs(dy) > SWIPE_DISTANCE {
                    // Whichever axis moved further decides, so a slightly
                    // diagonal swipe still does what was intended.
                    if abs(dx) > abs(dy) {
                        swipe = dx > 0 ? "right" : "left"
                    } else {
                        // Vision's origin is bottom-left: raising the hand
                        // increases y, and that should scroll up.
                        swipe = dy > 0 ? "up" : "down"
                    }
                    lastSwipeAt = now
                    swipeOrigin = group
                    swipeSince = now
                }
            }
        } else {
            swipeOrigin = nil
            swipeSince = nil
        }

        print(String(
            format: "{\"x\":%.4f,\"y\":%.4f,\"fingers\":%d,\"tap\":%@,\"pinching\":%@,\"swipe\":\"%@\",\"confidence\":%.2f}",
            x, y, fingers, tap ? "true" : "false", pinching ? "true" : "false", swipe, indexPt.confidence))
        fflush(stdout)
    }
}

// MARK: - main

ensureCameraAccess()

let session = AVCaptureSession()
session.sessionPreset = .medium   // 640x480 is ample for joints and far cheaper

guard let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input) else {
    FileHandle.standardError.write("no usable camera\n".data(using: .utf8)!)
    exit(4)
}
configureForLowLight(device)
session.addInput(input)

let output = AVCaptureVideoDataOutput()
let tracker = Tracker()
output.setSampleBufferDelegate(tracker, queue: DispatchQueue(label: "jarvis.hands"))
// Dropping late frames keeps the pointer on the present rather than working
// through a backlog, which is what makes tracking feel sluggish.
output.alwaysDiscardsLateVideoFrames = true
guard session.canAddOutput(output) else {
    FileHandle.standardError.write("no video output\n".data(using: .utf8)!)
    exit(5)
}
session.addOutput(output)

session.startRunning()
RunLoop.main.run()
