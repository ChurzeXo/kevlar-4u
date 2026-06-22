# 版本管理 API 需求文档

## 背景

客户端新增 `check_update` MCP 工具，每次审核完成后自动检查是否有新版本。版本信息由服务端管理，而非查询 npm registry。

---

## API 端点

### `GET /api/v1/version`

无需认证。Free 和 Pro 用户均可调用。

#### 请求

```
GET /api/v1/version
```

无需参数，无需 Authorization header。

#### 响应

```json
{
  "version": "1.6.0",
  "changelog": "新增地区选择、规则引擎合并、修复 Pro 泄漏、check_update 工具。",
  "upgradeCommand": "npx -y kevlar-4u@1.6.0 --auto",
  "releasedAt": "2026-06-22T00:00:00Z",
  "breaking": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version` | string | ✅ | 最新版本号（semver） |
| `changelog` | string | 可选 | 中文更新摘要，客户端追加在审核结果末尾 |
| `upgradeCommand` | string | 可选 | 升级命令，无则客户端生成默认命令 |
| `releasedAt` | string | 可选 | 发布时间 |
| `breaking` | boolean | 可选 | 是否有破坏性变更 |

#### 客户端行为

- 超时: 5s（非阻塞，失败不报错）
- 每轮审核完成后调用一次
- 仅在 `latest > local` 时展示更新提示
- Free 和 Pro 用户均可见

---

## 数据库建议

单表结构，最简单实现：

```sql
CREATE TABLE versions (
  version     TEXT PRIMARY KEY,    -- "1.6.0"
  changelog   TEXT,                -- 中文更新摘要
  released_at TIMESTAMP,
  breaking    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT NOW()
);
```

API 返回 `ORDER BY released_at DESC LIMIT 1` 即为最新版本。

---

## 管理建议

可选 `POST /api/v1/admin/version` 用于更新版本信息：

```json
{
  "version": "1.6.0",
  "changelog": "新增地区选择...",
  "breaking": false
}
```

或者直接改数据库一条 SQL，不需要额外 API。

---

## 客户端测试

后端部署后，验证方式：

```bash
# 直接测试版本端点
curl https://kevlar4u.xyz/api/v1/version

# 期望响应
# {"version":"1.6.0","changelog":"...","upgradeCommand":"..."}
```

然后在客户端运行 `check_update` 工具，或完成一次审核后查看末尾是否有更新提示。
