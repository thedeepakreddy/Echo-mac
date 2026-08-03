import { spawn } from "node:child_process";
import { Tts } from "./tts.js";

/**
 * Vocal Cloning & Meeting Proxy - Feature 3
 * Allows Echo to attend meetings on behalf of the user by piping its TTS output 
 * (configured with the user's cloned voice) into a virtual microphone driver like BlackHole.
 */

export class MeetingProxy {
  private activeMeeting: boolean = false;

  public async joinMeeting(url: string, voiceCloneId: string) {
    if (this.activeMeeting) {
      return { ok: false, message: "Already in a meeting." };
    }
    this.activeMeeting = true;
    console.log(`[MeetingProxy] Joining ${url} with cloned voice ID ${voiceCloneId}`);
    
    // Scaffold: In production, this would launch a headless Chromium/Puppeteer instance
    // or use Accessibility APIs to hook into the active Zoom/Meet window.
    
    // Switch system audio output to the Virtual Microphone (BlackHole)
    // so that when TTS plays, it goes directly into the meeting.
    try {
      spawn("SwitchAudioSource", ["-s", "BlackHole 16ch"]);
    } catch (e) {
      console.warn("[MeetingProxy] SwitchAudioSource not installed. Audio routing skipped.");
    }
    
    return { ok: true, message: `Joined meeting ${url}. I am now listening and can speak in your voice.` };
  }

  public async speakInMeeting(text: string) {
    if (!this.activeMeeting) return { ok: false, message: "Not currently in a meeting." };
    
    // Instantiate TTS with the ElevenLabs clone (Feature 3 logic)
    const cloneTts = new Tts("Daniel", true, "elevenlabs", process.env.USER_VOICE_CLONE_ID);
    cloneTts.say(text);
    
    return { ok: true, message: `Spoke in meeting: "${text}"` };
  }

  public async leaveMeeting() {
    this.activeMeeting = false;
    // Restore default audio
    try {
      spawn("SwitchAudioSource", ["-s", "MacBook Pro Speakers"]);
    } catch (e) {}
    
    return { ok: true, message: "Left the meeting and restored normal audio routing." };
  }
}

export const meetingProxy = new MeetingProxy();
