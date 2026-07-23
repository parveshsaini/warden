import {
  JUDGE_SYSTEM_PROMPT,
  type JudgeUsage,
  buildJudgePrompt,
  parseJudgeVerdict,
} from "./judge.js";
import type { Detector, ScanInput, ScanResult } from "./types.js";

export interface GeminiJudgeOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Called after each successful call so a caller can price a run. */
  onUsage?: (usage: JudgeUsage) => void;
}

const VERDICT_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", enum: ["malicious", "suspicious", "benign"] },
    reason: { type: "STRING" },
  },
  required: ["verdict", "reason"],
  propertyOrdering: ["verdict", "reason"],
} as const;

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * LLM tier backed by Google's Gemini API. Requires GEMINI_API_KEY; the gateway
 * only enables this tier when one is configured.
 */
export class GeminiJudgeDetector implements Detector {
  readonly name = "gemini-judge";

  constructor(private readonly options: GeminiJudgeOptions) {}

  async scan(input: ScanInput): Promise<ScanResult> {
    const baseUrl = this.options.baseUrl ?? "https://generativelanguage.googleapis.com";
    const response = await fetch(`${baseUrl}/v1beta/models/${this.options.model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.options.apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: JUDGE_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: buildJudgePrompt(input) }] }],
        generationConfig: {
          maxOutputTokens: 200,
          temperature: 0,
          // Constrained decoding — without it the small models emit a correct
          // verdict and then ramble past it, burning output tokens.
          responseMimeType: "application/json",
          responseSchema: VERDICT_SCHEMA,
          // Screening is a classification, not a reasoning task — thinking
          // tokens would multiply cost and latency for no accuracy gain.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      throw new Error(`gemini judge request failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as GeminiResponse;
    if (body.usageMetadata) {
      this.options.onUsage?.({
        inputTokens: body.usageMetadata.promptTokenCount ?? 0,
        outputTokens: body.usageMetadata.candidatesTokenCount ?? 0,
      });
    }
    const text =
      body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return parseJudgeVerdict(text, this.name);
  }
}
