/**
 * OpenRouter-backed table planning through its native Chat Completions API.
 *
 * The Anthropic Messages compatibility endpoint is intentionally not used here.
 * Several non-Anthropic models returned output that the Anthropic SDK rejected
 * before Dasher's governed validation loop could inspect it. Chat Completions
 * returns ordinary JSON text: this provider decodes it when possible and returns
 * malformed text unchanged, so `runTablePlanner` remains the trust boundary.
 */
import { z } from "zod";

import { SYSTEM_PROMPT, requestMessage } from "./anthropic";
import type { PlanningProvider, PlanningRequest } from "./provider";
import { TablePlanSchema } from "./table-plan";

export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3";
export const DEFAULT_OPENROUTER_BASE_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

export type OpenRouterReasoningEffort = "low" | "medium" | "high";

export interface OpenRouterPlanningProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly reasoningEffort?: OpenRouterReasoningEffort;
  readonly endpoint?: string;
  readonly siteUrl?: string;
  readonly appName?: string;
  readonly fetcher?: typeof fetch;
}

interface OpenRouterResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string;
    };
  }[];
}

export class OpenRouterPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterPlanningError";
  }
}

const tablePlanJsonSchema = z.toJSONSchema(TablePlanSchema);

export class OpenRouterPlanningProvider implements PlanningProvider {
  readonly id: string;
  readonly usesModel = true;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly reasoningEffort: OpenRouterReasoningEffort;
  private readonly endpoint: string;
  private readonly siteUrl: string | undefined;
  private readonly appName: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenRouterPlanningProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey === "") {
      throw new Error("OpenRouterPlanningProvider requires an API key");
    }
    this.apiKey = apiKey;
    this.model = options.model?.trim() || DEFAULT_OPENROUTER_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.reasoningEffort = options.reasoningEffort ?? "low";
    this.endpoint = options.endpoint?.trim() || DEFAULT_OPENROUTER_BASE_URL;
    this.siteUrl = options.siteUrl?.trim() || undefined;
    this.appName = options.appName?.trim() || undefined;
    this.fetcher = options.fetcher ?? fetch;
    this.id = `openrouter:${this.model}`;

    if (!Number.isInteger(this.maxTokens) || this.maxTokens < 1) {
      throw new Error("OpenRouter maxTokens must be a positive integer");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("OpenRouter timeoutMs must be a positive integer");
    }
  }

  async plan(request: PlanningRequest): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (this.siteUrl !== undefined) headers["http-referer"] = this.siteUrl;
    if (this.appName !== undefined)
      headers["x-openrouter-title"] = this.appName;

    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        reasoning_effort: this.reasoningEffort,
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}\n\nThe field planVersion must be exactly "table-plan-v1".`,
          },
          { role: "user", content: requestMessage(request) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "table_plan",
            strict: true,
            schema: tablePlanJsonSchema,
          },
        },
        provider: {
          require_parameters: true,
          data_collection: "deny",
          zdr: true,
          allow_fallbacks: false,
        },
      }),
    });

    if (!response.ok) {
      // Never include the provider body: it can echo request content and sample
      // cells. The status is enough for the governed loop and operator log.
      throw new OpenRouterPlanningError(
        `OpenRouter answered ${String(response.status)}`,
      );
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new OpenRouterPlanningError("OpenRouter response was too large");
    }

    let body: OpenRouterResponse;
    try {
      body = JSON.parse(text) as OpenRouterResponse;
    } catch {
      throw new OpenRouterPlanningError("OpenRouter response was not JSON");
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new OpenRouterPlanningError("OpenRouter returned no plan content");
    }

    try {
      return JSON.parse(content) as unknown;
    } catch {
      // Returned unchanged so TablePlanSchema reports plan_malformed and the
      // bounded planner loop, rather than this transport, owns acceptance.
      return content;
    }
  }
}
