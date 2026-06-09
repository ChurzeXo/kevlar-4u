import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleReviewContentWizard } from "../tools/reviewContentWizardTool.js";
import { writePersonaFile, invalidatePersonasCache } from "../utils/parser.js";
import type { PersonaMeta } from "../utils/parser.js";

let skillsDir: string;
let tmpDir: string;
let previousApiKey: string | undefined;
let previousOpenAiKey: string | undefined;
let previousAnthropicKey: string | undefined;
let previousLocalFallback: string | undefined;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-review-wizard-"));
  tmpDir = path.join(skillsDir, "tmp");
  previousApiKey = process.env.KEVLAR_API_KEY;
  previousOpenAiKey = process.env.OPENAI_API_KEY;
  previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  previousLocalFallback = process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
  delete process.env.KEVLAR_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
  invalidatePersonasCache();
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  if (previousApiKey === undefined) delete process.env.KEVLAR_API_KEY;
  else process.env.KEVLAR_API_KEY = previousApiKey;
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  if (previousLocalFallback === undefined) delete process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
  else process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = previousLocalFallback;
  invalidatePersonasCache();
});

function textOf(result: Awaited<ReturnType<typeof handleReviewContentWizard>>): string {
  return result.content.map((c) => c.text).join("\n");
}

function extractSessionId(text: string): string {
  const match = text.match(/sessionId:\s*([a-z0-9-]+)/);
  assert.ok(match, `expected sessionId in response: ${text}`);
  return match[1];
}

async function writePersona(id: string, name: string, tags: string[]): Promise<void> {
  const meta: PersonaMeta = {
    id, name, name_en: "Test Persona", version: "1.0.0", author: "kevlar-core",
    tags, description: `${name} 的测试描述`,
  };
  await writePersonaFile(skillsDir, meta, "性格特质：直接。常用平台：小红书。盲区：无特定盲区。");
  invalidatePersonasCache();
}

function writePrdRules(): void {
  fs.writeFileSync(
    path.join(skillsDir, "rules_free.json"),
    JSON.stringify({
      version: "2.0.0",
      last_updated: "2026-05-28",
      core_rules: {
        association_patterns: [
          { pattern: "颜色+身体部位", risk_type: "涉黄风险" },
          { pattern: "食材+异常修饰", risk_type: "黑话暗语" },
          { pattern: "人名+负面标签", risk_type: "人身攻击" },
        ],
        evolution_strategies: ["缩写演化", "谐音演化", "拆字演化", "Emoji嵌入"],
        risk_roots: [
          { word: "木耳", variants_check: ["粉", "黑", "白", "红"] },
          { word: "菊花", variants_check: ["XX", "爆"] },
        ],
      },
    }),
    "utf-8"
  );
}

