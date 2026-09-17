// voiceio — Echo's persistent audio I/O helper.
//
// One process, two jobs, one AVAudioEngine:
//
//   PLAYBACK  PCM comes in on stdin and plays the instant it arrives. `afplay`
//             cost 0.8–1.3 s of process and CoreAudio start-up for EVERY
//             sentence; here the engine is already running, so a sentence
//             starts within a few milliseconds of its first bytes, and "stop"
//             silences it in under 20 ms.
//   CAPTURE   (--capture) the microphone with Apple's voice-processing I/O —
//             the same echo cancellation FaceTime uses — so what goes out on
//             stdout is the room MINUS Echo's own voice. That is what makes
//             talking over Echo on open speakers workable: the wake word and
//             the speech detector never hear Echo at all.
//
// Wire format, both directions: 4-byte little-endian length, 1-byte type, payload.
//   stdin  0x01 PCM int16 mono (rate from the config message)   0x02 JSON control
//   stdout 0x10 PCM int16 mono 16 kHz, 512 samples per message    0x20 JSON event
// Control: {"cmd":"config","rate":24000}  {"cmd":"stop"}  {"cmd":"end"}  {"cmd":"quit"}
// Events:  ready · started · progress{played_ms} · drained · stopped · level{rms} · error{message}

import AVFoundation
import Foundation

let stdoutLock = NSLock()
func writeFrame(_ type: UInt8, _ payload: Data) {
    stdoutLock.lock(); defer { stdoutLock.unlock() }
    var len = UInt32(payload.count + 1).littleEndian
    var out = Data(bytes: &len, count: 4)
    out.append(type)
    out.append(payload)
    FileHandle.standardOutput.write(out)
}
func event(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj) { writeFrame(0x20, d) }
}
func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let captureWanted = CommandLine.arguments.contains("--capture")
let engine = AVAudioEngine()
let player = AVAudioPlayerNode()

// ---- playback -----------------------------------------------------------------
var inRate: Double = 24000
var playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inRate, channels: 1, interleaved: false)!
var scheduled = 0            // buffers handed to the node and not yet played back
var generation = 0           // bumped by every stop; late completions of old buffers are ignored
var playing = false
var startedReported = false
let playQueue = DispatchQueue(label: "voiceio.play")

func configurePlayer(rate: Double) {
    if rate == inRate { return }
    playQueue.sync {
        inRate = rate
        playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
    }
}

func schedulePCM(_ data: Data) {
    let n = data.count / 2
    guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(n)) else { return }
    buf.frameLength = AVAudioFrameCount(n)
    let dst = buf.floatChannelData![0]
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let src = raw.bindMemory(to: Int16.self)
        for i in 0..<n { dst[i] = Float(Int16(littleEndian: src[i])) / 32768.0 }
    }
    let gen = generation
    playQueue.sync {
        scheduled += 1
        player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { _ in
            playQueue.async {
                guard gen == generation else { return }
                scheduled -= 1
                if scheduled == 0 {
                    playing = false
                    startedReported = false
                    event(["ev": "drained"])
                }
            }
        }
        if !player.isPlaying { player.play() }
        playing = true
        if !startedReported {
            startedReported = true
            event(["ev": "started"])
        }
    }
}

func stopPlayback() {
    playQueue.sync {
        generation += 1
        player.stop()          // drops every scheduled buffer at once
        scheduled = 0
        playing = false
        startedReported = false
    }
    event(["ev": "stopped"])
}

// Progress: what has actually reached the speaker, for "what was spoken" accounting.
var progressTimer: DispatchSourceTimer?
func startProgress() {
    let t = DispatchSource.makeTimerSource(queue: playQueue)
    t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    t.setEventHandler {
        guard playing, let nt = player.lastRenderTime, nt.isSampleTimeValid,
              let pt = player.playerTime(forNodeTime: nt), pt.sampleRate > 0 else { return }
        let seconds = Double(pt.sampleTime) / pt.sampleRate
        guard seconds.isFinite, seconds >= 0 else { return }   // Int(inf) traps the whole process
        event(["ev": "progress", "played_ms": Int(seconds * 1000)])
    }
    t.resume()
    progressTimer = t
}

