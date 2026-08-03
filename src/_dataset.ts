/**
 * Inspect and export the DeepakLLM training set.
 *
 *   npm run dataset             what has been collected
 *   npm run dataset -- --export  write a portable bundle to deepakllm/dataset
 *
 * The live journal stays in ~/.jarvis/trajectories, which is append-only and
 * outside the repo. Export takes a SNAPSHOT of it into deepakllm/, copying the
 * screenshots in and rewriting every path as relative — so the folder can be
 * moved to another machine and still train. An export referencing
 * /Users/<name>/… is not portable, it just looks like it is.
 *
 * What it DROPPED is reported as loudly as what it kept: a dataset that
 * silently halves itself is how a training run ends up unexplained.
 */
import { writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import {
  loadAll,
  buildTrainingSet,
  toChatFormat,
  datasetStats,
  describeStats,
  trajectoryDir,
  type TrainingExample,
} from "./learn/trajectory.js";

const args = process.argv.slice(2);
const wantExport = args.includes("--export");
const BUNDLE = join(process.cwd(), "deepakllm", "dataset");

const stats = await datasetStats();
console.log(`\n${describeStats(stats)}\n`);

if (!stats.steps) {
  console.log("Turn it on with \"learning\": { \"enabled\": true } in config.json,");
  console.log("then use Jarvis normally — every teacher action becomes an example.\n");
  process.exit(0);
}

const rows = await loadAll();
const set = buildTrainingSet(rows);

console.log("Training set:");
console.log(`  usable examples   ${set.kept}`);
console.log(`  dropped — no outcome yet   ${set.dropped.unlabelled}`);
console.log(`  dropped — turn failed      ${set.dropped.failed}`);
console.log(`  dropped — student's own    ${set.dropped.student}`);
console.log(`  dropped — user refused     ${set.dropped.refused}`);

const withImages = set.examples.filter((e) => e.image).length;
console.log(`  carrying a screenshot      ${withImages}`);

// The honest read on whether this is worth training on yet.
console.log("");
if (set.kept < 500) {
  console.log(`Not enough to train on yet. Tool-name adherence starts improving`);
  console.log(`around 2,000–5,000 examples; you have ${set.kept}.`);
} else if (set.kept < 5000) {
  console.log(`Enough for a first LoRA run on tool selection and argument shape.`);
  console.log(`Coordinate grounding needs closer to 10,000.`);
} else {
  console.log(`Enough for a serious run, including grounding.`);
}

if (wantExport) {
  const screensOut = join(BUNDLE, "screens");
  // Rebuild the bundle from scratch. Leaving stale screenshots behind would
  // grow it without bound and silently ship images no example refers to.
  rmSync(BUNDLE, { recursive: true, force: true });
  mkdirSync(screensOut, { recursive: true });

  let copied = 0;
  let missing = 0;
  const portable: TrainingExample[] = set.examples.map((e) => {
    if (!e.image) return e;
    if (!existsSync(e.image)) {
      // The row survives without its picture; a text-only example still
      // teaches tool choice, which is most of the value early on.
      missing += 1;
      return { ...e, image: undefined };
    }
    const name = basename(e.image);
    try {
      copyFileSync(e.image, join(screensOut, name));
      copied += 1;
      return { ...e, image: `screens/${name}` };
    } catch {
      missing += 1;
      return { ...e, image: undefined };
    }
  });

  const lines = portable.map((e) => JSON.stringify(toChatFormat(e)));
  const jsonl = join(BUNDLE, "training.jsonl");
  writeFileSync(jsonl, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");

  writeFileSync(
    join(BUNDLE, "manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        examples: lines.length,
        screenshots: copied,
        droppedScreenshots: missing,
        dropped: set.dropped,
        sourceCounts: stats.bySource,
        imagePaths: "relative to this folder",
        note: "Snapshot of ~/.jarvis/trajectories. Safe to copy anywhere.",
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`\nBundle written to ${BUNDLE}`);
  console.log(`  training.jsonl   ${lines.length} examples`);
  console.log(`  screens/         ${copied} images${missing ? `, ${missing} unavailable` : ""}`);
  console.log(`  paths are relative — the folder can be moved as-is`);
}
console.log("");
