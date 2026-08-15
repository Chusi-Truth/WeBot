import { ProviderRegistry } from "./provider-registry.js";
import type { VoiceTranscriber } from "./types.js";

export interface ProviderVoiceTranscriberOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** Transcribes WAV audio through an OpenAI-compatible endpoint. */
export class ProviderVoiceTranscriber {
  readonly transcribe: VoiceTranscriber;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly registry: ProviderRegistry,
    options: ProviderVoiceTranscriberOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? registry.fetchImpl;
    this.transcribe = (request) => this.execute(request);
  }

  private async execute(
    request: Parameters<VoiceTranscriber>[0],
  ): Promise<string> {
    const providerId = this.env.WEBOT_STT_PROVIDER?.trim() || "openai";
    const { definition, apiKey } = this.registry.resolve(providerId);
    if (!apiKey || !definition.baseUrl) {
      throw new Error(`语音识别 Provider“${providerId}”配置不完整。`);
    }
    const model =
      this.env.WEBOT_STT_MODEL?.trim() ||
      (providerId === "openai" ? "gpt-4o-mini-transcribe" : definition.model);
    if (!model) throw new Error("没有配置语音识别模型。");

    const form = new FormData();
    form.append("model", model);
    form.append(
      "file",
      new Blob([Uint8Array.from(request.audio)], { type: request.mimeType }),
      request.filename,
    );
    const language =
      this.env.WEBOT_STT_LANGUAGE?.trim() || request.language?.trim();
    if (language) form.append("language", language);

    const controller = new AbortController();
    const timeoutMs = definition.timeoutMs ?? 90_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const apiKeyHeader = definition.apiKeyHeader ?? "Authorization";
      const apiKeyPrefix = definition.apiKeyPrefix ?? "Bearer ";
      const endpoint =
        this.env.WEBOT_STT_ENDPOINT?.trim() || "audio/transcriptions";
      const response = await this.fetchImpl(
        `${definition.baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`,
        {
          method: "POST",
          headers: {
            ...definition.headers,
            [apiKeyHeader]: `${apiKeyPrefix}${apiKey}`,
          },
          body: form,
          signal: controller.signal,
        },
      );
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(
          `${definition.label} 语音识别 HTTP ${response.status}: ${safeText(raw)}`,
        );
      }
      const text = extractTranscription(
        raw,
        response.headers.get("content-type"),
      );
      if (!text) throw new Error(`${definition.label} 没有返回语音转写文字。`);
      return text;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${definition.label} 语音识别超时。`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractTranscription(raw: string, contentType: string | null): string {
  if (!contentType?.includes("application/json")) return raw.trim();
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    throw new Error("语音识别 API 返回了无效 JSON。");
  }
}

function safeText(value: string, maxLength = 500): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
