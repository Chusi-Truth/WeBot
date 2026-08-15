import { describe, expect, it } from "vitest";

import {
  applyCharacterTemplates,
  exportCharacterCard,
  normalizeAgentImageBehavior,
  parseCharacterCard,
  parseCharacterExamples,
  selectRelevantLore,
} from "../src/character-card.js";

describe("Character Card compatibility", () => {
  it("imports only static image preferences and never enables natural or autonomous sending", () => {
    const parsed = parseCharacterCard({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "安全导入角色",
        description: "验证图片偏好的安全导入。",
        extensions: {
          webot: {
            image_behavior_preferences: {
              mode: "natural",
              allow_autonomous: true,
              cooldown_minutes: 30,
              visual_identity_prompt: "短发，深色外套，纪实摄影风格。",
            },
          },
        },
      },
    });

    expect(parsed.imageBehavior).toEqual({
      mode: "explicit",
      cooldownMinutes: 0,
      allowAutonomous: false,
      visualIdentityPrompt: "短发，深色外套，纪实摄影风格。",
    });

    const exported = exportCharacterCard({
      id: "image-behavior-agent",
      name: parsed.name,
      identity: parsed.identity,
      roleplay: parsed.roleplay,
      imageBehavior: {
        mode: "natural",
        cooldownMinutes: 45,
        allowAutonomous: true,
        visualIdentityPrompt: "长发，浅色衬衫，自然光。",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(exported.data.extensions).toMatchObject({
      webot: {
        image_behavior_preferences: {
          visual_identity_prompt: "长发，浅色衬衫，自然光。",
        },
      },
    });
    expect(JSON.stringify(exported.data.extensions)).not.toContain("natural");
    expect(JSON.stringify(exported.data.extensions)).not.toContain(
      "allow_autonomous",
    );
  });

  it("normalizes image behavior defaults and enforces bounded settings", () => {
    expect(normalizeAgentImageBehavior(undefined)).toEqual({
      mode: "explicit",
      cooldownMinutes: 0,
      allowAutonomous: false,
      visualIdentityPrompt: "",
    });
    expect(normalizeAgentImageBehavior({ cooldownMinutes: 90 })).toMatchObject({
      cooldownMinutes: 0,
    });
    expect(() =>
      normalizeAgentImageBehavior({ cooldownMinutes: 10_081 }),
    ).toThrow("0–10080");
    expect(() =>
      normalizeAgentImageBehavior({
        visualIdentityPrompt: "像".repeat(8_001),
      }),
    ).toThrow("8000");
  });

  it("keeps the local director event out of exported character cards", () => {
    const exported = exportCharacterCard({
      id: "agent-director-private",
      name: "林夏",
      identity: "城市图书馆的夜班管理员。",
      roleplay: {
        directorEvent: {
          enabled: true,
          title: "临海小城",
          premise: "林夏已经接受这次旅行。",
          world: "两人刚抵达车站。",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(JSON.stringify(exported)).not.toContain("directorEvent");
    expect(JSON.stringify(exported)).not.toContain("临海小城");
  });

  it("imports V2 roleplay fields and exports a V3 card", () => {
    const parsed = parseCharacterCard({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "露娜",
        description: "来自月之城的图书管理员。",
        personality: "冷静而好奇",
        scenario: "你们正在一座古老图书馆中。",
        first_mes: "欢迎来到月之图书馆。",
        mes_example: "{{char}}：请轻声说话。",
        system_prompt: "扮演 {{char}}。{{original}}",
        post_history_instructions: "始终保持角色。",
        extensions: {
          agnai: {
            voice: "moon-library",
          },
          webot: {
            roleplay_style_prompt: "细写月光、书页触感和角色的犹豫。",
            writing_style_examples: [
              "月光沿着书脊缓慢移动，她停了片刻才翻开下一页。",
              "雨声压低了房间里的空白，对话因此显得更近。",
            ],
            future_flag: true,
          },
        },
        alternate_greetings: ["今晚想读什么？"],
        tags: ["奇幻"],
        creator: "tester",
        character_version: "1.0",
        character_book: {
          scan_depth: 4,
          token_budget: 100,
          entries: [
            {
              keys: ["月之城"],
              content: "月之城永远处于夜晚。",
              enabled: true,
              insertion_order: 0,
            },
          ],
        },
      },
    });

    expect(parsed).toMatchObject({
      name: "露娜",
      identity: "来自月之城的图书管理员。",
      roleplay: {
        personality: "冷静而好奇",
        stylePrompt: "细写月光、书页触感和角色的犹豫。",
        writingStyleExamples: [
          "月光沿着书脊缓慢移动，她停了片刻才翻开下一页。",
          "雨声压低了房间里的空白，对话因此显得更近。",
        ],
        firstMessage: "欢迎来到月之图书馆。",
        tags: ["奇幻"],
        lorebook: { entries: [{ content: "月之城永远处于夜晚。" }] },
      },
    });

    const exported = exportCharacterCard({
      id: "agent-1",
      name: parsed.name,
      identity: parsed.identity,
      roleplay: parsed.roleplay,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(exported.spec).toBe("chara_card_v3");
    expect(exported.data).toMatchObject({
      name: "露娜",
      first_mes: "欢迎来到月之图书馆。",
      extensions: {
        agnai: {
          voice: "moon-library",
        },
        webot: {
          roleplay_style_prompt: "细写月光、书页触感和角色的犹豫。",
          writing_style_examples: [
            "月光沿着书脊缓慢移动，她停了片刻才翻开下一页。",
            "雨声压低了房间里的空白，对话因此显得更近。",
          ],
          future_flag: true,
        },
      },
      character_book: { entries: [{ keys: ["月之城"] }] },
    });
  });

  it("turns Tavern example dialogue into real user and assistant messages", () => {
    expect(
      parseCharacterExamples(
        '<START>\n{{user}}: "你在等我？"\n{{char}}: "只是顺路。"\n<START>\n{{user}}: "谢谢。"\n{{char}}: "别会错意。"',
        "林夏",
        "阿澈",
      ),
    ).toEqual([
      { role: "user", content: '"你在等我？"' },
      { role: "assistant", content: '"只是顺路。"' },
      { role: "user", content: '"谢谢。"' },
      { role: "assistant", content: '"别会错意。"' },
    ]);
  });

  it("preserves a non-object webot extension while storing the style separately", () => {
    const parsed = parseCharacterCard({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "兼容角色",
        description: "用于验证扩展兼容。",
        extensions: {
          webot: ["第三方占用值"],
          webot_roleplay_style_prompt: "描写潮湿空气和迟疑。",
          webot_writing_style_examples: ["她把伞靠在门边，水珠一路滚到地板。"],
        },
      },
    });
    const exported = exportCharacterCard({
      id: "agent-compatible",
      name: parsed.name,
      identity: parsed.identity,
      roleplay: parsed.roleplay,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(exported.data.extensions).toEqual({
      webot: ["第三方占用值"],
      webot_roleplay_style_prompt: "描写潮湿空气和迟疑。",
      webot_writing_style_examples: ["她把伞靠在门边，水珠一路滚到地板。"],
    });
  });

  it("keeps writing-style samples separate from dialogue examples and removes stale extension copies", () => {
    const parsed = parseCharacterCard({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "写作角色",
        description: "验证独立写作示例。",
        mes_example: "{{user}}: 在吗\n{{char}}: 在。",
        extensions: {
          webot: {
            writing_style_examples: [
              "灯光在杯沿停住，她没有立刻接话。",
            ],
          },
        },
      },
    });

    expect(parsed.roleplay.exampleMessages).toContain("{{user}}");
    expect(parsed.roleplay.writingStyleExamples).toEqual([
      "灯光在杯沿停住，她没有立刻接话。",
    ]);

    const exported = exportCharacterCard({
      id: "writing-agent",
      name: parsed.name,
      identity: parsed.identity,
      roleplay: {
        ...parsed.roleplay,
        writingStyleExamples: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(exported.data.mes_example).toContain("{{user}}");
    expect(exported.data.extensions).not.toHaveProperty(
      "webot.writing_style_examples",
    );

    const canonicalClear = parseCharacterCard({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "已清空示例的角色",
        description: "新版空数组必须覆盖旧版字段。",
        extensions: {
          webot: { writing_style_examples: [] },
          webot_writing_style_examples: ["不应复活的旧示例。"],
        },
      },
    });
    expect(canonicalClear.roleplay.writingStyleExamples).toBeUndefined();
  });

  it("validates writing-style sample count, item length, and total length", () => {
    const card = (examples: string[]) => ({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "边界角色",
        description: "验证示例边界。",
        extensions: { webot: { writing_style_examples: examples } },
      },
    });

    expect(() => parseCharacterCard(card(Array(21).fill("有效示例")))).toThrow(
      "不能超过 20 项",
    );
    expect(() => parseCharacterCard(card(["示".repeat(8_001)]))).toThrow(
      "不能超过 8000 个字符",
    );
    expect(() =>
      parseCharacterCard(card(Array(7).fill("示".repeat(7_000)))),
    ).toThrow("总长度不能超过 48000 个字符");
  });

  it("selects only relevant and constant lore within the budget", () => {
    const entries = selectRelevantLore(
      {
        tokenBudget: 100,
        entries: [
          {
            keys: ["月之城"],
            content: "月之城永远处于夜晚。",
            enabled: true,
            insertionOrder: 0,
          },
          {
            keys: [],
            content: "魔法需要付出代价。",
            enabled: true,
            constant: true,
            insertionOrder: 1,
          },
          {
            keys: ["太阳城"],
            content: "太阳城设定。",
            enabled: true,
            insertionOrder: 2,
          },
        ],
      },
      "请介绍月之城",
      [],
    );
    expect(entries.map((item) => item.content)).toEqual([
      "月之城永远处于夜晚。",
      "魔法需要付出代价。",
    ]);
    expect(applyCharacterTemplates("{{char}} 看着 {{user}}", "露娜")).toBe(
      "露娜 看着 用户",
    );
  });

  it("does not let assistant wording self-trigger domain lore", () => {
    const lorebook = {
      scanDepth: 8,
      entries: [
        {
          keys: ["地图", "路线"],
          content: "音乐背景设定。",
          enabled: true,
          insertionOrder: 0,
        },
        {
          keys: [],
          content: "始终保持关系连续。",
          enabled: true,
          constant: true,
          insertionOrder: 1,
        },
      ],
    };

    expect(
      selectRelevantLore(lorebook, "今天有点累", [
        { role: "assistant", content: "你的情绪像卡住的地图和断掉的路线。" },
        { role: "user", content: "别这么说话。" },
      ]).map((entry) => entry.content),
    ).toEqual(["始终保持关系连续。"]);

    expect(
      selectRelevantLore(lorebook, "那张地图找到了吗？", []).map(
        (entry) => entry.content,
      ),
    ).toEqual(["音乐背景设定。", "始终保持关系连续。"]);
  });

});
