/**
 * The MCP layer: isolated, deadlined, uniquely named, closeable.
 *   npm run mcptest
 *
 * Every case here is a way MCP used to fail quietly rather than loudly — a
 * server that hangs taking the whole turn with it, one bad entry hiding the
 * servers after it, a name too long for Gemini rejecting every tool in the
 * request, processes left running after a brain switch.
 *
 * No server is ever spawned: the client factory is injected, so each failure
 * mode is produced on demand instead of waited for.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeMcpServers,
  connectMcpServers,
  loadMcpConfig,
  openMcpServerCount,
  toolNameFor,
  type ClientFactory,
} from "./brain/mcp.js";

let pass = 0;
const failures: string[] = [];
function ok(value: unknown, message: string): void {
  if (value) {
    pass++;
    console.log(`  ✓ ${message}`);
    return;
  }
  failures.push(message);
  console.log(`  ✗ ${message}`);
}

const dir = mkdtempSync(join(tmpdir(), "echo-mcp-"));
const writeConfig = (name: string, body: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};

/** A server that connects, lists the tools it was given, and answers calls. */
const fakeServer = (tools: any[], onCall?: (name: string, args: any) => any): any => ({
  client: {
    listTools: async () => ({ tools }),
    callTool: async ({ name, arguments: args }: any) => onCall?.(name, args) ?? { content: [{ type: "text", text: `${name} ok` }] },
    close: async () => {},
  },
  transport: { close: async () => {} },
});

console.log("\nMCP layer\n");

console.log("  reading mcp.json");
{
  ok(Object.keys(loadMcpConfig(join(dir, "nope.json"))).length === 0, "a missing file is no servers, not a crash");
  ok(Object.keys(loadMcpConfig(writeConfig("broken.json", "{ not json"))).length === 0,
    "a malformed file is no servers, not a crash");
  ok(Object.keys(loadMcpConfig(writeConfig("empty.json", { mcpServers: {} }))).length === 0,
    "an empty server list is handled");

  const mixed = loadMcpConfig(writeConfig("mixed.json", {
    mcpServers: {
      good: { command: "/bin/echo", args: ["hi"], env: { K: "v" } },
      broken: { args: ["no command"] },
    },
  }));
  ok(Object.keys(mixed).length === 1 && !!mixed.good, "an entry with no command is dropped, the rest survive");
  ok(mixed.good.args?.[0] === "hi" && mixed.good.env?.K === "v", "command, args and env are carried through");
}

console.log("  naming tools the model can actually call");
{
  ok(toolNameFor("sarvam", "tts_speak") === "mcp__sarvam__tts_speak", "the ordinary case is the obvious name");
  ok(!/[^a-zA-Z0-9_]/.test(toolNameFor("my-server", "do.the/thing")), "hyphens, dots and slashes are replaced");

  const long = toolNameFor("averyverylongservername", "an_extremely_long_tool_name_that_keeps_going_and_going");
  ok(long.length <= 64, `an over-long name is capped at 64 (got ${long.length})`);
  ok(long.startsWith("mcp__averyverylongservername__"), "the routing prefix survives the cap");

  const taken = new Set(["mcp__s__t"]);
  const second = toolNameFor("s", "t", taken);
  ok(second !== "mcp__s__t", "a collision gets a different name instead of overwriting");
}

console.log("  one bad server does not take the others with it");
{
  const factory: ClientFactory = async (name) => {
    if (name === "broken") throw new Error("spawn ENOENT");
    return fakeServer([{ name: "works", description: "a tool", inputSchema: { type: "object", properties: {} } }]);
  };
  const { tools, servers } = await connectMcpServers({
    config: {
      broken: { command: "/nope" },
      working: { command: "/bin/echo" },
    },
    factory,
  });
  ok(tools.length === 1 && tools[0].name === "mcp__working__works", "the healthy server's tools still load");
  ok(servers.find((s) => s.name === "broken")?.ok === false, "the failure is reported, not swallowed");
  ok(/ENOENT/.test(servers.find((s) => s.name === "broken")?.error ?? ""), "the reason is kept for the log");
  await closeMcpServers();
}

