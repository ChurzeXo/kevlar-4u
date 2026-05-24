import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  generateIdFromDraft,
  getSubDirFromDraft,
  applyDedup,
  handleSaveDraft,
  handleUpdatePersonaDraft,
  handleDeletePersonaDraft,
  handleCreatePersona,
} from "../tools/createPersonaTool.js";
import { invalidatePersonasCache } from "../utils/parser.js";

let tmpDir: string;
let skillsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-ct-tmp-"));
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-ct-skills-"));
  invalidatePersonasCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(skillsDir, { recursive: true, force: true });
  invalidatePersonasCache();
});

function makeDraft(fields: Record<string, any>) {
  return { sessionId: "test-session", createdAt: Date.now(), step: 5, fields };
}

// ── generateIdFromDraft ──────────────────────────────────────────────────
describe("generateIdFromDraft", () => {
  it("returns undefined when draft is null", () => {
    assert.equal(generateIdFromDraft(null), undefined);
  });

  it("returns undefined when draft has no fields", () => {
    assert.equal(generateIdFromDraft({}), undefined);
  });

  it("generates trait_platform id from known values", () => {
    const draft = makeDraft({ traits: ["理性分析型→…"], platform: "小红书" });
    assert.equal(generateIdFromDraft(draft), "analytical_xiaohongshu");
  });

  it("falls back to platformKey when trait slug is empty", () => {
    const draft = makeDraft({ traits: ["超级严格型→…"], platform: "知乎" });
    const id = generateIdFromDraft(draft)!;
    assert.equal(id, "zhihu");
  });

  it("returns platformKey when traitKey is empty", () => {
    const draft = makeDraft({ traits: [], platform: "B站" });
    assert.equal(generateIdFromDraft(draft), "bilibili");
  });

  it("returns traitKey when platformKey is empty", () => {
    const draft = makeDraft({ traits: ["毒舌批评型→…"], platform: "" });
    assert.equal(generateIdFromDraft(draft), "critical");
  });

  it("returns undefined when both trait and platform slug are empty", () => {
    const draft = makeDraft({ traits: [], platform: "新平台" });
    assert.equal(generateIdFromDraft(draft), undefined);
  });
});

// ── getSubDirFromDraft ───────────────────────────────────────────────────
describe("getSubDirFromDraft", () => {
  it("returns undefined when draft is null", () => {
    assert.equal(getSubDirFromDraft(null), undefined);
  });

  it("returns platform key for known platform", () => {
    const draft = makeDraft({ platform: "小红书" });
    assert.equal(getSubDirFromDraft(draft), "xiaohongshu");
  });

  it("returns undefined for platform with only non-ASCII chars", () => {
    const draft = makeDraft({ platform: "新奇特平台" });
    assert.equal(getSubDirFromDraft(draft), undefined);
  });

  it("returns slugified key for mixed ASCII platform", () => {
    const draft = makeDraft({ platform: "My Cool Platform" });
    assert.equal(getSubDirFromDraft(draft), "my_cool_platform");
  });

  it("returns undefined when platform is empty", () => {
    const draft = makeDraft({ platform: "" });
    assert.equal(getSubDirFromDraft(draft), undefined);
  });
});

// ── applyDedup ───────────────────────────────────────────────────────────
describe("applyDedup", () => {
  it("returns baseId when no conflict", () => {
    assert.equal(applyDedup(skillsDir, "my_persona"), "my_persona");
  });

  it("appends _1, _2 when conflicts exist", () => {
    fs.writeFileSync(path.join(skillsDir, "my_persona.md"), "", "utf-8");
    fs.writeFileSync(path.join(skillsDir, "my_persona_1.md"), "", "utf-8");

    const id = applyDedup(skillsDir, "my_persona");
    assert.equal(id, "my_persona_2");
  });

  it("works with subDir", () => {
    fs.mkdirSync(path.join(skillsDir, "testdir"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "testdir", "foo.md"), "", "utf-8");

    const id = applyDedup(skillsDir, "foo", "testdir");
    assert.equal(id, "foo_1");
  });
});

