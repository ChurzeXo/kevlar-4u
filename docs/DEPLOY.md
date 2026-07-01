# Kevlar-4u 部署与发布指南

## 仓库架构

```
ChurzeXo/kevlar-4u (public, AGPL-3.0)       ChurzeXo/kevlar-pro-runtime (private)
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ src/                         │             │ src/                         │
│ ├── execution/               │             │ ├── credential/   (AES-GCM) │
│ │   └── proRuntime.ts        │──动态加载──▶│ ├── strategyBundle.ts        │
│ ├── subscription/tier.ts     │             │ ├── credentialCli.ts         │
│ └── tools/                   │             │ └── index.ts    (barrel)     │
│                              │  ◀──────────│                              │
│ src/pro/  ← Git Submodule ──│   相对路径    │ package.json: @kevlar/pro-…  │
└──────────────────────────────┘             └──────────────────────────────┘
```

**内核**：`DynamicImportProRuntimeLoader` 在运行时尝试 `import("@kevlar/pro-runtime")`。
有子模块/私有包 → Pro 增强。没有 → 自动降级 Free。

---

## 一、提交策略决策表

| 场景 | Free 代码 `src/` | Pro 子模块 `src/pro/` | 后端数据库 `kevlar4u.xyz` | 操作 |
|---|---|---|---|---|
| 只改 Free 代码，不发布 | 提交+推送 | 不动 | 不动 | `git add/commit/push` on main |
| 只改 Pro 代码，不发布 | 不动 | `npm run commit:pro` 自动处理 | 不动 | `npm run commit:pro`（提交子模块 + 更新主仓指针） |
| 同时改 Free + Pro，不发布 | 先提交+推送 | 再 `npm run commit:pro` | 不动 | `git add/commit/push` → `npm run commit:pro` |
| 准备发布（npm publish 前） | ✅ 确保已提交 | ✅ 确保已提交 | **先同步再发布** | `npm run sync:backend -- "变更摘要"` → `npm version patch` → `git push --tags` |
| 发布后发现漏了 DB 同步 | 不动 | 不动 | **补同步** | `npm run sync:backend -- "变更摘要"` |

**关键原则：**
- **后端数据库在 npm publish 前同步**——版本号相同，先写库再发布无冲突
- 如果发布前忘记同步，发布后补同步也可以，不影响已有功能
- 仅改代码不发布时，不需要操作数据库
- `npm run commit:pro` = 一站式提交并推送 Pro 子模块 + 更新主仓指针，不要手动分两步做

---

## 二、初次设置（仅首次执行）

### 1. 在 GitHub 创建私有仓库

1. 打开 https://github.com/new
2. Repository name: `kevlar-pro-runtime`
3. 勾选 **Private**
4. 不要勾选 "Initialize this repository"（我们要 push 已有代码）
5. 点击 "Create repository"

### 2. 推送 Pro 代码到私有仓库

```bash
cd src/pro
git remote add origin git@github.com:ChurzeXo/kevlar-pro-runtime.git
git push -u origin main
```

### 3. 在公有仓中注册子模块

```bash
cd ~/Documents/MCP-Service/kevlar

# 添加子模块
git submodule add git@github.com:ChurzeXo/kevlar-pro-runtime.git src/pro

# 提交 .gitmodules 和子模块指针
git add .gitmodules src/pro
git commit -m "chore: add pro-runtime submodule"
git push
```

### 4. 公共贡献者拉取（他们看不到 Pro）

```bash
git clone git@github.com:ChurzeXo/kevlar-4u.git
# src/pro/ 是空目录，DynamicImportProRuntimeLoader 自动降级 Free

# 有 Pro 权限的内部开发者：
git clone git@github.com:ChurzeXo/kevlar-4u.git
git submodule update --init --recursive   # 需要私有仓库的读权限
```

---

## 三、日常开发工作流

### 改 Pro 代码

