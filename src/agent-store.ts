import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  AgentMemory,
  AgentMemoryArchivedEpisode,
  AgentMemoryArchivedMajorEvent,
  AgentMemoryCompressionCandidate,
  AgentMemoryCompressionResult,
  AgentMemoryContext,
  AgentMemoryEpisode,
  AgentMemoryEpisodeRebuildSnapshot,
  AgentMemoryFact,
  AgentMemoryMajorEvent,
  AgentMemoryMajorEventDraft,
  AgentMemoryMajorEventIndex,
  AgentMemoryMessage,
  AgentMemorySummarySnapshot,
  AgentImageBehavior,
  AgentProfile,
  AgentConversationMode,
  AgentDirectorEvent,
  AgentRoleplayProfile,
  AgentStoryBook,
  AgentStoryBookEntry,
  AgentUserSummary,
  UserAgentRegistry,
} from "./agent-types.js";
import {
  normalizeAgentImageBehavior,
  normalizeDirectorEvent,
  normalizeRoleplayProfile,
} from "./character-card.js";

const DEFAULT_AGENT_NAME = "默认助手";
const DEFAULT_AGENT_IDENTITY = "你是一个友好、可靠、回答简洁的个人助理。";
const MAX_AGENTS_PER_USER = 20;
/** Kept small because every active episode can be injected into a prompt. */
const MAX_ACTIVE_MEMORY_EPISODES = 60;
/** Curator input is bounded separately from the active prompt context. */
const MAX_COMPRESSION_CONTEXT_EPISODES = 40;
/** Full event history remains available to the console without prompt bloat. */
const MAX_ARCHIVED_MEMORY_EPISODES = 1_000;
const MAX_MEMORY_MAJOR_EVENTS = 100;
const MAX_ACTIVE_MEMORY_MAJOR_EVENTS = 20;
const MAX_DETAILS_PER_MAJOR_EVENT = 24;
const MAX_MEMORY_EPISODES_PER_ORGANIZATION = 300;
const MAX_STORIES_PER_AGENT = 50;
const MAX_STORY_TITLE_CHARACTERS = 200;
const MAX_STORY_PREMISE_CHARACTERS = 20_000;
const MAX_STORY_CONTENT_CHARACTERS = 100_000;

export interface AgentStoreOptions {
  stateDir: string;
  /** Compress after the working window grows beyond this many messages. */
  maxMemoryMessages?: number;
  /** Messages kept verbatim in the prompt after a successful compression. */
  retainRecentMessages?: number;
  /** Maximum text sent to the curator in one compression batch. */
  compressionBatchChars?: number;
  /** Removes derived private artifacts, such as Prompt Trace, with memory. */
  onClearAgentData?: (userId: string, agentId: string) => Promise<void>;
  /** Removes Agent-owned configuration that should only be deleted with it. */
  onDeleteAgent?: (userId: string, agentId: string) => Promise<void>;
}

export interface AgentMemorySummaryArchive {
  compressionCount: number;
  snapshots: AgentMemorySummarySnapshot[];
}

export interface AgentMemoryEpisodeArchive {
  compressionCount: number;
  missingLegacyCompressionCount: number;
  sourceMessageCount: number;
  rebuiltAt?: string;
  episodes: AgentMemoryArchivedEpisode[];
  majorEvents: AgentMemoryArchivedMajorEvent[];
  ungroupedEpisodeCount: number;
  hierarchyGeneratedAt?: string;
  hierarchyInputFingerprint?: string;
}

export interface AgentMemoryEpisodeOrganizationCandidate {
  inputFingerprint: string;
  needsOrganization: boolean;
  sourceMessageCount: number;
  episodes: Array<{
    sourceKey: string;
    title: string;
    content: string;
    importance: 1 | 2 | 3 | 4 | 5;
    sourceMessageId?: string;
    sourceOrder?: number;
    occurredAt?: string;
    occurrencePrecision?: "message" | "batch";
    updatedAt: string;
  }>;
  previousMajorEvents: AgentMemoryMajorEvent[];
}

export class AgentStore {
  private readonly rootDir: string;
  private readonly maxMemoryMessages: number;
  private readonly retainRecentMessages: number;
  private readonly compressionBatchChars: number;
  private readonly onClearAgentData:
    | ((userId: string, agentId: string) => Promise<void>)
    | undefined;
  private readonly onDeleteAgent:
    | ((userId: string, agentId: string) => Promise<void>)
    | undefined;
  private readonly agentLocks = new Map<string, Promise<void>>();
  private readonly agentDeliveryLeases = new Map<string, Promise<void>>();
  private readonly registryLocks = new Map<string, Promise<void>>();
  private readonly agentDataGenerations = new Map<string, number>();

  constructor(options: AgentStoreOptions) {
    this.rootDir = path.join(options.stateDir, "agents");
    this.maxMemoryMessages = toEven(Math.max(options.maxMemoryMessages ?? 40, 4));
    this.retainRecentMessages = toEven(
      Math.min(
        Math.max(options.retainRecentMessages ?? 20, 2),
        this.maxMemoryMessages - 2,
      ),
    );
    this.compressionBatchChars = Math.max(
      options.compressionBatchChars ?? 60_000,
      8_000,
    );
    this.onClearAgentData = options.onClearAgentData;
    this.onDeleteAgent = options.onDeleteAgent;
  }

  async getRegistry(userId: string): Promise<UserAgentRegistry> {
    return this.withRegistryLock(userId, () =>
      this.getRegistryUnlocked(userId)
    );
  }

  private async getRegistryUnlocked(
    userId: string,
  ): Promise<UserAgentRegistry> {
    const existing = await this.readJson<UserAgentRegistry>(
      this.registryPath(userId),
    );
    if (existing?.agents.length) {
      let changed = false;
      if (existing.userId !== userId) {
        existing.userId = userId;
        changed = true;
      }
      for (const agent of existing.agents) {
        const normalized = normalizeAgentImageBehavior(agent.imageBehavior);
        if (JSON.stringify(agent.imageBehavior) !== JSON.stringify(normalized)) {
          agent.imageBehavior = normalized;
          changed = true;
        }
      }
      if (changed) await this.saveRegistry(userId, existing);
      return existing;
    }

    const now = new Date().toISOString();
    const defaultAgent: AgentProfile = {
      id: crypto.randomUUID(),
      name: DEFAULT_AGENT_NAME,
      identity: DEFAULT_AGENT_IDENTITY,
      imageBehavior: normalizeAgentImageBehavior(undefined),
      createdAt: now,
      updatedAt: now,
    };
    const registry: UserAgentRegistry = {
      version: 1,
      userId,
      activeAgentId: defaultAgent.id,
      agents: [defaultAgent],
    };
    await this.saveRegistry(userId, registry);
    return registry;
  }

  async listUsers(): Promise<AgentUserSummary[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      const users: AgentUserSummary[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const registry = await this.readJson<UserAgentRegistry>(
          path.join(this.rootDir, entry.name, "profiles.json"),
        );
        if (!registry?.userId || !registry.agents.length) continue;
        users.push({
          userId: registry.userId,
          activeAgentId: registry.activeAgentId,
          agentCount: registry.agents.length,
        });
      }
      return users.sort((a, b) => a.userId.localeCompare(b.userId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async getActiveAgent(userId: string): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const active = registry.agents.find(
        (agent) => agent.id === registry.activeAgentId,
      );
      if (active) return active;

      const fallback = registry.agents[0];
      if (!fallback) throw new Error("当前用户没有可用的 Agent。");
      registry.activeAgentId = fallback.id;
      await this.saveRegistry(userId, registry);
      return fallback;
    });
  }

