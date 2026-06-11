# 初审流程（Pre-Audit Pipeline）

## 流程图

```
Step 0a: 本地规则引擎
═══════════════════════════════════════════════════════════════════
  │  0.1 时机节点检测 ──────────────► timingFinding?
  │  0.2 2-4 gram 滑动窗口匹配 ────► variantMatches[]
  │  0.3 L2 结构模式检测 ──────────► structuralMatches[]
  │  0.4 Multi-hop patterns 检测 ──► multiHopMatches[]
  │
  │  输出：localFindings[]
  ▼
Step 0b + 联网搜索: 职业黑粉逆向全局解码 + 宿主搜索
═══════════════════════════════════════════════════════════════════
  │  宿主 AI 执行（所有执行模式），合并 Step 0b 解码 + 联网搜索
  │  │
  │  ─ [① 语言边界判定]
  │  │    提取外文/混排短语 → 生成最具歧义的「野生机翻」
  │  │    输出：wildTranslations [{ original, wildTranslation }]
  │  │
  │  ├─ [② 局部截取]（提取潜在武器化词汇，含外文）
  │  ├─ [③ 情绪重构]（扣帽与推演攻击链）
  │  └─ [④ 联网搜索] 宿主使用自己的 web search 工具
  │       对 blackAtoms 逐一搜索中文网络语境
  │
  │  输出：step0Result { wildTranslations, blackAtoms, attackCandidates }
  │        + webContextMap { keyword → 搜索结果文本 }
  ▼
Step 1: 物理脱嵌
═══════════════════════════════════════════════════════════════════
  │  stripContext(raw, knownEntities?)
  │  ├─ original（原文）
  │  ├─ bare（裸文：去掉品牌/链接/格式）
  │  └─ replacements（替换映射表）
  ▼
Step 2: 裸文审计
═══════════════════════════════════════════════════════════════════
  │  runSystemAuditors(bare, [context_distortion, network_culture_risk, cross_lingual_distortion])
  │  ├─ 注入从 Turn 1c 获取的对应 webContextMap
  │
  │  输出：bareFindings[]
  ▼
Step 3: 全文审计
═══════════════════════════════════════════════════════════════════
  │  runSystemAuditors(full, [所有 system_auditors])
  │  ├─ 注入从 Turn 1c 获取的对应 webContextMap
  │  ├─ social_risk           ─┬
  │  ├─ legal_compliance       │
  │  ├─ context_distortion     │ 并行执行
  │  ├─ network_culture_risk   │ 每个维度独立推理
  │  ├─ factual_integrity      │
  │  └─ cross_lingual_distortion─┘  ◄── 新增：跨界判官（恶意机翻与谐音检测）
  │
  │  输出：auditorResults[]
  ▼
Step 4: Delta 分析
═══════════════════════════════════════════════════════════════════
  │  （内联逻辑于 executeLlmSystemAudit() 中）
  │  对比 bareFindings vs auditorResults
  │  ├─ bareOnly  ──► 脱嵌放大型风险（仅有裸文）
  │  ├─ fullOnly  ──► 全文特有风险
  │  └─ stable    ──► 稳定风险
  │
  │  输出：deltaRisks
  ▼
Step 5: 合并 (无联网验证)
══════════════════════════════════════════════════════════════════
  │  mergeLocalFindingsIntoAudits(auditorResults, localFindings)
  │  ├─ 本地规则 findings 注入到 network_culture_risk 维度
  │  └─ 结果合并，不再单独执行联网验证（已在统一搜索阶段完成）
  │
  │  输出：mergedResults[]
  ▼
Step 6: 交叉验证
═══════════════════════════════════════════════════════════════════
  │  对有风险的维度进行互验（6 对双向/单向验证）：
  │  ├─ network_culture_risk ◄──► context_distortion
  │  ├─ cross_lingual_distortion ◄──► network_culture_risk
  │  ├─ social_risk ──────────► factual_integrity
  │  └─ legal_compliance ────► social_risk
  │
  │  输出：crossValidatedResults[]
  ▼
Step 7: 协同加权
═══════════════════════════════════════════════════════════════════
  │  calculateSynergy(dimensionLevels, extraFlags?)
  │  ├─ 检测跨维度组合风险
  │  └─ 🟡 → 🔴 升级判定
  │
  │  输出：synergy { triggered, overallMultiplier, levelUpgrades }
  ▼
Step 8: 最终仲裁
═══════════════════════════════════════════════════════════════════
  │  finalizePreAuditReport() ──► LLM 总仲裁官
  │  ├─ 合并重复 findings
  │  ├─ 强化攻击链描述
  │  ├─ 生成 worstCaseNarrative
  │  └─ 应用 levelUpgrades
  │
  │  输出：PreAuditReport
  ▼
Step 9: 结果展示
═══════════════════════════════════════════════════════════════════
  │  → 用户看到初审结果
  │  → 选择：进入复审 / 平台合规检查
  ▼
  End
```

