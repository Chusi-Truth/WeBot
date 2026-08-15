import type { AgentProfile } from "./agent-types.js";
import { AgentStore } from "./agent-store.js";
import {
  ToolRegistry,
  WEATHER_CURRENT_TOOL_NAME,
  type ToolExecutionResult,
} from "./tool-registry.js";
import {
  WeatherScheduleStore,
  type WeatherScheduleConfig,
  type WeatherScheduleSnapshot,
} from "./weather-schedule-store.js";

const HOUR_MS = 60 * 60_000;

export interface WeatherDeliveryContext {
  contextToken: string;
  recordedAt: string;
}

export interface WeatherAdminSnapshot extends WeatherScheduleSnapshot {
  deliveryAvailable: boolean;
  deliveryState: "unavailable" | "fresh" | "stale";
  nextRunAt?: string;
}

export interface WeatherPreview {
  message: string;
  weather: Readonly<Record<string, unknown>>;
}

export interface ScheduledWeatherFacts {
  location: string;
  forecastDay: "today";
  date: string;
  conditionZh: string;
  temperatureMinC: number | null;
  temperatureMaxC: number | null;
  precipitationProbabilityMaxPercent: number | null;
  windSpeedMaxKmh: number | null;
}

export interface WeatherCommentGenerationRequest {
  userId: string;
  agent: AgentProfile;
  weather: ScheduledWeatherFacts;
  /** Recent Agent-authored WeChat replies used only as voice references. */
  voiceSamples: readonly string[];
}

export type WeatherMessageTone =
  | "neutral"
  | "cool_caring"
  | "gentle"
  | "playful"
  | "energetic"
  | "formal"
  | "quiet"
  | "wry";

export interface WeatherScheduleAdminRuntime {
  getAdminSnapshot(
    userId: string,
    agentId: string,
  ): Promise<WeatherAdminSnapshot>;
  updateAdminConfig(
    userId: string,
    agentId: string,
    config: WeatherScheduleConfig,
  ): Promise<WeatherAdminSnapshot>;
  previewAdmin(userId: string, agentId: string): Promise<WeatherPreview>;
  sendAdminNow(userId: string, agentId: string): Promise<WeatherAdminSnapshot>;
}

export interface WeatherSchedulerOptions {
  stateDir: string;
  agents: AgentStore;
  tools: ToolRegistry;
  getDeliveryContext: (
    userId: string,
  ) => Promise<WeatherDeliveryContext | null>;
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
  /** Generates one short in-character line appended after immutable facts. */
  generateComment?: (
    params: WeatherCommentGenerationRequest,
  ) => Promise<string>;
  logger?: Pick<Console, "info" | "warn" | "error">;
  tickMs?: number;
  catchUpMinutes?: number;
  contextMaxAgeHours?: number;
  now?: () => Date;
  deliveryEnabled?: boolean;
}

