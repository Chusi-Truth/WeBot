import crypto from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentStore } from "../src/agent-store.js";
import type {
  AgentExecutionContext,
  AgentMemoryCompressionResult,
  AgentMemoryEpisode,
  AgentMemoryMajorEvent,
} from "../src/agent-types.js";
import { selectRelevantMemory } from "../src/memory-relevance.js";
import { compilePromptPlan } from "../src/prompt-compiler.js";

const USER_ID = "owner@im.wechat";

async function withStore(
  test: (fixture: {
    stateDir: string;
    store: AgentStore;
    agentId: string;
  }) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "webot-memory-event-hierarchy-"),
  );
  const store = new AgentStore({ stateDir });
  const agent = await store.getActiveAgent(USER_ID);
  try {
    await test({ stateDir, store, agentId: agent.id });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function replaceReconstructedDetails(
  store: AgentStore,
  agentId: string,
  episodes: AgentMemoryCompressionResult["episodes"],
): Promise<void> {
  await expect(
    store.saveReconstructedMemoryEpisodes(USER_ID, agentId, {
      episodes,
      sourceMessageCount: episodes.length * 2,
    }),
  ).resolves.toBe(true);
}

async function detailKeysByTitle(
  store: AgentStore,
  agentId: string,
): Promise<Record<string, string>> {
  const candidate = await store.getMemoryEpisodeOrganizationCandidate(
    USER_ID,
    agentId,
  );
  return Object.fromEntries(
    candidate.episodes.map((episode) => [episode.title, episode.sourceKey]),
  );
}

function hierarchySidecarPath(
  stateDir: string,
  agentId: string,
): string {
  const userHash = crypto
    .createHash("sha256")
    .update(USER_ID)
    .digest("hex")
    .slice(0, 24);
  return path.join(
    stateDir,
    "agents",
    userHash,
    "memory-major-events",
    `${agentId}.json`,
  );
}

describe("memory event hierarchy", () => {
  it("materializes flat details into a major event without losing detail data", async () => {
    await withStore(async ({ store, agentId }) => {
      await replaceReconstructedDetails(store, agentId, [
        {
          sourceKey: "rainy-night-meeting",
          title: "雨夜初见",
          content: "两人在雨夜的图书馆第一次见面。",
          importance: 5,
        },
        {
          sourceKey: "record-search-promise",
          title: "寻找旧地图",
          content: "双方约定一起查清无标签地图的来源。",
          importance: 4,
        },
      ]);
      const candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );

      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: candidate.inputFingerprint,
          groups: [
            {
              title: "相识与共同调查",
              summary: "两人从初次见面逐渐开始共同调查旧地图。",
              importance: 5,
              status: "ongoing",
              detailKeys: candidate.episodes.map(
                (episode) => episode.sourceKey,
              ),
            },
          ],
        }),
      ).resolves.toBe(true);

      const archive = await store.getMemoryEpisodeArchive(USER_ID, agentId);
      expect(archive.majorEvents).toHaveLength(1);
      expect(archive.ungroupedEpisodeCount).toBe(0);
      const flatDetails = archive.episodes
        .map(({ sourceKey, title, content, importance }) => ({
          sourceKey,
          title,
          content,
          importance,
        }))
        .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
      const nestedDetails = archive.majorEvents[0]!.details
        .map(({ sourceKey, title, content, importance }) => ({
          sourceKey,
          title,
          content,
          importance,
        }))
        .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
      expect(nestedDetails).toEqual(flatDetails);
      expect([...archive.majorEvents[0]!.detailKeys].sort()).toEqual(
        archive.majorEvents[0]!.details
          .map((detail) => detail.sourceKey)
          .sort(),
      );
    });
  });

  it("orders a major event's details by occurrence time and exposes its actual time range", async () => {
    await withStore(async ({ store, agentId }) => {
      await replaceReconstructedDetails(store, agentId, [
        {
          sourceKey: "later-stage",
          sourceMessageId: "message-later",
          sourceOrder: 8,
          occurredAt: "2026-06-20T12:00:00.000Z",
          occurrencePrecision: "message",
          title: "后期进展",
          content: "这是同一件大事在后期出现的进展。",
          importance: 5,
        },
        {
          sourceKey: "earlier-stage",
          sourceMessageId: "message-earlier",
          sourceOrder: 1,
          occurredAt: "2025-11-02T08:00:00.000Z",
          occurrencePrecision: "message",
          title: "前史开端",
          content: "这是同一件大事早期真正发生的开端。",
          importance: 4,
        },
        {
          sourceKey: "middle-stage",
          sourceMessageId: "message-middle",
          sourceOrder: 4,
          occurredAt: "2026-02-14T18:30:00.000Z",
          occurrencePrecision: "message",
          title: "中期转折",
          content: "这是同一件大事在中期发生的转折。",
          importance: 5,
        },
      ]);
      const candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );
      expect(
        candidate.episodes.map(
          ({
            sourceKey,
            sourceMessageId,
            sourceOrder,
            occurredAt,
            occurrencePrecision,
          }) => ({
            sourceKey,
            sourceMessageId,
            sourceOrder,
            occurredAt,
            occurrencePrecision,
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          {
            sourceKey: expect.stringMatching(/^curator:/),
            sourceMessageId: "message-earlier",
            sourceOrder: 1,
            occurredAt: "2025-11-02T08:00:00.000Z",
            occurrencePrecision: "message",
          },
          {
            sourceKey: expect.stringMatching(/^curator:/),
            sourceMessageId: "message-middle",
            sourceOrder: 4,
            occurredAt: "2026-02-14T18:30:00.000Z",
            occurrencePrecision: "message",
          },
          {
            sourceKey: expect.stringMatching(/^curator:/),
            sourceMessageId: "message-later",
            sourceOrder: 8,
            occurredAt: "2026-06-20T12:00:00.000Z",
            occurrencePrecision: "message",
          },
        ]),
      );

      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: candidate.inputFingerprint,
          groups: [
            {
              title: "跨越前史与后期的连续事件",
              summary: "同一事件从前史开端，经过中期转折，发展到后期。",
              importance: 5,
              status: "ongoing",
              detailKeys: candidate.episodes.map(
                (episode) => episode.sourceKey,
              ),
            },
          ],
        }),
      ).resolves.toBe(true);

      const majorEvent = (
        await store.getMemoryEpisodeArchive(USER_ID, agentId)
      ).majorEvents[0]!;
      expect(majorEvent.details.map(({ title }) => title)).toEqual([
        "前史开端",
        "中期转折",
        "后期进展",
      ]);
      expect(majorEvent).toMatchObject({
        firstOccurredAt: "2025-11-02T08:00:00.000Z",
        lastOccurredAt: "2026-06-20T12:00:00.000Z",
      });
      expect(
        majorEvent.details.map(
          ({
            sourceMessageId,
            sourceOrder,
            occurredAt,
            occurrencePrecision,
          }) => ({
            sourceMessageId,
            sourceOrder,
            occurredAt,
            occurrencePrecision,
          }),
        ),
      ).toEqual([
        {
          sourceMessageId: "message-earlier",
          sourceOrder: 1,
          occurredAt: "2025-11-02T08:00:00.000Z",
          occurrencePrecision: "message",
        },
        {
          sourceMessageId: "message-middle",
          sourceOrder: 4,
          occurredAt: "2026-02-14T18:30:00.000Z",
          occurrencePrecision: "message",
        },
        {
          sourceMessageId: "message-later",
          sourceOrder: 8,
          occurredAt: "2026-06-20T12:00:00.000Z",
          occurrencePrecision: "message",
        },
      ]);
    });
  });

  it("uses source order to keep tied message timestamps strictly chronological", async () => {
    await withStore(async ({ store, agentId }) => {
      const tiedAt = "2026-07-29T10:00:00.000Z";
      await replaceReconstructedDetails(store, agentId, [
        {
          sourceKey: "bubble-third",
          sourceMessageId: "message-third",
          sourceOrder: 2,
          occurredAt: tiedAt,
          occurrencePrecision: "message",
          title: "第三个气泡",
          content: "同一轮中最后发出的回复。",
          importance: 3,
        },
        {
          sourceKey: "bubble-first",
          sourceMessageId: "message-first",
          sourceOrder: 0,
          occurredAt: tiedAt,
          occurrencePrecision: "message",
          title: "第一个气泡",
          content: "同一轮中最先出现的消息。",
          importance: 3,
        },
        {
          sourceKey: "bubble-second",
          sourceMessageId: "message-second",
          sourceOrder: 1,
          occurredAt: tiedAt,
          occurrencePrecision: "message",
          title: "第二个气泡",
          content: "同一轮中随后出现的回复。",
          importance: 3,
        },
      ]);
      const candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );
      await store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
        inputFingerprint: candidate.inputFingerprint,
        groups: [
          {
            title: "同一时刻的连续消息",
            summary: "三条消息拥有相同时间戳，但仍按原始归档顺序排列。",
            importance: 3,
            status: "resolved",
            detailKeys: candidate.episodes.map(
              (episode) => episode.sourceKey,
            ),
          },
        ],
      });

      const archive = await store.getMemoryEpisodeArchive(USER_ID, agentId);
      expect(
        archive.episodes.map(({ sourceOrder }) => sourceOrder),
      ).toEqual([2, 1, 0]);
      expect(
        archive.majorEvents[0]!.details.map(({ sourceOrder }) => sourceOrder),
      ).toEqual([0, 1, 2]);
    });
  });

  it("assigns a duplicate detail key to only one major event", async () => {
    await withStore(async ({ store, agentId }) => {
      await replaceReconstructedDetails(store, agentId, [
        {
          sourceKey: "shared-detail",
          title: "共同约定",
          content: "双方约定周末见面。",
          importance: 5,
        },
        {
          sourceKey: "alpha-detail",
          title: "准备路线",
          content: "已经查好去展馆的路线。",
          importance: 3,
        },
        {
          sourceKey: "beta-detail",
          title: "准备门票",
          content: "已经确认门票仍然有效。",
          importance: 3,
        },
      ]);
      const candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );
      const keys = await detailKeysByTitle(store, agentId);

      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: candidate.inputFingerprint,
          groups: [
            {
              title: "大事件甲",
              summary: "甲事件应优先取得重复细节。",
              importance: 5,
              status: "ongoing",
              detailKeys: [keys["共同约定"]!, keys["准备路线"]!],
            },
            {
              title: "大事件乙",
              summary: "乙事件仍应保留自己的独立细节。",
              importance: 4,
              status: "ongoing",
              detailKeys: [keys["共同约定"]!, keys["准备门票"]!],
            },
          ],
        }),
      ).resolves.toBe(true);

      const archive = await store.getMemoryEpisodeArchive(USER_ID, agentId);
      const allOwnedKeys = archive.majorEvents.flatMap((event) =>
        event.detailKeys
      );
      expect(new Set(allOwnedKeys).size).toBe(allOwnedKeys.length);
      expect(
        allOwnedKeys.filter((key) => key === keys["共同约定"]),
      ).toHaveLength(1);
      expect(
        archive.majorEvents.find((event) =>
          event.detailKeys.includes(keys["共同约定"]!)
        )?.title,
      ).toBe("大事件甲");
      expect(allOwnedKeys).toHaveLength(3);
    });
  });

  it("reuses a previous major-event identity when reorganizing overlapping details", async () => {
    await withStore(async ({ store, agentId }) => {
      const firstTwo = [
        {
          sourceKey: "argument-detail",
          title: "发生争执",
          content: "双方因为失约发生争执。",
          importance: 4 as const,
        },
        {
          sourceKey: "apology-detail",
          title: "认真道歉",
          content: "双方说明责任并完成道歉。",
          importance: 5 as const,
        },
      ];
      await replaceReconstructedDetails(store, agentId, firstTwo);
      let candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );
      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: candidate.inputFingerprint,
          groups: [
            {
              title: "争执与修复",
              summary: "一次争执经过沟通得到修复。",
              importance: 5,
              status: "resolved",
              detailKeys: candidate.episodes.map(
                (episode) => episode.sourceKey,
              ),
            },
          ],
        }),
      ).resolves.toBe(true);
      const previous = (
        await store.getMemoryEpisodeArchive(USER_ID, agentId)
      ).majorEvents[0]!;

      await replaceReconstructedDetails(store, agentId, [
        ...firstTwo,
        {
          sourceKey: "new-boundary-detail",
          title: "确认新的边界",
          content: "双方约定以后无法赴约时要提前说明。",
          importance: 5,
        },
      ]);
      candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );
      const keys = await detailKeysByTitle(store, agentId);
      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: candidate.inputFingerprint,
          groups: [
            {
              sourceKey: "model-proposed-new-parent-key",
              title: "关系修复的新阶段",
              summary: "道歉之后，双方进一步确认了新的相处边界。",
              importance: 5,
              status: "ongoing",
              detailKeys: [
                keys["认真道歉"]!,
                keys["确认新的边界"]!,
              ],
            },
          ],
        }),
      ).resolves.toBe(true);

      const reorganized = (
        await store.getMemoryEpisodeArchive(USER_ID, agentId)
      ).majorEvents[0]!;
      expect(reorganized).toMatchObject({
        id: previous.id,
        sourceKey: previous.sourceKey,
        title: "关系修复的新阶段",
      });
      expect(reorganized.detailKeys).toEqual(
        expect.arrayContaining([
          keys["认真道歉"],
          keys["确认新的边界"],
        ]),
      );
    });
  });

  it("rejects a hierarchy save when its input fingerprint is stale", async () => {
    await withStore(async ({ store, agentId }) => {
      await replaceReconstructedDetails(store, agentId, [
        {
          sourceKey: "first-detail",
          title: "第一条细节",
          content: "这是整理开始时存在的细节。",
          importance: 3,
        },
      ]);
      const stale = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );

      await replaceReconstructedDetails(store, agentId, [
        {
          sourceKey: "first-detail",
          title: "第一条细节",
          content: "这是整理开始时存在的细节。",
          importance: 3,
        },
        {
          sourceKey: "late-detail",
          title: "后来新增的细节",
          content: "该细节使旧 fingerprint 失效。",
          importance: 4,
        },
      ]);

      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: stale.inputFingerprint,
          groups: [
            {
              title: "过期整理结果",
              summary: "这份结果不应写入。",
              importance: 4,
              status: "uncertain",
              detailKeys: [stale.episodes[0]!.sourceKey],
            },
          ],
        }),
      ).resolves.toBe(false);
      expect(
        (await store.getMemoryEpisodeArchive(USER_ID, agentId)).majorEvents,
      ).toEqual([]);
    });
  });

  it("invalidates a hierarchy fingerprint when only chronology changes", async () => {
    await withStore(async ({ store, agentId }) => {
      const shared = {
        sourceKey: "same-event",
        sourceMessageId: "same-message",
        occurredAt: "2026-01-01T00:00:00.000Z",
        occurrencePrecision: "message" as const,
        title: "同一事件",
        content: "事件文字没有变化，但历史顺序得到修正。",
        importance: 4 as const,
      };
      await replaceReconstructedDetails(store, agentId, [
        { ...shared, sourceOrder: 12 },
      ]);
      const stale = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );

      await replaceReconstructedDetails(store, agentId, [
        { ...shared, sourceOrder: 3 },
      ]);
      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: stale.inputFingerprint,
          groups: [
            {
              title: "过期的时间分组",
              summary: "只要原始顺序变了，旧分组指纹也必须失效。",
              importance: 4,
              status: "uncertain",
              detailKeys: [stale.episodes[0]!.sourceKey],
            },
          ],
        }),
      ).resolves.toBe(false);
    });
  });

  it("rejects an incomplete organizer result without replacing the prior hierarchy", async () => {
    await withStore(async ({ store, agentId }) => {
      await replaceReconstructedDetails(store, agentId, [
        {
          sourceKey: "kept-detail",
          title: "保留的细节",
          content: "这条细节会出现在模型结果中。",
          importance: 4,
        },
        {
          sourceKey: "omitted-detail",
          title: "被遗漏的细节",
          content: "模型漏掉这条时，整次整理必须失败。",
          importance: 5,
        },
      ]);
      const candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );
      await store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
        inputFingerprint: candidate.inputFingerprint,
        groups: [
          {
            title: "原有完整分组",
            summary: "原有分组包含全部细节。",
            importance: 5,
            status: "ongoing",
            detailKeys: candidate.episodes.map(
              (episode) => episode.sourceKey,
            ),
          },
        ],
      });
      const original = (
        await store.getMemoryEpisodeArchive(USER_ID, agentId)
      ).majorEvents;

      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: candidate.inputFingerprint,
          groups: [
            {
              title: "不完整的新分组",
              summary: "模型只返回了一条细节。",
              importance: 4,
              status: "uncertain",
              detailKeys: [candidate.episodes[0]!.sourceKey],
            },
          ],
          organizedDetailKeys: candidate.episodes.map(
            (episode) => episode.sourceKey,
          ),
        }),
      ).rejects.toThrow("遗漏了 1 条事件细节");
      expect(
        (await store.getMemoryEpisodeArchive(USER_ID, agentId)).majorEvents,
      ).toEqual(original);
    });
  });

  it("rejects a major event that skips across distant history stages", async () => {
    await withStore(async ({ store, agentId }) => {
      await expect(
        store.saveReconstructedMemoryEpisodes(USER_ID, agentId, {
          sourceMessageCount: 918,
          episodes: [
            {
              sourceKey: "early-stage",
              sourceMessageId: "message-early",
              sourceOrder: 10,
              occurredAt: "2026-01-01T00:00:00.000Z",
              occurrencePrecision: "message",
              title: "早期阶段",
              content: "关系尚处在早期阶段。",
              importance: 4,
            },
            {
              sourceKey: "late-stage",
              sourceMessageId: "message-late",
              sourceOrder: 700,
              occurredAt: "2026-06-01T00:00:00.000Z",
              occurrencePrecision: "message",
              title: "后期阶段",
              content: "很久以后关系进入了新的阶段。",
              importance: 5,
            },
          ],
        }),
      ).resolves.toBe(true);
      const candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );
      await expect(
        store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
          inputFingerprint: candidate.inputFingerprint,
          groups: [
            {
              title: "跨越整段关系史",
              summary: "错误地把相隔很远的两个阶段放在一起。",
              importance: 5,
              status: "ongoing",
              detailKeys: candidate.episodes.map(
                (episode) => episode.sourceKey,
              ),
            },
          ],
          organizedDetailKeys: candidate.episodes.map(
            (episode) => episode.sourceKey,
          ),
        }),
      ).rejects.toThrow("跨越了过多历史阶段");
      expect(
        (await store.getMemoryEpisodeArchive(USER_ID, agentId)).majorEvents,
      ).toEqual([]);
    });
  });

  it("deletes the hierarchy sidecar when memory is cleared", async () => {
    await withStore(async ({ stateDir, store, agentId }) => {
      await replaceReconstructedDetails(store, agentId, [
        {
          sourceKey: "clear-detail",
          title: "待清理细节",
          content: "清空记忆后不应继续存在。",
          importance: 3,
        },
      ]);
      const candidate = await store.getMemoryEpisodeOrganizationCandidate(
        USER_ID,
        agentId,
      );
      await store.saveMemoryEpisodeHierarchy(USER_ID, agentId, {
        inputFingerprint: candidate.inputFingerprint,
        groups: [
          {
            title: "待清理大事件",
            summary: "用于验证层级索引随记忆一起删除。",
            importance: 3,
            status: "uncertain",
            detailKeys: [candidate.episodes[0]!.sourceKey],
          },
        ],
      });
      const sidecar = hierarchySidecarPath(stateDir, agentId);
      await expect(access(sidecar)).resolves.toBeUndefined();

      await store.clearActiveMemory(USER_ID);

      await expect(access(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        store.getMemoryEpisodeArchive(USER_ID, agentId),
      ).resolves.toMatchObject({
        episodes: [],
        majorEvents: [],
        ungroupedEpisodeCount: 0,
      });
    });
  });
});

