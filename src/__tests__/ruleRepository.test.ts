import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { RuleRepository } from "../dao/RuleRepository.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRepo(skillsDir: string): RuleRepository {
  return new RuleRepository(skillsDir);
}

function makeBundle(customRules?: any): any {
  return {
    rules: {
      version: "2.0.0",
      last_updated: "2026-06-01",
      categories: customRules ?? {
        political: {
          associative_map: [
            {
              root: "test_root",
              variants: ["var_a", "var_b"],
              misinterpret_direction: "political",
              severity: "HIGH" as const,
              base_score: 85,
              suggestion: "Avoid political references",
            },
          ],
          multi_hop_patterns: [
            { pattern: ["敏感词A", "敏感词B"], risk: "high", type: "sequential" },
            { pattern: ["X", "Y", "Z"], risk: "medium", type: "sequential" },
          ],
        },
        social: {
          associative_map: [
            {
              root: "social_root",
              variants: ["social_var1", "social_var2"],
              misinterpret_direction: "social_risk",
              severity: "MEDIUM" as const,
              base_score: 60,
              suggestion: "Check social implications",
            },
          ],
          multi_hop_patterns: [
            { pattern: ["社会词", "舆论词"], risk: "medium", type: "sequential" },
          ],
        },
      },
      semantic_primes: {
        cat_emotion: ["愤怒", "悲伤", "恐惧", "喜悦"],
        cat_body: ["身体", "健康", "疾病", "疼痛"],
        cat_money: ["暴富", "赚钱", "免费", "优惠"],
        cat_power: ["权威", "专家", "官方", "认证"],
      },
      structural_patterns: [
        {
          id: "struct-001",
          description: "情绪+身体+金钱组合",
          severity: "HIGH" as const,
          requiredCategories: ["cat_emotion", "cat_body", "cat_money"],
          windowSize: 100,
          risk_type: "health_scam",
          auto_red: true,
        },
        {
          id: "struct-002",
          description: "情绪+权力组合",
          severity: "MEDIUM" as const,
          requiredCategories: ["cat_emotion", "cat_power"],
          windowSize: 80,
          risk_type: "authority_exploit",
          auto_red: false,
        },
        {
          id: "struct-003",
          description: "密度检测：≥3 个类别命中",
          severity: "HIGH" as const,
          minCategoryCount: 3,
          windowSize: 150,
          risk_type: "density_risk",
          auto_red: true,
        },
        {
          id: "struct-004",
          description: "密度检测：≥2 个类别命中",
          severity: "MEDIUM" as const,
          minCategoryCount: 2,
          windowSize: 200,
          risk_type: "low_density",
          auto_red: false,
        },
      ],
    },
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let skillsDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-rule-repo-"));
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

// ── Tests: getMeta / getRuleByRoot / isBlacklisted / resolveVariant (no rules) ─

describe("RuleRepository — no rules loaded", () => {
  it("getMeta returns defaults when no rules", async () => {
    const repo = makeRepo(skillsDir);
    const meta = await repo.getMeta();
    assert.equal(meta.version, "0.0.0");
    assert.equal(meta.last_updated, "");
    assert.deepEqual(meta.categories, []);
  });

  it("getRuleByRoot returns null when no rules loaded", async () => {
    const repo = makeRepo(skillsDir);
    const rule = await repo.getRuleByRoot("political", "test_root");
    assert.equal(rule, null);
  });

  it("isBlacklisted returns false when no rules loaded", () => {
    const repo = makeRepo(skillsDir);
    assert.equal(repo.isBlacklisted("anything"), false);
  });

  it("resolveVariant returns empty when no rules loaded", () => {
    const repo = makeRepo(skillsDir);
    assert.deepEqual(repo.resolveVariant("anything"), []);
  });

  it("getIndex returns null when no rules loaded", () => {
    const repo = makeRepo(skillsDir);
    assert.equal(repo.getIndex(), null);
  });
});

// ── Tests: loadRules + index operations ───────────────────────────────────────

describe("RuleRepository — with rules loaded", () => {
  it("loadRules returns true on valid bundle", async () => {
    const repo = makeRepo(skillsDir);
    const ok = await repo.loadRules(makeBundle());
    assert.equal(ok, true);
    assert.notEqual(repo.getIndex(), null);
  });

  it("getMeta returns correct metadata after loading", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const meta = await repo.getMeta();
    assert.equal(meta.version, "2.0.0");
    assert.equal(meta.last_updated, "2026-06-01");
    assert.deepEqual(meta.categories, ["political", "social"]);
  });

  it("getRuleByRoot returns correct rule", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const rule = await repo.getRuleByRoot("political", "test_root");
    assert.notEqual(rule, null);
    assert.equal(rule!.root, "test_root");
    assert.equal(rule!.severity, "HIGH");
    assert.equal(rule!.base_score, 85);
  });

  it("getRuleByRoot returns null for non-existent category", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const rule = await repo.getRuleByRoot("nonexistent", "test_root");
    assert.equal(rule, null);
  });

  it("getRuleByRoot returns null for non-existent root", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const rule = await repo.getRuleByRoot("political", "no_such_root");
    assert.equal(rule, null);
  });

  it("isBlacklisted returns true for exact root", () => {
    const repo = makeRepo(skillsDir);
    repo.loadRules(makeBundle()); // no await needed for sync method, but index must be loaded
    // Wait a tick — isBlacklisted is sync but loadRules is async
  });

  it("isBlacklisted: sync check after async load", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    assert.equal(repo.isBlacklisted("test_root"), true);
    assert.equal(repo.isBlacklisted("var_a"), true);
    assert.equal(repo.isBlacklisted("var_b"), true);
    assert.equal(repo.isBlacklisted("social_var1"), true);
    assert.equal(repo.isBlacklisted("unknown"), false);
  });

  it("resolveVariant returns exact match", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const results = repo.resolveVariant("var_a");
    assert.equal(results.length, 1);
    assert.equal(results[0].rule.root, "test_root");
    assert.equal(results[0].category, "political");
  });

  it("resolveVariant returns empty for unknown variant", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const results = repo.resolveVariant("unknown_variant");
    assert.deepEqual(results, []);
  });

  it("resolveVariant fuzzy matches confusable variants", async () => {
    const repo = makeRepo(skillsDir);
    // Load rules that include a confusable character mapping
    const bundle = makeBundle({
      test_cat: {
        associative_map: [
          {
            root: "菊",
            variants: ["菊花"],
            misinterpret_direction: "test",
            severity: "LOW" as const,
            base_score: 10,
            suggestion: "test",
          },
        ],
        multi_hop_patterns: [],
      },
    });
    await repo.loadRules(bundle);
    const results = repo.resolveVariant("局花"); // 局 → 菊 via confusable map
    assert.equal(results.length, 1);
    assert.equal(results[0].rule.root, "菊");
  });

  it("resolveVariant root lookup works", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const results = repo.resolveVariant("test_root");
    assert.equal(results.length, 1);
    assert.equal(results[0].rule.root, "test_root");
  });
});

