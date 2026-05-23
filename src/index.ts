#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKevlarServer } from "./server.js";
import { getErrorInfo } from "./utils/observability.js";

async function main() {
  const server = createKevlarServer();
  const transport = new StdioServerTransport();

  console.error("[Kevlar] 🛡️  MCP Server starting...");

  await server.connect(transport);

  console.error("[Kevlar] ✅  Server connected via Stdio. Waiting for client...");
}

main().catch((err) => {
  const info = getErrorInfo(err);
  console.error(`[Kevlar] Fatal error: [${info.code}] ${info.message}`);
  process.exit(1);
});
