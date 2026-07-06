import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleReviewContentWizard } from "../tools/reviewContentWizardTool.js";
import { writePersonaFile, invalidatePersonasCache } from "../utils/parser.js";
import type { ToolResult } from "../utils/types.js";
import type { PersonaMeta } from "../utils/parser.js";

let skillsDir: string;
let tmpDir: string;
let previousApiKey: string | undefined;
let previousOpenAiKey: string | undefined;
let previousAnthropicKey: string | undefined;
let previousLocalFallback: string | undefined;
let previousTier: string | undefined;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-review-wizard-"));
  tmpDir = path.join(skillsDir, "tmp");
  previousApiKey = process.env.KEVLAR_API_KEY;
  previousOpenAiKey = process.env.OPENAI_API_KEY;
  previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  previousLocalFallback = process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
  previousTier = process.env.KEVLAR_TIER;
  delete process.env.KEVLAR_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK;
  delete process.env.KEVLAR_TIER;
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
  if (previousTier === undefined) delete process.env.KEVLAR_TIER;
  else process.env.KEVLAR_TIER = previousTier;
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

/**
 * Extract just the ExecutionBlueprint JSON from a wizard response that includes
 * a kevlar-state block or markdown json code block.
 */
function extractExecutionBlueprintJson(text: string): string {
  // New format: text inside ```json ... ``` block
  const jsonBlockStart = text.indexOf("```json");
  if (jsonBlockStart >= 0) {
    const contentStart = jsonBlockStart + 7;
    const jsonBlockEnd = text.indexOf("\n```", contentStart);
    if (jsonBlockEnd >= 0) {
      return text.substring(contentStart, jsonBlockEnd).trim();
    }
  }
  // Legacy format fallback: text before ```kevlar-state
  const idx = text.indexOf("```kevlar-state");
  return idx >= 0 ? text.substring(0, idx).trim() : text.trim();
}

async function writePersona(id: string, name: string, tags: string[]): Promise<void> {
  const meta: PersonaMeta = {
    id, name, name_en: "Test Persona", version: "1.0.0", author: "kevlar-core",
    tags, description: `${name} 的测试描述`,
  };
  await writePersonaFile(skillsDir, meta, "性格特质：直接。常用平台：小红书。盲区：无特定盲区。");
  invalidatePersonasCache();
}

/** Start wizard and reply with "全球" to skip region selection step. */
async function startWizardWithRegion(userMessage: string, region = "全球"): Promise<ToolResult> {
  const r1 = await handleReviewContentWizard(skillsDir, tmpDir, { userMessage });
  const sid = extractSessionId(textOf(r1));
  return handleReviewContentWizard(skillsDir, tmpDir, { sessionId: sid, userMessage: region });
}

function writePrdRules(): void {
  // Write mock strategy bundle with rules (simulating what --sync downloads)
  const bundle = JSON.stringify({
    rules: {
      categories: {
        core: {
          associative_map: [
            {
              root: "木耳",
              variants: ["粉木耳", "黑木耳", "白木耳", "红木耳", "粉耳"],
              misinterpret_direction: "涉黄风险 — 颜色+身体部位联想",
              severity: "HIGH",
              base_score: 0.85,
            },
            {
              root: "菊花",
              variants: ["XX菊花", "爆菊花"],
              misinterpret_direction: "黑话暗语",
              severity: "HIGH",
              base_score: 0.85,
            },
          ],
        },
      },
      semantic_primes: {},
      structural_patterns: [],
    },
  });
  fs.writeFileSync(
    path.join(skillsDir, "strategy-bundle-cache.enc"),
    // Write raw JSON — deobfuscate will fail on raw JSON, so we need to
    // make RuleRepository.loadStrategyBundle accept unencrypted bundles too.
    // For now, the test runs in Free mode so the bundle isn't loaded anyway.
    bundle,
    "utf-8"
  );
}