export class WeatherScheduler implements WeatherScheduleAdminRuntime {
  private readonly store: WeatherScheduleStore;
  private readonly agents: AgentStore;
  private readonly tools: ToolRegistry;
  private readonly getDeliveryContext: WeatherSchedulerOptions["getDeliveryContext"];
  private readonly sendText: WeatherSchedulerOptions["sendText"];
  private readonly selectTone: WeatherSchedulerOptions["selectTone"];
  private readonly generateComment: WeatherSchedulerOptions["generateComment"];
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly tickMs: number;
  private readonly catchUpMinutes: number;
  private readonly contextMaxAgeMs: number;
  private readonly now: () => Date;
  private readonly deliveryEnabled: boolean;
  private readonly inFlight = new Set<string>();
  private readonly toneCache = new Map<
    string,
    { agentUpdatedAt: string; tone: WeatherMessageTone }
  >();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: WeatherSchedulerOptions) {
    this.store = new WeatherScheduleStore(options.stateDir);
    this.agents = options.agents;
    this.tools = options.tools;
    this.getDeliveryContext = options.getDeliveryContext;
    this.sendText = options.sendText;
    this.selectTone = options.selectTone;
    this.generateComment = options.generateComment;
    this.logger = options.logger ?? console;
    this.tickMs = options.tickMs ?? 60_000;
    this.catchUpMinutes = Math.max(0, options.catchUpMinutes ?? 180);
    this.contextMaxAgeMs =
      Math.max(1, options.contextMaxAgeHours ?? 24) * HOUR_MS;
    this.now = options.now ?? (() => new Date());
    this.deliveryEnabled = options.deliveryEnabled ?? true;
  }

  start(): void {
    if (this.timer || !this.deliveryEnabled) return;
    this.timer = setInterval(() => void this.runDueTasks(), this.tickMs);
    this.timer.unref();
    setTimeout(() => void this.runDueTasks(), 10_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async getAdminSnapshot(
    userId: string,
    agentId: string,
  ): Promise<WeatherAdminSnapshot> {
    await this.requireUserAgent(userId, agentId);
    const snapshot = await this.store.getSnapshot(userId, agentId);
    const context = await this.getDeliveryContext(userId);
    const deliveryState = this.deliveryState(context);
    return {
      ...snapshot,
      deliveryAvailable: this.deliveryEnabled && deliveryState === "fresh",
      deliveryState: this.deliveryEnabled ? deliveryState : "unavailable",
      ...(snapshot.enabled && snapshot.location
        ? {
            nextRunAt: nextLocalRun(
              this.now(),
              snapshot.localTime,
              snapshot.timeZone,
            ),
          }
        : {}),
    };
  }

  async updateAdminConfig(
    userId: string,
    agentId: string,
    config: WeatherScheduleConfig,
  ): Promise<WeatherAdminSnapshot> {
    const normalized = validateConfig(config);
    await this.agents.withExistingAgentLease(userId, agentId, async () => {
      await this.store.updateConfig(
        userId,
        agentId,
        normalized,
        this.now().toISOString(),
      );
    });
    return this.getAdminSnapshot(userId, agentId);
  }

  async previewAdmin(
    userId: string,
    agentId: string,
  ): Promise<WeatherPreview> {
    const agent = await this.requireUserAgent(userId, agentId);
    const snapshot = await this.store.getSnapshot(userId, agentId);
    if (!snapshot.location) throw new Error("请先填写天气地点。");
    return this.createPreview(userId, agent, snapshot.location);
  }

  async sendAdminNow(
    userId: string,
    agentId: string,
  ): Promise<WeatherAdminSnapshot> {
    if (!this.deliveryEnabled) {
      throw new Error("当前仅启动了管理后台，不能发送微信消息。");
    }
    const agent = await this.requireUserAgent(userId, agentId);
    const snapshot = await this.store.getSnapshot(userId, agentId);
    if (!snapshot.location) throw new Error("请先填写并保存天气地点。");
    await this.deliver({
      userId,
      agent,
      location: snapshot.location,
      source: "manual",
    });
    return this.getAdminSnapshot(userId, agentId);
  }

  async runDueTasks(): Promise<void> {
    const users = await this.agents.listUsers().catch((error: unknown) => {
      this.logger.error("读取天气任务用户列表失败：", error);
      return [];
    });
    for (const user of users) {
      const registry = await this.agents.getRegistry(user.userId);
      for (const agent of registry.agents) {
        try {
          await this.maybeRunScheduled(user.userId, agent);
        } catch (error) {
          this.logger.error(
            `每日天气任务失败（${user.userId}/${agent.id}）：`,
            error,
          );
        }
      }
    }
  }

  private async maybeRunScheduled(
    userId: string,
    agent: AgentProfile,
  ): Promise<void> {
    const snapshot = await this.store.getSnapshot(userId, agent.id);
    if (!snapshot.enabled || !snapshot.location) return;
    const slot = localSlot(this.now(), snapshot.timeZone);
    const scheduledMinute = parseLocalTime(snapshot.localTime);
    const currentDateHasReachedTarget =
      slot.minuteOfDay >= scheduledMinute;
    const targetLocalDate = currentDateHasReachedTarget
      ? slot.localDate
      : addUtcDate(slot.localDate, -1);
    const elapsedMinutes = currentDateHasReachedTarget
      ? slot.minuteOfDay - scheduledMinute
      : slot.minuteOfDay + 24 * 60 - scheduledMinute;
    if (
      !scheduledOccurrenceFollowsConfiguration(
        snapshot,
        targetLocalDate,
        scheduledMinute,
      )
    ) {
      return;
    }
    if (snapshot.lastLocalDate === targetLocalDate) {
      if (snapshot.lastStatus !== "waiting_context") return;
    }
    if (elapsedMinutes > this.catchUpMinutes) {
      if (
        currentDateHasReachedTarget &&
        (snapshot.lastLocalDate !== targetLocalDate ||
          snapshot.lastStatus === "waiting_context")
      ) {
        await this.store.markSkipped(
          userId,
          agent.id,
          targetLocalDate,
          this.now().toISOString(),
          "已超过今日补发窗口。",
        );
      }
      return;
    }

    const context = await this.getDeliveryContext(userId);
    if (!context || this.deliveryState(context) !== "fresh") {
      await this.store.markWaitingContext(
        userId,
        agent.id,
        targetLocalDate,
        this.now().toISOString(),
      );
      return;
    }
    const claimed = await this.store.claim(
      userId,
      agent.id,
      targetLocalDate,
      this.now().toISOString(),
    );
    if (!claimed) return;
    const key = `${userId}\0${agent.id}`;
    if (this.inFlight.has(key)) {
      await this.store.markWaitingContext(
        userId,
        agent.id,
        targetLocalDate,
        this.now().toISOString(),
      );
      return;
    }
    await this.deliver({
      userId,
      agent,
      location: snapshot.location,
      source: "schedule",
      context,
    });
  }

  private async deliver(params: {
    userId: string;
    agent: AgentProfile;
    location: string;
    source: "manual" | "schedule";
    context?: WeatherDeliveryContext;
  }): Promise<void> {
    const key = `${params.userId}\0${params.agent.id}`;
    if (this.inFlight.has(key)) {
      throw new Error("这个人物已有一项天气任务正在执行。");
    }
    this.inFlight.add(key);
    const occurredAt = this.now().toISOString();
    try {
      const context =
        params.context ?? (await this.getDeliveryContext(params.userId));
      if (this.deliveryState(context) !== "fresh" || !context) {
        throw new Error("没有可用的新鲜微信回复凭证，请先给机器人发一条消息。");
      }
      const preview = await this.createPreview(
        params.userId,
        params.agent,
        params.location,
      );
      // The external weather lookup happens before taking the Agent lease.
      // The lease makes existence-check, API submission and memory append
      // linear with Agent deletion.
      await this.agents.deliverOutboundMessage(
        params.userId,
        params.agent.id,
        preview.message,
        (finalizeDelivery) =>
          this.sendText({
            toUserId: params.userId,
            contextToken: context.contextToken,
            text: preview.message,
            finalizeDelivery,
          }),
      );
      await this.store.complete(params.userId, params.agent.id, {
        status: "api_accepted",
        occurredAt,
        message: preview.message,
      });
      this.logger.info(
        `Agent“${params.agent.name}”已提交每日天气消息（${params.source}）。`,
      );
    } catch (error) {
      await this.store.complete(params.userId, params.agent.id, {
        status: "failed",
        occurredAt,
        error: safeError(error),
      });
      throw error;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async createPreview(
    userId: string,
    agent: AgentProfile,
    location: string,
  ): Promise<WeatherPreview> {
    const result = await this.tools.execute(
      WEATHER_CURRENT_TOOL_NAME,
      { location, forecastDay: "today" },
      { source: "schedule" },
    );
    if (this.generateComment) {
      const weather = extractScheduledWeatherFacts(result);
      const comment = await this.resolveGeneratedComment(
        userId,
        agent,
        weather,
      );
      return {
        message: comment
          ? `${formatWeatherFacts(weather)}\n${comment}`
          : formatWeatherMessage(result, "neutral"),
        weather: result.data,
      };
    }
    const tone = await this.resolveTone(userId, agent);
    return {
      message: formatWeatherMessage(result, tone),
      weather: result.data,
    };
  }

  private async resolveGeneratedComment(
    userId: string,
    agent: AgentProfile,
    weather: ScheduledWeatherFacts,
  ): Promise<string | undefined> {
    try {
      const memory = await this.agents.getMemoryContext(userId, agent.id);
      const voiceSamples = memory.messages
        .filter(
          (message) =>
            message.role === "assistant" &&
            message.conversationMode === "wechat" &&
            !looksLikeScheduledWeatherMessage(message.content),
        )
        .slice(-5)
        .map((message) => message.content.trim().slice(0, 800))
        .filter(Boolean);
      const generated = await this.generateComment!({
        userId,
        agent,
        weather,
        voiceSamples,
      });
      return validateGeneratedWeatherComment(generated, agent);
    } catch (error) {
      this.logger.warn(
        `Agent“${agent.name}”的天气个性短评生成失败，已使用中性模板：`,
        error,
      );
      return undefined;
    }
  }

  private async resolveTone(
    userId: string,
    agent: AgentProfile,
  ): Promise<WeatherMessageTone> {
    if (!this.selectTone) return "neutral";
    const key = `${userId}\0${agent.id}`;
    const cached = this.toneCache.get(key);
    if (cached?.agentUpdatedAt === agent.updatedAt) return cached.tone;
    try {
      const selected = (await this.selectTone({ userId, agent })).trim();
      if (!isWeatherMessageTone(selected)) {
        this.logger.warn(
          `Agent“${agent.name}”返回了无效天气语气，已使用中性模板。`,
        );
        return "neutral";
      }
      this.toneCache.set(key, {
        agentUpdatedAt: agent.updatedAt,
        tone: selected,
      });
      return selected;
    } catch (error) {
      this.logger.warn(
        `Agent“${agent.name}”的天气语气选择失败，已使用中性模板：`,
        error,
      );
      return "neutral";
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

  private deliveryState(
    context: WeatherDeliveryContext | null,
  ): "fresh" | "stale" {
    if (!context) return "stale";
    const recordedAt = Date.parse(context.recordedAt);
    if (!Number.isFinite(recordedAt)) return "stale";
    return this.now().getTime() - recordedAt <= this.contextMaxAgeMs
      ? "fresh"
      : "stale";
  }
}

function validateConfig(
  config: WeatherScheduleConfig,
): WeatherScheduleConfig {
  if (typeof config.enabled !== "boolean") {
    throw new Error("enabled 必须是布尔值。");
  }
  const location = config.location.trim();
  if (!location || location.length > 80) {
    throw new Error("地点必须是 1–80 个字符。");
  }
  if (/[\u0000-\u001f\u007f]/u.test(location) || /:\/\//u.test(location)) {
    throw new Error("地点中包含不允许的内容。");
  }
  const localTime = config.localTime.trim();
  parseLocalTime(localTime);
  const timeZone = config.timeZone.trim();
  assertTimeZone(timeZone);
  return { enabled: config.enabled, location, localTime, timeZone };
}

function parseLocalTime(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match) throw new Error("发送时间必须使用 HH:mm 格式。");
  return Number(match[1]) * 60 + Number(match[2]);
}

function assertTimeZone(value: string): void {
  if (!value || value.length > 100) throw new Error("时区无效。");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error("请输入有效的 IANA 时区，例如 Asia/Shanghai。");
  }
}

function localSlot(
  now: Date,
  timeZone: string,
): { localDate: string; minuteOfDay: number } {
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    localDate: `${part("year")}-${part("month")}-${part("day")}`,
    minuteOfDay: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

function nextLocalRun(now: Date, localTime: string, timeZone: string): string {
  const slot = localSlot(now, timeZone);
  const target = parseLocalTime(localTime);
  const date = slot.minuteOfDay < target
    ? slot.localDate
    : addUtcDate(slot.localDate, 1);
  return `${date} ${localTime} (${timeZone})`;
}

function scheduledOccurrenceFollowsConfiguration(
  snapshot: WeatherScheduleSnapshot,
  targetLocalDate: string,
  scheduledMinute: number,
): boolean {
  if (!snapshot.configuredAt) return true;
  const configuredAt = new Date(snapshot.configuredAt);
  if (!Number.isFinite(configuredAt.getTime())) return false;
  const configuredSlot = localSlot(configuredAt, snapshot.timeZone);
  if (targetLocalDate > configuredSlot.localDate) return true;
  if (targetLocalDate < configuredSlot.localDate) return false;
  return scheduledMinute >= configuredSlot.minuteOfDay;
}

function addUtcDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const WEATHER_TONE_LINES: Readonly<Record<WeatherMessageTone, string>> =
  Object.freeze({
    neutral: "出门前记得看一眼天气变化。",
    cool_caring: "给你看过了。自己留意点，别等出门才后悔。",
    gentle: "我替你看过了，出门前再留意一下。",
    playful: "今日份天气情报送到，记得认真看。",
    energetic: "天气情报送到，今天也打起精神。",
    formal: "今天的天气信息整理好了，请查收。",
    quiet: "我看过了。你出门前再留意一下。",
    wry: "给你查好了，省得你又临出门才想起来。",
  });

function formatWeatherMessage(
  result: ToolExecutionResult,
  tone: WeatherMessageTone,
): string {
  const facts = formatWeatherFacts(extractScheduledWeatherFacts(result));
  const flavor = WEATHER_TONE_LINES[tone];
  return tone === "neutral"
    ? `${facts}${flavor}`
    : `${facts}\n${flavor}`;
}

function extractScheduledWeatherFacts(
  result: ToolExecutionResult,
): ScheduledWeatherFacts {
  const forecast = isRecord(result.data.forecast)
    ? result.data.forecast
    : {};
  return {
    location: String(result.data.location ?? "当地"),
    forecastDay: "today",
    date: typeof forecast.date === "string" ? forecast.date : "",
    conditionZh: String(forecast.conditionZh ?? "天气情况未知"),
    temperatureMinC: finiteNumberOrNull(forecast.temperatureMinC),
    temperatureMaxC: finiteNumberOrNull(forecast.temperatureMaxC),
    precipitationProbabilityMaxPercent: finiteNumberOrNull(
      forecast.precipitationProbabilityMaxPercent,
    ),
    windSpeedMaxKmh: finiteNumberOrNull(forecast.windSpeedMaxKmh),
  };
}

function formatWeatherFacts(weather: ScheduledWeatherFacts): string {
  const min = formatNumber(weather.temperatureMinC);
  const max = formatNumber(weather.temperatureMaxC);
  const rain = formatNumber(weather.precipitationProbabilityMaxPercent);
  const wind = formatNumber(weather.windSpeedMaxKmh);
  return `${weather.location}今天${weather.conditionZh}，${min}～${max}℃，最高降水概率${rain}%，最大风速${wind}km/h。`;
}

function validateGeneratedWeatherComment(
  value: string,
  agent: AgentProfile,
): string {
  const comment = value.trim();
  if (!comment) throw new Error("天气个性短评为空。");
  if ([...comment].length > 160) {
    throw new Error("天气个性短评超过 160 个字符。");
  }
  if (/[\r\n\u0000-\u001f\u007f]/u.test(comment)) {
    throw new Error("天气个性短评必须是单行纯文本。");
  }
  if (/[0-9０-９%％℃°]/u.test(comment)) {
    throw new Error("天气个性短评不得自行复述天气数值。");
  }
  if (
    /(?:https?:\/\/|www\.|\[\[WEBOT_|<START>|\{\{|```|!\[)/iu.test(
      comment,
    )
  ) {
    throw new Error("天气个性短评包含不允许的标记或链接。");
  }
  const names = new Set(
    [agent.name, agent.roleplay?.nickname]
      .map((name) => name?.trim())
      .filter((name): name is string => Boolean(name)),
  );
  if (
    [...names].some(
      (name) =>
        comment.startsWith(`${name}：`) || comment.startsWith(`${name}:`),
    )
  ) {
    throw new Error("天气个性短评不得带人物姓名标签。");
  }
  if (
    /[“”「」『』]/u.test(comment) ||
    /^(?:她|他|它)(?:抬|低|看|望|转|走|站|坐|伸|皱|笑|叹|顿|拿|把|靠|俯|仰)/u.test(
      comment,
    )
  ) {
    throw new Error("天气个性短评不得包含动作或场景旁白。");
  }
  return comment;
}

function looksLikeScheduledWeatherMessage(value: string): boolean {
  return value.includes("最高降水概率") && value.includes("最大风速");
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isWeatherMessageTone(value: string): value is WeatherMessageTone {
  return Object.hasOwn(WEATHER_TONE_LINES, value);
}

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Math.round(value * 10) / 10)
    : "未知";
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
