import type { AgentProfile } from "./agent-types.js";
import { AgentStore } from "./agent-store.js";
import {
  ReminderStore,
  type ReminderItem,
} from "./reminder-store.js";

const HOUR_MS = 60 * 60_000;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export interface ReminderDeliveryContext {
  contextToken: string;
  recordedAt: string;
}

export type ReminderMessageTone =
  | "neutral"
  | "cool_caring"
  | "gentle"
  | "playful"
  | "energetic"
  | "formal"
  | "quiet"
  | "wry";

export interface ReminderSchedulerOptions {
  stateDir: string;
  agents: AgentStore;
  getDeliveryContext: (
    userId: string,
  ) => Promise<ReminderDeliveryContext | null>;
  sendText: (params: {
    toUserId: string;
    contextToken: string;
    text: string;
    finalizeDelivery?: () => Promise<void>;
  }) => Promise<unknown>;
  selectTone?: (params: {
    userId: string;
    agent: AgentProfile;
  }) => Promise<string>;
  logger?: Pick<Console, "info" | "warn" | "error">;
  tickMs?: number;
  catchUpHours?: number;
  contextMaxAgeHours?: number;
  now?: () => Date;
  deliveryEnabled?: boolean;
  timeZone?: string;
}

/**
 * Delivers confirmed, one-shot reminders.
 *
 * A reminder is claimed only after a fresh delivery context is available.
 * Once claimed, every outcome is terminal: an uncertain external submission
 * must never turn into a duplicate reminder on the next scheduler tick.
 */
export class ReminderScheduler {
  readonly timeZone: string;

