/**
 * Dictated addresses, popup restraint, and send-button safety.
 *
 *   npm run composetest
 */
import { parseEmail, parsePhone, suggestSubject } from "./frontier/dictation.js";
import { classify } from "./safety/risk.js";
import { resolveAppName, openApp } from "./tools/computer-actions.js";

const ctx = { workingDir: process.env.HOME || "/tmp" };
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nSending messages\n");

// ---- dictated email addresses --------------------------------------------
console.log("  understanding a spelled-out address");
const emails: Array<[string, string | null]> = [
  ["john at gmail dot com", "john@gmail.com"],
  ["j o h n at gmail dot com", "john@gmail.com"],
  ["john dot smith at gmail dot com", "john.smith@gmail.com"],
  ["sarah at outlook dot com", "sarah@outlook.com"],
  ["deepak underscore r at yahoo dot com", "deepak_r@yahoo.com"],
  ["mike dash lee at proton dot me", "mike-lee@proton.me"],
  ["already@typed.com", "already@typed.com"],
  ["Contact me at hello@example.org please", "hello@example.org"],
  ["john at gmail", "john@gmail.com"],
  // Nonsense must return null so Jarvis asks again instead of typing rubbish.
  ["the weather is nice", null],
  ["", null],
];
for (const [spoken, want] of emails) {
  const got = parseEmail(spoken);
  ok(got === want, `${JSON.stringify(spoken.slice(0, 34))} -> ${got ?? "asks again"}`);
}

console.log("  phone numbers");
ok(parsePhone("five five five one two three four") === "5551234", "spoken digits");
ok(parsePhone("hello there") === null, "non-numbers are rejected");

// ---- subject lines --------------------------------------------------------
console.log("  subject from message");
ok(suggestSubject("Can we move tomorrow's meeting to 3pm?") === "Can we move tomorrow's meeting to 3pm", "short opener becomes the subject");
ok(suggestSubject("").length > 0, "empty body still yields something");
ok(suggestSubject("a".repeat(200)).length < 65, "a long body is trimmed");

// ---- clicking Send must confirm ------------------------------------------
console.log("  irreversible buttons ask first");
const mustAsk = [
  "Send", "send message", "Reply all", "Delete", "Pay now", "Post", "Publish", "Submit",
  // Real commerce buttons, which the first version missed: "Place order" did
  // not match Amazon's actual "Place your order" because of the word between.
  "Place order", "Place your order", "Proceed to checkout",
  "Add to Cart", "Add to Basket", "Add to bag",
  "Sign in", "Log out",
];
for (const label of mustAsk) {
  const t = classify("mcp__jarvis__click_ui_element", { description: label }, ctx).tier;
  ok(t === "high", `"${label}" -> ${t}`);
}
console.log("  ordinary buttons do not");
for (const label of ["Compose", "Inbox", "the search box", "Settings", "next page"]) {
  const t = classify("mcp__jarvis__click_ui_element", { description: label }, ctx).tier;
  ok(t === "medium", `"${label}" -> ${t}`);
}

// ---- popup restraint ------------------------------------------------------
console.log("  popup dismissal is classified");
ok(classify("mcp__jarvis__dismiss_popups", {}, ctx).tier === "medium", "dismissing is an ordinary action");
ok(classify("mcp__jarvis__understand_dictation", {}, ctx).tier === "low", "parsing speech changes nothing");

// ---- opening apps by spoken name ----------------------------------------
console.log("  opening apps by what you'd say");
const apps: Array<[string, string | null]> = [
  ["chrome", "Google Chrome"],   // the real name is longer than what anyone says
  ["Chrome", "Google Chrome"],
  ["safari", "Safari"],
  ["terminal", "Terminal"],      // lives in Utilities, not /Applications
  ["finder", "Finder"],          // lives in CoreServices
  ["notarealapp123", null],
];
for (const [spoken, want] of apps) {
  const got = await resolveAppName(spoken);
  ok(got === want, `"${spoken}" -> ${got ?? "not installed"}`);
}

// The bug this replaced: openApp always claimed success, so Jarvis announced it
// had opened Chrome while nothing happened.
const failure = await openApp("notarealapp123");
ok(/FAILED/.test(failure), "a failed open reports failure instead of claiming success");

console.log(`\n${pass}/${pass + fail} compose checks passed\n`);
process.exit(fail ? 1 : 0);
