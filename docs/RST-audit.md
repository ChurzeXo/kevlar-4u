# RST 审计文档 — Reaction Simulation Taxonomy

> 本文档描述 Kevlar-4u 的 RST（互联网反应模拟人格系统）的设计、实现与审计要点。
> 配合 `docs/reviewer-creation-and-prompt-assembly.md` 阅读，后者覆盖 RST 之前的基线系统。

---

## 一、系统定位

RST 不是"角色扮演"，而是**互联网舆论反应机制模拟**。

核心目标：

- 模拟真实互联网用户在不同平台、文化与传播环境下对内容的典型反馈
- 通过四层标签组合，预测内容在特定圈层中的传播阻力与误解路径
- 让评审员的输出更像"真实用户的第一反应"，而非"维度评分报告"

---

## 二、四层架构

### 2.1 Layer 1 — 基础反馈人格（Archetype）

8 种跨文化稳定存在的互联网行为模式：

| ID | 标签 | 核心特征 | Focus Dimensions |
|----|------|---------|-----------------|
| `pragmatic_consumer` | 实用主义消费者 | 关注价格与实际价值 | hook_retention, action_conversion |
| `technical_reviewer` | 技术真实性审查者 | 审查技术逻辑，对 buzzword 敏感 | information_gap, narrative_structure |
| `low_attention_reader` | 注意力稀缺型路人 | 极短阅读耐心 | hook_retention, narrative_structure |
| `anti_marketing_detector` | 反营销敏感者 | 对营销语言极度敏感 | differentiation, action_conversion |
| `emotional_reactor` | 情绪直觉型用户 | 优先感知语气与情绪 | emotional_resonance, virality_potential |
| `logic_hunter` | 逻辑漏洞猎手 | 喜欢找矛盾 | information_gap, differentiation |
| `social_value_observer` | 社会价值观察者 | 关注社会影响 | emotional_resonance, virality_potential |
| `subculture_gatekeeper` | 亚文化圈层守门人 | 强烈圈层意识 | differentiation, virality_potential |

**审计要点**：
- `buildDimensionBiasFromArchetypes()` 将 archetypes 转为 `DimensionBias`（focus/default 权重）
- 双选时 focus dimensions 取并集（最多 4 个 focus 维度）
- 无 RST 的 persona 回退到传统 `dimensionBias` 路径

### 2.2 Layer 2 — 内容敏感触发器（Trigger）

14 个触发器，决定哪些表达特征会引发强烈反应：

| 分类 | 触发器 | 保留的 auditor |
|------|--------|---------------|
| 表达类 | jargon_density | network_culture_risk |
| 表达类 | ai_writing | network_culture_risk, context_distortion |
| 表达类 | preachy_tone | social_risk |
| 表达类 | pretentious | social_risk |
| 传播类 | clickbait | context_distortion |
| 传播类 | slow_pacing | factual_integrity |
| 传播类 | info_density_imbalance | factual_integrity |
| 社会议题 | gender_expression | social_risk |
| 社会议题 | class_expression | social_risk |
| 社会议题 | identity_politics | social_risk, network_culture_risk |
| 社会议题 | corporate_responsibility | social_risk |
| 真实性 | authenticity_check | factual_integrity |
| 真实性 | data_credibility | factual_integrity |
| 真实性 | overhyped | legal_compliance, social_risk |

**审计要点**：
- `RST_TRIGGERS` 定义在 `dimensions.ts`
- 每个 trigger 有 `retainedAuditors`（哪些 auditor 的 findings 会被保留）和 `retainedPatterns`（关键词匹配）
- `findMatchingTrigger()` 在 `focusTopicTransform.ts` 中执行过滤

### 2.3 Layer 3 — 地区文化过滤器（Regional Pack）

5 个区域，每个区域定义 trigger 权重加成：

| 区域 | 高权重 Trigger |
|------|--------------|
| china | preachy_tone ×2.0, class_expression ×1.8, gender_expression ×1.5 |
| north_america | identity_politics ×2.0, corporate_responsibility ×1.5, gender_expression ×1.5 |
| japan | pretentious ×1.5, corporate_responsibility ×1.3 |
| korea | class_expression ×2.0, authenticity_check ×1.3 |
| southeast_asia | preachy_tone ×1.5, class_expression ×1.3 |

**审计要点**：
- `RST_REGIONAL_PACKS` 定义在 `dimensions.ts`
- 权重通过 `getEffectiveTriggerWeights()` 与 platform 权重相乘
- Wizard 中根据 platform 自动推断 region（如 `小红书 → china`）

