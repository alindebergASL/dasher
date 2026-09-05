/**
 * A planning provider backed by a Claude model, reached at
 * `@dasher/planner/anthropic` so the main entry point never imports an HTTP
 * client. Its output is `unknown` like every provider's: the run loop parses,
 * checks, and compiles it, so a bad answer costs an attempt, never a figure.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { PlanningProvider, PlanningRequest } from "./provider";
import { SYSTEM_PROMPT, requestMessage } from "./prompt";
import { TablePlanSchema } from "./table-plan";

export { SYSTEM_PROMPT, requestMessage };

export const DEFAULT_PLANNING_MODEL = "claude-opus-5";

/** The slice of the SDK client the provider uses, so a test can hand in a stub. */
export interface PlanningClient {
  readonly messages: {
    parse(params: Anthropic.MessageCreateParamsNonStreaming): Promise<{
      parsed_output: unknown;
      content: readonly Anthropic.ContentBlock[];
    }>;
  };
}

export interface AnthropicPlanningProviderOptions {
  /** Closed over by the instance; never read from the environment. Unused when `client` is given. */
  readonly apiKey?: string;
  readonly model?: string;
  /** Defaults to 8000. A plan is a few kilobytes of JSON. */
  readonly maxTokens?: number;
  /** For a gateway or a recording proxy. */
  readonly baseURL?: string;
  readonly client?: PlanningClient;
}

export class AnthropicPlanningProvider implements PlanningProvider {
  readonly id: string;
  readonly usesModel = true;
  private readonly client: PlanningClient;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicPlanningProviderOptions) {
    this.model = options.model?.trim() || DEFAULT_PLANNING_MODEL;
    this.maxTokens = options.maxTokens ?? 8_000;
    this.id = `anthropic:${this.model}`;
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      if (options.apiKey === undefined || options.apiKey.trim() === "") {
        throw new Error(
          "AnthropicPlanningProvider requires an API key or a client",
        );
      }
      this.client = new Anthropic({
        apiKey: options.apiKey,
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      });
    }
  }

  async plan(request: PlanningRequest): Promise<unknown> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: requestMessage(request) }],
      output_config: { format: zodOutputFormat(TablePlanSchema) },
    });
    if (
      response.parsed_output !== null &&
      response.parsed_output !== undefined
    ) {
      return response.parsed_output;
    }
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // The loop reports plan_malformed and spends an attempt, which is what a
      // bad response should cost; a throw here would let the provider abort.
      return text;
    }
  }
}
