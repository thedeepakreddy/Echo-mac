import { loadConfig } from "./src/config.js";
import { createBrain } from "./src/brain/index.js";
import { resolve } from "path";

const cfg = loadConfig(resolve("."));
const { brain } = createBrain(cfg);

console.log("Starting main brain...");

brain.on("text", (text) => {
  console.log(`[MAIN BRAIN]: ${text}`);
});

brain.on("tool", (t) => {
  console.log(`[MAIN TOOL]: ${t.name} - ${t.summary}`);
});

brain.send("Spawn a subagent to write the text 'ECHO CLONE TEST SUCCESS' into a file named 'echo_clone_test.txt' on my Desktop. Do not do it yourself, you MUST spawn a subagent to do it.");

setTimeout(() => {
  console.log("Exiting test.");
  process.exit(0);
}, 20000);
