import { TOOL_DEFINITIONS } from "./definitions.js";
import type { ToolDependencies, ToolHandler } from "./types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ── Lazy Module Loaders ─────────────────────────────────────────────────────
//
// Instead of eagerly importing all 12 tool modules (~350KB) at startup,
// each tool's handler is lazily loaded via dynamic import() on first call.
// Definitions (lightweight JSON, ~2KB) are loaded eagerly from definitions.ts.

type ModuleLoader = (deps: ToolDependencies) => Promise<ToolHandler>;

const toolLoaders: Record<string, ModuleLoader> = {
  list_personas: async (deps) => {
    const m = await import("./listPersonasTool.js");
    return m.listPersonasModule.handler(deps);
  },
  create_persona_wizard: async (deps) => {
    const m = await import("./createPersonaWizardTool.js");
    return m.createPersonaWizardModule.handler(deps);
  },
  delete_persona: async (deps) => {
    const m = await import("./deletePersonaTool.js");
    return m.deletePersonaModule.handler(deps);
  },
  delete_persona_wizard: async (deps) => {
    const m = await import("./deletePersonaWizardTool.js");
    return m.deletePersonaWizardModule.handler(deps);
  },
  review_content_wizard: async (deps) => {
    const m = await import("./reviewContentWizardTool.js");
    return m.reviewContentWizardModule.handler(deps);
  },
  review_content_wizard_continue: async (deps) => {
    const m = await import("./continueWizardTool.js");
    return m.reviewContentWizardContinueModule.handler(deps);
  },
  kevlar_help: async (deps) => {
    const m = await import("./helpTool.js");
    return m.helpModule.handler(deps);
  },
  get_execution_modes: async (deps) => {
    const m = await import("./getModesTool.js");
    return m.getModesModule.handler(deps);
  },
  configure: async (deps) => {
    const m = await import("./configureTool.js");
    return m.configureModule.handler(deps);
  },
  configure_wizard: async (deps) => {
    const m = await import("./configureWizardTool.js");
    return m.configureWizardModule.handler(deps);
  },
  set_language: async (deps) => {
    const m = await import("./languageTool.js");
    return m.languageModule.handler(deps);
  },
  check_update: async (deps) => {
    const m = await import("./checkUpdateTool.js");
    return m.checkUpdateModule.handler(deps);
  },
};

// ── Registry Factory ────────────────────────────────────────────────────────

export function createToolRegistry(deps: ToolDependencies): {
  registry: Map<string, ToolHandler>;
  toolDefinitions: Tool[];
} {
  const registry = new Map<string, ToolHandler>();
  const toolDefinitions: Tool[] = Object.values(TOOL_DEFINITIONS);

  for (const [name, loader] of Object.entries(toolLoaders)) {
    let cachedHandler: ToolHandler | null = null;
    let pendingLoad: Promise<ToolHandler> | null = null;

    registry.set(name, async (args: Record<string, unknown> | undefined) => {
      if (!cachedHandler) {
        if (!pendingLoad) {
          pendingLoad = loader(deps);
        }
        cachedHandler = await pendingLoad;
      }
      return cachedHandler(args);
    });
  }

  return { registry, toolDefinitions };
}