describe("handleReviewContentWizard state machine", () => {
  it("stores content and asks for persona creation when no personas exist without dumping dispatcher prompt", async () => {
    const result = await startWizardWithRegion("请评测这篇小红书文案：今天分享一个新品故事。");
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

    // Step 1: submit content → waitingForReviewDecision (结果 + 询问下一步)
    const started = await startWizardWithRegion("请评测这篇内容：这是一篇新品发布文案。");
const startText = textOf(started);
    assert.ok(startText.includes("请选择"));
    assert.ok(startText.includes("1. 舆论仿真推演"));
    assert.ok(startText.includes("currentStep: waitingForReviewDecision"));
    assert.ok(!startText.includes("这份内容准备投放在哪些平台"));
    assert.ok(!startText.includes("Kevlar-4u 宿主辅助评测任务"));

    // Step 2: confirm review → waitingForReviewerConfirmation (shows all personas)
    const sessionId = extractSessionId(startText);
    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    const confirmText = textOf(confirmed);
    assert.ok(confirmText.includes("当前共有 2 位评审员"));
    assert.ok(confirmText.includes("视觉读者"));
    assert.ok(confirmText.includes("逻辑读者"));
    assert.ok(confirmText.includes("请回复「开始舆论仿真推演」确认执行"));
    assert.ok(confirmText.includes("currentStep: waitingForReviewerConfirmation"));

    // Step 3: "开始舆论仿真推演" → dispatches ExecutionBlueprint for parallel persona review
    const reviewerDone = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    const reviewerText = textOf(reviewerDone);
    // Review execution dispatches an ExecutionBlueprint with wrapper instructions
    assert.ok(reviewerText.includes("Persona Review — Subagent Dispatch Request"));
    assert.ok(reviewerText.includes("kevlar.blueprint/v1"));
    assert.ok(reviewerText.includes("persona_reviewer"));
    assert.ok(reviewerText.includes("review_content_wizard_continue"));
  });

  it("does not falsely match short persona names", async () => {
    // Create a persona with a very short name "好"
    await writePersona("good_reader", "好", ["小红书", "视觉"]);
    
    // Step 1: submit content → waitingForReviewDecision
    const started = await startWizardWithRegion("请评测这篇内容：这是一篇新品发布文案。");
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
    const started = await startWizardWithRegion("请评测这篇美食文案：这是一篇关于菌菇产品的介绍。");
const startText = textOf(started);
    assert.ok(startText.includes("currentStep: waitingForReviewDecision"));

    const sessionId = extractSessionId(startText);

    // Step 2: confirm review → waitingForReviewerConfirmation (AI recommends 1-3)
    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
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

    // Step 3: "开始舆论仿真推演" → dispatches ExecutionBlueprint for parallel persona review
    const reviewerDone = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    const reviewerText = textOf(reviewerDone);
    // Review execution dispatches an ExecutionBlueprint with wrapper instructions
    assert.ok(reviewerText.includes("Persona Review — Subagent Dispatch Request"));
    assert.ok(reviewerText.includes("kevlar.blueprint/v1"));
    assert.ok(reviewerText.includes("persona_reviewer"));
    assert.ok(reviewerText.includes("review_content_wizard_continue"));
  });

  it.skip("renders clean system auditors as a deterministic pre-audit table", async () => {
    process.env.KEVLAR_TIER = "pro";
    process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = "1";
    process.env.KEVLAR_TIER = "pro";
    await writePersona("legal_compliance", "合规哨兵", ["system_auditor", "合规"]);
    await writePersona("context_distortion", "语境猎手", ["system_auditor", "语境"]);
    await writePersona("factual_integrity", "事实判官", ["system_auditor", "事实"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("请评测这篇内容：这是一篇新品发布文案。");
    const text = textOf(started);
    assert.ok(text.includes("<!-- kevlar:verbatim-pre-audit:start -->"));
    assert.ok(text.includes("| 维度 | 等级 | 关键发现 |"));
    assert.ok(text.includes("| 合规哨兵 | 🟢 | 无 |"));
    assert.ok(text.includes("| 语境猎手 | 🟢 | 无 |"));
    assert.ok(text.includes("| 事实判官 | 🟢 | 无 |"));
    assert.ok(!text.includes("审 查 维 度"));
    delete process.env.KEVLAR_TIER;
  });

  it("runs local DAO pre-audit even when no system auditors exist", async () => {
    process.env.KEVLAR_TIER = "pro";
    writePrdRules();

    const started = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳，颜值粉嫩，耳片肥厚，质地柔软，鲜香清脆");
    const text = textOf(started);
    assert.ok(text.includes("# 🔴 红色高危"));
    assert.ok(text.includes("规则引擎"));
    assert.ok(text.includes("| 规则引擎 | 🔴"));
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

  it.skip("adds local DAO findings to rule fallback findings with detailed fields", async () => {
    process.env.KEVLAR_TIER = "pro";
    process.env.KEVLAR_SYSTEM_AUDIT_LOCAL_FALLBACK = "1";
    writePrdRules();
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳，颜值粉嫩，耳片肥厚，质地柔软，鲜香清脆");
const text = textOf(started);
    assert.ok(text.includes("# 🔴 红色高危"));
    assert.ok(text.includes("暗语破译"));
    assert.ok(text.includes("| 暗语破译 | 🔴"));

    const sessionId = extractSessionId(text);
    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, `${sessionId}_review_wizard.json`), "utf-8")
    );
    const networkAudit = state.preAuditReport.dimensions.find((d: any) => d.id === "network_culture_risk");
    assert.ok(networkAudit);
    const finding = networkAudit.findings.find((f: any) => f.keyword === "粉耳");
    assert.equal(finding.trigger, "规则命中：粉耳 -> 木耳");
    assert.ok(finding.riskDescription.includes("贵妇"));
    assert.equal(finding.suggestedLevel, "🔴");
  });


  it.skip("uses host orchestration prompt when system auditors exist but no LLM caller is available", async () => {
    process.env.KEVLAR_TIER = "pro";
    writePrdRules();
    await writePersona("legal_compliance", "合规哨兵", ["system_auditor", "合规"]);
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    // Turn 1: first call → returns waitingForOrchestrationStep0 with Step 0 prompt
    const started = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳，颜值粉嫩");
const text = textOf(started);
    assert.ok(text.includes("[SYSTEM PROTOCOL] 职业黑粉逆向解码协议"));
    assert.ok(text.includes("待测文案"));
    assert.ok(text.includes("currentStep: waitingForOrchestrationStep0"));

    // Turn 1 submit: host AI returns Step 0 JSON + webContextMap → returns waitingForOrchestrationAudit
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
        summary: "宿主编排六维风险检测完成",
      }),
    });

    // Orchestration audit result is parsed → goes to inventory check → waitingForReviewDecision
    const parsedText = textOf(parsed);
    assert.ok(parsedText.includes("currentStep: waitingForReviewDecision"));
    assert.ok(parsedText.includes("宿主编排六维风险检测完成"));

    // Step: confirm review → proceeds to reviewer confirmation
    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    const confirmText = textOf(confirmed);
    assert.ok(confirmText.includes("currentStep: waitingForReviewerConfirmation"));
  });


  it.skip("emits orchestration Turn 1 prompt (no direct LLM calls) for sampling system auditors", async () => {
    process.env.KEVLAR_TIER = "pro";
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

    const result = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳，颜值粉嫩，耳片肥厚，质地柔软，鲜香清脆");
    // No LLM calls are made by handleSystemAudit — it returns orchestration Turn 1 prompt
    assert.equal(calls.length, 0);
    const responseText = result.content[0]?.text || "";
    // Should contain Step 0 instructions + web search + precedents requirements
    assert.ok(responseText.includes("职业黑粉逆向解码"));
    assert.ok(responseText.includes("类似事件先例检索"));
    // State should be waitingForOrchestrationStep0
    assert.ok(responseText.includes("waitingForOrchestrationStep0"));
  });

  it.skip("parses webContextMap from host AI and injects into Turn 2 prompt", async () => {
    process.env.KEVLAR_TIER = "pro";
    writePrdRules();
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳");
const sessionId = extractSessionId(textOf(started));

    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        blackAtoms: ["粉耳", "贵妇"],
        attackCandidates: [{ keyword: "粉耳", attackChain: "粉耳 → 去语境化 → 低俗联想" }],
        webContextMap: {
          "粉耳": "- 百度贴吧: 木耳黑话\n- 知乎: 菌菇的别称",
          "贵妇": "- 小红书: 高端用户群体",
        },
        precedents: [{ event: "某品牌低俗广告翻车事件", date: "2024-03" }],
      }),
    });
    const resultText = textOf(result);
    assert.ok(resultText.includes("联网验证上下文（Turn 1 已完成）"));
    assert.ok(resultText.includes("关键词「粉耳」"));
    assert.ok(resultText.includes("木耳黑话"));
    assert.ok(resultText.includes("关键词「贵妇」"));
    assert.ok(resultText.includes("高端用户群体"));
  });

  it.skip("defaults webContextMap to empty when host AI omits it", async () => {
    process.env.KEVLAR_TIER = "pro";
    writePrdRules();
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳");
const sessionId = extractSessionId(textOf(started));

    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        blackAtoms: ["粉耳"],
        attackCandidates: [{ keyword: "粉耳", attackChain: "test" }],
      }),
    });
    const resultText = textOf(result);
    assert.ok(resultText.includes("（无联网验证结果）"));
  });

  it.skip("filters non-string values from webContextMap", async () => {
    process.env.KEVLAR_TIER = "pro";
    writePrdRules();
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳");
const sessionId = extractSessionId(textOf(started));

    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        blackAtoms: ["粉耳", "菌菇"],
        attackCandidates: [{ keyword: "粉耳", attackChain: "test" }],
        webContextMap: {
          "粉耳": "- 正常的搜索结果",
          "菌菇": { "title": "对象值应被过滤" },
          "数字": 12345,
        },
        precedents: [{ event: "某品牌低俗广告翻车事件", date: "2024-03" }],
      }),
    });
    const resultText = textOf(result);
    // Valid string value should survive
    assert.ok(resultText.includes("关键词「粉耳」"));
    assert.ok(resultText.includes("正常的搜索结果"));
    // Non-string values should be filtered out — their keys should not appear
    assert.ok(!resultText.includes("关键词「菌菇」"));
    assert.ok(!resultText.includes("关键词「数字」"));
    assert.ok(!resultText.includes("对象值应被过滤"));
    assert.ok(!resultText.includes("12345"));
  });

  it.skip("handles null webContextMap gracefully", async () => {
    process.env.KEVLAR_TIER = "pro";
    writePrdRules();
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳");
const sessionId = extractSessionId(textOf(started));

    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        blackAtoms: ["粉耳"],
        attackCandidates: [{ keyword: "粉耳", attackChain: "test" }],
        webContextMap: null,
      }),
    });
    const resultText = textOf(result);
    assert.ok(resultText.includes("（无联网验证结果）"));
  });

  it.skip("handles array webContextMap gracefully", async () => {
    process.env.KEVLAR_TIER = "pro";
    writePrdRules();
    await writePersona("network_culture_risk", "暗语破译", ["system_auditor", "网络文化"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("盒马菌菇星球，贵妇粉耳");
const sessionId = extractSessionId(textOf(started));

    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        blackAtoms: ["粉耳"],
        attackCandidates: [{ keyword: "粉耳", attackChain: "test" }],
        webContextMap: ["粉耳", "木耳"],
      }),
    });
    const resultText = textOf(result);
    assert.ok(resultText.includes("（无联网验证结果）"));
  });
});