  private readonly store: ReminderStore;
  private readonly agents: AgentStore;
  private readonly getDeliveryContext: ReminderSchedulerOptions["getDeliveryContext"];
  private readonly sendText: ReminderSchedulerOptions["sendText"];
  private readonly selectTone: ReminderSchedulerOptions["selectTone"];
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly tickMs: number;
  private readonly catchUpMs: number;
  private readonly contextMaxAgeMs: number;
  private readonly now: () => Date;
  private readonly deliveryEnabled: boolean;
  private readonly toneCache = new Map<
    string,
    { agentUpdatedAt: string; tone: ReminderMessageTone }
  >();
  private timer: NodeJS.Timeout | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: ReminderSchedulerOptions) {
    this.store = new ReminderStore(options.stateDir);
    this.agents = options.agents;
    this.getDeliveryContext = options.getDeliveryContext;
    this.sendText = options.sendText;
    this.selectTone = options.selectTone;
    this.logger = options.logger ?? console;
    this.tickMs = Math.max(1, options.tickMs ?? 30_000);
    this.catchUpMs = Math.max(0, options.catchUpHours ?? 24) * HOUR_MS;
    this.contextMaxAgeMs =
      Math.max(1, options.contextMaxAgeHours ?? 24) * HOUR_MS;
    this.now = options.now ?? (() => new Date());
    this.deliveryEnabled = options.deliveryEnabled ?? true;
    this.timeZone = options.timeZone?.trim() || DEFAULT_TIME_ZONE;
    if (this.timeZone !== DEFAULT_TIME_ZONE) {
      throw new Error("当前版本的备忘提醒仅支持 Asia/Shanghai 时区。");
    }
  }

  start(): void {
    if (this.timer || !this.deliveryEnabled) return;
    this.timer = setInterval(() => void this.runDueTasks(), this.tickMs);
    this.timer.unref();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.runDueTasks();
    }, 10_000);
    this.startupTimer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = undefined;
    this.startupTimer = undefined;
  }

  async runDueTasks(): Promise<void> {
    if (!this.deliveryEnabled || this.running) return;
    this.running = true;
    try {
      const users = await this.agents.listUsers().catch((error: unknown) => {
        this.logger.error("读取提醒任务用户列表失败：", error);
        return [];
      });
      const now = this.now();
      for (const user of users) {
        try {
          const [registry, reminders] = await Promise.all([
            this.agents.getRegistry(user.userId),
            this.store.listDue(user.userId, now.toISOString()),
          ]);
          const agentsById = new Map(
            registry.agents.map((agent) => [agent.id, agent] as const),
          );
          for (const reminder of reminders) {
            const agent = agentsById.get(reminder.agentId);
            if (!agent) continue;
            try {
              await this.maybeDeliver(user.userId, agent, reminder, now);
            } catch (error) {
              this.logger.error(
                `提醒任务失败（${agent.id}/${reminder.id}）：`,
                error,
              );
            }
          }
        } catch (error) {
          this.logger.error("读取某位用户的提醒任务失败：", error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async handleNaturalAction(
    userId: string,
    agentId: string,
    input: string,
  ): Promise<string | null> {
    const match =
      /^(确认提醒|取消提醒) ([A-Za-z0-9][A-Za-z0-9_-]{2,63})$/u.exec(input);
    if (!match) return null;
    const action = match[1];
    const id = match[2]!;
    try {
      if (action === "确认提醒") {
        const reminder = await this.agents.withExistingAgentLease(
          userId,
          agentId,
          () =>
            this.store.confirm(
              userId,
              agentId,
              id,
              this.now().toISOString(),
            ),
        );
        return reminder
          ? confirmationText(reminder)
          : `没有找到可确认的提醒候选 ${id}。候选可能已过期，或不属于当前 Agent。`;
      }
      const cancelled = await this.agents.withExistingAgentLease(
        userId,
        agentId,
        () =>
          this.store.cancel(
            userId,
            agentId,
            id,
            this.now().toISOString(),
          ),
      );
      return cancelled
        ? `已取消提醒 ${id}。`
        : `没有找到可取消的提醒 ${id}。`;
    } catch (error) {
      return `提醒操作失败：${safeError(error)}`;
    }
  }

  async handleCommand(
    userId: string,
    agentId: string,
    commandLine: string,
  ): Promise<string> {
    const match = /^\/reminder(?:\s+(\S+))?(?:\s+([\s\S]*))?$/u.exec(
      commandLine.trim(),
    );
    if (!match) return this.helpText();
    const action = (match[1] ?? "help").toLocaleLowerCase();
    const args = (match[2] ?? "").trim();
    try {
      switch (action) {
        case "list":
          return this.listCommand(userId, agentId);
        case "add": {
          const parsed = parseAddCommand(args, this.timeZone, this.now());
          if (!parsed) {
            return "用法：/reminder add <YYYY-MM-DD> <HH:mm> <事项>\n例如：/reminder add 2026-07-30 15:00 交报告";
          }
          const reminder = await this.agents.withExistingAgentLease(
            userId,
            agentId,
            () =>
              this.store.createDirect(
                userId,
                agentId,
                parsed,
                this.now().toISOString(),
              ),
          );
          return confirmationText(reminder);
        }
        case "confirm":
          if (!isReminderId(args)) {
            return "用法：/reminder confirm <短ID>";
          }
          return (
            (await this.handleNaturalAction(
              userId,
              agentId,
              `确认提醒 ${args}`,
            )) ?? "用法：/reminder confirm <短ID>"
          );
        case "cancel":
          if (!isReminderId(args)) {
            return "用法：/reminder cancel <短ID>";
          }
          return (
            (await this.handleNaturalAction(
              userId,
              agentId,
              `取消提醒 ${args}`,
            )) ?? "用法：/reminder cancel <短ID>"
          );
        case "help":
          return this.helpText();
        default:
          return this.helpText();
      }
    } catch (error) {
      return `提醒操作失败：${safeError(error)}`;
    }
  }

  private async listCommand(
    userId: string,
    agentId: string,
  ): Promise<string> {
    const reminders = await this.agents.withExistingAgentLease(
      userId,
      agentId,
      () => this.store.list(userId, agentId),
    );
    const active = reminders
      .filter((reminder) =>
        ["scheduled", "waiting_context", "sending"].includes(reminder.status),
      )
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    if (!active.length) return "当前 Agent 没有待发送的提醒。";
    return [
      "当前 Agent 的提醒：",
      ...active.map(
        (reminder) =>
          `- ${reminder.id}｜${formatReminderTime(reminder.dueAt, reminder.timeZone)}｜${reminder.title}｜${statusLabel(reminder.status)}`,
      ),
    ].join("\n");
  }

  private async maybeDeliver(
    userId: string,
    agent: AgentProfile,
    reminder: ReminderItem,
    now: Date,
  ): Promise<void> {
    const dueAt = Date.parse(reminder.dueAt);
    if (!Number.isFinite(dueAt) || dueAt > now.getTime()) return;
    const elapsed = now.getTime() - dueAt;
    if (elapsed > this.catchUpMs) {
      await this.agents.withExistingAgentLease(userId, agent.id, () =>
        this.store.complete(userId, agent.id, reminder.id, {
          status: "expired",
          occurredAt: now.toISOString(),
          error: `已超过 ${formatCatchUpWindow(this.catchUpMs)}补发窗口。`,
        }),
      );
      return;
    }

    const context = await this.getDeliveryContext(userId);
    if (!this.isFreshContext(context, now) || !context) {
      await this.agents.withExistingAgentLease(userId, agent.id, () =>
        this.store.markWaitingContext(
          userId,
          agent.id,
          reminder.id,
          now.toISOString(),
        ),
      );
      return;
    }

    const tone = await this.resolveTone(userId, agent);
    const readyAt = this.now();
    if (!this.isFreshContext(context, readyAt)) {
      await this.agents.withExistingAgentLease(userId, agent.id, () =>
        this.store.markWaitingContext(
          userId,
          agent.id,
          reminder.id,
          readyAt.toISOString(),
        ),
      );
      return;
    }

    const claimed = await this.agents.withExistingAgentLease(
      userId,
      agent.id,
      () =>
        this.store.claim(
          userId,
          agent.id,
          reminder.id,
          readyAt.toISOString(),
        ),
    );
    if (!claimed) return;

    const message = formatReminderMessage(reminder, tone);
    await this.deliverClaimed(
      userId,
      agent,
      reminder,
      context,
      message,
      readyAt,
    );
  }

  private async deliverClaimed(
    userId: string,
    agent: AgentProfile,
    reminder: ReminderItem,
    context: ReminderDeliveryContext,
    message: string,
    now: Date,
  ): Promise<void> {
    let apiAccepted = false;
    try {
      await this.agents.deliverOutboundMessage(
        userId,
        agent.id,
        message,
        async (finalizeDelivery) => {
          let acceptanceFinalization: Promise<void> | undefined;
          const finalizeAcceptedDelivery = () => {
            acceptanceFinalization ??= (async () => {
              // The iLink request succeeded before this callback runs.
              apiAccepted = true;
              const recorded = await this.store.complete(
                userId,
                agent.id,
                reminder.id,
                {
                  status: "api_accepted",
                  occurredAt: now.toISOString(),
                  message,
                },
              );
              if (!recorded) {
                throw new Error(
                  "提醒发送后无法记录平台接受状态。",
                );
              }
              await finalizeDelivery();
            })();
            return acceptanceFinalization;
          };
          await this.sendText({
            toUserId: userId,
            contextToken: context.contextToken,
            text: message,
            finalizeDelivery: finalizeAcceptedDelivery,
          });
          // Custom/test transports may ignore the optional hook. Production
          // Adapter has already run it here; the callback is idempotent.
          await finalizeAcceptedDelivery();
        },
      );
      this.logger.info(
        `Agent“${agent.name}”已提交提醒消息（${reminder.id}）。`,
      );
    } catch (error) {
      if (apiAccepted) {
        this.logger.error(
          `提醒已由平台接受，但记录状态或写入 Agent 记忆失败（${agent.id}/${reminder.id}）：`,
          error,
        );
        return;
      }
      await this.store
        .complete(userId, agent.id, reminder.id, {
          status: "failed",
          occurredAt: now.toISOString(),
          error: safeError(error),
        })
        .catch((completionError: unknown) => {
          this.logger.error(
            `记录提醒失败状态失败（${agent.id}/${reminder.id}）：`,
            completionError,
          );
        });
      throw error;
    }
  }

  private async resolveTone(
    userId: string,
    agent: AgentProfile,
  ): Promise<ReminderMessageTone> {
    if (!this.selectTone) return "neutral";
    const key = `${userId}\0${agent.id}`;
    const cached = this.toneCache.get(key);
    if (cached?.agentUpdatedAt === agent.updatedAt) return cached.tone;
    try {
      const selected = (await this.selectTone({ userId, agent })).trim();
      if (!isReminderMessageTone(selected)) {
        this.logger.warn(
          `Agent“${agent.name}”返回了无效提醒语气，已使用中性模板。`,
        );
        this.toneCache.set(key, {
          agentUpdatedAt: agent.updatedAt,
          tone: "neutral",
        });
        return "neutral";
      }
      this.toneCache.set(key, {
        agentUpdatedAt: agent.updatedAt,
        tone: selected,
      });
      return selected;
    } catch (error) {
      this.logger.warn(
        `Agent“${agent.name}”的提醒语气选择失败，已使用中性模板：`,
        error,
      );
      this.toneCache.set(key, {
        agentUpdatedAt: agent.updatedAt,
        tone: "neutral",
      });
      return "neutral";
    }
  }

  private isFreshContext(
    context: ReminderDeliveryContext | null,
    now: Date,
  ): boolean {
    if (!context?.contextToken.trim()) return false;
    const recordedAt = Date.parse(context.recordedAt);
    if (!Number.isFinite(recordedAt)) return false;
    const age = now.getTime() - recordedAt;
    return age >= 0 && age <= this.contextMaxAgeMs;
  }

  private helpText(): string {
    return [
      "备忘提醒指令：",
      "/reminder list",
      "/reminder add <YYYY-MM-DD> <HH:mm> <事项>",
      "/reminder confirm <短ID>",
      "/reminder cancel <短ID>",
      "/reminder help",
      "自然确认或取消时，请完整回复“确认提醒 <短ID>”或“取消提醒 <短ID>”。",
      "当前只支持单次提醒；微信主动消息依赖近期会话凭证，不能替代系统闹钟。",
      ...(this.deliveryEnabled
        ? []
        : ["当前进程仅提供管理功能，不会投递微信提醒。"]),
    ].join("\n");
  }
}

const REMINDER_TONE_LINES: Readonly<Record<ReminderMessageTone, string>> =
  Object.freeze({
    neutral: "时间到了，记得处理。",
    cool_caring: "时间到了。你自己让我记着的，别又拖。",
    gentle: "到约定时间了，别着急，记得去处理。",
    playful: "时间到啦，你交给我的提醒可没忘。",
    energetic: "到时间了，行动起来。",
    formal: "已到约定时间，请及时处理。",
    quiet: "到时间了。记得去做。",
    wry: "时间到了。看来这回没法装作忘了。",
  });

function formatReminderMessage(
  reminder: ReminderItem,
  tone: ReminderMessageTone,
): string {
  return [
    `提醒你：${reminder.title}`,
    `约定时间：${formatReminderTime(reminder.dueAt, reminder.timeZone)}`,
    REMINDER_TONE_LINES[tone],
  ].join("\n");
}

function confirmationText(reminder: ReminderItem): string {
  return `已设置提醒 ${reminder.id}：${formatReminderTime(reminder.dueAt, reminder.timeZone)}｜${reminder.title}`;
}

function formatReminderTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function parseAddCommand(
  value: string,
  timeZone: string,
  now: Date,
): { title: string; dueAt: string } | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})\s+([01]\d|2[0-3]):([0-5]\d)\s+([\s\S]+)$/u.exec(
      value,
    );
  if (!match) return null;
  const title = match[4]!.trim();
  if (
    !title ||
    title.length > 200 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(title)
  ) {
    return null;
  }
  const dueAt = zonedDateTimeToIso(
    match[1]!,
    `${match[2]}:${match[3]}`,
    timeZone,
  );
  if (!dueAt || Date.parse(dueAt) <= now.getTime()) return null;
  return { title, dueAt };
}

function zonedDateTimeToIso(
  localDate: string,
  localTime: string,
  timeZone: string,
): string | null {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return null;
  }
  const desiredWallTime = Date.UTC(year, month - 1, day, hour, minute);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return null;
  }
  let instant = desiredWallTime;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localDateTimeParts(new Date(instant), timeZone);
    const observedWallTime = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    const delta = desiredWallTime - observedWallTime;
    if (delta === 0) break;
    instant += delta;
  }
  const finalParts = localDateTimeParts(new Date(instant), timeZone);
  if (
    finalParts.year !== year ||
    finalParts.month !== month ||
    finalParts.day !== day ||
    finalParts.hour !== hour ||
    finalParts.minute !== minute
  ) {
    return null;
  }
  return new Date(instant).toISOString();
}

function localDateTimeParts(
  value: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? NaN);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function formatCatchUpWindow(milliseconds: number): string {
  const hours = milliseconds / HOUR_MS;
  if (Number.isInteger(hours)) return `${hours} 小时`;
  return `${Math.round(milliseconds / 60_000)} 分钟`;
}

function isReminderId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u.test(value);
}

function isReminderMessageTone(
  value: string,
): value is ReminderMessageTone {
  return Object.hasOwn(REMINDER_TONE_LINES, value);
}

function statusLabel(status: ReminderItem["status"]): string {
  switch (status) {
    case "scheduled":
      return "待发送";
    case "waiting_context":
      return "等待近期聊天凭证";
    case "sending":
      return "正在提交";
    case "api_accepted":
      return "平台已接受";
    case "cancelled":
      return "已取消";
    case "expired":
      return "已过补发窗口";
    case "failed":
      return "发送失败";
    default:
      return status;
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
