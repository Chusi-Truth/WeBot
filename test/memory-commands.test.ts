import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentFramework } from "../src/agent-framework.js";
import { AgentStore } from "../src/agent-store.js";

const USER_ID = "alice@im.wechat";

async function createHarness() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-memory-command-"));
  const store = new AgentStore({
    stateDir,
    maxMemoryMessages: 4,
    retainRecentMessages: 2,
  });
  const framework = new AgentFramework({
    store,
    executor: ({ input }) => `回复：${input}`,
  });
  const agent = await store.getActiveAgent(USER_ID);
  return { framework, store, agent };
}

async function appendTurns(
  store: AgentStore,
  agentId: string,
  turns: ReadonlyArray<{ input: string; replies: readonly string[] }>,
) {
  for (const turn of turns) {
    await store.appendTurn(USER_ID, agentId, turn);
  }
}

async function curateMemory(
  store: AgentStore,
  agentId: string,
  result: Parameters<AgentStore["applyMemoryCompression"]>[3],
) {
  const candidate = await store.prepareMemoryCompression(USER_ID, agentId);
  expect(candidate).not.toBeNull();
  await expect(
    store.applyMemoryCompression(USER_ID, agentId, candidate!, result),
  ).resolves.toBe(true);
}

async function runMemoryCommand(
  framework: AgentFramework,
  command: string,
  userId = USER_ID,
): Promise<string> {
  const output = await framework.handle(userId, command);
  if (typeof output !== "string") {
    throw new Error(`记忆指令应返回纯文本响应：${command}`);
  }
  return output;
}

function pageCount(output: string): number {
  const match = output.match(/第\s*\d+\s*\/\s*(\d+)\s*页/);
  expect(match, `响应没有可解析的分页信息：\n${output}`).not.toBeNull();
  return Number(match?.[1]);
}

