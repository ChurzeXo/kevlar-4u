import path from "path";
import os from "os";

export type ConfigFormat = "json-mcpServers" | "json-mcp" | "json-mcp-local" | "toml-mcp";

export interface ClientDef {
  id: string;
  label: string;
  configPath: () => string;
  detectPaths?: () => string[];
  format: ConfigFormat;
  unsupported?: true;
  manualUrl?: string;
  requiresStdioType?: true;
}

/**
 * Registry of supported AI clients and their MCP configuration paths.
 * To add a new client: append one entry here.
 */
export function getRegistry(): ClientDef[] {
  const H = os.homedir();
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  return [
    {
      id: "claude",
      label: "Claude Desktop",
      configPath: () =>
        isMac
          ? path.join(H, "Library/Application Support/Claude/claude_desktop_config.json")
          : path.join(H, "AppData/Roaming/Claude/claude_desktop_config.json"),
      detectPaths: () =>
        isMac
          ? ["/Applications/Claude.app", path.join(H, "Library/Application Support/Claude")]
          : [path.join(H, "AppData/Roaming/Claude")],
      format: "json-mcpServers",
    },
    {
      id: "cursor",
      label: "Cursor",
      configPath: () =>
        isMac
          ? path.join(H, ".cursor/mcp.json")
          : isWin
          ? path.join(H, "AppData/Roaming/Cursor/User/globalStorage/mcp.json")
          : path.join(H, ".config/Cursor/User/globalStorage/mcp.json"),
      detectPaths: () =>
        isMac
          ? ["/Applications/Cursor.app", path.join(H, ".cursor")]
          : isWin
          ? [path.join(H, "AppData/Roaming/Cursor")]
          : [path.join(H, ".config/Cursor")],
      format: "json-mcpServers",
      requiresStdioType: true,
    },
    {
      id: "windsurf",
      label: "Windsurf",
      configPath: () =>
        isMac
          ? path.join(H, ".codeium/windsurf/mcp_config.json")
          : isWin
          ? path.join(H, "AppData/Roaming/Windsurf/mcp_config.json")
          : path.join(H, ".codeium/windsurf/mcp_config.json"),
      detectPaths: () =>
        isMac
          ? ["/Applications/Windsurf.app", path.join(H, ".codeium/windsurf")]
          : isWin
          ? [path.join(H, "AppData/Roaming/Windsurf")]
          : [path.join(H, ".codeium/windsurf")],
      format: "json-mcpServers",
    },
    {
      id: "opencode",
      label: "OpenCode",
      configPath: () =>
        isWin ? "" : path.join(H, ".config/opencode/opencode.json"),
      detectPaths: () =>
        isWin ? [] : [path.join(H, ".config/opencode")],
      format: "json-mcp-local",
    },
    {
      id: "codex",
      label: "Codex",
      configPath: () =>
        isWin ? "" : path.join(H, ".codex/config.toml"),
      detectPaths: () =>
        isWin ? [] : [path.join(H, ".codex")],
      format: "toml-mcp",
    },
    {
      id: "antigravity",
      label: "Antigravity",
      configPath: () =>
        isWin ? "" : path.join(H, ".gemini/antigravity/mcp_config.json"),
      detectPaths: () =>
        isWin
          ? []
          : [
              "/Applications/Antigravity.app",
              path.join(H, "Library/Application Support/Antigravity"),
            ],
      format: "json-mcpServers",
    },
    {
      id: "codebuddy",
      label: "CodeBuddy CN",
      configPath: () =>
        isWin ? "" : path.join(H, ".codebuddy/mcp.json"),
      detectPaths: () =>
        isWin
          ? []
          : [
              "/Applications/CodeBuddy CN.app",
              path.join(H, "Library/Application Support/CodeBuddy CN"),
            ],
      format: "json-mcpServers",
      requiresStdioType: true,
    },
    {
      id: "workbuddy",
      label: "WorkBuddy",
      configPath: () =>
        isWin ? "" : path.join(H, ".workbuddy/mcp.json"),
      detectPaths: () =>
        isWin
          ? []
          : [
              "/Applications/WorkBuddy.app",
              path.join(H, "Library/Application Support/WorkBuddy"),
            ],
      format: "json-mcpServers",
    },
  ];
}
