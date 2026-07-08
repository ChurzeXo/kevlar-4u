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

### 1.3 字段清单（14 个字段）

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
    "freeTierUpgradePrompt": "",
    "coreReasoningFramework": "## 【核心思维框架切换：攻防风险模拟分析模式】\n...",
    "coreFrameworkSteps": "【第一步：风险冷读（必须先于一切具体检查执行）】\n...",
    "globalStep0Protocol": "# [SYSTEM PROTOCOL] 风险模拟逆向解码协议（Turn 1 全局解码）\n...",
    "globalStep0Message": "## 【待测文案】\n...\n请严格执行并输出纯 JSON："
  }
}
```

> **Pro 版与 Free 版区别**：Pro 的 `precedentLockedMessage` 为空（允许输出真实品牌名），Free 的为 `"🔒 类似先例已锁定..."`。
> **新增 4 个字段**：`coreReasoningFramework`, `coreFrameworkSteps`, `globalStep0Protocol`, `globalStep0Message` — 对应 `reviewWizard.ts` 中已提取的攻防链提示词。Free 版内容见 `skills/templates/free.json`。

---

## 二、Pro 规则集 — 策略包 `rules` 字段

### 2.1 现状

开源仓库中已删除所有本地规则文件（`rules_free.json`、`rules_pro.json`、`rules_sensitive.json`、`rules_lowbrow.json`）。客户端 `RuleRepository` 现在从策略包缓存 (`skills/strategy-bundle-cache.enc`) 读取规则。

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

## 四、Prompt 库提取 ✅ 已完成

### 4.1 已提取

`src/prompts/reviewWizard.ts` 中 4 个核心攻防链函数已重构为 `PromptSegments` 字段：

| 函数 | 对应字段 | 状态 |
|---|---|---|
| `buildCoreReasoningFramework()` | `coreReasoningFramework` | ✅ 已提取 |
| `buildCoreFrameworkSteps()` | `coreFrameworkSteps` | ✅ 已提取 |
| `buildGlobalStep0Prompt()` | `globalStep0Protocol` | ✅ 已提取 |
| `buildGlobalStep0Message()` | `globalStep0Message` | ✅ 已提取 |

函数签名改为 `(prompts?: PromptSegments)`，未传入时自动从 `skills/templates/free.json` 加载默认值。

### 4.2 后端需配合

策略包的 `templates` 字段需包含以上 4 个新字段。Free 版内容参考 `skills/templates/free.json`。Pro 版可在服务端增强（更多攻击场景、更激进的推演逻辑等）。

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

| 优先级 | 项目 | 状态 | 说明 |
|---|---|---|---|
| P0 | 策略包 `templates` 字段 | 📦 数据已就绪 | 15 个 PromptSegments 字段已打包在 `.kevlar_upload_bundle.json` |
| P1 | 策略包 `rules` 字段 | 📦 数据已就绪 | 12 规则类 + 9 语义基元 + 9 结构模式，同上文件 |
| P2 | 管理 API | 🔧 待实现 | `POST /api/v1/admin/templates` — 上传端点 |

**执行方式**：后端建好 `POST /api/v1/admin/templates` 端点后，POST `.kevlar_upload_bundle.json` 内容即可。客户端 `--sync` 会自动拉取最新策略包。

详见 `.kevlar_backend_task.md`（可直接发给后端开发）。