describe("WeChat /memory commands", () => {
  it("shows a complete overview while preserving numeric working-window lookup", async () => {
    const { framework, store, agent } = await createHarness();
    await appendTurns(store, agent.id, [
      { input: "最早归档内容", replies: ["最早归档回复"] },
      { input: "第二轮归档内容", replies: ["第二轮归档回复"] },
      { input: "第三轮归档内容", replies: ["第三轮归档回复"] },
      { input: "当前工作窗口内容", replies: ["当前工作窗口回复"] },
    ]);
    await curateMemory(store, agent.id, {
      summary: "用户和 Agent 约定周末一起去天文馆。",
      facts: [{ key: "兴趣", value: "天文学" }],
      episodes: [
        {
          title: "天文馆约定",
          content: "两人约定周末一起去天文馆。",
          importance: 5,
        },
      ],
    });

    const overview = await runMemoryCommand(framework, "/memory show");
    expect(overview).toContain("记忆总览");
    expect(overview).toContain("完整聊天：8 条");
    expect(overview).toContain("长期摘要");
    expect(overview).toContain("周末一起去天文馆");
    expect(overview).toContain("长期事实");
    expect(overview).toContain("天文学");
    expect(overview).toContain("关键经历");
    expect(overview).toContain("天文馆约定");
    expect(overview).toContain("当前工作窗口内容");

    const recent = await runMemoryCommand(framework, "/memory show 2");
    expect(recent).toContain("工作窗口");
    expect(recent).toContain("当前工作窗口内容");
    expect(recent).toContain("当前工作窗口回复");
    expect(recent).not.toContain("最早归档内容");
    expect(recent).not.toContain("天文馆约定");
    expect(recent).toContain("/memory history 1");
  });

  it("pages the full JSONL history newest-first without reversing or splitting turns", async () => {
    const { framework, store, agent } = await createHarness();
    await appendTurns(store, agent.id, [
      { input: "第一轮问题", replies: ["第一轮回答"] },
      {
        input: "第二轮多气泡问题",
        replies: [
          "第二轮气泡一",
          "第二轮气泡二",
          "第二轮气泡三",
          "第二轮气泡四",
        ],
      },
      { input: "第三轮问题", replies: ["第三轮回答"] },
      { input: "第四轮问题", replies: ["第四轮回答"] },
      { input: "第五轮问题", replies: ["第五轮回答"] },
      { input: "第六轮问题", replies: ["第六轮回答"] },
    ]);
    await curateMemory(store, agent.id, {
      summary: "前五轮已经归档。",
      facts: [],
      episodes: [],
    });
    expect((await store.getMemory(USER_ID, agent.id)).length).toBeLessThan(
      (await store.getHistory(USER_ID, agent.id)).length,
    );

    const newestPage = await runMemoryCommand(
      framework,
      "/memory history 1",
    );
    expect(newestPage).toContain("第 1/2 页");
    expect(newestPage).not.toContain("第一轮问题");
    expect(newestPage).toContain("第二轮多气泡问题");
    for (const suffix of ["一", "二", "三", "四"]) {
      expect(newestPage).toContain(`第二轮气泡${suffix}`);
    }
    expect(newestPage.indexOf("第二轮多气泡问题")).toBeLessThan(
      newestPage.indexOf("第二轮气泡一"),
    );
    expect(newestPage.indexOf("第二轮气泡四")).toBeLessThan(
      newestPage.indexOf("第三轮问题"),
    );
    expect(newestPage.indexOf("第五轮问题")).toBeLessThan(
      newestPage.indexOf("第六轮问题"),
    );

    const olderPage = await runMemoryCommand(
      framework,
      "/memory history 2",
    );
    expect(olderPage).toContain("第 2/2 页");
    expect(olderPage).toContain("第一轮问题");
    expect(olderPage).toContain("第一轮回答");
    expect(olderPage).not.toContain("第二轮多气泡问题");
    expect(olderPage).not.toContain("第六轮问题");
  });

  it("links long history previews to a naturally paged full turn", async () => {
    const { framework, store, agent } = await createHarness();
    await appendTurns(store, agent.id, [
      {
        input: `长轮开头标记${"甲".repeat(4_000)}`,
        replies: [`${"乙".repeat(4_000)}长轮结尾标记`],
      },
    ]);

    const history = await runMemoryCommand(framework, "/memory history 1");
    expect(history).toContain("第 1 轮");
    expect(history).toContain("/memory turn 1 1");
    expect(history).toContain("长轮开头标记");
    expect(history).not.toContain("长轮结尾标记");

    const first = await runMemoryCommand(framework, "/memory turn 1 1");
    expect(first).toContain("长轮开头标记");
    expect(first).not.toContain("长轮结尾标记");
    const totalPages = pageCount(first);
    expect(totalPages).toBeGreaterThan(1);

    const last = await runMemoryCommand(
      framework,
      `/memory turn 1 ${totalPages}`,
    );
    expect(last).toContain(`第 ${totalPages}/${totalPages} 页`);
    expect(last).toContain("长轮结尾标记");
    expect(last).not.toContain("长轮开头标记");
  });

  it("paginates the full summary in natural reading order", async () => {
    const { framework, store, agent } = await createHarness();
    await appendTurns(store, agent.id, [
      { input: "用于生成摘要的一", replies: ["回答一"] },
      { input: "用于生成摘要的二", replies: ["回答二"] },
      { input: "用于生成摘要的三", replies: ["回答三"] },
    ]);
    const summary =
      `摘要开头标记\n${"甲".repeat(3_900)}\n` +
      `${"乙".repeat(3_900)}\n摘要结尾标记`;
    await curateMemory(store, agent.id, {
      summary,
      facts: [],
      episodes: [],
    });

    const first = await runMemoryCommand(framework, "/memory summary 1");
    expect(first).toContain("摘要开头标记");
    expect(first).not.toContain("摘要结尾标记");
    const totalPages = pageCount(first);
    expect(totalPages).toBeGreaterThan(1);

    const last = await runMemoryCommand(
      framework,
      `/memory summary ${totalPages}`,
    );
    expect(last).toContain(`第 ${totalPages}/${totalPages} 页`);
    expect(last).toContain("摘要结尾标记");
    expect(last).not.toContain("摘要开头标记");
  });

  it("pages facts in stored order and episodes in importance order", async () => {
    const { framework, store, agent } = await createHarness();
    await appendTurns(store, agent.id, [
      { input: "用于压缩的一", replies: ["回答一"] },
      { input: "用于压缩的二", replies: ["回答二"] },
      { input: "用于压缩的三", replies: ["回答三"] },
    ]);
    await curateMemory(store, agent.id, {
      summary: "有结构化长期记忆。",
      facts: Array.from({ length: 7 }, (_, index) => ({
        key: `事实键${index + 1}`,
        value: `事实值${index + 1}`,
      })),
      episodes: [
        { title: "经历一星", content: "一星内容", importance: 1 },
        {
          title: "经历五星",
          content: `五星开头${"五".repeat(970)}五星尾标`,
          importance: 5,
        },
        { title: "经历二星", content: "二星内容", importance: 2 },
        {
          title: "经历四星",
          content: `四星开头${"四".repeat(970)}四星尾标`,
          importance: 4,
        },
        { title: "经历三星", content: "三星内容", importance: 3 },
      ],
    });

    const factsPage1 = await runMemoryCommand(framework, "/memory facts 1");
    expect(factsPage1).toContain("第 1/2 页");
    expect(factsPage1).toContain("事实键1");
    expect(factsPage1).toContain("事实键5");
    expect(factsPage1).not.toContain("事实键6");
    const factsPage2 = await runMemoryCommand(framework, "/memory facts 2");
    expect(factsPage2).toContain("事实键6");
    expect(factsPage2).toContain("事实键7");
    expect(factsPage2).not.toContain("事实键1");

    const episodesPage1 = await runMemoryCommand(
      framework,
      "/memory episodes 1",
    );
    expect(episodesPage1).toContain("第 1/3 页");
    expect(episodesPage1.indexOf("经历五星")).toBeLessThan(
      episodesPage1.indexOf("经历四星"),
    );
    expect(episodesPage1).toContain("五星尾标");
    expect(episodesPage1).toContain("四星尾标");
    expect(episodesPage1).not.toContain("经历三星");
    expect(episodesPage1).not.toContain("经历二星");
    const episodesPage2 = await runMemoryCommand(
      framework,
      "/memory episodes 2",
    );
    expect(episodesPage2).toContain("第 2/3 页");
    expect(episodesPage2).toContain("经历三星");
    expect(episodesPage2).toContain("经历二星");
    expect(episodesPage2).not.toContain("经历一星");
    expect(episodesPage2).not.toContain("经历五星");
    const episodesPage3 = await runMemoryCommand(
      framework,
      "/memory episodes 3",
    );
    expect(episodesPage3).toContain("第 3/3 页");
    expect(episodesPage3).toContain("经历一星");
    expect(episodesPage3).not.toContain("经历二星");
  });

  it("handles empty and invalid pages without exposing an internal failure", async () => {
    const { framework } = await createHarness();

    for (const command of [
      "/memory show",
      "/memory history 1",
      "/memory summary 1",
      "/memory facts 1",
      "/memory episodes 1",
    ]) {
      const output = await runMemoryCommand(framework, command);
      expect(output).toMatch(/没有|为空|尚未/);
      expect(output).not.toContain("操作失败");
    }

    for (const command of [
      "/memory history 0",
      "/memory history abc",
      "/memory summary -1",
      "/memory facts 1.5",
      "/memory episodes 99",
    ]) {
      const output = await runMemoryCommand(framework, command);
      expect(output).toContain("页");
      expect(output).not.toContain("NaN");
      expect(output).not.toContain("TypeError");
    }
  });

  it("clears only the active Agent's browsable archive", async () => {
    const { framework, store, agent: firstAgent } = await createHarness();
    await appendTurns(store, firstAgent.id, [
      { input: "默认助手的私有记忆", replies: ["默认助手回答"] },
    ]);
    const secondAgent = await store.createAgent(USER_ID, {
      name: "第二助手",
      identity: "用于隔离测试。",
    });
    await appendTurns(store, secondAgent.id, [
      { input: "第二助手的私有记忆", replies: ["第二助手回答"] },
    ]);

    const secondHistory = await runMemoryCommand(
      framework,
      "/memory history 1",
    );
    expect(secondHistory).toContain("第二助手的私有记忆");
    expect(secondHistory).not.toContain("默认助手的私有记忆");
    await expect(framework.handle(USER_ID, "/memory clear")).resolves.toContain(
      "已清空",
    );
    expect(await runMemoryCommand(framework, "/memory history 1")).toMatch(
      /没有|为空/,
    );

    await store.switchAgentById(USER_ID, firstAgent.id);
    const firstHistory = await runMemoryCommand(
      framework,
      "/memory history 1",
    );
    expect(firstHistory).toContain("默认助手的私有记忆");
    expect(firstHistory).not.toContain("第二助手的私有记忆");
  });

  it("keeps command-level memory access isolated between users", async () => {
    const { framework, store, agent: aliceAgent } = await createHarness();
    const bobId = "bob@im.wechat";
    const bobAgent = await store.getActiveAgent(bobId);
    await appendTurns(store, aliceAgent.id, [
      { input: "Alice 的独有记忆", replies: ["Alice 的回答"] },
    ]);
    await store.appendTurn(bobId, bobAgent.id, {
      input: "Bob 的独有记忆",
      replies: ["Bob 的回答"],
    });

    const aliceHistory = await runMemoryCommand(
      framework,
      "/memory history 1",
    );
    expect(aliceHistory).toContain("Alice 的独有记忆");
    expect(aliceHistory).not.toContain("Bob 的独有记忆");

    const bobHistory = await runMemoryCommand(
      framework,
      "/memory history 1",
      bobId,
    );
    expect(bobHistory).toContain("Bob 的独有记忆");
    expect(bobHistory).not.toContain("Alice 的独有记忆");

    await runMemoryCommand(framework, "/memory clear");
    expect(await runMemoryCommand(framework, "/memory history 1")).toMatch(
      /没有|为空/,
    );
    expect(
      await runMemoryCommand(framework, "/memory history 1", bobId),
    ).toContain("Bob 的独有记忆");
  });
});
