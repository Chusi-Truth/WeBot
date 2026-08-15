import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  WeatherScheduleStore,
  type WeatherScheduleConfig,
} from "../src/weather-schedule-store.js";

const userId = "alice@im.wechat";
const agentA = "agent-a";
const agentB = "agent-b";

const shanghaiMorning: WeatherScheduleConfig = {
  enabled: true,
  location: "上海",
  localTime: "09:00",
  timeZone: "Asia/Shanghai",
};

describe("WeatherScheduleStore", () => {
  it("persists private per-agent schedules and reloads them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-weather-store-"));
    const store = new WeatherScheduleStore(stateDir);

    await store.updateConfig(userId, agentA, shanghaiMorning);
    await store.updateConfig(userId, agentB, {
      enabled: true,
      location: "北京",
      localTime: "18:30",
      timeZone: "Asia/Shanghai",
    });

    const schedulesDir = path.join(stateDir, "weather-schedules");
    const files = await readdir(schedulesDir);
    expect(files).toHaveLength(1);
    expect((await stat(schedulesDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(schedulesDir, files[0]!))).mode & 0o777).toBe(
      0o600,
    );
    expect(files[0]).not.toContain(userId);
    const persisted = await readFile(path.join(schedulesDir, files[0]!), "utf8");
    expect(persisted).not.toContain(userId);
    expect(JSON.parse(persisted)).toMatchObject({
      version: 1,
      userHash: files[0]!.replace(/\.json$/u, ""),
    });

    const reloaded = new WeatherScheduleStore(stateDir);
    expect(await reloaded.getSnapshot(userId, agentA)).toMatchObject({
      ...shanghaiMorning,
      lastStatus: "never",
    });
    expect(await reloaded.getSnapshot(userId, agentB)).toMatchObject({
      enabled: true,
      location: "北京",
      localTime: "18:30",
      timeZone: "Asia/Shanghai",
      lastStatus: "never",
    });
  });

  it("isolates run state by agent and resets it when scheduling details change", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-weather-isolation-"));
    const store = new WeatherScheduleStore(stateDir);
    const occurredAt = "2026-07-27T01:00:00.000Z";

    await store.updateConfig(userId, agentA, shanghaiMorning);
    await store.updateConfig(userId, agentB, {
      ...shanghaiMorning,
      location: "杭州",
    });
    expect(await store.claim(userId, agentA, "2026-07-27", occurredAt)).toBe(
      true,
    );
    await store.complete(userId, agentA, {
      status: "api_accepted",
      occurredAt,
      message: "上海天气消息",
    });

    expect(await store.getSnapshot(userId, agentA)).toMatchObject({
      location: "上海",
      lastLocalDate: "2026-07-27",
      lastStatus: "api_accepted",
      lastMessage: "上海天气消息",
    });
    expect(await store.getSnapshot(userId, agentB)).toMatchObject({
      location: "杭州",
      lastStatus: "never",
    });

    await store.updateConfig(userId, agentA, {
      ...shanghaiMorning,
      enabled: false,
    });
    expect(await store.getSnapshot(userId, agentA)).toMatchObject({
      enabled: false,
      lastLocalDate: "2026-07-27",
      lastStatus: "api_accepted",
    });

    await store.updateConfig(userId, agentA, {
      ...shanghaiMorning,
      location: "苏州",
    });
    expect(await store.getSnapshot(userId, agentA)).toMatchObject({
      ...shanghaiMorning,
      location: "苏州",
      lastStatus: "never",
    });
  });

  it("claims a date once, while allowing waiting-for-context jobs to retry", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-weather-claim-"));
    const store = new WeatherScheduleStore(stateDir);
    await store.updateConfig(userId, agentA, shanghaiMorning);

    expect(
      await store.claim(
        userId,
        agentA,
        "2026-07-27",
        "2026-07-27T01:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      await store.claim(
        userId,
        agentA,
        "2026-07-27",
        "2026-07-27T01:01:00.000Z",
      ),
    ).toBe(false);

    await store.markWaitingContext(
      userId,
      agentA,
      "2026-07-27",
      "2026-07-27T01:02:00.000Z",
    );
    expect(await store.getSnapshot(userId, agentA)).toMatchObject({
      lastLocalDate: "2026-07-27",
      lastStatus: "waiting_context",
    });
    expect(
      await store.claim(
        userId,
        agentA,
        "2026-07-27",
        "2026-07-27T01:03:00.000Z",
      ),
    ).toBe(true);
    expect(
      await store.claim(
        userId,
        agentA,
        "2026-07-27",
        "2026-07-27T01:04:00.000Z",
      ),
    ).toBe(false);
  });

  it("deletes Agent-owned location data and does not recreate it from a late completion", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-weather-delete-"),
    );
    const store = new WeatherScheduleStore(stateDir);
    await store.updateConfig(userId, agentA, shanghaiMorning);
    expect(
      await store.claim(
        userId,
        agentA,
        "2026-07-27",
        "2026-07-27T01:00:00.000Z",
      ),
    ).toBe(true);

    await store.deleteAgent(userId, agentA);
    await store.complete(userId, agentA, {
      status: "api_accepted",
      occurredAt: "2026-07-27T01:01:00.000Z",
      message: "不应恢复",
    });

    expect(await store.getSnapshot(userId, agentA)).toEqual({
      enabled: false,
      location: "",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
      lastStatus: "never",
    });
  });

  it("serializes deletion and late completion across separate store instances", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-weather-multi-store-"),
    );
    const deletionStore = new WeatherScheduleStore(stateDir);
    const schedulerStore = new WeatherScheduleStore(stateDir);
    await schedulerStore.updateConfig(userId, agentA, shanghaiMorning);
    expect(
      await schedulerStore.claim(
        userId,
        agentA,
        "2026-07-27",
        "2026-07-27T01:00:00.000Z",
      ),
    ).toBe(true);

    await Promise.all([
      deletionStore.deleteAgent(userId, agentA),
      schedulerStore.complete(userId, agentA, {
        status: "api_accepted",
        occurredAt: "2026-07-27T01:01:00.000Z",
        message: "迟到的完成结果",
      }),
    ]);

    expect(await schedulerStore.getSnapshot(userId, agentA)).toEqual({
      enabled: false,
      location: "",
      localTime: "09:00",
      timeZone: "Asia/Shanghai",
      lastStatus: "never",
    });
  });
});
