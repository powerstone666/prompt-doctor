import { readFileSync } from "node:fs";

type LiteLLMConfig = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class LiteLLMClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxTokens?: number;
  private readonly systemPrompt: string;

  constructor(config: LiteLLMConfig = {}) {
    const baseUrl = config.baseUrl ?? process.env.LLM_BASE_URL ?? process.env.LITELLM_BASE_URL;
    const model = config.model ?? process.env.LLM_MODEL ?? process.env.LITELLM_MODEL;
    const apiKey = config.apiKey ?? process.env.LLM_API_KEY ?? process.env.LITELLM_API_KEY;

    this.baseUrl = this.requireConfig(baseUrl, "LLM_BASE_URL (or LITELLM_BASE_URL)");
    this.model = this.requireConfig(model, "LLM_MODEL (or LITELLM_MODEL)");
    this.apiKey = this.requireConfig(apiKey, "LLM_API_KEY (or LITELLM_API_KEY)");
    this.temperature =
      config.temperature ??
      this.getOptionalNumber("LLM_TEMPERATURE") ??
      this.getOptionalNumber("LITELLM_TEMPERATURE") ??
      0.2;
    this.maxTokens =
      config.maxTokens ??
      this.getOptionalNumber("LLM_MAX_TOKENS") ??
      this.getOptionalNumber("LITELLM_MAX_TOKENS");
    this.systemPrompt = this.loadSystemPrompt();
  }

  public async enhancePrompt(prompt: string): Promise<string> {
    const messages = this.buildMessages(prompt);
    return this.call(messages);
  }

  private buildMessages(prompt: string): ChatMessage[] {
    return [
      {
        role: "system",
        content: this.systemPrompt
      },
      {
        role: "user",
        content: prompt
      }
    ];
  }

  private loadSystemPrompt(): string {
    const content = readFileSync(new URL("./prompt.txt", import.meta.url), "utf8");
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("prompt.txt is empty");
    }
    return trimmed;
  }

  private requireConfig(value: string | undefined, name: string): string {
    if (!value) {
      throw new Error(`Missing required env var: ${name}`);
    }
    return value;
  }

  private getOptionalNumber(name: string): number | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) return undefined;
    return parsed;
  }

  private async call(messages: ChatMessage[]): Promise<string> {
    const url = this.baseUrl;

    const payload = {
      model: this.model,
      messages,
      temperature: this.temperature,
      ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {})
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`LiteLLM error: ${response.status} ${response.statusText} ${bodyText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("LiteLLM response missing choices[0].message.content");
    }

    return content;
  }
}
