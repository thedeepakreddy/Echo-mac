const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function run() {
  const transport = new StdioClientTransport({
    command: "/Users/thedeepakreddy/.local/bin/uvx",
    args: ["sarvam-mcp"],
    env: { ...process.env, SARVAM_API_KEY: "sk_yi3osl3a_brxCMn7OZ0pvTJGiLS2q4RkC" }
  });
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));
  process.exit(0);
}
run().catch(console.error);
