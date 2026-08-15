import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calculateBubbleDelayMs,
  countVisibleCharacters,
  WeixinAdapter,
} from "../src/adapter.js";
import { ImageInputDownloader } from "../src/image-input.js";
import {
  MessageItemType,
  MessageType,
} from "../src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adaptive reply bubble delay", () => {
  const options = {
    baseMs: 800,
    perCharacterMs: 120,
    minMs: 1_000,
    maxMs: 7_000,
  };

  it("waits longer for a longer upcoming bubble", () => {
    expect(calculateBubbleDelayMs("嗯", options)).toBe(1_000);
    expect(calculateBubbleDelayMs("我马上就要过来。", options)).toBe(1_760);
  });

  it("counts graphemes, ignores whitespace, and caps very long messages", () => {
    expect(countVisibleCharacters("好 \n 的")).toBe(2);
    expect(countVisibleCharacters("e\u0301 👨‍👩‍👧‍👦")).toBe(2);
    expect(calculateBubbleDelayMs("好 \n 的", options)).toBe(1_040);
    expect(calculateBubbleDelayMs("很".repeat(100), options)).toBe(7_000);
  });
});

describe("WeixinAdapter incoming context", () => {
  it("captures a user context token before parsing unsupported media", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const adapter = new WeixinAdapter({
      stateDir,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 42,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "new-context-token",
                  item_list: [{ type: MessageItemType.IMAGE }],
                },
              ],
              get_updates_buf: "cursor-1",
            }),
          );
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();
    const handler = vi.fn();
    const contextHandler = vi.fn(() => adapter.stop());

    await adapter.start(handler, contextHandler);

    expect(contextHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "alice@im.wechat",
        contextToken: "new-context-token",
        messageId: 42,
      }),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("downloads an image-only message, analyzes it, and forwards no binary to the handler", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-image-in-"));
    const imageAnalyzer = vi.fn(async () => "画面里是一只坐在窗边的白猫。");
    const imageInputDownloader = {
      hasDownloadableImage: vi.fn(() => true),
      downloadAll: vi.fn(async () => [
        { data: Buffer.from("private-image-bytes"), mimeType: "image/png" as const },
      ]),
    };
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      imageAnalyzer,
      imageInputDownloader,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input).includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 43,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "image-context",
                  item_list: [{ type: MessageItemType.IMAGE }],
                },
              ],
              get_updates_buf: "cursor-image",
            }),
          );
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();
    const handler = vi.fn((message) => {
      adapter.stop();
      expect(message.text).toBe("[图片]");
      expect(message.imageObservations).toEqual([
        {
          description: "画面里是一只坐在窗边的白猫。",
          mimeType: "image/png",
        },
      ]);
      expect(JSON.stringify(message)).not.toContain(
        Buffer.from("private-image-bytes").toString("base64"),
      );
      return "看到了。";
    });

    await adapter.start(handler);

    expect(handler).toHaveBeenCalledOnce();
    expect(imageAnalyzer).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "alice@im.wechat",
        images: [
          expect.objectContaining({
            mimeType: "image/png",
          }),
        ],
      }),
    );
  });

  it("recognizes a real plaintext iLink image-only payload end to end", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-image-plain-"));
    const plainPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x01, 0x02, 0x03, 0x04,
    ]);
    const imageFetch = vi.fn(async () => new Response(plainPng));
    const imageAnalyzer = vi.fn(async () => "画面里有一个蓝色图标。");
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      imageAnalyzer,
      imageInputDownloader: new ImageInputDownloader({ fetchImpl: imageFetch }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input).includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 44,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "plain-image-context",
                  item_list: [
                    {
                      type: MessageItemType.IMAGE,
                      image_item: {
                        media: {
                          full_url: "https://media.example.test/plain-image",
                        },
                      },
                    },
                  ],
                },
              ],
              get_updates_buf: "cursor-plain-image",
            }),
          );
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();
    const handler = vi.fn((message) => {
      adapter.stop();
      expect(message.text).toBe("[图片]");
      expect(message.imageObservations).toEqual([
        { description: "画面里有一个蓝色图标。", mimeType: "image/png" },
      ]);
      return "看到了。";
    });

    await adapter.start(handler);

    expect(imageFetch).toHaveBeenCalledWith(
      "https://media.example.test/plain-image",
      { signal: expect.any(AbortSignal) },
    );
    expect(imageAnalyzer).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("WeixinAdapter reply bubbles", () => {
  it("combines one burst and checkpoints its cursor after processing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const sentTexts: string[] = [];
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 1,
      bubbleDelayMs: 0,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    let updateCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          updateCalls += 1;
          if (updateCalls === 1) {
            return new Response(
              JSON.stringify({
                ret: 0,
                msgs: [
                  {
                    message_id: 51,
                    message_type: MessageType.USER,
                    from_user_id: "alice@im.wechat",
                    context_token: "context-51",
                    item_list: [
                      {
                        type: MessageItemType.TEXT,
                        text_item: { text: "我今天" },
                      },
                    ],
                  },
                  {
                    message_id: 52,
                    message_type: MessageType.USER,
                    from_user_id: "alice@im.wechat",
                    context_token: "context-52",
                    item_list: [
                      {
                        type: MessageItemType.TEXT,
                        text_item: { text: "有点累" },
                      },
                    ],
                  },
                ],
                get_updates_buf: "cursor-burst",
              }),
            );
          }
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        if (url.includes("getconfig")) {
          return new Response(
            JSON.stringify({ ret: 0, typing_ticket: "typing-ticket" }),
          );
        }
        if (url.includes("sendmessage") && init?.body) {
          const body = JSON.parse(String(init.body)) as {
            msg: { item_list: Array<{ text_item: { text: string } }> };
          };
          sentTexts.push(body.msg.item_list[0]?.text_item.text ?? "");
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();
    const handler = vi.fn((incoming: { text: string; contextToken: string }) => {
      adapter.stop();
      expect(incoming).toMatchObject({
        text: "我今天\n有点累",
        contextToken: "context-52",
      });
      return "早点休息。";
    });

    await adapter.start(handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(updateCalls).toBeGreaterThanOrEqual(2);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toBe("早点休息。");
    expect(await adapter.store.loadCursor()).toBe("cursor-burst");
  });

  it("sends a visible fallback and stops typing when reply generation fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const sentTexts: string[] = [];
    const typingStatuses: number[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      bubbleDelayMs: 0,
      logger,
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    let updateCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          updateCalls += 1;
          if (updateCalls === 1) {
            return new Response(
              JSON.stringify({
                ret: 0,
                msgs: [
                  {
                    message_id: 53,
                    message_type: MessageType.USER,
                    from_user_id: "alice@im.wechat",
                    context_token: "context-53",
                    item_list: [
                      {
                        type: MessageItemType.TEXT,
                        text_item: { text: "继续" },
                      },
                    ],
                  },
                ],
                get_updates_buf: "cursor-failed-reply",
              }),
            );
          }
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        if (url.includes("getconfig")) {
          return new Response(
            JSON.stringify({ ret: 0, typing_ticket: "typing-ticket" }),
          );
        }
        if (url.includes("sendtyping") && init?.body) {
          const body = JSON.parse(String(init.body)) as { status: number };
          typingStatuses.push(body.status);
        }
        if (url.includes("sendmessage") && init?.body) {
          const body = JSON.parse(String(init.body)) as {
            msg: { item_list: Array<{ text_item: { text: string } }> };
          };
          sentTexts.push(body.msg.item_list[0]?.text_item.text ?? "");
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();

    await adapter.start(async () => {
      adapter.stop();
      throw new Error("model returned no text");
    });

    expect(sentTexts).toEqual(["刚才没有生成可发送的回复，请再发一次。"]);
    expect(typingStatuses).toEqual([1, 2]);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("carries unfinished work forward when a response has no new cursor", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      bubbleDelayMs: 0,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let signalThirdPoll!: () => void;
    const thirdPollStarted = new Promise<void>((resolve) => {
      signalThirdPoll = resolve;
    });
    let updateCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          updateCalls += 1;
          if (updateCalls === 1) {
            return new Response(
              JSON.stringify({
                ret: 0,
                msgs: [
                  {
                    message_id: 61,
                    message_type: MessageType.USER,
                    from_user_id: "alice@im.wechat",
                    context_token: "context-61",
                    item_list: [
                      {
                        type: MessageItemType.TEXT,
                        text_item: { text: "这条还没处理完" },
                      },
                    ],
                  },
                ],
              }),
            );
          }
          if (updateCalls === 2) {
            return new Response(
              JSON.stringify({
                ret: 0,
                msgs: [],
                get_updates_buf: "cursor-after-gap",
              }),
            );
          }
          signalThirdPoll();
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        if (url.includes("getconfig")) {
          return new Response(
            JSON.stringify({ ret: 0, typing_ticket: "typing-ticket" }),
          );
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();
    const handler = vi.fn(async () => {
      await handlerGate;
      adapter.stop();
    });

    const running = adapter.start(handler);
    await thirdPollStarted;
    expect(await adapter.store.loadCursor()).toBe("");

    releaseHandler();
    await running;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await adapter.store.loadCursor()).toBe("cursor-after-gap");
  });

  it("sends non-empty bubbles in order with one context token and distinct client IDs", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      bubbleDelayMs: 0,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};
        requests.push({ url, body });
        if (url.includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 43,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "fresh-context-token",
                  item_list: [
                    {
                      type: MessageItemType.TEXT,
                      text_item: { text: "你在做什么？" },
                    },
                  ],
                },
              ],
              get_updates_buf: "cursor-2",
            }),
          );
        }
        if (url.includes("getconfig")) {
          return new Response(
            JSON.stringify({ ret: 0, typing_ticket: "typing-ticket" }),
          );
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();

    await adapter.start(() => {
      adapter.stop();
      return ["第一条", "  ", "  第二条  "] as const;
    });

    const sentMessages = requests
      .filter(({ url }) => url.includes("sendmessage"))
      .map(({ body }) => body.msg as Record<string, unknown>);
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages.map((message) => message.context_token)).toEqual([
      "fresh-context-token",
      "fresh-context-token",
    ]);
    expect(
      sentMessages.map(
        (message) =>
          (
            message.item_list as Array<{
              text_item: { text: string };
            }>
          )[0]?.text_item.text,
      ),
    ).toEqual(["第一条", "第二条"]);
    expect(sentMessages[0]?.client_id).not.toBe(sentMessages[1]?.client_id);

    const relevantCalls = requests
      .filter(
        ({ url }) =>
          url.includes("sendtyping") || url.includes("sendmessage"),
      )
      .map(({ url, body }) => ({
        endpoint: url.includes("sendtyping") ? "typing" : "message",
        status: body.status,
      }));
    expect(relevantCalls).toEqual([
      { endpoint: "typing", status: 1 },
      { endpoint: "message", status: undefined },
      { endpoint: "message", status: undefined },
      { endpoint: "typing", status: 2 },
    ]);
  });

  it("keeps a string reply as one unchanged bubble", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const sentTexts: string[] = [];
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      bubbleDelayMs: 0,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 44,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "fresh-context-token",
                  item_list: [
                    {
                      type: MessageItemType.TEXT,
                      text_item: { text: "你好" },
                    },
                  ],
                },
              ],
              get_updates_buf: "cursor-3",
            }),
          );
        }
        if (url.includes("getconfig")) {
          return new Response(
            JSON.stringify({ ret: 0, typing_ticket: "typing-ticket" }),
          );
        }
        if (url.includes("sendmessage") && init?.body) {
          const body = JSON.parse(String(init.body)) as {
            msg: { item_list: Array<{ text_item: { text: string } }> };
          };
          sentTexts.push(body.msg.item_list[0]?.text_item.text ?? "");
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();

    await adapter.start(() => {
      adapter.stop();
      return "  保留两侧空格  ";
    });

    expect(sentTexts).toEqual(["  保留两侧空格  "]);
  });

  it("sends text, image, and text in the exact typed-part order", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const events: string[] = [];
    const sentContexts: string[] = [];
    const imageMediaSender = {
      sendFromUrl: vi.fn(async (params: {
        sourceUrl: string;
        toUserId: string;
        contextToken: string;
      }) => {
        events.push(`image:${params.sourceUrl}`);
        return "image-client-id";
      }),
    };
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      bubbleDelayMs: 0,
      imageMediaSender,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 81,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "context-image-order",
                  item_list: [
                    {
                      type: MessageItemType.TEXT,
                      text_item: { text: "发给我看看" },
                    },
                  ],
                },
              ],
              get_updates_buf: "cursor-image-order",
            }),
          );
        }
        if (url.includes("getconfig")) {
          return new Response(
            JSON.stringify({ ret: 0, typing_ticket: "typing-ticket" }),
          );
        }
        if (url.includes("sendmessage") && init?.body) {
          const body = JSON.parse(String(init.body)) as {
            msg: {
              context_token: string;
              item_list: Array<{ text_item?: { text?: string } }>;
            };
          };
          const text = body.msg.item_list[0]?.text_item?.text;
          if (text) events.push(`text:${text}`);
          sentContexts.push(body.msg.context_token);
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();
    const finalizeDelivery = vi.fn(async () => undefined);

    await adapter.start(() => {
      adapter.stop();
      return {
        parts: [
          { type: "text", text: "先看这个。" },
          {
            type: "image",
            sourceUrl: "https://images.example.test/cat.png",
            fallbackText: "图片没发出去。",
          },
          { type: "text", text: "看完告诉我。" },
        ],
        finalizeDelivery,
      };
    });

    expect(events).toEqual([
      "text:先看这个。",
      "image:https://images.example.test/cat.png",
      "text:看完告诉我。",
    ]);
    expect(imageMediaSender.sendFromUrl).toHaveBeenCalledWith({
      sourceUrl: "https://images.example.test/cat.png",
      toUserId: "alice@im.wechat",
      contextToken: "context-image-order",
    });
    expect(sentContexts).toEqual([
      "context-image-order",
      "context-image-order",
    ]);
    expect(finalizeDelivery).toHaveBeenCalledOnce();
    expect(finalizeDelivery).toHaveBeenCalledWith([
      "先看这个。",
      "[发送了一张图片]",
      "看完告诉我。",
    ]);
  });

  it("uploads a generated image buffer and records only its memory label", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-generated-"));
    const generated = Buffer.from("generated-image-buffer");
    const imageMediaSender = {
      sendFromUrl: vi.fn(async () => "url-image-id"),
      sendBuffer: vi.fn(async () => "generated-image-id"),
    };
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      bubbleDelayMs: 0,
      imageMediaSender,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input).includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 84,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "generated-context",
                  item_list: [
                    {
                      type: MessageItemType.TEXT,
                      text_item: { text: "画一张图" },
                    },
                  ],
                },
              ],
              get_updates_buf: "generated-cursor",
            }),
          );
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();
    const finalizeDelivery = vi.fn(async () => undefined);

    await adapter.start(() => {
      adapter.stop();
      return {
        parts: [
          { type: "text", text: "画好了。" },
          {
            type: "generated_image",
            data: generated,
            mimeType: "image/png",
            memoryText: "[生成并发送了一张图片：白猫]",
          },
        ],
        finalizeDelivery,
      };
    });

    expect(imageMediaSender.sendBuffer).toHaveBeenCalledWith({
      data: generated,
      toUserId: "alice@im.wechat",
      contextToken: "generated-context",
    });
    expect(imageMediaSender.sendFromUrl).not.toHaveBeenCalled();
    expect(finalizeDelivery).toHaveBeenCalledWith([
      "画好了。",
      "[生成并发送了一张图片：白猫]",
    ]);
  });

  it("exposes generated-image delivery through the per-user outbound queue", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-proactive-image-"));
    const sendBuffer = vi.fn(async () => "proactive-image-id");
    const adapter = new WeixinAdapter({
      stateDir,
      imageMediaSender: {
        sendFromUrl: vi.fn(async () => "url-image-id"),
        sendBuffer,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    await adapter.initialize();
    const source = Buffer.from("trusted-generated-image");

    const result = adapter.sendGeneratedImage({
      toUserId: "alice@im.wechat",
      contextToken: "fresh-context",
      data: source,
    });
    source.fill(0);

    await expect(result).resolves.toBe("proactive-image-id");
    expect(sendBuffer).toHaveBeenCalledWith({
      toUserId: "alice@im.wechat",
      contextToken: "fresh-context",
      data: Buffer.from("trusted-generated-image"),
    });
  });

  it("replaces a failed image with fallback text and continues later bubbles", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const events: string[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const imageMediaSender = {
      sendFromUrl: vi.fn(async () => {
        events.push("image:attempt");
        throw new Error("private upload detail must not be exposed");
      }),
    };
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      bubbleDelayMs: 0,
      imageMediaSender,
      logger,
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 82,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "context-image-fallback",
                  item_list: [
                    {
                      type: MessageItemType.TEXT,
                      text_item: { text: "图片呢？" },
                    },
                  ],
                },
              ],
              get_updates_buf: "cursor-image-fallback",
            }),
          );
        }
        if (url.includes("getconfig")) {
          return new Response(
            JSON.stringify({ ret: 0, typing_ticket: "typing-ticket" }),
          );
        }
        if (url.includes("sendmessage") && init?.body) {
          const body = JSON.parse(String(init.body)) as {
            msg: {
              item_list: Array<{ text_item?: { text?: string } }>;
            };
          };
          const text = body.msg.item_list[0]?.text_item?.text;
          if (text) events.push(`text:${text}`);
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();
    const finalizeDelivery = vi.fn(async () => undefined);

    await adapter.start(() => {
      adapter.stop();
      return {
        parts: [
          { type: "text", text: "我试着发一下。" },
          {
            type: "image",
            sourceUrl: "https://images.example.test/missing.png",
            fallbackText: "这张图刚才没发出去。",
          },
          { type: "text", text: "后面这句话还是要发。" },
        ],
        finalizeDelivery,
      };
    });

    expect(events).toEqual([
      "text:我试着发一下。",
      "image:attempt",
      "text:这张图刚才没发出去。",
      "text:后面这句话还是要发。",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "图片发送失败，已回退为文字提示。",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "private upload detail",
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(finalizeDelivery).toHaveBeenCalledOnce();
    expect(finalizeDelivery).toHaveBeenCalledWith([
      "我试着发一下。",
      "这张图刚才没发出去。",
      "后面这句话还是要发。",
    ]);
  });

  it("does not let proactive text to the same user interleave with a text-image-text batch", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-adapter-"));
    const events: string[] = [];
    let markImageStarted!: () => void;
    let releaseImage!: () => void;
    const imageStarted = new Promise<void>((resolve) => {
      markImageStarted = resolve;
    });
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    const imageMediaSender = {
      sendFromUrl: vi.fn(async () => {
        events.push("image:start");
        markImageStarted();
        await imageGate;
        events.push("image:end");
        return "image-client-id";
      }),
    };
    const adapter = new WeixinAdapter({
      stateDir,
      messageDebounceMs: 0,
      bubbleDelayMs: 0,
      imageMediaSender,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await adapter.store.saveCredential({
      accountId: "bot@im.bot",
      token: "bot-token",
      baseUrl: "https://ilink.example.test",
      userId: "alice@im.wechat",
      savedAt: "2026-07-22T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              msgs: [
                {
                  message_id: 83,
                  message_type: MessageType.USER,
                  from_user_id: "alice@im.wechat",
                  context_token: "context-image-batch",
                  item_list: [
                    {
                      type: MessageItemType.TEXT,
                      text_item: { text: "按顺序发" },
                    },
                  ],
                },
              ],
              get_updates_buf: "cursor-image-batch",
            }),
          );
        }
        if (url.includes("getconfig")) {
          return new Response(
            JSON.stringify({ ret: 0, typing_ticket: "typing-ticket" }),
          );
        }
        if (url.includes("sendmessage") && init?.body) {
          const body = JSON.parse(String(init.body)) as {
            msg: {
              item_list: Array<{ text_item?: { text?: string } }>;
            };
          };
          const text = body.msg.item_list[0]?.text_item?.text;
          if (text) events.push(`text:${text}`);
        }
        return new Response(JSON.stringify({ ret: 0 }));
      }),
    );
    await adapter.initialize();

    const running = adapter.start(() => {
      adapter.stop();
      return [
        { type: "text", text: "批次第一条" },
        {
          type: "image",
          sourceUrl: "https://images.example.test/slow.png",
        },
        { type: "text", text: "批次最后一条" },
      ] as const;
    });
    await imageStarted;
    const proactive = adapter.sendText({
      toUserId: "alice@im.wechat",
      contextToken: "context-proactive",
      text: "主动消息",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const whileImagePending = [...events];

    releaseImage();
    await Promise.all([running, proactive]);

    expect(whileImagePending).toEqual([
      "text:批次第一条",
      "image:start",
    ]);
    expect(events).toEqual([
      "text:批次第一条",
      "image:start",
      "image:end",
      "text:批次最后一条",
      "text:主动消息",
    ]);
  });
});
