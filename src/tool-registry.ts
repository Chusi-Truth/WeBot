import { createHash } from "node:crypto";

import type { AgentImageBehavior } from "./agent-types.js";
import type { ReminderProposal } from "./reminder-store.js";
import { parseReminderTime } from "./reminder-time.js";
import type { GeneratedImageAttachment } from "./types.js";

const WEATHER_TOOL_NAME = "weather_current";
export const WEATHER_CURRENT_TOOL_NAME = WEATHER_TOOL_NAME;
const REMINDER_PROPOSE_NAME = "reminder_propose";
export const REMINDER_PROPOSE_TOOL_NAME = REMINDER_PROPOSE_NAME;
export const IMAGE_GENERATE_TOOL_NAME = "image_generate";
const GEOCODING_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const WEATHER_ALLOWED_HOSTS = Object.freeze([
  "geocoding-api.open-meteo.com",
  "api.open-meteo.com",
] as const);

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024;
const MAX_LOCATION_LENGTH = 80;
const MAX_IMAGE_ARGUMENT_BYTES = 16 * 1024;
const MAX_IMAGE_PROMPT_CHARACTERS = 2_000;
const MAX_IMAGE_PROMPT_BYTES = 8 * 1024;
const MAX_VISUAL_IDENTITY_CHARACTERS = 8_000;
const MAX_VISUAL_IDENTITY_BYTES = 32 * 1024;
const MAX_REVISED_PROMPT_CHARACTERS = 750;
const MAX_REVISED_PROMPT_BYTES = 3_000;
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_GENERATION_SIZES = Object.freeze([
  "1024x1024",
  "1536x1024",
  "1024x1536",
] as const);
const IMAGE_GENERATION_QUALITIES = Object.freeze([
  "low",
  "medium",
  "high",
] as const);
const GENERATED_IMAGE_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
] as const);

export type ImageGenerationSize = (typeof IMAGE_GENERATION_SIZES)[number];
export type ImageGenerationQuality =
  (typeof IMAGE_GENERATION_QUALITIES)[number];

export type ToolInvocationSource = "chat" | "schedule";

export interface ChatCompletionToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: readonly string[];
      additionalProperties: false;
    };
  };
}

export interface ToolAuthorizationMetadata {
  readonly readOnly: boolean;
  readonly allowedSources: readonly ToolInvocationSource[];
  readonly allowedNetworkHosts: readonly string[];
}

export interface ToolDescriptor {
  readonly definition: ChatCompletionToolDefinition;
  readonly authorization: ToolAuthorizationMetadata;
}

export interface ToolExecutionContext {
  source: ToolInvocationSource;
  userId?: string;
  agentId?: string;
  currentUserInput?: string;
  /** Trusted per-Agent policy. It is never accepted from tool arguments. */
  imageBehavior?: AgentImageBehavior;
  acceptGeneratedImage?: (image: GeneratedImageAttachment) => void;
}

export interface ToolExecutionResult {
  readonly name: string;
  readonly source: ToolInvocationSource;
  /** A bounded JSON string suitable for a provider's `tool` message. */
  readonly content: string;
  /** The same parsed, bounded payload for callers that do not need JSON text. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ToolRegistryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  reminders?: ReminderProposalRuntime;
  imageGenerator?: ImageGenerationRuntime;
  /** @deprecated Kept for constructor compatibility; cooldowns are disabled. */
  stateDir?: string;
  now?: () => Date;
}

export interface ReminderProposalRuntime {
  propose(
    userId: string,
    agentId: string,
    input: { title: string; dueAt: string },
    proposedAt?: string,
  ): Promise<ReminderProposal>;
}

export interface ImageGenerationRuntime {
  isAvailable?: () => boolean;
  generate(input: {
    userId: string;
    agentId: string;
    prompt: string;
    size?: ImageGenerationSize;
    quality?: ImageGenerationQuality;
  }): Promise<{
    data: Buffer;
    mimeType: GeneratedImageAttachment["mimeType"];
    revisedPrompt?: string;
  }>;
}

export interface AutonomousImageDeliveryRequest {
  userId: string;
  agentId: string;
  imageBehavior: AgentImageBehavior;
  prompt: string;
  includesAgent: boolean;
  deliver: (image: GeneratedImageAttachment) => Promise<unknown>;
}

export interface AutonomousImageDeliveryResult {
  delivered: true;
}

export type ToolErrorCode =
  | "unknown_tool"
  | "unauthorized_source"
  | "not_authorized"
  | "invalid_arguments"
  | "timeout"
  | "upstream_error"
  | "invalid_upstream_response";

export class ToolExecutionError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

const WEATHER_CURRENT_DESCRIPTOR: ToolDescriptor = Object.freeze({
  definition: Object.freeze({
    type: "function" as const,
    function: Object.freeze({
      name: WEATHER_TOOL_NAME,
      description:
        "查询指定地点今天或明天的天气摘要。当用户询问当前、今日或明日天气时使用。",
      parameters: Object.freeze({
        type: "object" as const,
        properties: Object.freeze({
          location: Object.freeze({
            type: "string",
            description: "城市或地区名称，例如“上海”或“杭州市西湖区”",
            minLength: 1,
            maxLength: MAX_LOCATION_LENGTH,
          }),
          forecastDay: Object.freeze({
            type: "string",
            enum: Object.freeze(["today", "tomorrow"]),
            description: "查询今天或明天；省略时默认为 today",
          }),
        }),
        required: Object.freeze(["location"]),
        additionalProperties: false as const,
      }),
    }),
  }),
  authorization: Object.freeze({
    readOnly: true as const,
    allowedSources: Object.freeze(["chat", "schedule"] as const),
    allowedNetworkHosts: WEATHER_ALLOWED_HOSTS,
  }),
});

