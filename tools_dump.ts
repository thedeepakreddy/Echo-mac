import { TOOLS } from "./src/tools/registry.js";
import fs from "fs";
let out = "# Jarvis Tool Registry\n\n";
for (const t of TOOLS) {
  out += `### ${t.name}\n${t.description}\n\n`;
}
fs.writeFileSync("tools_dump.md", out);
