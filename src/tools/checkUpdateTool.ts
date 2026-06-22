import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { readConfig } from "../execution/config.js";
import type { ToolModule } from "./types.js";

const __dirname = new URL(".", import.meta.url).pathname;

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

interface VersionInfo {
  latest: string;
  changelog?: string;
  upgradeCommand?: string;
}

async function fetchVersionFromServer(): Promise<VersionInfo | null> {
  const config = readConfig();
  const baseUrl = (config.cloud_server_url || "https://kevlar4u.xyz").replace(/\/+$/, "");
  try {
    const res = await fetch(`${baseUrl}/api/v1/version`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    return { latest: String(data.version ?? ""), changelog: String(data.changelog ?? "") };
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
  const info = await fetchVersionFromServer();

  const lines: string[] = [];
  lines.push(`当前版本：v${local}`);

  if (!info) {
    lines.push(`无法检查更新（网络不可用）。`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (compareVersions(info.latest, local) > 0) {
    lines.push(`📦 新版本 v${info.latest} 已发布！`);
    if (info.changelog) {
      lines.push(`更新内容：${info.changelog}`);
    }
    lines.push(`请在终端运行升级命令：`);
    lines.push(`\`\`\``);
    lines.push(info.upgradeCommand || `npx -y kevlar-4u@${info.latest} --auto`);
    lines.push(`\`\`\``);
  } else {
    lines.push(`✅ 已是最新版本。`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function checkForUpdate(): Promise<string | null> {
  const local = getLocalVersion();
  try {
    const info = await fetchVersionFromServer();
    if (info && compareVersions(info.latest, local) > 0) {
      return `\n\n---\n📦 kevlar-4u v${info.latest} 已发布${info.changelog ? `：${info.changelog}` : "。"} 是否现在升级？`;
    }
  } catch { /* silent */ }
  return null;
}

export const checkUpdateModule: ToolModule = {
  definition: {
    name: "check_update",
    description: "检查 kevlar-4u 是否有新版本可用。对比服务端最新版本号，如有更新告知升级命令。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  handler: () => handler,
};
