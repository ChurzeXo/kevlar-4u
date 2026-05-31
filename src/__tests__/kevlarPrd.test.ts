import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { LocalJsonRuleRepository } from "../dao/LocalJsonRuleRepository.js";
import { buildKevlarRiskDirective, buildPseudoParallelDirective } from "../execution/riskPrompt.js";
import { augmentSystemPrompt } from "../execution/parallel.js";
import { orchestrationHandler } from "../execution/modes/orchestration.js";
import type { Persona } from "../utils/parser.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-prd-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCoreRules(): void {
  fs.writeFileSync(
    path.join(tmpDir, "rules_free.json"),
    JSON.stringify({
      core_rules: {
        association_patterns: [
          { pattern: "颜色+身体部位", risk_type: "涉黄风险" },
          { pattern: "食材+异常修饰", risk_type: "黑话暗语" },
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

function testPersona(id: string, name: string): Persona {
  return {
    meta: {
      id,
      name,
      name_en: name,
      version: "1.0.0",
      author: "test",
      tags: ["通用"],
      description: "测试评审员",
      blindSpot: "无",
    },
    systemPrompt: "你是测试评审员。",
    filePath: "",
  };
}

describe("Kevlar PRD rule repository", () => {
  it("loads core_rules into O(1) exact and variant indexes", async () => {
    writeCoreRules();
    const repo = new LocalJsonRuleRepository(tmpDir);

    assert.equal(await repo.loadRules(), true);

    assert.equal(repo.isBlacklisted("粉耳"), true);
    assert.equal(repo.isBlacklisted("爆菊花"), true);

    const exact = repo.resolveVariant("粉耳");
    assert.equal(exact.length, 1);
    assert.equal(exact[0].rule.root, "木耳");
    assert.equal(exact[0].rule.misinterpret_direction, "涉黄风险");

    const fuzzy = repo.resolveVariant("局花");
    assert.equal(fuzzy.length, 1);
    assert.equal(fuzzy[0].rule.root, "菊花");

    const index = repo.getIndex();
    assert.ok(index);
    assert.equal(index.variantMap.get("粉耳")?.rule.root, "木耳");
    assert.equal(index.associationPatterns[0].pattern, "颜色+身体部位");
    assert.ok(index.evolutionStrategies.includes("谐音演化"));
  });

  it("keeps packaged rules under 5KB", () => {
    const size = fs.statSync(path.join(process.cwd(), "skills", "rules_free.json")).size;
    assert.ok(size < 5 * 1024, `rules_free.json is ${size} bytes`);
  });
});

describe("Kevlar PRD prompt directives", () => {
  it("builds the risk directive without options (simplified signature)", () => {
    const directive = buildKevlarRiskDirective();
    assert.ok(directive.includes("严格遵守审查边界"));
    assert.ok(directive.includes("客观风险识别与分析"));
  });

  it("builds a pseudo-parallel isolation template for all personas", () => {
    const personas = [
      testPersona("p1", "独立女性视角审查员"),
      testPersona("p2", "理性男性视角审查员"),
    ];

    const directive = buildPseudoParallelDirective(personas);
    assert.ok(directive.includes("并行模拟执行规范"));
    assert.ok(directive.includes("审查员 1 号 [独立女性视角审查员]"));
    assert.ok(directive.includes("审查员 2 号 [理性男性视角审查员]"));
    assert.ok(directive.includes("不得颠倒或合并"));
    assert.ok(directive.includes("KEVLAR_PERSONA_END"));
  });

  it("orchestration output contains the parallel isolation contract", async () => {
    const result = await orchestrationHandler.execute({
      skillsDir: tmpDir,
      personas: [testPersona("p1", "独立女性视角审查员"), testPersona("p2", "理性男性视角审查员")],
      content: "今天的粉耳凉拌菜很清爽",
    });

    assert.ok(result.report.includes("并行模拟执行规范"));
    assert.ok(result.report.includes("严禁使用"));
    assert.ok(result.report.includes("KEVLAR_PERSONA_END"));
  });
});