```bash
# 进子模块修改
cd src/pro
# ... 编辑 ...

# 提交 Pro 代码到私有仓库
git add -A
git commit -m "feat: xxx"
git push

# 回到主仓，更新子模块指针
cd ../..
git add src/pro
git commit -m "push: update pro submodule pointer"
git push
```

### 简化版（一键脚本）

```bash
npm run commit:pro
```

这个脚本自动完成两个操作：
1. 在 `src/pro/` 内 `git add/commit/push`
2. 回到主仓 `git add src/pro && git commit && git push`

---

## 四、NPM 包发布

### 4.1 Free 包 (kevlar-4u) — 公开

```bash
cd ~/Documents/MCP-Service/kevlar

# 发布前强制自检
npm run build
ls dist/pro/ 2>/dev/null && echo "❌ 危险: dist/ 中有 pro 目录" || echo "✅ dist/ 干净"

# 确认 files 白名单和 .npmignore 双保险已生效
# package.json: "files": ["dist/", "skills/", "config/", "scripts/"]
# .npmignore:  src/pro/  src/pro/**/*

# 发布（通过 GitHub Release 触发 CI 自动发布）
npm version patch -m "chore: release %s"
git push origin main --tags
```

CI (`.github/workflows/release.yml`) 自动执行：
1. Checkout（`submodules: false`，不拉取私有子模块）
2. `npm ci`
3. `npm run build`
4. **熔断检查**：确认 `dist/` 无 Pro 代码泄漏
5. `npm test`（315 个测试，无需 Pro 包）
6. 打包 .tgz / .zip（不含 src/、node_modules、Pro 子模块）
7. 提取 CHANGELOG.md
8. 创建 GitHub Release
9. `npm publish` 到 npm registry

此外还有 **Pro CI** (`.github/workflows/pro-ci.yml`)，仅当子模块指针变更时触发：
- 需要用 SSH deploy key 拉取私有子模块
- 编译并运行 Pro 的 35 个测试
- 验证 dist/ 无 Pro 代码泄漏

**CI 需要配置的 Secrets：**

| Secret | 用途 | 配置位置 |
|---|---|---|
| `NPM_TOKEN` | npm 发布 token | Settings → Secrets → Actions |
| `PRO_REPO_DEPLOY_KEY` | Pro CI 拉取子模块的 SSH 私钥 | 同上（仅内部需配） |

### 4.2 Pro 包 (@kevlar/pro-runtime) — 私有 (GitHub Packages)

Pro 代码在 `src/pro/` 子模块中。发布于私有 GitHub Packages 而非 npm。

```bash
cd src/pro

# 1. 编译
npm install --legacy-peer-deps
npx tsc

# 2. 确认测试
npm test    # 预期: 35 pass / 0 fail

# 3. 推送子模块变更
git add -A && git commit -m "feat: xxx" && git push

# 4. 回到主仓更新指针
cd ../.. && npm run commit:pro
```

package.json 配置参考：
```json
{
  "name": "@kevlar/pro-runtime",
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

### 4.3 用户如何安装 Pro

```bash
# 配置 GitHub Packages 认证
npm config set @kevlar:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken <your_github_token>

