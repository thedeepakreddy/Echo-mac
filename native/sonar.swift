import AVFoundation
import Accelerate

func runSonar() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        break
    case .notDetermined:
        let gate = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            granted = ok
            gate.signal()
        }
        _ = gate.wait(timeout: .now() + 30)
        if !granted { exit(5) }
    default:
        exit(5)
    }

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let format = inputNode.inputFormat(forBus: 0)
    
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { (buffer, time) in
        guard let channelData = buffer.floatChannelData?[0] else { return }
        let frameLength = Int(buffer.frameLength)
        
        var rms: Float = 0.0
        vDSP_rmsqv(channelData, 1, &rms, vDSP_Length(frameLength))
        
        // Convert to roughly decibels (-160 to 0)
        let db = 20 * log10(max(rms, 0.00000001))
        
        // If there's a massive spike (e.g. > -10 dB is very loud locally)
        if db > -10.0 {
            print("{\"alert\":\"acoustic_anomaly\", \"db\":\(db)}")
            fflush(stdout)
        }
    }
    
    do {
        try engine.start()
        RunLoop.main.run()
    } catch {
        exit(6)
    }
}

runSonar()
