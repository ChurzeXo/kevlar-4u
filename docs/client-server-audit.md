# Kevlar-4u 客户端-服务端交互审计文档

版本: 客户端 v1.5.3 → 即将 v1.6
日期: 2026-06-21

---

## 目的

客户端近期完成了 Free/Pro 架构重构，所有 Pro IP（规则、提示词）已从开源仓库删除，改为从服务端动态获取。本文档列出所有客户端-服务端交互端点及其合约，供后端团队系统审计。

---

## 端点总览

| 端点 | 方法 | 用途 | 客户端调用位置 |
|---|---|---|---|
| `/api/v1/activate` | POST | 激活 Pro 许可证 | `src/pro/src/credential/activationClient.ts:49` / `scripts/credentialCli.ts:297` |
| `/api/v1/strategy/session` | POST | 创建同步会话 | `src/pro/src/credential/syncClient.ts:58` |
| `/api/v1/strategy/bundle/:id` | GET | 下载策略包 | `src/pro/src/credential/syncClient.ts:99` |
| `/api/v1/revocation/bundle-hashes` | GET | 吊销列表 | `src/pro/src/credential/syncClient.ts:36` |
| `/api/v1/subscription-prompts` | GET | Pro 提示词段 | `src/utils/saasClient.ts:16` |
| `/api/v1/admin/seed` | GET | 生成测试激活码 | 开发用 |
| `/api/v1/admin/templates` | POST | 上传规则/模板 | 开发用（新） |

---

## 一、`POST /api/v1/activate`

### 请求

```json
{
  "activationCode": "KV-ACT-XXXX-EXPIRES-30MIN",
  "installationId": "uuid-v4"
}
```

### 期望响应

```json
{
  "licenseKey": "lk_xxx",
  "refreshToken": "rt_xxx",
  "expiresAt": "2027-06-21T00:00:00Z"
}
```

### 错误响应

```json
{
  "error": {
    "code": "ACTIVATION_FAILED",
    "message": "激活码已过期或无效"
  }
}
```

### 客户端行为

- 超时: 10s (`AbortSignal.timeout(10000)`)
- 成功: 保存 AES-256-GCM 加密凭证到 `~/.kevlar-credentials`
- 服务端不可达: 降级生成本地凭证（`local-xxx`），365 天有效期
- 激活后自动尝试下载策略包

---

## 二、`POST /api/v1/strategy/session`

### 请求

```json
{
  "installationId": "uuid",
  "sessionId": "sync-xxxxxxxx",
  "clientVersion": "1.5.3",
  "locale": "zh-CN",
  "currentStrategyHash": "abc123"  // 可选，用于 304
}
```

### 期望响应

```json
{
  "strategySessionId": "ss_xxx",
  "bundleId": "bnd_v1_xxx",
  "sessionNonce": "nonce_xxx",
  "expiresAt": "2026-07-05T00:00:00Z",
  "watermarkToken": "wm_xxx",
  "canaryToken": "cn_xxx"
}
```

### 304 Not Modified

客户端传入 `currentStrategyHash` 时，服务端应返回 304（策略未变）。客户端 `syncClient.ts:76` 已支持：

```typescript
if (sessionRes.status === 304) {
  return { ok: true, status: "already_latest" };
}
```

### 客户端行为

- ⚠️ **sessionId 长度限制**: 服务端可能限制 128 字符。客户端生成的 sessionId 为 `sync-` + 8 位 hex，长度远低于此限制。
- `sessionNonce` 兼容: 客户端使用 `session.sessionNonce ?? session.nonce` 兜底

---

## 三、`GET /api/v1/strategy/bundle/:bundleId`

### 请求头

```
Authorization: Bearer <refreshToken>
X-Nonce: <sessionNonce>
```

### 期望响应 — 策略包格式

