import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { handleListPersonas } from "../tools/listPersonasTool.js";
import { invalidatePersonasCache } from "../utils/parser.js";

let skillsDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-list-test-"));
  invalidatePersonasCache();
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  invalidatePersonasCache();
});

function writePersona(id: string, name: string, tags: string[], description = "测试描述"): void {
  const content = [
    "---",
    `id: ${id}`,
    `name: ${name}`,
    "name_en: Test",
    "version: 1.0.0",
    "author: test",
    "tags:",
    ...tags.map(t => `  - ${t}`),
    `description: ${description}`,
    "blindSpot: none",
    "---",
    "性格特质：直接。",
  ].join("\n");
  fs.writeFileSync(path.join(skillsDir, `${id}.md`), content, "utf-8");
}

function textOf(result: Awaited<ReturnType<typeof handleListPersonas>>): string {
  return result.content.map(c => c.text).join("\n");
}

describe("handleListPersonas", () => {
  it("returns empty message when no personas exist", async () => {
    const result = await handleListPersonas(skillsDir);
    const text = textOf(result);
    assert.ok(text.includes("没有任何评审员"));
  });

  it("shows platform overview when no platform specified", async () => {
    writePersona("visual_reader", "视觉读者", ["小红书"]);
    writePersona("logic_reader", "逻辑读者", ["知乎"]);

    const result = await handleListPersonas(skillsDir);
    const text = textOf(result);
    assert.ok(text.includes("2 位评审员"));
    assert.ok(text.includes("小红书"));
    assert.ok(text.includes("知乎"));
    assert.ok(!text.includes("视觉读者"));
  });

  it("shows all personas when platform is 全部", async () => {
    writePersona("p1", "人设A", ["小红书"]);
    writePersona("p2", "人设B", ["知乎"]);

    const result = await handleListPersonas(skillsDir, "全部");
    const text = textOf(result);
    assert.ok(text.includes("人设A"));
    assert.ok(text.includes("人设B"));
    assert.ok(text.includes("2 位"));
  });

  it("filters by specific platform", async () => {
    writePersona("p1", "小红书写手", ["小红书", "视觉"]);
    writePersona("p2", "知乎达人", ["知乎", "逻辑"]);

    const result = await handleListPersonas(skillsDir, "小红书");
    const text = textOf(result);
    assert.ok(text.includes("小红书写手"));
    assert.ok(!text.includes("知乎达人"));
  });

  it("shows unknown platform message", async () => {
    writePersona("p1", "A", ["小红书"]);

    const result = await handleListPersonas(skillsDir, "不存在的平台");
    const text = textOf(result);
    assert.ok(text.includes("不存在的平台"));
    assert.ok(text.includes("没有评审员"));
  });

  it("detects platform from persona id when no tags match", async () => {
    writePersona("xiaohongshu_critic", "平台推断", []);

    const result = await handleListPersonas(skillsDir, "小红书");
    const text = textOf(result);
    assert.ok(text.includes("平台推断"));
  });

  it("falls back to 通用 when no platform is detected", async () => {
    writePersona("general_persona", "通用角色", ["其他"]);

    const overview = await handleListPersonas(skillsDir);
    assert.ok(textOf(overview).includes("通用"));

    const filtered = await handleListPersonas(skillsDir, "通用");
    assert.ok(textOf(filtered).includes("通用角色"));
  });

  it("handles multiple personas on same platform", async () => {
    writePersona("r1", "读者A", ["小红书"]);
    writePersona("r2", "读者B", ["小红书"]);
    writePersona("r3", "读者C", ["小红书"]);

    const result = await handleListPersonas(skillsDir, "小红书");
    const text = textOf(result);
    assert.ok(text.includes("3 位"));
    assert.ok(text.includes("读者A"));
    assert.ok(text.includes("读者B"));
    assert.ok(text.includes("读者C"));
  });

  it("shows tags in detailed view", async () => {
    writePersona("p1", "标签人", ["小红书", "时尚", "美妆"]);

    const result = await handleListPersonas(skillsDir, "全部");
    const text = textOf(result);
    assert.ok(text.includes("标签"));
    assert.ok(text.includes("时尚"));
    assert.ok(text.includes("美妆"));
  });
});
