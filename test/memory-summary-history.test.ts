import crypto from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentStore } from "../src/agent-store.js";

const USER_ID = "owner@im.wechat";

function summaryDir(stateDir: string, userId: string, agentId: string): string {
  const userHash = crypto
    .createHash("sha256")
    .update(userId)
    .digest("hex")
    .slice(0, 24);
  return path.join(
    stateDir,
    "agents",
    userHash,
    "memory-summaries",
    agentId,
  );
}

async function compress(
  store: AgentStore,
  agentId: string,
  summary: string,
  factValue: string,
) {
  const candidate = await store.prepareMemoryCompression(USER_ID, agentId);
  expect(candidate).not.toBeNull();
  await expect(
    store.applyMemoryCompression(USER_ID, agentId, candidate!, {
      summary,
      facts: [{ key: "当前约定", value: factValue }],
      episodes: [
        {
          title: `第${summary}次整理`,
          content: `整理后的关键经历：${summary}`,
          importance: 4,
        },
      ],
    }),
  ).resolves.toBe(true);
}

describe("memory summary history", () => {
  it("keeps every successful curated version immutable and clears it with memory", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-summary-history-"),
    );
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const agent = await store.getActiveAgent(USER_ID);

    for (const value of ["一", "二", "三"]) {
      await store.appendTurn(USER_ID, agent.id, {
        input: `第${value}轮`,
        reply: `第${value}轮回复`,
      });
    }
    await compress(store, agent.id, "摘要版本一", "约定一");

    const snapshotDir = summaryDir(stateDir, USER_ID, agent.id);
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      path.join(snapshotDir, "00000002.json"),
      JSON.stringify({
        version: 1,
        agentId: agent.id,
        sequence: 2,
        createdAt: new Date().toISOString(),
        compressedMessageCount: 999,
        archivedMessageCount: 999,
        compressedMessageIds: [],
        summary: "未提交的孤儿摘要",
        facts: [],
        episodes: [],
      }),
    );
    await expect(
      store.getMemorySummaryHistory(USER_ID, agent.id),
    ).resolves.toHaveLength(1);

    for (const value of ["四", "五"]) {
      await store.appendTurn(USER_ID, agent.id, {
        input: `第${value}轮`,
        reply: `第${value}轮回复`,
      });
    }
    await compress(store, agent.id, "摘要版本二", "约定二");

    const snapshots = await store.getMemorySummaryHistory(USER_ID, agent.id);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(({ sequence, summary }) => ({ sequence, summary })))
      .toEqual([
        { sequence: 1, summary: "摘要版本一" },
        { sequence: 2, summary: "摘要版本二" },
      ]);
    expect(snapshots[0]).toMatchObject({
      compressedMessageCount: 4,
      archivedMessageCount: 4,
      facts: [expect.objectContaining({ value: "约定一" })],
      episodes: [expect.objectContaining({ content: "整理后的关键经历：摘要版本一" })],
    });
    expect(snapshots[0]?.migratedBaseline).toBeUndefined();
    expect(snapshots[0]?.compressedMessageIds).toHaveLength(4);
    expect(snapshots[1]).toMatchObject({
      compressedMessageCount: 4,
      archivedMessageCount: 8,
      summary: "摘要版本二",
      facts: [expect.objectContaining({ value: "约定二" })],
    });
    expect(snapshots[1]?.summary).not.toContain("孤儿");
    const otherAgent = await store.getActiveAgent("other@im.wechat");
    expect(otherAgent.id).not.toBe(agent.id);
    await expect(
      store.getMemorySummaryHistory("other@im.wechat", agent.id),
    ).rejects.toThrow("没有找到");

    await store.clearActiveMemory(USER_ID);
    await expect(
      store.getMemorySummaryHistory(USER_ID, agent.id),
    ).resolves.toEqual([]);
  });

  it("recovers only the latest pre-upgrade state as an honest migration baseline", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-summary-migration-"),
    );
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const agent = await store.getActiveAgent(USER_ID);
    for (const value of ["一", "二", "三"]) {
      await store.appendTurn(USER_ID, agent.id, {
        input: `旧版第${value}轮`,
        reply: `旧版第${value}轮回复`,
      });
    }
    await compress(store, agent.id, "升级前最后一版摘要", "旧约定");

    await rm(summaryDir(stateDir, USER_ID, agent.id), {
      recursive: true,
      force: true,
    });

    for (const value of ["四", "五"]) {
      await store.appendTurn(USER_ID, agent.id, {
        input: `升级后第${value}轮`,
        reply: `升级后第${value}轮回复`,
      });
    }
    await compress(store, agent.id, "升级后的新摘要", "新约定");

    const migrated = await store.getMemorySummaryHistory(USER_ID, agent.id);
    expect(migrated).toEqual([
      expect.objectContaining({
        sequence: 1,
        summary: "升级前最后一版摘要",
        migratedBaseline: true,
        compressedMessageIds: [],
      }),
      expect.objectContaining({
        sequence: 2,
        summary: "升级后的新摘要",
      }),
    ]);
    expect(migrated[1]?.migratedBaseline).toBeUndefined();
  });

  it("removes the complete snapshot archive when its Agent is deleted", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-summary-delete-"),
    );
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const original = await store.getActiveAgent(USER_ID);
    const removable = await store.createAgent(USER_ID, {
      name: "可删除助手",
      identity: "用于测试私有摘要清理。",
    });
    for (const value of ["一", "二", "三"]) {
      await store.appendTurn(USER_ID, removable.id, {
        input: `待删除第${value}轮`,
        reply: `待删除第${value}轮回复`,
      });
    }
    await compress(store, removable.id, "待删除摘要", "待删除约定");
    const archiveDir = summaryDir(stateDir, USER_ID, removable.id);
    await expect(access(archiveDir)).resolves.toBeUndefined();

    await store.switchAgentById(USER_ID, original.id);
    await store.deleteAgentById(USER_ID, removable.id);

    await expect(access(archiveDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
