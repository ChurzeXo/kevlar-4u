# 初审流程（Pre-Audit Pipeline）

## 流程图

```
Step 0a: 本地规则引擎
═══════════════════════════════════════════════════════════════════
  │  0.1 时机节点检测 ──────────────► timingFinding?
  │  0.2 2-4 gram 滑动窗口匹配 ────► variantMatches[]
  │  0.3 L2 结构模式检测 ──────────► structuralMatches[]
  │
  │  输出：localFindings[]
  ▼
Step 0b: 职业黑粉逆向全局解码
═══════════════════════════════════════════════════════════════════
  │  LLM 独立解码 (Sampling/Direct API) 或 宿主 Yield (Orchestration)
  │  ├─ 局部截取（提取潜在武器化词汇）
  │  └─ 情绪重构（扣帽与推演攻击链）
  │
  │  输出：step0Result { blackAtoms, attackCandidates }
  ▼
Step 0c: 统一并发联网检索
═══════════════════════════════════════════════════════════════════
  │  runUnifiedWebSearch(step0Result, localFindings)
  │  ├─ 汇总本地命中词 + Step 0 词汇并发搜索
  │  └─ 并发度限制：最大 10 个词
  │
  │  输出：webContextMap
  ▼
Step 1: 物理脱嵌
═══════════════════════════════════════════════════════════════════
  │  stripContext(content)
  │  ├─ bare（裸文：去掉品牌/链接/格式）
  │  └─ full（原文）
  ▼
Step 2: 裸文审计
═══════════════════════════════════════════════════════════════════
  │  runSystemAuditors(bare, [context_distortion, network_culture_risk])
  │  ├─ 注入从 Turn 1c 获取的对应 webContextMap
  │
  │  输出：bareFindings[]
  ▼
Step 3: 全文审计
═══════════════════════════════════════════════════════════════════
  │  runSystemAuditors(full, [所有 system_auditors])
  │  ├─ 注入从 Turn 1c 获取的对应 webContextMap
  │  ├─ social_risk        ─┐
  │  ├─ legal_compliance    │ 并行执行
  │  ├─ context_distortion  │ 每个维度独立推理
  │  ├─ network_culture_risk│
  │  └─ factual_integrity  ─┘
  │
  │  输出：auditorResults[]
  ▼
Step 4: Delta 分析
═══════════════════════════════════════════════════════════════════
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
  │  对有风险的维度进行互验：
  │  ├─ network_culture_risk ◄──► context_distortion
  │  ├─ social_risk ──────────► factual_integrity
  │  └─ legal_compliance ────► social_risk
  │
  │  输出：crossValidatedResults[]
  ▼
Step 7: 协同加权
═══════════════════════════════════════════════════════════════════
  │  calculateSynergy(dimensionLevels, timingFlag)
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
| 0b | LLM | 职业黑粉逆向全局解码 (提取 Step 0 关键词) |
| 0c | 代码 | 统一并发联网检索 (对 localFindings + Step 0 关键词统一搜索) |
| 1 | 代码 | 文本脱嵌处理 (物理脱嵌 bare/full) |
| 2 | LLM | 裸文审计（2个维度，注入 Turn 1 联网上下文） |
| 3 | LLM | 全文审计（所有维度，注入 Turn 1 联网上下文） |
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
| Step 0b | `src/prompts/reviewWizard.ts` | `buildGlobalStep0Prompt()` / `buildOrchestrationStep0Prompt()` |
| Step 0c | `src/tools/reviewContentWizardTool.ts` | `runUnifiedWebSearch()` |
| Step 1 | `src/utils/stripContext.ts` | `stripContext()` |
| Step 2-3 | `src/tools/reviewContentWizardTool.ts` | `runSystemAuditors()` |
| Step 4 | `src/tools/reviewContentWizardTool.ts` | `executeLlmSystemAudit()` |
| Step 5 | `src/tools/reviewContentWizardTool.ts` | `mergeLocalFindingsIntoAudits()` |
| Step 6 | `src/tools/reviewContentWizardTool.ts` | `crossValidateRiskyDimensions()` |
| Step 7 | `src/execution/synergyCalculator.ts` | `calculateSynergy()` |
| Step 8 | `src/tools/reviewContentWizardTool.ts` | `finalizePreAuditReport()` / `buildPreAuditFinalizerPrompt()` |

## 联网验证说明

在重构后的 Pipeline 中，联网搜索被集中在 **Turn 1 (第一轮交互)** 统一进行，避免在沙盒执行（Step 2-3）和本地规则合并（Step 5）阶段多次发起碎片化的串行请求。

### 统一并发联网检索（Step 0c）

在 Step 0a (本地规则匹配) 和 Step 0b (LLM 全局解码) 完成后，系统会收集：
1. 本地规则引擎命中的高危/敏感词汇关键词。
2. Step 0 全局解码输出的 `blackAtoms` (黑料原子词) 及 `attackCandidates` 关键词。

所有收集到的关键词（最大并发限制为 10 个）将在 **Step 0c** 阶段通过 `runUnifiedWebSearch()` 并发调用联网搜索，返回一个 `Record<string, string>` 映射表。

### 联网上下文注入（Step 2-3）

在 Turn 2 执行沙盒审计时，`runSystemAuditors()` 会根据 Step 0c 的搜索结果，自动为每一个系统审计员（如 `network_culture_risk`）构建相关的 `webContext` 文本并注入到审计提示词中。审计员无需自行联网，即可在包含真实现实网络背景的情况下对文本进行研判。

### 结果合并（Step 5）

由于所有的联网验证和语境查询已经在 Turn 1 阶段完成，**Step 5 简化为纯代码内存合并**。`mergeLocalFindingsIntoAudits()` 只需将本地规则匹配结果同步合并至最终审计维度的 findings 中，无需发起任何网络请求。

### 实现细节

| 项目 | 说明 |
|------|------|
| 搜索引擎 | DuckDuckGo 即时搜索 API（通过 `webSearchFn` 传入） |
| 超时保护 | 5000ms 级别，超时后降级返回空结果 |
| 结果标注 | 最终初审结果中会统计 `webSearchDimensions` 以记录生效的维度 |