// ── handleSaveDraft ─────────────────────────────────────────────────────
describe("handleSaveDraft", () => {
  it("returns null when no sessionId", async () => {
    const result = await handleSaveDraft(tmpDir, { name: "test" } as any);
    assert.equal(result, null);
  });

  it("throws when file does not exist", async () => {
    await assert.rejects(
      () => handleSaveDraft(tmpDir, { name: "test", sessionId: "nosuch" } as any),
      /不存在/
    );
  });

  it("reads existing draft file", async () => {
    const draft = { sessionId: "s1", fields: { ageRange: "25-34" } };
    fs.writeFileSync(path.join(tmpDir, "s1_draft.json"), JSON.stringify(draft), "utf-8");

    const result = await handleSaveDraft(tmpDir, { name: "test", sessionId: "s1" } as any);
    assert.deepEqual(result, draft);
  });
});

// ── handleUpdatePersonaDraft ────────────────────────────────────────────
describe("handleUpdatePersonaDraft", () => {
  it("rejects invalid sessionId format", async () => {
    const result = await handleUpdatePersonaDraft(tmpDir, {
      sessionId: "bad char!",
      field: "ageRange",
      value: "25-34",
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("sessionId"));
  });

  it("rejects invalid sessionId in value", async () => {
    const result = await handleUpdatePersonaDraft(tmpDir, {
      sessionId: "normal",
      field: "ageRange",
      value: "../../etc/passwd",
    });
    assert.ok(result.content[0].text.includes("ageRange 更新成功"));
  });

  it("creates new draft file on first update", async () => {
    const result = await handleUpdatePersonaDraft(tmpDir, {
      sessionId: "new-session",
      field: "ageRange",
      value: "18-24",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("ageRange 更新成功"));

    const filePath = path.join(tmpDir, "new-session_draft.json");
    assert.ok(fs.existsSync(filePath));

    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(saved.fields.ageRange, "18-24");
    assert.equal(saved.step, 1);
  });

  it("merges into existing draft", async () => {
    const draft = { sessionId: "s2", fields: { ageRange: "25-34" }, step: 1 };
    fs.writeFileSync(path.join(tmpDir, "s2_draft.json"), JSON.stringify(draft), "utf-8");

    await handleUpdatePersonaDraft(tmpDir, {
      sessionId: "s2",
      field: "interests",
      value: ["科技", "游戏"],
    });

    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "s2_draft.json"), "utf-8"));
    assert.equal(saved.fields.ageRange, "25-34");
    assert.deepEqual(saved.fields.interests, ["科技", "游戏"]);
    assert.equal(saved.step, 2);
  });

  it("creates tmpDir if it does not exist", async () => {
    const newTmp = path.join(tmpDir, "nonexistent");
    const result = await handleUpdatePersonaDraft(newTmp, {
      sessionId: "s3",
      field: "ageRange",
      value: "35-44",
    });

    assert.ok(result.content[0].text.includes("更新成功"));
    assert.ok(fs.existsSync(newTmp));
  });
});

