import { JUDGE_SYSTEM_PROMPT, buildJudgePrompt, parseJudgeVerdict } from "./judge.js";
import type { Detector, ScanInput, ScanResult } from "./types.js";

export interface LlmJudgeOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface AnthropicMessage {
  content?: Array<{ type: string; text?: string }>;
}

/**
 * LLM tier — asks a Claude model to judge the text. Requires an API key;
 * the gateway only enables this tier when one is configured.
 */
export class LlmJudgeDetector implements Detector {
  readonly name = "llm-judge";

  constructor(private readonly options: LlmJudgeOptions) {}

  async scan(input: ScanInput): Promise<ScanResult> {
    const baseUrl = this.options.baseUrl ?? "https://api.anthropic.com";
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: 200,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildJudgePrompt(input) }],
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      throw new Error(`llm judge request failed: ${response.status} ${await response.text()}`);
    }
    const message = (await response.json()) as AnthropicMessage;
    const text = message.content?.find((block) => block.type === "text")?.text ?? "";
    return parseJudgeVerdict(text, this.name);
  }
}
