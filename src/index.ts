#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKevlarServer } from "./server.js";

async function main() {
  const server = createKevlarServer();
  const transport = new StdioServerTransport();

  console.error("[Kevlar] 🛡️  MCP Server starting...");

  await server.connect(transport);

  console.error("[Kevlar] ✅  Server connected via Stdio. Waiting for client...");
}

main().catch((err) => {
  console.error("[Kevlar] Fatal error:", err);
  process.exit(1);
});
