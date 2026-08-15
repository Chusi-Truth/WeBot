import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AgentFramework,
  type ReminderRuntime,
} from "../src/agent-framework.js";
import { AgentStore } from "../src/agent-store.js";
import type { AgentAutonomyRuntime } from "../src/agent-types.js";

async function createFramework() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-agents-"));
  const store = new AgentStore({ stateDir });
  const framework = new AgentFramework({
    store,
    executor: ({ agent, memory, input }) =>
      `${agent.name}|${memory.length}|${input}`,
  });
  return { framework, store };
}

describe("AgentFramework", () => {
  it("provides compact and topic-specific help without writing memory", async () => {
    const { framework, store } = await createFramework();
    const userId = "alice@im.wechat";

    await expect(framework.handle(userId, "/help")).resolves.toContain(
      "/help agent",
    );
    await expect(framework.handle(userId, "/help agent")).resolves.toContain(
      "/agent create",
    );
    await expect(framework.handle(userId, "/help memory")).resolves.toContain(
      "/memory clear",
    );
    await expect(framework.handle(userId, "/help story")).resolves.toContain(
      "/story send <序号>",
    );
    await expect(framework.handle(userId, "/help model")).resolves.toContain(
      "/agent model default",
    );
    await expect(framework.handle(userId, "/help life")).resolves.toContain(
      "/life on",
    );
    await expect(
      framework.handle(userId, "/help reminder"),
    ).resolves.toContain("/reminder confirm");
    await expect(framework.handle(userId, "/help image")).resolves.toContain(
      "HTTPS 图片直链",
    );

    const agent = await store.getActiveAgent(userId);
    expect(await store.getMemory(userId, agent.id)).toHaveLength(0);
  });

  it("lists and sends the active Agent's private story book without invoking the model or writing memory", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-story-command-"));
    const store = new AgentStore({ stateDir });
    const executor = vi.fn(() => "不应调用");
    const framework = new AgentFramework({ store, executor });
    const userId = "alice@im.wechat";
    const agent = await store.getActiveAgent(userId);
    let book = await store.getStoryBook(userId, agent.id);
    book = await store.saveStoryBookEntry(
      userId,
      agent.id,
      {
        title: "雨夜来信",
        premise: "一封迟到的信。",
        content: "雨落在窗沿。\n\n她拆开那封信，读到了久违的名字。",
      },
      book.updatedAt,
    );

    await expect(framework.handle(userId, "/story")).resolves.toContain(
      "1. 雨夜来信",
    );
    await expect(framework.handle(userId, "/story send 1")).resolves.toEqual([
      "《雨夜来信》",
      "雨落在窗沿。\n\n她拆开那封信，读到了久违的名字。",
    ]);
    await expect(framework.handle(userId, "/story read 2")).resolves.toContain(
      "没有第 2 篇故事",
    );
    expect(executor).not.toHaveBeenCalled();
    expect(await store.getMemory(userId, agent.id)).toEqual([]);
    expect(book.stories).toHaveLength(1);
  });

  it("splits a long story into ordered chat-safe bubbles without losing its text", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-story-bubbles-"));
    const store = new AgentStore({ stateDir });
    const framework = new AgentFramework({
      store,
      executor: vi.fn(() => "不应调用"),
    });
    const userId = "alice@im.wechat";
    const agent = await store.getActiveAgent(userId);
    const paragraphs = Array.from(
      { length: 9 },
      (_, index) => `第${index + 1}段：${"风吹过长街。".repeat(90)}`,
    );
    const content = paragraphs.join("\n\n");
    const book = await store.getStoryBook(userId, agent.id);
    await store.saveStoryBookEntry(
      userId,
      agent.id,
      { title: "长篇", premise: "测试", content },
      book.updatedAt,
    );

    const reply = await framework.handle(userId, "/story send 1");
    expect(Array.isArray(reply)).toBe(true);
    const bubbles = reply as string[];
    expect(bubbles[0]).toBe("《长篇》");
    expect(bubbles.length).toBeGreaterThan(2);
    expect(bubbles.slice(1).every((part) => Array.from(part).length <= 3_200)).toBe(
      true,
    );
    expect(bubbles.slice(1).join("").replace(/\s/gu, "")).toBe(
      content.replace(/\s/gu, ""),
    );
  });

  it("finalizes a successful typed image reply using what the channel actually delivered", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-images-"));
    const store = new AgentStore({ stateDir });
    const sourceUrl = "https://images.example.test/photo.png";
    const executor = vi.fn(
      () =>
        `给你看这个\n[[下一条]]\n[[WEBOT_IMAGE_V1 ${sourceUrl}]]\n[[下一条]]\n挺好看的。`,
    );
    const framework = new AgentFramework({
      store,
      executor,
      outboundImages: true,
    });
    const userId = "alice@im.wechat";

    const result = await framework.handle(
      userId,
      `把这张图发给我：${sourceUrl}`,
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("图片回复应返回显式 OutgoingReplyEnvelope。");
    }
    expect(result.parts).toEqual([
      { type: "text", text: "给你看这个" },
      {
        type: "image",
        sourceUrl,
        fallbackText: "这张图片暂时没能发出去。",
      },
      { type: "text", text: "挺好看的。" },
    ]);

    const agent = await store.getActiveAgent(userId);
    expect(await store.getMemory(userId, agent.id)).toEqual([]);
    if (!result.finalizeDelivery) {
      throw new Error("图片回复缺少 finalizeDelivery。");
    }
    await result.finalizeDelivery([
      "给你看这个",
      "[发送了一张图片]",
      "挺好看的。",
    ]);
    const memory = await store.getMemory(userId, agent.id);
    expect(memory.map((message) => message.content)).toEqual([
      `把这张图发给我：${sourceUrl}`,
      "给你看这个",
      "[发送了一张图片]",
      "挺好看的。",
    ]);
    expect(
      memory
        .filter((message) => message.role === "assistant")
        .map((message) => message.content)
        .join("\n"),
    ).not.toContain(sourceUrl);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        imageOutputCapability: { maxImagesPerReply: 4 },
      }),
    );
  });

  it("queues a generated image out of band and stores only its description after delivery", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-generated-image-"));
    const store = new AgentStore({ stateDir });
    const binary = Buffer.from("not persisted image bytes");
    const executor = vi.fn((context) => {
      context.acceptGeneratedImage?.({
        data: binary,
        mimeType: "image/png",
        prompt: "一只戴红围巾的白猫",
      });
      return "画好了。";
    });
    const framework = new AgentFramework({
      store,
      executor,
      outboundImages: true,
      generatedImages: true,
    });
    const userId = "alice@im.wechat";

    const result = await framework.handle(userId, "帮我画一只白猫", {
      imageObservations: [
        { description: "参考图是一条红围巾", mimeType: "image/jpeg" },
      ],
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("生成图片回复应返回显式 OutgoingReplyEnvelope。");
    }
    expect(result.parts).toEqual([
      { type: "text", text: "画好了。" },
      expect.objectContaining({
        type: "generated_image",
        data: binary,
        mimeType: "image/png",
        memoryText: "[生成并发送了一张图片：一只戴红围巾的白猫]",
      }),
    ]);
    const agent = await store.getActiveAgent(userId);
    expect(await store.getMemory(userId, agent.id)).toEqual([]);

    await result.finalizeDelivery?.([
      "画好了。",
      "[生成并发送了一张图片：一只戴红围巾的白猫]",
    ]);
    const memory = await store.getMemory(userId, agent.id);
    const serialized = JSON.stringify(memory);
    expect(serialized).toContain("参考图是一条红围巾");
    expect(serialized).toContain("生成并发送了一张图片");
    expect(serialized).not.toContain(binary.toString("base64"));
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        imageObservations: ["参考图是一条红围巾"],
        imageOutputCapability: {
          maxImagesPerReply: 4,
          canGenerateImages: true,
        },
      }),
    );
  });

  it("passes trusted receive time to WeChat prompts and preserves it in memory", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-chat-time-"));
    const store = new AgentStore({ stateDir });
    const executor = vi.fn(() => "收到");
    const framework = new AgentFramework({ store, executor });
    const receivedAt = Date.parse("2026-08-13T04:35:00.000Z");

    await framework.handle("alice@im.wechat", "现在几点了", { receivedAt });

    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        chatTime: expect.objectContaining({
          timeZone: "Asia/Shanghai",
          currentMessageTime: "2026-08-13T04:35:00.000Z",
        }),
      }),
    );
    const agent = await store.getActiveAgent("alice@im.wechat");
    const memory = await store.getMemory("alice@im.wechat", agent.id);
    expect(memory[0]).toMatchObject({
      role: "user",
      content: "现在几点了",
      createdAt: "2026-08-13T04:35:00.000Z",
    });
    expect(Date.parse(memory[1]!.createdAt)).toBeGreaterThanOrEqual(receivedAt);
  });

  it("drops a legacy public-link directive after a generated image was queued", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-generated-image-directive-"));
    const store = new AgentStore({ stateDir });
    const binary = Buffer.from("generated image bytes");
    const framework = new AgentFramework({
      store,
      outboundImages: true,
      generatedImages: true,
      executor: (context) => {
        context.acceptGeneratedImage?.({
          data: binary,
          mimeType: "image/png",
          prompt: "窗边随拍",
        });
        return [
          "拍好了。",
          "[[下一条]]",
          "[[WEBOT_IMAGE_V1 generated-image-does-not-need-a-url]]",
        ].join("\n");
      },
    });

    const result = await framework.handle("alice@im.wechat", "快来一张");
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("生成图片回复应返回显式 OutgoingReplyEnvelope。");
    }
    expect(result.parts).toEqual([
      { type: "text", text: "拍好了。" },
      expect.objectContaining({
        type: "generated_image",
        data: binary,
      }),
    ]);
    expect(JSON.stringify(result.parts)).not.toContain("公网链接");
  });

  it("rejects invented or modified user image URLs and finalizes only the actual fallback text", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-image-url-authorization-"),
    );
    const store = new AgentStore({ stateDir });
    const userUrl = "https://images.example.test/user-photo.png";
    const modifiedUrl = `${userUrl}?secret=private-memory`;
    const inventedUrl =
      "https://attacker.example.test/collect.png?secret=private-memory";
    const framework = new AgentFramework({
      store,
      outboundImages: true,
      executor: () =>
        [
          `[[WEBOT_IMAGE_V1 ${modifiedUrl}]]`,
          "[[下一条]]",
          `[[WEBOT_IMAGE_V1 ${inventedUrl}]]`,
        ].join("\n"),
    });
    const userId = "alice@im.wechat";

    const result = await framework.handle(
      userId,
      `请把这张图发回来：${userUrl}`,
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("图片回复应返回显式 OutgoingReplyEnvelope。");
    }
    expect(result.parts).toEqual([
      { type: "text", text: "这张图片没有可用的公网链接。" },
      { type: "text", text: "这张图片没有可用的公网链接。" },
    ]);
    const agent = await store.getActiveAgent(userId);
    expect(await store.getMemory(userId, agent.id)).toEqual([]);

    if (!result.finalizeDelivery) {
      throw new Error("图片回复缺少 finalizeDelivery。");
    }
    await result.finalizeDelivery([
      "这张图片没有可用的公网链接。",
      "这张图片没有可用的公网链接。",
    ]);
    const memory = await store.getMemory(userId, agent.id);
    expect(memory.map(({ content }) => content)).toEqual([
      `请把这张图发回来：${userUrl}`,
      "这张图片没有可用的公网链接。",
      "这张图片没有可用的公网链接。",
    ]);
    expect(JSON.stringify(memory)).not.toContain("private-memory");
    expect(JSON.stringify(memory)).not.toContain("attacker.example.test");
    expect(JSON.stringify(memory)).not.toContain("[发送了一张图片]");
  });

  it("finalizes a failed image delivery as fallback text instead of a successful image", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-image-delivery-fallback-"),
    );
    const store = new AgentStore({ stateDir });
    const sourceUrl = "https://images.example.test/failing.png";
    const framework = new AgentFramework({
      store,
      outboundImages: true,
      executor: () => `[[WEBOT_IMAGE_V1 ${sourceUrl}]]`,
    });
    const userId = "alice@im.wechat";

    const result = await framework.handle(
      userId,
      `发这张图：${sourceUrl}`,
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("图片回复应返回显式 OutgoingReplyEnvelope。");
    }
    expect(result.parts).toEqual([
      {
        type: "image",
        sourceUrl,
        fallbackText: "这张图片暂时没能发出去。",
      },
    ]);
    const agent = await store.getActiveAgent(userId);
    expect(await store.getMemory(userId, agent.id)).toEqual([]);

    if (!result.finalizeDelivery) {
      throw new Error("图片回复缺少 finalizeDelivery。");
    }
    await result.finalizeDelivery([
      "这张图片暂时没能发出去。",
    ]);
    expect(
      (await store.getMemory(userId, agent.id)).map(({ content }) => content),
    ).toEqual([
      `发这张图：${sourceUrl}`,
      "这张图片暂时没能发出去。",
    ]);
  });

  it("handles deterministic reminder confirmations outside the model and records the turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-reminders-"));
    const store = new AgentStore({ stateDir });
    const handleNaturalAction = vi
      .fn<ReminderRuntime["handleNaturalAction"]>()
      .mockResolvedValue("好，已经设好了：7月30日 15:00 提醒你交报告。");
    const handleCommand = vi
      .fn<ReminderRuntime["handleCommand"]>()
      .mockResolvedValue("当前没有未完成的提醒。");
    const executor = vi.fn(() => "不应调用模型");
    const framework = new AgentFramework({
      store,
      executor,
      reminders: {
        timeZone: "Asia/Shanghai",
        handleNaturalAction,
        handleCommand,
      },
    });
    const userId = "alice@im.wechat";
    const agent = await store.getActiveAgent(userId);

    await expect(
      framework.handle(userId, "确认提醒 A1B2C3"),
    ).resolves.toContain("已经设好了");
    expect(handleNaturalAction).toHaveBeenCalledWith(
      userId,
      agent.id,
      "确认提醒 A1B2C3",
    );
    expect(executor).not.toHaveBeenCalled();
    expect(await store.getMemory(userId, agent.id)).toMatchObject([
      { role: "user", content: "确认提醒 A1B2C3" },
      { role: "assistant", content: expect.stringContaining("已经设好了") },
    ]);

    await expect(
      framework.handle(userId, "/reminder list"),
    ).resolves.toContain("没有未完成");
    expect(handleCommand).toHaveBeenCalledWith(
      userId,
      agent.id,
      "/reminder list",
    );
    expect(await store.getMemory(userId, agent.id)).toHaveLength(2);
  });

  it("injects trusted reminder capability metadata into ordinary model turns", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-capability-"),
    );
    const store = new AgentStore({ stateDir });
    const executor = vi.fn(({ reminderCapability }) =>
      reminderCapability?.timeZone ?? "missing",
    );
    const framework = new AgentFramework({
      store,
      executor,
      reminders: {
        timeZone: "Asia/Shanghai",
        handleNaturalAction: vi.fn().mockResolvedValue(null),
        handleCommand: vi.fn(),
      },
    });

    await expect(
      framework.handle("alice@im.wechat", "明天下午三点要交报告"),
    ).resolves.toBe("Asia/Shanghai");
  });

  it("delegates life commands and injects only the active agent's autonomous memories", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-life-"));
    const store = new AgentStore({ stateDir });
    const getRecentEvents = vi.fn<AgentAutonomyRuntime["getRecentEvents"]>()
      .mockResolvedValue([
        {
          id: "event-1",
          createdAt: "2026-07-22T02:00:00.000Z",
          summary: "独自整理了窗边的薄荷盆栽。",
          mood: "安静",
          importance: 2,
          shouldContactUser: false,
          contactStatus: "not_requested",
        },
      ]);
    const handleCommand = vi.fn<AgentAutonomyRuntime["handleCommand"]>()
      .mockResolvedValue("自主生活已开启");
    const executor = vi.fn(({ autonomousEvents }) =>
      autonomousEvents?.[0]?.summary ?? "没有自主记忆",
    );
    const framework = new AgentFramework({
      store,
      executor,
      autonomy: { getRecentEvents, handleCommand },
    });
    const userId = "alice@im.wechat";

    await expect(framework.handle(userId, "/life on")).resolves.toBe(
      "自主生活已开启",
    );
    expect(handleCommand).toHaveBeenCalledWith(userId, "/life on");
    expect(executor).not.toHaveBeenCalled();

    await expect(framework.handle(userId, "今天怎么样？")).resolves.toContain(
      "薄荷盆栽",
    );
    const agent = await store.getActiveAgent(userId);
    expect(getRecentEvents).toHaveBeenCalledWith(userId, agent.id, 10);
  });

  it("creates, switches, and lists custom identities", async () => {
    const { framework } = await createFramework();
    const userId = "alice@im.wechat";

    await expect(
      framework.handle(
        userId,
        "/agent create 论文助手 你是严谨的学术论文编辑",
      ),
    ).resolves.toContain("已创建并切换");
    await expect(framework.handle(userId, "/agent show")).resolves.toContain(
      "你是严谨的学术论文编辑",
    );
    await expect(framework.handle(userId, "/agent list")).resolves.toContain(
      "● 论文助手",
    );
    await expect(
      framework.handle(userId, "/agent use 默认助手"),
    ).resolves.toContain("已切换到 Agent“默认助手”");
  });

  it("keeps memory isolated between agents", async () => {
    const { framework, store } = await createFramework();
    const userId = "alice@im.wechat";

    expect(await framework.handle(userId, "默认消息")).toBe(
      "默认助手|0|默认消息",
    );
    const defaultAgent = await store.getActiveAgent(userId);

    await framework.handle(
      userId,
      "/agent create 编程助手 你是 TypeScript 专家",
    );
    expect(await framework.handle(userId, "代码消息")).toBe(
      "编程助手|0|代码消息",
    );
    const codingAgent = await store.getActiveAgent(userId);

    expect(await store.getMemory(userId, defaultAgent.id)).toHaveLength(2);
    expect(await store.getMemory(userId, codingAgent.id)).toHaveLength(2);
    expect(
      (await store.getMemory(userId, defaultAgent.id))[0]?.content,
    ).toBe("默认消息");
    expect(
      (await store.getMemory(userId, codingAgent.id))[0]?.content,
    ).toBe("代码消息");
  });

  it("stores multiple assistant bubbles as one complete conversation turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-bubbles-"));
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const userId = "alice@im.wechat";
    const agent = await store.getActiveAgent(userId);

    await store.appendTurn(userId, agent.id, {
      input: "你毕业了吗？",
      replies: ["刚下班。", "现在在看店。", "怎么突然问这个？"],
    });
    const firstMemory = await store.getMemoryContext(userId, agent.id);
    expect(firstMemory.messages.map(({ role, content }) => ({ role, content })))
      .toEqual([
        { role: "user", content: "你毕业了吗？" },
        { role: "assistant", content: "刚下班。" },
        { role: "assistant", content: "现在在看店。" },
        { role: "assistant", content: "怎么突然问这个？" },
      ]);
    expect(firstMemory.totalMessageCount).toBe(4);
    expect(await store.getHistory(userId, agent.id)).toHaveLength(4);

    await store.appendTurn(userId, agent.id, {
      input: "随口问问。",
      reply: "哦。",
    });
    const candidate = await store.prepareMemoryCompression(userId, agent.id);
    expect(candidate?.messages.map((message) => message.content)).toEqual([
      "你毕业了吗？",
      "刚下班。",
      "现在在看店。",
      "怎么突然问这个？",
    ]);
  });

  it("does not cap model-separated WeChat bubbles and remembers each one", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-bubble-flow-"));
    const store = new AgentStore({ stateDir });
    const framework = new AgentFramework({
      store,
      // Kept to prove the legacy option no longer truncates replies.
      maxReplyBubbles: 3,
      executor: () =>
        [
          "刚下班。",
          "现在在看店。",
          "今天整理了地图。",
          "还擦了货架。",
          "晚点准备关门。",
          "不过外面还在下雨。",
          "怎么突然问这个？",
        ].join("\n[[下一条]]\n"),
    });
    const userId = "alice@im.wechat";

    await expect(framework.handle(userId, "你毕业了吗？")).resolves.toEqual([
      "刚下班。",
      "现在在看店。",
      "今天整理了地图。",
      "还擦了货架。",
      "晚点准备关门。",
      "不过外面还在下雨。",
      "怎么突然问这个？",
    ]);
    const agent = await store.getActiveAgent(userId);
    const memory = await store.getMemoryContext(userId, agent.id);
    expect(memory.messages.map((message) => message.content)).toEqual([
      "你毕业了吗？",
      "刚下班。",
      "现在在看店。",
      "今天整理了地图。",
      "还擦了货架。",
      "晚点准备关门。",
      "不过外面还在下雨。",
      "怎么突然问这个？",
    ]);
    expect(memory.messages.map((message) => message.conversationMode)).toEqual([
      "wechat",
      "wechat",
      "wechat",
      "wechat",
      "wechat",
      "wechat",
      "wechat",
      "wechat",
    ]);
  });

  it("keeps profiles and selections isolated between users", async () => {
    const { framework } = await createFramework();

    await framework.handle(
      "alice@im.wechat",
      "/agent create 私人助手 只服务 Alice",
    );

    await expect(
      framework.handle("bob@im.wechat", "/agent list"),
    ).resolves.not.toContain("私人助手");
    await expect(
      framework.handle("bob@im.wechat", "/agent show"),
    ).resolves.toContain("当前 Agent：默认助手");
  });

  it("clears only the active agent memory", async () => {
    const { framework, store } = await createFramework();
    const userId = "alice@im.wechat";

    await framework.handle(userId, "记住这句话");
    const agent = await store.getActiveAgent(userId);
    expect(await store.getMemory(userId, agent.id)).toHaveLength(2);

    await expect(
      framework.handle(userId, "/memory clear"),
    ).resolves.toContain("已清空");
    expect(await store.getMemory(userId, agent.id)).toHaveLength(0);
  });

  it("does not restore cleared memory when an in-flight reply finishes later", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-clear-race-"));
    const store = new AgentStore({ stateDir });
    let markStarted!: () => void;
    let releaseReply!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const framework = new AgentFramework({
      store,
      capturePromptTraceGeneration: () => 42,
      executor: async (context) => {
        expect(context.promptTraceGeneration).toBe(42);
        markStarted();
        await replyGate;
        return "稍后完成的回复";
      },
    });
    const userId = "alice@im.wechat";
    const pendingReply = framework.handle(userId, "处理中消息");
    await started;
    const agent = await store.clearActiveMemory(userId);
    releaseReply();

    await expect(pendingReply).resolves.toBe("稍后完成的回复");
    expect(await store.getMemory(userId, agent.id)).toEqual([]);
    expect(await store.getHistory(userId, agent.id)).toEqual([]);
  });

  it("keeps an agent visible when private-data cleanup fails during deletion", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-delete-retry-"));
    const store = new AgentStore({
      stateDir,
      onClearAgentData: async () => {
        throw new Error("模拟 Prompt Trace 删除失败");
      },
    });
    const userId = "alice@im.wechat";
    const original = await store.getActiveAgent(userId);
    const removable = await store.createAgent(userId, {
      name: "待删除角色",
      identity: "用于测试可重试删除。",
    });
    await store.switchAgentById(userId, original.id);

    await expect(store.deleteAgentById(userId, removable.id)).rejects.toThrow(
      "模拟 Prompt Trace 删除失败",
    );
    expect((await store.getRegistry(userId)).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: removable.id, name: "待删除角色" }),
      ]),
    );
  });

  it("does not apply stale background compression after memory is cleared", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-compress-race-"));
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const userId = "alice@im.wechat";
    const agent = await store.getActiveAgent(userId);
    await store.appendTurn(userId, agent.id, { input: "一", reply: "一答" });
    await store.appendTurn(userId, agent.id, { input: "二", reply: "二答" });
    await store.appendTurn(userId, agent.id, { input: "三", reply: "三答" });
    const generation = store.captureDataGeneration(userId, agent.id);
    const candidate = await store.prepareMemoryCompression(
      userId,
      agent.id,
      generation,
    );
    expect(candidate).not.toBeNull();

    await store.clearActiveMemory(userId);
    const applied = await store.applyMemoryCompression(
      userId,
      agent.id,
      candidate!,
      {
        summary: "不应复活的摘要",
        facts: [],
        episodes: [],
      },
      generation,
    );

    expect(applied).toBe(false);
    expect(await store.getMemory(userId, agent.id)).toEqual([]);
  });

  it("assigns a provider and model to the active agent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-agents-"));
    const store = new AgentStore({ stateDir });
    const framework = new AgentFramework({
      store,
      executor: ({ input }) => input,
      providers: {
        defaultProviderId: "openai",
        hasProvider: (id) => id === "openai" || id === "deepseek",
        listProviders: () => [
          {
            id: "openai",
            label: "OpenAI",
            api: "openai-responses",
            model: "gpt-5.6-terra",
            configured: true,
          },
          {
            id: "deepseek",
            label: "DeepSeek",
            api: "chat-completions",
            model: "deepseek-v4-flash",
            configured: true,
          },
        ],
      },
    });
    const userId = "alice@im.wechat";

    await expect(
      framework.handle(
        userId,
        "/agent model deepseek deepseek-v4-pro",
      ),
    ).resolves.toContain("deepseek / deepseek-v4-pro");
    await expect(
      framework.handle(userId, "/provider show"),
    ).resolves.toContain("deepseek / deepseek-v4-pro");

    await framework.handle(userId, "/agent model default");
    const agent = await store.getActiveAgent(userId);
    expect(agent.providerId).toBeUndefined();
    expect(agent.model).toBeUndefined();
  });

  it("switches the active agent between WeChat and immersive presentation", async () => {
    const { framework, store } = await createFramework();
    const userId = "alice@im.wechat";

    await expect(
      framework.handle(userId, "/agent mode wechat"),
    ).resolves.toContain("微信聊天模式");
    expect((await store.getActiveAgent(userId)).conversationMode).toBe("wechat");
    await framework.handle(userId, "聊天模式的一轮");
    await expect(framework.handle(userId, "/agent show")).resolves.toContain(
      "聊天表现：微信聊天",
    );

    await expect(
      framework.handle(userId, "/agent mode roleplay"),
    ).resolves.toContain("沉浸扮演模式");
    const agent = await store.getActiveAgent(userId);
    expect(agent.conversationMode).toBe("roleplay");
    await framework.handle(userId, "扮演模式的一轮");

    const memory = await store.getMemory(userId, agent.id);
    expect(memory.map((message) => message.conversationMode)).toEqual([
      "wechat",
      "wechat",
      "roleplay",
      "roleplay",
    ]);
    const history = await store.getHistory(userId, agent.id);
    expect(history.map((message) => message.conversationMode)).toEqual([
      "wechat",
      "wechat",
      "roleplay",
      "roleplay",
    ]);
  });

  it("archives every message and locally compacts when no curator is configured", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-memory-"));
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const framework = new AgentFramework({
      store,
      executor: ({ input }) => `回复：${input}`,
    });
    const userId = "alice@im.wechat";
    await framework.handle(userId, "我叫小雨，请记住我喜欢天文学");
    await framework.handle(userId, "第二轮对话");
    await framework.handle(userId, "第三轮对话");
    const agent = await store.getActiveAgent(userId);
    const memory = await store.getMemoryContext(userId, agent.id);
    const history = await store.getHistory(userId, agent.id);

    expect(memory.messages).toHaveLength(2);
    expect(memory.archivedMessageCount).toBe(4);
    expect(memory.totalMessageCount).toBe(6);
    expect(memory.compressionCount).toBe(1);
    expect(history).toHaveLength(6);
    expect(memory.summary).toContain("我叫小雨");
    expect(memory.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "姓名", value: "小雨" }),
        expect.objectContaining({ key: "偏好", value: "天文学" }),
      ]),
    );
  });

  it("lets an LLM curator choose durable facts and key episodes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-curator-"));
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const curator = vi.fn().mockResolvedValue({
      summary: "用户与角色约定一起寻找遗失的地图。",
      facts: [{ key: "偏好", value: "雨夜爵士" }],
      episodes: [
        {
          title: "地图约定",
          content: "两人约定共同调查无标签地图。",
          importance: 5 as const,
        },
      ],
    });
    const framework = new AgentFramework({
      store,
      executor: ({ input }) => `回复：${input}`,
      memoryCompressor: curator,
    });
    const userId = "alice@im.wechat";
    await framework.handle(userId, "我喜欢雨夜爵士");
    await framework.handle(userId, "一起找那张地图吧");
    await framework.handle(userId, "从仓库开始调查");
    const agent = await store.getActiveAgent(userId);

    await vi.waitFor(async () => {
      const memory = await store.getMemoryContext(userId, agent.id);
      expect(memory.compressionCount).toBe(1);
    });
    const memory = await store.getMemoryContext(userId, agent.id);
    expect(curator).toHaveBeenCalledOnce();
    expect(memory.messages).toHaveLength(2);
    expect(memory.summary).toContain("遗失的地图");
    expect(memory.facts).toEqual([
      expect.objectContaining({ key: "偏好", value: "雨夜爵士" }),
    ]);
    expect(memory.episodes).toEqual([
      expect.objectContaining({ title: "地图约定", importance: 5 }),
    ]);
    expect(await store.getHistory(userId, agent.id)).toHaveLength(6);
  });

  it("keeps the complete raw text in history even when prompt memory is bounded", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-raw-history-"));
    const store = new AgentStore({ stateDir });
    const framework = new AgentFramework({
      store,
      executor: () => "收到",
    });
    const input = "长".repeat(9_000);
    const userId = "alice@im.wechat";
    await framework.handle(userId, input);
    const agent = await store.getActiveAgent(userId);
    const memory = await store.getMemoryContext(userId, agent.id);
    const history = await store.getHistory(userId, agent.id);

    expect(memory.messages[0]?.content.length).toBe(8_001);
    expect(history[0]?.content).toBe(input);
  });
});