describe("handleReviewContentWizard state machine", () => {
  it("stores content and asks for persona creation when no personas exist without dumping dispatcher prompt", async () => {
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇小红书文案：今天分享一个新品故事。",
    });

    const text = textOf(result);
    assert.ok(text.includes("当前还没有可用评审员"));
    assert.ok(text.includes("currentStep: waitingForPersonaCreation"));
    assert.ok(text.includes("sessionId:"));
    assert.ok(!text.includes("=== SYSTEM_PROMPT 开始 ==="));
    assert.ok(!text.includes("你是一个内容评论调度引擎"));

    const sessionId = extractSessionId(text);
    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, `${sessionId}_review_wizard.json`), "utf-8")
    );
    assert.ok(state.content.includes("新品故事"));
  });

  it("with 1-2 personas: shows all, waits for reviewer confirmation, then executes review", async () => {
    await writePersona("visual_reader", "视觉读者", ["小红书", "视觉"]);
    await writePersona("logic_reader", "逻辑读者", ["知乎", "逻辑"]);

    // Step 1: submit content → waitingForReviewDecision (初审结果 + 询问是否复审)
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇内容：这是一篇新品发布文案。",
    });

    const startText = textOf(started);
    assert.ok(startText.includes("请选择下一步："));
    assert.ok(startText.includes("1. 进入「复审」"));
    assert.ok(startText.includes("currentStep: waitingForReviewDecision"));
    assert.ok(!startText.includes("这份内容准备投放在哪些平台"));
    assert.ok(!startText.includes("Kevlar-4u 宿主辅助评测任务"));

    // Step 2: confirm review → waitingForReviewerConfirmation (shows all personas)
    const sessionId = extractSessionId(startText);
    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始复审",
    });
    const confirmText = textOf(confirmed);
    assert.ok(confirmText.includes("当前共有 2 位评审员"));
    assert.ok(confirmText.includes("视觉读者"));
    assert.ok(confirmText.includes("逻辑读者"));
    assert.ok(confirmText.includes("请回复「开始复审」确认执行"));
    assert.ok(confirmText.includes("currentStep: waitingForReviewerConfirmation"));

    // Step 3: "开始复审" → executes review
    const reviewerDone = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始复审",
    });
    const reviewerText = textOf(reviewerDone);
    assert.ok(
      reviewerText.includes("currentStep: postReview") ||
      reviewerText.includes("评测完成") ||
      reviewerText.includes("评测执行失败")
    );
  });

  it("does not falsely match short persona names", async () => {
    // Create a persona with a very short name "好"
    await writePersona("good_reader", "好", ["小红书", "视觉"]);
    
    // Step 1: submit content → waitingForReviewDecision
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇内容：这是一篇新品发布文案。",
    });
    assert.ok(textOf(started).includes("currentStep: waitingForReviewDecision"));
    const sessionId = extractSessionId(textOf(started));
    
    // User message contains "好" but is not exactly "好" — should not trigger false affirmative
    const selection = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "这篇不好",
    });

    const text = textOf(selection);
    // Should NOT match "好" as affirmative — stay at waitingForReviewDecision
    assert.ok(!text.includes("已选择：好"));
    assert.ok(!text.includes("currentStep: waitingForReviewerConfirmation"));
    assert.ok(text.includes("currentStep: waitingForReviewDecision"));
  });

  it('with 3+ personas: recommends 1-3, shows remaining, waits for reviewer confirmation then executes review', async () => {
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);
    await writePersona("tech_guru", "科技极客", ["知乎", "科技"]);
    await writePersona("mom_user", "宝妈用户", ["抖音", "生活"]);
    await writePersona("student", "学生党", ["B站", "校园"]);

    // Step 1: submit content → waitingForReviewDecision
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇美食文案：这是一篇关于菌菇产品的介绍。",
    });
    const startText = textOf(started);
    assert.ok(startText.includes("currentStep: waitingForReviewDecision"));

    const sessionId = extractSessionId(startText);

    // Step 2: confirm review → waitingForReviewerConfirmation (AI recommends 1-3)
    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始复审",
    });
    const confirmText = textOf(confirmed);
    assert.ok(confirmText.includes("currentStep: waitingForReviewerConfirmation"));
    assert.ok(confirmText.includes("备选评审员"));
    assert.ok(
      confirmText.includes("美食达人") ||
      confirmText.includes("科技极客") ||
      confirmText.includes("宝妈用户") ||
      confirmText.includes("学生党")
    );

    // Step 3: "开始复审" → executes review
    const reviewerDone = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始复审",
    });
    const reviewerText = textOf(reviewerDone);
    assert.ok(
      reviewerText.includes("currentStep: postReview") ||
      reviewerText.includes("评测完成") ||
      reviewerText.includes("评测执行失败")
    );
  });

  it("renders clean system auditors as a deterministic pre-audit table", async () => {
    process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = "1";
    await writePersona("legal_compliance", "合规哨兵", ["system_auditor", "合规"]);
    await writePersona("context_distortion", "语境猎手", ["system_auditor", "语境"]);
    await writePersona("factual_integrity", "事实判官", ["system_auditor", "事实"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "请评测这篇内容：这是一篇新品发布文案。",
    });

    const text = textOf(started);
    assert.ok(text.includes("<!-- kevlar:verbatim-pre-audit:start -->"));
    assert.ok(text.includes("| 维度 | 等级 | 关键发现 |"));
    assert.ok(text.includes("| 合规哨兵 | 🟢 | 无 |"));
    assert.ok(text.includes("| 语境猎手 | 🟢 | 无 |"));
    assert.ok(text.includes("| 事实判官 | 🟢 | 无 |"));
    assert.ok(!text.includes("审 查 维 度"));
  });

  it("runs local DAO pre-audit even when no system auditors exist", async () => {
    writePrdRules();

    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "盒马菌菇星球，贵妇粉耳，颜值粉嫩，耳片肥厚，质地柔软，鲜香清脆",
    });

    const text = textOf(started);
    assert.ok(text.includes("综合风险等级：🔴 红色高危"));
    assert.ok(text.includes("本地规则引擎"));
    assert.ok(text.includes("| 本地规则引擎 | 🔴"));
    assert.ok(text.includes("<!-- kevlar:verbatim-pre-audit:start -->"));

    const sessionId = extractSessionId(text);
    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, `${sessionId}_review_wizard.json`), "utf-8")
    );
    const localRuleAudit = state.preAuditReport.dimensions.find((d: any) => d.id === "local_rule_engine");
    assert.ok(localRuleAudit);
    assert.ok(localRuleAudit.findings.length > 0);
    const finding = localRuleAudit.findings.find((f: any) => f.keyword === "粉耳");
    assert.ok(finding);
    assert.ok(finding.riskDescription.includes("木耳"));
  });

  it("adds local DAO findings to rule fallback findings with detailed fields", async () => {
    process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = "1";
    writePrdRules();
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "盒马菌菇星球，贵妇粉耳，颜值粉嫩，耳片肥厚，质地柔软，鲜香清脆",
    });

    const text = textOf(started);
    assert.ok(text.includes("综合风险等级：🔴 红色高危"));
    assert.ok(text.includes("暗语破译"));
    assert.ok(text.includes("| 暗语破译 | 🔴"));

    const sessionId = extractSessionId(text);
    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, `${sessionId}_review_wizard.json`), "utf-8")
    );
    const networkAudit = state.preAuditReport.dimensions.find((d: any) => d.id === "network_culture_risk");
    assert.ok(networkAudit);
    const finding = networkAudit.findings.find((f: any) => f.keyword === "粉耳");
    assert.equal(finding.trigger, "本地规则命中：粉耳 -> 木耳");
    assert.ok(finding.riskDescription.includes("贵妇"));
    assert.equal(finding.suggestedLevel, "🔴");
  });


  it("uses host orchestration prompt when system auditors exist but no LLM caller is available", async () => {
    writePrdRules();
    await writePersona("legal_compliance", "合规哨兵", ["system_auditor", "合规"]);
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    // Turn 1: first call → returns waitingForOrchestrationStep0 with Step 0 prompt
    const started = await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "盒马菌菇星球，贵妇粉耳，颜值粉嫩",
    });

    const text = textOf(started);
    assert.ok(text.includes("[SYSTEM PROTOCOL] 职业黑粉逆向解码协议"));
    assert.ok(text.includes("待测文案"));
    assert.ok(text.includes("currentStep: waitingForOrchestrationStep0"));

    // Turn 1 submit: host AI returns Step 0 JSON → system runs web search → returns waitingForOrchestrationAudit
    const sessionId = extractSessionId(text);
    const afterStep0 = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        blackAtoms: ["粉耳", "贵妇", "颜值粉嫩"],
        attackCandidates: [
          { keyword: "粉耳", attackChain: "粉耳 → 去语境化 → 低俗联想 → 舆情发酵" },
        ],
      }),
    });

    const afterStep0Text = textOf(afterStep0);
    assert.ok(afterStep0Text.includes("[SYSTEM PROTOCOL] 防御性风险矩阵扫描协议"));
    assert.ok(afterStep0Text.includes("currentStep: waitingForOrchestrationAudit"));

    // Turn 2 submit: host AI returns audit dimensions JSON → proceeds to waitingForOrchestrationFinal
    const turn2Response = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        dimensions: [
          { id: "legal_compliance", name: "合规哨兵", findings: [], level: "🟢" },
          {
            id: "network_culture_risk",
            name: "暗语破译",
            findings: [{ keyword: "粉耳", trigger: "宿主编排确认", riskDescription: "存在黑话误读", propagationRisk: "评论区联想", suggestedLevel: "🟡" }],
            level: "🟡",
          },
        ],
        deltaRisks: { bareOnly: [], fullOnly: [], stable: [] },
      }),
    });

    const turn2Text = textOf(turn2Response);
    assert.ok(turn2Text.includes("currentStep: waitingForOrchestrationFinal"));
    assert.ok(turn2Text.includes("交叉验证与最终仲裁"));

    // Turn 3 submit: host AI returns final report JSON → proceeds to inventory check → waitingForReviewDecision
    const parsed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        dimensions: [
          { id: "legal_compliance", name: "合规哨兵", findings: [], level: "🟢" },
          {
            id: "network_culture_risk",
            name: "暗语破译",
            findings: [{ keyword: "粉耳", trigger: "宿主编排确认", riskDescription: "存在黑话误读", propagationRisk: "评论区联想", suggestedLevel: "🟡" }],
            level: "🟡",
          },
        ],
        summary: "宿主编排初审完成",
      }),
    });

    // Orchestration audit result is parsed → goes to inventory check → waitingForReviewDecision
    const parsedText = textOf(parsed);
    assert.ok(parsedText.includes("currentStep: waitingForReviewDecision"));
    assert.ok(parsedText.includes("宿主编排初审完成"));

    // Step: confirm review → proceeds to reviewer confirmation
    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始复审",
    });
    const confirmText = textOf(confirmed);
    assert.ok(confirmText.includes("currentStep: waitingForReviewerConfirmation"));
  });


  it("uses orchestration-style isolated matrix prompts for sampling system auditors", async () => {
    writePrdRules();
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const calls: Array<{ systemPrompt: string; messages: Array<{ role: "user" | "assistant"; content: string }> }> = [];
    const samplingFn = async (params: {
      systemPrompt: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      maxTokens?: number;
    }) => {
      calls.push({ systemPrompt: params.systemPrompt, messages: params.messages });
      return { content: JSON.stringify({ findings: [] }), stopReason: "endTurn" };
    };

    await handleReviewContentWizard(skillsDir, tmpDir, {
      userMessage: "盒马菌菇星球，贵妇粉耳，颜值粉嫩，耳片肥厚，质地柔软，鲜香清脆",
      samplingFn,
    });

    assert.ok(calls.length >= 1);
    // First call is the isolated global Step 0 decoding call
    assert.ok(calls[0].systemPrompt.includes("[SYSTEM PROTOCOL] 职业黑粉逆向解码协议"));
    assert.ok(calls[0].messages[0].content.includes("全局解码"));
    // Sandbox calls follow (index >= 1): verify correct protocol headers
    const sandboxCall = calls.find((c) => c.systemPrompt.includes("[SYSTEM PROTOCOL] 防御性风险矩阵扫描协议"));
    assert.ok(sandboxCall, "Expected a sandbox audit call");
    assert.ok(sandboxCall!.systemPrompt.includes("真实隔离 LLM 沙盒"));
    assert.ok(sandboxCall!.systemPrompt.includes("严格遵守审查边界"));
    // Sandbox message should have local rule findings injected
    assert.ok(sandboxCall!.messages[0].content.includes("本地规则引擎预警"));
    assert.ok(sandboxCall!.messages[0].content.includes("粉耳 -> 木耳"));
  });
});
