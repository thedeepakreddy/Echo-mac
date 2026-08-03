import AVFoundation

let voices = AVSpeechSynthesisVoice.speechVoices()
var found = false
for voice in voices {
    if voice.name.contains("Deepak") {
        print("Found: \(voice.name) [\(voice.identifier)]")
        found = true
    }
}
if !found {
    print("Deepak's Voice not found in AVSpeechSynthesizer.")
}
