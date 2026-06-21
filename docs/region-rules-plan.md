# 规则引擎国际化方案（Region Rules）

## 背景

当前规则引擎 (`RuleRepository`) 从策略包加载全局规则，不区分目标地区。但实际内容审核高度依赖地区语境——中国市场的政治敏感词在欧美市场无意义，反之亦然。

跨国品牌（如 Nike、Apple）发布中文内容时，需要同时加载中国市场规则和全球通用规则。

## 设计目标

1. 规则按地区（zh-CN / en-US / global）分层
2. 客户端根据内容语言或用户配置自动选择适用的规则集
3. 跨国场景支持叠加多个地区规则
4. 改动量控制在 `RuleRepository` + 策略包数据结构内

---

## 方案

### 一、策略包 `rules` 结构变化

**当前**：
```json
{
  "rules": {
    "categories": {
      "core_free": { "associative_map": [...] },
      "political": { "associative_map": [...] }
    },
    "semantic_primes": { "color": {...}, "anatomy": {...} },
    "structural_patterns": [...]
  }
}
```

**改为**：
```json
{
  "rules": {
    "regions": {
      "zh-CN": {
        "categories": {
          "political_sensitive": { "associative_map": [...] },
          "lowbrow_cn": { "associative_map": [...] }
        },
        "semantic_primes": {},
        "structural_patterns": []
      },
      "en-US": {
        "categories": {
          "racial_sensitive": { "associative_map": [...] },
          "western_ad_law": { "associative_map": [...] }
        },
        "semantic_primes": {},
        "structural_patterns": []
      },
      "global": {
        "categories": {
          "universal_vulgar": { "associative_map": [...] }
        },
        "semantic_primes": {
          "color": {"words": ["粉","黑","red","black"]},
          "anatomy": {"words": ["耳","唇","ear","lip"]}
        },
        "structural_patterns": [...]
      }
    }
  }
}
```

### 二、Region 解析逻辑

客户端新增 `resolveRegions()` 函数：

```typescript
type RuleRegion = "zh-CN" | "en-US" | "ja-JP" | "ko-KR" | "global";

function resolveRegions(content: string, configHint?: string): RuleRegion[] {
  const regions: RuleRegion[] = ["global"]; // 始终加载

  // 1. 手动指定（环境变量 / 工具参数）
  if (process.env.KEVLAR_REGION) {
    return [...new Set([...process.env.KEVLAR_REGION.split(","), "global"])];
  }

  // 2. 自动检测：内容语言
  const detected = detectContentRegion(content);
  if (detected) regions.push(detected);

  return regions;
}
```

语言检测逻辑（轻量）：
- 中日韩字符占比 > 30% → `zh-CN`（或 `ja-JP`/`ko-KR` 通过 Unicode block 细分）
- 全 ASCII / 拉丁字符 → `en-US`

### 三、`RuleRepository` 改动

`loadRules()` 改为按 region 合并：

```typescript
async loadRules(customBundle?: any, regions?: RuleRegion[]): Promise<boolean> {
  const bundle = customBundle ?? await loadStrategyBundle(this.skillsDir);
  const activeRegions = regions ?? resolveRegions(contentForDetection);
  const regionData = bundle?.rules?.regions ?? {};

  // 合并 global + zh-CN + ... → 统一索引
  let allCategories: Record<string, RuleCategory> = {};
  let allSemanticPrimes: Record<string, string[]> = {};
  let allStructuralPatterns: StructuralPattern[] = [];

  for (const region of activeRegions) {
    const data = regionData[region];
    if (!data) continue;
    Object.assign(allCategories, data.categories ?? {});
    Object.assign(allSemanticPrimes, data.semantic_primes ?? {});
    allStructuralPatterns.push(...(data.structural_patterns ?? []));
  }

  // 去重 + 冲突处理：后加载覆盖先加载（global 被 zh-CN 覆盖）
  // 构建索引（与现有逻辑相同）
}
```

### 四、reviewContentWizard 集成

```typescript
// Step 0a: rule engine matching
async function buildRuleFindings(skillsDir: string, content: string): Promise<any[]> {
  const repo = new RuleRepository(skillsDir);
  const regions = resolveRegions(content);  // 新
  const loaded = await repo.loadRules(undefined, regions);  // 新
  // ...
}
```

### 五、后端配合

1. `POST /api/v1/admin/templates` 接受新格式 `rules.regions`
2. 策略包响应 `rules.regions` 按地区组织
3. 默认内置规则迁移到新格式

---

## 改动量评估

| 文件 | 改动范围 | 复杂度 |
|---|---|---|
| `src/dao/RuleRepository.ts` | `loadRules()` 签名 + 合并逻辑 | 中 |
| `src/dao/types.ts` | 新增 `RuleRegion` 类型 | 低 |
| `src/tools/reviewContentWizardTool.ts` | `buildRuleFindings` 传 region | 低 |
| `skills/templates/free.json` | 不变（Free 无规则） | 无 |
| 策略包 `rules` 结构 | 后端改 | 中 |

约 **100-150 行**新增代码，不影响现有测试。

---

## 待确认

1. **语言检测范围**：只做 zh-CN / en-US 两步，还是加 ja-JP、ko-KR？
2. **跨国品牌**：需要额外参数让用户指定 "这篇文案面向中国市场" 吗？还是纯靠自动检测？
3. **旧格式兼容**：策略包 `rules.categories`（无 region）需要向后兼容吗？（建议：如果 `regions` 字段不存在，回退全局模式）
