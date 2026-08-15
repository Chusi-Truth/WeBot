import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentStore } from "../src/agent-store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("AgentStore outbound delivery locking", () => {
  it("does not hold the Agent lock while the send callback is in flight", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-store-outbound-lock-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "alice@im.wechat";
      const agent = await store.getActiveAgent(userId);
      const sendEntered = deferred();
      const releaseSend = deferred();
      const events: string[] = [];

      const delivery = store.deliverOutboundMessage(
        userId,
        agent.id,
        "定时主动消息",
        async (finalizeDelivery) => {
          events.push("send:start");
          sendEntered.resolve();
          await releaseSend.promise;
          events.push("send:end");
          await finalizeDelivery();
          events.push("outbound:committed");
        },
      );
      await sendEntered.promise;

      const turn = store.appendTurn(userId, agent.id, {
        input: "发送期间收到的聊天",
        reply: "聊天回复",
      }).then((result) => {
        events.push("turn:committed");
        return result;
      });
      let timer: NodeJS.Timeout | undefined;
      const turnOutcome = await Promise.race([
        turn.then(() => "turn-complete" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 1_000);
        }),
      ]);
      if (timer) clearTimeout(timer);

      // Always release the fake network request before asserting so a
      // regression fails cleanly instead of leaving the test deadlocked.
      releaseSend.resolve();
      const [, turnPersisted] = await Promise.all([delivery, turn]);

      expect(turnOutcome).toBe("turn-complete");
      expect(turnPersisted).toBe(true);
      expect(events).toEqual([
        "send:start",
        "turn:committed",
        "send:end",
        "outbound:committed",
      ]);

      const memory = await store.getMemoryContext(userId, agent.id);
      expect(memory.messages.map((message) => message.content)).toEqual([
        "发送期间收到的聊天",
        "聊天回复",
        "定时主动消息",
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("AgentStore registry concurrency", () => {
  it("reloads the registry after a target delivery lease before deleting only that Agent", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-store-stale-registry-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "alice@im.wechat";
      const original = await store.getActiveAgent(userId);
      const target = await store.createAgent(userId, {
        name: "等待删除",
        identity: "这个 Agent 将在投递结束后删除。",
      });
      const keeper = await store.createAgent(userId, {
        name: "保留角色",
        identity: "这个 Agent 的并发修改必须保留。",
      });
      const sendEntered = deferred();
      const releaseSend = deferred();

      const delivery = store.deliverOutboundMessage(
        userId,
        target.id,
        "发送中的主动消息",
        async (finalizeDelivery) => {
          sendEntered.resolve();
          await releaseSend.promise;
          await finalizeDelivery();
        },
      );
      await sendEntered.promise;

      // deleteAgentById must wait for the target's delivery lease. Registry
      // mutations below happen while deletion is queued behind that lease.
      const deletion = store.deleteAgentById(userId, target.id);
      let createdDuringWait;
      try {
        createdDuringWait = await store.createAgent(userId, {
          name: "等待期间新建",
          identity: "删除等待期间创建，不能被旧 registry 覆盖。",
        });
        await store.updateAgentById(userId, keeper.id, {
          name: "等待期间重命名",
          identity: keeper.identity,
        });
        await store.switchAgentById(userId, keeper.id);
      } finally {
        releaseSend.resolve();
      }

      await Promise.all([delivery, deletion]);

      const registry = await store.getRegistry(userId);
      expect(registry.agents.map((agent) => agent.id)).toEqual(
        expect.arrayContaining([
          original.id,
          keeper.id,
          createdDuringWait.id,
        ]),
      );
      expect(registry.agents).toHaveLength(3);
      expect(
        registry.agents.some((agent) => agent.id === target.id),
      ).toBe(false);
      expect(
        registry.agents.find((agent) => agent.id === keeper.id),
      ).toMatchObject({
        name: "等待期间重命名",
        identity: keeper.identity,
      });
      expect(
        registry.agents.find((agent) => agent.id === createdDuringWait.id),
      ).toMatchObject({
        name: "等待期间新建",
        identity: "删除等待期间创建，不能被旧 registry 覆盖。",
      });
      expect(registry.activeAgentId).toBe(keeper.id);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("AgentStore roleplay style isolation", () => {
  it("persists a separate roleplay style prompt for every Agent without touching memory", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-style-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "alice@im.wechat";
      const first = await store.createAgent(userId, {
        name: "沉静角色",
        identity: "保持沉静。",
        roleplay: {
          personality: "克制",
          stylePrompt: "细写雨声和停顿。",
          writingStyleExamples: [
            "雨落在窗沿，她等那阵声音过去才继续说。",
          ],
          characterCardExtensions: {
            agnai: { voice: "quiet-rain" },
          },
        },
        conversationMode: "roleplay",
      });
      const second = await store.createAgent(userId, {
        name: "明快角色",
        identity: "保持明快。",
        roleplay: {
          personality: "坦率",
          stylePrompt: "使用明快短句。",
          writingStyleExamples: ["她笑了一声，话已经先一步说完。"],
        },
        conversationMode: "roleplay",
      });
      await store.appendTurn(userId, first.id, {
        input: "记住这一句",
        reply: "已经记住。",
      });

      await store.updateAgentById(userId, second.id, {
        name: second.name,
        identity: second.identity,
        roleplay: {
          ...second.roleplay,
          stylePrompt: "使用明快短句，并减少环境描写。",
        },
        conversationMode: "roleplay",
      });
      // Older clients that do not know the dedicated style fields must not
      // erase them while updating another roleplay field.
      const updatedFirst = await store.updateAgentById(userId, first.id, {
        name: first.name,
        identity: first.identity,
        roleplay: {
          personality: "克制但敏锐",
        },
        conversationMode: "roleplay",
        expectedUpdatedAt: first.updatedAt,
      });
      expect(Date.parse(updatedFirst.updatedAt)).toBeGreaterThan(
        Date.parse(first.updatedAt),
      );
      await expect(
        store.updateAgentById(userId, first.id, {
          name: "陈旧页面写入",
          identity: first.identity,
          roleplay: {
            personality: "不应覆盖",
            stylePrompt: "不应覆盖",
          },
          conversationMode: "roleplay",
          expectedUpdatedAt: first.updatedAt,
        }),
      ).rejects.toThrow("人物设定已被其他会话更新");
      const compatibleFirst = await store.updateAgentById(userId, first.id, {
        name: first.name,
        identity: first.identity,
        conversationMode: "roleplay",
        expectedUpdatedAt: updatedFirst.updatedAt,
      });
      expect(compatibleFirst.roleplay).toMatchObject({
        personality: "克制但敏锐",
        stylePrompt: "细写雨声和停顿。",
        writingStyleExamples: [
          "雨落在窗沿，她等那阵声音过去才继续说。",
        ],
        characterCardExtensions: {
          agnai: { voice: "quiet-rain" },
        },
      });

      const reloaded = new AgentStore({ stateDir });
      const registry = await reloaded.getRegistry(userId);
      expect(
        registry.agents.find((agent) => agent.id === first.id)?.roleplay,
      ).toMatchObject({
        personality: "克制但敏锐",
        stylePrompt: "细写雨声和停顿。",
        writingStyleExamples: [
          "雨落在窗沿，她等那阵声音过去才继续说。",
        ],
        characterCardExtensions: {
          agnai: { voice: "quiet-rain" },
        },
      });
      expect(
        registry.agents.find((agent) => agent.id === second.id)?.roleplay,
      ).toMatchObject({
        personality: "坦率",
        stylePrompt: "使用明快短句，并减少环境描写。",
        writingStyleExamples: ["她笑了一声，话已经先一步说完。"],
      });
      expect(
        (await reloaded.getMemoryContext(userId, first.id)).messages.map(
          (message) => message.content,
        ),
      ).toEqual(["记住这一句", "已经记住。"]);

      const cleared = await reloaded.updateAgentById(userId, first.id, {
        name: compatibleFirst.name,
        identity: compatibleFirst.identity,
        roleplay: {
          ...compatibleFirst.roleplay,
          writingStyleExamples: [],
        },
        conversationMode: "roleplay",
        expectedUpdatedAt: compatibleFirst.updatedAt,
      });
      expect(cleared.roleplay?.writingStyleExamples).toBeUndefined();
      expect(cleared.roleplay?.stylePrompt).toBe("细写雨声和停顿。");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent save from the same profile version", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-style-cas-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "concurrent@im.wechat";
      const current = await store.createAgent(userId, {
        name: "并发角色",
        identity: "初始身份",
        roleplay: { stylePrompt: "初始文风" },
        conversationMode: "roleplay",
      });
      const results = await Promise.allSettled([
        store.updateAgentById(userId, current.id, {
          name: current.name,
          identity: current.identity,
          roleplay: { stylePrompt: "第一份文风" },
          conversationMode: "roleplay",
          expectedUpdatedAt: current.updatedAt,
        }),
        store.updateAgentById(userId, current.id, {
          name: current.name,
          identity: current.identity,
          roleplay: { stylePrompt: "第二份文风" },
          conversationMode: "roleplay",
          expectedUpdatedAt: current.updatedAt,
        }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: expect.objectContaining({
          message: expect.stringContaining("已被其他会话更新"),
        }),
      });
      const saved = (await store.getRegistry(userId)).agents.find(
        (agent) => agent.id === current.id,
      );
      expect(["第一份文风", "第二份文风"]).toContain(
        saved?.roleplay?.stylePrompt,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("serializes console style saves with chat-side profile updates", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-style-registry-lock-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "cross-channel@im.wechat";
      const current = await store.createAgent(userId, {
        name: "跨端角色",
        identity: "初始身份",
        roleplay: { stylePrompt: "初始文风" },
        conversationMode: "roleplay",
      });

      const [styleSave, identitySave] = await Promise.all([
        store.updateAgentById(userId, current.id, {
          name: current.name,
          identity: current.identity,
          roleplay: { stylePrompt: "控制台新文风" },
          conversationMode: "roleplay",
          expectedUpdatedAt: current.updatedAt,
        }),
        store.updateActiveIdentity(userId, "聊天侧新身份"),
      ]);

      expect(styleSave.roleplay?.stylePrompt).toBe("控制台新文风");
      expect(identitySave.identity).toBe("聊天侧新身份");
      const saved = (await store.getRegistry(userId)).agents.find(
        (agent) => agent.id === current.id,
      );
      expect(saved).toMatchObject({
        identity: "聊天侧新身份",
        roleplay: { stylePrompt: "控制台新文风" },
      });

      const beforeModeChange = await store.getActiveAgent(userId);
      await Promise.all([
        store.updateAgentById(userId, current.id, {
          name: beforeModeChange.name,
          identity: beforeModeChange.identity,
          roleplay: { stylePrompt: "切模式前保存的新文风" },
          conversationMode: "roleplay",
          expectedUpdatedAt: beforeModeChange.updatedAt,
        }),
        store.setActiveConversationMode(userId, "wechat"),
      ]);
      expect(await store.getActiveAgent(userId)).toMatchObject({
        identity: "聊天侧新身份",
        conversationMode: "wechat",
        roleplay: { stylePrompt: "切模式前保存的新文风" },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("AgentStore director event persistence", () => {
  it("saves and clears a complete event per Agent while preserving memory and legacy omitted fields", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-director-event-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "director@im.wechat";
      const first = await store.createAgent(userId, {
        name: "第一角色",
        identity: "第一角色身份",
        roleplay: {
          personality: "谨慎",
          stylePrompt: "使用克制的限知叙述。",
          directorEvent: {
            enabled: true,
            title: "旧事件",
            premise: "第一角色仍在旧地点。",
            world: "旧世界约束。",
          },
        },
        conversationMode: "roleplay",
      });
      const second = await store.createAgent(userId, {
        name: "第二角色",
        identity: "第二角色身份",
        roleplay: {
          directorEvent: {
            enabled: true,
            title: "第二角色的独立事件",
            premise: "第二角色正在车站等车。",
            world: "末班车尚未到站。",
          },
        },
        conversationMode: "roleplay",
      });
      await store.appendTurn(userId, first.id, {
        input: "这是保存事件前的对话",
        reply: "这段记忆不能被事件编辑改动。",
      });

      const saved = await store.updateDirectorEventByAgentId(
        userId,
        first.id,
        {
          enabled: true,
          title: "暴雨夜的临时同盟",
          premise: "第一角色与用户已经抵达酒店十二楼。",
          world: "电梯停运，楼梯间仍可通行。",
        },
        first.updatedAt,
      );
      expect(saved.roleplay?.directorEvent).toEqual({
        enabled: true,
        title: "暴雨夜的临时同盟",
        premise: "第一角色与用户已经抵达酒店十二楼。",
        world: "电梯停运，楼梯间仍可通行。",
      });
      expect(saved.roleplay?.stylePrompt).toBe("使用克制的限知叙述。");
      expect(Date.parse(saved.updatedAt)).toBeGreaterThan(
        Date.parse(first.updatedAt),
      );

      const reloaded = new AgentStore({ stateDir });
      const persisted = (await reloaded.getRegistry(userId)).agents;
      expect(
        persisted.find((agent) => agent.id === first.id)?.roleplay
          ?.directorEvent,
      ).toEqual(saved.roleplay?.directorEvent);
      expect(
        persisted.find((agent) => agent.id === second.id)?.roleplay
          ?.directorEvent,
      ).toEqual({
        enabled: true,
        title: "第二角色的独立事件",
        premise: "第二角色正在车站等车。",
        world: "末班车尚未到站。",
      });
      expect(
        (await reloaded.getMemoryContext(userId, first.id)).messages.map(
          (message) => message.content,
        ),
      ).toEqual([
        "这是保存事件前的对话",
        "这段记忆不能被事件编辑改动。",
      ]);

      // A profile save from a client that predates director events must not
      // silently erase the current event when that field is omitted.
      const legacySaved = await reloaded.updateAgentById(userId, first.id, {
        name: saved.name,
        identity: saved.identity,
        roleplay: {
          personality: "谨慎但愿意合作",
        },
        conversationMode: "roleplay",
        expectedUpdatedAt: saved.updatedAt,
      });
      expect(legacySaved.roleplay).toMatchObject({
        personality: "谨慎但愿意合作",
        stylePrompt: "使用克制的限知叙述。",
        directorEvent: saved.roleplay?.directorEvent,
      });

      const cleared = await reloaded.updateDirectorEventByAgentId(
        userId,
        first.id,
        null,
        legacySaved.updatedAt,
      );
      expect(cleared.roleplay?.directorEvent).toBeUndefined();
      expect(cleared.roleplay).toMatchObject({
        personality: "谨慎但愿意合作",
        stylePrompt: "使用克制的限知叙述。",
      });
      expect(
        (await reloaded.getMemoryContext(userId, first.id)).messages.map(
          (message) => message.content,
        ),
      ).toEqual([
        "这是保存事件前的对话",
        "这段记忆不能被事件编辑改动。",
      ]);
      expect(
        (await reloaded.getRegistry(userId)).agents.find(
          (agent) => agent.id === second.id,
        )?.roleplay?.directorEvent,
      ).toEqual({
        enabled: true,
        title: "第二角色的独立事件",
        premise: "第二角色正在车站等车。",
        world: "末班车尚未到站。",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("allows only one director-event save from the same profile version", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-director-event-cas-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "director-cas@im.wechat";
      const current = await store.createAgent(userId, {
        name: "并发角色",
        identity: "并发角色身份",
        roleplay: {
          directorEvent: {
            enabled: true,
            title: "初始事件",
            premise: "角色已经进入初始事件。",
            world: "初始规则。",
          },
        },
        conversationMode: "roleplay",
      });
      await store.appendTurn(userId, current.id, {
        input: "并发保存前的消息",
        reply: "记忆应保持不变。",
      });
      const firstEvent = {
        enabled: true,
        title: "第一份事件",
        premise: "角色已经进入第一份事件。",
        world: "第一份世界规则。",
      } as const;
      const secondEvent = {
        enabled: true,
        title: "第二份事件",
        premise: "角色已经进入第二份事件。",
        world: "第二份世界规则。",
      } as const;

      const results = await Promise.allSettled([
        store.updateDirectorEventByAgentId(
          userId,
          current.id,
          firstEvent,
          current.updatedAt,
        ),
        store.updateDirectorEventByAgentId(
          userId,
          current.id,
          secondEvent,
          current.updatedAt,
        ),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: expect.objectContaining({
          message: expect.stringContaining("已被其他会话更新"),
        }),
      });
      const saved = (await store.getRegistry(userId)).agents.find(
        (agent) => agent.id === current.id,
      );
      expect([firstEvent, secondEvent]).toContainEqual(
        saved?.roleplay?.directorEvent,
      );
      expect(
        (await store.getMemoryContext(userId, current.id)).messages.map(
          (message) => message.content,
        ),
      ).toEqual(["并发保存前的消息", "记忆应保持不变。"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("AgentStore private story books", () => {
  it("stores multiple complete stories per Agent without changing profile or memory", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-story-book-"));
    try {
      const store = new AgentStore({ stateDir });
      const userId = "writer@im.wechat";
      const first = await store.createAgent(userId, {
        name: "第一作者",
        identity: "故事人物一",
      });
      const second = await store.createAgent(userId, {
        name: "第二作者",
        identity: "故事人物二",
      });
      await store.appendTurn(userId, first.id, {
        input: "聊天记忆",
        reply: "不能被故事书覆盖",
      });
      const empty = await store.getStoryBook(userId, first.id);
      const one = await store.saveStoryBookEntry(
        userId,
        first.id,
        {
          title: "雨夜",
          premise: "两人在末班车上重逢。",
          content: "车窗上的雨一路向后退。故事在到站时完整结束。",
        },
        empty.updatedAt,
      );
      const firstStory = one.stories[0]!;
      const two = await store.saveStoryBookEntry(
        userId,
        first.id,
        {
          title: "海边",
          premise: "一个独自旅行的清晨。",
          content: "潮水退去以后，她带着答案离开海滩。",
        },
        one.updatedAt,
      );
      expect(two.stories).toHaveLength(2);
      const updated = await store.saveStoryBookEntry(
        userId,
        first.id,
        {
          id: firstStory.id,
          title: "雨夜重逢",
          premise: firstStory.premise,
          content: `${firstStory.content}\n他们没有错过最后一次告别。`,
        },
        two.updatedAt,
      );
      expect(updated.stories.find((story) => story.id === firstStory.id))
        .toMatchObject({
          title: "雨夜重逢",
          createdAt: firstStory.createdAt,
        });
      expect((await store.getStoryBook(userId, second.id)).stories).toEqual([]);
      expect((await store.getRegistry(userId)).agents.find((agent) => agent.id === first.id))
        .toMatchObject({ identity: "故事人物一" });
      expect((await store.getMemoryContext(userId, first.id)).messages.map((message) => message.content))
        .toEqual(["聊天记忆", "不能被故事书覆盖"]);

      const reloaded = new AgentStore({ stateDir });
      expect((await reloaded.getStoryBook(userId, first.id)).stories)
        .toEqual(updated.stories);
      const removed = await reloaded.deleteStoryBookEntry(
        userId,
        first.id,
        firstStory.id,
        updated.updatedAt,
      );
      expect(removed.stories).toHaveLength(1);
      expect(removed.stories[0]?.title).toBe("海边");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects stale story-book saves atomically", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-story-book-cas-"));
    try {
      const store = new AgentStore({ stateDir });
      const userId = "writer-cas@im.wechat";
      const agent = await store.getActiveAgent(userId);
      const empty = await store.getStoryBook(userId, agent.id);
      const results = await Promise.allSettled([
        store.saveStoryBookEntry(
          userId,
          agent.id,
          { title: "甲", premise: "甲构想", content: "甲的完整正文。" },
          empty.updatedAt,
        ),
        store.saveStoryBookEntry(
          userId,
          agent.id,
          { title: "乙", premise: "乙构想", content: "乙的完整正文。" },
          empty.updatedAt,
        ),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect((await store.getStoryBook(userId, agent.id)).stories).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("AgentStore image behavior persistence", () => {
  it("defaults legacy Agents safely and keeps settings isolated from profile and memory edits", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-image-behavior-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "image-behavior@im.wechat";
      const legacy = await store.getActiveAgent(userId);
      expect(legacy.imageBehavior).toEqual({
        mode: "explicit",
        cooldownMinutes: 0,
        allowAutonomous: false,
        visualIdentityPrompt: "",
      });
      const other = await store.createAgent(userId, {
        name: "另一角色",
        identity: "另一角色保持独立。",
        imageBehavior: {
          mode: "off",
          cooldownMinutes: 120,
          allowAutonomous: false,
          visualIdentityPrompt: "不应被另一个 Agent 覆盖。",
        },
      });
      await store.appendTurn(userId, legacy.id, {
        input: "保存图片配置前的对话",
        reply: "配置保存不能影响这段记忆。",
      });

      const saved = await store.updateImageBehaviorByAgentId(
        userId,
        legacy.id,
        {
          mode: "natural",
          cooldownMinutes: 35,
          allowAutonomous: true,
          visualIdentityPrompt: "短发，白衬衫，日常手机摄影。",
        },
        legacy.updatedAt,
      );
      expect(saved.imageBehavior).toEqual({
        mode: "natural",
        cooldownMinutes: 0,
        allowAutonomous: true,
        visualIdentityPrompt: "短发，白衬衫，日常手机摄影。",
      });

      const legacyClientSave = await store.updateAgentById(
        userId,
        legacy.id,
        {
          name: saved.name,
          identity: "由旧版人物编辑器更新的身份。",
          expectedUpdatedAt: saved.updatedAt,
        },
      );
      expect(legacyClientSave.imageBehavior).toEqual(saved.imageBehavior);
      await expect(
        store.updateImageBehaviorByAgentId(
          userId,
          legacy.id,
          { mode: "off" },
          saved.updatedAt,
        ),
      ).rejects.toThrow("已被其他会话更新");

      const reloaded = new AgentStore({ stateDir });
      const agents = (await reloaded.getRegistry(userId)).agents;
      expect(
        agents.find((agent) => agent.id === legacy.id)?.imageBehavior,
      ).toEqual(saved.imageBehavior);
      expect(
        agents.find((agent) => agent.id === other.id)?.imageBehavior,
      ).toEqual({
        mode: "off",
        cooldownMinutes: 0,
        allowAutonomous: false,
        visualIdentityPrompt: "不应被另一个 Agent 覆盖。",
      });
      expect(
        (await reloaded.getMemoryContext(userId, legacy.id)).messages.map(
          (message) => message.content,
        ),
      ).toEqual([
        "保存图片配置前的对话",
        "配置保存不能影响这段记忆。",
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("allows only one image behavior save from the same Agent version", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-agent-image-behavior-cas-"),
    );
    try {
      const store = new AgentStore({ stateDir });
      const userId = "image-cas@im.wechat";
      const agent = await store.getActiveAgent(userId);
      const results = await Promise.allSettled([
        store.updateImageBehaviorByAgentId(
          userId,
          agent.id,
          { mode: "natural", cooldownMinutes: 20 },
          agent.updatedAt,
        ),
        store.updateImageBehaviorByAgentId(
          userId,
          agent.id,
          { mode: "off", cooldownMinutes: 20 },
          agent.updatedAt,
        ),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