// ---- capture ------------------------------------------------------------------
var converter: AVAudioConverter?
let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
var pending = Data()
var levelCounter = 0

func startCapture() {
    let input = engine.inputNode
    do {
        // Voice processing = echo cancellation + noise suppression + AGC. Must be
        // set before the engine starts. Ducking of other audio is turned to its
        // minimum so Echo's own playback is not pulled down while the mic is live.
        try input.setVoiceProcessingEnabled(true)
        if #available(macOS 14.0, *) {
            input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }
    } catch {
        event(["ev": "error", "message": "voice processing unavailable: \(error.localizedDescription)"])
    }
    let hw = input.outputFormat(forBus: 0)
    // No microphone (permission denied, or none present) shows up as a 0 Hz
    // format here, and installing a tap on it aborts the whole process — which
    // would take playback down with it. Report and carry on playback-only.
    guard hw.sampleRate > 0, hw.channelCount > 0 else {
        event(["ev": "error", "message": "no usable microphone format (\(hw.sampleRate) Hz, \(hw.channelCount) ch) — capture disabled"])
        return
    }
    converter = AVAudioConverter(from: hw, to: outFormat)
    input.installTap(onBus: 0, bufferSize: 1024, format: hw) { buffer, _ in
        guard let conv = converter else { return }
        let ratio = 16000.0 / hw.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
        var consumed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if err != nil { return }
        let bytes = Int(out.frameLength) * 2
        pending.append(Data(bytes: out.int16ChannelData![0], count: bytes))
        while pending.count >= 1024 {
            let frame = pending.prefix(1024)
            pending.removeFirst(1024)
            writeFrame(0x10, Data(frame))
            levelCounter += 1
            if levelCounter % 8 == 0 {
                var sum: Double = 0
                frame.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                    let s = raw.bindMemory(to: Int16.self)
                    for i in 0..<512 { let v = Double(s[i]); sum += v * v }
                }
                event(["ev": "level", "rms": Int((sum / 512).squareRoot())])
            }
        }
    }
}

// ---- main ---------------------------------------------------------------------
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: playFormat)
if captureWanted { startCapture() }
engine.prepare()
do {
    try engine.start()
} catch {
    event(["ev": "error", "message": "engine failed to start: \(error.localizedDescription)"])
    exit(1)
}
startProgress()
event(["ev": "ready", "capture": captureWanted, "aec": captureWanted, "outputRate": engine.mainMixerNode.outputFormat(forBus: 0).sampleRate])

// stdin reader: framed messages.
let stdin = FileHandle.standardInput
var inbuf = Data()
let reader = DispatchQueue(label: "voiceio.stdin")
reader.async {
    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty { event(["ev": "stdin_closed"]); exit(0) }
        inbuf.append(chunk)
        while inbuf.count >= 5 {
            // Index through startIndex and load unaligned: after the first
            // message the buffer's storage is neither zero-based nor aligned,
            // and a plain `load`/`inbuf[4]` on it trapped the process.
            let start = inbuf.startIndex
            let len = Int(inbuf.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self) }.littleEndian)
            guard len >= 1, inbuf.count >= 4 + len else { break }
            let type = inbuf[start + 4]
            let payload = Data(inbuf[(start + 5)..<(start + 4 + len)])
            inbuf = Data(inbuf[(start + 4 + len)..<inbuf.endIndex])
            switch type {
            case 0x01:
                schedulePCM(payload)
            case 0x02:
                if let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any], let cmd = obj["cmd"] as? String {
                    switch cmd {
                    case "config": if let r = obj["rate"] as? Double { configurePlayer(rate: r) }
                    case "stop": stopPlayback()
                    case "quit": exit(0)
                    default: break
                    }
                }
            default: break
            }
        }
    }
}
RunLoop.main.run()
