/**
 * The secret scrubber that stands between Echo and ever storing a password.
 *
 *   npm run redacttest
 *
 * Two things must both hold: real credentials are removed, and ordinary screen
 * text is left alone (over-redaction is acceptable, but not to the point of
 * shredding normal content).
 */
import { scrubSecrets, looksSecret, REDACTED } from "./safety/redact.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const gone = (secret: string, text: string) => !scrubSecrets(text).includes(secret);

console.log("\nSecret scrubber\n");

console.log("  labelled passwords are removed");
{
  ok(gone("hunter2", "Password: hunter2"), "Password: hunter2");
  ok(gone("hunter2", "password hunter2"), "password hunter2 (no colon)");
  ok(gone("s3cr3t!", "pwd = s3cr3t!"), "pwd = s3cr3t!");
  ok(gone("1234", "PIN: 1234"), "PIN: 1234");
  ok(gone("letmein", "passcode: letmein"), "passcode");
  ok(gone("topsecret", 'secret="topsecret"'), "quoted secret value");
  ok(scrubSecrets("Password: hunter2").includes(REDACTED), "a [redacted] marker is left behind");
  ok(/password/i.test(scrubSecrets("Password: hunter2")), "the label itself is kept, only the value goes");
}

console.log("  known credential shapes are removed anywhere");
{
  ok(gone("sk-ant-api03-abc123def456ghi789", "my key is sk-ant-api03-abc123def456ghi789 ok"), "Anthropic key");
  ok(gone("AIzaSyD-abc123def456ghi789jkl012mno", "AIzaSyD-abc123def456ghi789jkl012mno"), "Google key");
  ok(gone("ghp_abcdefghijklmnopqrstuvwxyz0123", "token ghp_abcdefghijklmnopqrstuvwxyz0123"), "GitHub token");
  ok(gone("AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"), "AWS access key id");
  ok(gone("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"), "JWT");
  ok(gone("4111 1111 1111 1111", "card 4111 1111 1111 1111 exp"), "card number (spaced)");
  ok(gone("4111-1111-1111-1111", "4111-1111-1111-1111"), "card number (dashed)");
}

console.log("  ordinary screen text is left intact");
{
  const keep = [
    "The quarterly report is due on Friday at 5pm.",
    "git commit -m \"fix the login button colour\"",
    "Meeting with Sarah about the pricing agreement",
    "function add(a, b) { return a + b; }",
    "Inbox — 3 unread messages",
    "The password field is on the next screen", // mentions 'password' but no value
  ];
  for (const t of keep) ok(scrubSecrets(t) === t, `kept: "${t.slice(0, 42)}"`);
}
{
  // 'password' as the last word with nothing after must not eat the sentence.
  ok(scrubSecrets("please enter your password").length > 10, "a trailing 'password' with no value is left readable");
}

console.log("  helpers behave");
{
  ok(looksSecret("api_key: sk-ant-abcdefghijklmnopqrst") === true, "looksSecret flags a real secret");
  ok(looksSecret("just some ordinary words here") === false, "looksSecret clears normal text");
  ok(scrubSecrets("") === "", "empty string is fine");
  ok(scrubSecrets(undefined as any) === "", "undefined does not throw");
  ok(scrubSecrets(42 as any) === "", "a non-string does not throw");
}

console.log(`\n${pass}/${pass + fail} redaction checks passed\n`);
process.exit(fail ? 1 : 0);
