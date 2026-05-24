import { listPersonasModule } from "./listPersonasTool.js";
import {
  updatePersonaDraftModule,
  deletePersonaDraftModule,
} from "./createPersonaTool.js";
import { createPersonaWizardModule } from "./createPersonaWizardTool.js";
import { deletePersonaModule } from "./deletePersonaTool.js";
import { deletePersonaWizardModule } from "./deletePersonaWizardTool.js";
import { reviewModule } from "./reviewTool.js";
import { reviewContentWizardModule } from "./reviewContentWizardTool.js";
import { helpModule } from "./helpTool.js";
import { getModesModule } from "./getModesTool.js";
import { configureModule } from "./configureTool.js";
import { configureWizardModule } from "./configureWizardTool.js";
import type { ToolDependencies, ToolModule } from "./types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

type ToolHandler = (args: Record<string, unknown> | undefined) => Promise<any>;

const allModules: ToolModule[] = [
  listPersonasModule,
  updatePersonaDraftModule,
  deletePersonaDraftModule,
  createPersonaWizardModule,
  deletePersonaModule,
  deletePersonaWizardModule,
  reviewModule,
  reviewContentWizardModule,
  getModesModule,
  configureModule,
  configureWizardModule,
  helpModule,
];

export function createToolRegistry(deps: ToolDependencies): {
  registry: Map<string, ToolHandler>;
  toolDefinitions: Tool[];
} {
  const registry = new Map<string, ToolHandler>();
  const toolDefinitions: Tool[] = [];

  for (const mod of allModules) {
    registry.set(mod.definition.name, mod.handler(deps));
    toolDefinitions.push(mod.definition);
  }

  return { registry, toolDefinitions };
}