  async createAgent(
    userId: string,
    params: {
      name: string;
      identity: string;
      roleplay?: AgentRoleplayProfile;
      conversationMode?: AgentConversationMode;
      imageBehavior?: Partial<AgentImageBehavior>;
    },
  ): Promise<AgentProfile> {
    const name = validateName(params.name);
    const identity = validateIdentity(params.identity);
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      if (registry.agents.length >= MAX_AGENTS_PER_USER) {
        throw new Error(`每个用户最多创建 ${MAX_AGENTS_PER_USER} 个 Agent。`);
      }
      if (findAgentByName(registry, name)) {
        throw new Error(`Agent“${name}”已经存在。`);
      }

      const now = new Date().toISOString();
      const roleplay = normalizeRoleplayProfile(params.roleplay);
      const agent: AgentProfile = {
        id: crypto.randomUUID(),
        name,
        identity,
        ...(roleplay ? { roleplay } : {}),
        ...(params.conversationMode
          ? { conversationMode: params.conversationMode }
          : {}),
        imageBehavior: normalizeAgentImageBehavior(params.imageBehavior),
        createdAt: now,
        updatedAt: now,
      };
      registry.agents.push(agent);
      registry.activeAgentId = agent.id;
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async switchAgent(userId: string, name: string): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = findAgentByName(registry, validateName(name));
      if (!agent) throw new Error(`没有找到 Agent“${name.trim()}”。`);
      registry.activeAgentId = agent.id;
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async switchAgentById(
    userId: string,
    agentId: string,
  ): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = requireAgentById(registry, agentId);
      registry.activeAgentId = agent.id;
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async updateActiveIdentity(
    userId: string,
    identity: string,
  ): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = requireActiveAgent(registry);
      agent.identity = validateIdentity(identity);
      agent.updatedAt = nextUpdatedAt(agent.updatedAt);
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async renameActiveAgent(
    userId: string,
    newName: string,
  ): Promise<AgentProfile> {
    const name = validateName(newName);
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = requireActiveAgent(registry);
      const duplicate = findAgentByName(registry, name);
      if (duplicate && duplicate.id !== agent.id) {
        throw new Error(`Agent“${name}”已经存在。`);
      }
      agent.name = name;
      agent.updatedAt = nextUpdatedAt(agent.updatedAt);
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async setActiveProvider(
    userId: string,
    selection: { providerId?: string; model?: string },
  ): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = requireActiveAgent(registry);
      if (selection.providerId?.trim()) {
        agent.providerId = selection.providerId.trim();
      } else {
        delete agent.providerId;
      }
      if (selection.model?.trim()) {
        agent.model = selection.model.trim();
      } else {
        delete agent.model;
      }
      agent.updatedAt = nextUpdatedAt(agent.updatedAt);
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async setActiveConversationMode(
    userId: string,
    conversationMode: AgentConversationMode,
  ): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = requireActiveAgent(registry);
      agent.conversationMode = conversationMode;
      agent.updatedAt = nextUpdatedAt(agent.updatedAt);
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async updateAgentById(
    userId: string,
    agentId: string,
    update: {
      name: string;
      identity: string;
      providerId?: string;
      model?: string;
      roleplay?: AgentRoleplayProfile;
      conversationMode?: AgentConversationMode;
      imageBehavior?: Partial<AgentImageBehavior>;
      expectedUpdatedAt?: string;
    },
  ): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = requireAgentById(registry, agentId);
      if (
        update.expectedUpdatedAt &&
        agent.updatedAt !== update.expectedUpdatedAt
      ) {
        throw new Error("人物设定已被其他会话更新，请刷新后重试。");
      }
      const name = validateName(update.name);
      const duplicate = findAgentByName(registry, name);
      if (duplicate && duplicate.id !== agent.id) {
        throw new Error(`Agent“${name}”已经存在。`);
      }
      agent.name = name;
      agent.identity = validateIdentity(update.identity);
      const incomingRoleplay = update.roleplay === undefined
        ? agent.roleplay
        : update.roleplay && agent.roleplay
        ? {
            ...update.roleplay,
            ...(agent.roleplay.stylePrompt &&
            !Object.hasOwn(update.roleplay, "stylePrompt")
              ? { stylePrompt: agent.roleplay.stylePrompt }
              : {}),
            ...(agent.roleplay.writingStyleExamples &&
            !Object.hasOwn(update.roleplay, "writingStyleExamples")
              ? {
                  writingStyleExamples:
                    agent.roleplay.writingStyleExamples,
                }
              : {}),
            ...(agent.roleplay.directorEvent &&
            !Object.hasOwn(update.roleplay, "directorEvent")
              ? {
                  directorEvent: agent.roleplay.directorEvent,
                }
              : {}),
            ...(agent.roleplay.characterCardExtensions &&
            !Object.hasOwn(update.roleplay, "characterCardExtensions")
              ? {
                  characterCardExtensions:
                    agent.roleplay.characterCardExtensions,
                }
              : {}),
          }
        : update.roleplay;
      const roleplay = normalizeRoleplayProfile(incomingRoleplay);
      if (roleplay) agent.roleplay = roleplay;
      else delete agent.roleplay;
      if (update.conversationMode) {
        agent.conversationMode = update.conversationMode;
      } else {
        delete agent.conversationMode;
      }
      if (update.providerId?.trim()) {
        agent.providerId = update.providerId.trim();
      } else {
        delete agent.providerId;
      }
      if (update.model?.trim()) {
        agent.model = update.model.trim();
      } else {
        delete agent.model;
      }
      if (update.imageBehavior !== undefined) {
        agent.imageBehavior = normalizeAgentImageBehavior(
          {
            ...normalizeAgentImageBehavior(agent.imageBehavior),
            ...update.imageBehavior,
          },
        );
      }
      agent.updatedAt = nextUpdatedAt(agent.updatedAt);
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async updateImageBehaviorByAgentId(
    userId: string,
    agentId: string,
    imageBehavior: Partial<AgentImageBehavior>,
    expectedUpdatedAt: string,
  ): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = requireAgentById(registry, agentId);
      if (agent.updatedAt !== expectedUpdatedAt) {
        throw new Error("人物设定已被其他会话更新，请刷新后重试。");
      }
      agent.imageBehavior = normalizeAgentImageBehavior({
        ...normalizeAgentImageBehavior(agent.imageBehavior),
        ...imageBehavior,
      });
      agent.updatedAt = nextUpdatedAt(agent.updatedAt);
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async updateDirectorEventByAgentId(
    userId: string,
    agentId: string,
    event: AgentDirectorEvent | null,
    expectedUpdatedAt: string,
  ): Promise<AgentProfile> {
    return this.withRegistryLock(userId, async () => {
      const registry = await this.getRegistryUnlocked(userId);
      const agent = requireAgentById(registry, agentId);
      if (agent.updatedAt !== expectedUpdatedAt) {
        throw new Error("人物设定已被其他会话更新，请刷新后重试。");
      }
      const directorEvent = event === null
        ? undefined
        : normalizeDirectorEvent(event);
      const nextRoleplay: AgentRoleplayProfile = {
        ...(agent.roleplay ?? {}),
      };
      if (directorEvent) nextRoleplay.directorEvent = directorEvent;
      else delete nextRoleplay.directorEvent;
      const roleplay = normalizeRoleplayProfile(nextRoleplay);
      if (roleplay) agent.roleplay = roleplay;
      else delete agent.roleplay;
      agent.updatedAt = nextUpdatedAt(agent.updatedAt);
      await this.saveRegistry(userId, registry);
      return agent;
    });
  }

  async getStoryBook(
    userId: string,
    agentId: string,
  ): Promise<AgentStoryBook> {
    return this.withAgentLock(userId, agentId, async () => {
      await this.withRegistryLock(userId, async () => {
        requireAgentById(await this.getRegistryUnlocked(userId), agentId);
      });
      return this.getStoryBookLocked(userId, agentId);
    });
  }

  async saveStoryBookEntry(
    userId: string,
    agentId: string,
    story: Pick<AgentStoryBookEntry, "title" | "premise" | "content"> & {
      id?: string;
    },
    expectedBookUpdatedAt: string,
  ): Promise<AgentStoryBook> {
    return this.withAgentLock(userId, agentId, async () => {
      await this.withRegistryLock(userId, async () => {
        requireAgentById(await this.getRegistryUnlocked(userId), agentId);
      });
      const book = await this.getStoryBookLocked(userId, agentId);
      if (book.updatedAt !== expectedBookUpdatedAt) {
        throw new Error("故事书已在其他位置更新，请重新打开后再试。");
      }
      const now = nextUpdatedAt(book.updatedAt);
      const normalized = normalizeStoryBookEntry(story);
      const existingIndex = story.id
        ? book.stories.findIndex((entry) => entry.id === story.id)
        : -1;
      if (story.id && existingIndex < 0) {
        throw new Error("没有找到要保存的故事。");
      }
      if (existingIndex >= 0) {
        const existing = book.stories[existingIndex]!;
        book.stories[existingIndex] = {
          ...normalized,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: now,
        };
      } else {
        if (book.stories.length >= MAX_STORIES_PER_AGENT) {
          throw new Error(`每个人物最多保存 ${MAX_STORIES_PER_AGENT} 篇故事。`);
        }
        book.stories.unshift({
          ...normalized,
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        });
      }
      book.updatedAt = now;
      await this.writePrivateJson(this.storyBookPath(userId, agentId), book);
      return book;
    });
  }

  async deleteStoryBookEntry(
    userId: string,
    agentId: string,
    storyId: string,
    expectedBookUpdatedAt: string,
  ): Promise<AgentStoryBook> {
    return this.withAgentLock(userId, agentId, async () => {
      await this.withRegistryLock(userId, async () => {
        requireAgentById(await this.getRegistryUnlocked(userId), agentId);
      });
      const book = await this.getStoryBookLocked(userId, agentId);
      if (book.updatedAt !== expectedBookUpdatedAt) {
        throw new Error("故事书已在其他位置更新，请重新打开后再试。");
      }
      const nextStories = book.stories.filter((story) => story.id !== storyId);
      if (nextStories.length === book.stories.length) {
        throw new Error("没有找到要删除的故事。");
      }
      book.stories = nextStories;
      book.updatedAt = nextUpdatedAt(book.updatedAt);
      await this.writePrivateJson(this.storyBookPath(userId, agentId), book);
      return book;
    });
  }

  async deleteAgent(userId: string, name: string): Promise<void> {
    const registry = await this.getRegistry(userId);
    const agent = findAgentByName(registry, validateName(name));
    if (!agent) throw new Error(`没有找到 Agent“${name.trim()}”。`);
    await this.deleteAgentByStableId(userId, agent.id);
  }

  async deleteAgentById(userId: string, agentId: string): Promise<void> {
    await this.deleteAgentByStableId(userId, agentId);
  }

  private async deleteAgentByStableId(
    userId: string,
    agentId: string,
  ): Promise<void> {
    await this.withAgentDeliveryLease(userId, agentId, () =>
      this.withAgentLock(userId, agentId, async () => {
        // The delivery lease may have waited on a network request. Reload the
        // registry only after both guards are held so newer profile edits are
        // never overwritten by a stale pre-wait snapshot.
        await this.withRegistryLock(userId, async () => {
          const registry = await this.getRegistryUnlocked(userId);
          const agent = requireAgentById(registry, agentId);
          if (registry.agents.length === 1) {
            throw new Error("至少需要保留一个 Agent。");
          }
          if (registry.activeAgentId === agent.id) {
            throw new Error("不能删除当前 Agent，请先切换到另一个 Agent。");
          }
          // Invalidate in-flight replies before removing any private data. If
          // cleanup fails, the profile remains visible so it can be retried.
          this.bumpAgentDataGeneration(userId, agent.id);
          await rm(this.memoryPath(userId, agent.id), { force: true });
          await rm(this.historyPath(userId, agent.id), { force: true });
          await rm(this.memorySummaryDir(userId, agent.id), {
            recursive: true,
            force: true,
          });
          await rm(this.memoryEpisodeRebuildPath(userId, agent.id), {
            force: true,
          });
          await rm(this.memoryMajorEventIndexPath(userId, agent.id), {
            force: true,
          });
          await rm(this.storyBookPath(userId, agent.id), { force: true });
          await this.onClearAgentData?.(userId, agent.id);
          await this.onDeleteAgent?.(userId, agent.id);

          registry.agents = registry.agents.filter(
            (candidate) => candidate.id !== agent.id,
          );
          await this.saveRegistry(userId, registry);
        });
      })
    );
  }

  captureDataGeneration(userId: string, agentId: string): number {
    return this.agentDataGenerations.get(this.agentLockKey(userId, agentId)) ?? 0;
  }

  async getMemory(
    userId: string,
    agentId: string,
  ): Promise<AgentMemoryMessage[]> {
    return (await this.getMemoryContext(userId, agentId)).messages;
  }

  async getMemoryContext(
    userId: string,
    agentId: string,
  ): Promise<AgentMemoryContext> {
    const [memory, hierarchy, rebuilt] = await Promise.all([
      this.readJson<AgentMemory>(this.memoryPath(userId, agentId)),
      this.readJson<AgentMemoryMajorEventIndex>(
        this.memoryMajorEventIndexPath(userId, agentId),
      ),
      this.readJson<AgentMemoryEpisodeRebuildSnapshot>(
        this.memoryEpisodeRebuildPath(userId, agentId),
      ),
    ]);
    const episodes = mergeMemoryEpisodes(
      rebuilt?.agentId === agentId ? rebuilt.episodes : [],
      memory?.episodes ?? [],
      MAX_ACTIVE_MEMORY_EPISODES,
    );
    const activeDetailKeys = new Set(
      episodes.map((episode) => memoryEpisodeKey(episode)),
    );
    const hierarchyIsCurrent =
      hierarchy?.agentId === agentId &&
      hierarchy.activeInputFingerprint ===
        memoryEpisodeFingerprint(episodes);
    return {
      messages: memory?.messages ?? [],
      summary: memory?.summary ?? "",
      facts: memory?.facts ?? [],
      episodes,
      majorEvents:
        hierarchyIsCurrent
          ? hierarchy.groups
              .map((group) => ({
                ...group,
                detailKeys: group.detailKeys.filter((key) =>
                  activeDetailKeys.has(key)
                ),
              }))
              .filter((group) => group.detailKeys.length > 0)
              .slice(0, MAX_ACTIVE_MEMORY_MAJOR_EVENTS)
          : [],
      archivedMessageCount: memory?.archivedMessageCount ?? 0,
      totalMessageCount:
        memory?.totalMessageCount ??
        (memory?.archivedMessageCount ?? 0) + (memory?.messages.length ?? 0),
      compressionCount: memory?.compressionCount ?? 0,
      ...(memory?.lastCompressionAt
        ? { lastCompressionAt: memory.lastCompressionAt }
        : {}),
    };
  }

  async getMemorySummaryHistory(
    userId: string,
    agentId: string,
  ): Promise<AgentMemorySummarySnapshot[]> {
    return (await this.getMemorySummaryArchive(userId, agentId)).snapshots;
  }

  async getMemorySummaryArchive(
    userId: string,
    agentId: string,
  ): Promise<AgentMemorySummaryArchive> {
    const registry = await this.getRegistry(userId);
    requireAgentById(registry, agentId);
    return this.withAgentLock(userId, agentId, () =>
      this.getMemorySummaryArchiveLocked(userId, agentId)
    );
  }

  async getMemoryEpisodeArchive(
    userId: string,
    agentId: string,
  ): Promise<AgentMemoryEpisodeArchive> {
    const registry = await this.getRegistry(userId);
    requireAgentById(registry, agentId);
    return this.withAgentLock(userId, agentId, () =>
      this.getMemoryEpisodeArchiveLocked(userId, agentId)
    );
  }

  private async getMemoryEpisodeArchiveLocked(
    userId: string,
    agentId: string,
  ): Promise<AgentMemoryEpisodeArchive> {
      // All three sources are read under the same Agent lock so a concurrent
      // clear/rebuild cannot produce a half-old, half-new archive response.
      const summaryArchive = await this.getMemorySummaryArchiveLocked(
        userId,
        agentId,
      );
      const current = await this.getMemoryContext(userId, agentId);
      const rebuilt = await this.readJson<AgentMemoryEpisodeRebuildSnapshot>(
        this.memoryEpisodeRebuildPath(userId, agentId),
      );
      const activeKeys = new Set(
        current.episodes.map((episode) => memoryEpisodeKey(episode)),
      );
      const aggregated = new Map<string, AgentMemoryArchivedEpisode>();

      const includeEpisode = (
        episode: AgentMemoryEpisode,
        seenAt: string,
        options: {
          sequence?: number;
          reconstructed?: boolean;
          migratedBaseline?: boolean;
        } = {},
      ) => {
        const key = memoryEpisodeKey(episode);
        const existing = aggregated.get(key);
        const sequences = options.sequence === undefined
          ? existing?.compressionSequences ?? []
          : [...new Set([
              ...(existing?.compressionSequences ?? []),
              options.sequence,
            ])].sort((a, b) => a - b);
        aggregated.set(key, {
          ...(existing ?? episode),
          ...episode,
          id: existing?.id ?? episode.id,
          sourceKey: episode.sourceKey ?? existing?.sourceKey ?? key,
          firstSeenAt: existing?.firstSeenAt ?? seenAt,
          lastSeenAt: seenAt,
          seenCount: (existing?.seenCount ?? 0) + 1,
          compressionSequences: sequences,
          currentlyActive: activeKeys.has(key),
          reconstructed:
            Boolean(existing?.reconstructed) || Boolean(options.reconstructed),
          migratedBaseline:
            Boolean(existing?.migratedBaseline) ||
            Boolean(options.migratedBaseline),
        });
      };

      for (const snapshot of summaryArchive.snapshots) {
        for (const episode of snapshot.episodes) {
          includeEpisode(episode, snapshot.createdAt, {
            sequence: snapshot.sequence,
            ...(snapshot.migratedBaseline
              ? { migratedBaseline: true }
              : {}),
          });
        }
      }
      if (rebuilt?.agentId === agentId) {
        for (const episode of rebuilt.episodes) {
          includeEpisode(episode, rebuilt.createdAt, { reconstructed: true });
        }
      }
      for (const episode of current.episodes) {
        const key = memoryEpisodeKey(episode);
        const archived = aggregated.get(key);
        if (!archived) {
          includeEpisode(episode, episode.updatedAt);
          continue;
        }
        // Current memory is the authoritative live revision (the curator layer
        // wins over an overlapping rebuild), but overlaying it must not count
        // as another historical appearance.
        aggregated.set(key, {
          ...archived,
          ...episode,
          id: archived.id,
          ...((episode.sourceKey ?? archived.sourceKey)
            ? { sourceKey: episode.sourceKey ?? archived.sourceKey }
            : {}),
          firstSeenAt: archived.firstSeenAt,
          lastSeenAt:
            Date.parse(episode.updatedAt) > Date.parse(archived.lastSeenAt)
              ? episode.updatedAt
              : archived.lastSeenAt,
          seenCount: archived.seenCount,
          compressionSequences: archived.compressionSequences,
          currentlyActive: true,
          reconstructed: archived.reconstructed,
          migratedBaseline: archived.migratedBaseline,
        });
      }

      const episodes = [...aggregated.values()].sort(
        (a, b) =>
          compareMemoryEpisodeChronology(b, a) ||
          b.importance - a.importance ||
          a.title.localeCompare(b.title, "zh-CN"),
      );
      const hierarchy = await this.readJson<AgentMemoryMajorEventIndex>(
        this.memoryMajorEventIndexPath(userId, agentId),
      );
      const hierarchyIsCurrent =
        hierarchy?.agentId === agentId &&
        hierarchy.inputFingerprint ===
          memoryEpisodeArchiveFingerprint(episodes);
      const materialized = materializeMajorEvents(
        hierarchyIsCurrent ? hierarchy.groups : [],
        episodes,
      );
      return {
        compressionCount: summaryArchive.compressionCount,
        missingLegacyCompressionCount: Math.max(
          0,
          summaryArchive.compressionCount - summaryArchive.snapshots.length,
        ),
        sourceMessageCount: rebuilt?.sourceMessageCount ?? 0,
        ...(rebuilt?.createdAt ? { rebuiltAt: rebuilt.createdAt } : {}),
        episodes,
        majorEvents: materialized.majorEvents,
        ungroupedEpisodeCount: materialized.ungroupedEpisodeCount,
        ...(hierarchyIsCurrent && hierarchy?.generatedAt
          ? { hierarchyGeneratedAt: hierarchy.generatedAt }
          : {}),
        ...(hierarchyIsCurrent && hierarchy?.inputFingerprint
          ? { hierarchyInputFingerprint: hierarchy.inputFingerprint }
          : {}),
      };
  }

  async getMemoryEpisodeOrganizationCandidate(
    userId: string,
    agentId: string,
  ): Promise<AgentMemoryEpisodeOrganizationCandidate> {
    const registry = await this.getRegistry(userId);
    requireAgentById(registry, agentId);
    return this.withAgentLock(userId, agentId, async () => {
      const archive = await this.getMemoryEpisodeArchiveLocked(userId, agentId);
      const hierarchy = await this.readJson<AgentMemoryMajorEventIndex>(
        this.memoryMajorEventIndexPath(userId, agentId),
      );
      const inputFingerprint = memoryEpisodeArchiveFingerprint(
        archive.episodes,
      );
      if (
        archive.episodes.length > MAX_MEMORY_EPISODES_PER_ORGANIZATION
      ) {
        throw new Error(
          `当前有 ${archive.episodes.length} 条事件细节，超过单次整理上限 ${MAX_MEMORY_EPISODES_PER_ORGANIZATION}；需要分页整理，未丢弃任何事件。`,
        );
      }
      return {
        inputFingerprint,
        sourceMessageCount: archive.sourceMessageCount,
        needsOrganization:
          hierarchy?.agentId !== agentId ||
          hierarchy.inputFingerprint !== inputFingerprint,
        episodes: [...archive.episodes]
          .sort(compareMemoryEpisodeChronology)
          .map((episode) => ({
          sourceKey: episode.sourceKey ?? memoryEpisodeKey(episode),
          title: episode.title,
          content: episode.content,
          importance: episode.importance,
          ...(episode.sourceMessageId
            ? { sourceMessageId: episode.sourceMessageId }
            : {}),
          ...(episode.sourceOrder !== undefined
            ? { sourceOrder: episode.sourceOrder }
            : {}),
          ...(episode.occurredAt ? { occurredAt: episode.occurredAt } : {}),
          ...(episode.occurrencePrecision
            ? { occurrencePrecision: episode.occurrencePrecision }
            : {}),
          updatedAt: episode.updatedAt,
          })),
        previousMajorEvents:
          hierarchy?.agentId === agentId &&
              hierarchy.inputFingerprint === inputFingerprint
            ? hierarchy.groups
            : [],
      };
    });
  }

  async saveMemoryEpisodeHierarchy(
    userId: string,
    agentId: string,
    params: {
      inputFingerprint: string;
      groups: readonly AgentMemoryMajorEventDraft[];
      /** Details that the organizer was required to place exactly once. */
      organizedDetailKeys?: readonly string[];
    },
    expectedGeneration?: number,
  ): Promise<boolean> {
    const registry = await this.getRegistry(userId);
    requireAgentById(registry, agentId);
    return this.withAgentLock(userId, agentId, async () => {
      if (!this.isDataGenerationCurrent(userId, agentId, expectedGeneration)) {
        return false;
      }
      const archive = await this.getMemoryEpisodeArchiveLocked(userId, agentId);
      const inputFingerprint = memoryEpisodeArchiveFingerprint(
        archive.episodes,
      );
      if (params.inputFingerprint !== inputFingerprint) return false;
      const previous = await this.readJson<AgentMemoryMajorEventIndex>(
        this.memoryMajorEventIndexPath(userId, agentId),
      );
      const now = new Date().toISOString();
      if (params.organizedDetailKeys?.length) {
        assertMajorEventDraftCoverage(
          params.groups,
          params.organizedDetailKeys,
        );
      }
      const groups = normalizeMajorEvents(
        params.groups,
        archive.episodes,
        previous?.agentId === agentId ? previous.groups : [],
        now,
      );
      if (params.organizedDetailKeys?.length) {
        const expected = new Set(
          params.organizedDetailKeys
            .map((key) => normalizeMemoryEpisodeSourceKey(key))
            .filter(Boolean),
        );
        const covered = new Set(
          groups.flatMap((group) =>
            group.detailKeys.map((key) =>
              normalizeMemoryEpisodeSourceKey(key)
            )
          ),
        );
        const missing = [...expected].filter((key) => !covered.has(key));
        if (missing.length) {
          throw new Error(
            `大事件整理结果遗漏了 ${missing.length} 条事件细节，已保留原有分组。`,
          );
        }
      }
      const oversized = groups.find(
        (group) => group.detailKeys.length > MAX_DETAILS_PER_MAJOR_EVENT,
      );
      if (oversized) {
        throw new Error(
          `大事件整理结果中有分组包含 ${oversized.detailKeys.length} 条细节，超过 ${MAX_DETAILS_PER_MAJOR_EVENT} 条上限，已保留原有分组。`,
        );
      }
      const chronologyProblem = findMajorEventChronologyProblem(
        groups,
        archive.episodes,
        archive.sourceMessageCount,
      );
      if (chronologyProblem) {
        throw new Error(
          `${chronologyProblem}，已保留原有分组。`,
        );
      }
      const snapshot: AgentMemoryMajorEventIndex = {
        version: 1,
        agentId,
        generatedAt: now,
        inputFingerprint,
        activeInputFingerprint: memoryEpisodeFingerprint(
          archive.episodes.filter((episode) => episode.currentlyActive),
        ),
        sourceEpisodeCount: archive.episodes.length,
        groups,
      };
      await this.writePrivateJson(
        this.memoryMajorEventIndexPath(userId, agentId),
        snapshot,
      );
      return true;
    });
  }

  async saveReconstructedMemoryEpisodes(
    userId: string,
    agentId: string,
    params: {
      episodes: AgentMemoryCompressionResult["episodes"];
      sourceMessageCount: number;
      sourceStartedAt?: string;
      sourceEndedAt?: string;
    },
    expectedGeneration?: number,
  ): Promise<boolean> {
    const registry = await this.getRegistry(userId);
    requireAgentById(registry, agentId);
    return this.withAgentLock(userId, agentId, async () => {
      if (!this.isDataGenerationCurrent(userId, agentId, expectedGeneration)) {
        return false;
      }
      const existing = await this.getMemoryContext(userId, agentId);
      const now = new Date().toISOString();
      const summaryArchive = await this.getMemorySummaryArchiveLocked(
        userId,
        agentId,
      );
      const previousRebuild =
        await this.readJson<AgentMemoryEpisodeRebuildSnapshot>(
          this.memoryEpisodeRebuildPath(userId, agentId),
        );
      const validPreviousRebuild =
        previousRebuild?.agentId === agentId ? previousRebuild : null;
      const latestCuratorEpisodes =
        summaryArchive.snapshots.at(-1)?.episodes ?? [];
      const curatorEpisodes = removeReconstructedLayer(
        existing.episodes,
        validPreviousRebuild?.episodes ?? [],
        latestCuratorEpisodes,
        MAX_ACTIVE_MEMORY_EPISODES,
      );
      if (params.episodes.length > MAX_ARCHIVED_MEMORY_EPISODES) {
        throw new Error(
          `重建生成了 ${params.episodes.length} 条事件，超过 ${MAX_ARCHIVED_MEMORY_EPISODES} 条安全上限；旧记忆保持不变。`,
        );
      }
      // A completed rebuild is one replaceable source layer. Re-running it
      // atomically supersedes its previous output instead of making incorrect
      // reconstructed events immortal.
      const reconstructed = normalizeCompressedEpisodes(
        params.episodes,
        now,
        MAX_ARCHIVED_MEMORY_EPISODES,
      );
      const snapshot: AgentMemoryEpisodeRebuildSnapshot = {
        version: 1,
        agentId,
        createdAt: now,
        sourceMessageCount: Math.max(0, Math.floor(params.sourceMessageCount)),
        ...(params.sourceStartedAt
          ? { sourceStartedAt: params.sourceStartedAt }
          : {}),
        ...(params.sourceEndedAt ? { sourceEndedAt: params.sourceEndedAt } : {}),
        episodes: reconstructed,
      };
      const memory: AgentMemory = {
        version: 3,
        agentId,
        updatedAt: now,
        messages: existing.messages,
        summary: existing.summary,
        facts: existing.facts,
        // Reconstructed memory has a single authoritative snapshot. Keeping
        // memory.json curator-only lets one atomic snapshot replacement switch
        // the entire reconstructed layer without a half-new state.
        episodes: curatorEpisodes,
        archivedMessageCount: existing.archivedMessageCount,
        totalMessageCount: existing.totalMessageCount,
        compressionCount: existing.compressionCount,
        ...(existing.lastCompressionAt
          ? { lastCompressionAt: existing.lastCompressionAt }
          : {}),
      };
      await this.writePrivateJson(this.memoryPath(userId, agentId), memory);
      await this.writePrivateJson(
        this.memoryEpisodeRebuildPath(userId, agentId),
        snapshot,
      );
      return true;
    });
  }

  async appendTurn(
    userId: string,
    agentId: string,
    params: (
      | { input: string; reply: string }
      | { input: string; replies: readonly string[] }
    ) & {
      conversationMode?: AgentConversationMode;
      inputCreatedAt?: string;
    },
    expectedGeneration?: number,
  ): Promise<boolean> {
    return this.withAgentLock(userId, agentId, async () => {
      if (!this.isDataGenerationCurrent(userId, agentId, expectedGeneration)) {
        return false;
      }
      const replies = ("replies" in params ? params.replies : [params.reply])
        .map((reply) => reply.trim())
        .filter(Boolean);
      if (!replies.length) {
        throw new Error("Agent 回复不能为空。");
      }
      const existing = await this.getMemoryContext(userId, agentId);
      const messages = withMessageIds(existing.messages, agentId);
      const now = new Date().toISOString();
      const inputCreatedAt = normalizeStoredMessageTime(
        params.inputCreatedAt,
        now,
      );
      const userMessage = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: params.input,
        createdAt: inputCreatedAt,
        ...(params.conversationMode
          ? { conversationMode: params.conversationMode }
          : {}),
      };
      const assistantMessages = replies.map((reply) => ({
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content: reply,
        createdAt: now,
        ...(params.conversationMode
          ? { conversationMode: params.conversationMode }
          : {}),
      }));
      await this.ensureHistoryInitialized(userId, agentId, messages);
      await this.appendPrivateHistory(userId, agentId, [
        userMessage,
        ...assistantMessages,
      ]);
      messages.push(
        { ...userMessage, content: trimMemoryContent(userMessage.content) },
        ...assistantMessages.map((message) => ({
          ...message,
          content: trimMemoryContent(message.content),
        })),
      );
      const curatorEpisodes = await this.getCuratorEpisodesLocked(
        userId,
        agentId,
        existing,
      );
      const memory: AgentMemory = {
        version: 3,
        agentId,
        updatedAt: now,
        messages,
        summary: existing.summary,
        facts: mergeFacts(existing.facts, extractFacts(params.input, now)),
        episodes: curatorEpisodes,
        archivedMessageCount: existing.archivedMessageCount,
        totalMessageCount:
          existing.totalMessageCount + 1 + assistantMessages.length,
        compressionCount: existing.compressionCount,
        ...(existing.lastCompressionAt
          ? { lastCompressionAt: existing.lastCompressionAt }
          : {}),
      };
      await this.writePrivateJson(this.memoryPath(userId, agentId), memory);
      return true;
    });
  }

  async appendOutboundMessage(
    userId: string,
    agentId: string,
    content: string,
    conversationMode: AgentConversationMode = "wechat",
  ): Promise<void> {
    const normalized = content.trim();
    if (!normalized) throw new Error("主动消息不能为空。");
    await this.withAgentLock(userId, agentId, async () => {
      const registry = await this.getRegistry(userId);
      requireAgentById(registry, agentId);
      await this.appendOutboundMessageLocked(
        userId,
        agentId,
        normalized,
        conversationMode,
      );
    });
  }

  async deliverOutboundMessage(
    userId: string,
    agentId: string,
    content: string,
    send: (
      finalizeDelivery: () => Promise<void>,
    ) => Promise<unknown>,
    conversationMode: AgentConversationMode = "wechat",
  ): Promise<void> {
    const normalized = content.trim();
    if (!normalized) throw new Error("主动消息不能为空。");
    await this.withAgentDeliveryLease(userId, agentId, async () => {
      const expectedGeneration = await this.withAgentLock(
        userId,
        agentId,
        async () => {
          const registry = await this.getRegistry(userId);
          requireAgentById(registry, agentId);
          return this.captureDataGeneration(userId, agentId);
        },
      );
      let finalization: Promise<void> | undefined;
      const finalizeDelivery = () => {
        finalization ??= this.withAgentLock(
          userId,
          agentId,
          async () => {
            if (
              !this.isDataGenerationCurrent(
                userId,
                agentId,
                expectedGeneration,
              )
            ) {
              throw new Error(
                "主动消息发送期间 Agent 数据已被清除，未写入旧记忆。",
              );
            }
            const registry = await this.getRegistry(userId);
            requireAgentById(registry, agentId);
            await this.appendOutboundMessageLocked(
              userId,
              agentId,
              normalized,
              conversationMode,
            );
          },
        );
        return finalization;
      };
      await send(finalizeDelivery);
      // Custom transports may not support in-queue finalization. Production
      // transports call it inside the adapter queue; this is a safe fallback.
      await finalizeDelivery();
    });
  }

  async withExistingAgentLease<T>(
    userId: string,
    agentId: string,
    action: (agent: AgentProfile) => Promise<T>,
  ): Promise<T> {
    return this.withAgentLock(userId, agentId, async () => {
      const registry = await this.getRegistry(userId);
      return action(requireAgentById(registry, agentId));
    });
  }

  private async appendOutboundMessageLocked(
    userId: string,
    agentId: string,
    content: string,
    conversationMode: AgentConversationMode,
  ): Promise<void> {
    const existing = await this.getMemoryContext(userId, agentId);
    const messages = withMessageIds(existing.messages, agentId);
    const now = new Date().toISOString();
    const message: AgentMemoryMessage & { id: string } = {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      createdAt: now,
      conversationMode,
    };
    await this.ensureHistoryInitialized(userId, agentId, messages);
    await this.appendPrivateHistory(userId, agentId, [message]);
    messages.push({
      ...message,
      content: trimMemoryContent(message.content),
    });
    const curatorEpisodes = await this.getCuratorEpisodesLocked(
      userId,
      agentId,
      existing,
    );
    const memory: AgentMemory = {
      version: 3,
      agentId,
      updatedAt: now,
      messages,
      summary: existing.summary,
      facts: existing.facts,
      episodes: curatorEpisodes,
      archivedMessageCount: existing.archivedMessageCount,
      totalMessageCount: existing.totalMessageCount + 1,
      compressionCount: existing.compressionCount,
      ...(existing.lastCompressionAt
        ? { lastCompressionAt: existing.lastCompressionAt }
        : {}),
    };
    await this.writePrivateJson(this.memoryPath(userId, agentId), memory);
  }

  async prepareMemoryCompression(
    userId: string,
    agentId: string,
    expectedGeneration?: number,
  ): Promise<AgentMemoryCompressionCandidate | null> {
    return this.withAgentLock(userId, agentId, async () => {
      if (!this.isDataGenerationCurrent(userId, agentId, expectedGeneration)) {
        return null;
      }
      const existing = await this.getMemoryContext(userId, agentId);
      if (existing.messages.length <= this.maxMemoryMessages) return null;
      const messages = withMessageIds(existing.messages, agentId);
      const turns = splitMemoryTurns(messages);
      let retainedMessages = 0;
      let retainedTurns = 0;
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (!turn) continue;
        retainedMessages += turn.length;
        retainedTurns += 1;
        if (retainedMessages >= this.retainRecentMessages) break;
      }
      const eligibleTurns = turns.slice(
        0,
        Math.max(0, turns.length - retainedTurns),
      );
      if (!eligibleTurns.length) return null;
      const selected: typeof messages = [];
      let selectedChars = 0;
      for (const turn of eligibleTurns) {
        const nextChars = turn.reduce(
          (total, message) => total + message.content.length,
          0,
        );
        if (
          selected.length > 0 &&
          selectedChars + nextChars > this.compressionBatchChars
        ) {
          break;
        }
        selected.push(...turn);
        selectedChars += nextChars;
      }
      if (!selected.length) return null;
      await this.persistMessageIdsIfNeeded(userId, agentId, existing, messages);
      return {
        messages: selected,
        previousSummary: existing.summary,
        previousFacts: existing.facts,
        previousEpisodes: existing.episodes.slice(
          0,
          MAX_COMPRESSION_CONTEXT_EPISODES,
        ),
      };
    });
  }