// ── Tests: checkTimingRisk ────────────────────────────────────────────────────

describe("RuleRepository — checkTimingRisk", () => {
  it("returns null when date is far from any window", () => {
    const repo = makeRepo(skillsDir);
    // July 15 — far from all windows
    const result = repo.checkTimingRisk(new Date("2026-07-15"), "女性 护肤");
    assert.equal(result, null);
  });

  it("returns finding when date is near Women's Day with relevance keyword", () => {
    const repo = makeRepo(skillsDir);
    // March 5 — within 7 days of March 8 (Women's Day)
    const result = repo.checkTimingRisk(new Date("2026-03-05"), "送给妈妈的礼物，女性职场穿搭");
    assert.notEqual(result, null);
    assert.equal(result!.windowId, "womens_day");
    assert.equal(result!.windowLabel, "妇女节");
    assert.ok(Math.abs(result!.daysFromCenter) <= 7, "should be within window");
    assert.equal(result!.riskMultiplier, 2.0);
    assert.equal(result!.matched, true);
  });

  it("returns finding with force keyword even without relevance keyword", () => {
    const repo = makeRepo(skillsDir);
    // March 6 — within Women's Day window, with force keyword "性别"
    const result = repo.checkTimingRisk(new Date("2026-03-06"), "关于性别的讨论");
    assert.notEqual(result, null);
    assert.equal(result!.windowId, "womens_day");
    assert.ok(result!.description.includes("妇女节"), "should mention window label");
  });

  it("returns null when date is in window but no matching keyword", () => {
    const repo = makeRepo(skillsDir);
    // March 5 — within Women's Day window, but no relevant keywords
    const result = repo.checkTimingRisk(new Date("2026-03-05"), "今天的天气真好");
    assert.equal(result, null);
  });

  it("returns finding on exact center date", () => {
    const repo = makeRepo(skillsDir);
    // Exactly June 1 — Children's Day
    const result = repo.checkTimingRisk(new Date("2026-06-01"), "儿童教育很重要");
    assert.notEqual(result, null);
    assert.equal(result!.windowId, "childrens_day");
    assert.equal(result!.daysFromCenter, 0);
    assert.equal(result!.riskMultiplier, 2.5);
  });

  it("returns finding at edge of Valentine's window", () => {
    const repo = makeRepo(skillsDir);
    // Feb 9 — 5 days before Feb 14 (edge of 5-day window)
    const result = repo.checkTimingRisk(new Date("2026-02-09"), "恋爱约会");
    assert.notEqual(result, null);
    assert.equal(result!.windowId, "valentines_day");
  });

  it("returns null one day outside window boundary", () => {
    const repo = makeRepo(skillsDir);
    // Feb 8 — 6 days before Feb 14 (outside 5-day window)
    const result = repo.checkTimingRisk(new Date("2026-02-08"), "恋爱约会");
    assert.equal(result, null);
  });

  it("returns finding for Labour Day with force keyword", () => {
    const repo = makeRepo(skillsDir);
    const result = repo.checkTimingRisk(new Date("2026-05-02"), "资本家剥削员工压榨劳动力");
    assert.notEqual(result, null);
    assert.equal(result!.windowId, "labour_day");
  });

  it("returns finding for Singles Day window", () => {
    const repo = makeRepo(skillsDir);
    // Nov 10 — within 3 days of Nov 11
    const result = repo.checkTimingRisk(new Date("2026-11-10"), "双十一购物打折");
    assert.notEqual(result, null);
    assert.equal(result!.windowId, "singles_day");
  });
});

