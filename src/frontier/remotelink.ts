import QRCode from "qrcode";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Getting the phone-remote link onto the phone.
 *
 * The link ends in a 32-character random token, which is unspeakable — reading
 * it aloud is hopeless and typing it from a laptop screen is error-prone. So the
 * link is never meant to be conveyed by voice: it is shown as a QR code to scan,
 * and written to a file so it can always be recovered.
 */

/** A scannable QR code for the link, as a PNG data URL for an <img>. */
export async function qrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    width: 340,
    margin: 2,
    errorCorrectionLevel: "M",
    // High contrast so a phone camera locks on quickly, tuned to the HUD.
    color: { dark: "#03181d", light: "#c9f7ff" },
  });
}

/** A QR rendered as text, for a terminal or a log — no image needed. */
export async function qrText(url: string): Promise<string> {
  return QRCode.toString(url, { type: "utf8", errorCorrectionLevel: "M" });
}

/**
 * Write the current link where it can always be found again.
 *
 * A phone that misses the QR, a reactor that was not looking at — this is the
 * fallback that means the link is never actually lost while the remote is open.
 */
export function saveRemoteUrl(url: string): string {
  const path = join(homedir(), ".jarvis", "remote-url.txt");
  try {
    writeFileSync(path, url + "\n", { mode: 0o600 });
  } catch {
    /* the on-screen QR is the primary path; a failed write is not fatal */
  }
  return path;
}
