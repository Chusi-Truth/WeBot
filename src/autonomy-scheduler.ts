import crypto from "node:crypto";

import type {
  AgentAutonomyAdminEvent,
  AgentAutonomyAdminRuntime,
  AgentAutonomyAdminSnapshot,
  AgentAutonomyEvent,
  AgentAutonomyGenerator,
  AgentAutonomyRuntime,
  AgentProfile,
} from "./agent-types.js";
import { AgentStore } from "./agent-store.js";
import { AutonomyStore } from "./autonomy-store.js";
import type { StoredDeliveryContext } from "./autonomy-store.js";

const HOUR_MS = 60 * 60 * 1_000;
const FAILED_EVALUATION_RETRY_MS = 30 * 60_000;

export interface AutonomySchedulerOptions {
  stateDir: string;
  agents: AgentStore;
  generator: AgentAutonomyGenerator;
  sendText: (params: {
    toUserId: string;
    contextToken: string;
    text: string;
  }) => Promise<unknown>;
  /** Trusted bridge to ToolRegistry; never exposed as a model tool. */
  sendAutonomousImage?: (params: {
    userId: string;
    agent: AgentProfile;
    contextToken: string;
    prompt: string;
    includesAgent: boolean;
  }) => Promise<unknown>;
  logger?: Pick<Console, "info" | "warn" | "error">;
  defaultEnabled?: boolean;
  tickMs?: number;
  idleHours?: number;
  generationIntervalHours?: number;
  maxContactsPerDay?: number;
  quietStartHour?: number;
  quietEndHour?: number;
  timeZone?: string;
  contextMaxAgeHours?: number;
  now?: () => Date;
}

