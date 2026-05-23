import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKevlarServer } from "../server.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-e2e-"));
  process.env.KEVLAR_SKILLS_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KEVLAR_SKILLS_DIR;
});

describe("End-to-End integration test", () => {
  it("calls review_content via MCP client", async () => {
    const server = createKevlarServer();

    // Seed a test persona
    const personaPath = path.join(tmpDir, "e2e_persona.md");
    fs.writeFileSync(personaPath, [
      "---",
      "id: e2e_persona",
      "name: E2E Tester",
      "name_en: E2E Tester",
      "version: 1.0.0",
      "author: kevlar-core",
      "tags: [e2e]",
      "description: E2E test persona",
      "blindSpot: none",
      "---",
      "常用平台：通用",
      "性格特质：温和",
      "盲区：无",
    ].join("\n"), "utf-8");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "kevlar-e2e-test", version: "1.0.0" },
      { capabilities: {} }
    );

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const response = await client.callTool({
        name: "review_content",
        arguments: {
          content: "这是一个用于 E2E 测试的文本",
          context: "自动化测试环境",
          mode: "orchestration",
        },
      });

      assert.ok(response, "Response should exist");
      assert.ok(Array.isArray(response.content), "Response should have content array");
      assert.equal(response.content[0].type, "text");

      const textOutput = response.content[0].text;
      assert.ok(textOutput.includes("E2E Tester"), "Should include persona name");
      assert.ok(textOutput.includes("宿主辅助兜底模式"), "Should indicate orchestration fallback mode");
      assert.ok(textOutput.includes("这是一个用于 E2E 测试的文本"), "Should include the provided content");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("starts create_persona_wizard via MCP client", async () => {
    const server = createKevlarServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "kevlar-e2e-test", version: "1.0.0" },
      { capabilities: {} }
    );

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const response = await client.callTool({
        name: "create_persona_wizard",
        arguments: {
          userMessage: "开始创建人设",
        },
      });

      assert.ok(response, "Response should exist");
      assert.ok(Array.isArray(response.content), "Response should have content array");

      const textOutput = response.content[0].text;
      assert.ok(textOutput.includes("年龄段"), "Should ask about age range");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
