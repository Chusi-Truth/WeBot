import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IncomingMessageBuffer } from "../src/message-buffer.js";
import type { IncomingTextMessage } from "../src/types.js";

function message(
  senderId: string,
  text: string,
  sequence: number,
): IncomingTextMessage {
  return {
    senderId,
    text,
    messageId: sequence,
    sessionId: `session-${sequence}`,
    contextToken: `context-${sequence}`,
    createdAt: sequence * 1_000,
    raw: {
      message_id: sequence,
      from_user_id: senderId,
      context_token: `context-${sequence}`,
      client_id: `raw-${sequence}`,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IncomingMessageBuffer", () => {
  it("aggregates messages in order and resets its sliding debounce", async () => {
    const handled: IncomingTextMessage[] = [];
    const buffer = new IncomingMessageBuffer((incoming) => {
      handled.push(incoming);
    });

    const first = buffer.enqueue(message("alice", "我今天", 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const second = buffer.enqueue(message("alice", "有点累", 2));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handled).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);
    expect(handled.map(({ text }) => text)).toEqual(["我今天\n有点累"]);
  });

  it("flushes at the maximum window even when messages keep arriving", async () => {
    const handled: IncomingTextMessage[] = [];
    const buffer = new IncomingMessageBuffer(
      (incoming) => {
        handled.push(incoming);
      },
      { debounceMs: 1_500, maxWindowMs: 3_000 },
    );

    const promises = [buffer.enqueue(message("alice", "一", 1))];
    await vi.advanceTimersByTimeAsync(1_000);
    promises.push(buffer.enqueue(message("alice", "二", 2)));
    await vi.advanceTimersByTimeAsync(1_000);
    promises.push(buffer.enqueue(message("alice", "三", 3)));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(promises);

    expect(handled.map(({ text }) => text)).toEqual(["一\n二\n三"]);
  });

  it("flushes a regular batch before processing slash commands individually", async () => {
    const handled: string[] = [];
    const buffer = new IncomingMessageBuffer(
      async ({ text }) => {
        handled.push(text);
      },
      { debounceMs: 1_500 },
    );

    const regular = buffer.enqueue(message("alice", "先说一句", 1));
    const command = buffer.enqueue(message("alice", "  /help  ", 2));
    await Promise.all([regular, command]);

    expect(handled).toEqual(["先说一句", "  /help  "]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the latest message metadata for an aggregated batch", async () => {
    const handled: IncomingTextMessage[] = [];
    const buffer = new IncomingMessageBuffer((incoming) => {
      handled.push(incoming);
    });
    const first = buffer.enqueue(message("alice", "前半句", 11));
    const second = buffer.enqueue(message("alice", "后半句", 12));

    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.all([first, second]);

    expect(handled[0]).toMatchObject({
      text: "前半句\n后半句",
      messageId: 12,
      sessionId: "session-12",
      contextToken: "context-12",
      createdAt: 12_000,
      raw: {
        message_id: 12,
        context_token: "context-12",
        client_id: "raw-12",
      },
    });
  });

  it("preserves image observations from every message in a combined burst", async () => {
    const handled: IncomingTextMessage[] = [];
    const buffer = new IncomingMessageBuffer((incoming) => {
      handled.push(incoming);
    });
    const firstMessage = message("alice", "先看这张", 21);
    firstMessage.imageObservations = [
      { description: "一只白猫", mimeType: "image/png" },
    ];
    const secondMessage = message("alice", "还有这张", 22);
    secondMessage.imageObservations = [
      { description: "一片海边日落", mimeType: "image/jpeg" },
    ];

    const first = buffer.enqueue(firstMessage);
    const second = buffer.enqueue(secondMessage);
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.all([first, second]);

    expect(handled[0]?.imageObservations).toEqual([
      { description: "一只白猫", mimeType: "image/png" },
      { description: "一片海边日落", mimeType: "image/jpeg" },
    ]);
  });

  it("serializes one sender while allowing different senders to run independently", async () => {
    const events: string[] = [];
    let releaseAlice!: () => void;
    const aliceGate = new Promise<void>((resolve) => {
      releaseAlice = resolve;
    });
    const buffer = new IncomingMessageBuffer(
      async ({ senderId, text }) => {
        events.push(`start:${senderId}:${text}`);
        if (senderId === "alice" && text === "/one") await aliceGate;
        events.push(`end:${senderId}:${text}`);
      },
      { debounceMs: 10 },
    );

    const aliceOne = buffer.enqueue(message("alice", "/one", 1));
    const aliceTwo = buffer.enqueue(message("alice", "/two", 2));
    const bob = buffer.enqueue(message("bob", "/status", 3));
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([
      "start:alice:/one",
      "start:bob:/status",
      "end:bob:/status",
    ]);
    releaseAlice();
    await Promise.all([aliceOne, aliceTwo, bob]);
    expect(events).toEqual([
      "start:alice:/one",
      "start:bob:/status",
      "end:bob:/status",
      "end:alice:/one",
      "start:alice:/two",
      "end:alice:/two",
    ]);
  });

  it("drain flushes pending batches and invalid timings fall back safely", async () => {
    const handled: string[] = [];
    const buffer = new IncomingMessageBuffer(
      ({ text }) => {
        handled.push(text);
      },
      { debounceMs: Number.NaN, maxWindowMs: -1 },
    );
    const pending = buffer.enqueue(message("alice", "不用等默认时间", 1));

    await buffer.drain();
    await pending;
    expect(handled).toEqual(["不用等默认时间"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("processes immediately when debounce is disabled", async () => {
    const handled: string[] = [];
    const buffer = new IncomingMessageBuffer(
      ({ text }) => {
        handled.push(text);
      },
      { debounceMs: 0 },
    );

    await buffer.enqueue(message("alice", "立即处理", 1));
    expect(handled).toEqual(["立即处理"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