### 2.4 Layer 4 — 平台文化层（Platform Culture）

12 个平台，每个平台定义行为约束和 trigger 修正：

| 平台 | 行为约束 | 高修正 Trigger |
|------|---------|--------------|
| hacker_news | 必须包含技术质疑；禁止公司公关口吻 | ai_writing ×1.5, overhyped ×1.5 |
| reddit | 情绪化，可使用社区梗 | pretentious ×1.3 |
| twitter | 280 字以内；结论前置 | slow_pacing ×1.5, clickbait ×1.3 |
| v2ex | 必须有"个人经历"支撑 | pretentious ×1.8, overhyped ×1.5 |
| xiaohongshu | 必须有"真实体验感"；广告感一律差评 | ai_writing ×1.5, overhyped ×1.8 |
| zhihu | 结构完整、逻辑自洽；反感情感宣泄 | preachy_tone ×1.3, ai_writing ×1.2 |
| douyin | 短平快；结论先行 | slow_pacing ×1.5 |
| weibo | 情绪优先；可使用表情包 | clickbait ×1.3 |
| bilibili | 二次元梗可用；技术细节受欢迎 | pretentious ×1.3 |
| wechat_official | 正式但不刻板；信息密度高 | slow_pacing ×1.2 |
| instagram | 视觉优先；emoji 可用 | overhyped ×1.3 |
| youtube | 口语化；可引用视频内容 | slow_pacing ×1.2 |

**审计要点**：
- `RST_PLATFORM_CULTURES` 定义在 `dimensions.ts`
- `buildRSTSection()` 在 prompt 中注入平台行为约束
- Wizard 中根据用户输入的平台名自动匹配 `PlatformCultureId`

---

## 三、Focus Topic 转化管线

### 3.1 设计动机

初审 findings 是冷冰冰的结构化异常清单（如 `legal_compliance: 命中广告法绝对化词汇`）。直接丢给有性格的评审员会导致认知断层。

Focus Topic 转化器将 findings 转为引导性提示：

```
原始 finding                          Focus Topic
"最高品质" → 广告法绝对化用语    →    "这篇文案在表达上有明显的营销包装痕迹"
"精英说教感"                    →    "开头有种'教你做事'的味道"
```

### 3.2 三步 Pipeline

```
输入：preAuditReport + RSTConfig
  ↓
Step 1 — Filter（过滤）
  对每个 finding，检查 reviewer 的 triggers 是否匹配
  匹配条件：auditor ∈ trigger.retainedAuditors AND finding text matches retainedPatterns
  ↓
Step 2 — Translate（转译）
  使用 TRANSLATION_MAP 将 (auditor, trigger) → 自然语言模板
  无匹配模板时使用 fallbackTemplate
  ↓
Step 3 — Persona Adapt（人格适配）
  根据 L1 Archetype 添加语气前缀（如"从实用角度看，"）
  ↓
输出：FocusTopic[]
```

### 3.3 注入位置

| 执行模式 | 注入位置 | 说明 |
|---------|---------|------|
| MCP Sampling / Direct API | `augmentSystemPrompt()` → system prompt | ⑤ Focus Topics 段 |
| Orchestration | `buildPersonaBlock()` → system prompt | Focus Topics 段 |

**非 RST persona 不注入 Focus Topics**，走原有的 raw findings 路径（向后兼容）。

---

## 四、两阶段评审流程

### 4.1 Stage 1 — 系统初审

5 位系统审查员并行执行：

| 审查员 | 职责 | 输出 |
|--------|------|------|
| legal_compliance | 广告法、平台规则、政治红线 | findings[] |
| context_distortion | 截图脱语境化、标题党、二创曲解 | findings[] |
| network_culture_risk | 黑话撞车、亚文化用语、侮辱性谐音 | findings[] |
| factual_integrity | 数据造假、常识错误、伪科普 | findings[] |
| social_risk | 歧视、物化、特权凝视、对立煽动 | findings[] |

**初审不做进攻性维度评估**，只做防御性扫描。

### 4.2 Stage 2 — RST 复审

复审评审员**不再做防御性维度评估**（已在初审完成），只做：

1. 接收 Focus Topics（从初审 findings 过滤+转译）
2. 根据 RST 四层人格配置，产出真实用户反应
3. 评估 7 个进攻性维度

**关键边界**：

| 职责 | 初审 | 复审 |
|------|------|------|
| 合规与法律红线 | ✅ | ❌ |
| 语境脱嵌与曲解风险 | ✅ | ❌ |
| 网络文化风险 | ✅ | ❌ |
| 事实硬伤 | ✅ | ❌ |
| 社会风险与群体伦理 | ✅ | ❌ |
| 进攻性维度（7 个） | ❌ | ✅ |
| 真实互联网用户反应 | ❌ | ✅（RST 核心） |

