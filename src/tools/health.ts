import { existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadConfig } from "../config.js";

function checkBinary(name: string): string | null {
  const binPath = `native/${name}`;
  if (!existsSync(binPath)) {
    return `Missing native binary: ${binPath}. It might have failed to compile or was deleted.`;
  }
  return null;
}

export async function check_health(): Promise<{ text: string }> {
  const issues: string[] = [];
  const config = loadConfig(process.cwd());

  // Check native binaries
  const binaries = ["axhelper", "facetracker", "visionhelper", "sonar", "textextract"];
  for (const bin of binaries) {
    const err = checkBinary(bin);
    if (err) issues.push(err);
  }

  // Check Ollama if active
  if (config.brain === "ollama") {
    try {
      execSync("curl -s http://localhost:11434/api/tags", { stdio: "pipe" });
      
      const model = config.ollama?.model || "llama3.2:3b";
      const ollamaList = execSync("ollama list").toString();
      if (!ollamaList.includes(model)) {
        issues.push(`Configured Ollama model '${model}' is not installed. Needs: ollama pull ${model}`);
      }
    } catch {
      issues.push("Ollama is not running. It needs to be started via 'brew services start ollama' or the Ollama app.");
    }
  }

  // Check Gemini API Key if active
  if (config.brain === "gemini") {
    const envKey = config.gemini?.apiKeyEnv || "GEMINI_API_KEY";
    if (!process.env[envKey]) {
      issues.push(`Gemini API key is missing. The environment variable ${envKey} must be set.`);
    }
  }

  // Write to log
  const timestamp = new Date().toISOString();
  let logEntry = `[${timestamp}] Health Check Run\n`;
  if (issues.length === 0) {
    logEntry += "Result: ALL SYSTEMS OPERATIONAL\n\n";
  } else {
    logEntry += "Result: ISSUES DETECTED\n";
    issues.forEach(issue => logEntry += `- ${issue}\n`);
    logEntry += "\n";
  }
  
  appendFileSync("health_record.txt", logEntry);

  if (issues.length === 0) {
    return { text: "Health check complete. All features are running well with no errors or inconsistencies found. A clean record has been saved to health_record.txt." };
  } else {
    return { text: `Health check complete. I found ${issues.length} problem(s):\n${issues.map(i => "- " + i).join("\n")}\n\nI have recorded these in health_record.txt. Let me know if you would like me to fix these issues.` };
  }
}
