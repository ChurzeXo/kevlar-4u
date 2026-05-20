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
      "description: Testing persona",
      "---",
      "You are an E2E test persona.",
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
      assert.ok(textOutput.includes("编排代理模式"), "Should indicate orchestration mode");
      assert.ok(textOutput.includes("这是一个用于 E2E 测试的文本"), "Should include the provided content");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists prompts and gets prompt contents via MCP client", async () => {
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
      // 1. List prompts
      const listResponse = await client.listPrompts();
      assert.ok(listResponse, "Prompts list should exist");
      assert.ok(Array.isArray(listResponse.prompts), "Prompts should be an array");
      
      const promptNames = listResponse.prompts.map((p: any) => p.name);
      assert.ok(promptNames.includes("create_persona"), "Should list create_persona prompt");
      assert.ok(promptNames.includes("review_content"), "Should list review_content prompt");

      // 2. Get create_persona prompt
      const getCreateResponse = await client.getPrompt({ name: "create_persona" });
      assert.ok(getCreateResponse, "Prompt response should exist");
      assert.ok(Array.isArray(getCreateResponse.messages), "Prompt should have messages");
      assert.equal(getCreateResponse.messages[0].role, "assistant");
      assert.ok(
        getCreateResponse.messages[0].content.type === "text" &&
        getCreateResponse.messages[0].content.text.includes("你是一个角色构建引擎"),
        "Should contain create_persona instructions"
      );

      // 3. Get review_content prompt
      const getReviewResponse = await client.getPrompt({ name: "review_content" });
      assert.ok(getReviewResponse, "Prompt response should exist");
      assert.ok(Array.isArray(getReviewResponse.messages), "Prompt should have messages");
      assert.equal(getReviewResponse.messages[0].role, "assistant");
      assert.ok(
        getReviewResponse.messages[0].content.type === "text" &&
        getReviewResponse.messages[0].content.text.includes("内容评论"),
        "Should contain review instructions"
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("creates a persona directly without sessionId via MCP client", async () => {
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
        name: "create_persona",
        arguments: {
          id: "direct_persona",
          name: "直接创建评论员",
          name_en: "Direct Persona",
          description: "一个直接创建的用于测试的评论员",
          tags: ["direct", "test"],
        },
      });

      assert.ok(response, "Response should exist");
      assert.ok(Array.isArray(response.content), "Response should have content array");
      assert.equal(response.content[0].type, "text");

      const textOutput = response.content[0].text;
      assert.ok(textOutput.includes("直接创建评论员"), "Should indicate success with name");

      // Verify the file was written
      const filePath = path.join(tmpDir, "direct_persona.md");
      assert.ok(fs.existsSync(filePath), "Persona file should exist");
      const fileContent = fs.readFileSync(filePath, "utf-8");
      assert.ok(fileContent.includes("name: 直接创建评论员"), "Metadata name should match");
      assert.ok(fileContent.includes("name_en: Direct Persona"), "Metadata name_en should match");
      assert.ok(fileContent.includes("一个直接创建的用于测试的评论员"), "Body description should match");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

