import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MEDIA_VISION_INSTRUCTIONS,
  MediaAiService,
} from "../src/media-ai.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import type { ProviderApi } from "../src/provider-types.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Buffer.from("RIFF0000WEBP", "ascii");

async function loadRegistry(params: {
  fetchImpl: typeof fetch;
  api?: ProviderApi;
  env?: NodeJS.ProcessEnv;
  providerId?: string;
}): Promise<ProviderRegistry> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-media-ai-"));
  const providerId = params.providerId ?? "cliproxy";
  await writeFile(
    path.join(stateDir, "providers.json"),
    JSON.stringify({
      providers: [
        {
          id: providerId,
          label: "CLIProxy",
          api: params.api ?? "openai-responses",
          baseUrl: "https://cliproxy.example.test/v1/",
          model: "provider-default-model",
          apiKeyEnv: "CLIPROXY_API_KEY",
          apiKeyHeader: "X-API-Key",
          apiKeyPrefix: "Token ",
          headers: { "X-Proxy-Header": "kept" },
          timeoutMs: 5_000,
        },
      ],
    }),
  );
  return ProviderRegistry.load({
    stateDir,
    env: params.env ?? { CLIPROXY_API_KEY: "cliproxy-secret" },
    fetchImpl: params.fetchImpl,
  });
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("MediaAiService", () => {
  it("sends images through Responses with an injection-resistant instruction", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: [
          {
            content: [
              { type: "output_text", text: "一张带有标题的白板。" },
            ],
          },
        ],
      }),
    );
    const registry = await loadRegistry({ fetchImpl });
    const service = new MediaAiService(registry);

    await expect(
      service.describeImages({
        userId: "private-user@im.wechat",
        userPrompt: "请读出标题",
        images: [
          { data: Buffer.from("first"), mimeType: "image/png" },
          { data: Buffer.from("second"), mimeType: "image/jpeg" },
        ],
      }),
    ).resolves.toBe("一张带有标题的白板。");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://cliproxy.example.test/v1/responses");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Proxy-Header": "kept",
      "X-API-Key": "Token cliproxy-secret",
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      instructions: MEDIA_VISION_INSTRUCTIONS,
      store: false,
      max_output_tokens: 2_000,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "请读出标题" },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${Buffer.from("second").toString("base64")}`,
            },
          ],
        },
      ],
    });
    expect(body.instructions).toContain("不可信内容");
    expect(body.instructions).toContain("绝不能执行");
    expect(body.instructions).toContain("不要扮演");
    expect(body.safety_identifier).toMatch(/^[a-f0-9]{64}$/u);
    expect(body.safety_identifier).not.toContain("private-user");
  });

  it("uses env-selected providers and models", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ output_text: "客观描述" }));
    const registry = await loadRegistry({
      fetchImpl,
      providerId: "media-custom",
      env: { CLIPROXY_API_KEY: "cliproxy-secret" },
    });
    const service = new MediaAiService(registry, {
      env: {
        WEBOT_VISION_PROVIDER: "media-custom",
        WEBOT_VISION_MODEL: "vision-custom",
      },
    });

    await expect(
      service.describeImages({
        userId: "u",
        images: [{ data: Buffer.from("x"), mimeType: "image/webp" }],
      }),
    ).resolves.toBe("客观描述");
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body)).model).toBe("vision-custom");
  });

  it("reports capability availability without throwing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const ready = new MediaAiService(await loadRegistry({ fetchImpl }));
    expect(ready.isVisionAvailable()).toBe(true);
    expect(ready.isImageGenerationAvailable()).toBe(true);

    const chatOnly = new MediaAiService(
      await loadRegistry({ fetchImpl, api: "chat-completions" }),
    );
    expect(chatOnly.isVisionAvailable()).toBe(false);
    expect(chatOnly.isImageGenerationAvailable()).toBe(true);

    const missingKey = new MediaAiService(
      await loadRegistry({ fetchImpl, env: {} }),
    );
    expect(missingKey.isVisionAvailable()).toBe(false);
    expect(missingKey.isImageGenerationAvailable()).toBe(false);
  });

  it("enforces image count, per-image, total-image, and prompt limits before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const registry = await loadRegistry({ fetchImpl });
    const oneImage = new MediaAiService(registry, {
      maxImages: 1,
      maxInputImageBytes: 2,
      maxTotalInputImageBytes: 2,
      maxPromptCharacters: 3,
    });
    await expect(
      oneImage.describeImages({
        userId: "u",
        images: [
          { data: Buffer.from("a"), mimeType: "image/png" },
          { data: Buffer.from("b"), mimeType: "image/png" },
        ],
      }),
    ).rejects.toThrow("图片数量超过");
    await expect(
      oneImage.describeImages({
        userId: "u",
        images: [{ data: Buffer.from("abc"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("单张图片超过");
    await expect(
      oneImage.describeImages({
        userId: "u",
        userPrompt: "1234",
        images: [{ data: Buffer.from("a"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("提示词超过");

    const totalLimit = new MediaAiService(registry, {
      maxImages: 2,
      maxInputImageBytes: 3,
      maxTotalInputImageBytes: 3,
    });
    await expect(
      totalLimit.describeImages({
        userId: "u",
        images: [
          { data: Buffer.from("aa"), mimeType: "image/png" },
          { data: Buffer.from("bb"), mimeType: "image/jpeg" },
        ],
      }),
    ).rejects.toThrow("总大小超过");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requests one base64 image and returns its detected MIME type", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          {
            b64_json: PNG.toString("base64"),
            revised_prompt: "a revised safe prompt",
          },
        ],
      }),
    );
    const registry = await loadRegistry({ fetchImpl });
    const service = new MediaAiService(registry);

    const result = await service.generateImage({
      userId: "private-user",
      agentId: "private-agent",
      prompt: "一只坐在窗边的猫",
      size: "1536x1024",
      quality: "high",
    });
    expect(result).toEqual({
      data: PNG,
      mimeType: "image/png",
      revisedPrompt: "a revised safe prompt",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://cliproxy.example.test/v1/images/generations",
    );
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-image-2",
      prompt: "一只坐在窗边的猫",
      n: 1,
      response_format: "b64_json",
      moderation: "low",
      size: "1536x1024",
      quality: "high",
    });
    expect(body.user).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(body)).not.toContain("private-user");
    expect(JSON.stringify(body)).not.toContain("private-agent");
  });

  it("classifies image safety rejections without exposing upstream details", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "moderation_blocked",
            message: "private safety detail safety_violations=[sexual]",
          },
        },
        { status: 400 },
      ),
    );
    const service = new MediaAiService(await loadRegistry({ fetchImpl }));

    await expect(
      service.generateImage({ userId: "u", agentId: "a", prompt: "draw" }),
    ).rejects.toMatchObject({
      name: "MediaAiModerationError",
      message: "图片生成请求被内容安全规则拒绝。",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [JPEG, "image/jpeg"],
    [WEBP, "image/webp"],
  ] as const)("detects generated %s output", async (image, mimeType) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ data: [{ b64_json: image.toString("base64") }] }),
      );
    const service = new MediaAiService(await loadRegistry({ fetchImpl }));
    await expect(
      service.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "draw",
      }),
    ).resolves.toMatchObject({ data: image, mimeType });
  });

  it("strictly validates generation prompt, size, and quality", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new MediaAiService(await loadRegistry({ fetchImpl }), {
      maxPromptCharacters: 4,
    });
    await expect(
      service.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "12345",
      }),
    ).rejects.toThrow("提示词超过");
    await expect(
      service.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "draw",
        size: "512x512" as never,
      }),
    ).rejects.toThrow("尺寸不受支持");
    await expect(
      service.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "draw",
        quality: "ultra" as never,
      }),
    ).rejects.toThrow("质量选项不受支持");

    const byteLimited = new MediaAiService(await loadRegistry({ fetchImpl }), {
      maxPromptCharacters: 10,
      maxPromptBytes: 4,
    });
    await expect(
      byteLimited.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "两只",
      }),
    ).rejects.toThrow("超过允许字节数");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized responses and decoded images", async () => {
    const oversizedResponseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ output_text: "too large" }));
    const responseLimited = new MediaAiService(
      await loadRegistry({ fetchImpl: oversizedResponseFetch }),
      { maxResponseBytes: 10 },
    );
    await expect(
      responseLimited.describeImages({
        userId: "u",
        images: [{ data: Buffer.from("x"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("返回内容超过允许大小");

    const imageFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [{ b64_json: Buffer.concat([PNG, Buffer.from([0])]).toString("base64") }],
      }),
    );
    const imageLimited = new MediaAiService(
      await loadRegistry({ fetchImpl: imageFetch }),
      { maxGeneratedImageBytes: PNG.byteLength },
    );
    await expect(
      imageLimited.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "draw",
      }),
    ).rejects.toThrow("无效 base64 图片");
  });

  it.each([
    [{ data: [] }, "返回格式无效"],
    [{ data: [{ b64_json: "not-base64" }] }, "无效 base64"],
    [
      { data: [{ b64_json: Buffer.from("not an image").toString("base64") }] },
      "不是有效的 PNG、JPEG 或 WebP",
    ],
    [
      { data: [{ b64_json: PNG.toString("base64") }, { b64_json: PNG.toString("base64") }] },
      "返回格式无效",
    ],
  ])("rejects an invalid generation response", async (payload, message) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(payload));
    const service = new MediaAiService(await loadRegistry({ fetchImpl }));
    await expect(
      service.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "draw",
      }),
    ).rejects.toThrow(message);
  });

  it("does not expose keys, prompts, or base64 payloads in HTTP errors", async () => {
    const prompt = "private prompt that must not leak";
    const encoded = Buffer.from("private image bytes").toString("base64");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: `cliproxy-secret ${prompt} data:image/png;base64,${encoded}`,
          },
        },
        { status: 400 },
      ),
    );
    const service = new MediaAiService(await loadRegistry({ fetchImpl }));

    let thrown: unknown;
    try {
      await service.generateImage({
        userId: "u",
        agentId: "a",
        prompt,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("HTTP 400");
    expect(message).not.toContain("cliproxy-secret");
    expect(message).not.toContain(prompt);
    expect(message).not.toContain(encoded);
    expect(message).not.toContain("base64");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries one transient generation failure and then succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, { status: 500 }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ b64_json: PNG.toString("base64") }] }),
      );
    const service = new MediaAiService(await loadRegistry({ fetchImpl }));

    await expect(
      service.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "draw",
      }),
    ).resolves.toMatchObject({ data: PNG, mimeType: "image/png" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a transient generation failure at most once", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "temporary" }, { status: 500 }));
    const service = new MediaAiService(await loadRegistry({ fetchImpl }));

    await expect(
      service.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "draw",
      }),
    ).rejects.toThrow("HTTP 500");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sanitizes transport errors and honors an explicit timeout", async () => {
    const leakyFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error("cliproxy-secret private prompt data:image/png;base64,AAAA"),
      );
    const leakyService = new MediaAiService(
      await loadRegistry({ fetchImpl: leakyFetch }),
    );
    await expect(
      leakyService.generateImage({
        userId: "u",
        agentId: "a",
        prompt: "private prompt",
      }),
    ).rejects.toThrow(/^图片生成 API 请求失败。$/u);
    expect(leakyFetch).toHaveBeenCalledTimes(2);

    // A non-cooperative transport must not be able to bypass the deadline.
    const timeoutFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Promise<Response>(() => undefined));
    const timeoutService = new MediaAiService(
      await loadRegistry({ fetchImpl: timeoutFetch }),
      { imageGenerationTimeoutMs: 1 },
    );
    const timedRequest = timeoutService.generateImage({
      userId: "u",
      agentId: "a",
      prompt: "draw",
    });
    await expect(timedRequest).rejects.toThrow("请求超时");
    await timedRequest.catch((error: unknown) => {
      expect(error).toMatchObject({ name: "AbortError" });
    });
    expect(timeoutFetch).toHaveBeenCalledTimes(2);
  });
});
