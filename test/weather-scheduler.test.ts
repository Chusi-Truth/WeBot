import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentStore } from "../src/agent-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { WeatherScheduleStore } from "../src/weather-schedule-store.js";
import {
  WeatherScheduler,
  type WeatherDeliveryContext,
} from "../src/weather-scheduler.js";

const geocodingBody = {
  results: [
    {
      name: "上海",
      latitude: 31.22222,
      longitude: 121.45806,
    },
  ],
};

const forecastBody = {
  daily: {
    time: ["2026-07-27", "2026-07-28"],
    weather_code: [2, 95],
    temperature_2m_max: [34.2, 32],
    temperature_2m_min: [27.1, 26],
    precipitation_probability_max: [18, 76],
    wind_speed_10m_max: [16.4, 28],
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function weatherFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "geocoding-api.open-meteo.com") {
      return jsonResponse(geocodingBody);
    }
    if (url.hostname === "api.open-meteo.com") {
      return jsonResponse(forecastBody);
    }
    throw new Error(`unexpected host: ${url.hostname}`);
  });
}

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("WeatherScheduler", () => {
  it("runs at the configured local time, sends once, and appends outbound memory", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-weather-due-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const voiceSample = "别急，我看着呢。";
    await agents.appendOutboundMessage(
      userId,
      agent.id,
      "上海昨天晴，20～30℃，最高降水概率10%，最大风速12km/h。旧天气消息。",
      "wechat",
    );
    await agents.appendTurn(userId, agent.id, {
      input: "你会记得提醒我吗？",
      reply: voiceSample,
      conversationMode: "wechat",
    });
    let now = new Date("2026-07-27T00:59:00.000Z"); // 08:59 in Shanghai
    const fetchImpl = weatherFetch();
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const personalizedComment = "热归热，伞也带上。别说我没提醒你。";
    const generateComment = vi.fn().mockResolvedValue(personalizedComment);
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl }),
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: "2026-07-27T00:30:00.000Z",
      }),
      sendText,
      generateComment,
      now: () => now,
      logger: silentLogger(),
    });
    await scheduler.updateAdminConfig(userId, agent.id, {
      enabled: true,
      location: "上海",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    });

    await scheduler.runDueTasks();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();

    now = new Date("2026-07-27T01:00:00.000Z"); // 09:00 in Shanghai
    await scheduler.runDueTasks();
    await scheduler.runDueTasks();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        toUserId: userId,
        contextToken: "fresh-context",
        text: `上海今天局部多云，27.1～34.2℃，最高降水概率18%，最大风速16.4km/h。\n${personalizedComment}`,
      }),
    );
    expect(generateComment).toHaveBeenCalledOnce();
    expect(generateComment).toHaveBeenCalledWith({
      userId,
      agent,
      weather: {
        location: "上海",
        forecastDay: "today",
        date: "2026-07-27",
        conditionZh: "局部多云",
        temperatureMinC: 27.1,
        temperatureMaxC: 34.2,
        precipitationProbabilityMaxPercent: 18,
        windSpeedMaxKmh: 16.4,
      },
      voiceSamples: [voiceSample],
    });
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastLocalDate: "2026-07-27",
      lastStatus: "api_accepted",
    });
    expect(
      (await agents.getMemoryContext(userId, agent.id)).messages.at(-1),
    ).toEqual(
      expect.objectContaining({
        role: "assistant",
        conversationMode: "wechat",
        content:
          `上海今天局部多云，27.1～34.2℃，最高降水概率18%，最大风速16.4km/h。\n${personalizedComment}`,
      }),
    );
  });

  it("does not query or send without a fresh context, then catches up the same day", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-weather-context-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-27T00:50:00.000Z"); // 08:50 in Shanghai
    let context: WeatherDeliveryContext | null = null;
    const fetchImpl = weatherFetch();
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl }),
      getDeliveryContext: vi.fn(async () => context),
      sendText,
      now: () => now,
      contextMaxAgeHours: 24,
      logger: silentLogger(),
    });
    await scheduler.updateAdminConfig(userId, agent.id, {
      enabled: true,
      location: "上海",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    });
    now = new Date("2026-07-27T01:10:00.000Z"); // 09:10 in Shanghai

    await scheduler.runDueTasks();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastLocalDate: "2026-07-27",
      lastStatus: "waiting_context",
      deliveryState: "stale",
    });

    context = {
      contextToken: "expired-context",
      recordedAt: "2026-07-25T01:10:00.000Z",
    };
    await scheduler.runDueTasks();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();

    context = {
      contextToken: "new-context",
      recordedAt: "2026-07-27T01:09:00.000Z",
    };
    await scheduler.runDueTasks();
    await scheduler.runDueTasks();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ contextToken: "new-context" }),
    );
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastLocalDate: "2026-07-27",
      lastStatus: "api_accepted",
      deliveryState: "fresh",
    });
  });

  it("catches up across midnight using the previous local date", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-weather-midnight-"),
    );
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    let now = new Date("2026-07-27T14:00:00.000Z"); // 22:00 on Jul 27 in Shanghai
    const fetchImpl = weatherFetch();
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl }),
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: "2026-07-27T16:20:00.000Z",
      }),
      sendText,
      now: () => now,
      catchUpMinutes: 120,
      logger: silentLogger(),
    });
    await scheduler.updateAdminConfig(userId, agent.id, {
      enabled: true,
      location: "上海",
      localTime: "23:00",
      timeZone: "Asia/Shanghai",
    });
    now = new Date("2026-07-27T16:30:00.000Z"); // 00:30 on Jul 28 in Shanghai

    await scheduler.runDueTasks();
    await scheduler.runDueTasks();

    expect(sendText).toHaveBeenCalledOnce();
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastLocalDate: "2026-07-27",
      lastStatus: "api_accepted",
    });
  });

  it("does not backfill yesterday when a cross-midnight schedule was just enabled", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-weather-new-midnight-"),
    );
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const now = new Date("2026-07-27T16:30:00.000Z"); // 00:30 on Jul 28 in Shanghai
    const fetchImpl = weatherFetch();
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl }),
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: "2026-07-27T16:20:00.000Z",
      }),
      sendText,
      now: () => now,
      catchUpMinutes: 120,
      logger: silentLogger(),
    });

    await scheduler.updateAdminConfig(userId, agent.id, {
      enabled: true,
      location: "上海",
      localTime: "23:00",
      timeZone: "Asia/Shanghai",
    });
    await scheduler.runDueTasks();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastStatus: "never",
    });
  });

  it("does not send or recreate private state when an Agent is deleted during lookup", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-weather-delete-race-"),
    );
    const weatherSchedules = new WeatherScheduleStore(stateDir);
    const agents = new AgentStore({
      stateDir,
      onDeleteAgent: (userId, agentId) =>
        weatherSchedules.deleteAgent(userId, agentId),
    });
    const userId = "alice@im.wechat";
    const original = await agents.getActiveAgent(userId);
    const removable = await agents.createAgent(userId, {
      name: "待删除人物",
      identity: "用于天气并发删除测试。",
    });
    await agents.switchAgentById(userId, original.id);
    let now = new Date("2026-07-27T00:59:00.000Z");
    let releaseLookup!: () => void;
    let markLookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "geocoding-api.open-meteo.com") {
        markLookupStarted();
        await lookupGate;
        return jsonResponse(geocodingBody);
      }
      if (url.hostname === "api.open-meteo.com") {
        return jsonResponse(forecastBody);
      }
      throw new Error(`unexpected host: ${url.hostname}`);
    });
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl }),
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: "2026-07-27T00:50:00.000Z",
      }),
      sendText,
      now: () => now,
      logger: silentLogger(),
    });
    await scheduler.updateAdminConfig(userId, removable.id, {
      enabled: true,
      location: "上海",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    });
    now = new Date("2026-07-27T01:00:00.000Z");

    const pending = scheduler.runDueTasks();
    await lookupStarted;
    await agents.deleteAgentById(userId, removable.id);
    releaseLookup();
    await pending;

    expect(sendText).not.toHaveBeenCalled();
    expect(
      (await agents.getRegistry(userId)).agents.some(
        (candidate) => candidate.id === removable.id,
      ),
    ).toBe(false);
    expect(await weatherSchedules.getSnapshot(userId, removable.id)).toEqual({
      enabled: false,
      location: "",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
      lastStatus: "never",
    });
  });

  it("previews weather without sending or writing conversation memory", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-weather-preview-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const voiceSample = "行了，我知道。";
    await agents.appendTurn(userId, agent.id, {
      input: "你说话能不能自然一点？",
      reply: voiceSample,
      conversationMode: "wechat",
    });
    const memoryBeforePreview = await agents.getMemoryContext(userId, agent.id);
    const fetchImpl = weatherFetch();
    const sendText = vi.fn();
    const generateComment = vi
      .fn()
      .mockResolvedValueOnce("太阳挺认真，你也别忘了带伞。")
      .mockResolvedValueOnce("今天有点热，出门前自己看着办。 ");
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl }),
      getDeliveryContext: vi.fn().mockResolvedValue(null),
      sendText,
      generateComment,
      logger: silentLogger(),
    });
    await scheduler.updateAdminConfig(userId, agent.id, {
      enabled: true,
      location: "上海",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    });

    const preview = await scheduler.previewAdmin(userId, agent.id);

    expect(preview).toMatchObject({
      message:
        "上海今天局部多云，27.1～34.2℃，最高降水概率18%，最大风速16.4km/h。\n太阳挺认真，你也别忘了带伞。",
      weather: {
        tool: "weather_current",
        location: "上海",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sendText).not.toHaveBeenCalled();
    expect((await agents.getMemoryContext(userId, agent.id)).messages).toEqual(
      memoryBeforePreview.messages,
    );
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastStatus: "never",
    });
    const secondPreview = await scheduler.previewAdmin(userId, agent.id);
    expect(secondPreview.message).toBe(
      "上海今天局部多云，27.1～34.2℃，最高降水概率18%，最大风速16.4km/h。\n今天有点热，出门前自己看着办。",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(generateComment).toHaveBeenCalledTimes(2);
    for (const [params] of generateComment.mock.calls) {
      expect(params).toMatchObject({
        userId,
        agent,
        weather: {
          location: "上海",
          forecastDay: "today",
          date: "2026-07-27",
          conditionZh: "局部多云",
          temperatureMinC: 27.1,
          temperatureMaxC: 34.2,
          precipitationProbabilityMaxPercent: 18,
          windSpeedMaxKmh: 16.4,
        },
        voiceSamples: expect.arrayContaining([voiceSample]),
      });
    }
  });

  it("sends now as the selected non-active Agent with a fresh personalized comment", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-weather-send-now-persona-"),
    );
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const activeAgent = await agents.getActiveAgent(userId);
    const targetAgent = await agents.createAgent(userId, {
      name: "林夏",
      identity: "表面谨慎，实际会用很短的话关心用户。",
    });
    await agents.switchAgentById(userId, activeAgent.id);
    const voiceSample = "随你。外套还是带着。";
    await agents.appendTurn(userId, targetAgent.id, {
      input: "今天冷不冷？",
      reply: voiceSample,
      conversationMode: "wechat",
    });
    const personalizedComment = "伞放包里。不是担心你，只是不想听你抱怨。";
    const generateComment = vi.fn().mockResolvedValue(personalizedComment);
    const sendText = vi.fn().mockResolvedValue({ ret: 0 });
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl: weatherFetch() }),
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: "2026-07-27T00:59:00.000Z",
      }),
      sendText,
      generateComment,
      now: () => new Date("2026-07-27T01:00:00.000Z"),
      logger: silentLogger(),
    });
    await scheduler.updateAdminConfig(userId, targetAgent.id, {
      enabled: true,
      location: "上海",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    });

    const snapshot = await scheduler.sendAdminNow(userId, targetAgent.id);
    const expectedMessage =
      `上海今天局部多云，27.1～34.2℃，最高降水概率18%，最大风速16.4km/h。\n${personalizedComment}`;

    expect(generateComment).toHaveBeenCalledOnce();
    expect(generateComment).toHaveBeenCalledWith({
      userId,
      agent: targetAgent,
      weather: {
        location: "上海",
        forecastDay: "today",
        date: "2026-07-27",
        conditionZh: "局部多云",
        temperatureMinC: 27.1,
        temperatureMaxC: 34.2,
        precipitationProbabilityMaxPercent: 18,
        windSpeedMaxKmh: 16.4,
      },
      voiceSamples: [voiceSample],
    });
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        toUserId: userId,
        contextToken: "fresh-context",
        text: expectedMessage,
      }),
    );
    expect(snapshot).toMatchObject({
      lastStatus: "api_accepted",
      lastMessage: expectedMessage,
    });
    expect(
      (await agents.getMemoryContext(userId, targetAgent.id)).messages.at(-1),
    ).toEqual(expect.objectContaining({ content: expectedMessage }));
    expect(
      (await agents.getMemoryContext(userId, activeAgent.id)).messages,
    ).toEqual([]);
    expect((await agents.getActiveAgent(userId)).id).toBe(activeAgent.id);
  });

  it.each([
    {
      label: "model invents weather claims",
      generateComment: vi.fn().mockResolvedValue(
        "上海今天暴雨，19℃，降水100%，记得带伞。",
      ),
    },
    {
      label: "model returns blank text",
      generateComment: vi.fn().mockResolvedValue(" \n\t "),
    },
    {
      label: "model returns oversized text",
      generateComment: vi.fn().mockResolvedValue("太长".repeat(2_000)),
    },
    {
      label: "model generation fails",
      generateComment: vi.fn().mockRejectedValue(new Error("provider timeout")),
    },
  ])(
    "sends the immutable neutral fallback when $label",
    async ({ generateComment }) => {
      const stateDir = await mkdtemp(
        path.join(os.tmpdir(), "webot-weather-tone-fallback-"),
      );
      const agents = new AgentStore({ stateDir });
      const userId = "alice@im.wechat";
      const agent = await agents.getActiveAgent(userId);
      const logger = silentLogger();
      const sendText = vi.fn().mockResolvedValue({ ret: 0 });
      const scheduler = new WeatherScheduler({
        stateDir,
        agents,
        tools: new ToolRegistry({ fetchImpl: weatherFetch() }),
        getDeliveryContext: vi.fn().mockResolvedValue({
          contextToken: "fresh-context",
          recordedAt: "2026-07-27T00:59:00.000Z",
        }),
        sendText,
        generateComment,
        now: () => new Date("2026-07-27T01:00:00.000Z"),
        logger,
      });
      await scheduler.updateAdminConfig(userId, agent.id, {
        enabled: true,
        location: "上海",
        localTime: "09:00",
        timeZone: "Asia/Shanghai",
      });

      const snapshot = await scheduler.sendAdminNow(userId, agent.id);
      const fallback =
        "上海今天局部多云，27.1～34.2℃，最高降水概率18%，最大风速16.4km/h。出门前记得看一眼天气变化。";

      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          toUserId: userId,
          contextToken: "fresh-context",
          text: fallback,
        }),
      );
      expect(snapshot).toMatchObject({
        lastStatus: "api_accepted",
        lastMessage: fallback,
      });
      expect(
        (await agents.getMemoryContext(userId, agent.id)).messages.at(-1),
      ).toEqual(expect.objectContaining({ content: fallback }));
      expect(fallback).not.toContain("19℃");
      expect(fallback).not.toContain("100%");
      expect(fallback).not.toContain("暴雨");
      expect(generateComment).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledOnce();
    },
  );

  it("records a failed status when the weather tool fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-weather-tool-fail-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("weather unavailable"),
    );
    const sendText = vi.fn();
    const generateComment = vi.fn().mockResolvedValue("记得看天气。");
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl }),
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: "2026-07-27T01:00:00.000Z",
      }),
      sendText,
      generateComment,
      now: () => new Date("2026-07-27T01:00:00.000Z"),
      logger: silentLogger(),
    });
    await scheduler.updateAdminConfig(userId, agent.id, {
      enabled: true,
      location: "上海",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    });

    await scheduler.runDueTasks();

    expect(sendText).not.toHaveBeenCalled();
    expect(generateComment).not.toHaveBeenCalled();
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastLocalDate: "2026-07-27",
      lastStatus: "failed",
      lastError: expect.stringContaining("Weather service request failed"),
    });
  });

  it("records a failed status and no memory when iLink rejects sending", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-weather-send-fail-"));
    const agents = new AgentStore({ stateDir });
    const userId = "alice@im.wechat";
    const agent = await agents.getActiveAgent(userId);
    const fetchImpl = weatherFetch();
    const sendText = vi.fn().mockRejectedValue(new Error("iLink send failed"));
    const scheduler = new WeatherScheduler({
      stateDir,
      agents,
      tools: new ToolRegistry({ fetchImpl }),
      getDeliveryContext: vi.fn().mockResolvedValue({
        contextToken: "fresh-context",
        recordedAt: "2026-07-27T01:00:00.000Z",
      }),
      sendText,
      now: () => new Date("2026-07-27T01:00:00.000Z"),
      logger: silentLogger(),
    });
    await scheduler.updateAdminConfig(userId, agent.id, {
      enabled: true,
      location: "上海",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
    });

    await scheduler.runDueTasks();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledOnce();
    expect(await scheduler.getAdminSnapshot(userId, agent.id)).toMatchObject({
      lastLocalDate: "2026-07-27",
      lastStatus: "failed",
      lastError: "iLink send failed",
    });
    expect((await agents.getMemoryContext(userId, agent.id)).messages).toEqual(
      [],
    );
  });
});