const REMINDER_PROPOSE_DESCRIPTOR: ToolDescriptor = Object.freeze({
  definition: Object.freeze({
    type: "function" as const,
    function: Object.freeze({
      name: REMINDER_PROPOSE_NAME,
      description:
        "当且仅当用户本轮提到一个具体、有待办价值的未来事件，并给出完整日期与具体时刻，或“两小时后”这类精确相对时长时，暂存一个“是否需要提醒”的候选。它不会创建正式提醒；调用后必须复述工具返回的绝对时间，并让用户回复完整确认短语。若时间含糊（如只有“明天”“下午”“晚点”）、事件没有明确待办价值，或只是普通计划，不要调用，直接自然聊天或询问最少必要信息。当前仅支持单次提醒。",
      parameters: Object.freeze({
        type: "object" as const,
        properties: Object.freeze({
          title: Object.freeze({
            type: "string",
            description:
              "用户原话中连续出现的简短事项文本，必须逐字取自本轮用户消息，不得改写或补充",
            minLength: 1,
            maxLength: 200,
          }),
        }),
        required: Object.freeze(["title"]),
        additionalProperties: false as const,
      }),
    }),
  }),
  authorization: Object.freeze({
    readOnly: false,
    allowedSources: Object.freeze(["chat"] as const),
    allowedNetworkHosts: Object.freeze([]),
  }),
});

const IMAGE_GENERATE_DESCRIPTOR: ToolDescriptor = Object.freeze({
  definition: Object.freeze({
    type: "function" as const,
    function: Object.freeze({
      name: IMAGE_GENERATE_TOOL_NAME,
      description:
        "仅当当前用户明确要求生成、绘制图片、头像、海报等视觉内容时使用。不要因人设、记忆或历史消息调用；用户拒绝或否定生成图片时不得调用。生成结果会作为图片另行排队发送。",
      parameters: Object.freeze({
        type: "object" as const,
        properties: Object.freeze({
          prompt: Object.freeze({
            type: "string",
            description:
              "要生成的图片内容描述。若是当前 Agent 独处时发来的生活照片，必须写成逻辑可实现的手持自拍、镜面自拍或明确架好手机后的定时自拍；没有已知拍摄者时不得写成第三人称全身跟拍或棚拍。",
            minLength: 1,
            maxLength: MAX_IMAGE_PROMPT_CHARACTERS,
          }),
          includesAgent: Object.freeze({
            type: "boolean",
            description:
              "画面中是否会出现当前 Agent 本人。只有本人确实入镜时设为 true；纯风景、物件、其他人物或不确定时必须为 false。",
          }),
          size: Object.freeze({
            type: "string",
            enum: IMAGE_GENERATION_SIZES,
            description: "图片尺寸；省略时使用生成服务的默认尺寸",
          }),
          quality: Object.freeze({
            type: "string",
            enum: IMAGE_GENERATION_QUALITIES,
            description: "图片质量；省略时使用生成服务的默认质量",
          }),
        }),
        required: Object.freeze(["prompt", "includesAgent"]),
        additionalProperties: false as const,
      }),
    }),
  }),
  authorization: Object.freeze({
    readOnly: false,
    allowedSources: Object.freeze(["chat"] as const),
    allowedNetworkHosts: Object.freeze([]),
  }),
});

const NATURAL_IMAGE_GENERATE_DESCRIPTOR: ToolDescriptor = Object.freeze({
  ...IMAGE_GENERATE_DESCRIPTOR,
  definition: Object.freeze({
    ...IMAGE_GENERATE_DESCRIPTOR.definition,
    function: Object.freeze({
      ...IMAGE_GENERATE_DESCRIPTOR.definition.function,
      description:
        "生成并分享一张新图片。除用户明确要求外，只能在分享角色当下所见场景、正在进行的活动或确有视觉价值的内容时自然使用；不要每轮调用，不要为了展示能力、填补沉默、转移话题或结束对话而调用。用户拒绝、取消或表示不想看图时不得调用。生成结果会作为图片另行排队发送。",
    }),
  }),
});

interface WeatherArguments {
  location: string;
  forecastDay: "today" | "tomorrow";
}

interface ImageGenerationArguments {
  prompt: string;
  includesAgent: boolean;
  size?: ImageGenerationSize;
  quality?: ImageGenerationQuality;
}

interface Coordinates {
  latitude: number;
  longitude: number;
}

interface WeatherPayload extends Readonly<Record<string, unknown>> {
  tool: typeof WEATHER_TOOL_NAME;
  location: string;
  forecastDay: "today" | "tomorrow";
  forecast: {
    date: string;
    weatherCode: number;
    conditionZh: string;
    temperatureMinC: number;
    temperatureMaxC: number;
    precipitationProbabilityMaxPercent: number;
    windSpeedMaxKmh: number;
  };
  attribution: "Open-Meteo";
}

/**
 * Registry for the intentionally small, least-privilege set of built-in tools.
 *
 * Tool arguments remain untrusted even if a provider claims JSON-schema
 * conformance. Every invocation is checked again at runtime.
 */
export class ToolRegistry {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #reminders: ReminderProposalRuntime | undefined;
  readonly #imageGenerator: ImageGenerationRuntime | undefined;
  readonly #now: () => Date;
  readonly #naturalImageGenerationInFlight = new Set<string>();

