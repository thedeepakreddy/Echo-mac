import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAppPath } from "../utils/appPath.js";
import type { ToolOutput } from "../tools/registry.js";

/**
 * One place that knows how to reach an MCP server.
 *
 * This used to live twice — once in the Gemini brain, once in the Claude brain —
 * and both copies had the same four holes:
 *
 *   1. mcp.json was looked up in process.cwd(). That is the project directory
 *      when Echo is started with `npm start` and `/` when it is launched from
 *      Finder, so a packaged build silently had no MCP servers at all and said
 *      nothing about it.
 *   2. Every server was connected inside ONE try/catch. The first server whose
 *      binary was missing threw, and every server after it was never reached —
 *      with one line on the console as the only trace.
 *   3. `await client.connect(...)` had no timeout. A server that spawns but
 *      never speaks (uvx fetching a package on a bad network is the obvious
 *      one) hangs initMcp forever, and because the agent loop awaits it before
 *      its first request, the brain goes quiet with no error and no turn end.
 *      That is a silent stop with a cause nobody can see.
 *   4. Nothing was ever closed. Every brain switch spawned a fresh set of
 *      server processes and abandoned the previous ones.
 *
 * Everything here is therefore per-server isolated, deadlined, and closeable.
 */

/** How a server is described in mcp.json. */
export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A single MCP tool, already named the way the model will call it. */
export interface McpToolHandle {
  /** `mcp__<server>__<tool>`, sanitized and unique. */
  name: string;
  serverName: string;
  originalName: string;
  description: string;
  inputSchema: any;
  call(args: Record<string, unknown>): Promise<ToolOutput>;
}

/** What happened to each server, so a failure is reportable rather than lost. */
export interface McpServerStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface McpConnection {
  tools: McpToolHandle[];
  servers: McpServerStatus[];
  /** Close only this brain's clients. Idempotent. */
  close(): Promise<void>;
}

/** Gemini caps a function name at 64 characters and rejects anything longer. */
const MAX_TOOL_NAME = 64;

/**
 * How long a server gets to come up.
 *
 * 30s, measured rather than guessed: `uvx sarvam-mcp` takes about 16 seconds
 * from spawn to tool list on this machine, because uvx checks pypi for the
 * package on every start. A 15s deadline dropped a server that was working
 * perfectly well — so the number has to clear a real cold start with room to
 * spare, and the cost of it being generous is paid in the background (see the
 * eager connect in the Gemini brain) rather than by someone waiting for an
 * answer.
 */
function timeoutMs(): number {
  const n = Number(process.env.ECHO_MCP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30_000;
}

/**
 * Where mcp.json lives.
 *
 * The app path first — that is where every other config file in Echo is read
 * from — and the working directory second, so running from a checkout keeps
 * behaving exactly as it did.
 */
export function mcpConfigPath(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(join(getAppPath(), "mcp.json"));
  } catch {
    /* not inside Electron */
  }
  candidates.push(join(process.cwd(), "mcp.json"));
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Read the server list, tolerating a file that is missing or malformed.
 *
 * A broken mcp.json must not take the brain down with it: no MCP is a working
 * assistant with fewer tools, while a thrown parse error during startup is no
 * assistant at all.
 */
export function loadMcpConfig(path = mcpConfigPath()): Record<string, McpServerSpec> {
  // `ECHO_MCP=0` turns the whole layer off. Tests that construct a real brain
  // set it — a unit test has no business spawning somebody's uvx server — and
  // it doubles as the switch for running Echo without external tools.
  if (process.env.ECHO_MCP?.trim() === "0") return {};
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") return {};
    const out: Record<string, McpServerSpec> = {};
    for (const [name, spec] of Object.entries<any>(servers)) {
      if (!spec?.command || typeof spec.command !== "string") {
        console.error(`[mcp] server "${name}" has no command — skipping it`);
        continue;
      }
      out[name] = {
        command: spec.command,
        args: Array.isArray(spec.args) ? spec.args.map(String) : [],
        env: spec.env && typeof spec.env === "object" ? spec.env : {},
      };
    }
    return out;
  } catch (err: any) {
    console.error(`[mcp] could not read ${path}: ${err?.message ?? err}`);
    return {};
  }
}

/**
 * The name the model sees, guaranteed callable.
 *
 * Three rules, each earned: only `[A-Za-z0-9_]` survives (Gemini rejects the
 * rest), the result is capped at 64 characters (a longer one 400s the WHOLE
 * request, taking every other tool down with it), and a collision gets a
 * numeric suffix rather than silently overwriting the tool registered first.
 */
export function toolNameFor(serverName: string, toolName: string, taken: Set<string> = new Set()): string {
  const clean = (s: string) => String(s ?? "").replace(/[^a-zA-Z0-9_]/g, "_");
  let name = `mcp__${clean(serverName)}__${clean(toolName)}`;
  if (name.length > MAX_TOOL_NAME) {
    // Trim the middle of the tool's own name, not the prefix: the prefix is how
    // the brain routes the call back to the right server.
    const prefix = `mcp__${clean(serverName)}__`;
    name = prefix.length >= MAX_TOOL_NAME
      ? prefix.slice(0, MAX_TOOL_NAME)
      : prefix + clean(toolName).slice(0, MAX_TOOL_NAME - prefix.length);
  }
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const suffix = `_${i}`;
    const candidate = name.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return name; // 98 identical names is not a situation worth more code
}

