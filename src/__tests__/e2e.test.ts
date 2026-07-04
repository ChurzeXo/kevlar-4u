import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";

import { writePersonaFile, invalidatePersonasCache } from "../utils/parser.js";
import type { PersonaMeta } from "../utils/parser.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKevlarServer, _resetServerInitializedForTest } from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REAL_TEMPLATES_DIR = path.resolve(__dirname, "..", "..", "skills", "templates");

let tmpDir: string;

beforeEach(() => {
  process.env.KEVLAR_SKIP_PRO_IMPORT = "1";
  _resetServerInitializedForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-e2e-"));
  const tmpTemplates = path.join(tmpDir, "templates");
  fs.mkdirSync(tmpTemplates, { recursive: true });
  for (const file of fs.readdirSync(REAL_TEMPLATES_DIR)) {
    fs.copyFileSync(path.join(REAL_TEMPLATES_DIR, file), path.join(tmpTemplates, file));
  }
  process.env.KEVLAR_SKILLS_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.KEVLAR_SKILLS_DIR;
  delete process.env.KEVLAR_SKIP_PRO_IMPORT;
});

describe("End-to-End integration test", () => {
  it("calls review_content_wizard via MCP client (multi-turn)", async () => {
    const server = await createKevlarServer();

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
      // Step 1: Start wizard → waitingForRegionSelection
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
      assert.ok(step1Text.includes("请告知本次内容计划推广的目标国家或地区"), "Should ask for target regions");
      assert.ok(step1Text.includes("currentStep: waitingForRegionSelection"), "Should be in region selection step");

      // Extract sessionId
      const sessionIdMatch = step1Text.match(/sessionId:\s*([a-z0-9-]+)/);
      assert.ok(sessionIdMatch, "Should include sessionId");
      const sessionId = sessionIdMatch[1];

      // Step 2: Select regions → waitingForReviewDecision (Free tier)
      const step2 = await client.callTool({
        name: "review_content_wizard",
        arguments: {
          sessionId,
          userMessage: "全球",
        },
      });

      assert.ok(step2, "Step 2 response should exist");
      const step2Text = (step2.content as any)[0].text;
      assert.ok(step2Text.includes("接下来进行舆论仿真推演"), "Should show review intro");
      assert.ok(step2Text.includes("输入编号选择"), "Should ask for persona number selection");
      assert.ok(step2Text.includes("currentStep: waitingForReviewDecision"), "Should be in review decision step");

      // Step 3: select persona by number → directly dispatches ExecutionBlueprint
      const step3 = await client.callTool({
        name: "review_content_wizard",
        arguments: {
          sessionId,
          userMessage: "1",
        },
      });

      assert.ok(step3, "Step 3 response should exist");
      assert.ok(Array.isArray(step3.content), "Step 3 response should have content array");
      assert.equal(step3.content[0].type, "text");
      const step3Text = step3.content[0].text;

      // Verify ExecutionBlueprint structure in the response
      assert.ok(step3Text.includes("kevlar.blueprint/v1"), "Should contain ExecutionBlueprint protocol marker");
      assert.ok(step3Text.includes("isolated_contexts"), "Should use ephemeral agents mode");
      assert.ok(step3Text.includes("Persona Review — Subagent Dispatch Request"), "Should contain dispatch request");

      // Extract the JSON blueprint from the ```json code block
      const jsonStart = step3Text.indexOf("```json");
      const contentStart = jsonStart + 7;
      const jsonBlockEnd = step3Text.indexOf("\n```", contentStart);
      const jsonText = jsonBlockEnd >= 0 ? step3Text.substring(contentStart, jsonBlockEnd).trim() : step3Text;
      const blueprint = JSON.parse(jsonText);

      assert.equal(blueprint.protocol, "kevlar.blueprint/v1");
      assert.equal(blueprint.execution.isolation.level, "strict");
      assert.equal(blueprint.contexts.length, 1);
      assert.equal(blueprint.contexts[0].id, "e2e_persona");
      assert.equal(blueprint.continuation.tool, "review_content_wizard_continue");
      assert.equal(blueprint.continuation.checkpoint, "persona_audit_started");

      // Read continuation context from state file
      const stateFileDir = path.join(tmpDir, "tmp");
      const statePath = path.join(stateFileDir, `${sessionId}_review_wizard.json`);
      assert.ok(fs.existsSync(statePath), `State file should exist at ${statePath} after ExecutionBlueprint dispatch`);
      const stateContent = fs.readFileSync(statePath, "utf-8");
      const state = JSON.parse(stateContent);
      assert.ok(state.activeContinuation, "Should have active continuation in state");
      const { continuationId } = state.activeContinuation;
      const { revision } = state;
      assert.ok(continuationId, "Should have continuationId");
      assert.ok(typeof revision === "number", "Should have revision number");

      // Step 4: Submit persona audit ExecutionReceipt via continue tool
      const mockReceipt = {
        protocol: "kevlar.blueprint/v1",
        contexts: [
          {
            id: "e2e_persona",
            status: "completed",
            output: {
              findings: [
                {
                  dimension: "content_quality",
                  level: "🟢",
                  reasoning: "内容质量合格，这是用于 E2E 测试的文本",
                },
              ],
            },
          },
        ],
        aggregation: {
          dimensions: [
            {
              dimension: "overall",
              level: "🟢",
              reasoning: "总体评审通过",
            },
          ],
          summary: "这是用于 E2E 测试的文本的整体评审：内容合格，无敏感风险。",
        },
      };

      const step5 = await client.callTool({
        name: "review_content_wizard_continue",
        arguments: {
          sessionId,
          checkpoint: "persona_audit_started",
          expectedRevision: revision,
          continuationId,
          receipt: mockReceipt,
        },
      });

      assert.ok(step5, "Step 5 response should exist");
      const step5Text = (step5.content as any)[0].text;
      assert.ok(step5Text.includes("E2E Tester"), "Final report should include persona name");
      assert.ok(step5Text.includes("舆论仿真推演报告"), "Final report should include report header");
      assert.ok(step5Text.includes("currentStep: waitingForNextRound"), "Wizard should show next round options");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("Pro tier: systemAudit → rstConfirmation → personaAudit ExecutionBlueprint (multi-turn)", async () => {
    // Enable Pro tier path
    process.env.KEVLAR_TIER = "pro";
    // Use local fallback to avoid needing strategyProvider for ExecutionBlueprint dispatch
    process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = "1";

    const server = await createKevlarServer();

    // Seed a system auditor persona (required for systemAudit flow)
    const auditorMeta: PersonaMeta = {
      id: "e2e_auditor",
      name: "合规审查员",
      name_en: "Compliance Auditor",
      version: "1.0.0",
      author: "kevlar-core",
      tags: ["system_auditor"],
      description: "E2E system auditor",
      blindSpot: "none",
    };
    await writePersonaFile(tmpDir, auditorMeta, "审查维度：内容合规\n性格特质：严谨\n盲区：无");
    const personaMeta: PersonaMeta = {
      id: "e2e_persona_pro",
      name: "E2E Pro Tester",
      name_en: "E2E Pro Tester",
      version: "1.0.0",
      author: "kevlar-core",
      tags: ["e2e"],
      description: "E2E Pro test persona",
      blindSpot: "none",
    };
    await writePersonaFile(tmpDir, personaMeta, "常用平台：通用\n性格特质：温和\n盲区：无");
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
      // Step 1: Start wizard → waitingForRegionSelection
      const step1 = await client.callTool({
        name: "review_content_wizard",
        arguments: { userMessage: "请评测这篇Pro tier内容：测试合规审核" },
      });
      const step1Text = (step1.content as any)[0].text;
      assert.ok(step1Text.includes("waitingForRegionSelection"));
      const sessionIdMatch = step1Text.match(/sessionId:\s*([a-z0-9-]+)/);
      assert.ok(sessionIdMatch, "Should include sessionId");
      const sessionId = sessionIdMatch[1];

      // Step 2: Select regions → systemAudit (Pro tier)
      // With local fallback → rstConfirmation
      const step2 = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: "中国" },
      });
      const step2Text = (step2.content as any)[0].text;
      assert.ok(step2Text.includes("六维风险检测已完成"), "Should show system audit results");
      assert.ok(step2Text.includes("是否继续进行舆论仿真推演"), "Should ask for rst confirmation");
      assert.ok(step2Text.includes("currentStep: rstConfirmation"), "Should be in rstConfirmation step");

      // Step 3: "继续" → checkPersonaInventory → waitingForReviewDecision
      const step3 = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: "继续" },
      });
      const step3Text = (step3.content as any)[0].text;
      assert.ok(step3Text.includes("请选择"), "Should ask for review action");
      assert.ok(step3Text.includes("舆论仿真推演"), "Should offer review option");
      assert.ok(step3Text.includes("waitingForReviewDecision"), "Should be in review decision step");

      // Step 4: "开始舆论仿真推演" → waitingForReviewerConfirmation (1 persona → auto-select)
      const step4 = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: "开始舆论仿真推演" },
      });
      const step4Text = (step4.content as any)[0].text;
      assert.ok(step4Text.includes("当前共有 1 位评审员"), "Should show persona count");
      assert.ok(step4Text.includes("waitingForReviewerConfirmation"), "Should be in reviewer confirmation");

      // Step 5: "开始舆论仿真推演" → ExecutionBlueprint dispatch (waitingForPersonaAudit)
      const step5 = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: "开始舆论仿真推演" },
      });
      const step5Text = (step5.content as any)[0].text;

      // Verify ExecutionBlueprint dispatch
      assert.ok(step5Text.includes("kevlar.blueprint/v1"), "Should contain ExecutionBlueprint protocol");
      assert.ok(step5Text.includes("isolated_contexts"), "Should use ephemeral agents mode");
      assert.ok(step5Text.includes("Persona Review — Subagent Dispatch Request"), "Should contain dispatch request");

      // Parse blueprint from ```json block
      const jsonStart = step5Text.indexOf("```json");
      const contentStart = jsonStart + 7;
      const jsonBlockEnd = step5Text.indexOf("\n```", contentStart);
      const jsonText = jsonBlockEnd >= 0 ? step5Text.substring(contentStart, jsonBlockEnd).trim() : step5Text;
      const blueprint = JSON.parse(jsonText);
      assert.equal(blueprint.protocol, "kevlar.blueprint/v1");
      assert.equal(blueprint.execution.isolation.level, "strict");
      assert.equal(blueprint.contexts.length, 1);
      assert.ok(blueprint.contexts[0].id === "e2e_persona_pro" || blueprint.contexts[0].id === "e2e_persona");

      // Read continuation context
      const stateFileDir = path.join(tmpDir, "tmp");
      const statePath = path.join(stateFileDir, `${sessionId}_review_wizard.json`);
      assert.ok(fs.existsSync(statePath), "State file should exist");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      const { continuationId } = state.activeContinuation;
      const { revision } = state;

      // Step 6: Submit persona audit receipt → completed
      const mockReceipt = {
        protocol: "kevlar.blueprint/v1",
        contexts: [{
          id: blueprint.contexts[0].id,
          status: "completed",
          output: {
            findings: [{
              dimension: "content_quality",
              level: "🟢",
              reasoning: "Pro tier内容：测试合规审核 — 内容质量合格",
            }],
          },
        }],
        aggregation: {
          dimensions: [{
            dimension: "overall",
            level: "🟢",
            reasoning: "总体评审通过",
          }],
          summary: "Pro tier E2E 测试内容的整体评审：合规，无风险。",
        },
      };

      const step6 = await client.callTool({
        name: "review_content_wizard_continue",
        arguments: {
          sessionId,
          checkpoint: "persona_audit_started",
          expectedRevision: revision,
          continuationId,
          receipt: mockReceipt,
        },
      });
      const step6Text = (step6.content as any)[0].text;
      assert.ok(step6Text.includes("舆论仿真推演报告"), "Final report should include header");
      assert.ok(step6Text.includes("currentStep: completed"), "Wizard should be marked as completed");
    } finally {
      await client.close();
      await server.close();
      delete process.env.KEVLAR_TIER;
      delete process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
    }
  });

  it("Pro tier: subagentAudit ExecutionBlueprint dispatch → receipt → rstConfirmation (multi-turn)", async () => {
    // Enable Pro tier — no local fallback so it enters host_orchestration + structured path
    process.env.KEVLAR_TIER = "pro";
    // Explicitly NOT setting KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK so it goes through
    // the ExecutionBlueprint dispatch → waitingForSubagentAudit path

    const server = await createKevlarServer();

    // Seed a system_auditor persona (required to trigger ExecutionBlueprint dispatch)
    const auditorMeta: PersonaMeta = {
      id: "e2e_subagent_auditor",
      name: "合规审查员",
      name_en: "Compliance Auditor",
      version: "1.0.0",
      author: "kevlar-core",
      tags: ["system_auditor"],
      description: "E2E subagent auditor",
      blindSpot: "none",
    };
    await writePersonaFile(tmpDir, auditorMeta, "审查维度：内容合规\n性格特质：严谨\n盲区：无");
    const personaMeta: PersonaMeta = {
      id: "e2e_persona_subagent",
      name: "E2E Subagent Tester",
      name_en: "E2E Subagent Tester",
      version: "1.0.0",
      author: "kevlar-core",
      tags: ["e2e"],
      description: "E2E subagent test persona",
      blindSpot: "none",
    };
    await writePersonaFile(tmpDir, personaMeta, "常用平台：通用\n性格特质：温和\n盲区：无");
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
      // Step 1: Start wizard → waitingForRegionSelection
      const step1 = await client.callTool({
        name: "review_content_wizard",
        arguments: { userMessage: "请评测这篇内容：测试 Subagent 并行审计流程" },
      });
      const step1Text = (step1.content as any)[0].text;
      assert.ok(step1Text.includes("waitingForRegionSelection"), "Step 1 should be waitingForRegionSelection");
      const sessionIdMatch = step1Text.match(/sessionId:\s*([a-z0-9-]+)/);
      assert.ok(sessionIdMatch, "Should include sessionId");
      const sessionId = sessionIdMatch[1];

      // Step 2: Select region → systemAudit → Step 0b web search prompt
      // (structured path now requires Step 0b BEFORE subagent dispatch)
      const step2 = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: "中国" },
      });
      const step2Text = (step2.content as any)[0].text;

      // Verify Step 0b guidance was emitted (not ExecutionBlueprint yet)
      assert.ok(step2Text.includes("Turn 1"), "Step 2 should emit Turn 1 Step 0 guidance");
      assert.ok(step2Text.includes("blackAtoms"), "Should ask for blackAtoms in Step 0 JSON");
      assert.ok(step2Text.includes("precedents"), "Should ask for precedents in Step 0 JSON");

      // Step 2b: Submit Step 0 JSON → ExecutionBlueprint dispatch (waitingForSubagentAudit)
      // handleOrchestrationStep0Result() forks into structured path when plan.strategy === "structured"
      const mockStep0Result = {
        blackAtoms: [{ phrase: "测试", reason: "可被恶意断章取义", targetDimension: "context_distortion" }],
        attackCandidates: [{ atom: "测试", chain: "原始表达 → 断章取义 → 评论区发酵 → 舆情危机", severity: "🟡" }],
        wildTranslations: [],
        precedents: [{ event: "2023年某品牌翻车事件", date: "2023-05" }],
      };
      const step2b = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: JSON.stringify(mockStep0Result) },
      });
      const step2bText = (step2b.content as any)[0].text;

      // Verify ExecutionBlueprint dispatch for subagent audit
      assert.ok(step2bText.includes("kevlar.blueprint/v1"), "Step 2b should contain ExecutionBlueprint protocol");
      assert.ok(step2bText.includes("isolated_contexts"), "Step 2b should use ephemeral agents mode");
      assert.ok(step2bText.includes("host_merge"), "Step 2b should use host_merge aggregation strategy");

      // Parse blueprint to verify structure (extract from code block)
      const jsonMatch = step2bText.match(/```json\n([\s\S]*?)\n```/);
      assert.ok(jsonMatch, "Should contain JSON code block in blueprint");
      const blueprint = JSON.parse(jsonMatch[1]);
      assert.equal(blueprint.protocol, "kevlar.blueprint/v1");
      assert.equal(blueprint.execution.mode, "isolated_contexts");
      assert.equal(blueprint.execution.isolation.level, "strict");
      assert.ok(blueprint.contexts.length >= 1, "Should have at least one auditor agent");
      assert.equal(blueprint.contexts[0].id, "e2e_subagent_auditor");
      assert.equal(blueprint.continuation.tool, "review_content_wizard_continue");
      assert.equal(blueprint.continuation.checkpoint, "preaudit_completed");

      // Read continuation context from state file - the wizard should have set
      // state.step = "waitingForSubagentAudit" and saved
      const stateFileDir = path.join(tmpDir, "tmp");
      const statePath = path.join(stateFileDir, `${sessionId}_review_wizard.json`);
      assert.ok(fs.existsSync(statePath), `State file should exist at ${statePath} after ExecutionBlueprint dispatch`);
      const stateContent = fs.readFileSync(statePath, "utf-8");
      const state = JSON.parse(stateContent);
      assert.equal(state.step, "waitingForSubagentAudit", "State should be waitingForSubagentAudit");
      assert.ok(state.activeContinuation, "Should have active continuation in state");
      assert.equal(state.activeContinuation.checkpoint, "preaudit_completed");
      const { continuationId } = state.activeContinuation;
      const { revision } = state;
      assert.ok(continuationId, "Should have continuationId");
      assert.ok(typeof revision === "number", "Should have revision number");

      // Step 3: Submit subagent audit ExecutionReceipt via continue tool
      // This should trigger handleContextAuditResult → rstConfirmation
      const auditorId = blueprint.contexts[0].id;
      const mockReceipt = {
        protocol: "kevlar.blueprint/v1",
        contexts: [
          {
            id: auditorId,
            status: "completed",
            output: {
              findings: [],
            },
          },
        ],
        aggregation: {
          dimensions: [
            {
              id: "legal_compliance",
              name: "合规审查",
              findings: [],
              level: "🟢",
              reasoning: "内容合规，未发现违规风险",
            },
          ],
          summary: "Subagent 并行审计完成：内容合规，无风险发现。",
        },
      };

      const step3 = await client.callTool({
        name: "review_content_wizard_continue",
        arguments: {
          sessionId,
          checkpoint: "preaudit_completed",
          expectedRevision: revision,
          continuationId,
          receipt: mockReceipt,
        },
      });

      assert.ok(step3, "Step 3 response should exist");
      const step3Text = (step3.content as any)[0].text;
      assert.ok(step3Text.includes("六维风险检测已完成"), "Should show pre-audit completion");
      assert.ok(step3Text.includes("Subagent 并行模式"), "Should indicate subagent parallel mode");
      assert.ok(step3Text.includes("是否继续进行舆论仿真推演"), "Should ask for rst continuation");
      assert.ok(step3Text.includes("currentStep: rstConfirmation"), "Should be in rstConfirmation step");

      // Verify state was updated correctly
      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      assert.equal(updatedState.step, "rstConfirmation");
      assert.ok(updatedState.preAuditReport, "Should have preAuditReport");
      assert.ok(Array.isArray(updatedState.preAuditReport.dimensions), "Should have dimensions array");
      assert.ok(typeof updatedState.preAuditReport.summary === "string", "Should have summary string");

      // Step 4: Continue past rstConfirmation → checkPersonaInventory → waitingForReviewDecision
      const step4 = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: "继续" },
      });
      const step4Text = (step4.content as any)[0].text;
      assert.ok(step4Text.includes("舆论仿真推演"), "Should offer review option");
      assert.ok(step4Text.includes("waitingForReviewDecision"), "Should be in review decision step");

      // Step 5: "开始舆论仿真推演" → waitingForReviewerConfirmation
      const step5 = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: "开始舆论仿真推演" },
      });
      const step5Text = (step5.content as any)[0].text;
      assert.ok(step5Text.includes("当前共有 1 位评审员"), "Should show persona count");
      assert.ok(step5Text.includes("waitingForReviewerConfirmation"), "Should be in reviewer confirmation");

      // Step 6: "开始舆论仿真推演" → ExecutionBlueprint dispatch (waitingForPersonaAudit)
      const step6 = await client.callTool({
        name: "review_content_wizard",
        arguments: { sessionId, userMessage: "开始舆论仿真推演" },
      });
      const step6Text = (step6.content as any)[0].text;
      assert.ok(step6Text.includes("kevlar.blueprint/v1"), "Should have ExecutionBlueprint for persona audit");
      assert.ok(step6Text.includes("Persona Review — Subagent Dispatch Request"), "Should contain dispatch request");

      // Extract JSON from ```json block
      const jsonStart = step6Text.indexOf("```json");
      const contentStart = jsonStart + 7;
      const jsonBlockEnd = step6Text.indexOf("\n```", contentStart);
      const jsonText = jsonBlockEnd >= 0 ? step6Text.substring(contentStart, jsonBlockEnd).trim() : step6Text;
      const personaBlueprint = JSON.parse(jsonText);
      assert.equal(personaBlueprint.continuation.checkpoint, "persona_audit_started");

      // Read updated state
      const state2 = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      const { continuationId: continuationId2 } = state2.activeContinuation;
      const { revision: revision2 } = state2;

      // Step 7: Submit persona audit receipt → completed
      const personaReceipt = {
        protocol: "kevlar.blueprint/v1",
        contexts: [
          {
            id: personaBlueprint.contexts[0].id,
            status: "completed",
            output: {
              findings: [
                {
                  dimension: "content_quality",
                  level: "🟢",
                  reasoning: "内容质量合格，测试通过",
                },
              ],
            },
          },
        ],
        aggregation: {
          dimensions: [
            {
              dimension: "overall",
              level: "🟢",
              reasoning: "总体评审通过",
            },
          ],
          summary: "Subagent E2E 测试内容的整体评审：合规，无风险。",
        },
      };

      const step7 = await client.callTool({
        name: "review_content_wizard_continue",
        arguments: {
          sessionId,
          checkpoint: "persona_audit_started",
          expectedRevision: revision2,
          continuationId: continuationId2,
          receipt: personaReceipt,
        },
      });
      const step7Text = (step7.content as any)[0].text;
      assert.ok(step7Text.includes("舆论仿真推演报告"), "Final report should include header");
      assert.ok(step7Text.includes("currentStep: completed"), "Wizard should be marked as completed");
      assert.ok(state2.preAuditReport, "Should retain preAuditReport through completion");
    } finally {
      await client.close();
      await server.close();
      delete process.env.KEVLAR_TIER;
    }
  });

  it("starts create_persona_wizard via MCP client", async () => {
    const server = await createKevlarServer();
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