describe("hierarchical event recall", () => {
  it("uses a major-event title and summary to recall its child detail", () => {
    const detail: AgentMemoryEpisode = {
      id: "detail-id",
      sourceKey: "detail-key",
      title: "确认日期",
      content: "双方把出发日期定在八月十日。",
      importance: 4,
      updatedAt: "2026-07-20T12:00:00.000Z",
    };
    const majorEvent: AgentMemoryMajorEvent = {
      id: "major-id",
      sourceKey: "major-key",
      title: "毕业后的海边旅行",
      summary: "双方正在筹备毕业后的第一次海边旅行。",
      importance: 5,
      status: "ongoing",
      detailKeys: [detail.sourceKey!],
      updatedAt: "2026-07-20T12:00:00.000Z",
    };

    const selected = selectRelevantMemory({
      input: "毕业后的海边旅行准备得怎么样了？",
      episodes: [detail],
      majorEvents: [majorEvent],
    });

    expect(selected.episodes).toEqual([detail]);
  });

  it("injects the owning major event but only the detail matching the prompt", () => {
    const matchingDetail: AgentMemoryEpisode = {
      id: "matching-detail-id",
      sourceKey: "matching-detail-key",
      title: "保管民宿钥匙",
      content: "民宿钥匙暂时放在用户的蓝色背包里。",
      importance: 4,
      updatedAt: "2026-07-20T12:00:00.000Z",
    };
    const unrelatedSibling: AgentMemoryEpisode = {
      id: "sibling-detail-id",
      sourceKey: "sibling-detail-key",
      title: "挑选纪念品",
      content: "双方还讨论过给同学带什么纪念品。",
      importance: 5,
      updatedAt: "2026-07-21T12:00:00.000Z",
    };
    const majorEvent: AgentMemoryMajorEvent = {
      id: "major-trip-id",
      sourceKey: "major-trip-key",
      title: "海边旅行",
      summary: "双方已经完成住宿和交通安排。",
      importance: 5,
      status: "ongoing",
      detailKeys: [
        matchingDetail.sourceKey!,
        unrelatedSibling.sourceKey!,
      ],
      updatedAt: "2026-07-21T12:00:00.000Z",
    };
    const context: AgentExecutionContext = {
      userId: USER_ID,
      agent: {
        id: "agent-1",
        name: "林夏",
        identity: "你是林夏，会保持共同经历的连续性。",
        conversationMode: "wechat",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      memory: [],
      memoryEpisodes: [matchingDetail, unrelatedSibling],
      memoryMajorEvents: [majorEvent],
      input: "民宿钥匙放在哪里？",
    };

    const plan = compilePromptPlan(context);
    const block = plan.blocks.find(
      (candidate) => candidate.id === "memory.episodes",
    );

    expect(block?.content).toContain("海边旅行");
    expect(block?.content).toContain("民宿钥匙暂时放在用户的蓝色背包里");
    expect(block?.content).not.toContain("给同学带什么纪念品");
    expect(block?.sourceRefs).toEqual([
      majorEvent.id,
      matchingDetail.id,
    ]);
  });
});
