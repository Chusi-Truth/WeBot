import { describe, expect, it } from "vitest";

import type {
  AgentMemoryEpisode,
  AgentMemoryFact,
  AgentMemoryMessage,
} from "../src/agent-types.js";
import { selectRelevantMemory } from "../src/memory-relevance.js";

const NOW = "2026-07-20T12:00:00.000Z";

function fact(
  id: string,
  key: string,
  value: string,
  updatedAt = NOW,
): AgentMemoryFact {
  return { id, key, value, source: "test", updatedAt };
}

function episode(
  id: string,
  title: string,
  content: string,
  importance: 1 | 2 | 3 | 4 | 5,
  updatedAt = NOW,
): AgentMemoryEpisode {
  return { id, title, content, importance, updatedAt };
}

function message(
  role: "user" | "assistant",
  content: string,
): AgentMemoryMessage {
  return { role, content, createdAt: NOW };
}

describe("selectRelevantMemory", () => {
  it("selects Chinese facts and episodes connected to the current topic", () => {
    const result = selectRelevantMemory({
      input: "那份卷宗的编号查到了吗？",
      facts: [
        fact("record", "卷宗编号", "最后两位是 17"),
        fact("drink", "饮品偏好", "喜欢洋甘菊茶"),
      ],
      episodes: [
        episode("shop", "寻找旧卷宗", "两人约好查清卷宗的来源。", 4),
        episode("walk", "雨天散步", "一起沿河散步。", 5),
      ],
    });

    expect(result.facts.map(({ id }) => id)).toEqual(["record"]);
    expect(result.episodes.map(({ id }) => id)).toEqual(["shop"]);
    expect(result.hasRecallCue).toBe(false);
  });

  it("uses an owner-directed event to keep its compressed progress relevant", () => {
    const result = selectRelevantMemory({
      input: "继续。",
      ownerContext: "暴雨夜的酒店调查，当前需要寻找十二楼的脚步声来源。",
      summary: "两人已经从酒店顶层下到十二楼，停在安全门前辨认脚步声。另一天讨论过海边旅行。",
      episodes: [
        episode(
          "hotel",
          "酒店调查",
          "停电后两人抵达十二楼，并听见走廊里有人靠近。",
          4,
        ),
        episode("beach", "海边旅行", "两人在海边度过周末。", 5),
      ],
    });

    expect(result.includeSummary).toBe(true);
    expect(result.summary).toContain("酒店顶层下到十二楼");
    expect(result.summary).not.toContain("海边旅行");
    expect(result.episodes.map(({ id }) => id)).toEqual(["hotel"]);
  });

  it("uses recent user messages for continuity but ignores assistant-introduced topics", () => {
    const result = selectRelevantMemory({
      input: "那个呢？",
      recentMessages: [
        message("user", "我想喝一杯冰咖啡"),
        message("assistant", "好啊，再放一张城市卷宗吧。"),
      ],
      facts: [
        fact("coffee", "咖啡偏好", "冰咖啡不加糖"),
        fact("jazz", "音乐偏好", "喜欢城市旅行"),
      ],
      episodes: [
        episode("cafe", "咖啡店", "用户点过一杯冰咖啡。", 3),
        episode("concert", "爵士演出", "一起听过爵士演出。", 5),
      ],
    });

    expect(result.facts.map(({ id }) => id)).toEqual(["coffee"]);
    expect(result.episodes.map(({ id }) => id)).toEqual(["cafe"]);
  });

  it("matches Latin words case-insensitively", () => {
    const result = selectRelevantMemory({
      input: "Should I order ESPRESSO again?",
      facts: [
        fact("espresso", "Coffee order", "Double espresso, no sugar"),
        fact("tea", "Tea preference", "Earl Grey with milk"),
      ],
      episodes: [],
    });

    expect(result.facts.map(({ id }) => id)).toEqual(["espresso"]);
  });

  it("omits unrelated memory even when it is important or recent", () => {
    const result = selectRelevantMemory({
      input: "今天代码编译通过了。",
      summary: "过去经常讨论旅行和卷宗。",
      facts: [fact("food", "食物偏好", "喜欢番茄意面")],
      episodes: [
        episode("trip", "海边旅行", "两人在海边度过周末。", 5),
      ],
    });

    expect(result).toEqual({
      includeSummary: false,
      summary: "",
      facts: [],
      episodes: [],
      hasRecallCue: false,
    });
  });

  it("retains a small, category-distinct set of safety-critical facts", () => {
    const result = selectRelevantMemory({
      input: "今天天气不错。",
      facts: [
        fact("name", "用户姓名", "小寒"),
        fact("address", "居住地址", "上海"),
        fact("relationship", "双方关系", "恋人"),
        fact("boundary-1", "相处边界", "不要追问家庭创伤"),
        fact("boundary-2", "禁忌", "不要拿身材开玩笑"),
        fact("safe", "安全词", "月亮"),
      ],
    });

    expect(result.facts.map(({ id }) => id)).toEqual(["safe", "boundary-1"]);
  });

  it("lets explicit recall cues retrieve the most important, then most recent episodes", () => {
    const result = selectRelevantMemory({
      input: "还记得上次那件事吗？",
      episodes: [
        episode("old-five", "旧事", "很早以前的重要约定。", 5, "2025-01-01T00:00:00Z"),
        episode("new-five", "近事", "最近的重要约定。", 5, "2026-07-01T00:00:00Z"),
        episode("four", "小事", "普通共同经历。", 4, "2026-07-19T00:00:00Z"),
      ],
    });

    expect(result.hasRecallCue).toBe(true);
    expect(result.episodes.map(({ id }) => id)).toEqual([
      "new-five",
      "old-five",
    ]);
  });

  it("does not let importance alone retrieve an episode without a recall cue", () => {
    const result = selectRelevantMemory({
      input: "晚饭吃什么？",
      episodes: [episode("important", "毕业典礼", "一起参加毕业典礼。", 5)],
    });

    expect(result.episodes).toEqual([]);
  });

  it("includes only summary sentences with direct topic overlap", () => {
    const summary = "两人正在调查一张没有标签的旧卷宗。之前还聊过海边旅行。";

    const relevant = selectRelevantMemory({
      input: "卷宗来源查到了吗？",
      summary,
    });
    expect(relevant.includeSummary).toBe(true);
    expect(relevant.summary).toBe("两人正在调查一张没有标签的旧卷宗。");
    expect(selectRelevantMemory({ input: "今天吃什么？", summary }).includeSummary).toBe(
      false,
    );
    expect(selectRelevantMemory({ input: "之前发生了什么？", summary }).includeSummary).toBe(
      false,
    );
  });

  it("does not carry an old user topic across an explicit topic switch", () => {
    const result = selectRelevantMemory({
      input: "今天代码编译通过了。",
      recentMessages: [message("user", "我的保研材料刚交完")],
      facts: [
        fact("code", "代码进度", "项目已编译通过"),
        fact("admission", "保研进度", "材料已提交"),
      ],
    });

    expect(result.facts.map(({ id }) => id)).toEqual(["code"]);
  });

  it("requires a Chinese word match instead of one shared character", () => {
    const result = selectRelevantMemory({
      input: "今天心情不好。",
      facts: [fact("food", "饮食偏好", "喜欢番茄意面")],
    });

    expect(result.facts).toEqual([]);
  });

  it("does not mistake ordinary uses of ‘之前’ for a recall request", () => {
    const result = selectRelevantMemory({
      input: "吃饭之前要不要洗手？",
      summary: "两人去过海边旅行。",
      episodes: [episode("graduation", "毕业典礼", "一起参加毕业典礼。", 5)],
    });

    expect(result.hasRecallCue).toBe(false);
    expect(result.includeSummary).toBe(false);
    expect(result.episodes).toEqual([]);
  });

  it("uses recent user text, but not assistant text, when deciding on a summary", () => {
    const summary = "用户喜欢收集旧卷宗。";

    expect(
      selectRelevantMemory({
        input: "接着说。",
        summary,
        recentMessages: [
          message("user", "那份旧卷宗是哪一年的？"),
          message("assistant", "顺便聊聊晚饭。"),
        ],
      }).includeSummary,
    ).toBe(true);
    expect(
      selectRelevantMemory({
        input: "接着说。",
        summary,
        recentMessages: [message("assistant", "我在找一张旧卷宗。")],
      }).includeSummary,
    ).toBe(false);
  });

  it("applies the default caps of five facts and two episodes", () => {
    const result = selectRelevantMemory({
      input: "卷宗",
      facts: Array.from({ length: 7 }, (_, index) =>
        fact(`fact-${index}`, `卷宗 ${index}`, `第 ${index} 份卷宗`),
      ),
      episodes: Array.from({ length: 3 }, (_, index) =>
        episode(
          `episode-${index}`,
          `卷宗 ${index}`,
          `一起找过第 ${index} 份卷宗。`,
          3,
        ),
      ),
    });

    expect(result.facts).toHaveLength(5);
    expect(result.episodes).toHaveLength(2);
  });

  it("honors custom caps, including zero", () => {
    const facts = [
      fact("safe", "安全词", "月亮"),
      fact("one", "卷宗一", "卷宗内容"),
      fact("two", "卷宗二", "卷宗内容"),
    ];
    const episodes = [
      episode("one", "卷宗一", "第一份卷宗。", 4),
      episode("two", "卷宗二", "第二张卷宗。", 3),
    ];

    const capped = selectRelevantMemory({
      input: "卷宗",
      facts,
      episodes,
      factLimit: 2,
      episodeLimit: 1,
    });
    expect(capped.facts).toHaveLength(2);
    expect(capped.episodes).toHaveLength(1);

    const empty = selectRelevantMemory({
      input: "卷宗",
      facts,
      episodes,
      factLimit: 0,
      episodeLimit: 0,
    });
    expect(empty.facts).toEqual([]);
    expect(empty.episodes).toEqual([]);

    const ignoresRecentUsers = selectRelevantMemory({
      input: "继续。",
      recentMessages: [message("user", "卷宗")],
      facts,
      recentUserMessageLimit: 0,
      criticalFactLimit: 0,
    });
    expect(ignoresRecentUsers.facts).toEqual([]);
  });

  it("breaks relevance ties deterministically by recency and source order", () => {
    const result = selectRelevantMemory({
      input: "猫",
      facts: [
        fact("old", "宠物", "猫", "2025-01-01T00:00:00Z"),
        fact("new-first", "动物", "猫", "2026-01-01T00:00:00Z"),
        fact("new-second", "动物", "猫", "2026-01-01T00:00:00Z"),
      ],
      factLimit: 3,
    });

    expect(result.facts.map(({ id }) => id)).toEqual([
      "new-first",
      "new-second",
      "old",
    ]);
  });
});
