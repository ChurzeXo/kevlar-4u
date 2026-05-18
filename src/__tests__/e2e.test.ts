import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
  it("simulates an MCP client calling review_content", async () => {
    const handlers: any[] = [];
    const originalSetRequestHandler = Server.prototype.setRequestHandler;
    
    // Intercept setRequestHandler to extract the ToolCall handler
    Server.prototype.setRequestHandler = function (schema: any, handler: any) {
      handlers.push(handler);
      originalSetRequestHandler.call(this, schema, handler);
    };

    let server;
    try {
      server = createKevlarServer();
      
      // In createKevlarServer, the second request handler registered is for CallToolRequestSchema
      const toolCallHandler = handlers[1];
      assert.ok(toolCallHandler, "Tool call handler should be registered");

      // Seed a test persona
      const personaPath = path.join(tmpDir, "e2e_persona.md");
      fs.writeFileSync(personaPath, [
        "---",
        "id: e2e_persona",
        "name: E2E Tester",
        "name_en: E2E Tester",
        "version: 1.0.0",
        "author: test",
        "tags: [e2e]",
        "description: Testing persona",
        "---",
        "You are an E2E test persona.",
      ].join("\n"), "utf-8");

      // Construct a mock request similar to what an MCP client sends
      const request = {
        params: {
          name: "review_content",
          arguments: {
            content: "这是一个用于 E2E 测试的文本",
            context: "自动化测试环境",
            mode: "orchestration" // Use orchestration to avoid external API calls in test
          }
        }
      };

      // Call the tool handler directly
      const response = await toolCallHandler(request);
      
      // Verify response structure and contents
      assert.ok(response && !response.isError, "Response should be valid");
      assert.ok(Array.isArray(response.content), "Response should have content array");
      assert.equal(response.content[0].type, "text");
      
      const textOutput = response.content[0].text;
      assert.ok(textOutput.includes("E2E Tester"), "Should include persona name");
      assert.ok(textOutput.includes("编排代理模式"), "Should indicate orchestration mode");
      assert.ok(textOutput.includes("这是一个用于 E2E 测试的文本"), "Should include the provided content");
    } finally {
      // Restore prototype
      Server.prototype.setRequestHandler = originalSetRequestHandler;
    }
  });
});
