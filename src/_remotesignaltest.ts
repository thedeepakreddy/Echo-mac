/**
 * Signalling, commands and confirmations — the relay between phone and Mac.
 *
 *   npm run remotesignaltest
 *
 * The safety-critical property here is that a confirmation is answered as
 * ITSELF: a stale "yes" from the phone must never approve an action that has
 * since taken the place of the one that was shown.
 */
import {
  Signalling, normaliseCommand, ConfirmRelay, MAX_COMMAND_LEN,
} from "./frontier/remotesignal.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\nRemote signalling & relay\n");

console.log("  WebRTC offer/answer changes hands once");
{
  const s = new Signalling();
  ok(s.takeOffer() === null, "nothing to answer before the phone offers");
  const gen = s.setOffer({ type: "offer", sdp: "v=0 phone" });
  ok(gen === 1, "the first offer is generation 1");
  ok(s.takeOffer()?.offer.sdp === "v=0 phone", "the Mac reads the offer");
  ok(s.getAnswer() === null, "no answer until the Mac gives one");
  s.setAnswer({ type: "answer", sdp: "v=0 mac" });
  ok(s.getAnswer()?.sdp === "v=0 mac", "the phone reads the answer");
}
{
  // A new offer (the phone reconnecting) supersedes the old negotiation.
  const s = new Signalling();
  s.setOffer({ type: "offer", sdp: "first" });
  s.setAnswer({ type: "answer", sdp: "old-answer" });
  const gen2 = s.setOffer({ type: "offer", sdp: "second" });
  ok(gen2 === 2, "a reconnect bumps the generation");
  ok(s.getAnswer() === null, "and clears the stale answer so the phone waits for a fresh one");
  ok(s.takeOffer()?.offer.sdp === "second", "the Mac now answers the new offer");
}

console.log("  ICE candidates are delivered once, to the right side");
{
  const s = new Signalling();
  s.setOffer({ type: "offer", sdp: "x" });
  s.addCandidate("phone", { candidate: "p1" });
  s.addCandidate("phone", { candidate: "p2" });
  s.addCandidate("mac", { candidate: "m1" });

  const forMac = s.drainCandidates("mac");
  ok(forMac.length === 2 && forMac[0].candidate === "p1", "the Mac gets the phone's candidates");
  ok(s.drainCandidates("mac").length === 0, "and does not get them a second time");

  const forPhone = s.drainCandidates("phone");
  ok(forPhone.length === 1 && forPhone[0].candidate === "m1", "the phone gets the Mac's candidate");
  ok(s.drainCandidates("phone").length === 0, "also only once");
}

console.log("  commands are sanity-checked, not second-guessed");
{
  ok(normaliseCommand("open my email").ok, "an ordinary command is accepted");
  const n = normaliseCommand("  open   my   email  ");
  ok(n.ok === true && n.text === "open my email", "whitespace is tidied");
  ok(!normaliseCommand("").ok, "the empty command is rejected");
  ok(!normaliseCommand("   ").ok, "so is whitespace only");
  ok(!normaliseCommand(42 as any).ok, "so is a non-string");
  ok(!normaliseCommand("x".repeat(MAX_COMMAND_LEN + 1)).ok, "an enormous paste is rejected");
  // Full control was chosen, so a 'dangerous'-looking command is NOT blocked
  // here — the safety gate downstream is where it is caught and confirmed.
  ok(normaliseCommand("delete every file in Documents").ok, "a risky-sounding command still passes (the gate handles risk)");
}

console.log("  a confirmation is answered as itself");
{
  const relay = new ConfirmRelay();
  ok(!relay.isPending, "nothing pending at rest");
  const { id, answered } = relay.ask("Send this email to Bob?", "high", 1000);
  ok(relay.isPending, "asking makes it pending");
  ok(relay.current()?.prompt.includes("Bob") === true, "and the phone can see the question");

  // The dangerous case: answer names the WRONG id.
  ok(!relay.answer("some-other-id", true), "an answer to a different question is refused");
  ok(relay.isPending, "so the real question is still pending");

  ok(relay.answer(id, true), "answering the right id works");
  ok((await answered) === true, "and resolves the waiting action as approved");
  ok(!relay.isPending, "then nothing is pending");
}
{
  const relay = new ConfirmRelay();
  const { id, answered } = relay.ask("Delete the folder?", "high", 1000);
  relay.answer(id, false);
  ok((await answered) === false, "a 'no' from the phone denies the action");
}
{
  // Silence must deny, never approve.
  const relay = new ConfirmRelay();
  const { answered } = relay.ask("Pay the invoice?", "high", 40);
  ok((await answered) === false, "a question that times out is denied, not approved");
  ok(!relay.isPending, "and is cleared");
}
{
  // A new question supersedes an unanswered one, denying the old so its caller
  // is not stuck forever.
  const relay = new ConfirmRelay();
  const first = relay.ask("Old question?", "medium", 1000);
  const second = relay.ask("New question?", "high", 1000);
  ok((await first.answered) === false, "the superseded question is auto-denied");
  ok(relay.current()?.id === second.id, "and the new one is what the phone now shows");
  relay.answer(second.id, true);
  ok((await second.answered) === true, "which can still be answered normally");
}
{
  // Disconnect cancels anything outstanding.
  const relay = new ConfirmRelay();
  const { answered } = relay.ask("Anything?", "high", 5000);
  relay.cancel();
  ok((await answered) === false, "a disconnect denies the pending question");
  ok(!relay.isPending, "and clears it");
}
{
  // Answered out loud at the Mac: the phone must stop showing it, but the id
  // must be dismissed rather than re-answered.
  const relay = new ConfirmRelay();
  const { id } = relay.ask("Approve at the Mac?", "high", 5000);
  ok(relay.isPending, "pending while unanswered");
  relay.dismiss("wrong-id");
  ok(relay.isPending, "dismissing a different id changes nothing");
  relay.dismiss(id);
  ok(!relay.isPending, "dismissing the right id clears it from the phone");
}

console.log(`\n${pass}/${pass + fail} signalling checks passed\n`);
process.exit(fail ? 1 : 0);
