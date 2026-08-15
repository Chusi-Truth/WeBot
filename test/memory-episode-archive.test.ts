import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentStore } from "../src/agent-store.js";

const USER_ID = "owner@im.wechat";

async function appendCompressibleTurns(
  store: AgentStore,
  agentId: string,
  labels: readonly string[],
) {
  for (const label of labels) {
    await store.appendTurn(USER_ID, agentId, {
      input: `${label}用户消息`,
      reply: `${label}助手回复`,
    });
  }
}

async function compressWithEpisode(
  store: AgentStore,
  agentId: string,
  episode: { title: string; content: string; importance: 1 | 2 | 3 | 4 | 5 },
) {
  const candidate = await store.prepareMemoryCompression(USER_ID, agentId);
  expect(candidate).not.toBeNull();
  await expect(
    store.applyMemoryCompression(USER_ID, agentId, candidate!, {
      summary: `包含${episode.title}的摘要`,
      facts: [],
      episodes: [episode],
    }),
  ).resolves.toBe(true);
}

describe("memory episode archive", () => {
  it("keeps older events active and exposes a complete deduplicated archive", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-episode-archive-"),
    );
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const agent = await store.getActiveAgent(USER_ID);

    await appendCompressibleTurns(store, agent.id, ["一", "二", "三"]);
    await compressWithEpisode(store, agent.id, {
      title: "毕业约定",
      content: "双方约定毕业后一起去看海。",
      importance: 5,
    });
    await appendCompressibleTurns(store, agent.id, ["四", "五"]);
    await compressWithEpisode(store, agent.id, {
      title: "第一次争执",
      content: "双方因失约发生争执，仍需要继续沟通。",
      importance: 4,
    });

    let memory = await store.getMemoryContext(USER_ID, agent.id);
    expect(memory.episodes.map(({ title }) => title)).toEqual([
      "毕业约定",
      "第一次争执",
    ]);

    await appendCompressibleTurns(store, agent.id, ["六", "七"]);
    await compressWithEpisode(store, agent.id, {
      title: "毕业约定",
      content: "双方把看海约定改到秋天，并确认会提前请假。",
      importance: 5,
    });
    memory = await store.getMemoryContext(USER_ID, agent.id);
    expect(memory.episodes).toHaveLength(2);
    expect(memory.episodes[0]).toMatchObject({
      title: "毕业约定",
      content: expect.stringContaining("改到秋天"),
    });

    const archive = await store.getMemoryEpisodeArchive(USER_ID, agent.id);
    expect(archive.compressionCount).toBe(3);
    expect(archive.missingLegacyCompressionCount).toBe(0);
    expect(archive.episodes).toHaveLength(2);
    expect(archive.episodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "毕业约定",
          seenCount: 3,
          compressionSequences: [1, 2, 3],
          currentlyActive: true,
        }),
        expect.objectContaining({
          title: "第一次争执",
          seenCount: 2,
          compressionSequences: [2, 3],
          currentlyActive: true,
        }),
      ]),
    );
  });

  it("atomically replaces a rebuild layer without deleting curator events", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-episode-rebuild-"),
    );
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const agent = await store.getActiveAgent(USER_ID);
    await appendCompressibleTurns(store, agent.id, ["一", "二", "三"]);
    await compressWithEpisode(store, agent.id, {
      title: "毕业约定",
      content: "双方约定毕业后一起去看海。",
      importance: 5,
    });
    const generation = store.captureDataGeneration(USER_ID, agent.id);
    await expect(
      store.saveReconstructedMemoryEpisodes(
        USER_ID,
        agent.id,
        {
          episodes: [
            {
              title: "周末看展",
              content: "双方约定周末一起去看展。",
              importance: 4,
            },
            {
              title: "错误推断",
              content: "错误地推断用户已经搬家。",
              importance: 3,
            },
          ],
          sourceMessageCount: 8,
        },
        generation,
      ),
    ).resolves.toBe(true);

    // A normal compression between rebuilds must remain in the curator layer
    // rather than being attributed to the reconstructed source.
    await appendCompressibleTurns(store, agent.id, ["四", "五"]);
    await compressWithEpisode(store, agent.id, {
      title: "求职进展",
      content: "用户收到了面试邀请，准备周五参加面试。",
      importance: 4,
    });

    await expect(
      store.saveReconstructedMemoryEpisodes(
        USER_ID,
        agent.id,
        {
          episodes: [
            {
              title: "确认未搬家",
              content: "用户明确表示自己没有搬家。",
              importance: 3,
            },
          ],
          sourceMessageCount: 4,
        },
        generation,
      ),
    ).resolves.toBe(true);

    expect(await store.getMemoryContext(USER_ID, agent.id)).toMatchObject({
      episodes: expect.arrayContaining([
        expect.objectContaining({
          title: "毕业约定",
        }),
        expect.objectContaining({
          title: "求职进展",
        }),
        expect.objectContaining({
          title: "确认未搬家",
        }),
      ]),
    });
    const archive = await store.getMemoryEpisodeArchive(USER_ID, agent.id);
    expect(archive).toMatchObject({
      sourceMessageCount: 4,
      episodes: expect.arrayContaining([
        expect.objectContaining({
          title: "毕业约定",
          reconstructed: false,
          currentlyActive: true,
        }),
        expect.objectContaining({
          title: "求职进展",
          reconstructed: false,
          currentlyActive: true,
        }),
        expect.objectContaining({
          title: "确认未搬家",
          reconstructed: true,
          currentlyActive: true,
        }),
      ]),
    });
    expect(archive.episodes.map(({ title }) => title)).not.toContain("周末看展");
    expect(archive.episodes.map(({ title }) => title)).not.toContain("错误推断");

    await store.clearActiveMemory(USER_ID);
    expect(await store.getMemoryEpisodeArchive(USER_ID, agent.id)).toMatchObject({
      sourceMessageCount: 0,
      episodes: [],
    });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("preserves reconstructed occurrence anchors while remaining compatible with legacy episodes", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-episode-occurrence-"),
    );
    const store = new AgentStore({ stateDir });
    const agent = await store.getActiveAgent(USER_ID);

    await expect(
      store.saveReconstructedMemoryEpisodes(USER_ID, agent.id, {
        sourceMessageCount: 6,
        episodes: [
          {
            sourceKey: "anchored-history",
            sourceMessageId: "history-message-1",
            sourceOrder: 0,
            occurredAt: "2025-03-04T05:06:07.000Z",
            occurrencePrecision: "message",
            title: "有精确锚点的前史",
            content: "这条事件锚定到一条真实的历史消息。",
            importance: 5,
          },
          {
            sourceKey: "batch-fallback",
            sourceOrder: 4,
            occurredAt: "2025-04-01T00:00:00.000Z",
            occurrencePrecision: "batch",
            title: "只有批次时间的事件",
            content: "这条事件没有精确消息锚点，但保留了批次时间。",
            importance: 4,
          },
          {
            sourceKey: "legacy-without-occurrence",
            title: "升级前的旧事件",
            content: "旧数据没有发生时间字段，仍然必须可以读取。",
            importance: 3,
          },
        ],
      }),
    ).resolves.toBe(true);

    const archive = await store.getMemoryEpisodeArchive(USER_ID, agent.id);
    expect(archive.episodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "有精确锚点的前史",
          sourceMessageId: "history-message-1",
          sourceOrder: 0,
          occurredAt: "2025-03-04T05:06:07.000Z",
          occurrencePrecision: "message",
        }),
        expect.objectContaining({
          title: "只有批次时间的事件",
          sourceOrder: 4,
          occurredAt: "2025-04-01T00:00:00.000Z",
          occurrencePrecision: "batch",
        }),
        expect.objectContaining({
          title: "升级前的旧事件",
        }),
      ]),
    );
    expect(
      archive.episodes.find(({ title }) => title === "升级前的旧事件"),
    ).not.toHaveProperty("occurredAt");
    expect(
      archive.episodes
        .filter(({ occurredAt }) => occurredAt)
        .map(({ title }) => title),
    ).toEqual([
      "只有批次时间的事件",
      "有精确锚点的前史",
    ]);
    expect(
      (await store.getMemoryContext(USER_ID, agent.id)).episodes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "有精确锚点的前史",
          occurredAt: "2025-03-04T05:06:07.000Z",
        }),
        expect.objectContaining({
          title: "升级前的旧事件",
        }),
      ]),
    );
    await rm(stateDir, { recursive: true, force: true });
  });

  it("keeps punctuation-distinct event titles separate while updating exact titles", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-episode-source-key-"),
    );
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const agent = await store.getActiveAgent(USER_ID);

    await appendCompressibleTurns(store, agent.id, ["一", "二", "三"]);
    const candidate = await store.prepareMemoryCompression(USER_ID, agent.id);
    expect(candidate).not.toBeNull();
    await store.applyMemoryCompression(USER_ID, agent.id, candidate!, {
      summary: "记录了两个不同项目。",
      facts: [],
      episodes: [
        {
          title: "项目：A-B",
          content: "用户决定继续推进 A-B 项目。",
          importance: 4,
        },
        {
          title: "项目 A·B",
          content: "用户决定暂停另一个 A·B 项目。",
          importance: 4,
        },
        {
          title: "同名事件",
          content: "甲方活动在上午举行。",
          importance: 3,
        },
        {
          title: "同名事件",
          content: "乙方活动在晚上举行。",
          importance: 3,
        },
      ],
    });

    await appendCompressibleTurns(store, agent.id, ["四", "五"]);
    await compressWithEpisode(store, agent.id, {
      title: "项目：A-B",
      content: "用户后来决定把 A-B 项目延期一周。",
      importance: 5,
    });

    const memory = await store.getMemoryContext(USER_ID, agent.id);
    expect(memory.episodes).toHaveLength(4);
    expect(memory.episodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "项目：A-B",
          content: expect.stringContaining("延期一周"),
        }),
        expect.objectContaining({
          title: "项目 A·B",
          content: expect.stringContaining("暂停"),
        }),
      ]),
    );
    expect(
      memory.episodes.filter(({ title }) => title === "同名事件"),
    ).toHaveLength(2);
    await rm(stateDir, { recursive: true, force: true });
  });

  it("uses explicit source keys to distinguish and correct same-title events", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-episode-explicit-source-key-"),
    );
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const agent = await store.getActiveAgent(USER_ID);

    await appendCompressibleTurns(store, agent.id, ["一", "二", "三"]);
    let candidate = await store.prepareMemoryCompression(USER_ID, agent.id);
    expect(candidate).not.toBeNull();
    await store.applyMemoryCompression(USER_ID, agent.id, candidate!, {
      summary: "两个同名但独立的项目事件。",
      facts: [],
      episodes: [
        {
          sourceKey: "project-alpha",
          title: "项目进展",
          content: "Alpha 项目通过第一轮评审。",
          importance: 4,
        },
        {
          sourceKey: "project-beta",
          title: "项目进展",
          content: "Beta 项目因资源不足暂停。",
          importance: 4,
        },
      ],
    });

    await appendCompressibleTurns(store, agent.id, ["四", "五"]);
    candidate = await store.prepareMemoryCompression(USER_ID, agent.id);
    expect(candidate).not.toBeNull();
    await store.applyMemoryCompression(USER_ID, agent.id, candidate!, {
      summary: "Alpha 项目的评审结论有更新。",
      facts: [],
      episodes: [
        {
          sourceKey: "project-alpha",
          title: "项目进展",
          content: "Alpha 项目复审后被要求补充材料。",
          importance: 5,
        },
      ],
    });

    const episodes = (await store.getMemoryContext(USER_ID, agent.id)).episodes;
    expect(episodes).toHaveLength(2);
    expect(episodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining("补充材料"),
        }),
        expect.objectContaining({
          content: expect.stringContaining("Beta"),
        }),
      ]),
    );
    await rm(stateDir, { recursive: true, force: true });
  });

  it("bounds active and compression-context events while preserving the archive", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-episode-limits-"),
    );
    const store = new AgentStore({
      stateDir,
      maxMemoryMessages: 4,
      retainRecentMessages: 2,
    });
    const agent = await store.getActiveAgent(USER_ID);

    await appendCompressibleTurns(store, agent.id, ["一", "二", "三"]);
    let candidate = await store.prepareMemoryCompression(USER_ID, agent.id);
    expect(candidate).not.toBeNull();
    await store.applyMemoryCompression(USER_ID, agent.id, candidate!, {
      summary: "第一批事件",
      facts: [],
      episodes: Array.from({ length: 50 }, (_, index) => ({
        title: `第一批事件 ${index}`,
        content: `第一批事件内容 ${index}`,
        importance: 3 as const,
      })),
    });
    await appendCompressibleTurns(store, agent.id, ["四", "五"]);
    candidate = await store.prepareMemoryCompression(USER_ID, agent.id);
    expect(candidate).not.toBeNull();
    await store.applyMemoryCompression(USER_ID, agent.id, candidate!, {
      summary: "第二批事件",
      facts: [],
      episodes: Array.from({ length: 50 }, (_, index) => ({
        title: `第二批事件 ${index}`,
        content: `第二批事件内容 ${index}`,
        importance: 4 as const,
      })),
    });

    expect((await store.getMemoryContext(USER_ID, agent.id)).episodes).toHaveLength(
      60,
    );
    expect((await store.getMemoryEpisodeArchive(USER_ID, agent.id)).episodes)
      .toHaveLength(100);

    await appendCompressibleTurns(store, agent.id, ["六", "七"]);
    candidate = await store.prepareMemoryCompression(USER_ID, agent.id);
    expect(candidate?.previousEpisodes).toHaveLength(40);
    await rm(stateDir, { recursive: true, force: true });
  });

  it("serializes archive reads with a concurrent memory clear", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-episode-clear-race-"),
    );
    let enterClear!: () => void;
    let releaseClear!: () => void;
    const clearEntered = new Promise<void>((resolve) => {
      enterClear = resolve;
    });
    const clearReleased = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const store = new AgentStore({
      stateDir,
      onClearAgentData: async () => {
        enterClear();
        await clearReleased;
      },
    });
    const agent = await store.getActiveAgent(USER_ID);
    await store.saveReconstructedMemoryEpisodes(USER_ID, agent.id, {
      episodes: [
        {
          title: "待清理事件",
          content: "这条事件会随记忆清除。",
          importance: 3,
        },
      ],
      sourceMessageCount: 2,
    });

    const clearing = store.clearActiveMemory(USER_ID);
    await clearEntered;
    let archiveResolved = false;
    const reading = store
      .getMemoryEpisodeArchive(USER_ID, agent.id)
      .then((archive) => {
        archiveResolved = true;
        return archive;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(archiveResolved).toBe(false);
    releaseClear();
    await clearing;
    await expect(reading).resolves.toMatchObject({
      sourceMessageCount: 0,
      episodes: [],
    });
    await rm(stateDir, { recursive: true, force: true });
  });
});
