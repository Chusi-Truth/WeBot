import { describe, expect, it, vi } from "vitest";

import {
  IMAGE_GENERATE_TOOL_NAME,
  ToolExecutionError,
  ToolRegistry,
} from "../src/tool-registry.js";

const geocodingBody = {
  results: [
    {
      id: 1796236,
      name: "上海",
      latitude: 31.22222,
      longitude: 121.45806,
      country: "中国",
      arbitrary_external_description: "此内容不得进入工具输出",
    },
  ],
};

const forecastBody = {
  latitude: 31.2,
  longitude: 121.5,
  timezone: "Asia/Shanghai",
  daily: {
    time: ["2026-07-27", "2026-07-28"],
    weather_code: [2, 95],
    temperature_2m_max: [34.2, 32],
    temperature_2m_min: [27.1, 26],
    precipitation_probability_max: [18, 76],
    wind_speed_10m_max: [16.4, 28],
    external_summary: ["untrusted text", "more untrusted text"],
  },
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function successfulFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse(geocodingBody))
    .mockResolvedValueOnce(jsonResponse(forecastBody));
}

describe("ToolRegistry", () => {
  it("does not register image generation unless a runtime is configured", () => {
    const registry = new ToolRegistry({ fetchImpl: vi.fn<typeof fetch>() });

    expect(
      registry.definitionsFor("chat").map((item) => item.function.name),
    ).not.toContain(IMAGE_GENERATE_TOOL_NAME);
    expect(registry.getDescriptor(IMAGE_GENERATE_TOOL_NAME)).toBeUndefined();
  });

  it("registers image generation only for chat with a strict schema", () => {
    const registry = new ToolRegistry({
      imageGenerator: { generate: vi.fn() },
    });

    const definition = registry
      .definitionsFor("chat")
      .find((item) => item.function.name === IMAGE_GENERATE_TOOL_NAME);
    expect(definition?.function.parameters).toEqual({
      type: "object",
      properties: {
        prompt: expect.objectContaining({
          type: "string",
          minLength: 1,
        }),
        includesAgent: expect.objectContaining({
          type: "boolean",
        }),
        size: expect.objectContaining({
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536"],
        }),
        quality: expect.objectContaining({
          type: "string",
          enum: ["low", "medium", "high"],
        }),
      },
      required: ["prompt", "includesAgent"],
      additionalProperties: false,
    });
    expect(
      registry.definitionsFor("schedule").map((item) => item.function.name),
    ).not.toContain(IMAGE_GENERATE_TOOL_NAME);
    expect(
      registry.getDescriptor(IMAGE_GENERATE_TOOL_NAME)?.authorization,
    ).toEqual({
      readOnly: false,
      allowedSources: ["chat"],
      allowedNetworkHosts: [],
    });
  });

  it("requires image generation for an explicit current request but not cancellation", () => {
    const registry = new ToolRegistry({
      imageGenerator: { generate: vi.fn() },
    });
    const imageBehavior = {
      mode: "explicit" as const,
      cooldownMinutes: 90,
      allowAutonomous: false,
      visualIdentityPrompt: "",
    };

    expect(
      registry.requiredChatTool("算了，给我发张你的自拍", { imageBehavior }),
    ).toBe(IMAGE_GENERATE_TOOL_NAME);
    expect(
      registry.requiredChatTool("快来一张", { imageBehavior }),
    ).toBe(IMAGE_GENERATE_TOOL_NAME);
    expect(
      registry.requiredChatTool("来张白丝照", { imageBehavior }),
    ).toBe(IMAGE_GENERATE_TOOL_NAME);
    expect(
      registry.requiredChatTool("给我发张自拍\n算了，不用了", {
        imageBehavior,
      }),
    ).toBeUndefined();
    expect(
      registry.requiredChatTool("今天有点累", { imageBehavior }),
    ).toBeUndefined();
    expect(
      registry.requiredChatTool("给我发张自拍", {
        imageBehavior: { ...imageBehavior, mode: "off" },
      }),
    ).toBeUndefined();
  });

  it("hot-enables image generation when its private provider becomes available", () => {
    let available = false;
    const registry = new ToolRegistry({
      imageGenerator: {
        isAvailable: () => available,
        generate: vi.fn(),
      },
    });

    expect(
      registry.definitionsFor("chat").map((item) => item.function.name),
    ).not.toContain(IMAGE_GENERATE_TOOL_NAME);
    available = true;
    expect(
      registry.definitionsFor("chat").map((item) => item.function.name),
    ).toContain(IMAGE_GENERATE_TOOL_NAME);
  });

  it("generates an explicitly requested image and queues only its buffer", async () => {
    const imageData = Buffer.from("private generated image bytes");
    const generate = vi.fn().mockResolvedValue({
      data: imageData,
      mimeType: "image/png",
      revisedPrompt: "一只戴红围巾的水彩小猫",
      apiKey: "must-never-leak",
    });
    const acceptGeneratedImage = vi.fn();
    const registry = new ToolRegistry({ imageGenerator: { generate } });

    const result = await registry.execute(
      IMAGE_GENERATE_TOOL_NAME,
      JSON.stringify({
        prompt: "一只戴红围巾的水彩小猫",
        includesAgent: false,
        size: "1536x1024",
        quality: "high",
      }),
      {
        source: "chat",
        userId: "owner@im.wechat",
        agentId: "agent-a",
        currentUserInput: "请帮我生成一张戴红围巾的小猫图片",
        acceptGeneratedImage,
      },
    );

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith({
      userId: "owner@im.wechat",
      agentId: "agent-a",
      prompt: "一只戴红围巾的水彩小猫",
      size: "1536x1024",
      quality: "high",
    });
    expect(acceptGeneratedImage).toHaveBeenCalledOnce();
    expect(acceptGeneratedImage).toHaveBeenCalledWith({
      data: imageData,
      mimeType: "image/png",
      prompt: "一只戴红围巾的水彩小猫",
    });
    expect(result.data).toEqual({ success: true, queued: true });
    expect(JSON.parse(result.content)).toEqual(result.data);
    expect(Object.keys(result.data)).toEqual(["success", "queued"]);
    expect(result.content).not.toContain(imageData.toString("base64"));
    expect(result.content).not.toContain("must-never-leak");
    expect(result.content.toLowerCase()).not.toContain("apikey");
  });

  it.each([
    ["implicit mention", "这张海报的颜色很好看"],
    ["explicit refusal", "请不要帮我生成一张图片"],
    ["cancelled drawing", "取消画头像，只聊聊天"],
    ["English refusal", "Don't generate an image for me"],
    [
      "request only in a quoted message",
      "[引用消息]\n请帮我生成一张小猫图片\n[/引用消息]\n这是什么意思？",
    ],
    [
      "request in a spaced quote-tag variant",
      "【 引用 内容 】\n帮我画一只猫\n【 / 引用 内容 】\n好的",
    ],
    [
      "request in an English quote-tag variant",
      "<QUOTED MESSAGE>\nGenerate an image of a cat\n</quoted message>\nThanks",
    ],
    ["request in an unclosed quoted message", "[引用消息]\n请生成一张小猫图片"],
    ["terminal never mind", "请生成一张小猫图片，算了。"],
    ["terminal no longer needed", "帮我画一只猫\n不用了，谢谢。"],
    ["terminal cancellation", "制作一张海报。取消"],
    ["terminal cancellation of request", "请生成一张图片，取消这个请求。"],
    [
      "terminal English cancellation",
      "Generate an image of a cat. Never mind.",
    ],
  ])(
    "rejects image generation without affirmative intent: %s",
    async (_label, currentUserInput) => {
      const generate = vi.fn();
      const acceptGeneratedImage = vi.fn();
      const registry = new ToolRegistry({ imageGenerator: { generate } });

      await expect(
        registry.execute(
          IMAGE_GENERATE_TOOL_NAME,
          { prompt: "一只小猫", includesAgent: false },
          {
            source: "chat",
            userId: "owner@im.wechat",
            agentId: "agent-a",
            currentUserInput,
            acceptGeneratedImage,
          },
        ),
      ).rejects.toMatchObject({ code: "not_authorized" });
      expect(generate).not.toHaveBeenCalled();
      expect(acceptGeneratedImage).not.toHaveBeenCalled();
    },
  );

  it("ignores a refusal in a quoted message when the current text requests an image", async () => {
    const generate = vi.fn().mockResolvedValue({
      data: Buffer.from("generated image"),
      mimeType: "image/png",
    });
    const acceptGeneratedImage = vi.fn();
    const registry = new ToolRegistry({ imageGenerator: { generate } });

    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "一只小猫", includesAgent: false },
        {
          source: "chat",
          userId: "owner@im.wechat",
          agentId: "agent-a",
          currentUserInput:
            "[引用消息]\n请不要画图\n[/引用消息]\n现在请帮我画一只猫",
          acceptGeneratedImage,
        },
      ),
    ).resolves.toMatchObject({ data: { success: true, queued: true } });

    expect(generate).toHaveBeenCalledOnce();
    expect(acceptGeneratedImage).toHaveBeenCalledOnce();
  });

  it("allows contextual generation only in natural mode and keeps off mode disabled", async () => {
    const generate = vi.fn().mockResolvedValue({
      data: Buffer.from("generated image"),
      mimeType: "image/png",
    });
    const registry = new ToolRegistry({ imageGenerator: { generate } });
    const common = {
      source: "chat" as const,
      userId: "owner@im.wechat",
      agentId: "agent-a",
      currentUserInput: "我刚把阳台上的花重新摆好了",
      acceptGeneratedImage: vi.fn(),
    };

    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "傍晚阳台上的花", includesAgent: false },
        {
          ...common,
          imageBehavior: {
            mode: "natural",
            cooldownMinutes: 90,
            allowAutonomous: false,
            visualIdentityPrompt: "",
          },
        },
      ),
    ).resolves.toMatchObject({ data: { success: true, queued: true } });

    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "傍晚阳台上的花", includesAgent: false },
        {
          ...common,
          currentUserInput: "刚才的花很好看，但别发图片",
          imageBehavior: {
            mode: "natural",
            cooldownMinutes: 0,
            allowAutonomous: false,
            visualIdentityPrompt: "",
          },
        },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });

    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "傍晚阳台上的花", includesAgent: false },
        {
          ...common,
          currentUserInput: "请生成一张阳台图片",
          imageBehavior: {
            mode: "off",
            cooldownMinutes: 90,
            allowAutonomous: false,
            visualIdentityPrompt: "",
          },
        },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(
      registry
        .definitionsFor("chat", {
          imageBehavior: {
            mode: "off",
            cooldownMinutes: 90,
            allowAutonomous: false,
            visualIdentityPrompt: "",
          },
        })
        .map((item) => item.function.name),
    ).not.toContain(IMAGE_GENERATE_TOOL_NAME);
  });

  it("allows sequential natural images without a time interval or daily quota", async () => {
    const generated = {
      data: Buffer.from("generated image"),
      mimeType: "image/png" as const,
    };
    const generate = vi.fn().mockResolvedValue(generated);
    const behavior = {
      mode: "natural" as const,
      cooldownMinutes: 90,
      allowAutonomous: false,
      visualIdentityPrompt: "",
    };
    const context = (userId: string, agentId: string, input: string) => ({
      source: "chat" as const,
      userId,
      agentId,
      currentUserInput: input,
      imageBehavior: behavior,
      acceptGeneratedImage: vi.fn(),
    });
    const first = new ToolRegistry({ imageGenerator: { generate } });

    await first.execute(
      IMAGE_GENERATE_TOOL_NAME,
      { prompt: "窗边的晚霞", includesAgent: false },
      context("user-a", "agent-a", "今天的晚霞很好看"),
    );
    await expect(
      first.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "窗边的晚霞", includesAgent: false },
        context("user-a", "agent-a", "天色又变了一点"),
      ),
    ).resolves.toMatchObject({ data: { success: true } });

    // The same runtime does not impose any shared or daily quota.
    await expect(
      first.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "另一扇窗", includesAgent: false },
        context("user-a", "agent-b", "这边也能看到晚霞"),
      ),
    ).resolves.toMatchObject({ data: { success: true } });
    await expect(
      first.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "山顶晚霞", includesAgent: false },
        context("user-b", "agent-a", "山顶的颜色很漂亮"),
      ),
    ).resolves.toMatchObject({ data: { success: true } });

    // Explicit generation is likewise unrestricted.
    await expect(
      first.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "窗边的晚霞", includesAgent: false },
        context("user-a", "agent-a", "请生成一张窗边晚霞图片"),
      ),
    ).resolves.toMatchObject({ data: { success: true } });

    const afterRestart = new ToolRegistry({ imageGenerator: { generate } });
    await expect(
      afterRestart.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "夜里的窗", includesAgent: false },
        context("user-a", "agent-a", "窗外已经黑了"),
      ),
    ).resolves.toMatchObject({ data: { success: true } });
    expect(generate).toHaveBeenCalledTimes(6);
  });

  it("does not consume natural cooldown after generation or queue failure", async () => {
    let failGeneration = true;
    const generate = vi.fn(async () => {
      if (failGeneration) throw new Error("temporary failure");
      return {
        data: Buffer.from("generated image"),
        mimeType: "image/png" as const,
      };
    });
    const registry = new ToolRegistry({ imageGenerator: { generate } });
    const behavior = {
      mode: "natural" as const,
      cooldownMinutes: 90,
      allowAutonomous: false,
      visualIdentityPrompt: "",
    };
    const base = {
      source: "chat" as const,
      userId: "user-a",
      agentId: "agent-a",
      currentUserInput: "刚才看到一片很好看的云",
      imageBehavior: behavior,
    };

    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "云", includesAgent: false },
        { ...base, acceptGeneratedImage: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "upstream_error" });
    failGeneration = false;
    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "云", includesAgent: false },
        { ...base, acceptGeneratedImage: vi.fn() },
      ),
    ).resolves.toMatchObject({ data: { success: true } });

    const queueFailureRegistry = new ToolRegistry({
      imageGenerator: { generate },
    });
    await expect(
      queueFailureRegistry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "另一片云", includesAgent: false },
        {
          ...base,
          acceptGeneratedImage: () => {
            throw new Error("queue unavailable");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "upstream_error" });
    await expect(
      queueFailureRegistry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "另一片云", includesAgent: false },
        { ...base, acceptGeneratedImage: vi.fn() },
      ),
    ).resolves.toMatchObject({ data: { success: true } });
  });

  it("blocks concurrent natural generation for the same user and Agent", async () => {
    let release!: (value: { data: Buffer; mimeType: "image/png" }) => void;
    const pending = new Promise<{
      data: Buffer;
      mimeType: "image/png";
    }>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn(() => pending);
    const registry = new ToolRegistry({ imageGenerator: { generate } });
    const context = {
      source: "chat" as const,
      userId: "user-a",
      agentId: "agent-a",
      currentUserInput: "窗边的光线很好看",
      imageBehavior: {
        mode: "natural" as const,
        cooldownMinutes: 90,
        allowAutonomous: false,
        visualIdentityPrompt: "",
      },
      acceptGeneratedImage: vi.fn(),
    };

    const first = registry.execute(
      IMAGE_GENERATE_TOOL_NAME,
      { prompt: "窗边光线", includesAgent: false },
      context,
    );
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "窗边光线", includesAgent: false },
        context,
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
    release({ data: Buffer.from("generated image"), mimeType: "image/png" });
    await expect(first).resolves.toMatchObject({ data: { success: true } });
  });

  it("sends trusted visual identity only when the Agent is actually in frame", async () => {
    const generate = vi.fn().mockResolvedValue({
      data: Buffer.from("generated image"),
      mimeType: "image/png",
    });
    const registry = new ToolRegistry({ imageGenerator: { generate } });

    await registry.execute(
      IMAGE_GENERATE_TOOL_NAME,
      { prompt: "雨后的空街道", includesAgent: false },
      {
        source: "chat",
        userId: "user-a",
        agentId: "agent-a",
        currentUserInput: "刚才外面的街道很安静",
        imageBehavior: {
          mode: "natural",
          cooldownMinutes: 0,
          allowAutonomous: false,
          visualIdentityPrompt: "黑色短发，深棕色眼睛",
        },
        acceptGeneratedImage: vi.fn(),
      },
    );

    const sceneryPrompt = generate.mock.calls[0]![0].prompt;
    expect(sceneryPrompt).toBe("雨后的空街道");
    expect(sceneryPrompt).not.toContain("黑色短发，深棕色眼睛");

    await registry.execute(
      IMAGE_GENERATE_TOOL_NAME,
      { prompt: "她站在雨后街边的手机随拍", includesAgent: true },
      {
        source: "chat",
        userId: "user-a",
        agentId: "agent-a",
        currentUserInput: "刚才站在街边的时候风有点大",
        imageBehavior: {
          mode: "natural",
          cooldownMinutes: 0,
          allowAutonomous: false,
          visualIdentityPrompt: "黑色短发，深棕色眼睛",
        },
        acceptGeneratedImage: vi.fn(),
      },
    );

    const portraitPrompt = generate.mock.calls[1]![0].prompt;
    expect(portraitPrompt).toContain("她站在雨后街边的手机随拍");
    expect(portraitPrompt).toContain("黑色短发，深棕色眼睛");
    expect(portraitPrompt).toContain("画面已明确包含当前 Agent 本人");
    expect(portraitPrompt).toContain("普通“给你拍一张”“来张照片”");
    expect(portraitPrompt).toContain("优先理解为自然手机自拍");
    expect(portraitPrompt).toContain("不得凭空采用隐形第三人摄影师");
  });

  it("allows sequential trusted autonomous images without a time interval", async () => {
    const generate = vi.fn().mockResolvedValue({
      data: Buffer.from("autonomous image"),
      mimeType: "image/png",
    });
    const deliver = vi.fn().mockResolvedValue("image-client-id");
    const registry = new ToolRegistry({ imageGenerator: { generate } });
    const request = {
      userId: "user-a",
      agentId: "agent-a",
      imageBehavior: {
        mode: "natural" as const,
        cooldownMinutes: 90,
        allowAutonomous: true,
        visualIdentityPrompt: "黑色短发，深棕色眼睛",
      },
      prompt: "她在书店里发现旧版地图时拍下的自然手机照片",
      includesAgent: true,
      deliver,
    };

    await expect(
      registry.generateAndDeliverAutonomousImage(request),
    ).resolves.toEqual({ delivered: true });
    expect(generate).toHaveBeenCalledWith({
      userId: "user-a",
      agentId: "agent-a",
      prompt: expect.stringMatching(
        /黑色短发，深棕色眼睛[\s\S]*Agent 视觉设定结束/u,
      ),
    });
    expect(generate.mock.calls[0]![0].prompt).toContain("镜面自拍");
    expect(deliver).toHaveBeenCalledWith({
      data: Buffer.from("autonomous image"),
      mimeType: "image/png",
      prompt: "她在书店里发现旧版地图时拍下的自然手机照片",
    });
    await expect(
      registry.generateAndDeliverAutonomousImage(request),
    ).resolves.toEqual({ delivered: true });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not consume autonomous image cooldown when delivery fails", async () => {
    const generate = vi.fn().mockResolvedValue({
      data: Buffer.from("autonomous image"),
      mimeType: "image/png",
    });
    const registry = new ToolRegistry({ imageGenerator: { generate } });
    const base = {
      userId: "user-a",
      agentId: "agent-a",
      imageBehavior: {
        mode: "natural" as const,
        cooldownMinutes: 90,
        allowAutonomous: true,
        visualIdentityPrompt: "",
      },
      prompt: "桌上摊开的旧地图",
      includesAgent: false,
    };

    await expect(
      registry.generateAndDeliverAutonomousImage({
        ...base,
        deliver: vi.fn().mockRejectedValue(new Error("upload failed")),
      }),
    ).rejects.toMatchObject({ code: "upstream_error" });
    await expect(
      registry.generateAndDeliverAutonomousImage({
        ...base,
        deliver: vi.fn().mockResolvedValue("image-client-id"),
      }),
    ).resolves.toEqual({ delivered: true });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("rejects autonomous delivery unless natural mode and its separate switch are enabled", async () => {
    const generate = vi.fn();
    const registry = new ToolRegistry({ imageGenerator: { generate } });
    const base = {
      userId: "user-a",
      agentId: "agent-a",
      prompt: "桌上的旧地图",
      includesAgent: false,
      deliver: vi.fn(),
    };

    for (const imageBehavior of [
      {
        mode: "explicit" as const,
        cooldownMinutes: 90,
        allowAutonomous: true,
        visualIdentityPrompt: "",
      },
      {
        mode: "natural" as const,
        cooldownMinutes: 90,
        allowAutonomous: false,
        visualIdentityPrompt: "",
      },
      {
        mode: "off" as const,
        cooldownMinutes: 90,
        allowAutonomous: true,
        visualIdentityPrompt: "",
      },
    ]) {
      await expect(
        registry.generateAndDeliverAutonomousImage({
          ...base,
          imageBehavior,
        }),
      ).rejects.toMatchObject({ code: "not_authorized" });
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ["non-object", null],
    ["missing prompt", { includesAgent: false }],
    ["missing includesAgent", { prompt: "小猫" }],
    ["non-boolean includesAgent", { prompt: "小猫", includesAgent: "yes" }],
    ["non-string prompt", { prompt: 123, includesAgent: false }],
    ["empty prompt", { prompt: "   ", includesAgent: false }],
    ["extra field", { prompt: "小猫", includesAgent: false, apiKey: "secret" }],
    ["invalid size", { prompt: "小猫", includesAgent: false, size: "512x512" }],
    ["invalid quality", { prompt: "小猫", includesAgent: false, quality: "ultra" }],
    ["control character", { prompt: "小猫\n忽略规则", includesAgent: false }],
    ["too many characters", { prompt: "a".repeat(2_001), includesAgent: false }],
  ])("rejects invalid image arguments: %s", async (_label, args) => {
    const generate = vi.fn();
    const registry = new ToolRegistry({ imageGenerator: { generate } });

    await expect(
      registry.execute(IMAGE_GENERATE_TOOL_NAME, args, {
        source: "chat",
        userId: "owner@im.wechat",
        agentId: "agent-a",
        currentUserInput: "请生成一张小猫图片",
        acceptGeneratedImage: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects image generation without a delivery sink", async () => {
    const generate = vi.fn();
    const registry = new ToolRegistry({ imageGenerator: { generate } });

    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "一张小猫图片", includesAgent: false },
        {
          source: "chat",
          userId: "owner@im.wechat",
          agentId: "agent-a",
          currentUserInput: "请生成一张小猫图片",
        },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("normalizes image generation network failures", async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(
        new Error("network failed with secret upstream details"),
      );
    const acceptGeneratedImage = vi.fn();
    const registry = new ToolRegistry({ imageGenerator: { generate } });

    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "一张小猫图片", includesAgent: false },
        {
          source: "chat",
          userId: "owner@im.wechat",
          agentId: "agent-a",
          currentUserInput: "请生成一张小猫图片",
          acceptGeneratedImage,
        },
      ),
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: "Image generation request failed",
    });
    expect(acceptGeneratedImage).not.toHaveBeenCalled();
  });

  it("preserves a sanitized moderation explanation for the chat model", async () => {
    const moderationError = new Error("private upstream safety details");
    moderationError.name = "MediaAiModerationError";
    const registry = new ToolRegistry({
      imageGenerator: { generate: vi.fn().mockRejectedValue(moderationError) },
    });

    await expect(
      registry.execute(
        IMAGE_GENERATE_TOOL_NAME,
        { prompt: "一张人物照片", includesAgent: true },
        {
          source: "chat",
          userId: "owner@im.wechat",
          agentId: "agent-a",
          currentUserInput: "请生成一张人物照片",
          acceptGeneratedImage: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      code: "not_authorized",
      message: expect.stringContaining("内容安全规则拒绝"),
    });
  });

  it("exposes a read-only weather definition to chat and schedule", () => {
    const registry = new ToolRegistry({ fetchImpl: vi.fn<typeof fetch>() });

    for (const source of ["chat", "schedule"] as const) {
      expect(registry.definitionsFor(source)).toEqual([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "weather_current",
            parameters: expect.objectContaining({
              required: ["location"],
              additionalProperties: false,
            }),
          }),
        }),
      ]);
    }
    expect(registry.getDescriptor("weather_current")?.authorization).toEqual({
      readOnly: true,
      allowedSources: ["chat", "schedule"],
      allowedNetworkHosts: [
        "geocoding-api.open-meteo.com",
        "api.open-meteo.com",
      ],
    });
  });

  it("exposes reminder proposals only to chat and stores only a pending candidate", async () => {
    const propose = vi.fn().mockResolvedValue({
      id: "A1B2C3",
      title: "交报告",
      dueAt: "2026-07-29T07:00:00.000Z",
      timeZone: "Asia/Shanghai",
      createdAt: "2026-07-28T02:00:00.000Z",
      expiresAt: "2026-07-28T02:30:00.000Z",
    });
    const registry = new ToolRegistry({
      fetchImpl: vi.fn<typeof fetch>(),
      reminders: { propose },
      now: () => new Date("2026-07-28T02:00:00.000Z"),
    });

    expect(
      registry.definitionsFor("chat").map((item) => item.function.name),
    ).toEqual(["weather_current", "reminder_propose"]);
    expect(
      registry.definitionsFor("schedule").map((item) => item.function.name),
    ).toEqual(["weather_current"]);
    expect(registry.getDescriptor("reminder_propose")?.authorization).toEqual({
      readOnly: false,
      allowedSources: ["chat"],
      allowedNetworkHosts: [],
    });

    const result = await registry.execute(
      "reminder_propose",
      JSON.stringify({ title: "交报告" }),
      {
        source: "chat",
        userId: "owner@im.wechat",
        agentId: "agent-a",
        currentUserInput: "我明天下午3点要交报告",
      },
    );

    expect(propose).toHaveBeenCalledWith(
      "owner@im.wechat",
      "agent-a",
      {
        title: "交报告",
        dueAt: "2026-07-29T07:00:00.000Z",
      },
      "2026-07-28T02:00:00.000Z",
    );
    expect(result.data).toMatchObject({
      status: "pending_confirmation",
      proposal: {
        id: "A1B2C3",
        title: "交报告",
        localTime: expect.stringContaining("15:00"),
      },
      confirmationCommand: "确认提醒 A1B2C3",
    });
    expect(JSON.stringify(result.data)).not.toContain("owner@im.wechat");
  });

  it("rejects reminder proposals invented from persona or without an exact time", async () => {
    const propose = vi.fn();
    const registry = new ToolRegistry({
      reminders: { propose },
      now: () => new Date("2026-07-28T02:00:00.000Z"),
    });
    const context = {
      source: "chat" as const,
      userId: "owner@im.wechat",
      agentId: "agent-a",
      currentUserInput: "我明天要交报告",
    };

    await expect(
      registry.execute("reminder_propose", { title: "交报告" }, context),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(
      registry.execute(
        "reminder_propose",
        { title: "服药" },
        {
          ...context,
          currentUserInput: "我明天下午3点要交报告",
        },
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(propose).not.toHaveBeenCalled();
  });

  it("queries only fixed HTTPS hosts and returns bounded whitelisted JSON", async () => {
    const fetchImpl = successfulFetch();
    const registry = new ToolRegistry({ fetchImpl });

    const result = await registry.execute(
      "weather_current",
      JSON.stringify({ location: "  上海  ", forecastDay: "tomorrow" }),
      { source: "chat" },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [geocodingUrl, geocodingInit] = fetchImpl.mock.calls[0] ?? [];
    expect(new URL(String(geocodingUrl)).hostname).toBe(
      "geocoding-api.open-meteo.com",
    );
    expect(new URL(String(geocodingUrl)).searchParams.get("name")).toBe("上海");
    expect(geocodingInit).toMatchObject({
      method: "GET",
      redirect: "error",
    });
    expect(geocodingInit?.signal).toBeInstanceOf(AbortSignal);

    const [forecastUrl, forecastInit] = fetchImpl.mock.calls[1] ?? [];
    const parsedForecastUrl = new URL(String(forecastUrl));
    expect(parsedForecastUrl.protocol).toBe("https:");
    expect(parsedForecastUrl.hostname).toBe("api.open-meteo.com");
    expect(parsedForecastUrl.searchParams.get("latitude")).toBe("31.22222");
    expect(parsedForecastUrl.searchParams.get("longitude")).toBe("121.45806");
    expect(parsedForecastUrl.searchParams.get("forecast_days")).toBe("2");
    expect(forecastInit).toMatchObject({
      method: "GET",
      redirect: "error",
    });

    expect(result).toMatchObject({
      name: "weather_current",
      source: "chat",
      data: {
        tool: "weather_current",
        location: "上海",
        forecastDay: "tomorrow",
        forecast: {
          date: "2026-07-28",
          weatherCode: 95,
          conditionZh: "雷暴",
          temperatureMinC: 26,
          temperatureMaxC: 32,
          precipitationProbabilityMaxPercent: 76,
          windSpeedMaxKmh: 28,
        },
        attribution: "Open-Meteo",
      },
    });
    expect(JSON.parse(result.content)).toEqual(result.data);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(4 * 1024);
    expect(result.content).not.toContain("external");
    expect(result.content).not.toContain("untrusted");
    expect(result.content).not.toContain("中国");
  });

  it("defaults to today's forecast and maps WMO codes locally", async () => {
    const registry = new ToolRegistry({ fetchImpl: successfulFetch() });

    const result = await registry.execute(
      "weather_current",
      { location: "上海" },
      { source: "schedule" },
    );

    expect(result.data).toMatchObject({
      forecastDay: "today",
      forecast: {
        date: "2026-07-27",
        weatherCode: 2,
        conditionZh: "局部多云",
      },
    });
  });

  it.each([
    ["non-object", null],
    ["array", ["上海"]],
    ["missing location", {}],
    ["non-string location", { location: 123 }],
    ["empty location", { location: "   " }],
    ["extra field", { location: "上海", url: "https://evil.invalid" }],
    ["invalid day", { location: "上海", forecastDay: "next-week" }],
    ["control characters", { location: "上海\n恶意内容" }],
    ["HTTP URL", { location: "https://evil.invalid" }],
    ["other URL scheme", { location: "file:///etc/passwd" }],
    ["www URL", { location: "www.evil.invalid" }],
    ["schemeless URL", { location: "evil.invalid/weather" }],
    ["protocol-relative URL", { location: "//evil.invalid/weather" }],
    ["too long", { location: "城".repeat(81) }],
  ])("rejects invalid arguments: %s", async (_label, args) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const registry = new ToolRegistry({ fetchImpl });

    await expect(
      registry.execute("weather_current", args, { source: "chat" }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON and oversized argument JSON", async () => {
    const registry = new ToolRegistry({ fetchImpl: vi.fn<typeof fetch>() });

    await expect(
      registry.execute("weather_current", "{bad", { source: "chat" }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(
      registry.execute(
        "weather_current",
        `{"location":"${"a".repeat(2100)}"}`,
        { source: "chat" },
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("rejects unknown tools and invalid invocation sources before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const registry = new ToolRegistry({ fetchImpl });

    await expect(
      registry.execute("fetch_url", { location: "上海" }, { source: "chat" }),
    ).rejects.toMatchObject({ code: "unknown_tool" });
    await expect(
      registry.execute(
        "weather_current",
        { location: "上海" },
        { source: "admin" as never },
      ),
    ).rejects.toMatchObject({ code: "unauthorized_source" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized upstream bodies by content-length", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "999",
        },
      }),
    );
    const registry = new ToolRegistry({
      fetchImpl,
      maxResponseBytes: 64,
    });

    await expect(
      registry.execute(
        "weather_current",
        { location: "上海" },
        { source: "chat" },
      ),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

  it("rejects streamed upstream bodies that cross the byte limit", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ padding: "x".repeat(200) }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const registry = new ToolRegistry({
      fetchImpl,
      maxResponseBytes: 64,
    });

    await expect(
      registry.execute(
        "weather_current",
        { location: "上海" },
        { source: "chat" },
      ),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

  it("aborts requests that exceed the timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const registry = new ToolRegistry({ fetchImpl, timeoutMs: 5 });

    await expect(
      registry.execute(
        "weather_current",
        { location: "上海" },
        { source: "chat" },
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it.each([
    ["HTTP failures", new Response("busy", { status: 503 })],
    [
      "non-JSON content",
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      }),
    ],
    [
      "invalid JSON",
      new Response("{", {
        headers: { "content-type": "application/json" },
      }),
    ],
  ])(
    "normalizes %s without returning upstream content",
    async (_label, response) => {
      const registry = new ToolRegistry({
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
      });

      await expect(
        registry.execute(
          "weather_current",
          { location: "上海" },
          { source: "chat" },
        ),
      ).rejects.toBeInstanceOf(ToolExecutionError);
    },
  );

  it("rejects unrecognized enums and out-of-range numeric fields", async () => {
    const badForecast = structuredClone(forecastBody);
    badForecast.daily.weather_code[0] = 1234;
    badForecast.daily.temperature_2m_max[0] = Number.POSITIVE_INFINITY;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(geocodingBody))
      .mockResolvedValueOnce(jsonResponse(badForecast));
    const registry = new ToolRegistry({ fetchImpl });

    await expect(
      registry.execute(
        "weather_current",
        { location: "上海" },
        { source: "chat" },
      ),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

  it("rejects invalid geocoding coordinates", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: [{ latitude: 999, longitude: 121 }],
      }),
    );
    const registry = new ToolRegistry({ fetchImpl });

    await expect(
      registry.execute(
        "weather_current",
        { location: "上海" },
        { source: "chat" },
      ),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });
});
