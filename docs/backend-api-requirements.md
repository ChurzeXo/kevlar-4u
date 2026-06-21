# Kevlar-4u 后端 API 需求文档

版本: v1.5 → v1.6
日期: 2026-06-21

---

## 背景

客户端已将所有 Pro 级 IP（提示词、规则、策略）从开源仓库中删除，改为从后端服务动态获取。以下为后端需要新增或适配的 API。

---

## 一、策略包 `templates` 字段 — Pro 提示词段

### 1.1 现状

客户端 `PromptSegments` 接口定义了 10 个字段，Free 版从 `skills/templates/free.json` 加载，Pro 版通过 `SaaSClient.fetchSubscriptionPrompts()` 从 `GET /api/v1/subscription-prompts` 获取。

### 1.2 需求

策略包（`GET /api/v1/strategy/bundle/:bundleId`）的 `templates` 字段需包含完整的 `PromptSegments` JSON。

### 1.3 字段清单

```json
{
  "templates": {
    "precedentSectionHeader": "📌 类似先例（供自行检索）",
    "precedentLockedMessage": "",
    "precedentNoneMessage": "暂未检索到类似案例",
    "finalRenderPrecedentInstruction": "如果 JSON 中 precedents 数组非空，后接 bullet 列表...",
    "orchestrationMetaRuleItem4": "4. 本轮职责：执行 Step 6 + Step 8...",
    "orchestrationStep8Item4": "4. **场景推演**：生成攻击链分析及最坏情况舆情传播剧本...",
    "finalizerCoreItem4": "4. 场景推演：生成攻击链分析及最坏舆情剧本...",
    "precedentLockedCn": "",
    "precedentLockedEn": "",
    "freeTierUpgradePrompt": ""
  }
}
```

> **Pro 版与 Free 版区别**：Pro 的 `precedentLockedMessage` 为空（允许输出真实品牌名），Free 的为 `"🔒 类似先例已锁定..."`。

---

## 二、Pro 规则集 — 策略包 `rules` 字段

### 2.1 现状

开源仓库中已删除 `rules_pro.json`、`rules_sensitive.json`、`rules_lowbrow.json`。客户端 `LocalJsonRuleRepository` 仍会尝试从 `skills/` 目录加载这些文件。

### 2.2 需求

策略包新增 `rules` 字段，或在 `GET /api/v1/subscription-prompts` 响应中返回。

建议格式：

```json
{
  "rules": {
    "pro": { /* rules_pro.json 内容 */ },
    "sensitive": { /* rules_sensitive.json 内容 */ },
    "lowbrow": { /* rules_lowbrow.json 内容 */ }
  }
}
```

### 2.3 字段说明

| 字段 | 原文件 | 用途 |
|---|---|---|
| `rules.pro` | `rules_pro.json` | Pro 版高级规则：实时热点 + 复杂场景多跳联想 |
| `rules.sensitive` | `rules_sensitive.json` | 政治/敏感话题规则：历史事件、领土主权、意识形态等 |
| `rules.lowbrow` | `rules_lowbrow.json` | 低俗擦边语义规则：颜色+身体词组合、感官堆叠检测 |

### 2.4 客户端加载逻辑

客户端 `isPro()` 返回 `true` 时，规则应从服务端加载替代本地文件。Pro 包中的 `StrategyProvider` 应提供 `getRules()` 方法。

---

## 三、管理 API — Pro 内容上传与更新（新增）

### 3.1 需求

后期 Pro 提示词、规则集会持续迭代，需要一个管理后台 API 用于上传更新。

### 3.2 建议端点

```
POST /api/v1/admin/templates
```

**请求体**：
```json
{
  "prompts": { /* PromptSegments JSON */ },
  "rules": {
    "pro": { /* rules_pro.json 内容 */ },
    "sensitive": { /* rules_sensitive.json 内容 */ },
    "lowbrow": { /* rules_lowbrow.json 内容 */ }
  },
  "version": "1.1.0",
  "description": "更新日志描述"
}
```

**认证**：Admin API Key（`Authorization: Bearer <admin_key>`）

**响应**：
```json
{
  "ok": true,
  "version": "1.1.0",
  "updatedAt": "2026-06-21T12:00:00Z"
}
```

### 3.3 备选方案

如果不想新增 API，可以在服务器端直接编辑策略包模板文件，触发 `--sync` 时客户端自然获取最新版。

---

## 四、Prompt 库提取（v1.6 规划）

### 4.1 现状

`src/prompts/reviewWizard.ts`（1,094 行）包含核心攻防链提示词，硬编码在函数体中：

| 函数 | 行数 | 内容 |
|---|---|---|
| `buildCoreReasoningFramework()` | 212-228 | 职业黑粉核心思维框架 |
| `buildCoreFrameworkSteps()` | 235-248 | 冷读攻击步骤 |
| `buildGlobalStep0Prompt()` | 387-426 | 全局逆向解码协议 |
| `buildGlobalStep0Message()` | 433-475 | 断章取义三步走 |
| `buildOrchestrationStep0Prompt()` | 504-559 | Turn 1 编排提示词 |
| `buildOrchestrationFinalizerPrompt()` | 774-870 | Turn 3 交叉验证+仲裁 |
| `buildPreAuditFinalizerPrompt()` | 1042-1093 | 最终仲裁提示词 |
| `buildIsolatedSystemAuditorPrompt()` | 873-923 | 单维度审计员提示词 |

### 4.2 提取方案

将以上提示词的**文本内容**提取为 `PromptSegments` 的新增字段，函数体中用 `segments.xxx` 替换硬编码字符串。Pro 版 `segments` 从策略包获取，Free 版从 `free.json` 获取。

### 4.3 新增 PromptSegments 字段（预估）

```
coreFrameworkText: string          // 职业黑粉核心思维框架
coreFrameworkSteps: string         // 冷读攻击步骤
globalDecodeProtocol: string       // 全局逆向解码协议
globalDecodeMessage: string        // 断章取义三步走
orchestrationStep0Prompt: string   // Turn 1 编排提示词
orchestrationFinalizerPrompt: string // Turn 3 交叉验证+仲裁
preAuditFinalizerPrompt: string    // 最终仲裁提示词
systemAuditorPromptTemplate: string // 单维度审计员提示词模板
```

---

## 五、现有 API 适配检查

### 5.1 `GET /api/v1/subscription-prompts`

客户端 `SaaSClient.fetchSubscriptionPrompts()` 调用此端点。

**需确认**：
- 响应格式为 `{ "prompts": { /* PromptSegments */ } }`
- 支持 `?locale=zh-CN` 和 `?locale=en-US` 参数
- Authorization header 校验

### 5.2 `POST /api/v1/strategy/session`

**需确认**：
- `currentStrategyHash` 支持 304 响应（客户端已实现）
- `sessionNonce` 字段名保持一致（客户端用 `session.sessionNonce ?? session.nonce` 兜底）

### 5.3 `GET /api/v1/strategy/bundle/:bundleId`

**需确认**：
- `templates` 字段返回完整 PromptSegments（见第一章）
- HMAC-SHA256 签名使用 `canonicalJSONDeep` + 原始 `strategyHash`

---

## 六、优先级排序

| 优先级 | 项目 | 原因 |
|---|---|---|
| P0 | 策略包 `templates` 字段补充 | Pro 激活后无本地 pro.json，依赖后端提供 |
| P1 | Pro 规则集通过策略包下发 | 规则文件已从开源仓库删除 |
| P2 | 管理 API | 方便后期迭代，但非阻塞 |
| P3 | Prompt 库提取（v1.6） | 改动量大，需客户端+后端联动 |
