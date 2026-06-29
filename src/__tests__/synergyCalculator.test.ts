import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateSynergy, type SynergyRule } from "../execution/synergyCalculator.js";

describe("calculateSynergy — built-in rules", () => {
  it("returns 1.0 multiplier and no triggers when all dimensions are green", () => {
    const result = calculateSynergy({
      social_risk: "🟢",
      network_culture_risk: "🟢",
      context_distortion: "🟢",
      legal_compliance: "🟢",
      factual_integrity: "🟢",
      cross_lingual_distortion: "🟢",
    });
    assert.equal(result.overallMultiplier, 1.0);
    assert.deepEqual(result.triggered, []);
    assert.equal(result.levelUpgrades.length, 0);
  });

  it("rule 1: social_risk + network_culture_risk (ALL) → 2.5x + level upgrade", () => {
    const result = calculateSynergy({
      social_risk: "🟡",
      network_culture_risk: "🟡",
    });
    assert.equal(result.overallMultiplier, 2.5);
    assert.ok(result.triggered.includes("情绪传播 × 文化符号双触发"));
    const upgrades = result.levelUpgrades.filter((u) => u.dimension === "social_risk" || u.dimension === "network_culture_risk");
    assert.equal(upgrades.length, 2);
    for (const u of upgrades) {
      assert.equal(u.from, "🟡");
      assert.equal(u.to, "🔴");
    }
  });

  it("rule 1: only one matched → not triggered (ALL condition)", () => {
    const result = calculateSynergy({
      social_risk: "🟡",
      network_culture_risk: "🟢",
    });
    assert.equal(result.overallMultiplier, 1.0);
    assert.equal(result.triggered.length, 0);
  });

  it("rule 2: context_distortion + network_culture_risk (ALL) → 2.0x + level upgrade", () => {
    const result = calculateSynergy({
      context_distortion: "🔴",
      network_culture_risk: "🟡",
    });
    assert.equal(result.overallMultiplier, 2.0);
    assert.ok(result.triggered.includes("语境崩塌 × 暗语风险双触发"));
    const contextUpgrade = result.levelUpgrades.find((u) => u.dimension === "context_distortion");
    const networkUpgrade = result.levelUpgrades.find((u) => u.dimension === "network_culture_risk");
    // context_distortion is already 🔴, so no upgrade
    assert.equal(contextUpgrade, undefined);
    assert.ok(networkUpgrade);
    assert.equal(networkUpgrade.from, "🟡");
    assert.equal(networkUpgrade.to, "🔴");
  });

  it("rule 3: legal_compliance + social_risk + context_distortion (ALL) → 3.0x + level upgrade", () => {
    const result = calculateSynergy({
      legal_compliance: "🟡",
      social_risk: "🟡",
      context_distortion: "🟡",
    });
    assert.equal(result.overallMultiplier, 3.0);
    assert.ok(result.triggered.includes("合规 × 社会风险 × 语境崩塌三向触发"));
    assert.equal(result.levelUpgrades.length, 3);
  });

  it("rule 3: not all matched → not triggered", () => {
    const result = calculateSynergy({
      legal_compliance: "🟡",
      social_risk: "🟢",
      context_distortion: "🟡",
    });
    assert.equal(result.overallMultiplier, 1.0);
    assert.equal(result.triggered.length, 0);
  });

  it("rule 4: timing_risk (ANY) → 1.5x, no level upgrade", () => {
    const result = calculateSynergy({}, ["timing_risk"]);
    assert.equal(result.overallMultiplier, 1.5);
    assert.ok(result.triggered.includes("时机窗口加成"));
    assert.equal(result.levelUpgrades.length, 0);
  });

  it("rule 4: not triggered when extraFlags missing", () => {
    const result = calculateSynergy({});
    assert.equal(result.overallMultiplier, 1.0);
    assert.equal(result.triggered.length, 0);
  });

  it("combined: multiple rules can fire simultaneously", () => {
    const result = calculateSynergy(
      {
        social_risk: "🟡",
        network_culture_risk: "🟡",
        context_distortion: "🟡",
      },
      ["timing_risk"],
    );
    assert.equal(result.overallMultiplier, 7.5); // 2.5 × 2.0 × 1.5
    assert.equal(result.triggered.length, 3);
  });
});

