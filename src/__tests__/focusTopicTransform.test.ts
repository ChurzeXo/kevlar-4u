import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatFocusTopicsForPrompt,
  transformFindingsToFocusTopics,
} from "../execution/focusTopicTransform.js";
import type { RSTConfig } from "../execution/dimensions.js";

const rst: RSTConfig = {
  archetypes: ["anti_marketing_detector"],
  triggers: ["overhyped"],
  regionalPack: "china",
  platformCulture: "xiaohongshu",
};

describe("Focus Topic transformation", () => {
  it("translates legal pre-audit findings into reviewer-facing narration", () => {
    const topics = transformFindingsToFocusTopics(
      {
        dimensions: [
          {
            id: "legal_compliance",
            name: "内容审查员-合规",
            findings: [
              {
                keyword: "全网第一",
                trigger: "广告法绝对化用语",
                riskDescription: "包含夸大宣传，命中广告法禁用词",
                suggestedLevel: "🟡",
              },
            ],
          },
        ],
      },
      rst,
    );

    assert.equal(topics.length, 1);
    assert.match(topics[0].prompt, /第 1 段/);
    assert.match(topics[0].prompt, /过度包装、吹嘘功能/);
    assert.match(topics[0].prompt, /画饼/);
    assert.doesNotMatch(topics[0].prompt, /legal_compliance|广告法禁用词|系统违规代码/);
  });

  it("formats focus topics as sniper review hints without raw audit codes", () => {
    const section = formatFocusTopicsForPrompt([
      {
        sourceAuditor: "内容审查员-合规",
        sourceKeyword: "全网第一",
        matchedTrigger: "overhyped",
        prompt: "该文本在初审中被检测出在第 1 段存在“过度包装、吹嘘功能”的嫌疑。请以你刻薄、理性的视角，死磕该段落是否在“画饼”或缺乏事实依据。",
      },
    ]);

    assert.match(section, /狙击手定点复审焦点/);
    assert.match(section, /旁白提示/);
    assert.doesNotMatch(section, /基本盘|系统违规代码|legal_compliance/);
  });
});
