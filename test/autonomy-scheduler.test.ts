import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentStore } from "../src/agent-store.js";
import { AutonomyScheduler } from "../src/autonomy-scheduler.js";

describe("AutonomyScheduler", () => {
  it("generates an off-screen memory after idle time and attempts one justified contact", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-scheduler-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-22T02:00:00.000Z"); // 10:00 Shanghai
    const generator = vi.fn().mockResolvedValue({
      summary: "整理旧地图时发现了双方一直在找的编号。",
      mood: "有些惊喜",
      importance: 5 as const,
      shouldContactUser: true,
      contactReason: "发现了共同目标的重要线索",
      message: "我找到那张地图背面的编号了，你有空时我发给你看。",
    });
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator,
      sendText,
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });

    await scheduler.recordInteraction(userId, "context-token");
    await scheduler.handleCommand(userId, "/life on");
    now = new Date("2026-07-22T09:00:00.000Z"); // 17:00 Shanghai
    await scheduler.runDueTasks();

    expect(generator).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith({
      toUserId: userId,
      contextToken: "context-token",
      text: "我找到那张地图背面的编号了，你有空时我发给你看。",
    });
    const events = await scheduler.getRecentEvents(userId, agent.id);
    expect(events).toEqual([
      expect.objectContaining({
        summary: expect.stringContaining("地图"),
        contactStatus: "attempted",
      }),
    ]);
  });

  it("sends an eligible autonomous image only after its proactive text succeeds", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-scheduler-image-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    let agent = await agents.getActiveAgent(userId);
    agent = await agents.updateImageBehaviorByAgentId(
      userId,
      agent.id,
      {
        mode: "natural",
        cooldownMinutes: 90,
        allowAutonomous: true,
        visualIdentityPrompt: "黑色短发，深棕色眼睛",
      },
      agent.updatedAt,
    );
    let now = new Date("2026-07-22T02:00:00.000Z");
    const order: string[] = [];
    const sendText = vi.fn(async () => {
      order.push("text");
    });
    const sendAutonomousImage = vi.fn(async () => {
      order.push("image");
    });
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator: vi.fn().mockResolvedValue({
        summary: "在旧书店找到了双方一直讨论的绝版地图。",
        mood: "惊喜",
        importance: 5,
        shouldContactUser: true,
        contactReason: "共同目标有了重要进展",
        message: "那张一直找不到的地图我碰见了，给你看一下。",
        imagePrompt: "旧书店木桌上摊开的绝版城市地图，真实手机随拍",
        imageIncludesAgent: false,
      }),
      sendText,
      sendAutonomousImage,
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });

    await scheduler.recordInteraction(userId, "fresh-context-token");
    await scheduler.setAdminEnabled(userId, agent.id, true);
    now = new Date("2026-07-22T09:00:00.000Z");
    await scheduler.runDueTasks();

    expect(order).toEqual(["text", "image"]);
    expect(sendAutonomousImage).toHaveBeenCalledWith({
      userId,
      agent: expect.objectContaining({
        id: agent.id,
        imageBehavior: expect.objectContaining({
          mode: "natural",
          allowAutonomous: true,
        }),
      }),
      contextToken: "fresh-context-token",
      prompt: "旧书店木桌上摊开的绝版城市地图，真实手机随拍",
      includesAgent: false,
    });
    expect(await scheduler.getRecentEvents(userId, agent.id)).toEqual([
      expect.objectContaining({
        contactStatus: "attempted",
        imageStatus: "delivered",
        imagePrompt: "旧书店木桌上摊开的绝版城市地图，真实手机随拍",
        imageAttemptedAt: "2026-07-22T09:00:00.000Z",
      }),
    ]);
  });

  it("keeps successful proactive text successful when its image delivery fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-scheduler-image-fail-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    let agent = await agents.getActiveAgent(userId);
    agent = await agents.updateImageBehaviorByAgentId(
      userId,
      agent.id,
      { mode: "natural", allowAutonomous: true },
      agent.updatedAt,
    );
    let now = new Date("2026-07-22T02:00:00.000Z");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator: vi.fn().mockResolvedValue({
        summary: "发现了约定要找的重要资料。",
        mood: "惊喜",
        importance: 5,
        shouldContactUser: true,
        message: "资料找到了，我拍给你看看。",
        imagePrompt: "桌面上的重要资料，真实手机随拍",
        imageIncludesAgent: false,
      }),
      sendText: vi.fn().mockResolvedValue(undefined),
      sendAutonomousImage: vi
        .fn()
        .mockRejectedValue(new Error("private upload detail")),
      logger,
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });
    await scheduler.recordInteraction(userId, "fresh-context-token");
    await scheduler.setAdminEnabled(userId, agent.id, true);
    now = new Date("2026-07-22T09:00:00.000Z");

    await scheduler.runDueTasks();

    expect(await scheduler.getRecentEvents(userId, agent.id)).toEqual([
      expect.objectContaining({
        contactStatus: "attempted",
        imageStatus: "failed",
        imageError: "private upload detail",
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      `Agent 主动联系配图失败（${userId}）：`,
      expect.any(Error),
    );
  });

  it("never attempts an autonomous image when proactive text delivery fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-scheduler-text-fail-image-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    let agent = await agents.getActiveAgent(userId);
    agent = await agents.updateImageBehaviorByAgentId(
      userId,
      agent.id,
      { mode: "natural", allowAutonomous: true },
      agent.updatedAt,
    );
    let now = new Date("2026-07-22T02:00:00.000Z");
    const sendAutonomousImage = vi.fn();
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator: vi.fn().mockResolvedValue({
        summary: "找到了一份重要资料。",
        mood: "惊喜",
        importance: 5,
        shouldContactUser: true,
        message: "资料找到了，给你看看。",
        imagePrompt: "桌面上的重要资料",
        imageIncludesAgent: false,
      }),
      sendText: vi.fn().mockRejectedValue(new Error("text delivery failed")),
      sendAutonomousImage,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });
    await scheduler.recordInteraction(userId, "fresh-context-token");
    await scheduler.setAdminEnabled(userId, agent.id, true);
    now = new Date("2026-07-22T09:00:00.000Z");

    await scheduler.runDueTasks();

    expect(sendAutonomousImage).not.toHaveBeenCalled();
    expect(await scheduler.getRecentEvents(userId, agent.id)).toEqual([
      expect.objectContaining({
        contactStatus: "failed",
        imageStatus: "skipped",
      }),
    ]);
  });

  it("ignores autonomous image suggestions that are not important contacts", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-scheduler-image-routine-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    let agent = await agents.getActiveAgent(userId);
    agent = await agents.updateImageBehaviorByAgentId(
      userId,
      agent.id,
      { mode: "natural", allowAutonomous: true },
      agent.updatedAt,
    );
    let now = new Date("2026-07-22T02:00:00.000Z");
    const sendAutonomousImage = vi.fn();
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator: vi.fn().mockResolvedValue({
        summary: "收拾了桌面。",
        mood: "平静",
        importance: 2,
        shouldContactUser: true,
        message: "桌面收拾好了。",
        imagePrompt: "整洁的桌面",
        imageIncludesAgent: false,
      }),
      sendText: vi.fn(),
      sendAutonomousImage,
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });
    await scheduler.recordInteraction(userId, "fresh-context-token");
    await scheduler.setAdminEnabled(userId, agent.id, true);
    now = new Date("2026-07-22T09:00:00.000Z");

    await scheduler.runDueTasks();

    expect(sendAutonomousImage).not.toHaveBeenCalled();
    expect(await scheduler.getRecentEvents(userId, agent.id)).toEqual([
      expect.objectContaining({
        contactStatus: "not_requested",
        imageStatus: "not_requested",
      }),
    ]);
  });

  it("keeps important memories but does not contact during quiet hours", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-quiet-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-21T14:00:00.000Z"); // 22:00 Shanghai
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator: vi.fn().mockResolvedValue({
        summary: "发现了一条重要线索。",
        mood: "专注",
        importance: 5,
        shouldContactUser: true,
        message: "有件事想告诉你。",
      }),
      sendText,
      now: () => now,
      idleHours: 1,
      generationIntervalHours: 1,
      quietStartHour: 22,
      quietEndHour: 9,
    });
    await scheduler.recordInteraction(userId, "context-token");
    await scheduler.handleCommand(userId, "/life on");
    now = new Date("2026-07-21T15:30:00.000Z"); // 23:30 Shanghai
    await scheduler.runDueTasks();

    expect(sendText).not.toHaveBeenCalled();
    expect(await scheduler.getRecentEvents(userId, agent.id)).toEqual([
      expect.objectContaining({ contactStatus: "pending" }),
    ]);

    now = new Date("2026-07-22T01:05:00.000Z"); // 09:05 Shanghai
    await scheduler.runDueTasks();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await scheduler.getRecentEvents(userId, agent.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contactStatus: "attempted" }),
      ]),
    );
  });

  it("exposes sanitized admin snapshots with newest events first", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-admin-life-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-22T02:00:00.000Z");
    const generator = vi
      .fn()
      .mockResolvedValueOnce({
        summary: "第一段经历。",
        mood: "平静",
        importance: 2,
        shouldContactUser: false,
      })
      .mockResolvedValueOnce({
        summary: "第二段经历。",
        mood: "愉快",
        eventKind: "decision",
        conversationValue: 4,
        conversationHook: "是否继续采用刚试过的新方法",
        openThread: "还需要再验证一次效果",
        importance: 3,
        shouldContactUser: false,
      });
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator,
      sendText: vi.fn(),
      now: () => now,
    });

    await scheduler.recordInteraction(userId, "context-secret");
    const enabled = await scheduler.setAdminEnabled(userId, agent.id, true);
    expect(enabled).toMatchObject({
      enabled: true,
      contactAvailable: true,
      eventCount: 0,
      events: [],
    });
    await scheduler.generateAdminEvent(userId, agent.id);
    now = new Date("2026-07-22T03:00:00.000Z");
    await scheduler.generateAdminEvent(userId, agent.id);

    const snapshot = await scheduler.getAdminSnapshot(userId, agent.id, 1);
    expect(snapshot).toMatchObject({
      enabled: true,
      lastGeneratedAt: "2026-07-22T03:00:00.000Z",
      lastInteractionAt: "2026-07-22T02:00:00.000Z",
      contactAvailable: true,
      eventCount: 2,
      events: [
        expect.objectContaining({
          summary: "第二段经历。",
          eventKind: "decision",
          conversationValue: 4,
          conversationHook: "是否继续采用刚试过的新方法",
          openThread: "还需要再验证一次效果",
          contactStatus: "not_requested",
        }),
      ],
    });
    expect(snapshot).not.toHaveProperty("lastContextToken");
    expect(snapshot.events[0]).not.toHaveProperty("contactError");
    expect(JSON.stringify(snapshot)).not.toContain("context-secret");

    await expect(
      scheduler.getAdminSnapshot(userId, "not-this-users-agent"),
    ).rejects.toThrow("没有找到指定 Agent");
    await expect(
      scheduler.setAdminEnabled(userId, "not-this-users-agent", false),
    ).rejects.toThrow("没有找到指定 Agent");
    await expect(
      scheduler.generateAdminEvent(userId, "not-this-users-agent"),
    ).rejects.toThrow("没有找到指定 Agent");
  });

  it("does not persist low-value diary entries or retry them every tick", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-life-skip-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-22T02:00:00.000Z");
    const generator = vi.fn().mockResolvedValue({
      outcome: "none",
      reason: "只有起床和收拾房间，没有形成值得讨论的新变化。",
    });
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator,
      sendText: vi.fn(),
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });

    await scheduler.recordInteraction(userId, "context-token");
    await scheduler.setAdminEnabled(userId, agent.id, true);
    now = new Date("2026-07-22T09:00:00.000Z");
    await scheduler.runDueTasks();
    now = new Date("2026-07-22T09:05:00.000Z");
    await scheduler.runDueTasks();

    expect(generator).toHaveBeenCalledOnce();
    expect(generator).toHaveBeenCalledWith(
      expect.objectContaining({ allowNoEvent: true }),
    );
    expect(await scheduler.getRecentEvents(userId, agent.id)).toEqual([]);
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastEvaluatedAt: "2026-07-22T09:00:00.000Z",
      eventCount: 0,
    });

    now = new Date("2026-07-22T15:01:00.000Z");
    await scheduler.runDueTasks();
    expect(generator).toHaveBeenCalledTimes(2);
  });

  it("backs off scheduled model failures instead of retrying every tick", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-life-backoff-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-22T02:00:00.000Z");
    const generator = vi.fn().mockRejectedValue(new Error("invalid JSON"));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator,
      sendText: vi.fn(),
      logger,
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });

    await scheduler.recordInteraction(userId, "context-token");
    await scheduler.setAdminEnabled(userId, agent.id, true);
    now = new Date("2026-07-22T09:00:00.000Z");
    await scheduler.runDueTasks();
    now = new Date("2026-07-22T09:05:00.000Z");
    await scheduler.runDueTasks();
    expect(generator).toHaveBeenCalledOnce();

    now = new Date("2026-07-22T09:31:00.000Z");
    await scheduler.runDueTasks();
    expect(generator).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("reports a manual no-event result as such instead of a busy task", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-life-manual-none-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator: vi.fn().mockResolvedValue({
        outcome: "none",
        reason: "没有形成具体变化。",
      }),
      sendText: vi.fn(),
    });

    await expect(
      scheduler.generateAdminEvent(userId, agent.id),
    ).rejects.toThrow("没有形成值得记录的新经历：没有形成具体变化");
  });

  it("never queues a manual admin event for later contact", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-manual-life-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const now = new Date("2026-07-22T02:00:00.000Z");
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator: vi.fn().mockResolvedValue({
        summary: "手动生成的重要经历。",
        mood: "急切",
        importance: 5,
        shouldContactUser: true,
        contactReason: "有重要消息",
        message: "我有件重要的事想告诉你。",
      }),
      sendText,
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });

    await scheduler.recordInteraction(userId, "context-token");
    await scheduler.setAdminEnabled(userId, agent.id, true);
    const event = await scheduler.generateAdminEvent(userId, agent.id);
    expect(event).toMatchObject({
      shouldContactUser: true,
      contactStatus: "not_requested",
    });

    await scheduler.runDueTasks();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not contact after autonomy is disabled during generation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-disable-life-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-22T02:00:00.000Z");
    let releaseGeneration!: () => void;
    let markGenerationStarted!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      markGenerationStarted = resolve;
    });
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new AutonomyScheduler({
      stateDir,
      agents,
      generator: vi.fn(async () => {
        markGenerationStarted();
        await generationGate;
        return {
          summary: "生成期间关闭自主生活。",
          mood: "专注",
          importance: 5 as const,
          shouldContactUser: true,
          message: "这条消息不应发送。",
        };
      }),
      sendText,
      now: () => now,
      idleHours: 6,
      generationIntervalHours: 6,
    });

    await scheduler.recordInteraction(userId, "context-token");
    await scheduler.setAdminEnabled(userId, agent.id, true);
    now = new Date("2026-07-22T09:00:00.000Z");
    const dueTask = scheduler.runDueTasks();
    await generationStarted;
    await scheduler.setAdminEnabled(userId, agent.id, false);
    releaseGeneration();
    await dueTask;

    expect(sendText).not.toHaveBeenCalled();
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      enabled: false,
      eventCount: 1,
      events: [
        expect.objectContaining({ contactStatus: "not_requested" }),
      ],
    });
  });
});
