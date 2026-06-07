import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import { writePersonaFile, invalidatePersonasCache } from "../utils/parser.js";
import type { PersonaMeta } from "../utils/parser.js";
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
  it("calls review_content_wizard via MCP client (multi-turn)", async () => {
    const server = createKevlarServer();

    // Seed a test persona
    const meta: PersonaMeta = {
      id: "e2e_persona",
      name: "E2E Tester",
      name_en: "E2E Tester",
      version: "1.0.0",
      author: "kevlar-core",
      tags: ["e2e"],
      description: "E2E test persona",
      blindSpot: "none",
    };
    await writePersonaFile(tmpDir, meta, "常用平台：通用\n性格特质：温和\n盲区：无");
    invalidatePersonasCache();

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
      // Step 1: Start wizard with content → waitingForReviewDecision
      const step1 = await client.callTool({
        name: "review_content_wizard",
        arguments: {
          userMessage: "请评测这篇内容：这是一个用于 E2E 测试的文本",
        },
      });

      assert.ok(step1, "Step 1 response should exist");
      assert.ok(Array.isArray(step1.content), "Step 1 response should have content array");
      assert.equal(step1.content[0].type, "text");

      const step1Text = step1.content[0].text;
      assert.ok(step1Text.includes("请选择下一步："), "Should ask for the next review action");
      assert.ok(step1Text.includes("1. 进入复审"), "Should offer review as the next action");
      assert.ok(step1Text.includes("currentStep: waitingForReviewDecision"), "Should be in review decision step");

      // Extract sessionId
      const sessionIdMatch = step1Text.match(/sessionId:\s*([a-z0-9-]+)/);
      assert.ok(sessionIdMatch, "Should include sessionId");
      const sessionId = sessionIdMatch[1];

      // Step 2: confirm review → waitingForReviewerConfirmation
      const step2 = await client.callTool({
        name: "review_content_wizard",
        arguments: {
          sessionId,
          userMessage: "开始复审",
        },
      });

      assert.ok(step2, "Step 2 response should exist");
      assert.ok(Array.isArray(step2.content), "Step 2 response should have content array");
      assert.equal(step2.content[0].type, "text");
      const step2Text = step2.content[0].text;
      assert.ok(step2Text.includes("当前共有 1 位评审员"), "Should show persona count");
      assert.ok(step2Text.includes("currentStep: waitingForReviewerConfirmation"), "Should be in reviewer confirmation step");

      // Step 3: "开始复审" → executes review
      const step3 = await client.callTool({
        name: "review_content_wizard",
        arguments: {
          sessionId,
          userMessage: "开始复审",
        },
      });

      assert.ok(step3, "Step 3 response should exist");
      assert.ok(Array.isArray(step3.content), "Step 3 response should have content array");
      assert.equal(step3.content[0].type, "text");
      const step3Text = step3.content[0].text;
      assert.ok(step3Text.includes("E2E Tester"), "Should include persona name in report");
      assert.ok(step3Text.includes("这是一个用于 E2E 测试的文本"), "Should include the provided content");
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