// ── Tests: checkMultiHopPatterns ──────────────────────────────────────────────

describe("RuleRepository — checkMultiHopPatterns", () => {
  it("returns empty when no rules loaded", () => {
    const repo = makeRepo(skillsDir);
    const results = repo.checkMultiHopPatterns("敏感词A 敏感词B");
    assert.deepEqual(results, []);
  });

  it("returns match when all pattern words are in content", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const results = repo.checkMultiHopPatterns("这里包含敏感词A和敏感词B");
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].pattern, ["敏感词A", "敏感词B"]);
    assert.equal(results[0].risk, "high");
    assert.equal(results[0].category, "political");
  });

  it("returns empty when only some words match", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const results = repo.checkMultiHopPatterns("只有敏感词A没有其他");
    assert.deepEqual(results, []);
  });

  it("matches three-word pattern", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const results = repo.checkMultiHopPatterns("X Y Z 一起出现");
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].pattern, ["X", "Y", "Z"]);
    assert.equal(results[0].risk, "medium");
  });

  it("returns multiple matches from different categories", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // Content that triggers both political and social patterns
    const results = repo.checkMultiHopPatterns("敏感词A 敏感词B 社会词 舆论词 全部都在");
    assert.equal(results.length, 2);
    const categories = results.map((r) => r.category).sort();
    assert.deepEqual(categories, ["political", "social"]);
  });

  it("finds word as substring match (contains check)", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // "敏感词A" as substring of "大敏感词A" → matches
    const results = repo.checkMultiHopPatterns("大敏感词A 敏感词B来了");
    assert.equal(results.length, 1);
  });
});

// ── Tests: checkStructuralPatterns ────────────────────────────────────────────

