import { execSync } from 'child_process';
try {
  const output = execSync('/opt/homebrew/bin/cliclick p', { encoding: 'utf-8' });
  console.log("cliclick success:", output);
} catch (e) {
  console.error("cliclick failed:", e);
}