  async applyMemoryCompression(
    userId: string,
    agentId: string,
    candidate: AgentMemoryCompressionCandidate,
    result: AgentMemoryCompressionResult,
    expectedGeneration?: number,
  ): Promise<boolean> {
    return this.withAgentLock(userId, agentId, async () => {
      if (!this.isDataGenerationCurrent(userId, agentId, expectedGeneration)) {
        return false;
      }
      const existing = await this.getMemoryContext(userId, agentId);
      const summaryArchive = await this.getMemorySummaryArchiveLocked(
        userId,
        agentId,
      );
      const rebuilt = await this.readJson<AgentMemoryEpisodeRebuildSnapshot>(
        this.memoryEpisodeRebuildPath(userId, agentId),
      );
      const validRebuilt = rebuilt?.agentId === agentId ? rebuilt : null;
      const messages = withMessageIds(existing.messages, agentId);
      const compressedIds = new Set(candidate.messages.map((message) => message.id));
      const actuallyCompressed = messages.filter((message) =>
        compressedIds.has(message.id),
      ).length;
      if (!actuallyCompressed) return false;
      const now = new Date().toISOString();
      const summary = trimSummary(result.summary);
      const facts = normalizeCompressedFacts(result.facts, now);
      const curatedEpisodes = normalizeCompressedEpisodes(result.episodes, now);
      const latestCuratorArchive =
        summaryArchive.snapshots.at(-1)?.episodes ?? [];
      const activeCuratorEpisodes = removeReconstructedLayer(
        existing.episodes,
        validRebuilt?.episodes ?? [],
        latestCuratorArchive,
        MAX_ACTIVE_MEMORY_EPISODES,
      );
      const archivedEpisodes = mergeMemoryEpisodes(
        latestCuratorArchive.length
          ? latestCuratorArchive
          : activeCuratorEpisodes,
        curatedEpisodes,
        MAX_ARCHIVED_MEMORY_EPISODES,
      );
      const currentCuratorEpisodes = mergeMemoryEpisodes(
        activeCuratorEpisodes,
        curatedEpisodes,
        MAX_ACTIVE_MEMORY_EPISODES,
      );
      const archivedMessageCount =
        existing.archivedMessageCount + actuallyCompressed;
      const sequence = existing.compressionCount + 1;
      const compressedMessages = messages.filter((message) =>
        compressedIds.has(message.id),
      );
      const snapshot: AgentMemorySummarySnapshot = {
        version: 1,
        agentId,
        sequence,
        createdAt: now,
        compressedMessageCount: actuallyCompressed,
        archivedMessageCount,
        compressedMessageIds: compressedMessages.map((message) => message.id),
        ...(compressedMessages[0]?.createdAt
          ? { sourceStartedAt: compressedMessages[0].createdAt }
          : {}),
        ...(compressedMessages.at(-1)?.createdAt
          ? { sourceEndedAt: compressedMessages.at(-1)!.createdAt }
          : {}),
        summary,
        facts,
        episodes: archivedEpisodes,
      };
      // Write the fixed-sequence snapshot first. It remains hidden until the
      // current memory's compressionCount commits the same sequence.
      await this.writePrivateJson(
        this.memorySummarySnapshotPath(userId, agentId, sequence),
        snapshot,
      );
      const memory: AgentMemory = {
        version: 3,
        agentId,
        updatedAt: now,
        messages: messages.filter((message) => !compressedIds.has(message.id)),
        summary,
        facts,
        episodes: currentCuratorEpisodes,
        archivedMessageCount,
        totalMessageCount: existing.totalMessageCount,
        compressionCount: sequence,
        lastCompressionAt: now,
      };
      await this.writePrivateJson(this.memoryPath(userId, agentId), memory);
      return true;
    });
  }

