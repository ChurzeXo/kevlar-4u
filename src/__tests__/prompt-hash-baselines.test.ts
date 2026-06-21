import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type Persona } from "../utils/parser.js";
import {
  buildPreAuditFinalizerPrompt,
  buildIsolatedSystemAuditorPrompt,
  buildIsolatedSystemAuditorMessage,
  buildOrchestrationFinalizerPrompt,
  type Step0Result,
} from "../prompts/reviewWizard.js";
import { loadPromptSegments } from "../subscription/promptTemplates.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function makePersona(id: string, name: string, desc: string, systemPrompt: string): Persona {
  return {
    meta: { id, name, name_en: name, version: "1.0", author: "test", tags: ["system_auditor"], description: desc },
    systemPrompt,
    filePath: "/tmp/test.json",
  };
}

const SAMPLE_CONTENT = "这是一条测试内容，包含一些需要被审查的表述。";

const SAMPLE_AUDITORS: Persona[] = [
  makePersona("legal_compliance", "合规哨兵", "合规审查", "你是一名合规审查员。"),
  makePersona("social_risk", "社伦判官", "社会风险审查", "你是一名社会风险审查员。"),
  makePersona("context_distortion", "语境猎手", "语境脱嵌审查", "你是一名语境猎手。"),
  makePersona("network_culture_risk", "暗语破译", "网络文化审查", "你是一名暗语破译。"),
  makePersona("factual_integrity", "事实判官", "事实审查", "你是一名事实判官。"),
  makePersona("cross_lingual_distortion", "跨界判官", "跨语言审查", "你是一名跨界判官。"),
];

const FREE_SEGMENTS = loadPromptSegments("free");
// Pro segments now come from server; local pro.json removed.
// loadPromptSegments("pro") falls back to free when file is absent.
const PRO_SEGMENTS = loadPromptSegments("pro");

describe("Prompt expansion hash baselines (Step 1)", () => {

  it("buildPreAuditFinalizerPrompt with Free segments (loaded from file)", () => {
    const prompt = buildPreAuditFinalizerPrompt(SAMPLE_AUDITORS, [], FREE_SEGMENTS);
    const hash = sha256(prompt);
    assert.equal(hash, "2095b3d74401d57d062abb1912d05ffdbc9c335ff916f2d8429fcd4e00a8afae", "Free finalizer prompt hash changed — template content drift detected");
  });

  it("buildPreAuditFinalizerPrompt with Pro segments (falls back to Free tier)", () => {
    const proPrompt = buildPreAuditFinalizerPrompt(SAMPLE_AUDITORS, [{ event: "test", date: "2024" }], PRO_SEGMENTS);
    const freePrompt = buildPreAuditFinalizerPrompt(SAMPLE_AUDITORS, [{ event: "test", date: "2024" }], FREE_SEGMENTS);
    // Pro segments fall back to Free when server bundle is absent — prompts should match
    assert.equal(proPrompt, freePrompt, "Pro prompt should match Free prompt when server unavailable");
  });

  it("buildIsolatedSystemAuditorPrompt", () => {
    const prompt = buildIsolatedSystemAuditorPrompt(SAMPLE_AUDITORS[0]);
    const hash = sha256(prompt);
    assert.equal(hash, "5aa2f1e6dbe3c96b9423589de7ffbb6132e0430f2f5ed52bdc445c0166663bf8", "Auditor prompt hash changed");
  });

  it("buildIsolatedSystemAuditorMessage", () => {
    const msg = buildIsolatedSystemAuditorMessage(SAMPLE_CONTENT, SAMPLE_AUDITORS[0], {
      localFindings: [{ keyword: "测试", suggestedLevel: "🟡" }],
      step0Result: { wildTranslations: [], blackAtoms: ["测试"], attackCandidates: [], precedents: [] },
    });
    const hash = sha256(msg);
    assert.equal(hash, "69ffd459bfbe301a2f21cbaa145a26da935f88660bf576daf41a6678f480c0e0", "Auditor message hash changed");
  });

  it("buildOrchestrationFinalizerPrompt with Free segments (loaded from file)", () => {
    const prompt = buildOrchestrationFinalizerPrompt(
      SAMPLE_CONTENT,
      SAMPLE_AUDITORS,
      [],
      { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
      { bareOnly: [], fullOnly: [], stable: [] },
      [{ event: "test", date: "2024" }],
      FREE_SEGMENTS,
    );
    const hash = sha256(prompt);
    assert.equal(hash, "72606698ae6d31fa431158a1af3fe664a644b81d3959422965b9828824433b57", "Free orchestration finalizer hash changed — template content drift detected");
  });

  it("buildOrchestrationFinalizerPrompt with Pro segments (falls back to Free)", () => {
    const proPrompt = buildOrchestrationFinalizerPrompt(
      SAMPLE_CONTENT,
      SAMPLE_AUDITORS,
      [],
      { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
      { bareOnly: [], fullOnly: [], stable: [] },
      [{ event: "test", date: "2024" }],
      PRO_SEGMENTS,
    );
    const freePrompt = buildOrchestrationFinalizerPrompt(
      SAMPLE_CONTENT,
      SAMPLE_AUDITORS,
      [],
      { triggered: [], overallMultiplier: 1.0, levelUpgrades: [] },
      { bareOnly: [], fullOnly: [], stable: [] },
      [{ event: "test", date: "2024" }],
      FREE_SEGMENTS,
    );
    // Pro segments fall back to Free when server unavailable
    assert.equal(proPrompt, freePrompt, "Pro orchestration prompt should match Free when server unavailable");
  });
});
