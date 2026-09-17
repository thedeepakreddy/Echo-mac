/**
 * Changing brains by saying the name.
 *
 *   npm run switchtest
 *
 * Almost all of this is one question: when does "claude" mean "become Claude",
 * and when is it just a word in a sentence? Getting that wrong in the generous
 * direction is the expensive mistake — "ask Claude what it thinks" would throw
 * away the conversation the user was in the middle of and answer from a brain
 * with no memory of it — so the refusals below matter more than the matches.
 */
import { PROVIDERS, PROVIDER_LABELS, parseBrainSwitch, unavailableReason } from "./brain/switching.js";
import { TOOLS } from "./tools/registry.js";
import { classify } from "./safety/risk.js";
import { toolsForLocalModel } from "./brain/localtools.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const heard = (said: string, want: string | null) =>
  ok(parseBrainSwitch(said) === want, `${JSON.stringify(said)} → ${want ?? "not a switch"}`);

console.log("\nSwitching brains by name\n");

console.log("  the name on its own is the whole command");
{
  heard("claude", "claude");
  heard("gemini", "gemini");
  heard("ollama", "ollama");
  heard("llama", "ollama");
  heard("local", "ollama");
  heard("Gemini.", "gemini");
  heard("CLAUDE!", "claude");
  heard("  gemini  ", "gemini");
}

console.log("  and so are the ways people actually ask");
{
  heard("switch to gemini", "gemini");
  heard("switch your brain to claude", "claude");
  heard("change brain to ollama", "ollama");
  heard("use claude", "claude");
  heard("use the local model", "ollama");
  heard("go back to gemini", "gemini");
  heard("gemini please", "gemini");
  heard("switch to claude now", "claude");
  heard("can you switch to gemini", "gemini");
  heard("swap to ollama instead", "ollama");
  heard("echo switch to claude", "claude");
  heard("use the gemini brain", "gemini");
}

console.log("  a model's name is a request for the brain that runs it");
{
  heard("sonnet", "claude");
  heard("switch to opus", "claude");
  heard("flash", "gemini");
  heard("llama3.2", "ollama");
  heard("use llama 3.2", "ollama");
  heard("deepakllm", "ollama");
  heard("anthropic", "claude");
}

console.log("  but a sentence that is doing something else is left alone");
{
  heard("ask claude about the weather", null);
  heard("what does gemini think", null);
  heard("open claude code", null);
  heard("is claude better than gemini", null);
  heard("claude or gemini", null);
  heard("tell me about ollama models", null);
  heard("search for gemini horoscopes", null);
  heard("write an email to claude", null);
  heard("switch to dark mode", null);
  heard("switch the lights on", null);
  heard("", null);
  heard("   ", null);
  heard("switch", null);
  heard("brain", null);
  heard(
    "can you please switch your brain over to the gemini model now for me thanks",
    null
  );
}

console.log("  a brain that cannot start says so before anything is torn down");
{
  ok(unavailableReason("gemini", {}, "GEMINI_API_KEY") !== null, "no key means Gemini is unavailable");
  ok(unavailableReason("gemini", { GEMINI_API_KEY: " " }, "GEMINI_API_KEY") !== null,
     "and a blank one is no key at all");
  ok(unavailableReason("gemini", { GEMINI_API_KEY: "abc" }, "GEMINI_API_KEY") === null, "with a key it is fine");
  ok(unavailableReason("claude", {}) === null, "Claude needs nothing from the environment here");
  ok(unavailableReason("ollama", {}) === null, "and neither does the local model");
  ok(/GEMINI_API_KEY/.test(unavailableReason("gemini", {}, "GEMINI_API_KEY")!),
     "the reason names the variable, so the fix is obvious");
}

console.log("  every brain can be named out loud");
{
  for (const p of PROVIDERS) {
    ok(!!PROVIDER_LABELS[p], `${p} has a spoken label (${PROVIDER_LABELS[p]})`);
  }
  ok(PROVIDER_LABELS.ollama !== "ollama", "the local one is described, not spelled out");
  ok(PROVIDERS.every((p) => parseBrainSwitch(p) === p), "and every provider name parses to itself");
}

console.log("  the tool still exists for when the model decides");
{
  const tool = TOOLS.find((t) => t.name === "switch_brain");
  ok(!!tool, "switch_brain is registered");
  ok(!/restart the application|instantly restart/i.test(tool?.description ?? ""),
     "and no longer claims it restarts the app");
  ok(/live/i.test(tool?.description ?? "") && /no restart/i.test(tool?.description ?? ""),
     "it says the swap is live and needs no restart");

  const risk = classify("switch_brain", { brain: "gemini" }, { workingDir: "/tmp" });
  ok(risk.tier === "medium", "the model reaching for it unprompted still asks first");
  ok(!/restart/i.test(risk.reason), "and the question it asks is no longer about restarting");
  ok(/conversation/i.test(risk.reason), "it names the real cost: the conversation ends");

  const local = toolsForLocalModel(TOOLS.map((t) => ({ name: t.name, function: { name: t.name } })));
  ok(local.some((t: any) => (t.function?.name ?? t.name) === "switch_brain"),
     "the local model is offered it too, so it can hand off to a bigger brain");
}

console.log(`\n${pass}/${pass + fail} switching checks passed\n`);
process.exit(fail ? 1 : 0);