export class AutonomyScheduler
  implements AgentAutonomyRuntime, AgentAutonomyAdminRuntime
{
  private readonly store: AutonomyStore;
  private readonly agents: AgentStore;
  private readonly generator: AgentAutonomyGenerator;
  private readonly sendText: AutonomySchedulerOptions["sendText"];
  private readonly sendAutonomousImage:
    | AutonomySchedulerOptions["sendAutonomousImage"]
    | undefined;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly tickMs: number;
  private readonly idleMs: number;
  private readonly generationIntervalMs: number;
  private readonly maxContactsPerDay: number;
  private readonly quietStartHour: number;
  private readonly quietEndHour: number;
  private readonly timeZone: string;
  private readonly contextMaxAgeMs: number;
  private readonly now: () => Date;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: AutonomySchedulerOptions) {
    this.store = new AutonomyStore(
      options.stateDir,
      options.defaultEnabled ?? false,
    );
    this.agents = options.agents;
    this.generator = options.generator;
    this.sendText = options.sendText;
    this.sendAutonomousImage = options.sendAutonomousImage;
    this.logger = options.logger ?? console;
    this.tickMs = options.tickMs ?? 5 * 60_000;
    this.idleMs = (options.idleHours ?? 6) * HOUR_MS;
    this.generationIntervalMs =
      (options.generationIntervalHours ?? 6) * HOUR_MS;
    this.maxContactsPerDay = options.maxContactsPerDay ?? 1;
    this.quietStartHour = options.quietStartHour ?? 22.5;
    this.quietEndHour = options.quietEndHour ?? 9;
    this.timeZone = options.timeZone ?? "Asia/Shanghai";
    this.contextMaxAgeMs =
      Math.max(1, options.contextMaxAgeHours ?? 24) * HOUR_MS;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runDueTasks(), this.tickMs);
    this.timer.unref();
    setTimeout(() => void this.runDueTasks(), 10_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async recordInteraction(userId: string, contextToken: string): Promise<void> {
    await this.store.recordInteraction(
      userId,
      contextToken,
      this.now().toISOString(),
    );
  }

  async getDeliveryContext(
    userId: string,
  ): Promise<StoredDeliveryContext | null> {
    return this.store.getDeliveryContext(userId);
  }

  async getRecentEvents(
    userId: string,
    agentId: string,
    count = 10,
  ): Promise<AgentAutonomyEvent[]> {
    return this.store.getRecentEvents(userId, agentId, count);
  }

  async getAdminSnapshot(
    userId: string,
    agentId: string,
    count = 50,
  ): Promise<AgentAutonomyAdminSnapshot> {
    await this.requireUserAgent(userId, agentId);
    const snapshot = await this.store.getSnapshot(userId, agentId);
    const eventLimit = Number.isFinite(count)
      ? Math.max(1, Math.min(Math.trunc(count), 100))
      : 50;
    return {
      enabled: snapshot.enabled,
      ...(snapshot.enabledAt ? { enabledAt: snapshot.enabledAt } : {}),
      ...(snapshot.lastEvaluatedAt
        ? { lastEvaluatedAt: snapshot.lastEvaluatedAt }
        : {}),
      ...(snapshot.lastGeneratedAt
        ? { lastGeneratedAt: snapshot.lastGeneratedAt }
        : {}),
      ...(snapshot.lastContactAttemptAt
        ? { lastContactAttemptAt: snapshot.lastContactAttemptAt }
        : {}),
      ...(snapshot.lastInteractionAt
        ? { lastInteractionAt: snapshot.lastInteractionAt }
        : {}),
      contactAvailable: this.isFreshContext(
        snapshot.lastContextToken,
        snapshot.lastContextTokenAt,
      ),
      eventCount: snapshot.events.length,
      events: snapshot.events
        .slice(-eventLimit)
        .reverse()
        .map(toAdminEvent),
    };
  }

  async setAdminEnabled(
    userId: string,
    agentId: string,
    enabled: boolean,
  ): Promise<AgentAutonomyAdminSnapshot> {
    await this.requireUserAgent(userId, agentId);
    await this.store.setEnabled(
      userId,
      agentId,
      enabled,
      this.now().toISOString(),
    );
    return this.getAdminSnapshot(userId, agentId);
  }

  async generateAdminEvent(
    userId: string,
    agentId: string,
  ): Promise<AgentAutonomyAdminEvent | null> {
    const agent = await this.requireUserAgent(userId, agentId);
    const event = await this.generateEvent(userId, agent, false);
    return event ? toAdminEvent(event) : null;
  }

  async handleCommand(userId: string, commandLine: string): Promise<string> {
    const [, rest] = splitOnce(commandLine.trim());
    const [action = "status"] = splitOnce(rest.trim());
    const agent = await this.agents.getActiveAgent(userId);
    switch (action.toLocaleLowerCase()) {
      case "on":
        await this.store.setEnabled(
          userId,
          agent.id,
          true,
          this.now().toISOString(),
        );
        return `已开启 Agent“${agent.name}”的自主生活。离线一段时间后，她会形成自己的经历，并可能尝试主动联系你。`;
      case "off":
        await this.store.setEnabled(userId, agent.id, false);
        return `已关闭 Agent“${agent.name}”的自主生活。已有自主记忆会保留。`;
      case "show": {
        const events = await this.store.getRecentEvents(userId, agent.id, 5);
        if (!events.length) return `Agent“${agent.name}”还没有自主经历。`;
        return [
          `Agent“${agent.name}”最近的自主经历：`,
          ...events.map(
            (event) => {
              const details = [
                `重要度 ${event.importance}/5`,
                ...(event.conversationValue
                  ? [`可聊性 ${event.conversationValue}/5`]
                  : []),
              ].join("，");
              return [
                `- ${formatTime(event.createdAt)}｜${event.summary}（${details}）`,
                ...(event.conversationHook
                  ? [`  可聊点：${event.conversationHook}`]
                  : []),
                ...(event.openThread
                  ? [`  未决线索：${event.openThread}`]
                  : []),
              ].join("\n");
            },
          ),
        ].join("\n");
      }
      case "now": {
        const event = await this.generateEvent(userId, agent, false);
        return event
          ? [
              "已生成一段自主经历：",
              event.summary,
              `当前心境：${event.mood}`,
              ...(event.conversationHook
                ? [`可聊点：${event.conversationHook}`]
                : []),
              ...(event.openThread
                ? [`未决线索：${event.openThread}`]
                : []),
            ].join("\n")
          : "当前已有生成任务正在运行，请稍后再试。";
      }
      case "status":
      case "": {
        const snapshot = await this.store.getSnapshot(userId, agent.id);
        return [
          `Agent“${agent.name}”自主生活：${snapshot.enabled ? "已开启" : "未开启"}`,
          `自主经历：${snapshot.events.length} 条`,
          `最近评估：${snapshot.lastEvaluatedAt ? formatTime(snapshot.lastEvaluatedAt) : "暂无"}`,
          `最近生成：${snapshot.lastGeneratedAt ? formatTime(snapshot.lastGeneratedAt) : "暂无"}`,
          `最近主动联系尝试：${snapshot.lastContactAttemptAt ? formatTime(snapshot.lastContactAttemptAt) : "暂无"}`,
          "指令：/life on、/life off、/life show、/life now",
        ].join("\n");
      }
      default:
        return "自主生活指令：\n/life on\n/life off\n/life status\n/life show\n/life now";
    }
  }

  async runDueTasks(): Promise<void> {
    const users = await this.agents.listUsers().catch((error: unknown) => {
      this.logger.error("读取自主生活用户列表失败：", error);
      return [];
    });
    for (const user of users) {
      try {
        const agent = await this.agents.getActiveAgent(user.userId);
        const snapshot = await this.store.getSnapshot(user.userId, agent.id);
        if (!snapshot.enabled) continue;
        const pendingContact = snapshot.events.findLast(
          (event) => event.contactStatus === "pending",
        );
        if (pendingContact) {
          await this.maybeContact(user.userId, agent.id, pendingContact);
        }
        const memory = await this.agents.getMemoryContext(user.userId, agent.id);
        const latestMemoryAt = memory.messages.at(-1)?.createdAt;
        const baseline =
          snapshot.lastInteractionAt ??
          latestMemoryAt ??
          snapshot.enabledAt ??
          this.now().toISOString();
        const nowMs = this.now().getTime();
        if (nowMs - Date.parse(baseline) < this.idleMs) continue;
        const lastEvaluatedAt =
          snapshot.lastEvaluatedAt ?? snapshot.lastGeneratedAt ?? baseline;
        if (nowMs - Date.parse(lastEvaluatedAt) < this.generationIntervalMs) {
          continue;
        }
        if (
          snapshot.lastAttemptAt &&
          (!snapshot.lastEvaluatedAt ||
            Date.parse(snapshot.lastAttemptAt) >
              Date.parse(snapshot.lastEvaluatedAt)) &&
          nowMs - Date.parse(snapshot.lastAttemptAt) <
            Math.min(
              this.generationIntervalMs,
              FAILED_EVALUATION_RETRY_MS,
            )
        ) {
          continue;
        }
        await this.generateEvent(user.userId, agent, true);
      } catch (error) {
        this.logger.error(`自主生活任务失败（${user.userId}）：`, error);
      }
    }
  }

  private async generateEvent(
    userId: string,
    agent: AgentProfile,
    allowContact: boolean,
  ): Promise<AgentAutonomyEvent | null> {
    const key = `${userId}\0${agent.id}`;
    if (this.inFlight.has(key)) return null;
    this.inFlight.add(key);
    try {
      const [memory, snapshot] = await Promise.all([
        this.agents.getMemoryContext(userId, agent.id),
        this.store.getSnapshot(userId, agent.id),
      ]);
      const now = this.now();
      if (allowContact) {
        await this.store.recordAttempt(userId, agent.id, now.toISOString());
      }
      const lastInteraction = snapshot.lastInteractionAt
        ? Date.parse(snapshot.lastInteractionAt)
        : now.getTime();
      const result = await this.generator({
        userId,
        agent,
        memory,
        previousEvents: snapshot.events.slice(-10),
        currentTime: now.toISOString(),
        timeZone: this.timeZone,
        inactiveHours: Math.max(0, (now.getTime() - lastInteraction) / HOUR_MS),
        allowNoEvent: allowContact,
      });
      if (result.outcome === "none") {
        if (!allowContact) {
          throw new Error(
            result.reason
              ? `这段时间没有形成值得记录的新经历：${result.reason}`
              : "这段时间没有形成值得记录的新经历。",
          );
        }
        await this.store.recordEvaluation(userId, agent.id, now.toISOString());
        this.logger.info(
          `Agent“${agent.name}”本轮未形成值得记录的自主经历${result.reason ? `：${result.reason}` : "。"}`,
        );
        return null;
      }
      const contactPending = Boolean(
        allowContact &&
          result.shouldContactUser &&
          result.message &&
          result.importance >= 4,
      );
      const imagePrompt = normalizeAutonomousImagePrompt(result.imagePrompt);
      const imagePending = Boolean(
        contactPending &&
          imagePrompt &&
          agent.imageBehavior?.mode === "natural" &&
          agent.imageBehavior.allowAutonomous === true,
      );
      const event: AgentAutonomyEvent = {
        id: crypto.randomUUID(),
        createdAt: now.toISOString(),
        summary: result.summary,
        mood: result.mood,
        ...(result.eventKind ? { eventKind: result.eventKind } : {}),
        ...(result.conversationValue
          ? { conversationValue: result.conversationValue }
          : {}),
        ...(result.conversationHook
          ? { conversationHook: result.conversationHook }
          : {}),
        ...(result.openThread ? { openThread: result.openThread } : {}),
        ...(result.continuationOf
          ? { continuationOf: result.continuationOf }
          : {}),
        importance: result.importance,
        shouldContactUser: result.shouldContactUser,
        ...(result.contactReason
          ? { contactReason: result.contactReason }
          : {}),
        ...(result.message ? { message: result.message } : {}),
        contactStatus: contactPending ? "pending" : "not_requested",
        ...(imagePending
          ? {
              imagePrompt,
              imageIncludesAgent: result.imageIncludesAgent === true,
              imageStatus: "pending",
            }
          : { imageStatus: "not_requested" }),
      };
      await this.store.appendEvent(userId, agent.id, event);
      this.logger.info(`Agent“${agent.name}”生成自主经历：${event.summary}`);
      if (allowContact) await this.maybeContact(userId, agent.id, event);
      return event;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async maybeContact(
    userId: string,
    agentId: string,
    event: AgentAutonomyEvent,
  ): Promise<void> {
    if (
      !event.shouldContactUser ||
      !event.message ||
      event.importance < 4 ||
      this.isQuietTime(this.now())
    ) {
      return;
    }
    const snapshot = await this.store.getSnapshot(userId, agentId);
    if (!snapshot.enabled) {
      if (event.contactStatus === "pending") {
        await this.store.updateContact(userId, agentId, event.id, {
          status: "not_requested",
        });
      }
      if (event.imageStatus === "pending") {
        await this.store.updateImageDelivery(userId, agentId, event.id, {
          status: "skipped",
          error: "自主生活已关闭，未发送配图。",
        });
      }
      return;
    }
    if (
      !this.isFreshContext(
        snapshot.lastContextToken,
        snapshot.lastContextTokenAt,
      ) ||
      !snapshot.lastContextToken
    ) {
      return;
    }
    if (
      snapshot.lastContactAttemptAt &&
      this.sameLocalDay(snapshot.lastContactAttemptAt, this.now())
    ) {
      const attemptsToday = snapshot.events.filter(
        (candidate) =>
          candidate.contactAttemptedAt &&
          this.sameLocalDay(candidate.contactAttemptedAt, this.now()),
      ).length;
      if (attemptsToday >= this.maxContactsPerDay) return;
    }
    const attemptedAt = this.now().toISOString();
    try {
      await this.sendText({
        toUserId: userId,
        contextToken: snapshot.lastContextToken,
        text: event.message,
      });
      await this.store.updateContact(userId, agentId, event.id, {
        status: "attempted",
        attemptedAt,
      });
    } catch (error) {
      await this.store.updateContact(userId, agentId, event.id, {
        status: "failed",
        attemptedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (event.imageStatus === "pending") {
        await this.store.updateImageDelivery(userId, agentId, event.id, {
          status: "skipped",
          error: "主动联系文字未发送，未尝试配图。",
        });
      }
      this.logger.warn(`Agent 主动联系尝试失败（${userId}）：`, error);
      return;
    }
    await this.trySendAutonomousImage(
      userId,
      agentId,
      event,
      snapshot.lastContextToken,
    );
  }

  private async trySendAutonomousImage(
    userId: string,
    agentId: string,
    event: AgentAutonomyEvent,
    contextToken: string,
  ): Promise<void> {
    if (event.imageStatus !== "pending" || !event.imagePrompt) return;
    if (!this.sendAutonomousImage) {
      await this.store.updateImageDelivery(userId, agentId, event.id, {
        status: "skipped",
        error: "当前运行模式没有启用主动图片投递。",
      });
      return;
    }

    const imageAttemptedAt = this.now().toISOString();
    try {
      const agent = await this.requireUserAgent(userId, agentId);
      if (
        agent.imageBehavior?.mode !== "natural" ||
        agent.imageBehavior.allowAutonomous !== true
      ) {
        await this.store.updateImageDelivery(userId, agentId, event.id, {
          status: "skipped",
          error: "Agent 当前已关闭自主生活配图。",
        });
        return;
      }
      await this.sendAutonomousImage({
        userId,
        agent,
        contextToken,
        prompt: event.imagePrompt,
        includesAgent: event.imageIncludesAgent === true,
      });
      await this.store.updateImageDelivery(userId, agentId, event.id, {
        status: "delivered",
        attemptedAt: imageAttemptedAt,
      });
    } catch (error) {
      await this.store.updateImageDelivery(userId, agentId, event.id, {
        status: "failed",
        attemptedAt: imageAttemptedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      this.logger.warn(`Agent 主动联系配图失败（${userId}）：`, error);
    }
  }

  private async requireUserAgent(
    userId: string,
    agentId: string,
  ): Promise<AgentProfile> {
    const registry = await this.agents.getRegistry(userId);
    const agent = registry.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error("没有找到指定 Agent。");
    return agent;
  }

  private isQuietTime(date: Date): boolean {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(
      parts.find((part) => part.type === "minute")?.value ?? 0,
    );
    const value = hour + minute / 60;
    return this.quietStartHour > this.quietEndHour
      ? value >= this.quietStartHour || value < this.quietEndHour
      : value >= this.quietStartHour && value < this.quietEndHour;
  }

  private sameLocalDay(value: string, date: Date): boolean {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(new Date(value)) === formatter.format(date);
  }

  private isFreshContext(
    contextToken: string | undefined,
    recordedAt: string | undefined,
  ): boolean {
    if (!contextToken || !recordedAt) return false;
    const time = Date.parse(recordedAt);
    return (
      Number.isFinite(time) &&
      this.now().getTime() - time <= this.contextMaxAgeMs
    );
  }
}

function splitOnce(value: string): [string, string] {
  const match = value.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function normalizeAutonomousImagePrompt(value: unknown): string {
  if (typeof value !== "string") return "";
  return Array.from(value.trim())
    .slice(0, 2_000)
    .join("")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .trim();
}

function toAdminEvent(event: AgentAutonomyEvent): AgentAutonomyAdminEvent {
  return {
    id: event.id,
    createdAt: event.createdAt,
    summary: event.summary,
    mood: event.mood,
    ...(event.eventKind ? { eventKind: event.eventKind } : {}),
    ...(event.conversationValue
      ? { conversationValue: event.conversationValue }
      : {}),
    ...(event.conversationHook
      ? { conversationHook: event.conversationHook }
      : {}),
    ...(event.openThread ? { openThread: event.openThread } : {}),
    ...(event.continuationOf
      ? { continuationOf: event.continuationOf }
      : {}),
    importance: event.importance,
    shouldContactUser: event.shouldContactUser,
    ...(event.contactReason ? { contactReason: event.contactReason } : {}),
    ...(event.message ? { message: event.message } : {}),
    contactStatus: event.contactStatus,
    ...(event.contactAttemptedAt
      ? { contactAttemptedAt: event.contactAttemptedAt }
      : {}),
    ...(event.imagePrompt ? { imagePrompt: event.imagePrompt } : {}),
    ...(typeof event.imageIncludesAgent === "boolean"
      ? { imageIncludesAgent: event.imageIncludesAgent }
      : {}),
    ...(event.imageStatus ? { imageStatus: event.imageStatus } : {}),
    ...(event.imageAttemptedAt
      ? { imageAttemptedAt: event.imageAttemptedAt }
      : {}),
  };
}