// ── ExecutionBlueprint Structure Validation ─────────────────────────────────────

describe("ExecutionBlueprint structure validation", () => {
  it("generates valid kevlar.blueprint/v1 blueprint with strict isolation for persona review", async () => {
    await writePersona("visual_reader", "视觉读者", ["小红书", "视觉"]);
    await writePersona("logic_reader", "逻辑读者", ["知乎", "逻辑"]);

    // Walk wizard to persona review stage
    const started = await startWizardWithRegion("请评测这篇内容：这是一篇新品发布文案。");
    const sessionId = extractSessionId(textOf(started));

    // Confirm review → waitingForReviewerConfirmation
    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    assert.ok(textOf(confirmed).includes("currentStep: waitingForReviewerConfirmation"));

    // Execute review → dispatches ExecutionBlueprint with wrapper instructions
    const dispatch = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    const dispatchText = textOf(dispatch);
    assert.ok(dispatchText.includes("Persona Review — Subagent Dispatch Request"));

    // Parse the ExecutionBlueprint JSON from response
    const blueprint = JSON.parse(extractExecutionBlueprintJson(dispatchText));

    // ── Top-level structure ──────────────────────────────────────────
    assert.equal(blueprint.protocol, "kevlar.blueprint/v1");
    assert.equal(blueprint.execution.mode, "isolated_contexts");
    assert.ok(blueprint.execution.allowedModes.includes("native_subagent"));
    assert.ok(blueprint.execution.allowedModes.includes("simulated_agent"));

    // ── Isolation: must be strict ────────────────────────────────────
    assert.equal(blueprint.execution.isolation.required, true);
    assert.equal(blueprint.execution.isolation.level, "strict");

    // ── Concurrency: matches persona count ───────────────────────────
    assert.equal(blueprint.execution.concurrency, 2);

    // ── Agents: each has persona_reviewer role ────────────────────────
    assert.ok(Array.isArray(blueprint.contexts));
    assert.equal(blueprint.contexts.length, 2);

    const contextIds = new Set(blueprint.contexts.map((a: any) => a.id));
    assert.ok(contextIds.has("visual_reader"));
    assert.ok(contextIds.has("logic_reader"));

    for (const agent of blueprint.contexts) {
      assert.equal(agent.role, "persona_reviewer");
      assert.equal(agent.outputSchema, "kevlar.reviewer/v1");
      // instructions must be self-contained (not just an empty string)
      assert.ok(typeof agent.instructions === "string" && agent.instructions.length > 0);
      assert.ok(agent.instructions.includes(agent.id === "visual_reader" ? "视觉读者" : "逻辑读者"));
      // Must contain the content being reviewed
      assert.ok(agent.instructions.includes("新品发布文案"));
    }

    // ── Aggregation rules ────────────────────────────────────────────
    assert.equal(blueprint.aggregation.strategy, "host_merge");
    assert.equal(blueprint.aggregation.rules.requireAllContexts, true);
    assert.equal(blueprint.aggregation.rules.conflictResolution, "host_decide");
    assert.equal(blueprint.aggregation.rules.outputSchema, "kevlar.audit/v1");

    // ── Continuation contract ────────────────────────────────────────
    assert.equal(blueprint.continuation.tool, "review_content_wizard_continue");
    assert.equal(blueprint.continuation.sessionId, sessionId);
    assert.equal(blueprint.continuation.checkpoint, "persona_audit_started");
    assert.ok(typeof blueprint.continuation.expectedRevision === "number");
    assert.ok(typeof blueprint.continuation.idempotencyKey === "string");
    assert.ok(blueprint.continuation.idempotencyKey.includes(sessionId));
  });

  it("persona ExecutionBlueprint instructions include defensive dimension context", async () => {
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("请评测这篇内容：这是一篇新品发布文案，产品有潜在的过度宣传风险。");
    const sessionId = extractSessionId(textOf(started));

    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    assert.ok(textOf(confirmed).includes("currentStep: waitingForReviewerConfirmation"));

    const dispatch = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    const blueprint = JSON.parse(extractExecutionBlueprintJson(textOf(dispatch)));

    const instructions = blueprint.contexts[0].instructions;
    assert.ok(typeof instructions === "string" && instructions.length > 0);

    // Must contain the 6 defensive dimensions for the persona to evaluate against
    assert.ok(instructions.includes("传播舆情风险") || instructions.includes("defensiveDimension") ||
      instructions.includes("context_distortion") || instructions.includes("social_risk"),
      `Persona instructions should reference defensive dimensions for evaluation, got: ${instructions.substring(0, 200)}`);
  });

  it("Free tier does NOT generate system audit ExecutionBlueprint", async () => {
    // System auditors exist but Free tier should skip system audit entirely
    await writePersona("legal_compliance", "合规哨兵", ["system_auditor", "合规"]);
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("请评测这篇内容：测试文案。");
    const startText = textOf(started);

    // Free tier should go to persona inventory, NOT system audit
    assert.ok(!startText.includes("waitingForSubagentAudit"));
    assert.ok(!startText.includes("kevlar.blueprint/v1"));
    // Should go to either persona check or review decision
    assert.ok(
      startText.includes("waitingForReviewDecision") ||
      startText.includes("checkPersonaInventory") ||
      startText.includes("waitingForPersonaCreation"),
      `Expected persona inventory step, got step in: ${startText.substring(0, 300)}`
    );
  });

  it("single persona: ExecutionBlueprint concurrency is 1, isolation.strict maintained", async () => {
    await writePersona("solo_reviewer", "单人评审", ["知乎", "逻辑"]);

    const started = await startWizardWithRegion("请评测这篇内容：测试文案。");
    const sessionId = extractSessionId(textOf(started));

    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    assert.ok(textOf(confirmed).includes("currentStep: waitingForReviewerConfirmation"));

    const dispatch = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: "开始舆论仿真推演",
    });
    const blueprint = JSON.parse(extractExecutionBlueprintJson(textOf(dispatch)));

    assert.equal(blueprint.execution.concurrency, 1);
    assert.equal(blueprint.contexts.length, 1);
    assert.equal(blueprint.execution.isolation.level, "strict");
    assert.equal(blueprint.contexts[0].role, "persona_reviewer");
  });

  // ── Phase 5: Receipt Error Handling Tests ─────────────────────────────────

  it("rejects empty receipt with clear error message", async () => {
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("测试内容");
    const sessionId = extractSessionId(textOf(started));

    // Progress through the wizard to persona audit state
    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "开始舆论仿真推演",
    });
    assert.ok(textOf(confirmed).includes("waitingForReviewerConfirmation"));

    // Step to persona audit ExecutionBlueprint dispatch
    await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "开始舆论仿真推演",
    });

    // Submit empty receipt via continue tool (empty string rejected, use single char)
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: " ",
    });

    // Should get a clear JSON parse error, not a crash
    const resultText = textOf(result);
    assert.ok(
      resultText.includes("无法解析") || resultText.includes("不是有效的 JSON"),
      `Expected parse error message, got: ${resultText.substring(0, 300)}`
    );
  });

  it("rejects malformed non-JSON receipt gracefully", async () => {
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("测试内容");
    const sessionId = extractSessionId(textOf(started));

    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "开始舆论仿真推演",
    });
    assert.ok(textOf(confirmed).includes("waitingForReviewerConfirmation"));

    await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "开始舆论仿真推演",
    });

    // Submit plainly invalid text (not JSON at all)
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "this is not json at all {{}",
    });

    const resultText = textOf(result);
    assert.ok(
      resultText.includes("无法解析") || resultText.includes("不是有效的 JSON"),
      `Expected parse error for non-JSON, got: ${resultText.substring(0, 300)}`
    );
  });

  it("rejects receipt with missing agents array", async () => {
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("测试内容");
    const sessionId = extractSessionId(textOf(started));

    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "开始舆论仿真推演",
    });
    assert.ok(textOf(confirmed).includes("waitingForReviewerConfirmation"));

    await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "开始舆论仿真推演",
    });

    // Valid JSON but missing the required "contexts" field
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        protocol: "kevlar.blueprint/v1",
        aggregation: { dimensions: [], summary: "no agents" },
      }),
    });

    const resultText = textOf(result);
    assert.ok(
      resultText.includes("格式错误") || resultText.includes('"contexts"'),
      `Expected missing agents error, got: ${resultText.substring(0, 300)}`
    );
  });

  it("rejects receipt with invalid agent fields", async () => {
    await writePersona("foodie", "美食达人", ["小红书", "美食"]);

    const started = await startWizardWithRegion("测试内容");
    const sessionId = extractSessionId(textOf(started));

    const confirmed = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "开始舆论仿真推演",
    });
    assert.ok(textOf(confirmed).includes("waitingForReviewerConfirmation"));

    await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId, userMessage: "开始舆论仿真推演",
    });

    // Agents present but missing required fields (id, output)
    const result = await handleReviewContentWizard(skillsDir, tmpDir, {
      sessionId,
      userMessage: JSON.stringify({
        protocol: "kevlar.blueprint/v1",
        contexts: [{}],
        aggregation: { dimensions: [], summary: "bad agent" },
      }),
    });

    const resultText = textOf(result);
    assert.ok(
      resultText.includes("格式错误") || resultText.includes('"id"') || resultText.includes('"output"'),
      `Expected invalid agent fields error, got: ${resultText.substring(0, 300)}`
    );
  });
});