  constructor(options: ToolRegistryOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = validatePositiveIntegerOption(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      30_000,
      "timeoutMs",
    );
    this.#maxResponseBytes = validatePositiveIntegerOption(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      256 * 1024,
      "maxResponseBytes",
    );
    this.#reminders = options.reminders;
    this.#imageGenerator = options.imageGenerator;
    this.#now = options.now ?? (() => new Date());
  }

  list(
    source: ToolInvocationSource,
    context: Pick<ToolExecutionContext, "imageBehavior"> = {},
  ): readonly ToolDescriptor[] {
    assertInvocationSource(source);
    const result: ToolDescriptor[] = [];
    if (
      WEATHER_CURRENT_DESCRIPTOR.authorization.allowedSources.includes(source)
    ) {
      result.push(WEATHER_CURRENT_DESCRIPTOR);
    }
    if (
      this.#reminders &&
      REMINDER_PROPOSE_DESCRIPTOR.authorization.allowedSources.includes(source)
    ) {
      result.push(REMINDER_PROPOSE_DESCRIPTOR);
    }
    const imageBehavior = normalizeImageBehavior(context.imageBehavior);
    if (
      this.#imageGenerator &&
      this.#imageGenerationAvailable() &&
      imageBehavior.mode !== "off" &&
      IMAGE_GENERATE_DESCRIPTOR.authorization.allowedSources.includes(source)
    ) {
      result.push(
        imageBehavior.mode === "natural"
          ? NATURAL_IMAGE_GENERATE_DESCRIPTOR
          : IMAGE_GENERATE_DESCRIPTOR,
      );
    }
    return result;
  }

  definitionsFor(
    source: ToolInvocationSource,
    context: Pick<ToolExecutionContext, "imageBehavior"> = {},
  ): readonly ChatCompletionToolDefinition[] {
    return this.list(source, context).map(
      (descriptor) => descriptor.definition,
    );
  }

  requiredChatTool(
    input: string,
    context: Pick<ToolExecutionContext, "imageBehavior"> = {},
  ): typeof IMAGE_GENERATE_TOOL_NAME | undefined {
    const imageBehavior = normalizeImageBehavior(context.imageBehavior);
    if (
      imageBehavior.mode === "off" ||
      !this.#imageGenerator ||
      !this.#imageGenerationAvailable()
    ) {
      return undefined;
    }
    const intent = analyzeImageGenerationIntent(input);
    return intent.explicit && !intent.rejected
      ? IMAGE_GENERATE_TOOL_NAME
      : undefined;
  }

  getDescriptor(name: string): ToolDescriptor | undefined {
    if (name === WEATHER_TOOL_NAME) return WEATHER_CURRENT_DESCRIPTOR;
    if (name === REMINDER_PROPOSE_NAME && this.#reminders) {
      return REMINDER_PROPOSE_DESCRIPTOR;
    }
    if (
      name === IMAGE_GENERATE_TOOL_NAME &&
      this.#imageGenerator &&
      this.#imageGenerationAvailable()
    ) {
      return IMAGE_GENERATE_DESCRIPTOR;
    }
    return undefined;
  }

  async execute(
    name: string,
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const source = context?.source;
    assertInvocationSource(source);

    const descriptor = this.getDescriptor(name);
    if (!descriptor) {
      throw new ToolExecutionError(
        "unknown_tool",
        `Tool is not registered: ${safeToolName(name)}`,
      );
    }
    if (!descriptor.authorization.allowedSources.includes(source)) {
      throw new ToolExecutionError(
        "unauthorized_source",
        `Tool ${descriptor.definition.function.name} is not allowed for ${source}`,
      );
    }

    let data: Readonly<Record<string, unknown>>;
    if (name === WEATHER_TOOL_NAME) {
      data = await this.#executeWeather(parseWeatherArguments(rawArguments));
    } else if (name === REMINDER_PROPOSE_NAME) {
      data = await this.#proposeReminder(rawArguments, context);
    } else {
      data = await this.#generateImage(rawArguments, context);
    }
    const content = JSON.stringify(data);
    if (Buffer.byteLength(content, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
      throw new ToolExecutionError(
        "invalid_upstream_response",
        "Tool output exceeded its safety limit",
      );
    }
    return Object.freeze({
      name,
      source,
      content,
      data: Object.freeze(data),
    });
  }

  /**
   * Trusted scheduler-only path for a proactive image. This is deliberately
   * separate from execute(): a model tool call and a generic `schedule`
   * invocation can never reach it. A per-user-and-Agent in-flight guard avoids
   * duplicate concurrent work without imposing a time interval or quota.
   */
  async generateAndDeliverAutonomousImage(
    request: AutonomousImageDeliveryRequest,
  ): Promise<AutonomousImageDeliveryResult> {
    if (!this.#imageGenerator || !this.#imageGenerationAvailable()) {
      throw new ToolExecutionError(
        "unknown_tool",
        "Image generation service is not available",
      );
    }
    if (
      !isPresentIdentity(request.userId) ||
      !isPresentIdentity(request.agentId) ||
      typeof request.deliver !== "function"
    ) {
      throw new ToolExecutionError(
        "not_authorized",
        "自主发图缺少可信的用户、角色或投递授权。",
      );
    }
    const imageBehavior = normalizeImageBehavior(request.imageBehavior);
    if (
      imageBehavior.mode !== "natural" ||
      imageBehavior.allowAutonomous !== true
    ) {
      throw new ToolExecutionError(
        "not_authorized",
        "当前 Agent 未允许自主生活主动配图。",
      );
    }

    const args = parseImageGenerationArguments({
      prompt: request.prompt,
      includesAgent: request.includesAgent,
    });
    const generationKey = imageGenerationKey(request.userId, request.agentId);
    this.#assertNoNaturalImageInFlight(generationKey);
    this.#naturalImageGenerationInFlight.add(generationKey);

    try {
      const generationPrompt = appendTrustedImageConstraints(
        args.prompt,
        args.includesAgent,
        imageBehavior.visualIdentityPrompt,
      );
      let generated: Awaited<ReturnType<ImageGenerationRuntime["generate"]>>;
      try {
        generated = await this.#imageGenerator.generate({
          userId: request.userId,
          agentId: request.agentId,
          prompt: generationPrompt,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "MediaAiModerationError") {
          throw new ToolExecutionError(
            "not_authorized",
            "图片生成服务因内容安全规则拒绝了这次请求。请如实告诉用户这张图片未能生成；不要声称网络、天气、工具卡顿，也不要承诺稍后自动补发。可以请用户换成普通、非性化的画面描述。",
          );
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new ToolExecutionError(
            "timeout",
            "Image generation request timed out",
          );
        }
        if (error instanceof ToolExecutionError) throw error;
        throw new ToolExecutionError(
          "upstream_error",
          "Image generation request failed",
        );
      }

      const image = validateGeneratedImage(generated);
      try {
        await request.deliver({
          data: Buffer.from(image.data),
          mimeType: image.mimeType,
          prompt: args.prompt,
        });
      } catch {
        throw new ToolExecutionError(
          "upstream_error",
          "Generated autonomous image could not be delivered",
        );
      }

      return Object.freeze({ delivered: true });
    } finally {
      this.#naturalImageGenerationInFlight.delete(generationKey);
    }
  }

  async #proposeReminder(
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!this.#reminders) {
      throw new ToolExecutionError(
        "unknown_tool",
        "Reminder service is not configured",
      );
    }
    if (
      context.source !== "chat" ||
      !context.userId ||
      !context.agentId ||
      !context.currentUserInput
    ) {
      throw new ToolExecutionError(
        "unauthorized_source",
        "提醒候选只能由当前聊天消息提出。",
      );
    }
    const title = parseReminderTitle(rawArguments);
    if (!context.currentUserInput.includes(title)) {
      throw new ToolExecutionError(
        "not_authorized",
        "提醒事项必须逐字取自当前用户消息，请先向用户确认事项。",
      );
    }
    const parsedTime = parseReminderTime(context.currentUserInput, {
      now: this.#now(),
    });
    if (!parsedTime.ok) {
      throw new ToolExecutionError("invalid_arguments", parsedTime.message);
    }
    const proposedAt = this.#now().toISOString();
    const proposal = await this.#reminders.propose(
      context.userId,
      context.agentId,
      { title, dueAt: parsedTime.dueAt },
      proposedAt,
    );
    const confirmationCommand = `确认提醒 ${proposal.id}`;
    return {
      ok: true,
      tool: REMINDER_PROPOSE_NAME,
      status: "pending_confirmation",
      proposal: {
        id: proposal.id,
        title: proposal.title,
        dueAt: proposal.dueAt,
        localTime: formatShanghaiTime(proposal.dueAt),
        expiresAt: proposal.expiresAt,
      },
      confirmationCommand,
      instruction: `这只是待确认候选，不是已创建的提醒。请用当前人物的自然语气，准确复述事项和 localTime，并要求用户回复完整的“${confirmationCommand}”。不得声称已经设置成功。`,
    };
  }

  async #generateImage(
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!this.#imageGenerator) {
      throw new ToolExecutionError(
        "unknown_tool",
        "Image generation service is not configured",
      );
    }
    if (
      context.source !== "chat" ||
      !isPresentIdentity(context.userId) ||
      !isPresentIdentity(context.agentId) ||
      typeof context.currentUserInput !== "string" ||
      typeof context.acceptGeneratedImage !== "function"
    ) {
      throw new ToolExecutionError(
        "not_authorized",
        "图片生成需要当前聊天的用户、角色和图片接收器授权。",
      );
    }
    const imageBehavior = normalizeImageBehavior(context.imageBehavior);
    if (imageBehavior.mode === "off") {
      throw new ToolExecutionError(
        "not_authorized",
        "当前 Agent 已关闭图片生成。",
      );
    }

    const intent = analyzeImageGenerationIntent(context.currentUserInput);
    if (intent.rejected) {
      throw new ToolExecutionError(
        "not_authorized",
        "当前用户消息拒绝或取消了图片生成。",
      );
    }
    if (imageBehavior.mode === "explicit" && !intent.explicit) {
      throw new ToolExecutionError(
        "not_authorized",
        "当前用户消息没有明确授权生成图片。",
      );
    }

    const args = parseImageGenerationArguments(rawArguments);

    const naturalInvocation =
      imageBehavior.mode === "natural" && !intent.explicit;
    const generationKey =
      imageBehavior.mode === "natural"
        ? imageGenerationKey(context.userId, context.agentId)
        : undefined;
    if (generationKey) {
      if (naturalInvocation) {
        this.#assertNoNaturalImageInFlight(generationKey);
        this.#naturalImageGenerationInFlight.add(generationKey);
      }
    }

    const generationPrompt = appendTrustedImageConstraints(
      args.prompt,
      args.includesAgent,
      imageBehavior.visualIdentityPrompt,
    );
    let generated: Awaited<ReturnType<ImageGenerationRuntime["generate"]>>;
    try {
      try {
        generated = await this.#imageGenerator.generate({
          userId: context.userId,
          agentId: context.agentId,
          prompt: generationPrompt,
          ...(args.size ? { size: args.size } : {}),
          ...(args.quality ? { quality: args.quality } : {}),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "MediaAiModerationError") {
          throw new ToolExecutionError(
            "not_authorized",
            "图片生成服务因内容安全规则拒绝了这次请求。请如实告诉用户这张图片未能生成；不要声称网络、天气、工具卡顿，也不要承诺稍后自动补发。可以请用户换成普通、非性化的画面描述。",
          );
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new ToolExecutionError(
            "timeout",
            "Image generation request timed out",
          );
        }
        throw new ToolExecutionError(
          "upstream_error",
          "Image generation request failed",
        );
      }

      const image = validateGeneratedImage(generated);
      try {
        context.acceptGeneratedImage({
          data: Buffer.from(image.data),
          mimeType: image.mimeType,
          prompt: args.prompt,
        });
      } catch {
        throw new ToolExecutionError(
          "upstream_error",
          "Generated image could not be queued",
        );
      }
      return {
        success: true,
        queued: true,
      };
    } finally {
      if (naturalInvocation && generationKey) {
        this.#naturalImageGenerationInFlight.delete(generationKey);
      }
    }
  }

  #imageGenerationAvailable(): boolean {
    if (!this.#imageGenerator) return false;
    try {
      return this.#imageGenerator.isAvailable?.() ?? true;
    } catch {
      return false;
    }
  }

  #assertNoNaturalImageInFlight(key: string): void {
    if (this.#naturalImageGenerationInFlight.has(key)) {
      throw new ToolExecutionError(
        "not_authorized",
        "自然发图正在处理中，请不要重复生成。",
      );
    }
  }

  async #executeWeather(args: WeatherArguments): Promise<WeatherPayload> {
    const coordinates = await this.#geocode(args.location);
    const daily = await this.#forecast(coordinates);
    const index = args.forecastDay === "tomorrow" ? 1 : 0;

    const date = readArrayItem(daily.time, index, isIsoDate, "daily.time");
    const weatherCode = readArrayItem(
      daily.weather_code,
      index,
      isKnownWeatherCode,
      "daily.weather_code",
    );
    const temperatureMinC = readArrayItem(
      daily.temperature_2m_min,
      index,
      (value): value is number => isFiniteInRange(value, -100, 70),
      "daily.temperature_2m_min",
    );
    const temperatureMaxC = readArrayItem(
      daily.temperature_2m_max,
      index,
      (value): value is number => isFiniteInRange(value, -100, 70),
      "daily.temperature_2m_max",
    );
    const precipitationProbabilityMaxPercent = readArrayItem(
      daily.precipitation_probability_max,
      index,
      (value): value is number => isFiniteInRange(value, 0, 100),
      "daily.precipitation_probability_max",
    );
    const windSpeedMaxKmh = readArrayItem(
      daily.wind_speed_10m_max,
      index,
      (value): value is number => isFiniteInRange(value, 0, 500),
      "daily.wind_speed_10m_max",
    );

    return {
      tool: WEATHER_TOOL_NAME,
      location: args.location,
      forecastDay: args.forecastDay,
      forecast: {
        date,
        weatherCode,
        conditionZh: weatherCodeToChinese(weatherCode),
        temperatureMinC,
        temperatureMaxC,
        precipitationProbabilityMaxPercent,
        windSpeedMaxKmh,
      },
      attribution: "Open-Meteo",
    };
  }

  async #geocode(location: string): Promise<Coordinates> {
    const url = new URL(GEOCODING_ENDPOINT);
    url.searchParams.set("name", location);
    url.searchParams.set("count", "1");
    url.searchParams.set("language", "zh");
    url.searchParams.set("format", "json");
    assertAllowedWeatherUrl(url);

    const body = await this.#fetchJson(url);
    if (!isPlainRecord(body) || !Array.isArray(body.results)) {
      throw invalidUpstream("Geocoding response has an invalid shape");
    }
    const first = body.results[0];
    if (!isPlainRecord(first)) {
      throw new ToolExecutionError(
        "invalid_upstream_response",
        "No matching weather location was found",
      );
    }
    if (
      !isFiniteInRange(first.latitude, -90, 90) ||
      !isFiniteInRange(first.longitude, -180, 180)
    ) {
      throw invalidUpstream("Geocoding coordinates are invalid");
    }
    return {
      latitude: first.latitude,
      longitude: first.longitude,
    };
  }

  async #forecast(coordinates: Coordinates): Promise<Record<string, unknown>> {
    const url = new URL(FORECAST_ENDPOINT);
    url.searchParams.set("latitude", String(coordinates.latitude));
    url.searchParams.set("longitude", String(coordinates.longitude));
    url.searchParams.set(
      "daily",
      [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "wind_speed_10m_max",
      ].join(","),
    );
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "2");
    assertAllowedWeatherUrl(url);

    const body = await this.#fetchJson(url);
    if (!isPlainRecord(body) || !isPlainRecord(body.daily)) {
      throw invalidUpstream("Forecast response has an invalid shape");
    }
    return body.daily;
  }

  async #fetchJson(url: URL): Promise<unknown> {
    assertAllowedWeatherUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "WeBot-weather-tool/1.0",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ToolExecutionError(
          "upstream_error",
          `Weather service returned HTTP ${response.status}`,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw invalidUpstream("Weather service did not return JSON");
      }
      const text = await readTextWithLimit(response, this.#maxResponseBytes);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw invalidUpstream("Weather service returned invalid JSON");
      }
    } catch (error) {
      if (error instanceof ToolExecutionError) {
        throw error;
      }
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new ToolExecutionError(
          "timeout",
          "Weather service request timed out",
        );
      }
      throw new ToolExecutionError(
        "upstream_error",
        "Weather service request failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseImageGenerationArguments(raw: unknown): ImageGenerationArguments {
  let value = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_IMAGE_ARGUMENT_BYTES) {
      throw invalidArguments("图片生成参数过大。");
    }
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw invalidArguments("图片生成参数必须是合法 JSON。");
    }
  }
  if (!isPlainRecord(value)) {
    throw invalidArguments("图片生成参数必须是对象。");
  }
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        (key !== "prompt" &&
          key !== "includesAgent" &&
          key !== "size" &&
          key !== "quality"),
    )
  ) {
    throw invalidArguments("图片生成参数包含不支持的字段。");
  }
  if (typeof value.prompt !== "string") {
    throw invalidArguments("prompt 必须是字符串。");
  }
  const prompt = value.prompt.trim();
  if (
    countUnicodeCharacters(prompt) === 0 ||
    countUnicodeCharacters(prompt) > MAX_IMAGE_PROMPT_CHARACTERS ||
    Buffer.byteLength(prompt, "utf8") > MAX_IMAGE_PROMPT_BYTES
  ) {
    throw invalidArguments(
      `prompt 必须是 1–${MAX_IMAGE_PROMPT_CHARACTERS} 个字符，且不超过 ${MAX_IMAGE_PROMPT_BYTES} bytes。`,
    );
  }
  if (hasControlCharacters(prompt)) {
    throw invalidArguments("prompt 不得包含控制字符。");
  }
  if (typeof value.includesAgent !== "boolean") {
    throw invalidArguments("includesAgent 必须是布尔值。");
  }

  const hasSize = Object.prototype.hasOwnProperty.call(value, "size");
  if (hasSize && !isImageGenerationSize(value.size)) {
    throw invalidArguments(
      `size 必须是 ${IMAGE_GENERATION_SIZES.join("、")} 之一。`,
    );
  }
  const hasQuality = Object.prototype.hasOwnProperty.call(value, "quality");
  if (hasQuality && !isImageGenerationQuality(value.quality)) {
    throw invalidArguments(
      `quality 必须是 ${IMAGE_GENERATION_QUALITIES.join("、")} 之一。`,
    );
  }

  return {
    prompt,
    includesAgent: value.includesAgent,
    ...(hasSize ? { size: value.size as ImageGenerationSize } : {}),
    ...(hasQuality ? { quality: value.quality as ImageGenerationQuality } : {}),
  };
}

