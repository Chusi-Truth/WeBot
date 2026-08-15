import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentStore } from "../src/agent-store.js";
import {
  ReminderScheduler,
  type ReminderDeliveryContext,
} from "../src/reminder-scheduler.js";
import { ReminderStore } from "../src/reminder-store.js";

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("ReminderScheduler", () => {
  it("sends once as the creating Agent and records the exact outbound memory", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-due-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const original = await agents.getActiveAgent(userId);
    const creator = await agents.createAgent(userId, {
      name: "林夏",
      identity: "表达克制，表达简短。",
    });
    await agents.switchAgentById(userId, original.id);
    const now = new Date("2026-07-28T07:00:00.000Z");
    const reminder = await reminders.createDirect(
      userId,
      creator.id,
      {
        title: "交项目报告",
        dueAt: now.toISOString(),
      },
      "2026-07-28T06:00:00.000Z",
    );
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const selectTone = vi.fn().mockResolvedValue("cool_caring");
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: "2026-07-28T06:59:00.000Z",
      }),
      sendText,
      selectTone,
      now: () => now,
      logger: silentLogger(),
    });

    await scheduler.runDueTasks();
    await scheduler.runDueTasks();

    const expectedMessage =
      "提醒你：交项目报告\n约定时间：2026/07/28周二 15:00\n时间到了。你自己让我记着的，别又拖。";
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        toUserId: userId,
        contextToken: "fresh-context",
        text: expectedMessage,
      }),
    );
    expect(selectTone).toHaveBeenCalledOnce();
    expect(selectTone).toHaveBeenCalledWith({ userId, agent: creator });
    expect(
      (await reminders.list(userId, creator.id)).find(
        (candidate) => candidate.id === reminder.id,
      ),
    ).toMatchObject({
      status: "api_accepted",
      lastMessage: expectedMessage,
    });
    expect((await agents.getMemoryContext(userId, original.id)).messages).toEqual(
      [],
    );
    expect((await agents.getMemoryContext(userId, creator.id)).messages).toEqual(
      [
        expect.objectContaining({
          role: "assistant",
          conversationMode: "wechat",
          content: expectedMessage,
        }),
      ],
    );
  });

  it("waits for a fresh context, catches up within 24 hours, and expires after it", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-context-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-28T01:00:00.000Z");
    let context: ReminderDeliveryContext | null = null;
    const waiting = await reminders.createDirect(
      userId,
      agent.id,
      { title: "给医生回电话", dueAt: now.toISOString() },
      "2026-07-28T00:00:00.000Z",
    );
    const sendText = vi.fn(async (params: {
      finalizeDelivery?: () => Promise<void>;
    }) => {
      await params.finalizeDelivery?.();
      return { ret: 0 };
    });
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext: vi.fn(async () => context),
      sendText,
      now: () => now,
      logger: silentLogger(),
    });

    await scheduler.runDueTasks();
    expect(sendText).not.toHaveBeenCalled();
    expect(
      (await reminders.list(userId, agent.id)).find(
        (candidate) => candidate.id === waiting.id,
      ),
    ).toMatchObject({ status: "waiting_context" });

    now = new Date("2026-07-29T00:59:00.000Z");
    context = {
      contextToken: "new-context",
      recordedAt: "2026-07-29T00:58:00.000Z",
    };
    await scheduler.runDueTasks();
    expect(sendText).toHaveBeenCalledOnce();

    const expired = await reminders.createDirect(
      userId,
      agent.id,
      {
        title: "提交另一份材料",
        dueAt: "2026-07-28T00:00:00.000Z",
      },
      "2026-07-27T23:00:00.000Z",
    );
    now = new Date("2026-07-29T00:00:01.000Z");
    await scheduler.runDueTasks();

    expect(sendText).toHaveBeenCalledOnce();
    expect(
      (await reminders.list(userId, agent.id)).find(
        (candidate) => candidate.id === expired.id,
      ),
    ).toMatchObject({
      status: "expired",
      lastError: "已超过 24 小时补发窗口。",
    });
  });

  it("does not retry a claimed reminder when iLink rejects it", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-send-fail-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const now = new Date("2026-07-28T01:00:00.000Z");
    const reminder = await reminders.createDirect(
      userId,
      agent.id,
      { title: "交材料", dueAt: now.toISOString() },
      "2026-07-28T00:00:00.000Z",
    );
    const sendText = vi.fn().mockRejectedValue(new Error("iLink rejected"));
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: now.toISOString(),
      }),
      sendText,
      now: () => now,
      logger: silentLogger(),
    });

    await scheduler.runDueTasks();
    await scheduler.runDueTasks();

    expect(sendText).toHaveBeenCalledOnce();
    expect(
      (await reminders.list(userId, agent.id)).find(
        (candidate) => candidate.id === reminder.id,
      ),
    ).toMatchObject({
      status: "failed",
      lastError: "iLink rejected",
    });
    expect((await agents.getMemoryContext(userId, agent.id)).messages).toEqual(
      [],
    );
  });

  it("keeps overlapping scheduler scans single-flight", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-single-flight-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const now = new Date("2026-07-28T01:00:00.000Z");
    await reminders.createDirect(
      userId,
      agent.id,
      { title: "只发送一次", dueAt: now.toISOString() },
      "2026-07-28T00:00:00.000Z",
    );
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const getDeliveryContext = vi.fn(async () => {
      await contextGate;
      return {
        contextToken: "fresh-context",
        recordedAt: now.toISOString(),
      };
    });
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext,
      sendText,
      now: () => now,
      logger: silentLogger(),
    });

    const first = scheduler.runDueTasks();
    await Promise.resolve();
    await scheduler.runDueTasks();
    releaseContext();
    await first;

    expect(getDeliveryContext).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("keeps api_accepted when the later memory append fails", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-memory-fail-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const now = new Date("2026-07-28T01:00:00.000Z");
    const reminder = await reminders.createDirect(
      userId,
      agent.id,
      { title: "吃药", dueAt: now.toISOString() },
      "2026-07-28T00:00:00.000Z",
    );
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    vi.spyOn(agents, "deliverOutboundMessage").mockImplementation(
      async (_userId, _agentId, _content, send) => {
        await send(async () => undefined);
        throw new Error("memory disk full");
      },
    );
    const logger = silentLogger();
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: now.toISOString(),
      }),
      sendText,
      now: () => now,
      logger,
    });

    await scheduler.runDueTasks();
    await scheduler.runDueTasks();

    expect(sendText).toHaveBeenCalledOnce();
    expect(
      (await reminders.list(userId, agent.id)).find(
        (candidate) => candidate.id === reminder.id,
      ),
    ).toMatchObject({ status: "api_accepted" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("提醒已由平台接受"),
      expect.objectContaining({ message: "memory disk full" }),
    );
  });

  it("uses neutral fixed text when persona tone selection fails", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-tone-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const now = new Date("2026-07-28T01:00:00.000Z");
    await reminders.createDirect(
      userId,
      agent.id,
      { title: "拿快递", dueAt: now.toISOString() },
      "2026-07-28T00:00:00.000Z",
    );
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: now.toISOString(),
      }),
      sendText,
      selectTone: vi.fn().mockRejectedValue(new Error("provider timeout")),
      now: () => now,
      logger: silentLogger(),
    });

    await scheduler.runDueTasks();

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(
          /^提醒你：拿快递\n约定时间：.+\n时间到了，记得处理。$/u,
        ),
      }),
    );
  });

  it("requires exact natural confirmation and supports list/add/cancel commands", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-command-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const now = new Date("2026-07-28T01:00:00.000Z");
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext: vi.fn().mockResolvedValue(null),
      sendText: vi.fn(),
      now: () => now,
      logger: silentLogger(),
    });
    const proposal = await reminders.propose(
      userId,
      agent.id,
      {
        title: "下午开会",
        dueAt: "2026-07-28T07:00:00.000Z",
      },
      now.toISOString(),
    );

    expect(
      await scheduler.handleNaturalAction(
        userId,
        agent.id,
        `好的，确认提醒 ${proposal.id}`,
      ),
    ).toBeNull();
    expect(await reminders.getProposal(userId, agent.id, proposal.id)).not.toBeNull();

    expect(
      await scheduler.handleNaturalAction(
        userId,
        agent.id,
        `确认提醒 ${proposal.id}`,
      ),
    ).toContain(`已设置提醒 ${proposal.id}`);
    expect(await reminders.getProposal(userId, agent.id, proposal.id)).toBeNull();

    const added = await scheduler.handleCommand(
      userId,
      agent.id,
      "/reminder add 2026-07-30 15:00 交报告",
    );
    expect(added).toMatch(/^已设置提醒 [A-Za-z0-9_-]+：/u);

    const listed = await scheduler.handleCommand(
      userId,
      agent.id,
      "/reminder list",
    );
    expect(listed).toContain("下午开会");
    expect(listed).toContain("交报告");

    expect(
      await scheduler.handleNaturalAction(
        userId,
        agent.id,
        `取消提醒 ${proposal.id}`,
      ),
    ).toBe(`已取消提醒 ${proposal.id}。`);
    expect(
      await scheduler.handleNaturalAction(
        userId,
        agent.id,
        `确认提醒 ${proposal.id}`,
      ),
    ).toContain("没有找到可确认");
    expect(
      await scheduler.handleCommand(
        userId,
        agent.id,
        `/reminder confirm ${proposal.id} 多余文字`,
      ),
    ).toBe("用法：/reminder confirm <短ID>");
    expect(
      await scheduler.handleCommand(userId, agent.id, "/reminder help"),
    ).toContain("不能替代系统闹钟");
  });

  it("does not mutate or deliver jobs in an admin-only process", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-admin-only-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const now = new Date("2026-07-28T01:00:00.000Z");
    const reminder = await reminders.createDirect(
      userId,
      agent.id,
      { title: "不会由后台发送", dueAt: now.toISOString() },
      "2026-07-28T00:00:00.000Z",
    );
    const sendText = vi.fn();
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: now.toISOString(),
      }),
      sendText,
      now: () => now,
      deliveryEnabled: false,
      logger: silentLogger(),
    });

    scheduler.start();
    await scheduler.runDueTasks();
    scheduler.stop();

    expect(sendText).not.toHaveBeenCalled();
    expect(
      (await reminders.list(userId, agent.id)).find(
        (candidate) => candidate.id === reminder.id,
      ),
    ).toMatchObject({ status: "scheduled" });
    expect(
      await scheduler.handleCommand(userId, agent.id, "/reminder help"),
    ).toContain("仅提供管理功能");
  });

  it("cancels the delayed startup scan when stopped", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-stop-startup-"),
    );
    const agents = new AgentStore({ stateDir });
    const getDeliveryContext = vi.fn().mockResolvedValue(null);
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext,
      sendText: vi.fn(),
      logger: silentLogger(),
    });

    vi.useFakeTimers();
    try {
      scheduler.start();
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(getDeliveryContext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send or recreate reminder state when its Agent is deleted", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-delete-race-"),
    );
    const reminders = new ReminderStore(stateDir);
    const agents = new AgentStore({
      stateDir,
      onDeleteAgent: (userId, agentId) =>
        reminders.deleteAgent(userId, agentId),
    });
    const userId = "alice@im.wechat";
    const original = await agents.getActiveAgent(userId);
    const removable = await agents.createAgent(userId, {
      name: "待删除人物",
      identity: "用于提醒并发删除测试。",
    });
    await agents.switchAgentById(userId, original.id);
    const now = new Date("2026-07-28T01:00:00.000Z");
    await reminders.createDirect(
      userId,
      removable.id,
      { title: "不应发送", dueAt: now.toISOString() },
      "2026-07-28T00:00:00.000Z",
    );
    let releaseTone!: () => void;
    let markToneStarted!: () => void;
    const toneGate = new Promise<void>((resolve) => {
      releaseTone = resolve;
    });
    const toneStarted = new Promise<void>((resolve) => {
      markToneStarted = resolve;
    });
    const sendText = vi.fn();
    const scheduler = new ReminderScheduler({
      stateDir,
      agents,
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: now.toISOString(),
      }),
      sendText,
      selectTone: vi.fn(async () => {
        markToneStarted();
        await toneGate;
        return "gentle";
      }),
      now: () => now,
      logger: silentLogger(),
    });

    const pending = scheduler.runDueTasks();
    await toneStarted;
    await agents.deleteAgentById(userId, removable.id);
    releaseTone();
    await pending;

    expect(sendText).not.toHaveBeenCalled();
    expect(await reminders.list(userId, removable.id)).toEqual([]);
    expect(
      (await agents.getRegistry(userId)).agents.some(
        (candidate) => candidate.id === removable.id,
      ),
    ).toBe(false);
  });
});