# 安装
npm install kevlar-4u            # Free 公开包
npm install @kevlar/pro-runtime  # Pro 私有包
```

---

## 五、发布前熔断检查清单

每次 `npm publish` 前确认：

```
✅ .npmignore 包含 src/pro/
✅ dist/ 中无 pro/ 目录
✅ dist/execution/proRuntime.js 中对 Pro 的引用保持为动态字符串 import("@kevlar/pro-runtime")
✅ npm test 全部通过 (315 Free + 35 Pro)
✅ git status 干净，无未提交的 Pro 源码泄漏
✅ 后端数据库已同步当前版本（`curl -s https://kevlar4u.xyz/api/v1/version` 确认）
```

---

## 六、后端数据库写入

npm publish 只推送包到 registry。`check_update` 查版本和 Pro 激活都需要 `kevlar4u.xyz` 后端数据库中有对应记录。

> **⚠️ 必须 npm publish 前同步，不要等发布后再更新。** 详见"一、提交策略决策表"。

### 6.1 Admin Token

`POST /api/v1/admin/version` 需要 admin token，由 `ADMIN_API_TOKEN` 环境变量控制。

**开发环境默认值**：`kevlar-admin-api-dev`（无需在 Vercel 额外设置即生效）。

**生产环境**：需自行生成并在 Vercel Environment Variables 面板配置。

生成随机 token：

```bash
openssl rand -hex 32
```

**本地执行 curl 时**，避免 token 写入 shell 历史：

```bash
# 方式一：环境变量注入（推荐）
ADMIN_API_TOKEN="kevlar-admin-api-dev" bash -c 'curl -s -X POST https://kevlar4u.xyz/api/v1/admin/version \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -d "{\"version\":\"1.6.7\",\"changelog\":\"...\",\"breaking\":false}"'

# 方式二：写入 .env（不提交到 git）
echo 'ADMIN_API_TOKEN=kevlar-admin-api-dev' >> .env
source .env
curl -s ... -H "Authorization: Bearer $ADMIN_API_TOKEN" ...
```

> **注意**：`ADMIN_API_TOKEN` 是后端环境变量，不存储在 kevlar-4u 仓库中。开发环境默认值仅用于本地测试。

### 6.2 更新版本号

每次发布新版本后执行：

```bash
# 方式一：一键发布（推荐）
ADMIN_API_TOKEN="kevlar-admin-api-dev" npm run deploy:all -- "更新摘要"

# 方式二：npm 命令
ADMIN_API_TOKEN="kevlar-admin-api-dev" npm run sync:backend -- "更新摘要"

# 方式三：curl 直接调用
curl -s -X POST https://kevlar4u.xyz/api/v1/admin/version \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -d '{"version":"1.6.2","changelog":"更新摘要","breaking":false}'
```

响应：

```json
{"ok":true,"version":"1.6.2","releasedAt":"2026-06-23T08:43:17.780Z"}
```

验证：

```bash
curl -s https://kevlar4u.xyz/api/v1/version
```

### 6.3 生成 Pro 激活码

```bash
curl -s https://kevlar4u.xyz/api/v1/admin/seed
```

返回一次性激活码（30 分钟有效）：

```json
{"code":"KV-ACT-xxxxxxxx-xxxxxx-EXPIRES-30MIN","expiresAt":"2026-06-23T09:09:36.312Z"}
```

---

## 七、环境变量速查

| 变量 | 用途 |
|---|---|
| `ADMIN_API_TOKEN` | 后端 admin API 鉴权 token（Vercel 部署需配置） |
| `KEVLAR_SKIP_PRO_IMPORT` | `"1"` 时跳过 `@kevlar/pro-runtime` 加载（测试用） |
| `KEVLAR_TIER` | 设为 `"pro"` 强制使用 Pro 模式 |
| `KEVLAR_SKILLS_DIR` | 覆盖默认的 `skills/` 路径 |
| `KEVLAR_BUNDLE_SIGNING_SECRET` | HMAC 密钥（仅服务端） |
| `KEVLAR_SIGNING_KEY` | Ed25519 私钥 PEM（仅服务端） |

---

## 八、本地开发说明

子模块 + tsconfig paths 方案，无需 npm link。

```bash
# 克隆（有 Pro 权限）
git clone git@github.com:ChurzeXo/kevlar-4u.git
git submodule update --init --recursive

# tsconfig.json 已有 paths 映射：
# @kevlar/pro-runtime → ./src/pro/src
# kevlar-4u/execution/*  → ./src/execution/*.ts
# kevlar-4u/subscription/* → ./src/subscription/*.ts

# 日常开发即可直接 import "@kevlar/pro-runtime"
npm run dev     # tsx 启动，paths 自动生效
npm test        # 315 tests
```
