import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AutonomyStore } from "../src/autonomy-store.js";

describe("AutonomyStore", () => {
  it("persists interaction tokens and keeps autonomous memories isolated by agent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-autonomy-"));
    const store = new AutonomyStore(stateDir);
    await store.recordInteraction("alice@im.wechat", "context-secret");
    await store.setEnabled("alice@im.wechat", "agent-a", true);
    await store.appendEvent("alice@im.wechat", "agent-a", {
      id: "event-a",
      createdAt: "2026-07-22T02:00:00.000Z",
      summary: "读完了一本旧杂志。",
      mood: "放松",
      importance: 2,
      shouldContactUser: false,
      contactStatus: "not_requested",
    });

    const restored = new AutonomyStore(stateDir);
    const first = await restored.getSnapshot("alice@im.wechat", "agent-a");
    const second = await restored.getSnapshot("alice@im.wechat", "agent-b");
    expect(first.enabled).toBe(true);
    expect(first.lastContextToken).toBe("context-secret");
    expect(first.events).toHaveLength(1);
    expect(second.enabled).toBe(false);
    expect(second.events).toHaveLength(0);
  });
});