function analyzeImageGenerationIntent(input: string): {
  explicit: boolean;
  rejected: boolean;
} {
  const normalized = stripQuotedMessageBlocks(input.normalize("NFKC")).trim();
  if (!normalized) return { explicit: false, rejected: false };
  if (hasTerminalImageGenerationCancellation(normalized)) {
    return { explicit: false, rejected: true };
  }

  const negatedIntentPatterns = [
    /(?:不|别|勿|无需|不用|不必|禁止|停止|取消|莫)[^，。！？!?;；\n]{0,24}(?:生成|创建|创作|制作|绘制|绘画|画出|画|设计|做)(?:图|图片|图像|图画|插图|插画|头像|海报|壁纸|封面|照片|相片|表情包|漫画|logo|标志|图标)?/iu,
    /(?:不要|别|无需|不用|不必|禁止|停止|取消|莫|不想|不希望|不打算|没打算|不是|并非)\s*(?:再\s*)?(?:(?:帮|给|替|为)\s*我?\s*)?(?:(?:让|叫|请)\s*你?\s*)?(?:生成|创建|创作|制作|绘制|绘画|画出|画|设计|做)(?:图|图片|图像|图画|插图|插画|头像|海报|壁纸|封面|照片|相片|表情包|漫画|logo|标志|图标)?/iu,
    /(?:不要|别给我|不想要|不需要|无需|不用)\s*(?:一|1)?\s*(?:张|幅|个|份|套)?\s*(?:图|图片|图像|图画|插图|插画|头像|海报|壁纸|封面|照片|相片|表情包|漫画|logo|标志|图标)/iu,
    /\b(?:do\s+not|don't|dont|never|stop|cancel)\s+(?:(?:want|need)\s+)?(?:(?:you|me)\s+)?(?:to\s+)?(?:please\s+)?(?:generate|create|draw|paint|design|make)(?:\s+(?:an?\s+)?(?:image|picture|photo|avatar|poster|illustration|artwork|logo|wallpaper|cover))?/iu,
    /\b(?:no|without)\s+(?:image|picture|photo|avatar|poster|illustration|artwork|logo|wallpaper|cover)s?\b/iu,
    /(?:不|别|勿|不要|不用|无需|停止|取消)[^，。！？!?;；\n]{0,16}(?:发|分享|传|给)[^，。！？!?;；\n]{0,10}(?:图|图片|照片|相片|头像|海报|插画)/iu,
  ];
  if (negatedIntentPatterns.some((pattern) => pattern.test(normalized))) {
    return { explicit: false, rejected: true };
  }

  const explicitIntentPatterns = [
    /(?:生成|创建|创作|制作|绘制|绘画|画出|画|设计|做)(?:[^，。！？!?;；\n]{0,16})(?:图|图片|图像|图画|插图|插画|头像|海报|壁纸|封面|照片|相片|表情包|漫画|logo|标志|图标)/iu,
    /(?:请|麻烦|帮我|给我|替我|为我|能否|可以|可不可以|我要你|我想让你)(?:[^，。！？!?;；\n]{0,12})(?:画|绘制|绘画|画出)(?:[^，。！？!?;；\n]|$)/u,
    /^(?:请\s*)?(?:帮我\s*)?(?:画|绘制|绘画|画出)\s*(?:一|1)?\s*(?:只|个|位|名|头|匹|条|座|棵|朵|辆|艘|架|片|些)?\s*\S/u,
    /(?:生成|创作|绘制|绘画|画出|画)\s*(?:一|1)?\s*(?:张|幅)/u,
    /(?:我要|我想要|想要|给我|来)(?:一|1)?\s*(?:张|幅|个|份|套)?\s*(?:图|图片|图像|图画|插图|插画|头像|海报|壁纸|封面|照片|相片|表情包|漫画|logo|标志|图标)/iu,
    /(?:给我|帮我|发我|来|拍)(?:一|1)?\s*张[^，。！？!?;；\n]{0,24}(?:自拍|照片|相片|图片|图|照)/iu,
    /(?:请|麻烦|赶紧|快点|快|给我|帮我|来|再来)[^，。！？!?;；\n]{0,12}(?:发|拍|整|来)(?:给我)?[^，。！？!?;；\n]{0,8}(?:一|1)?\s*张(?:[^，。！？!?;；\n]{0,12})?(?:自拍|照片|相片|图|图片|照)?/iu,
    /^(?:赶紧|快点|快|给我)?\s*(?:再)?来\s*(?:一|1)\s*张(?:吧|啊|呀|啦|呢)?[。！？!?…~～\s]*$/u,
    /(?:图|图片|图像|图画|插图|插画|头像|海报|壁纸|封面|照片|相片|表情包|漫画|logo|标志|图标)(?:[^，。！？!?;；\n]{0,10})(?:生成|创建|创作|制作|绘制|画|设计|做)(?:一下|一个|一张)?/iu,
    /\b(?:generate|create|draw|paint|design|make)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|avatar|poster|illustration|artwork|logo|wallpaper|cover)\b/iu,
  ];
  return {
    explicit: explicitIntentPatterns.some((pattern) =>
      pattern.test(normalized),
    ),
    rejected: false,
  };
}

