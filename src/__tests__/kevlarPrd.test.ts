import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { RuleRepository } from "../dao/RuleRepository.js";
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

function mockRulesBundle() {
  return {
    rules: {
      categories: {
        core: {
          associative_map: [
            {
              root: "木耳",
              variants: ["粉木耳", "黑木耳", "白木耳", "红木耳", "粉耳", "木耳"],
              misinterpret_direction: "涉黄风险",
              severity: "HIGH",
              base_score: 0.85,
            },
            {
              root: "菊花",
              variants: ["XX菊花", "爆菊花", "局花", "菊花"],
              misinterpret_direction: "黑话暗语",
              severity: "HIGH",
              base_score: 0.85,
            },
          ],
        },
      },
    },
  };
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
    const repo = new RuleRepository(tmpDir);
    const bundle = mockRulesBundle();
    assert.equal(await repo.loadRules(bundle), true);

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
  });

  it("loads empty rules when no bundle available", async () => {
    const repo = new RuleRepository(tmpDir);
    assert.equal(await repo.loadRules(), true);
    assert.equal(repo.isBlacklisted("anything"), false);
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