describe("calculateSynergy — custom rules", () => {
  it("overrides built-in rules with custom rules", () => {
    const custom: SynergyRule[] = [
      {
        dimensions: ["factual_integrity"],
        condition: "ANY",
        multiplier: 5.0,
        upgradeLevel: true,
        label: "Custom: 事实疑点放大",
      },
    ];
    const result = calculateSynergy(
      {
        social_risk: "🟡",
        network_culture_risk: "🟡",
        factual_integrity: "🟡",
      },
      undefined,
      custom,
    );
    // Built-in rules ignored, only custom applies
    assert.equal(result.overallMultiplier, 5.0);
    assert.equal(result.triggered.length, 1);
    assert.ok(result.triggered.includes("Custom: 事实疑点放大"));
    assert.equal(result.levelUpgrades.length, 1);
  });

  it("custom rules with ALL condition", () => {
    const custom: SynergyRule[] = [
      {
        dimensions: ["social_risk", "factual_integrity"],
        condition: "ALL",
        multiplier: 4.0,
        upgradeLevel: false,
        label: "Custom: 社会+事实",
      },
    ];
    const result = calculateSynergy(
      { social_risk: "🟡", factual_integrity: "🟡" },
      undefined,
      custom,
    );
    assert.equal(result.overallMultiplier, 4.0);
    assert.equal(result.levelUpgrades.length, 0);
  });

  it("empty custom rules array falls back to built-in", () => {
    const result = calculateSynergy(
      { social_risk: "🟡", network_culture_risk: "🟡" },
      undefined,
      [],
    );
    assert.equal(result.overallMultiplier, 2.5);
    assert.equal(result.triggered.length, 1);
  });
});

describe("calculateSynergy — edge cases", () => {
  it("empty dimensions → 1.0 multiplier, no triggers", () => {
    const result = calculateSynergy({});
    assert.equal(result.overallMultiplier, 1.0);
    assert.deepEqual(result.triggered, []);
  });

  it("unknown dimension IDs are treated as 🟢", () => {
    const result = calculateSynergy({
      social_risk: "🟡",
      network_culture_risk: "🟡",
      unknown_dim: "🔴",
    });
    assert.equal(result.overallMultiplier, 2.5);
    assert.equal(result.triggered.length, 1);
  });

  it("details array has entries for all rules", () => {
    const result = calculateSynergy({ social_risk: "🟡", network_culture_risk: "🟡" });
    assert.equal(result.details.length, 4);
    const matched = result.details.filter((d) => d.matched);
    assert.equal(matched.length, 1);
    const unmatched = result.details.filter((d) => !d.matched);
    assert.equal(unmatched.length, 3);
  });

  it("multiplier is rounded to 1 decimal", () => {
    const result = calculateSynergy(
      {
        social_risk: "🟡",
        network_culture_risk: "🟡",
        context_distortion: "🟡",
        legal_compliance: "🟡",
      },
      ["timing_risk"],
    );
    // 2.5 × 2.0 × 3.0 × 1.5 = 22.5 → rounded to 22.5
    assert.equal(result.overallMultiplier, 22.5);
  });

  it("does not upgrade 🔴 dimensions (only 🟡 → 🔴)", () => {
    const result = calculateSynergy({
      social_risk: "🔴",
      network_culture_risk: "🔴",
    });
    assert.ok(result.triggered.includes("情绪传播 × 文化符号双触发"));
    assert.equal(result.levelUpgrades.length, 0);
  });
});