```json
{
  "formatVersion": "kevlar-strategy-bundle-v1",
  "bundleId": "bnd_v1_xxx",
  "version": "1.1.0",
  "tier": "pro",
  "steps": [
    "local_rules",
    "orchestration_step0",
    "strip_context",
    "bare_audit",
    "full_audit",
    "delta_analysis",
    "merge_local_findings",
    "cross_validation",
    "synergy_weighting",
    "final_arbitration",
    "display"
  ],
  "visibility": {
    "preAuditDetails": "full",
    "rstContinuationPrompt": "after_pre_audit",
    "upgradePrompt": "disabled"
  },

  "templates": {
    // ⚠️ 审计重点 — 16 个 PromptSegments 字段
    "precedentSectionHeader": "...",
    "precedentLockedMessage": "",
    "precedentNoneMessage": "...",
    "finalRenderPrecedentInstruction": "...",
    "orchestrationMetaRuleItem4": "...",
    "orchestrationStep8Item4": "...",
    "finalizerCoreItem4": "...",
    "precedentLockedCn": "",
    "precedentLockedEn": "",
    "freeTierUpgradePrompt": "",
    "freeTierUpgradeHint": "...",
    "coreReasoningFramework": "...",
    "coreFrameworkSteps": "...",
    "globalStep0Protocol": "...",
    "globalStep0Message": "..."
  },

  "rules": {
    // ⚠️ 审计重点 — 新格式（从旧 { pro, sensitive, lowbrow } 迁移）
    "categories": {
      "core_free": {
        "name": "...",
        "severity": "HIGH",
        "associative_map": [
          { "root": "木耳", "variants": ["粉木耳"], "misinterpret_direction": "涉黄风险", "severity": "HIGH", "base_score": 0.85 }
        ],
        "multi_hop_patterns": [
          { "pattern": ["词A", "词B"], "risk": "组合风险描述" }
        ]
      }
    },
    "semantic_primes": {
      "color": { "description": "颜色类单字", "words": ["粉","黑","红","黄"...] },
      "anatomy": { "description": "身体部位单字", "words": ["耳","唇","舌"...] },
      "anatomy_double": { "description": "身体部位双字词", "words": ["木耳","菊花"...] },
      "texture": { "...": {} },
      "liquid": { "...": {} },
      "action": { "...": {} },
      "size": { "...": {} },
      "temperature": { "...": {} },
      "sound": { "...": {} }
    },
    "structural_patterns": [
      {
        "id": "color_anatomy_adjacent",
        "description": "颜色单字 + 身体单字 相邻",
        "severity": "MEDIUM",
        "requiredCategories": ["color", "anatomy"],
        "windowSize": 3,
        "risk_type": "生造词低俗联想",
        "auto_red": false
      }
    ],
    "version": "1.1.0",
    "last_updated": "2026-06-21T00:00:00Z"
  },

  "synergyRules": [
    {
      "dimensions": ["network_culture_risk", "context_distortion"],
      "condition": "ALL",
      "multiplier": 2.0,
      "upgradeLevel": true,
      "label": "暗语+脱嵌联合风险"
    }
  ],
  "dimensionMultipliers": {
    "legal_compliance": 1.0,
    "social_risk": 1.0
  },

  "strategySessionId": "ss_xxx",
  "strategyHash": "hex-hash-string",
  "issuedAt": "2026-06-21T00:00:00Z",
  "expiresAt": "2026-07-21T00:00:00Z",
  "gracePeriodHours": 336,
  "graceExpiresAt": "2026-08-04T00:00:00Z",
  "watermarkToken": "wm_xxx",
  "canaryToken": "cn_xxx",
  "sessionNonce": "nonce_xxx",
  "bundleSignature": "base64-signature"
}
```

### 签名验证

客户端验证 HMAC-SHA256 + Ed25519 双重签名：

1. **首要路径 — HMAC-SHA256**: 使用 `canonicalJSONDeep`（递归 sort）序列化整个 bundle（不含 `bundleSignature`），**保留原始 `strategyHash`**（不置零），计算 HMAC
2. **回退路径 — Ed25519**: 尝试 4 种组合：deep canonical / array-replacer × 原始 strategyHash / 置零 strategyHash

**签名密钥**：
- HMAC secret: 环境变量 `KEVLAR_BUNDLE_SIGNING_SECRET`，默认 `"kevlar-bundle-signing-dev"`
- Ed25519 公钥: 硬编码在 `src/pro/src/strategyBundle.ts:5-7`

### 哈希互认

- `computeBundleHash()`: `SHA256(canonicalJSONDeep(data)).digest("hex")`
- `strategyHash`: 取哈希前 16 位
- `computePlanFingerprintFromBundle()`: `SHA256(kevlar-plan-{tier}-{steps}-{bundleId})` 前 16 位

---

## 四、`GET /api/v1/revocation/bundle-hashes`

### 期望响应

```json
{
  "revokedHashes": ["hash1", "hash2"]
}
```

客户端检查 `bundle.strategyHash` 和 `bundle.bundleId` 是否在列表中。

### 客户端行为

- 吊销检查为尽力型（best-effort），失败不阻塞同步
- 超时: 8s

---