function normalizeImageBehavior(
  value: AgentImageBehavior | undefined,
): AgentImageBehavior {
  const mode =
    value?.mode === "natural" || value?.mode === "off"
      ? value.mode
      : "explicit";
  return {
    mode,
    // Kept only so older stored Agent profiles remain shape-compatible.
    // Runtime image generation has no time-based or daily quota.
    cooldownMinutes: 0,
    allowAutonomous: value?.allowAutonomous === true,
    visualIdentityPrompt: normalizeTrustedVisualIdentity(
      value?.visualIdentityPrompt,
    ),
  };
}

function normalizeTrustedVisualIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  const sanitized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim();
  if (!sanitized) return "";
  let result = "";
  for (const character of sanitized) {
    if (Array.from(result).length >= MAX_VISUAL_IDENTITY_CHARACTERS) break;
    if (
      Buffer.byteLength(result + character, "utf8") > MAX_VISUAL_IDENTITY_BYTES
    ) {
      break;
    }
    result += character;
  }
  return result.trim();
}

function appendTrustedImageConstraints(
  prompt: string,
  includesAgent: boolean,
  visualIdentityPrompt: string,
): string {
  if (!includesAgent) return prompt;
  const sections = [
    "【本轮画面要求（模型提出）】",
    prompt,
    "【平台可信的拍摄逻辑（模型不可覆盖）】",
    "若这是当前 Agent 发给用户的写实照片或生活随拍，拍摄方式必须符合现场条件。没有明确存在的拍摄者时，默认改为手机手持自拍（自然的手臂长度与近距离构图）、镜面自拍，或画面/场景中能够合理解释的手机支架加定时自拍。不得凭空采用隐形第三人摄影师、远距离全身跟拍、专业棚拍、航拍或电影机位。全身照只有在镜面自拍、明确架好手机定时拍摄，或当前上下文已经确立另一位拍摄者时才合理。普通“给你拍一张”“来张照片”在人物独处时优先理解为自然手机自拍，而不是第三人称全身照。若用户明确要求插画、绘画等非摄影画面，本条只约束叙事视角，不强制自拍构图。",
    "【拍摄逻辑结束】",
  ];
  if (visualIdentityPrompt) {
    sections.push(
      "【平台可信的 Agent 视觉设定（模型不可覆盖）】",
      "画面已明确包含当前 Agent 本人。必须应用以下外观连续性设定，不得用其他人物替代，也不得改变已确定的稳定外貌特征。",
      visualIdentityPrompt,
      "【Agent 视觉设定结束】",
    );
  }
  return sections.join("\n");
}

