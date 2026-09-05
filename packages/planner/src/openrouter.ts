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

import { SYSTEM_PROMPT, requestMessage } from "./prompt";
import type { PlanningProvider, PlanningRequest } from "./provider";
import { TablePlanSchema } from "./table-plan";
import { parsePeriodHeader } from "./workbook";

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
  readonly model?: string;
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

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: string[];
}

/**
 * Tighten the static plan shape with facts from this table.
 *
 * Zod still validates the answer and `findPlanProblems` remains authoritative.
 * These enums stop a structured-output provider from generating a role that is
 * guaranteed to be rejected — for example assigning a date column to `label` —
 * and spending every bounded repair attempt on the same type error.
 */
function schemaFor(request: PlanningRequest): JsonSchemaNode {
  const schema = structuredClone(tablePlanJsonSchema) as JsonSchemaNode;
  const roles = schema.properties?.["roles"]?.properties;
  const filterColumn =
    schema.properties?.["filters"]?.items?.properties?.["column"];
  if (roles === undefined || filterColumn === undefined) {
    throw new OpenRouterPlanningError(
      "Dasher could not constrain the OpenRouter plan schema",
    );
  }

  const names = request.table.columns.map((column) => column.name);
  const numbers = request.table.columns
    .filter((column) => column.type === "number")
    .map((column) => column.name);
  const text = request.table.columns
    .filter((column) => column.type === "text")
    .map((column) => column.name);
  const periods = request.table.columns
    .filter((column) => {
      if (column.type === "date") return true;
      if (request.table.unpivoted === true && column.name === "period") {
        return true;
      }
      const samples = column.samples.filter((sample) => sample !== "");
      return (
        samples.length > 0 &&
        samples.every((sample) => parsePeriodHeader(sample) !== null)
      );
    })
    .map((column) => column.name);

  for (const role of ["amount", "budget"] as const) {
    const node = roles[role];
    if (node === undefined)
      throw new OpenRouterPlanningError("Dasher plan schema is incomplete");
    node.enum = numbers;
  }
  for (const role of ["category", "label", "account"] as const) {
    const node = roles[role];
    if (node === undefined)
      throw new OpenRouterPlanningError("Dasher plan schema is incomplete");
    node.enum = text;
  }
  const period = roles["period"];
  if (period === undefined)
    throw new OpenRouterPlanningError("Dasher plan schema is incomplete");
  period.enum = periods;
  filterColumn.enum = names;
  return schema;
}

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
            schema: schemaFor(request),
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

    const responseModel = body.model?.trim();
    if (responseModel === undefined || responseModel === "") {
      throw new OpenRouterPlanningError(
        "OpenRouter response did not identify the model",
      );
    }
    if (responseModel !== this.model) {
      // Provenance is read from `provider.id` after plan() returns. Mutating a
      // shared singleton's id from each response races concurrent requests, so
      // aliases and routers are refused instead: the requested and served model
      // must be the same exact identifier before the plan can be accepted.
      throw new OpenRouterPlanningError(
        "OpenRouter answered with a different model than requested",
      );
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
