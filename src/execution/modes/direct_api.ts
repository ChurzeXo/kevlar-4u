/**
 * Direct API Execution Mode
 * 
 * Directly calls third-party LLM APIs (OpenAI / Anthropic / Ollama).
 * API keys are read ONLY from environment variables.
 */

import type { ExecutionContext, ExecutionHandler, ExecutionResult, ExecutionMode } from "../base.js";
import type { Persona } from "../../utils/parser.js";
import { DEFAULT_DIMENSIONS_CONFIG } from "../dimensions.js";
import { executePersonasInParallel, buildUserMessage, augmentSystemPrompt } from "../parallel.js";
import { logger } from "../../utils/logger.js";
import { scanForCredentials } from "../../utils/sanitize.js";

const MODE: ExecutionMode = "direct_api";

// ── API Key Management ────────────────────────────────────────────────────────

interface ApiKeyInfo {
  key: string;
  provider: "anthropic" | "openai" | "ollama";
}

function getApiKey(): ApiKeyInfo | null {
  // Priority: KEVLAR_API_KEY > ANTHROPIC_API_KEY > OPENAI_API_KEY
  const key =
    process.env.KEVLAR_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY;

  if (!key) {
    const isOllamaEnv =
      !!process.env.OLLAMA_BASE_URL ||
      (!!process.env.KEVLAR_MODEL &&
        (process.env.KEVLAR_MODEL.startsWith("llama") ||
          process.env.KEVLAR_MODEL.startsWith("deepseek") ||
          process.env.KEVLAR_MODEL.startsWith("qwen") ||
          process.env.KEVLAR_MODEL.startsWith("mistral") ||
          process.env.KEVLAR_MODEL.includes("ollama")));

    if (isOllamaEnv) {
      return { key: "ollama", provider: "ollama" };
    }
    return null;
  }

  if (key.startsWith("sk-ant-")) {
    return { key, provider: "anthropic" };
  }
  if (key.startsWith("sk-")) {
    return { key, provider: "openai" };
  }

  return { key, provider: "ollama" };
}

export function hasApiKey(): boolean {
  return !!getApiKey();
}

export function maskApiKey(key: string, visible = 4): string {
  if (key.length <= visible * 2) return "*".repeat(key.length);
  return key.slice(0, visible) + "*".repeat(8) + key.slice(-visible);
}

// ── API Client ────────────────────────────────────────────────────────────────

interface LlmRequest {
  model: string;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

interface LlmResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason?: string;
}

async function callApi(keyInfo: ApiKeyInfo, request: LlmRequest): Promise<LlmResponse> {
  const { key, provider } = keyInfo;

  logger.debug("API call initiated", {
    event: "api_call",
    provider,
    model: request.model,
    systemLength: request.system.length,
    keyMasked: maskApiKey(key),
  });

  if (provider === "ollama") {
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    if (!baseUrl.includes("localhost") && !baseUrl.includes("127.0.0.1")) {
      logger.warn("Ollama base URL is not localhost", {
        event: "ollama_external_url",
        baseUrl,
      });
    }
  }

  if (provider === "anthropic") {
    return callAnthropic(key, request);
  } else if (provider === "openai") {
    return callOpenAi(key, request);
  } else {
    return callOllama(key, request);
  }
}

async function callAnthropic(apiKey: string, request: LlmRequest): Promise<LlmResponse> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: request.model || "claude-3-5-sonnet-20241022",
      system: request.system,
      messages: request.messages,
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature ?? 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
    stop_reason: string;
  };

  return {
    content: data.content[0]?.text || "",
    usage: {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    },
    stopReason: data.stop_reason,
  };
}

async function callOpenAi(apiKey: string, request: LlmRequest): Promise<LlmResponse> {
  const model = request.model || "gpt-4o";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: request.system },
        ...request.messages,
      ],
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature ?? 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices[0]?.message?.content || "",
    usage: {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    },
  };
}

async function callOllama(apiKey: string, request: LlmRequest): Promise<LlmResponse> {
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model || "llama3",
      messages: [
        { role: "system", content: request.system },
        ...request.messages,
      ],
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens || 4096,
      },
      stream: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as {
    message: { content: string };
  };

  return {
    content: data.message?.content || "",
  };
}

// ── API Handler ───────────────────────────────────────────────────────────────

export const directApiHandler: ExecutionHandler = {
  mode: MODE,
  priority: 20, // Medium priority

  canExecute(): boolean {
    return hasApiKey();
  },

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { personas, content, context: contextNote } = ctx;
    const dimsConfig = ctx.dimensions ?? DEFAULT_DIMENSIONS_CONFIG;

    const keyInfo = getApiKey();
    if (!keyInfo) {
      throw new Error("API key not configured. Please set KEVLAR_API_KEY environment variable.");
    }

    logger.info("Direct API review starting", {
      event: "direct_api_start",
      personas: personas.length,
      provider: keyInfo.provider,
    });

    const result = await executePersonasInParallel(
      personas,
      content,
      { mode: MODE, retryEventName: "api", dimensions: dimsConfig, preAuditReport: ctx.preAuditReport },
      async (persona: Persona) => {
        const review = await executePersonaReview(keyInfo, persona, content, contextNote, dimsConfig, ctx.preAuditReport);
        return review;
      }
    );

    logger.info("Direct API review completed", {
      event: "direct_api_complete",
      personas: result.personas.length,
      partialFailures: result.partialFailures?.length || 0,
    });

    return result;
  },
};

// ── Persona Review ────────────────────────────────────────────────────────────

async function executePersonaReview(
  keyInfo: ApiKeyInfo,
  persona: Persona,
  content: string,
  contextNote: string | undefined,
  dimensions?: import("../dimensions.js").DimensionsConfig,
  preAuditReport?: any
): Promise<string> {
  const userMessage = buildUserMessage(content, contextNote, dimensions, preAuditReport);

  const response = await callApi(keyInfo, {
    model: process.env.KEVLAR_MODEL || "",
    system: augmentSystemPrompt(persona, dimensions),
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 4096,
    temperature: 0.7,
  });

  const leaked = scanForCredentials(response.content);
  if (leaked.length > 0) {
    logger.warn("Credential pattern detected in LLM response", {
      event: "credential_leak_detected",
      personaId: persona.meta.id,
      patterns: leaked,
    });
  }

  return response.content;
}