function imageGenerationKey(userId: string, agentId: string): string {
  return createHash("sha256")
    .update(userId, "utf8")
    .update("\0", "utf8")
    .update(agentId, "utf8")
    .digest("hex");
}

function stripQuotedMessageBlocks(input: string): string {
  const tagPattern =
    /(?:\[|【|<)\s*(\/?)\s*(?:引用\s*(?:消息|内容)?|quoted?\s*(?:message|text)?|quote)\s*(?:\]|】|>)/giu;
  let depth = 0;
  let unquotedStart = 0;
  let result = "";
  let hasUnmatchedClosingTag = false;

  for (const match of input.matchAll(tagPattern)) {
    const index = match.index;
    const isClosingTag = match[1] === "/";
    if (!isClosingTag) {
      if (depth === 0) {
        result += input.slice(unquotedStart, index);
      }
      depth += 1;
      continue;
    }
    if (depth === 0) {
      hasUnmatchedClosingTag = true;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      unquotedStart = index + match[0].length;
    }
  }

  if (hasUnmatchedClosingTag) return "";
  if (depth === 0) {
    result += input.slice(unquotedStart);
  }
  return result;
}

function hasTerminalImageGenerationCancellation(input: string): boolean {
  return (
    /(?:算了|作罢|(?:取消|撤销)(?:掉|了|(?:这|该)?(?:个)?(?:图片)?(?:生成)?(?:请求|任务|操作))?|不用(?:了)?|不需要(?:了)?|不要了|先不用|先不要|不(?:画|生成|做|制作|设计|绘制|弄)了|别(?:画|生成|做|制作|设计|绘制|弄)了|停止(?:生成|画图|绘图)?|停下)(?:了|吧|啦|啊|呀|呢|哈)?(?:\s*[，,、]\s*(?:谢谢你?|谢了|多谢|就这样(?:吧)?))?[。！？!?…~～\s]*$/u.test(
      input,
    ) ||
    /\b(?:never\s+mind|forget\s+it|cancel(?:\s+it)?|no\s+thanks|don't\s+bother)\b[.!?…~\s]*$/iu.test(
      input,
    )
  );
}

