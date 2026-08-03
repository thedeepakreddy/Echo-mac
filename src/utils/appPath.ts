import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

export function getAppPath(): string {
  try {
    return nodeRequire("electron").app.getAppPath();
  } catch {
    return process.cwd();
  }
}
