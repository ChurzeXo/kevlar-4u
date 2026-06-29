#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKevlarServer, announceHandshakeToClient, setServerInitialized, isServerInitialized } from "./server.js";
import { getErrorInfo } from "./utils/observability.js";
import { writeRawStderr } from "./utils/logger.js";
import { instrumentTransport } from "./utils/instrumentTransport.js";

let _rawInitializeParams: any = null;

async function main() {
	const server = await createKevlarServer();
	const transport = new StdioServerTransport();

	const initTimeoutMs = parseInt(process.env.KEVLAR_INIT_TIMEOUT_MS || "30000", 10);
	let initTimer: ReturnType<typeof setTimeout> | null = null;

	instrumentTransport(transport as any);

	const prevOnMessage = transport.onmessage;
	transport.onmessage = (msg: any) => {
		if (msg?.method === "initialize") {
			_rawInitializeParams = msg.params ?? null;
		}
		prevOnMessage?.(msg);

		if (msg?.method === "notifications/initialized") {
			if (initTimer) {
				clearTimeout(initTimer);
				initTimer = null;
			}
			setServerInitialized();
			announceHandshakeToClient(server.server, undefined, _rawInitializeParams);
		}
	};

	await server.connect(transport);

	initTimer = setTimeout(() => {
		if (!isServerInitialized()) {
			writeRawStderr(
				`[Kevlar-4u] Initialize timeout: no handshake completed within ${initTimeoutMs}ms`,
			);
			process.exit(1);
		}
	}, initTimeoutMs);
}

main().catch((err) => {
	const info = getErrorInfo(err);
	writeRawStderr(`[Kevlar-4u] Fatal error: [${info.code}] ${info.message}`);
	process.exit(1);
});
