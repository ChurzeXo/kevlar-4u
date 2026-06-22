import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import type { ToolModule } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = new URL(".", import.meta.url).pathname;

function getLocalVersion(): string {
  try {
    // Use package.json from project root
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/kevlar-4u/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.version;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function handler(): Promise<any> {
  const local = getLocalVersion();
  const latest = await fetchLatestVersion();

  const lines: string[] = [];
  lines.push(`🔍 Kevlar-4u 版本检查`);
  lines.push(`- 当前版本：v${local}`);

  if (!latest) {
    lines.push(`- 最新版本：无法获取（网络不可用）`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  lines.push(`- 最新版本：v${latest}`);

  if (compareVersions(latest, local) > 0) {
    lines.push("");
    lines.push(`📦 新版本可用！请在你的终端运行：`);
    lines.push(`\`\`\``);
    lines.push(`npx -y kevlar-4u@${latest} --auto`);
    lines.push(`\`\`\``);
    lines.push(`安装后重启 AI 客户端即可使用新版本。`);
  } else {
    lines.push(`✅ 已是最新版本。`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export const checkUpdateModule: ToolModule = {
  definition: {
    name: "check_update",
    description: "检查 kevlar-4u 是否有新版本可用。如有更新，告知升级命令。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  handler: () => handler,
};
