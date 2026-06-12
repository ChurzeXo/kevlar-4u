# 类似先例功能（Precedents Feature）

## 概述

在最坏情况推演后，展示类似舆情事件先例，引导用户自行搜索详情。

## 输出格式

```
🚨 最坏情况推演
[原有 worstCaseNarrative 内容]

📌 类似先例（供自行检索）：
• 2024年某品牌低俗广告事件（2024-03）
• 2023年某平台物化女性争议（2023-11）
```

## 数据结构

```typescript
export interface Precedent {
  event: string;  // 事件名称
  date?: string;  // 事件时间（可选）
}
```

## 修改文件

### 1. `src/prompts/reviewWizard.ts`

**新增接口**（第 14-17 行）：
```typescript
export interface Precedent {
  event: string;
  date?: string;
}
```

**Step0Result 扩展**（第 24 行）：
```typescript
export interface Step0Result {
  wildTranslations: WildTranslation[];
  blackAtoms: string[];
  attackCandidates: Step0Finding[];
  precedents?: Precedent[];  // 新增
}
```

**OrchestrationPreAuditContext 扩展**（第 311 行）：
```typescript
export interface OrchestrationPreAuditContext {
  localFindings: any[];
  stripped: StrippedContent;
  step0Result?: Step0Result;
  webContextMap?: Record<string, string>;
  precedents?: Precedent[];  // 新增
}
```

**buildOrchestrationStep0Prompt 修改**（第 463-472 行）：

在"联网搜索要求"后新增先例搜索指令：
```markdown
### 类似事件先例检索
在完成 blackAtoms 搜索后，请额外搜索类似舆情事件：
  - 搜索关键词："{品牌/产品名} + {风险类型} + 舆情 事件 翻车"
  - 示例："盒马 粉木耳 争议"、"品牌 低俗营销 翻车"
  - 返回 1-3 个最相关的历史事件，格式见 precedents 字段
```

输出格式增加 precedents 字段（第 497-501 行）：
```json
"precedents": [
  {
    "event": "2024年某品牌低俗广告事件",
    "date": "2024-03",
  },
]
```

### 2. `src/tools/reviewContentWizardTool.ts`

**导入 Precedent 类型**（第 25 行）：
```typescript
import {
  ...
  type Precedent,
  ...
} from "../prompts/reviewWizard.js";
```

**handleOrchestrationStep0Result 解析 precedents**（第 408-419 行）：
```typescript
// precedents is provided by host AI (from its own web search)
const precedents: Precedent[] = [];
if (Array.isArray(parsed.precedents)) {
  for (const item of parsed.precedents) {
    if (item && typeof item === "object" && typeof item.event === "string") {
      precedents.push({
        event: item.event,
        date: typeof item.date === "string" ? item.date : undefined,
      });
    }
  }
}
```

**buildOrchestrationPreAuditContext 传递 precedents**（第 369 行）：
```typescript
function buildOrchestrationPreAuditContext(
  content: string,
  localFindings: any[],
  step0Result?: Step0Result,
  webContextMap?: Record<string, string>,
  precedents?: Precedent[],  // 新增
): OrchestrationPreAuditContext {
  return {
    localFindings,
    stripped: stripContext(content),
    step0Result,
    webContextMap,
    precedents,  // 新增
  };
}
```

**PreAuditReport 接口扩展**（第 898 行）：
```typescript
interface PreAuditReport {
  ...
  precedents?: Precedent[];  // 新增
}
```

**executeLlmSystemAudit 传递 precedents**（第 504 行）：
```typescript
async function executeLlmSystemAudit(
  content: string,
  systemAuditors: Persona[],
  localFindings: any[],
  caller: AuditLlmCaller,
  step0Result: Step0Result | undefined,
  webContextMap: Record<string, string>,
  precedents?: Precedent[],  // 新增
  timingContext?: string,
  sendProgress?: (message: string) => void,
): Promise<PreAuditReport> {
```

**finalizePreAuditReport 传递 precedents**（第 948 行）：
```typescript
const report = await finalizePreAuditReport(
  content,
  localFindings,
  mergedResults,
  crossValidatedResults,
  systemAuditors,
  caller,
  synergy,
  deltaRisks,
  precedents,  // 新增
);
```

## 数据流

```
宿主 AI 联网搜索
       ↓
  precedents JSON
       ↓
handleOrchestrationStep0Result 解析
       ↓
buildOrchestrationPreAuditContext 传递
       ↓
executeLlmSystemAudit → finalizePreAuditReport
       ↓
  PreAuditReport.precedents
       ↓
  输出到用户
```

## 三种模式对齐

| 模式 | 搜索执行者 | 数据流 |
|------|-----------|--------|
| 编排模式 | 宿主 AI | Turn 1 返回 precedents → Turn 2/3 注入 |
| Direct API | 宿主 AI | 同上（首轮宿主交互） |
| MCP Sampling | 宿主 AI | 同上（sampling 客户端） |

## 容错处理

- 宿主返回不含 `precedents`：空数组，不影响流程
- `precedents` 格式错误：容错过滤，只保留合法项
- 无搜索工具的宿主：`precedents` 为空

## 测试

- TypeScript 检查通过
- 222 个测试全部通过