function validateGeneratedImage(value: unknown): {
  data: Buffer;
  mimeType: GeneratedImageAttachment["mimeType"];
  revisedPrompt?: string;
} {
  if (!isPlainRecord(value)) {
    throw invalidUpstream("Image generation response has an invalid shape");
  }
  if (
    !Buffer.isBuffer(value.data) ||
    value.data.byteLength === 0 ||
    value.data.byteLength > MAX_GENERATED_IMAGE_BYTES
  ) {
    throw invalidUpstream("Generated image data is invalid");
  }
  if (typeof value.mimeType !== "string") {
    throw invalidUpstream("Generated image MIME type is invalid");
  }
  const mimeType = value.mimeType.trim().toLowerCase();
  if (!isGeneratedImageMimeType(mimeType)) {
    throw invalidUpstream("Generated image MIME type is invalid");
  }

  const hasRevisedPrompt = Object.prototype.hasOwnProperty.call(
    value,
    "revisedPrompt",
  );
  let revisedPrompt: string | undefined;
  if (hasRevisedPrompt) {
    if (typeof value.revisedPrompt !== "string") {
      throw invalidUpstream("Image revised prompt is invalid");
    }
    revisedPrompt = value.revisedPrompt.trim();
    if (
      countUnicodeCharacters(revisedPrompt) === 0 ||
      countUnicodeCharacters(revisedPrompt) > MAX_REVISED_PROMPT_CHARACTERS ||
      Buffer.byteLength(revisedPrompt, "utf8") > MAX_REVISED_PROMPT_BYTES ||
      hasControlCharacters(revisedPrompt)
    ) {
      throw invalidUpstream("Image revised prompt is invalid");
    }
  }

  return {
    data: value.data,
    mimeType,
    ...(revisedPrompt ? { revisedPrompt } : {}),
  };
}

function isPresentIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    Buffer.byteLength(value, "utf8") <= 2 * 1024 &&
    !hasControlCharacters(value)
  );
}