console.log("  a hung server cannot hang the brain");
{
  // The real shape of this: uvx spawns, fetches a package, and never speaks.
  const factory: ClientFactory = async () => new Promise(() => {}) as any;
  const started = Date.now();
  const { tools, servers } = await connectMcpServers({
    config: { hangs: { command: "/bin/sleep" } },
    factory,
    timeout: 60,
  });
  const elapsed = Date.now() - started;
  ok(elapsed < 2000, `connect gives up rather than waiting forever (${elapsed}ms)`);
  ok(tools.length === 0 && servers[0]?.ok === false, "the hung server contributes no tools and is marked failed");
  ok(/timed out/.test(servers[0]?.error ?? ""), "the timeout says so in the error");
}

console.log("  a hung TOOL CALL cannot hang the turn either");
{
  const factory: ClientFactory = async () => ({
    client: {
      listTools: async () => ({ tools: [{ name: "slow", description: "d", inputSchema: {} }] }),
      callTool: () => new Promise(() => {}),
      close: async () => {},
    },
    transport: { close: async () => {} },
  } as any);
  const { tools } = await connectMcpServers({ config: { s: { command: "x" } }, factory, timeout: 60 });
  let message = "";
  try {
    await tools[0].call({});
  } catch (err: any) {
    message = String(err?.message ?? err);
  }
  ok(/timed out/.test(message), "a call that never returns rejects instead of stalling the loop");
  await closeMcpServers();
}

console.log("  results are never empty");
{
  const factory: ClientFactory = async () => fakeServer(
    [
      { name: "quiet", description: "d", inputSchema: {} },
      { name: "angry", description: "d", inputSchema: {} },
    ],
    (name) => (name === "quiet" ? { content: [] } : { content: [], isError: true })
  );
  const { tools } = await connectMcpServers({ config: { s: { command: "x" } }, factory });
  const quiet = await tools.find((t) => t.originalName === "quiet")!.call({});
  const angry = await tools.find((t) => t.originalName === "angry")!.call({});
  // An empty tool result reads to a model as "that failed" and is how a turn
  // ends with nothing said.
  ok(quiet.text!.trim().length > 0, "a server that returns no content still yields text");
  ok(/error/i.test(angry.text ?? ""), "an error result says it errored");
  // Transport failure must survive as a typed status, not only as prose: the
  // reliability tables and the training set are built from these labels.
  ok(quiet.status === "success" && angry.status === "failed", "isError becomes a typed failure, not ordinary text");
  ok((angry.data as any)?.isError === true, "the structured MCP result is preserved alongside the text");
  await closeMcpServers();
}

console.log("  servers are shut down, not abandoned");
{
  let closedClients = 0;
  let closedTransports = 0;
  const factory: ClientFactory = async () => ({
    client: {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => { closedClients++; },
    },
    transport: { close: async () => { closedTransports++; } },
  } as any);

  await connectMcpServers({ config: { a: { command: "x" }, b: { command: "y" } }, factory });
  ok(openMcpServerCount() === 2, "both servers are tracked while open");
  await closeMcpServers();
  ok(closedClients === 2 && closedTransports === 2, "every client and its child process are closed");
  ok(openMcpServerCount() === 0, "nothing is left tracked");

  // Each connection owns its own clients. This used to be one global set, so
  // a clone starting up closed the main brain's servers out from under it and
  // its next tool call answered "unknown tool". Connecting must now be additive.
  const first = await connectMcpServers({ config: { a: { command: "x" } }, factory });
  const second = await connectMcpServers({ config: { a: { command: "x" } }, factory });
  ok(openMcpServerCount() === 2, "a second brain's servers are tracked alongside the first's");
  const beforeClosing = closedClients;
  await second.close();
  ok(closedClients === beforeClosing + 1, "closing one brain closes only its own client");
  ok(openMcpServerCount() === 1, "the other brain's server is still open");
  await second.close();
  ok(openMcpServerCount() === 1, "closing twice is idempotent and touches nothing else");
  await first.close();
  ok(openMcpServerCount() === 0, "the owner closes its own set");
  await closeMcpServers();
}

console.log(`\n${pass}/${pass + failures.length} MCP checks passed\n`);
if (failures.length) {
  console.error(`${failures.length} problem(s):\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
