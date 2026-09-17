// speechhelper — on-device streaming speech recognition through Apple's
// Speech framework, for Echo's voice pipeline.
//
// Sarvam's realtime endpoint is the streaming path for Telugu and mixed
// speech; this is the offline one for English and Hindi (te-IN is not offered
// on-device — checked on this Mac). Partial results arrive as you speak, the
// final one moments after you stop, and nothing leaves the machine.
//
// Protocol: stdin is framed (4-byte LE length, 1-byte type, payload):
//   0x01 PCM int16 mono 16 kHz    0x02 JSON {"cmd":"start","locale":"en-IN"} | {"cmd":"end"} | {"cmd":"quit"}
// stdout is JSON lines: {"type":"ready"} {"type":"partial","text":..} {"type":"final","text":..} {"type":"error","message":..}

import AVFoundation
import Foundation
import Speech

let outLock = NSLock()
func emit(_ obj: [String: Any]) {
    outLock.lock(); defer { outLock.unlock() }
    if let d = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardOutput.write(d)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
var recognizer: SFSpeechRecognizer?
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var lastText = ""

func start(locale: String) {
    stop()
    guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)), r.isAvailable else {
        emit(["type": "error", "message": "recognizer unavailable for \(locale)"])
        return
    }
    recognizer = r
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if r.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    if #available(macOS 13, *) { req.addsPunctuation = true }
    request = req
    lastText = ""
    task = r.recognitionTask(with: req) { result, error in
        if let result = result {
            let text = result.bestTranscription.formattedString
            lastText = text
            emit(["type": result.isFinal ? "final" : "partial", "text": text])
        }
        if let error = error {
            // A cancelled task reports an error too; only a live one matters.
            emit(["type": "error", "message": error.localizedDescription])
            emit(["type": "final", "text": lastText])
        }
    }
    emit(["type": "started", "locale": locale, "onDevice": r.supportsOnDeviceRecognition])
}

func stop() {
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
}

func feed(_ data: Data) {
    guard let req = request else { return }
    let frames = data.count / 2
    guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
    buf.frameLength = AVAudioFrameCount(frames)
    data.withUnsafeBytes { raw in
        buf.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: frames)
    }
    req.append(buf)
}

SFSpeechRecognizer.requestAuthorization { status in
    if status != .authorized { emit(["type": "error", "message": "speech recognition not authorized (\(status.rawValue))"]) }
    emit(["type": "ready", "authorized": status == .authorized])
}

let stdin = FileHandle.standardInput
var inbuf = Data()
DispatchQueue(label: "speechhelper.stdin").async {
    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty { exit(0) }
        inbuf.append(chunk)
        while inbuf.count >= 5 {
            let base = inbuf.startIndex
            let len = Int(inbuf.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self) }.littleEndian)
            guard len >= 1, inbuf.count >= 4 + len else { break }
            let type = inbuf[base + 4]
            let payload = Data(inbuf[(base + 5)..<(base + 4 + len)])
            inbuf = Data(inbuf[(base + 4 + len)..<inbuf.endIndex])
            switch type {
            case 0x01: feed(payload)
            case 0x02:
                if let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any], let cmd = obj["cmd"] as? String {
                    switch cmd {
                    case "start": start(locale: (obj["locale"] as? String) ?? "en-US")
                    case "end": request?.endAudio()
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