describe("RuleRepository — checkStructuralPatterns", () => {
  it("returns empty when no rules loaded", () => {
    const repo = makeRepo(skillsDir);
    const results = repo.checkStructuralPatterns("任何内容");
    assert.deepEqual(results, []);
  });

  it("matches requiredCategories when all categories hit within window", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // "愤怒" (cat_emotion), "身体" (cat_body), "赚钱" (cat_money) — all within 100 chars of struct-001
    const content = "愤怒的人们看到这些关于身体健康和赚钱的信息";
    const results = repo.checkStructuralPatterns(content);
    const match = results.find((r) => r.patternId === "struct-001");
    assert.notEqual(match, undefined, "struct-001 should match");
    assert.equal(match!.severity, "HIGH");
    assert.equal(match!.suggestedLevel, "🔴"); // auto_red = true
    assert.equal(match!.riskType, "health_scam");
  });

  it("returns null for requiredCategories when one category missing", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // Only emotion + body, no money → struct-001 should NOT match
    const content = "愤怒的人们关注身体健康";
    const results = repo.checkStructuralPatterns(content);
    const match = results.find((r) => r.patternId === "struct-001");
    assert.equal(match, undefined);
  });

  it("returns null for requiredCategories when words too far apart", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // struct-002: emotion + power, windowSize=80
    const closeContent = "愤怒" + "权威".padStart(200, "填充文字填充文字"); // too far apart
    const results = repo.checkStructuralPatterns(closeContent);
    const match = results.find((r) => r.patternId === "struct-002");
    assert.equal(match, undefined);
  });

  it("matches struct-002 when emotion and power are close", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const content = "专家表示愤怒是可以理解的";
    const results = repo.checkStructuralPatterns(content);
    const match = results.find((r) => r.patternId === "struct-002");
    assert.notEqual(match, undefined);
    assert.equal(match!.severity, "MEDIUM");
    assert.equal(match!.suggestedLevel, "🟡"); // auto_red = false
    assert.equal(match!.riskType, "authority_exploit");
  });

  it("matches minCategoryCount mode when enough categories hit", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // struct-003: minCategoryCount=3, windowSize=150
    const content = "愤怒的消费者发现免费赚钱的秘诀后感到恐惧和疾病";
    const results = repo.checkStructuralPatterns(content);
    const match = results.find((r) => r.patternId === "struct-003");
    assert.notEqual(match, undefined, "struct-003 should match with ≥3 categories");
    assert.equal(match!.severity, "HIGH");
    assert.equal(match!.suggestedLevel, "🔴");
    assert.ok(match!.hitCount !== undefined);
    assert.ok(match!.hitCount! >= 3);
  });

  it("returns null for minCategoryCount when not enough categories hit", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // struct-004: minCategoryCount=2, but only one category hits
    const content = "专家权威认证"; // only cat_power
    const results = repo.checkStructuralPatterns(content);
    const match = results.find((r) => r.patternId === "struct-004");
    assert.equal(match, undefined);
  });

  it("returns multiple structural matches when applicable", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // Content that triggers both struct-002 and struct-004
    const content = "愤怒的专家表示权威认证机构也认可免费的身体健康检查";
    const results = repo.checkStructuralPatterns(content);
    // Should match struct-004 (minCategoryCount=2: emotion+power)
    const match4 = results.find((r) => r.patternId === "struct-004");
    assert.notEqual(match4, undefined, "struct-004 should match");
    // struct-002 should also match (emotion+power)
    const match2 = results.find((r) => r.patternId === "struct-002");
    assert.notEqual(match2, undefined, "struct-002 should match");
  });

  it("counts unique categories, not word occurrences", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    // struct-004 needs ≥2 categories. Multiple emotion words still count as 1 category.
    const content = "愤怒 悲伤 恐惧".padEnd(50, "填充");
    const results = repo.checkStructuralPatterns(content);
    const match = results.find((r) => r.patternId === "struct-004");
    assert.equal(match, undefined, "one category repeated should not satisfy minCategoryCount=2");
  });
});

// ── Tests: edge cases ─────────────────────────────────────────────────────────

describe("RuleRepository — edge cases", () => {
  it("loadRules handles empty bundle gracefully", async () => {
    const repo = makeRepo(skillsDir);
    const ok = await repo.loadRules({ rules: {} });
    assert.equal(ok, true);
    const meta = await repo.getMeta();
    assert.equal(meta.version, "0.0.0");
    assert.deepEqual(meta.categories, []);
  });

  it("loadRules handles null bundle gracefully", async () => {
    const repo = makeRepo(skillsDir);
    const ok = await repo.loadRules(null);
    assert.equal(ok, true);
  });

  it("loadRules handles bundle without rules key", async () => {
    const repo = makeRepo(skillsDir);
    const ok = await repo.loadRules({ other: "data" });
    assert.equal(ok, true);
  });

  it("checkMultiHopPatterns handles empty content", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const results = repo.checkMultiHopPatterns("");
    assert.deepEqual(results, []);
  });

  it("checkStructuralPatterns handles empty content", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    const results = repo.checkStructuralPatterns("");
    assert.deepEqual(results, []);
  });

  it("checkTimingRisk handles empty content", () => {
    const repo = makeRepo(skillsDir);
    const result = repo.checkTimingRisk(new Date("2026-03-05"), "");
    assert.equal(result, null);
  });

  it("resolveVariant handles empty string", async () => {
    const repo = makeRepo(skillsDir);
    await repo.loadRules(makeBundle());
    assert.deepEqual(repo.resolveVariant(""), []);
  });

  it("injectDecryptedStream always returns false", async () => {
    const repo = makeRepo(skillsDir);
    const result = await repo.injectDecryptedStream("cipher", "token");
    assert.equal(result, false);
  });

  it("loadRules with Pro format fails gracefully without Pro runtime", async () => {
    const repo = makeRepo(skillsDir);
    // Write encrypted-style bundle
    const encPath = path.join(skillsDir, "strategy-bundle-cache.enc");
    fs.writeFileSync(encPath, "kevlar:some-encrypted-data", "utf-8");
    // Should not throw, just return true with empty rules
    const ok = await repo.loadRules();
    assert.equal(ok, true);
    const meta = await repo.getMeta();
    assert.equal(meta.version, "0.0.0"); // no rules loaded from encrypted bundle
  });

  it("loadRules with corrupted JSON in bundle file returns true gracefully", async () => {
    const repo = makeRepo(skillsDir);
    const encPath = path.join(skillsDir, "strategy-bundle-cache.enc");
    fs.writeFileSync(encPath, "not valid json {{{", "utf-8");
    const ok = await repo.loadRules();
    assert.equal(ok, true);
  });
});