---

## 五、Prompt 拼接变更

### 5.1 augmentSystemPrompt 拼接顺序（RST 版）

```
① 人设身份（persona.systemPrompt）
    ↓
② 评审员画像（buildPersonaContextDirective）
    ↓
③ RST 段（buildRSTSection）          ← 新增
    ↓
④ Focus Topics（formatFocusTopicsForPrompt） ← 新增
    ↓
⑤ 进攻性维度（buildOffensiveSystemDirective） ← 移除防御性
    ↓
⑥ 语气约束（buildToneDirective）
```

### 5.2 RST 段内容

```markdown
## 🧬 互联网反应模拟人格（RST）

你的人格底色是「反营销敏感者」。
你对以下内容特征特别敏感：AI 味敏感、装腔感敏感、过度包装审查。
你所处的文化语境是「中国大陆语境」，活跃平台是「小红书」。

请以这个身份的真实反应模式来评论内容，而不是以评审员的分析视角。
你的输出应该像一个真实互联网用户的第一反应，而不是一份评估报告。
```

### 5.3 Focus Topics 段内容

```markdown
## 🎯 复审焦点（来自初审）

以下是初审中发现的、可能与你的视角相关的要点，请在评论时关注这些方面：

1. 从营销嗅觉看，这篇文案在表达上有明显的营销包装痕迹，你注意到了吗？
2. 从营销嗅觉看，「重新定义」这种表达有故作深刻的嫌疑，按你的审美标准可能不太买账。

以上仅为参考提示，你可以根据自己的判断决定是否深入评论。
```

---

## 六、数据模型变更

### 6.1 PersonaMeta 新增字段

```typescript
interface PersonaMeta {
  // ... 现有字段不变 ...
  rst?: RSTConfig;  // 新增，可选
}

interface RSTConfig {
  archetypes: ArchetypeId[];      // L1 人格（1-2 个）
  triggers: TriggerId[];           // L2 触发器（0-14 个）
  regionalPack: RegionalPackId;   // L3 区域
  platformCulture: PlatformCultureId; // L4 平台
}
```

### 6.2 Persona JSON 示例

```json
{
  "meta": {
    "id": "anti_mkt_xiaohongshu",
    "name": "暴躁韭菜",
    "rst": {
      "archetypes": ["anti_marketing_detector"],
      "triggers": ["ai_writing", "overhyped", "preachy_tone"],
      "regionalPack": "china",
      "platformCulture": "xiaohongshu"
    },
    "dimensionBias": {
      "entries": [
        { "dimension": "differentiation", "weight": "focus" },
        { "dimension": "action_conversion", "weight": "focus" }
      ],
      "perspective": "对营销包装和商业话术高度警觉的反营销视角"
    }
  }
}
```

### 6.3 向后兼容

- `rst` 字段为可选（`rst?: RSTConfig`）
- 无 `rst` 的 persona 走原有 `dimensionBias` 路径
- `buildPersonaContextDirective()` 对有 `rst` 的 persona 额外输出 RST 描述
- `buildDimensionBiasFromRST()` 从 RST config 构建 dimensionBias（复用现有维度权重体系）

---

## 七、Wizard 变更

### 7.1 Perspective 步骤扩展

原有 9 个预设 + 自定义选项，新增 8 个 RST archetype 选项：

```
1-9.   传统视角预设（如"关注措辞细节、情绪表达与社会议题感受"）
10.    自定义视角
11-18. [RST] 8 个人格选项
```

### 7.2 自然语言解析

当用户输入非编号/非选项文本时，`rstParser.ts` 自动解析：

```
输入："一个讨厌 buzzword 的 HN 技术用户"
输出：RSTConfig {
  archetypes: ["technical_reviewer"],
  triggers: ["jargon_density", "ai_writing", "overhyped"],
  regionalPack: "north_america",
  platformCulture: "hacker_news"
}
```

**解析方式**：关键词匹配（非 LLM），延迟 < 10ms。

### 7.3 RST 四层选择器（P3）

选择 archetype 后进入子流程，依次询问 L2/L3/L4，每层支持跳过使用默认值。

---

## 八、新增文件索引