  async applyLocalMemoryCompression(
    userId: string,
    agentId: string,
    candidate: AgentMemoryCompressionCandidate,
    expectedGeneration?: number,
  ): Promise<boolean> {
    return this.applyMemoryCompression(
      userId,
      agentId,
      candidate,
      {
        summary: compactSummary(candidate.previousSummary, candidate.messages),
        facts: candidate.previousFacts.map(({ key, value }) => ({ key, value })),
        episodes: candidate.previousEpisodes.map(
          ({
            sourceKey,
            sourceMessageId,
            sourceOrder,
            occurredAt,
            occurrencePrecision,
            title,
            content,
            importance,
          }) => ({
            ...(sourceKey ? { sourceKey } : {}),
            ...(sourceMessageId ? { sourceMessageId } : {}),
            ...(sourceOrder !== undefined ? { sourceOrder } : {}),
            ...(occurredAt ? { occurredAt } : {}),
            ...(occurrencePrecision ? { occurrencePrecision } : {}),
            title,
            content,
            importance,
          }),
        ),
      },
      expectedGeneration,
    );
  }

  async getHistory(
    userId: string,
    agentId: string,
  ): Promise<AgentMemoryMessage[]> {
    const registry = await this.getRegistry(userId);
    requireAgentById(registry, agentId);
    const existing = await this.getMemoryContext(userId, agentId);
    await this.ensureHistoryInitialized(
      userId,
      agentId,
      withMessageIds(existing.messages, agentId),
    );
    try {
      const raw = await readFile(this.historyPath(userId, agentId), "utf8");
      const messages = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentMemoryMessage);
      return withMessageIds(messages, agentId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async clearActiveMemory(userId: string): Promise<AgentProfile> {
    const agent = await this.getActiveAgent(userId);
    await this.clearAgentData(userId, agent.id);
    return agent;
  }

  async clearMemoryByAgentId(
    userId: string,
    agentId: string,
  ): Promise<AgentProfile> {
    const registry = await this.getRegistry(userId);
    const agent = requireAgentById(registry, agentId);
    await this.clearAgentData(userId, agent.id);
    return agent;
  }

  private async clearAgentData(userId: string, agentId: string): Promise<void> {
    await this.withAgentDeliveryLease(userId, agentId, () =>
      this.withAgentLock(userId, agentId, async () => {
        this.bumpAgentDataGeneration(userId, agentId);
        await rm(this.memoryPath(userId, agentId), { force: true });
        await rm(this.historyPath(userId, agentId), { force: true });
        await rm(this.memorySummaryDir(userId, agentId), {
          recursive: true,
          force: true,
        });
        await rm(this.memoryEpisodeRebuildPath(userId, agentId), {
          force: true,
        });
        await rm(this.memoryMajorEventIndexPath(userId, agentId), {
          force: true,
        });
        await this.onClearAgentData?.(userId, agentId);
      })
    );
  }

  private async saveRegistry(
    userId: string,
    registry: UserAgentRegistry,
  ): Promise<void> {
    await this.writePrivateJson(this.registryPath(userId), registry);
  }

  private registryPath(userId: string): string {
    return path.join(this.userDir(userId), "profiles.json");
  }

  private memoryPath(userId: string, agentId: string): string {
    return path.join(this.userDir(userId), "memory", `${agentId}.json`);
  }

  private storyBookPath(userId: string, agentId: string): string {
    return path.join(this.userDir(userId), "story-books", `${agentId}.json`);
  }

  private historyPath(userId: string, agentId: string): string {
    return path.join(this.userDir(userId), "history", `${agentId}.jsonl`);
  }

  private memorySummaryDir(userId: string, agentId: string): string {
    return path.join(this.userDir(userId), "memory-summaries", agentId);
  }

  private memoryEpisodeRebuildPath(userId: string, agentId: string): string {
    return path.join(
      this.userDir(userId),
      "memory-episode-rebuilds",
      `${agentId}.json`,
    );
  }

  private memoryMajorEventIndexPath(userId: string, agentId: string): string {
    return path.join(
      this.userDir(userId),
      "memory-major-events",
      `${agentId}.json`,
    );
  }

  private memorySummarySnapshotPath(
    userId: string,
    agentId: string,
    sequence: number,
  ): string {
    return path.join(
      this.memorySummaryDir(userId, agentId),
      `${String(sequence).padStart(8, "0")}.json`,
    );
  }

  private userDir(userId: string): string {
    const hash = crypto
      .createHash("sha256")
      .update(userId)
      .digest("hex")
      .slice(0, 24);
    return path.join(this.rootDir, hash);
  }

  private async getStoryBookLocked(
    userId: string,
    agentId: string,
  ): Promise<AgentStoryBook> {
    const stored = await this.readJson<AgentStoryBook>(
      this.storyBookPath(userId, agentId),
    );
    if (!stored) {
      return {
        version: 1,
        agentId,
        updatedAt: "1970-01-01T00:00:00.000Z",
        stories: [],
      };
    }
    if (
      stored.version !== 1 ||
      stored.agentId !== agentId ||
      typeof stored.updatedAt !== "string" ||
      !Array.isArray(stored.stories)
    ) {
      throw new Error("故事书数据格式无效。");
    }
    if (stored.stories.length > MAX_STORIES_PER_AGENT) {
      throw new Error("故事书条目数量超过支持范围。");
    }
    return {
      version: 1,
      agentId,
      updatedAt: stored.updatedAt,
      stories: stored.stories.map((story) =>
        normalizeStoredStoryBookEntry(story)
      ),
    };
  }

  /**
   * Reads the committed summary view while the caller owns this Agent's lock.
   * Keeping this separate avoids nested acquisition by archive/rebuild paths.
   */
  private async getMemorySummaryArchiveLocked(
    userId: string,
    agentId: string,
  ): Promise<AgentMemorySummaryArchive> {
    const current = await this.readJson<AgentMemory>(
      this.memoryPath(userId, agentId),
    );
    const compressionCount = current?.compressionCount ?? 0;
    let entries: Dirent[];
    try {
      entries = await readdir(this.memorySummaryDir(userId, agentId), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        entries = [];
      } else {
        throw error;
      }
    }
    const snapshots: Array<AgentMemorySummarySnapshot | null> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      snapshots.push(
        await this.readJson<AgentMemorySummarySnapshot>(
          path.join(this.memorySummaryDir(userId, agentId), entry.name),
        ),
      );
    }
    const committed = snapshots
      .filter(
        (snapshot): snapshot is AgentMemorySummarySnapshot =>
          snapshot !== null &&
          snapshot.agentId === agentId &&
          Number.isInteger(snapshot.sequence) &&
          snapshot.sequence >= 1 &&
          snapshot.sequence <= compressionCount,
      )
      .sort((a, b) => a.sequence - b.sequence);
    const rebuilt = await this.readJson<AgentMemoryEpisodeRebuildSnapshot>(
      this.memoryEpisodeRebuildPath(userId, agentId),
    );
    const validRebuilt = rebuilt?.agentId === agentId ? rebuilt : null;
    const sanitized = committed.map((snapshot) => ({
      ...snapshot,
      episodes: validRebuilt
        ? removeReconstructedLayer(
            snapshot.episodes,
            validRebuilt.episodes,
            [],
            MAX_ARCHIVED_MEMORY_EPISODES,
          )
        : snapshot.episodes,
    }));
    if (
      current &&
      compressionCount >= 1 &&
      !sanitized.some((snapshot) => snapshot.sequence === compressionCount)
    ) {
      const latestCuratorEpisodes = sanitized.at(-1)?.episodes ?? [];
      const curatorEpisodes = validRebuilt
        ? removeReconstructedLayer(
            current.episodes ?? [],
            validRebuilt.episodes,
            latestCuratorEpisodes,
            MAX_ARCHIVED_MEMORY_EPISODES,
          )
        : current.episodes ?? [];
      const baseline: AgentMemorySummarySnapshot = {
        version: 1,
        agentId,
        sequence: compressionCount,
        createdAt: current.lastCompressionAt ?? new Date().toISOString(),
        compressedMessageCount: current.archivedMessageCount ?? 0,
        archivedMessageCount: current.archivedMessageCount ?? 0,
        compressedMessageIds: [],
        summary: current.summary ?? "",
        facts: current.facts ?? [],
        episodes: curatorEpisodes,
        migratedBaseline: true,
      };
      await this.writePrivateJson(
        this.memorySummarySnapshotPath(userId, agentId, compressionCount),
        baseline,
      );
      sanitized.push(baseline);
    }
    return {
      compressionCount,
      snapshots: sanitized,
    };
  }

  private async getCuratorEpisodesLocked(
    userId: string,
    agentId: string,
    memory: Pick<AgentMemoryContext, "episodes" | "compressionCount">,
  ): Promise<AgentMemoryEpisode[]> {
    const rebuilt = await this.readJson<AgentMemoryEpisodeRebuildSnapshot>(
      this.memoryEpisodeRebuildPath(userId, agentId),
    );
    if (rebuilt?.agentId !== agentId) return [...memory.episodes];
    const rawFallback = memory.compressionCount >= 1
      ? await this.readJson<AgentMemorySummarySnapshot>(
          this.memorySummarySnapshotPath(
            userId,
            agentId,
            memory.compressionCount,
          ),
        )
      : null;
    const fallback = rawFallback?.agentId === agentId
      ? removeReconstructedLayer(
          rawFallback.episodes,
          rebuilt.episodes,
          [],
          MAX_ARCHIVED_MEMORY_EPISODES,
        )
      : [];
    return removeReconstructedLayer(
      memory.episodes,
      rebuilt.episodes,
      fallback,
      MAX_ACTIVE_MEMORY_EPISODES,
    );
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`无法读取 Agent 状态：${String(error)}`, {
        cause: error,
      });
    }
  }

  private async writePrivateJson(
    filePath: string,
    value: unknown,
  ): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  }

  private async ensureHistoryInitialized(
    userId: string,
    agentId: string,
    messages: readonly AgentMemoryMessage[],
  ): Promise<void> {
    const filePath = this.historyPath(userId, agentId);
    try {
      await readFile(filePath, "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(
      filePath,
      messages.length
        ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
        : "",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await chmod(filePath, 0o600);
  }

  private async appendPrivateHistory(
    userId: string,
    agentId: string,
    messages: readonly AgentMemoryMessage[],
  ): Promise<void> {
    const filePath = this.historyPath(userId, agentId);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await appendFile(
      filePath,
      `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(filePath, 0o600);
  }

  private async persistMessageIdsIfNeeded(
    userId: string,
    agentId: string,
    existing: AgentMemoryContext,
    messages: Array<AgentMemoryMessage & { id: string }>,
  ): Promise<void> {
    if (existing.messages.every((message) => message.id)) return;
    const now = new Date().toISOString();
    const curatorEpisodes = await this.getCuratorEpisodesLocked(
      userId,
      agentId,
      existing,
    );
    const memory: AgentMemory = {
      version: 3,
      agentId,
      updatedAt: now,
      messages,
      summary: existing.summary,
      facts: existing.facts,
      episodes: curatorEpisodes,
      archivedMessageCount: existing.archivedMessageCount,
      totalMessageCount: existing.totalMessageCount,
      compressionCount: existing.compressionCount,
      ...(existing.lastCompressionAt
        ? { lastCompressionAt: existing.lastCompressionAt }
        : {}),
    };
    await this.writePrivateJson(this.memoryPath(userId, agentId), memory);
  }

  private async withAgentLock<T>(
    userId: string,
    agentId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = this.agentLockKey(userId, agentId);
    const previous = this.agentLocks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.agentLocks.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.agentLocks.get(key) === tail) this.agentLocks.delete(key);
    }
  }

  private async withRegistryLock<T>(
    userId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.registryLocks.get(userId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.registryLocks.set(userId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.registryLocks.get(userId) === tail) {
        this.registryLocks.delete(userId);
      }
    }
  }

  private async withAgentDeliveryLease<T>(
    userId: string,
    agentId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = this.agentLockKey(userId, agentId);
    const previous =
      this.agentDeliveryLeases.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.agentDeliveryLeases.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.agentDeliveryLeases.get(key) === tail) {
        this.agentDeliveryLeases.delete(key);
      }
    }
  }

  private agentLockKey(userId: string, agentId: string): string {
    return `${userId}\0${agentId}`;
  }

  private isDataGenerationCurrent(
    userId: string,
    agentId: string,
    expectedGeneration: number | undefined,
  ): boolean {
    return expectedGeneration === undefined ||
      expectedGeneration === this.captureDataGeneration(userId, agentId);
  }

  private bumpAgentDataGeneration(userId: string, agentId: string): void {
    const key = this.agentLockKey(userId, agentId);
    this.agentDataGenerations.set(key, (this.agentDataGenerations.get(key) ?? 0) + 1);
  }
}

function requireActiveAgent(registry: UserAgentRegistry): AgentProfile {
  const active = registry.agents.find(
    (agent) => agent.id === registry.activeAgentId,
  );
  if (!active) throw new Error("当前 Agent 状态无效。");
  return active;
}

function requireAgentById(
  registry: UserAgentRegistry,
  agentId: string,
): AgentProfile {
  const agent = registry.agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error("没有找到指定 Agent。");
  return agent;
}

function findAgentByName(
  registry: UserAgentRegistry,
  name: string,
): AgentProfile | undefined {
  const normalized = name.toLocaleLowerCase();
  return registry.agents.find(
    (agent) => agent.name.toLocaleLowerCase() === normalized,
  );
}

function validateName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Agent 名称不能为空。");
  if (name.length > 80) throw new Error("Agent 名称不能超过 80 个字符。");
  if (/[\r\n\u0000-\u001f]/.test(name)) {
    throw new Error("Agent 名称不能包含换行或控制字符。");
  }
  return name;
}

function validateIdentity(value: string): string {
  const identity = value.trim();
  if (!identity) throw new Error("Agent 身份描述不能为空。");
  if (identity.length > 20_000) {
    throw new Error("Agent 身份描述不能超过 20000 个字符。");
  }
  return identity;
}

function trimMemoryContent(value: string): string {
  const maxLength = 8_000;
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}…`;
}

function withMessageIds(
  messages: readonly AgentMemoryMessage[],
  agentId: string,
): Array<AgentMemoryMessage & { id: string }> {
  return messages.map((message, index) => ({
    ...message,
    id:
      message.id ??
      crypto
        .createHash("sha256")
        .update(
          `${agentId}\0${message.createdAt}\0${message.role}\0${index}\0${message.content}`,
        )
        .digest("hex")
        .slice(0, 24),
  }));
}

function splitMemoryTurns<T extends AgentMemoryMessage>(
  messages: readonly T[],
): T[][] {
  const turns: T[][] = [];
  let current: T[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) turns.push(current);
  return turns;
}

function trimSummary(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 8_000 ? normalized : normalized.slice(-8_000);
}

function compactSummary(
  previous: string,
  archived: readonly AgentMemoryMessage[],
): string {
  if (!archived.length) return previous;
  const additions = archived.map((message) => {
    const role = message.role === "user" ? "用户" : "角色";
    const content = message.content.replace(/\s+/g, " ").trim();
    return `- ${role}：${content.slice(0, 240)}${content.length > 240 ? "…" : ""}`;
  });
  const combined = [previous.trim(), ...additions].filter(Boolean).join("\n");
  return combined.length <= 6_000 ? combined : combined.slice(-6_000);
}

function extractFacts(input: string, now: string): AgentMemoryFact[] {
  const normalized = input.replace(/\s+/g, " ").trim();
  const patterns: Array<{ key: string; expression: RegExp }> = [
    { key: "姓名", expression: /(?:我叫|我的名字是)\s*([^，。！？,.!?]{1,30})/ },
    { key: "身份", expression: /我是(?:一名|一个|一位)?\s*([^，。！？,.!?]{2,60})/ },
    { key: "偏好", expression: /我(?:很|最)?喜欢\s*([^，。！？,.!?]{1,80})/ },
    { key: "不喜欢", expression: /我(?:很|最)?不喜欢\s*([^，。！？,.!?]{1,80})/ },
    { key: "重要事项", expression: /请记住[：:\s]*([^。！？.!?]{2,160})/ },
  ];
  const facts: AgentMemoryFact[] = [];
  for (const pattern of patterns) {
    const match = normalized.match(pattern.expression);
    const value = match?.[1]?.trim();
    if (!value) continue;
    facts.push({
      id: crypto.createHash("sha256").update(`${pattern.key}\0${value}`).digest("hex").slice(0, 16),
      key: pattern.key,
      value,
      source: normalized.slice(0, 240),
      updatedAt: now,
    });
  }
  return facts;
}

function mergeFacts(
  existing: readonly AgentMemoryFact[],
  incoming: readonly AgentMemoryFact[],
): AgentMemoryFact[] {
  const merged = new Map(existing.map((fact) => [`${fact.key}\0${fact.value}`, fact]));
  for (const fact of incoming) merged.set(`${fact.key}\0${fact.value}`, fact);
  return [...merged.values()].slice(-100);
}

function normalizeCompressedFacts(
  facts: readonly { key: string; value: string }[],
  now: string,
): AgentMemoryFact[] {
  const normalized = facts
    .map(({ key, value }) => ({ key: key.trim(), value: value.trim() }))
    .filter(({ key, value }) => key && value)
    .slice(-100);
  return normalized.map(({ key, value }) => ({
    id: crypto
      .createHash("sha256")
      .update(`${key}\0${value}`)
      .digest("hex")
      .slice(0, 16),
    key: key.slice(0, 80),
    value: value.slice(0, 500),
    source: "LLM 记忆压缩",
    updatedAt: now,
  }));
}

function normalizeCompressedEpisodes(
  episodes: readonly {
    sourceKey?: string;
    sourceMessageId?: string;
    sourceOrder?: number;
    occurredAt?: string;
    occurrencePrecision?: "message" | "batch";
    title: string;
    content: string;
    importance: 1 | 2 | 3 | 4 | 5;
  }[],
  now: string,
  limit = 50,
): AgentMemoryEpisode[] {
  return episodes
    .map((episode) => {
      const title = episode.title.trim().slice(0, 100);
      const content = episode.content.trim().slice(0, 1_000);
      const sourceKey =
        normalizeMemoryEpisodeSourceKey(episode.sourceKey) ||
        automaticMemoryEpisodeSourceKey(title, content);
      const sourceMessageId = normalizeMemoryEpisodeSourceMessageId(
        episode.sourceMessageId,
      );
      const sourceOrder = normalizeMemoryEpisodeSourceOrder(
        episode.sourceOrder,
      );
      const occurredAt = normalizeMemoryEpisodeTimestamp(
        episode.occurredAt,
      );
      const occurrencePrecision = occurredAt
        ? episode.occurrencePrecision === "message" && sourceMessageId
          ? "message" as const
          : "batch" as const
        : undefined;
      return {
        id: crypto
          .createHash("sha256")
          .update(`${title}\0${content}`)
          .digest("hex")
          .slice(0, 16),
        sourceKey,
        title,
        content,
        importance: episode.importance,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceOrder !== undefined ? { sourceOrder } : {}),
        ...(occurredAt ? { occurredAt } : {}),
        ...(occurrencePrecision ? { occurrencePrecision } : {}),
        updatedAt: now,
      };
    })
    .filter((episode) => episode.title && episode.content)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, Math.max(1, limit));
}

function mergeMemoryEpisodes(
  existing: readonly AgentMemoryEpisode[],
  incoming: readonly AgentMemoryEpisode[],
  limit = MAX_ACTIVE_MEMORY_EPISODES,
): AgentMemoryEpisode[] {
  const merged = new Map<string, AgentMemoryEpisode>();
  const existingTitleKeys = new Map<string, string | null>();
  for (const episode of existing) {
    const key = memoryEpisodeKey(episode);
    merged.set(key, {
      ...episode,
      ...(episode.sourceKey ? { sourceKey: episode.sourceKey } : {}),
    });
    const titleKey = memoryEpisodeLegacyTitleKey(episode.title);
    existingTitleKeys.set(
      titleKey,
      existingTitleKeys.has(titleKey) ? null : key,
    );
  }
  for (const episode of incoming) {
    let key = memoryEpisodeKey(episode);
    // The current parser cannot yet carry a model-supplied key. For an
    // automatic-key item, a single pre-existing exact-title event is treated
    // as its correction. The alias is consumed once, so two same-title events
    // in one new batch remain distinct. Explicit source keys never use this
    // heuristic.
    if (!merged.has(key) && episode.sourceKey?.startsWith("auto:")) {
      const titleKey = memoryEpisodeLegacyTitleKey(episode.title);
      const existingKey = existingTitleKeys.get(titleKey);
      if (existingKey) {
        key = existingKey;
        existingTitleKeys.delete(titleKey);
      }
    }
    const previous = merged.get(key);
    const sourceKey = previous?.sourceKey ?? episode.sourceKey;
    const sourceMessageId =
      episode.sourceMessageId ?? previous?.sourceMessageId;
    const sourceOrder = episode.sourceOrder ?? previous?.sourceOrder;
    const occurredAt = episode.occurredAt ?? previous?.occurredAt;
    const occurrencePrecision =
      episode.occurrencePrecision ?? previous?.occurrencePrecision;
    merged.set(key, {
      ...episode,
      id: previous?.id ?? episode.id,
      ...(sourceKey ? { sourceKey } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(sourceOrder !== undefined ? { sourceOrder } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      ...(occurrencePrecision ? { occurrencePrecision } : {}),
    });
  }
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.importance - a.importance ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.title.localeCompare(b.title, "zh-CN"),
    )
    .slice(0, Math.max(1, limit));
}

function removeReconstructedLayer(
  active: readonly AgentMemoryEpisode[],
  reconstructed: readonly AgentMemoryEpisode[],
  curatorFallback: readonly AgentMemoryEpisode[],
  limit: number,
): AgentMemoryEpisode[] {
  if (!reconstructed.length) {
    return mergeMemoryEpisodes(active, curatorFallback, limit);
  }
  const reconstructedByKey = new Map(
    reconstructed.map((episode) => [memoryEpisodeKey(episode), episode]),
  );
  const fallbackKeys = new Set(
    curatorFallback.map((episode) => memoryEpisodeKey(episode)),
  );
  const withoutReconstructed = active.filter((episode) => {
    const key = memoryEpisodeKey(episode);
    const rebuilt = reconstructedByKey.get(key);
    if (!rebuilt) return true;
    if (fallbackKeys.has(key)) return false;
    // Older stores merged a rebuilt value into active memory while preserving
    // the curator event's id. A differing id is therefore evidence that this
    // event existed independently and must not be removed with the rebuild.
    return episode.id !== rebuilt.id;
  });
  return mergeMemoryEpisodes(withoutReconstructed, curatorFallback, limit);
}

function memoryEpisodeKey(
  episode: Pick<AgentMemoryEpisode, "id" | "sourceKey" | "title">,
): string {
  return episode.sourceKey?.trim() ||
    memoryEpisodeLegacyTitleKey(episode.title) ||
    `id:${episode.id}`;
}

function normalizeMemoryEpisodeSourceKey(
  sourceKey: string | undefined,
): string {
  const normalized = sourceKey?.normalize("NFKC").trim().slice(0, 200);
  if (!normalized) return "";
  if (/^(?:curator|auto):[a-f0-9]{24}$/u.test(normalized)) {
    return normalized;
  }
  return `curator:${crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 24)}`;
}

function normalizeMemoryEpisodeSourceMessageId(
  sourceMessageId: string | undefined,
): string {
  if (typeof sourceMessageId !== "string") return "";
  return sourceMessageId.normalize("NFKC").trim().slice(0, 200);
}

function normalizeMemoryEpisodeSourceOrder(
  sourceOrder: number | undefined,
): number | undefined {
  return typeof sourceOrder === "number" &&
      Number.isSafeInteger(sourceOrder) &&
      sourceOrder >= 0
    ? sourceOrder
    : undefined;
}

function normalizeMemoryEpisodeTimestamp(
  value: string | undefined,
): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  const timestamp = Date.parse(normalized);
  if (!normalized || !Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toISOString();
}

function automaticMemoryEpisodeSourceKey(
  title: string,
  content: string,
): string {
  return `auto:${crypto
    .createHash("sha256")
    .update(
      `${normalizeMemoryEpisodeText(title)}\0${normalizeMemoryEpisodeText(content)}`,
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function memoryEpisodeLegacyTitleKey(title: string): string {
  const normalizedTitle = normalizeMemoryEpisodeText(title);
  if (!normalizedTitle) return "";
  return `legacy-title:${crypto
    .createHash("sha256")
    .update(normalizedTitle)
    .digest("hex")
    .slice(0, 24)}`;
}

function normalizeMemoryEpisodeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/gu, " ");
}

function memoryEpisodeArchiveFingerprint(
  episodes: readonly AgentMemoryArchivedEpisode[],
): string {
  return memoryEpisodeFingerprint(episodes);
}

function memoryEpisodeFingerprint(
  episodes: readonly AgentMemoryEpisode[],
): string {
  const canonical = episodes
    .map((episode) => ({
      sourceKey: episode.sourceKey ?? memoryEpisodeKey(episode),
      title: episode.title,
      content: episode.content,
      importance: episode.importance,
      sourceMessageId: episode.sourceMessageId ?? "",
      sourceOrder: episode.sourceOrder ?? null,
      occurredAt: episode.occurredAt ?? "",
      occurrencePrecision: episode.occurrencePrecision ?? "",
    }))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function assertMajorEventDraftCoverage(
  groups: readonly AgentMemoryMajorEventDraft[],
  expectedDetailKeys: readonly string[],
): void {
  const expected = new Map<string, string>();
  for (const key of expectedDetailKeys) {
    const canonical = normalizeMemoryEpisodeSourceKey(key);
    if (canonical) expected.set(canonical, key);
  }
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const group of groups) {
    for (const key of group.detailKeys) {
      const canonical = normalizeMemoryEpisodeSourceKey(key);
      if (!canonical || !expected.has(canonical)) {
        unknown += 1;
        continue;
      }
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    }
  }
  const missing = [...expected.keys()].filter((key) => !counts.has(key));
  const duplicate = [...counts.values()].filter((count) => count > 1).length;
  if (missing.length || duplicate || unknown) {
    throw new Error(
      `大事件整理结果遗漏了 ${missing.length} 条事件细节，另有重复 ${duplicate} 条、未知引用 ${unknown} 条；已保留原有分组。`,
    );
  }
}

function findMajorEventChronologyProblem(
  groups: readonly AgentMemoryMajorEvent[],
  episodes: readonly AgentMemoryArchivedEpisode[],
  sourceMessageCount: number,
): string {
  const byKey = new Map(
    episodes.map((episode) => [
      episode.sourceKey ?? memoryEpisodeKey(episode),
      episode,
    ]),
  );
  const maximumSpan = Math.max(
    120,
    Math.ceil(Math.max(0, sourceMessageCount) * 0.25),
  );
  const maximumGap = Math.max(
    80,
    Math.ceil(Math.max(0, sourceMessageCount) * 0.10),
  );
  for (const group of groups) {
    const orders = group.detailKeys
      .map((key) =>
        normalizeMemoryEpisodeSourceOrder(byKey.get(key)?.sourceOrder)
      )
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    if (orders.length < 2) continue;
    if (orders.at(-1)! - orders[0]! > maximumSpan) {
      return `大事件“${group.title}”跨越了过多历史阶段`;
    }
    if (
      orders.some(
        (order, index) =>
          index > 0 && order - orders[index - 1]! > maximumGap,
      )
    ) {
      return `大事件“${group.title}”包含时间上断开的事件细节`;
    }
  }
  return "";
}

function normalizeMajorEvents(
  drafts: readonly AgentMemoryMajorEventDraft[],
  episodes: readonly AgentMemoryArchivedEpisode[],
  previous: readonly AgentMemoryMajorEvent[],
  now: string,
): AgentMemoryMajorEvent[] {
  const knownDetailKeys = new Map<string, string>();
  for (const episode of episodes) {
    const key = episode.sourceKey ?? memoryEpisodeKey(episode);
    knownDetailKeys.set(key, key);
    knownDetailKeys.set(normalizeMemoryEpisodeSourceKey(key), key);
  }
  const previousKeys = previous.map((group) => ({
    group,
    keys: new Set(group.detailKeys),
  }));
  const claimedPrevious = new Set<string>();
  const assignedDetails = new Set<string>();
  const normalizedDrafts = drafts
    .map((draft) => ({
      draft,
      detailKeys: [...new Set(
        draft.detailKeys
          .map((key) =>
            knownDetailKeys.get(key) ??
            knownDetailKeys.get(normalizeMemoryEpisodeSourceKey(key))
          )
          .filter((key): key is string => Boolean(key)),
      )],
    }))
    .filter(({ detailKeys }) => detailKeys.length > 0)
    .sort(
      (a, b) =>
        b.detailKeys.length - a.detailKeys.length ||
        b.draft.importance - a.draft.importance ||
        a.draft.title.localeCompare(b.draft.title, "zh-CN"),
    );
  const groups: AgentMemoryMajorEvent[] = [];

  for (const { draft, detailKeys: candidateKeys } of normalizedDrafts) {
    const detailKeys = candidateKeys.filter(
      (key) => !assignedDetails.has(key),
    );
    if (!detailKeys.length) continue;
    let matched: AgentMemoryMajorEvent | undefined;
    let overlap = 0;
    for (const candidate of previousKeys) {
      if (claimedPrevious.has(candidate.group.sourceKey)) continue;
      const score = detailKeys.reduce(
        (total, key) => total + Number(candidate.keys.has(key)),
        0,
      );
      if (score > overlap) {
        overlap = score;
        matched = candidate.group;
      }
    }
    const anchor = [...detailKeys].sort()[0]!;
    const sourceKey = matched?.sourceKey ??
      `major:${crypto
        .createHash("sha256")
        .update(anchor)
        .digest("hex")
        .slice(0, 24)}`;
    const id = matched?.id ??
      crypto.createHash("sha256").update(sourceKey).digest("hex").slice(0, 16);
    const title = draft.title.trim().slice(0, 120) || "未命名大事件";
    const summary =
      draft.summary.trim().slice(0, 2_000) ||
      episodes.find((episode) =>
        detailKeys.includes(episode.sourceKey ?? memoryEpisodeKey(episode))
      )?.content.slice(0, 800) ||
      title;
    const importance = Math.min(
      5,
      Math.max(1, Math.round(Number(draft.importance) || 1)),
    ) as 1 | 2 | 3 | 4 | 5;
    const status =
      draft.status === "ongoing" ||
        draft.status === "resolved" ||
        draft.status === "uncertain"
        ? draft.status
        : "uncertain";
    groups.push({
      id,
      sourceKey,
      title,
      summary,
      importance,
      status,
      detailKeys,
      updatedAt: now,
    });
    detailKeys.forEach((key) => assignedDetails.add(key));
    if (matched) claimedPrevious.add(matched.sourceKey);
  }

  return groups
    .sort(
      (a, b) =>
        b.importance - a.importance ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.title.localeCompare(b.title, "zh-CN"),
    )
    .slice(0, MAX_MEMORY_MAJOR_EVENTS);
}

function materializeMajorEvents(
  groups: readonly AgentMemoryMajorEvent[],
  episodes: readonly AgentMemoryArchivedEpisode[],
): {
  majorEvents: AgentMemoryArchivedMajorEvent[];
  ungroupedEpisodeCount: number;
} {
  const byKey = new Map(
    episodes.map((episode) => [
      episode.sourceKey ?? memoryEpisodeKey(episode),
      episode,
    ]),
  );
  const assigned = new Set<string>();
  const majorEvents = groups
    .map((group): AgentMemoryArchivedMajorEvent | null => {
      const details = group.detailKeys
        .map((key) => byKey.get(key))
        .filter(
          (episode): episode is AgentMemoryArchivedEpisode =>
            episode !== undefined && !assigned.has(
              episode.sourceKey ?? memoryEpisodeKey(episode),
            ),
        )
        .sort(
          (a, b) =>
            compareMemoryEpisodeChronology(a, b) ||
            a.title.localeCompare(b.title, "zh-CN"),
        );
      if (!details.length) return null;
      details.forEach((episode) =>
        assigned.add(episode.sourceKey ?? memoryEpisodeKey(episode))
      );
      const firstSeenAt = details.reduce(
        (earliest, episode) =>
          Date.parse(episode.firstSeenAt) < Date.parse(earliest)
            ? episode.firstSeenAt
            : earliest,
        details[0]!.firstSeenAt,
      );
      const lastSeenAt = details.reduce(
        (latest, episode) =>
          Date.parse(episode.lastSeenAt) > Date.parse(latest)
            ? episode.lastSeenAt
            : latest,
        details[0]!.lastSeenAt,
      );
      const occurred = details
        .map((episode) => normalizeMemoryEpisodeTimestamp(episode.occurredAt))
        .filter(Boolean)
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      const sourceOrders = details
        .map((episode) => normalizeMemoryEpisodeSourceOrder(
          episode.sourceOrder,
        ))
        .filter((value): value is number => value !== undefined)
        .sort((a, b) => a - b);
      return {
        ...group,
        details,
        currentlyActive: details.some((episode) => episode.currentlyActive),
        firstSeenAt,
        lastSeenAt,
        ...(sourceOrders[0] !== undefined
          ? { firstSourceOrder: sourceOrders[0] }
          : {}),
        ...(sourceOrders.at(-1) !== undefined
          ? { lastSourceOrder: sourceOrders.at(-1)! }
          : {}),
        ...(occurred[0] ? { firstOccurredAt: occurred[0] } : {}),
        ...(occurred.at(-1) ? { lastOccurredAt: occurred.at(-1)! } : {}),
      };
    })
    .filter(
      (group): group is AgentMemoryArchivedMajorEvent => group !== null,
    )
    .sort(
      (a, b) =>
        (a.lastSourceOrder !== undefined &&
            b.lastSourceOrder !== undefined
          ? b.lastSourceOrder - a.lastSourceOrder
          : Date.parse(b.lastOccurredAt ?? b.lastSeenAt) -
            Date.parse(a.lastOccurredAt ?? a.lastSeenAt)) ||
        b.importance - a.importance ||
        a.title.localeCompare(b.title, "zh-CN"),
    );
  return {
    majorEvents,
    ungroupedEpisodeCount: Math.max(0, episodes.length - assigned.size),
  };
}

function memoryEpisodeChronologyTimestamp(
  episode: Pick<AgentMemoryEpisode, "occurredAt" | "updatedAt"> & {
    firstSeenAt?: string;
  },
): number {
  const preferred = normalizeMemoryEpisodeTimestamp(episode.occurredAt);
  if (preferred) return Date.parse(preferred);
  const fallback = episode.firstSeenAt ?? episode.updatedAt;
  const timestamp = Date.parse(fallback);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareMemoryEpisodeChronology(
  left: Pick<
    AgentMemoryEpisode,
    "id" | "sourceKey" | "sourceOrder" | "occurredAt" | "updatedAt" | "title"
  > & { firstSeenAt?: string },
  right: Pick<
    AgentMemoryEpisode,
    "id" | "sourceKey" | "sourceOrder" | "occurredAt" | "updatedAt" | "title"
  > & { firstSeenAt?: string },
): number {
  const leftOrder = normalizeMemoryEpisodeSourceOrder(left.sourceOrder);
  const rightOrder = normalizeMemoryEpisodeSourceOrder(right.sourceOrder);
  if (
    leftOrder !== undefined &&
    rightOrder !== undefined &&
    leftOrder !== rightOrder
  ) {
    return leftOrder - rightOrder;
  }
  const timeDifference =
    memoryEpisodeChronologyTimestamp(left) -
    memoryEpisodeChronologyTimestamp(right);
  if (timeDifference) return timeDifference;
  if (leftOrder !== undefined && rightOrder === undefined) return -1;
  if (leftOrder === undefined && rightOrder !== undefined) return 1;
  return memoryEpisodeKey(left).localeCompare(memoryEpisodeKey(right));
}

function normalizeStoryBookEntry(
  story: Pick<AgentStoryBookEntry, "title" | "premise" | "content">,
): Pick<AgentStoryBookEntry, "title" | "premise" | "content"> {
  const normalized = {
    title: boundedStoryText(
      story.title,
      "故事标题",
      MAX_STORY_TITLE_CHARACTERS,
    ),
    premise: boundedStoryText(
      story.premise,
      "剧情构想",
      MAX_STORY_PREMISE_CHARACTERS,
    ),
    content: boundedStoryText(
      story.content,
      "故事正文",
      MAX_STORY_CONTENT_CHARACTERS,
    ),
  };
  if (!normalized.title && !normalized.premise && !normalized.content) {
    throw new Error("故事标题、剧情构想和正文不能全部为空。");
  }
  return normalized;
}

function normalizeStoredStoryBookEntry(value: unknown): AgentStoryBookEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("故事书条目格式无效。");
  }
  const story = value as Partial<AgentStoryBookEntry>;
  if (
    typeof story.id !== "string" ||
    !story.id.trim() ||
    typeof story.createdAt !== "string" ||
    typeof story.updatedAt !== "string"
  ) {
    throw new Error("故事书条目缺少必要字段。");
  }
  const normalized = normalizeStoryBookEntry(
    {
      title: story.title ?? "",
      premise: story.premise ?? "",
      content: story.content ?? "",
    },
  );
  return {
    id: story.id,
    ...normalized,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
  };
}

function boundedStoryText(
  value: unknown,
  label: string,
  maxCharacters: number,
): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本。`);
  const text = value.trim();
  if (Array.from(text).length > maxCharacters) {
    throw new Error(`${label}不能超过 ${maxCharacters} 个字符。`);
  }
  return text;
}

function nextUpdatedAt(previous: string): string {
  const previousTime = Date.parse(previous);
  const nextTime = Number.isFinite(previousTime)
    ? Math.max(Date.now(), previousTime + 1)
    : Date.now();
  return new Date(nextTime).toISOString();
}

function normalizeStoredMessageTime(
  candidate: string | undefined,
  fallback: string,
): string {
  if (!candidate) return fallback;
  const parsed = new Date(candidate);
  const timestamp = parsed.getTime();
  if (
    !Number.isFinite(timestamp) ||
    parsed.getUTCFullYear() < 2020 ||
    parsed.getUTCFullYear() > 2200
  ) {
    return fallback;
  }
  return parsed.toISOString();
}

function toEven(value: number): number {
  const integer = Math.floor(value);
  return integer - (integer % 2);
}
