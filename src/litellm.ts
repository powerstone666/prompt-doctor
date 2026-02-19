import { readFileSync } from "node:fs";

type LiteLLMConfig = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  cache_control?: { type: "ephemeral" };
};

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1000;

export class LiteLLMClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly systemPrompt: string;

  constructor(config: LiteLLMConfig = {}) {
    const baseUrl = config.baseUrl ?? process.env.LLM_BASE_URL;
    const model = config.model ?? process.env.LLM_MODEL;
    const apiKey = config.apiKey ?? process.env.LLM_API_KEY;

    this.baseUrl = this.requireConfig(baseUrl, "LLM_BASE_URL");
    this.model = this.requireConfig(model, "LLM_MODEL");
    this.apiKey = this.requireConfig(apiKey, "LLM_API_KEY");
    this.temperature = DEFAULT_TEMPERATURE;
    this.maxTokens = DEFAULT_MAX_TOKENS;
    this.systemPrompt = this.loadSystemPrompt();
  }

  public async enhancePrompt(prompt: string): Promise<string> {
    const messages = this.buildMessages(prompt);
    return this.call(messages);
  }

  public async enhancePromptWithContext(prompt: string, repoContext?: string): Promise<string> {
    const messages = this.buildMessages(prompt, repoContext);
    return this.call(messages);
  }

  private buildMessages(prompt: string, repoContext?: string): ChatMessage[] {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: this.systemPrompt,
        cache_control: { type: "ephemeral" as const }
      }
    ];

    if (repoContext?.trim()) {
      messages.push({
        role: "system",
        content:
          "Repository context is provided below.\n\n" +
          "ACTIVE FILE SECTION (if present): This is the PRIMARY TARGET of the user's request. All vague references (\"this file\", \"here\", \"current page\") point to this file. Use the exact path and excerpts provided.\n\n" +
          "OTHER FILE SECTIONS: These are REFERENCE ONLY for understanding patterns and conventions. Do not treat them as targets or facts about what to search/modify unless the user explicitly names them. If reference context contradicts user intent, ignore it.\n\n" +
          repoContext
      });
    }

    messages.push({
      role: "user",
      content: prompt
    });

    return messages;
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

  private async call(messages: ChatMessage[]): Promise<string> {
    const url = this.baseUrl;

    const payload = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      cache: true,
      metadata: {
        system_prompt_cached: true
      }
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