| 文件 | 职责 | 新增阶段 |
|------|------|---------|
| `src/execution/focusTopicTransform.ts` | Focus Topic 三步 pipeline | P1 |
| `src/execution/rstParser.ts` | 自然语言 → RST config 解析 | P2 |
| `src/execution/rstRecommender.ts` | RST 评审员推荐引擎 | P3 |
| `schedule/RST-ARCHITECTURE.md` | 架构设计文档 | P0 |
| `schedule/RST-需求文档.md` | 需求文档 | P0 |
| `schedule/RST-PHASE-LOG.md` | 阶段记忆 | P0 |

---

## 九、修改文件索引

| 文件 | 变更内容 | 变更阶段 |
|------|---------|---------|
| `src/execution/dimensions.ts` | +450 行：RST 类型定义 + 四层映射表 + 构建函数 | P0 |
| `src/utils/parser.ts` | PersonaMeta 新增 `rst?: RSTConfig` | P0 |
| `src/tools/createPersonaTool.ts` | CreatePersonaInput + buildPersonaMeta 透传 rst | P0 |
| `src/tools/createPersonaWizardTool.ts` | perspective 步骤 RST 选项 + 自然语言解析集成 | P0-P3 |
| `src/execution/parallel.ts` | augmentSystemPrompt 新增 RST/Focus Topics 段 | P1 |
| `src/execution/modes/orchestration.ts` | buildPersonaBlock 新增 RST/Focus Topics 段 | P1 |
| `src/execution/modes/sampling.ts` | 传递 preAuditReport 给 augmentSystemPrompt | P1 |
| `README.md` / `README.zh.md` / `README.ja.md` / `README.ko.md` | RST 相关描述更新 | RST 完成后 |

---

## 十、审计检查清单

### 10.1 安全性

- [ ] RST config 不包含用户可控的 prompt 注入向量
- [ ] Focus Topic 转译模板不含可被利用的格式化字符串
- [ ] `rstParser.ts` 的关键词匹配不执行用户输入中的任何命令
- [ ] `buildRSTSection()` 输出的内容经过 `sanitizePersistentField()` 处理

### 10.2 向后兼容

- [ ] 无 `rst` 的 persona 走原有 dimensionBias 路径
- [ ] 无 `rst` 的 persona 不注入 Focus Topics（走原有 raw findings）
- [ ] 无 `rst` 的 persona 不注入 RST 段
- [ ] `augmentSystemPrompt` 对 system_auditor 跳过所有 RST 逻辑

### 10.3 数据完整性

- [ ] `RSTConfig` 四个字段均为必填（archetypes / triggers / regionalPack / platformCulture）
- [ ] `rstParser.ts` 解析失败时回退到默认值，不阻断流程
- [ ] `buildDefaultRSTConfig()` 根据 platform 自动推断 region 和 platformCulture
- [ ] `getEffectiveTriggerWeights()` 正确处理所有区域×平台组合

### 10.4 Prompt 安全

- [ ] Focus Topics 仅作为"参考提示"注入，不构成强制指令
- [ ] RST 段明确声明"以真实反应模式评论，而非分析视角"
- [ ] 防御性维度不在复审 prompt 中出现（仅初审执行）
- [ ] `buildReviewUserMessage` 中的 raw findings 对 RST persona 仍可用（补充上下文）

### 10.5 性能

- [ ] Focus Topic 转化延迟 < 50ms（纯规则匹配）
- [ ] 自然语言 RST 解析延迟 < 10ms（纯关键词匹配）
- [ ] RST 映射查询延迟 < 10ms（纯内存）
- [ ] 无 LLM 调用（rstParser 和 focusTopicTransform 均为 rule-based）

---

## 十一、已知限制

1. **Wizard RST 四层选择器**：当前仅 L1 可选，L2/L3/L4 靠自动推断（P3 已实现完整版，但需验证）
2. **Focus Topic 转译模板**：基于预定义的 (auditor, trigger) 映射，新 auditor 或新 trigger 需手动添加模板
3. **自然语言解析**：基于关键词匹配，复杂描述可能解析不准确（如"一个有点阴阳怪气但又很理性的用户"）
4. **RST 推荐引擎**：基于规则评分，非 LLM 语义理解
5. **地区覆盖**：目前只有 5 个区域，未覆盖欧洲、南美等

---

## 十二、演进方向

1. **完整四层 Wizard**：P3 已实现，待验证用户交互体验
2. **Focus Topic LLM 转译**：将 rule-based 转译升级为 LLM 转译，提升自然度
3. **RST 推荐引擎 LLM 化**：用 LLM 替代规则评分，提升推荐准确度
4. **更多区域/平台**：根据用户反馈扩展
5. **RST 评测基准**：建立标准测试集，量化 RST vs 无 RST 的评审质量差异