## 汇总表

| Step | 执行者 | 主要操作 |
|------|--------|----------|
| 0a | 代码 | 本地规则匹配 (localFindings) |
| 0b+搜索 | 宿主 AI | 职业黑粉逆向全局解码 + 联网搜索（宿主 AI 合并执行，输出 step0Result + webContextMap） |
| 1 | 代码 | 文本脱嵌处理 (stripContext: original/bare/replacements) |
| 2 | LLM | 裸文审计（3个维度，含跨语言曲解，注入 Turn 1 联网上下文） |
| 3 | LLM | 全文审计（**6 个维度**，含新增跨界判官，注入 Turn 1 联网上下文） |
| 4 | 代码 | Delta 信号提取 |
| 5 | 代码 | 结果合并 (无二次联网验证，纯内存合并) |
| 6 | LLM | 交叉验证 |
| 7 | 代码 | 协同加权计算 |
| 8 | LLM | 最终仲裁聚合 |
| 9 | 代码 | 展示给用户 |

## 核心文件

| 步骤 | 文件 | 函数 / 提示词 |
|------|------|--------------|
| Step 0a | `src/tools/reviewContentWizardTool.ts` | `buildLocalRuleFindings()` |
| Step 0b+搜索 | `src/prompts/reviewWizard.ts` | `buildOrchestrationStep0Prompt()`（含联网搜索指令） |
| Step 0c | 已移除 | 统一由宿主 AI 搜索替代，`runUnifiedWebSearch()` 已删除 |
| Step 1 | `src/utils/stripContext.ts` | `stripContext(raw, knownEntities?)` |
| Step 2-3 | `src/tools/reviewContentWizardTool.ts` | `runSystemAuditors()` |
| Step 4 | `src/tools/reviewContentWizardTool.ts` | 内联于 `executeLlmSystemAudit()` |
| Step 5 | `src/tools/reviewContentWizardTool.ts` | `mergeLocalFindingsIntoAudits()` |
| Step 6 | `src/tools/reviewContentWizardTool.ts` | `crossValidateRiskyDimensions()` |
| Step 7 | `src/execution/synergyCalculator.ts` | `calculateSynergy(dimensionLevels, extraFlags?)` |
| Step 8 | `src/tools/reviewContentWizardTool.ts` | `finalizePreAuditReport()` / `buildPreAuditFinalizerPrompt()` |

## 联网验证说明

在统一裁撤方案实施后，联网搜索不再由 kevlar 服务器自行调用 DuckDuckGo。Step 0b 与联网搜索**合并**为宿主 AI 的一轮交互。

### Step 0b+搜索：宿主 AI 合并执行

在 Step 0a (本地规则引擎) 完成后，工具返回给宿主 AI，宿主 AI 同时执行：
1. **职业黑粉逆向解码**（Step 0b）：提取 `wildTranslations`、`blackAtoms`、`attackCandidates`。
2. **联网搜索**：宿主 AI 使用自己的 web search 工具对每个 `blackAtoms` 搜索中文网络语境。
3. **合并返回**：宿主 AI 在一次调用中返回 `step0Result` + `webContextMap`。

### 联网上下文注入（Step 2-3）

与之前一致：`runSystemAuditors()` 根据 `webContextMap` 为每个系统审计员构建 `webContext` 文本并注入审计提示词。

### 结果合并（Step 5）

不变。纯代码内存合并。

### 边界情况

| 场景 | 行为 |
|------|------|
| 宿主 AI 搜索结果为空 | `webContextMap` 为 `{}`，Steps 2-9 跳过注入 |
| 宿主 AI 无搜索工具 | Step 0b 解码正常执行，`webContextMap` 为空，降级为无联网分析 |
| 本地规则命中为空 | Step 0a 输出空 `localFindings`，不影响流程 |