/** Reject a promise if it has not settled in time, without leaving it dangling. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      // Deliberately NOT unref'd. An unref'd timer cannot hold the event loop
      // open, so when the thing being raced is a promise that never settles —
      // exactly the case this exists for — Node finds nothing pending and the
      // await is abandoned instead of rejecting. The `finally` below clears it,
      // so it can never outlive the call either.
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Text out of an MCP result, which is a list of typed content blocks. */
function textOf(result: any): string {
  const content = (result?.content ?? []) as any[];
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text) return text;
  // Never hand a brain an empty string: an empty tool result reads as failure
  // and is the shape of a turn that ends with nothing said.
  return result?.isError ? "The MCP tool reported an error with no message." : "done";
}

/** Live clients, so they can be shut down when a brain is replaced. */
type LiveClient = { name: string; client: Client; transport: StdioClientTransport };
const connections = new Set<Set<LiveClient>>();
async function closeClient(item: LiveClient): Promise<void> {
  try { await item.client.close(); } catch { /* transport owns process */ }
  try { await item.transport.close(); } catch { /* already closed */ }
}
/** Preserve structured content and errors rather than laundering them into prose. */
export function mcpToolOutput(result: any): ToolOutput {
  const content = Array.isArray(result?.content) ? result.content : [];
  const picture = content.find((b: any) => b?.type === "image" && typeof b.data === "string");
  return {
    text: textOf(result),
    status: result?.isError ? "failed" : "success",
    verification: "unverified",
    ...(result?.isError ? { error: { category: "tool_error", message: textOf(result) } } : {}),
    data: { content, structuredContent: result?.structuredContent ?? null, isError: !!result?.isError },
    ...(picture ? { image: { data: picture.data, mimeType: picture.mimeType ?? "image/png" } as any } : {}),
  };
}

export type ClientFactory = (
  serverName: string,
  spec: McpServerSpec
) => Promise<{ client: Client; transport: StdioClientTransport }>;

const defaultFactory: ClientFactory = async (serverName, spec) => {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
  });
  const client = new Client({ name: `echo-${serverName}`, version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
};

/**
 * Connect every configured server and collect their tools.
 *
 * Never throws and never hangs: a server that fails is reported in `servers`
 * and the others still load, which is the whole difference between "the Sarvam
 * server is missing" and "Echo has no tools tonight".
 */
export async function connectMcpServers(options: {
  config?: Record<string, McpServerSpec>;
  factory?: ClientFactory;
  timeout?: number;
} = {}): Promise<McpConnection> {
  const owned = new Set<LiveClient>();
  connections.add(owned);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    connections.delete(owned);
    const closing = [...owned];
    owned.clear();
    await Promise.all(closing.map(closeClient));
  };

  const config = options.config ?? loadMcpConfig();
  const factory = options.factory ?? defaultFactory;
  const deadline = options.timeout ?? timeoutMs();
  const tools: McpToolHandle[] = [];
  const servers: McpServerStatus[] = [];
  const taken = new Set<string>();

  for (const [serverName, spec] of Object.entries(config)) {
    let connected: { client: Client; transport: StdioClientTransport } | null = null;
    try {
      let accepted = true;
      const pending = factory(serverName, spec).then(async item => {
        if (!accepted || closed) { await closeClient({ name: serverName, ...item }); throw new Error("MCP connection expired"); }
        return item;
      });
      try { connected = await withDeadline(pending, deadline, `MCP server "${serverName}"`); }
      finally { accepted = false; }
      const listed = await withDeadline(
        connected.client.listTools(),
        deadline,
        `listing tools for "${serverName}"`
      );
      owned.add({ name: serverName, ...connected });

      for (const tool of listed?.tools ?? []) {
        const name = toolNameFor(serverName, tool.name, taken);
        taken.add(name);
        const client = connected.client;
        tools.push({
          name,
          serverName,
          originalName: tool.name,
          description: tool.description || `MCP tool ${tool.name} from ${serverName}`,
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          call: async (args) => {
            if (closed) return { status: "failed", text: "This MCP connection is closed.", error: { category: "unavailable", message: "MCP connection closed" }, verification: "unverified" };
            // A hung tool call stalls the agent loop exactly like a hung
            // connect does, so it gets the same deadline.
            const result = await withDeadline(
              client.callTool({ name: tool.name, arguments: args ?? {} }),
              deadline,
              `${name}`
            );
            return mcpToolOutput(result);
          },
        });
      }
      servers.push({ name: serverName, ok: true, toolCount: listed?.tools?.length ?? 0 });
      console.log(`[mcp] ${serverName}: ${listed?.tools?.length ?? 0} tool(s)`);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      servers.push({ name: serverName, ok: false, toolCount: 0, error: message });
      console.error(`[mcp] ${serverName} unavailable: ${message}`);
      // A server that timed out has a child process sitting there; the transport
      // owns it, so closing the transport is what actually kills it.
      try {
        await connected?.transport.close();
      } catch {
        /* it may already be gone */
      }
    }
  }

  return { tools, servers, close };
}

/** Explicit process shutdown only. A brain must call its own connection.close(). */
export async function closeMcpServers(): Promise<void> {
  const all = [...connections];
  connections.clear();
  await Promise.all(all.flatMap(owned => {
    const items = [...owned]; owned.clear();
    return items.map(closeClient);
  }));
}

export function openMcpServerCount(): number {
  return [...connections].reduce((sum, owned) => sum + owned.size, 0);
}
