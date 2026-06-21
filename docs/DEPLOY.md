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

## 一、初次设置（仅首次执行）

### 1. 在 GitHub 创建私有仓库

1. 打开 https://github.com/new
2. Repository name: `kevlar-pro-runtime`
3. 勾选 **Private**
4. 不要勾选 "Initialize this repository"（我们要 push 已有代码）
5. 点击 "Create repository"

### 2. 推送 Pro 代码到私有仓库

```bash
cd ~/Documents/MCP-Service/pro-runtime

# 添加 remote（用你实际的 SSH URL）
git remote add origin git@github.com:ChurzeXo/kevlar-pro-runtime.git

# 推送
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

## 二、日常开发工作流

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

## 三、NPM 包发布

### 3.1 Free 包 (kevlar-4u) — 公开

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

CI (.github/workflows/release.yml) 自动执行：
1. `npm ci`
2. `npm run build`
3. `npm test`
4. 打包 .tgz / .zip
5. 创建 GitHub Release
6. `npm publish` 到 npm registry

### 3.2 Pro 包 (@kevlar/pro-runtime) — 私有 (GitHub Packages)

```bash
cd ~/Documents/MCP-Service/pro-runtime

# 1. 编译
npm run build

# 2. 确认测试
npm test    # 预期: 35 pass / 0 fail

# 3. 登录 GitHub Packages
#    创建 GitHub Token: Settings → Developer settings → Tokens (classic)
#    勾选 write:packages + read:packages
npm login --registry=https://npm.pkg.github.com
# Username: ChurzeXo
# Password: ghp_xxxxxxxxxxxx
# Email: your@email.com

# 4. 发布
npm publish --registry=https://npm.pkg.github.com
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

### 3.3 用户如何安装 Pro

```bash
# 配置 GitHub Packages 认证
npm config set @kevlar:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken <your_github_token>

# 安装
npm install kevlar-4u            # Free 公开包
npm install @kevlar/pro-runtime  # Pro 私有包
```

---

## 四、发布前熔断检查清单

每次 `npm publish` 前确认：

```
✅ .npmignore 包含 src/pro/
✅ dist/ 中无 pro/ 目录
✅ dist/execution/proRuntime.js 中对 Pro 的引用保持为动态字符串 import("@kevlar/pro-runtime")
✅ npm test 全部通过 (315 Free + 35 Pro)
✅ git status 干净，无未提交的 Pro 源码泄漏
```

---

## 五、环境变量速查

| 变量 | 用途 |
|---|---|
| `KEVLAR_SKIP_PRO_IMPORT` | `"1"` 时跳过 `@kevlar/pro-runtime` 加载（测试用） |
| `KEVLAR_TIER` | 设为 `"pro"` 强制使用 Pro 模式 |
| `KEVLAR_SKILLS_DIR` | 覆盖默认的 `skills/` 路径 |
| `KEVLAR_BUNDLE_SIGNING_SECRET` | HMAC 密钥（仅服务端） |
| `KEVLAR_SIGNING_KEY` | Ed25519 私钥 PEM（仅服务端） |

---

## 六、npm link 回退方案

如果子模块方式不适合当前开发场景，可以回到 `npm link`：

```bash
# Free 包全局链接
cd ~/Documents/MCP-Service/kevlar
npm link

# Pro 包链接 Free（peer dep）
cd ~/Documents/MCP-Service/pro-runtime
npm link kevlar-4u
npm link

# Free 包链接 Pro（optional dep）
cd ~/Documents/MCP-Service/kevlar
npm link @kevlar/pro-runtime

# 恢复：两条路都走完
npm unlink @kevlar/pro-runtime
npm unlink kevlar-4u
```
