# 📦 Kevlar — 第三方依赖列表

> 请在项目根目录下运行以下命令安装全部依赖。

## 一键安装（推荐）

```bash
npm install
```

---

## 生产依赖（dependencies）

| 包名 | 版本 | 用途 |
|------|------|------|
| `@modelcontextprotocol/sdk` | `^1.29.0` | Anthropic 官方 MCP SDK，提供 Server、Transport、Schema 等核心类 |
| `dotenv` | `^17.4.2` | 从 `.env` 文件加载环境变量（如 `KEVLAR_SKILLS_DIR`） |
| `gray-matter` | `^4.0.3` | 解析 Markdown 文件头部的 YAML Frontmatter，用于读取/写入人设元数据 |

### 单独安装命令

```bash
npm install @modelcontextprotocol/sdk dotenv gray-matter
```

---

## 开发依赖（devDependencies）

| 包名 | 版本 | 用途 |
|------|------|------|
| `typescript` | `^6.0.3` | TypeScript 编译器 |
| `tsx` | `^4.22.1` | 直接运行 TypeScript 文件（用于开发模式 `npm run dev`） |
| `@types/node` | `^25.8.0` | Node.js 的 TypeScript 类型定义 |

### 单独安装命令

```bash
npm install -D typescript tsx @types/node
```

---

## 构建 & 运行

```bash
# 1. 安装依赖
npm install

# 2. 编译 TypeScript → JavaScript
npm run build

# 3. （可选）开发模式，无需编译直接运行
npm run dev

# 4. 生产运行（编译后）
npm start
```

## 注册到 Claude Desktop

编译完成后，编辑 Claude Desktop 的 MCP 配置文件（macOS 路径：`~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "kevlar": {
      "command": "node",
      "args": ["/你的绝对路径/kevlar/dist/index.js"]
    }
  }
}
```

> ⚠️ 注意：`args` 中必须使用**绝对路径**。

## 可选环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `KEVLAR_SKILLS_DIR` | `<项目根目录>/skills/` | 自定义人设文件目录的绝对路径 |

在项目根目录创建 `.env` 文件即可：

```env
KEVLAR_SKILLS_DIR=/custom/path/to/my-personas
```
