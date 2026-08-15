import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ProviderRegistry } from "../src/provider-registry.js";
import { ProviderVoiceTranscriber } from "../src/voice-transcriber.js";

describe("ProviderVoiceTranscriber", () => {
  it("calls an OpenAI-compatible transcription endpoint", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-stt-"));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ text: "你好，林夏" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl,
    });
    const transcriber = new ProviderVoiceTranscriber(registry, {
      env: { WEBOT_STT_PROVIDER: "openai" },
      fetchImpl,
    });

    const text = await transcriber.transcribe({
      audio: Buffer.from("wav"),
      mimeType: "audio/wav",
      filename: "voice.wav",
      language: "zh",
    });

    expect(text).toBe("你好，林夏");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