// ── handleDeletePersonaDraft ────────────────────────────────────────────
describe("handleDeletePersonaDraft", () => {
  it("rejects invalid sessionId", async () => {
    const result = await handleDeletePersonaDraft(tmpDir, { sessionId: "bad!!" });
    assert.ok(result.isError);
  });

  it("warns when file does not exist", async () => {
    const result = await handleDeletePersonaDraft(tmpDir, { sessionId: "no-such" });
    assert.ok(result.content[0].text.includes("找不到"));
  });

  it("deletes existing draft file", async () => {
    const filePath = path.join(tmpDir, "delme_draft.json");
    fs.writeFileSync(filePath, JSON.stringify({ sessionId: "delme" }), "utf-8");

    const result = await handleDeletePersonaDraft(tmpDir, { sessionId: "delme" });
    assert.ok(result.content[0].text.includes("删除成功"));
    assert.ok(!fs.existsSync(filePath));
  });

  it("rejects sessionId mismatch", async () => {
    const filePath = path.join(tmpDir, "mismatch_draft.json");
    fs.writeFileSync(filePath, JSON.stringify({ sessionId: "other" }), "utf-8");

    const result = await handleDeletePersonaDraft(tmpDir, { sessionId: "mismatch" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("归属校验失败"));
  });
});

// ── handleCreatePersona ─────────────────────────────────────────────────
describe("handleCreatePersona", () => {
  it("creates persona with provided id", async () => {
    const result = await handleCreatePersona(skillsDir, tmpDir, {
      name: "测试读者",
      id: "test_reader",
      description: "A test persona",
      tags: ["小红书"],
    });

    assert.ok(result.content[0].text.includes("测试读者"));
    assert.ok(fs.existsSync(path.join(skillsDir, "test_reader.md")));
  });

  it("generates id from draft when no id provided", async () => {
    const filePath = path.join(tmpDir, "my-session_draft.json");
    fs.writeFileSync(filePath, JSON.stringify({
      sessionId: "my-session",
      fields: {
        ageRange: "25-34",
        interests: ["科技"],
        traits: ["理性分析型→喜欢查数据"],
        platform: "知乎",
        authorRelation: "路人",
      },
    }), "utf-8");

    const result = await handleCreatePersona(skillsDir, tmpDir, {
      name: "理性知乎人",
      sessionId: "my-session",
    });

    assert.ok(result.content[0].text.includes("理性知乎人"));

    const zhihuDir = path.join(skillsDir, "zhihu");
    assert.ok(fs.existsSync(zhihuDir));
    const files = fs.readdirSync(zhihuDir);
    assert.ok(files.some(f => f.endsWith(".md")));
  });

  it("returns error when draft is incomplete", async () => {
    const filePath = path.join(tmpDir, "bad-session_draft.json");
    fs.writeFileSync(filePath, JSON.stringify({
      sessionId: "bad-session",
      fields: { ageRange: "25-34" },
    }), "utf-8");

    const result = await handleCreatePersona(skillsDir, tmpDir, {
      name: "Incomplete",
      sessionId: "bad-session",
    });

    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("未找到完整的临时草稿"));
  });

  it("returns error for invalid id format", async () => {
    const result = await handleCreatePersona(skillsDir, tmpDir, {
      name: "@@@",
      id: "bad@id!",
      description: "test",
      tags: [],
    });

    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("名称格式不合法"));
  });

  it("applies dedup when id conflicts", async () => {
    fs.writeFileSync(path.join(skillsDir, "my_persona.md"), "existing", "utf-8");

    const result = await handleCreatePersona(skillsDir, tmpDir, {
      name: "my_persona",
      description: "dedup test",
      tags: [],
    });

    const text = result.content.map(c => c.text).join("\n");
    assert.ok(text.includes("my_persona"));

    const files = fs.readdirSync(skillsDir);
    assert.equal(files.filter(f => f.startsWith("my_persona")).length, 2);
  });

  it("falls back to random id when name is empty", async () => {
    const result = await handleCreatePersona(skillsDir, tmpDir, {
      name: "",
      description: "empty name fallback",
      tags: [],
    });

    const text = result.content.map(c => c.text).join("\n");
    assert.ok(text.includes("已成功创建"));
  });

  it("creates persona from draft with subdirectory", async () => {
    const filePath = path.join(tmpDir, "sub-session_draft.json");
    fs.writeFileSync(filePath, JSON.stringify({
      sessionId: "sub-session",
      fields: {
        ageRange: "18-24",
        interests: ["美妆"],
        traits: ["感性跟风型→容易被种草"],
        platform: "小红书",
        authorRelation: "粉丝",
      },
    }), "utf-8");

    const result = await handleCreatePersona(skillsDir, tmpDir, {
      name: "美妆种草机",
      sessionId: "sub-session",
    });

    assert.ok(result.content[0].text.includes("美妆种草机"));

    const subDir = path.join(skillsDir, "xiaohongshu");
    assert.ok(fs.existsSync(subDir));

    const files = fs.readdirSync(subDir);
    assert.ok(files.some(f => f.endsWith(".md")));
  });
});