function isImageGenerationSize(value: unknown): value is ImageGenerationSize {
  return IMAGE_GENERATION_SIZES.includes(value as ImageGenerationSize);
}

function isImageGenerationQuality(
  value: unknown,
): value is ImageGenerationQuality {
  return IMAGE_GENERATION_QUALITIES.includes(value as ImageGenerationQuality);
}

function isGeneratedImageMimeType(
  value: string,
): value is (typeof GENERATED_IMAGE_MIME_TYPES)[number] {
  return GENERATED_IMAGE_MIME_TYPES.includes(
    value as (typeof GENERATED_IMAGE_MIME_TYPES)[number],
  );
}

function countUnicodeCharacters(value: string): number {
  return Array.from(value).length;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function parseWeatherArguments(raw: unknown): WeatherArguments {
  let value = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > 2 * 1024) {
      throw invalidArguments("Tool arguments are too large");
    }
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw invalidArguments("Tool arguments must be valid JSON");
    }
  }

  if (!isPlainRecord(value)) {
    throw invalidArguments("Tool arguments must be an object");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "location" && key !== "forecastDay"),
    )
  ) {
    throw invalidArguments("Tool arguments contain unsupported fields");
  }
  if (typeof value.location !== "string") {
    throw invalidArguments("location must be a string");
  }
  const location = value.location.trim();
  if (
    location.length === 0 ||
    location.length > MAX_LOCATION_LENGTH ||
    Buffer.byteLength(location, "utf8") > MAX_LOCATION_LENGTH * 4
  ) {
    throw invalidArguments(
      `location must contain 1-${MAX_LOCATION_LENGTH} characters`,
    );
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(location)) {
    throw invalidArguments("location must not contain control characters");
  }
  if (
    /(?:[a-z][a-z0-9+.-]*:\/\/|https?:\/\/|www\.)/iu.test(location) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(location) ||
    /(?:^|[\s(])\/\/[^\s]+/u.test(location) ||
    /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?:#]|$)/iu.test(location)
  ) {
    throw invalidArguments("location must not be a URL");
  }

  const forecastDay = value.forecastDay ?? "today";
  if (forecastDay !== "today" && forecastDay !== "tomorrow") {
    throw invalidArguments("forecastDay must be today or tomorrow");
  }
  return { location, forecastDay };
}

function parseReminderTitle(raw: unknown): string {
  let value = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > 2 * 1024) {
      throw invalidArguments("提醒候选参数过大。");
    }
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw invalidArguments("提醒候选参数必须是合法 JSON。");
    }
  }
  if (!isPlainRecord(value)) {
    throw invalidArguments("提醒候选参数必须是对象。");
  }
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || key !== "title",
    ) ||
    typeof value.title !== "string"
  ) {
    throw invalidArguments("提醒候选只接受 title 字段。");
  }
  const title = value.title.trim();
  if (
    !title ||
    title.length > 200 ||
    Buffer.byteLength(title, "utf8") > 800 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(title)
  ) {
    throw invalidArguments("提醒事项必须是 1–200 个可见字符。");
  }
  return title;
}

function formatShanghaiTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function assertInvocationSource(
  source: unknown,
): asserts source is ToolInvocationSource {
  if (source !== "chat" && source !== "schedule") {
    throw new ToolExecutionError(
      "unauthorized_source",
      "Tool invocation source is not allowed",
    );
  }
}

function assertAllowedWeatherUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    !WEATHER_ALLOWED_HOSTS.includes(
      url.hostname as (typeof WEATHER_ALLOWED_HOSTS)[number],
    ) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    throw new ToolExecutionError(
      "upstream_error",
      "Weather network destination is not allowed",
    );
  }
}

async function readTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maxBytes
    ) {
      throw invalidUpstream("Weather response exceeded its safety limit");
    }
  }

  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw invalidUpstream("Weather response exceeded its safety limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw invalidUpstream("Weather response is not valid UTF-8");
  }
}

function readArrayItem<T>(
  value: unknown,
  index: number,
  predicate: (item: unknown) => item is T,
  field: string,
): T {
  if (!Array.isArray(value) || !predicate(value[index])) {
    throw invalidUpstream(`Forecast field ${field} is invalid`);
  }
  return value[index];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

const KNOWN_WEATHER_CODES = new Set([
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77,
  80, 81, 82, 85, 86, 95, 96, 99,
]);

function isKnownWeatherCode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    KNOWN_WEATHER_CODES.has(value)
  );
}

function weatherCodeToChinese(code: number): string {
  if (code === 0) return "晴";
  if (code === 1) return "大部晴朗";
  if (code === 2) return "局部多云";
  if (code === 3) return "阴";
  if (code === 45 || code === 48) return "雾";
  if (code === 51 || code === 53 || code === 55) return "毛毛雨";
  if (code === 56 || code === 57) return "冻毛毛雨";
  if (code === 61 || code === 63 || code === 65) return "雨";
  if (code === 66 || code === 67) return "冻雨";
  if (code === 71 || code === 73 || code === 75) return "雪";
  if (code === 77) return "米雪";
  if (code === 80 || code === 81 || code === 82) return "阵雨";
  if (code === 85 || code === 86) return "阵雪";
  if (code === 95) return "雷暴";
  if (code === 96 || code === 99) return "雷暴伴冰雹";
  throw invalidUpstream("Weather code is not supported");
}

function validatePositiveIntegerOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${name} must be a positive integer <= ${maximum}`);
  }
  return resolved;
}

function invalidArguments(message: string): ToolExecutionError {
  return new ToolExecutionError("invalid_arguments", message);
}

function invalidUpstream(message: string): ToolExecutionError {
  return new ToolExecutionError("invalid_upstream_response", message);
}

function safeToolName(name: unknown): string {
  if (typeof name !== "string") {
    return "<invalid>";
  }
  return /^[a-z0-9_-]{1,64}$/iu.test(name) ? name : "<invalid>";
}

export const BUILTIN_TOOL_DESCRIPTORS = Object.freeze([
  WEATHER_CURRENT_DESCRIPTOR,
] as const);
