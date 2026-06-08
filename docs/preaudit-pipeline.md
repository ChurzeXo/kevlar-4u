# 初审流程（Pre-Audit Pipeline）

## 流程图

```
Step 0: 本地规则引擎
═══════════════════════════════════════════════════════════════════
  │  0.1 时机节点检测 ──────────────► timingFinding?
  │  0.2 2-4 gram 滑动窗口匹配 ────► variantMatches[]
  │  0.3 L2 结构模式检测 ──────────► structuralMatches[]
  │
  │  输出：localFindings[]
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
  │
  │  输出：bareFindings[]
  ▼
Step 3: 全文审计
═══════════════════════════════════════════════════════════════════
  │  runSystemAuditors(full, [所有 system_auditors])
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
Step 5: 合并 + 联网验证
═══════════════════════════════════════════════════════════════════
  │  mergeLocalFindingsIntoAuditsAsync(auditorResults, localFindings, webSearchConfig)
  │  ├─ 本地规则 findings 注入到 network_culture_risk 维度
  │  └─ 对高危(🔴/🟡) findings 执行联网验证
  │     ├─ network_culture_risk: 识别数字暗语、验证平台文化背景
  │     └─ factual_integrity: 验证事实性声明
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
| 0 | 代码 | 本地规则匹配 |
| 1 | 代码 | 文本脱嵌处理 |
| 2 | LLM | 裸文审计（2个维度） |
| 3 | LLM | 全文审计（所有维度） |
| 4 | 代码 | Delta 信号提取 |
| 5 | 代码 | 结果合并 + 联网验证 |
| 6 | LLM | 交叉验证 |
| 7 | 代码 | 协同加权计算 |
| 8 | LLM | 最终仲裁聚合 |
| 9 | 代码 | 展示给用户 |

## 核心文件

| 步骤 | 文件 | 函数 |
|------|------|------|
| Step 0 | `src/tools/reviewContentWizardTool.ts` | `buildLocalRuleFindings()` |
| Step 1 | `src/utils/stripContext.ts` | `stripContext()` |
| Step 2-3 | `src/tools/reviewContentWizardTool.ts` | `runSystemAuditors()` |
| Step 4 | `src/tools/reviewContentWizardTool.ts` | `executeLlmSystemAudit()` |
| Step 5 | `src/tools/reviewContentWizardTool.ts` | `mergeLocalFindingsIntoAuditsAsync()` |
| Step 5 (联网) | `src/execution/webSearch.ts` | `getWebContextForAuditor()` |
| Step 6 | `src/tools/reviewContentWizardTool.ts` | `crossValidateRiskyDimensions()` |
| Step 7 | `src/execution/synergyCalculator.ts` | `calculateSynergy()` |
| Step 8 | `src/tools/reviewContentWizardTool.ts` | `finalizePreAuditReport()` |

## 联网验证说明

联网搜索在两个阶段执行：

### 阶段一：系统审计员执行时（Step 2-3）

`runSystemAuditors()` 中，对支持的维度注入联网上下文：

| 维度 | 搜索内容 | 提取逻辑 |
|------|---------|---------|
| `network_culture_risk` | 数字暗语、谐音梗、缩写、Emoji 组合 | `extractSuspiciousTerms()` |
| `factual_integrity` | 数字数据、引用声明、时间声明 | `extractFactClaims()` |

搜索结果作为 `webContext` 注入到审计员的 prompt 中，增强识别准确性。

### 阶段二：本地规则合并时（Step 5）

`mergeLocalFindingsIntoAuditsAsync()` 中，对高危(🔴/🟡) findings 执行联网验证：

| 维度 | 联网验证内容 |
|------|-------------|
| `network_culture_risk` | 验证本地规则匹配到的关键词是否为真实网络用语 |
| `factual_integrity` | 验证事实性声明的准确性 |

### 实现细节

| 项目 | 说明 |
|------|------|
| 搜索引擎 | DuckDuckGo 即时搜索 API（无需 API key） |
| 超时保护 | 5000ms，超时后降级返回空结果 |
| 可选功能 | 需要传入 `webSearchFn` 才会启用 |
| 结果标注 | 初审结果中显示 `🔍 联网验证维度：xxx` |

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/execution/webSearch.ts` | DuckDuckGo 搜索实现、关键词提取、结果格式化 |
| `src/tools/reviewContentWizardTool.ts` | 调用联网搜索、追踪搜索维度、展示搜索状态 |