## 五、`GET /api/v1/subscription-prompts` ⚠️ 新端点

### 请求

```
GET /api/v1/subscription-prompts?locale=zh-CN
Authorization: Bearer <refreshToken>
```

### 期望响应

```json
{
  "prompts": {
    // 完整 PromptSegments（16 字段，同策略包 templates）
    "precedentSectionHeader": "...",
    "precedentLockedMessage": "...",
    "...": "...",
    "freeTierUpgradeHint": "...",
    "coreReasoningFramework": "...",
    "coreFrameworkSteps": "...",
    "globalStep0Protocol": "...",
    "globalStep0Message": "..."
  }
}
```

### 客户端行为

- 调用方: `SaaSClient.fetchSubscriptionPrompts()` (`src/utils/saasClient.ts:10`)
- 超时: 3s
- 缓存: 按 URL 缓存（不改 locale 则复用）
- 失败: 返回 null，调用方降级到 `loadPromptSegments("free")`
- 仅在 `isPro() === true` 时调用

---

## 六、`POST /api/v1/admin/templates` ⚠️ 新端点

### 请求

```
POST /api/v1/admin/templates
Authorization: Bearer <admin_api_key>

{
  "version": "1.1.0",
  "description": "...",
  "templates": { /* 16 PromptSegments 字段 */ },
  "rules": {
    "categories": { ... },
    "semantic_primes": { ... },
    "structural_patterns": [ ... ],
    "version": "1.1.0",
    "last_updated": "2026-06-21T00:00:00Z"
  }
}
```

### 期望响应

```json
{
  "ok": true,
  "version": "1.1.0",
  "updatedAt": "2026-06-21T12:00:00Z"
}
```

---

## 七、数据格式变更审计清单

### 策略包 `rules` 字段重构 ⚠️ BREAKING

| 方面 | 旧格式 | 新格式 |
|---|---|---|
| 结构 | `{ pro: {...}, sensitive: {...}, lowbrow: {...} }` | `{ categories: {...}, semantic_primes: {...}, structural_patterns: [...], version, last_updated }` |
| 规则来源 | 三个独立文件，不同 schema | 统一合并到 `categories` 字典，`semantic_primes` + `structural_patterns` 独立 |
| 版本控制 | 各文件各自 version | 统一 `version` + `last_updated` |

**客户端已适配**：`RuleRepository.loadRules()` 只读取新格式。

### 策略包 `templates` 字段扩充

| 指标 | 旧 | 新 |
|---|---|---|
| PromptSegments 字段数 | 10 | 16 |
| 新增字段 | — | `freeTierUpgradeHint`, `coreReasoningFramework`, `coreFrameworkSteps`, `globalStep0Protocol`, `globalStep0Message` |

### 规则文件删除（客户端）

以下文件已从开源仓库删除，必须由服务端策略包提供：

- `skills/rules_free.json` → rules.categories
- `skills/rules_pro.json` → rules.categories
- `skills/rules_sensitive.json` → rules.categories
- `skills/rules_lowbrow.json` → rules.semantic_primes + rules.structural_patterns
- `skills/templates/pro.json` → templates (via subscription-prompts)

---

## 八、本地联调步骤

```bash
# 1. 修改客户端配置指向本地服务
echo '{"cloud_server_url":"http://localhost:3000","mode":"auto"}' > skills/kevlar-config.json

# 2. 获取测试激活码
curl http://localhost:3000/api/v1/admin/seed

# 3. 激活 + 同步
npx tsx scripts/cli.ts --activate --code <code>
npx tsx scripts/cli.ts --sync

# 4. 上传规则包
curl -X POST http://localhost:3000/api/v1/admin/templates \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer kevlar-admin-api-dev" \
  -d @.kevlar_upload_bundle.json

# 5. 重新同步（验证规则包已更新）
npx tsx scripts/cli.ts --sync

# 6. 诊断
npx tsx scripts/cli.ts --doctor
```

### 验证检查点

- [ ] strategy bundle 包含 `rules.categories`（非空）
- [ ] strategy bundle 包含 `rules.semantic_primes`（9 类）
- [ ] strategy bundle 包含 `rules.structural_patterns`（9 条）
- [ ] `templates` 包含 16 个 PromptSegments 字段
- [ ] HMAC-SHA256 签名验证通过
- [ ] 304 响应正确（二次 sync 返回 `already_latest`）
- [ ] `subscription-prompts` 返回完整 PromptSegments
- [ ] `admin/templates` POST 上传成功，重新 sync 拉取新版本
