import path from "path";
import fs from "fs";
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

// ── Path slot ─────────────────────────────────────────────────────

interface PathSlot {
  path: string;
  /** undefined = all platforms */
  os?: "mac" | "win" | "linux";
}

// ── Client manifest ───────────────────────────────────────────────

interface ClientManifest {
  id: string;
  label: string;
  configSlots: PathSlot[];
  detectSlots: PathSlot[];
  format: ConfigFormat;
  requiresStdioType?: true;
  unsupported?: true;
}

// ── Path expansion ────────────────────────────────────────────────

const H = os.homedir();
const APPDATA = process.env.APPDATA || path.join(H, "AppData", "Roaming");

function expandPath(p: string): string {
  return p.replace(/^~(?=[/\\])/, H).replace(/%APPDATA%/g, APPDATA);
}

function currentOs(): "mac" | "win" | "linux" {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function slotMatches(slot: PathSlot): boolean {
  return !slot.os || slot.os === currentOs();
}

// ── Resolver ──────────────────────────────────────────────────────

function resolveSlots(slots: PathSlot[], override?: string[]): string[] {
  if (override && override.length > 0) {
    return override.map(expandPath);
  }
  return slots.filter(slotMatches).map((s) => expandPath(s.path));
}

// ── Override file ─────────────────────────────────────────────────
// ~/.kevlar/client-overrides.json
// When a client developer changes a path, add the new slot in MANIFESTS below.
// For local workaround without waiting for a release, users can override here.
//
// {
//   "clients": {
//     "cursor": {
//       "configPaths": ["~/.cursor/mcp.json"],
//       "detectPaths": ["/Applications/Cursor.app", "~/.cursor"]
//     }
//   }
// }

interface ClientOverride {
  configPaths?: string[];
  detectPaths?: string[];
}

interface OverrideFile {
  _comment?: string;
  clients?: Record<string, ClientOverride>;
}

const OVERRIDE_PATH = path.join(H, ".kevlar", "client-overrides.json");

function loadOverrides(): Record<string, ClientOverride> {
  try {
    if (fs.existsSync(OVERRIDE_PATH)) {
      return (JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf8")) as OverrideFile).clients ?? {};
    }
  } catch {
    /* corrupt — ignore */
  }
  return {};
}

// ── Manifest definitions ──────────────────────────────────────────
// All known path slots across all platforms.
// When a client changes paths: add the new slot here. Keep old slots
// for backward compat with users on older client versions.

const MANIFESTS: ClientManifest[] = [
  {
    id: "claude",
    label: "Claude Desktop",
    configSlots: [
      { path: "~/Library/Application Support/Claude/claude_desktop_config.json", os: "mac" },
      { path: "~/.claude/claude_desktop_config.json", os: "mac" },
      { path: "%APPDATA%\\Claude\\claude_desktop_config.json", os: "win" },
      { path: "~/.config/Claude/claude_desktop_config.json", os: "linux" },
    ],
    detectSlots: [
      { path: "/Applications/Claude.app", os: "mac" },
      { path: "~/Library/Application Support/Claude", os: "mac" },
      { path: "~/.claude", os: "mac" },
      { path: "%APPDATA%\\Claude", os: "win" },
      { path: "~/.config/Claude", os: "linux" },
    ],
    format: "json-mcpServers",
  },
  {
    id: "cursor",
    label: "Cursor",
    configSlots: [
      { path: "~/.cursor/mcp.json", os: "mac" },
      { path: "%APPDATA%\\Cursor\\User\\globalStorage\\mcp.json", os: "win" },
      { path: "~/.config/Cursor/User/globalStorage/mcp.json", os: "linux" },
    ],
    detectSlots: [
      { path: "/Applications/Cursor.app", os: "mac" },
      { path: "~/.cursor", os: "mac" },
      { path: "%APPDATA%\\Cursor", os: "win" },
      { path: "~/.config/Cursor", os: "linux" },
    ],
    format: "json-mcpServers",
    requiresStdioType: true,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    configSlots: [
      { path: "~/.codeium/windsurf/mcp_config.json", os: "mac" },
      { path: "%APPDATA%\\Windsurf\\mcp_config.json", os: "win" },
      { path: "~/.codeium/windsurf/mcp_config.json", os: "linux" },
    ],
    detectSlots: [
      { path: "/Applications/Windsurf.app", os: "mac" },
      { path: "~/.codeium/windsurf", os: "mac" },
      { path: "%APPDATA%\\Windsurf", os: "win" },
      { path: "~/.codeium/windsurf", os: "linux" },
    ],
    format: "json-mcpServers",
  },
  {
    id: "opencode",
    label: "OpenCode",
    configSlots: [
      { path: "~/.config/opencode/opencode.json", os: "mac" },
      { path: "~/.config/opencode/opencode.json", os: "linux" },
    ],
    detectSlots: [
      { path: "~/.config/opencode", os: "mac" },
      { path: "~/.config/opencode", os: "linux" },
    ],
    format: "json-mcp-local",
  },
  {
    id: "codex",
    label: "Codex",
    configSlots: [
      { path: "~/.codex/config.toml", os: "mac" },
      { path: "~/.codex/config.toml", os: "linux" },
    ],
    detectSlots: [
      { path: "~/.codex", os: "mac" },
      { path: "~/.codex", os: "linux" },
    ],
    format: "toml-mcp",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    configSlots: [
      { path: "~/.gemini/antigravity/mcp_config.json", os: "mac" },
      { path: "%APPDATA%\\Antigravity\\mcp_config.json", os: "win" },
      { path: "~/.gemini/antigravity/mcp_config.json", os: "linux" },
    ],
    detectSlots: [
      { path: "/Applications/Antigravity.app", os: "mac" },
      { path: "~/Library/Application Support/Antigravity", os: "mac" },
      { path: "~/.gemini/antigravity", os: "mac" },
      { path: "%APPDATA%\\Antigravity", os: "win" },
      { path: "~/.gemini/antigravity", os: "linux" },
    ],
    format: "json-mcpServers",
  },
  {
    id: "codebuddy",
    label: "CodeBuddy CN",
    configSlots: [
      { path: "~/.codebuddy/mcp.json", os: "mac" },
      { path: "%APPDATA%\\CodeBuddy CN\\mcp.json", os: "win" },
      { path: "~/.codebuddy/mcp.json", os: "linux" },
    ],
    detectSlots: [
      { path: "/Applications/CodeBuddy CN.app", os: "mac" },
      { path: "~/Library/Application Support/CodeBuddy CN", os: "mac" },
      { path: "~/.codebuddy", os: "mac" },
      { path: "%APPDATA%\\CodeBuddy CN", os: "win" },
      { path: "~/.codebuddy", os: "linux" },
    ],
    format: "json-mcpServers",
    requiresStdioType: true,
  },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    configSlots: [
      { path: "~/.workbuddy/mcp.json", os: "mac" },
      { path: "%APPDATA%\\WorkBuddy\\mcp.json", os: "win" },
      { path: "~/.workbuddy/mcp.json", os: "linux" },
    ],
    detectSlots: [
      { path: "/Applications/WorkBuddy.app", os: "mac" },
      { path: "~/Library/Application Support/WorkBuddy", os: "mac" },
      { path: "~/.workbuddy", os: "mac" },
      { path: "%APPDATA%\\WorkBuddy", os: "win" },
      { path: "~/.workbuddy", os: "linux" },
    ],
    format: "json-mcpServers",
  },
];

// ── Public API ────────────────────────────────────────────────────

export function getRegistry(): ClientDef[] {
  const overrides = loadOverrides();

  return MANIFESTS.map((m) => {
    const ov = overrides[m.id];

    const configCandidates = resolveSlots(m.configSlots, ov?.configPaths);
    const detectCandidates = resolveSlots(m.detectSlots, ov?.detectPaths);

    return {
      id: m.id,
      label: m.label,
      format: m.format,
      unsupported: m.unsupported,
      requiresStdioType: m.requiresStdioType,
      configPath: () => {
        if (configCandidates.length === 0) return "";
        return configCandidates.find((p) => fs.existsSync(p)) ?? configCandidates[0];
      },
      detectPaths: () => detectCandidates,
    };
  });
}

/**
 * Diagnostic dump: all resolved paths per client + detection status.
 * Useful for `--doctor` or troubleshooting cross-platform issues.
 */
export function dumpRegistry(): Record<
  string,
  { configPaths: string[]; detectPaths: string[]; detected: boolean }
> {
  const overrides = loadOverrides();
  const result: Record<string, { configPaths: string[]; detectPaths: string[]; detected: boolean }> = {};
  for (const m of MANIFESTS) {
    const ov = overrides[m.id];
    const configPaths = resolveSlots(m.configSlots, ov?.configPaths);
    const detectPaths = resolveSlots(m.detectSlots, ov?.detectPaths);
    result[m.id] = {
      configPaths,
      detectPaths,
      detected: detectPaths.some((p) => fs.existsSync(p)),
    };
  }
  return result;
}
