/**
 * Jarvis's identity — who it says built it.
 *
 *   npm run personatest
 *
 * This is a product requirement, not an implementation detail: whichever model
 * is behind Jarvis, its creator is Deepak, and that must survive brain switches
 * and future edits to the prompt. The checks are deliberately blunt so a well
 * meaning rewrite that drops the line fails loudly.
 */
import { JARVIS_PERSONA, CREATOR } from "./brain/types.js";
import { TOOLS } from "./tools/registry.js";
import { classify } from "./safety/risk.js";
import { toolsForLocalModel } from "./brain/localtools.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

console.log("\nCreator identity\n");

console.log("  the persona names the real creator");
{
  const p = JARVIS_PERSONA;
  ok(p.includes(CREATOR.name), "Deepak is named");
  ok(p.includes(CREATOR.org), "AskDeepakAI is named");
  ok(/created by Deepak|Deepak,? (the )?(founder|creator)|creator.{0,20}Deepak/i.test(p),
     "Deepak is stated as the creator, not merely mentioned");
  ok(/who (built|made|created) you|your creator/i.test(p),
     "the persona tells Jarvis how to answer the question when asked");
}
{
  // The core of the requirement: the underlying model must never be presented
  // as the creator. The persona must actively DENY that, so no brain answers
  // "I was made by Anthropic/Google".
  const p = JARVIS_PERSONA.toLowerCase();
  ok(/not anthropic|not claude|not google|not gemini|not any model|not the model/.test(p),
     "the persona explicitly rules out the model or company as creator");
  ok(/whichever (underlying )?model|any brain|during any brain|regardless of.{0,30}model/i.test(JARVIS_PERSONA),
     "and says the identity holds whichever brain is running");
}

console.log("  the creator record is the single source of truth");
{
  ok(CREATOR.github === "https://github.com/thedeepakreddy", "GitHub URL is exact");
  ok(CREATOR.linkedin === "https://www.linkedin.com/in/deepak-reddy-038582223", "LinkedIn URL is exact");
  ok(CREATOR.github.startsWith("https://") && CREATOR.linkedin.startsWith("https://"),
     "both pages are https");
}

console.log("  there is a way to show his page");
{
  const tool = TOOLS.find((t) => t.name === "show_creator_page");
  ok(!!tool, "the show_creator_page tool exists");
  ok(/github/i.test(tool?.description ?? "") && /linkedin/i.test(tool?.description ?? ""),
     "and offers both GitHub and LinkedIn");
  // A no-argument call is valid (defaults to GitHub), so the schema must not
  // force the argument.
  const parsed = tool?.schema?.which;
  ok(!!parsed && typeof (parsed as any).parse === "function", "the 'which' argument exists");
}

console.log("  every brain can reach it");
{
  ok(classify("show_creator_page", {}, { workingDir: "/tmp" }).tier !== "high",
     "showing the page is not treated as a dangerous action");
  const local = toolsForLocalModel(TOOLS.map((t) => ({ name: t.name, function: { name: t.name } })));
  ok(local.some((t: any) => (t.function?.name ?? t.name) === "show_creator_page"),
     "the local model is offered the tool too, so it works on the Ollama brain");
}

console.log(`\n${pass}/${pass + fail} identity checks passed\n`);
process.exit(fail ? 1 : 0);
