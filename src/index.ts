#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKevlarServer } from "./server.js";
import { getErrorInfo } from "./utils/observability.js";
import { writeRawStderr } from "./utils/logger.js";

async function main() {
	const server = await createKevlarServer();
	const transport = new StdioServerTransport();

	writeRawStderr("[Kevlar-4u] 🛡️  Server starting...");

	await server.connect(transport);

	writeRawStderr(
		"[Kevlar-4u] ✅  Server connected via Stdio. Waiting for client...",
	);
}

main().catch((err) => {
	const info = getErrorInfo(err);
	writeRawStderr(`[Kevlar-4u] Fatal error: [${info.code}] ${info.message}`);
	process.exit(1);
});
