import { assertApiSuccess, ILinkApiClient } from "./api-client.js";
import { SessionExpiredError } from "./errors.js";
import { parseIncomingText } from "./message-parser.js";
import {
  IncomingMessageBuffer,
  type IncomingMessageBufferOptions,
} from "./message-buffer.js";
import {
  ImageMediaSender,
  type ImageMediaSenderLike,
} from "./image-media.js";
import { ImageInputDownloader } from "./image-input.js";
import { StateStore } from "./storage.js";
import { VoiceMediaDownloader } from "./voice-media.js";
import type {
  Credential,
  ImageAnalyzer,
  IncomingContextHandler,
  IncomingTextMessage,
  MessageHandler,
  MessageReply,
  OutgoingReplyEnvelope,
  OutgoingReplyPart,
  VoiceTranscriber,
  WeixinMessage,
} from "./types.js";
import { MessageType, TypingStatus } from "./types.js";

const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1_000;
const TYPING_KEEPALIVE_MS = 5_000;
const DEFAULT_BUBBLE_BASE_DELAY_MS = 800;
const DEFAULT_BUBBLE_DELAY_PER_CHARACTER_MS = 120;
const DEFAULT_BUBBLE_MIN_DELAY_MS = 1_000;
const DEFAULT_BUBBLE_MAX_DELAY_MS = 7_000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("zh", {
  granularity: "grapheme",
});

export interface WeixinAdapterOptions {
  stateDir?: string;
  logger?: Pick<Console, "info" | "warn" | "error">;
  /**
   * Defaults to the Weixin user who scanned the login QR code.
   * Set to "any" only when the bot is intentionally public.
   */
  allowFrom?: string[] | "any";
  voiceTranscriber?: VoiceTranscriber;
  voiceMediaDownloader?: Pick<
    VoiceMediaDownloader,
    "hasDownloadableVoice" | "downloadAsWav"
  >;
  imageAnalyzer?: ImageAnalyzer;
  imageInputDownloader?: Pick<
    ImageInputDownloader,
    "hasDownloadableImage" | "downloadAll"
  >;
  /** Sliding quiet period used to combine consecutive messages. */
  messageDebounceMs?: number;
  /** Maximum time measured from the first message in one combined input. */
  messageMaxWaitMs?: number;
  /**
   * Legacy fixed delay. When used alone it preserves the old fixed-delay
   * behavior. Prefer the adaptive options below for new integrations.
   */
  bubbleDelayMs?: number;
  /** Base delay before each bubble after the first. Defaults to 800 ms. */
  bubbleBaseDelayMs?: number;
  /** Extra delay for each visible character. Defaults to 120 ms. */
  bubbleDelayPerCharacterMs?: number;
  /** Lower bound for one inter-bubble delay. Defaults to 1000 ms. */
  bubbleMinDelayMs?: number;
  /** Upper bound for one inter-bubble delay. Defaults to 7000 ms. */
  bubbleMaxDelayMs?: number;
  /** Optional test/custom implementation for secure image download + upload. */
  imageMediaSender?: ImageMediaSenderLike;
}

export class WeixinAdapter {
  readonly store: StateStore;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly configuredAllowFrom: string[] | "any" | undefined;
  private readonly voiceTranscriber: VoiceTranscriber | undefined;
  private readonly voiceMediaDownloader: Pick<
    VoiceMediaDownloader,
    "hasDownloadableVoice" | "downloadAsWav"
  >;
  private readonly imageAnalyzer: ImageAnalyzer | undefined;
  private readonly imageInputDownloader: Pick<
    ImageInputDownloader,
    "hasDownloadableImage" | "downloadAll"
  >;
  private readonly messageBufferOptions: IncomingMessageBufferOptions;
  private readonly bubbleDelay: BubbleDelayOptions;
  private readonly configuredImageMediaSender: ImageMediaSenderLike | undefined;
  private effectiveAllowFrom: Set<string> | "any" = "any";
  private api?: ILinkApiClient;
  private imageMediaSender?: ImageMediaSenderLike;
  private credential?: Credential;
  private controller: AbortController | undefined;
  private readonly seenIds = new Set<number>();
  private readonly typingTickets = new Map<
    string,
    { ticket: string; expiresAt: number }
  >();
  private readonly outboundTails = new Map<string, Promise<void>>();

  constructor(options: WeixinAdapterOptions = {}) {
    this.store = new StateStore(
      options.stateDir ? { stateDir: options.stateDir } : {},
    );
    this.logger = options.logger ?? console;
    this.configuredAllowFrom = options.allowFrom;
    this.voiceTranscriber = options.voiceTranscriber;
    this.voiceMediaDownloader =
      options.voiceMediaDownloader ?? new VoiceMediaDownloader();
    this.imageAnalyzer = options.imageAnalyzer;
    this.imageInputDownloader =
      options.imageInputDownloader ?? new ImageInputDownloader();
    this.messageBufferOptions = {
      ...(options.messageDebounceMs === undefined
        ? {}
        : { debounceMs: options.messageDebounceMs }),
      ...(options.messageMaxWaitMs === undefined
        ? {}
        : { maxWindowMs: options.messageMaxWaitMs }),
    };
    this.bubbleDelay = normalizeBubbleDelayOptions(options);
    this.configuredImageMediaSender = options.imageMediaSender;
  }

  async initialize(): Promise<Credential> {
    if (this.controller) {
      throw new Error("Adapter 运行期间不能重新初始化。");
    }
    if (this.outboundTails.size > 0) {
      throw new Error("仍有消息正在发送，暂时不能重新初始化 Adapter。");
    }
    const credential = await this.store.loadCredential();
    if (!credential) {
      throw new Error("尚未登录，请先运行 npm run login。");
    }
    this.credential = credential;
    this.api = new ILinkApiClient({
      baseUrl: credential.baseUrl,
      token: credential.token,
    });
    this.imageMediaSender =
      this.configuredImageMediaSender ??
      new ImageMediaSender({ api: this.api });
    const allowed =
      this.configuredAllowFrom ??
      (credential.userId ? [credential.userId] : "any");
    this.effectiveAllowFrom =
      allowed === "any" ? "any" : new Set(allowed.map((id) => id.trim()));
    if (allowed === "any" && !this.configuredAllowFrom) {
      this.logger.warn(
        "登录凭证没有扫码用户 ID，当前会处理所有发送者。建议显式配置 allowFrom。",
      );
    }
    return credential;
  }

  async start(
    handler: MessageHandler,
    onIncomingContext?: IncomingContextHandler,
  ): Promise<void> {
    if (this.controller) throw new Error("Adapter 已经在运行。");
    const credential = this.credential ?? (await this.initialize());
    const api = this.requireApi();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let cursor = await this.store.loadCursor();
    let timeoutMs = 40_000;
    let consecutiveFailures = 0;
    let cursorCommitChain = Promise.resolve();
    let uncheckpointedProcessing: Promise<void>[] = [];
    const messageBuffer = new IncomingMessageBuffer(
      (message) => this.handleMessage(handler, message),
      this.messageBufferOptions,
    );

    try {
      await api.notifyStart().catch((error: unknown) => {
        this.logger.warn("启动通知失败，将继续收取消息：", error);
      });
      this.logger.info(`微信 Adapter 已启动，账号：${credential.accountId}`);

      while (!signal.aborted) {
        try {
          const response = await api.getUpdates(cursor, {
            timeoutMs,
            signal,
          });
          if (signal.aborted) break;
          assertApiSuccess(response, "getupdates");
          consecutiveFailures = 0;
          if (
            response.longpolling_timeout_ms &&
            response.longpolling_timeout_ms > 0
          ) {
            timeoutMs = response.longpolling_timeout_ms + 5_000;
          }

          for (const raw of response.msgs ?? []) {
            if (!raw.from_user_id || !this.isAllowed(raw.from_user_id)) {
              if (raw.from_user_id) {
                this.logger.warn(`已忽略未授权发送者：${raw.from_user_id}`);
              }
              continue;
            }
            if (this.isDuplicate(raw.message_id)) continue;
            if (
              onIncomingContext &&
              raw.message_type === MessageType.USER &&
              raw.context_token
            ) {
              try {
                await onIncomingContext({
                  senderId: raw.from_user_id,
                  contextToken: raw.context_token,
                  ...(raw.message_id !== undefined
                    ? { messageId: raw.message_id }
                    : {}),
                  ...(raw.create_time_ms !== undefined
                    ? { createdAt: raw.create_time_ms }
                    : {}),
                  raw,
                });
              } catch (error) {
                this.logger.error("保存最新微信会话上下文失败：", error);
              }
            }
            const message = await this.prepareIncomingMessage(raw);
            if (!message) continue;
            uncheckpointedProcessing.push(
              messageBuffer.enqueue(message).catch((error: unknown) => {
                this.logger.error("队列中的消息处理失败：", error);
              }),
            );
          }

          if (
            response.get_updates_buf &&
            response.get_updates_buf !== cursor
          ) {
            cursor = response.get_updates_buf;
            const checkpoint = cursor;
            const checkpointedProcessing = uncheckpointedProcessing;
            uncheckpointedProcessing = [];
            cursorCommitChain = cursorCommitChain
              .then(async () => {
                await Promise.all(checkpointedProcessing);
                await this.store.saveCursor(checkpoint);
              })
              .catch((error: unknown) => {
                this.logger.error("保存微信消息游标失败：", error);
              });
          }
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof SessionExpiredError) throw error;
          consecutiveFailures += 1;
          this.logger.error(
            `收取消息失败（连续 ${consecutiveFailures} 次）：`,
            error,
          );
          const backoffMs = consecutiveFailures >= 3 ? 30_000 : 2_000;
          if (consecutiveFailures >= 3) consecutiveFailures = 0;
          await delay(backoffMs, signal);
        }
      }
    } finally {
      await messageBuffer.drain();
      await Promise.all(uncheckpointedProcessing);
      await cursorCommitChain;
      await this.drainOutbound();
      await api.notifyStop().catch(() => undefined);
      this.controller = undefined;
      this.logger.info("微信 Adapter 已停止。");
    }
  }

  stop(): void {
    this.controller?.abort();
  }

  async sendText(params: {
    toUserId: string;
    contextToken: string;
    text: string;
    /**
     * Internal delivery hook used by scheduled messages so their memory write
     * is ordered inside the same per-user outbound queue.
     */
    finalizeDelivery?: () => Promise<void>;
  }): Promise<string> {
    return this.enqueueOutbound(params.toUserId, async () => {
      const clientId = await this.sendTextNow(params);
      await params.finalizeDelivery?.();
      return clientId;
    });
  }

  async sendImageFromUrl(params: {
    toUserId: string;
    contextToken: string;
    sourceUrl: string;
  }): Promise<string> {
    return this.enqueueOutbound(
      params.toUserId,
      () => this.sendImageFromUrlNow(params),
    );
  }

  /** Queues a trusted generated image behind all earlier output to this user. */
  async sendGeneratedImage(params: {
    toUserId: string;
    contextToken: string;
    data: Buffer;
  }): Promise<string> {
    const data = Buffer.from(params.data);
    return this.enqueueOutbound(params.toUserId, () =>
      this.sendGeneratedImageNow({ ...params, data }),
    );
  }

  private async sendTextNow(params: {
    toUserId: string;
    contextToken: string;
    text: string;
  }): Promise<string> {
    return this.requireApi().sendText(params);
  }

  private async sendImageFromUrlNow(params: {
    toUserId: string;
    contextToken: string;
    sourceUrl: string;
  }): Promise<string> {
    if (!this.imageMediaSender) {
      throw new Error("Adapter 尚未初始化，请先调用 initialize()。");
    }
    return this.imageMediaSender.sendFromUrl(params);
  }

  private async sendGeneratedImageNow(params: {
    toUserId: string;
    contextToken: string;
    data: Buffer;
  }): Promise<string> {
    if (!this.imageMediaSender?.sendBuffer) {
      throw new Error("当前图片发送器不支持生成图片。");
    }
    return this.imageMediaSender.sendBuffer(params);
  }

  /**
   * Serializes every outbound operation for one Weixin user. A whole
   * multi-part reply is enqueued as one operation so proactive messages cannot
   * appear between its text and image bubbles.
   */
  private enqueueOutbound<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.outboundTails.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.outboundTails.set(userId, tail);
    void tail.then(() => {
      if (this.outboundTails.get(userId) === tail) {
        this.outboundTails.delete(userId);
      }
    });
    return current;
  }

  private async drainOutbound(): Promise<void> {
    while (this.outboundTails.size > 0) {
      await Promise.all([...this.outboundTails.values()]);
    }
  }

  private async prepareIncomingMessage(
    raw: WeixinMessage,
  ): Promise<IncomingTextMessage | null> {
    const direct = parseIncomingText(raw);
    if (this.imageInputDownloader.hasDownloadableImage(raw)) {
      if (!raw.from_user_id || !raw.context_token) return null;
      if (!this.imageAnalyzer) {
        if (direct) return direct;
        await this.sendText({
          toUserId: raw.from_user_id,
          contextToken: raw.context_token,
          text: "我收到了图片，但当前还没有配置图片理解服务。",
        });
        return null;
      }
      try {
        const images = await this.imageInputDownloader.downloadAll(raw);
        if (!images.length) throw new Error("图片消息没有可解析的内容。");
        const description = (
          await this.imageAnalyzer({
            userId: raw.from_user_id,
            ...(direct?.text ? { userPrompt: direct.text } : {}),
            images,
          })
        ).trim();
        if (!description) throw new Error("图片理解服务返回为空。");
        const base = direct ?? parseIncomingText(
          {
            ...raw,
            item_list: [
              { type: 1, text_item: { text: "[图片]" } },
            ],
          },
        );
        if (!base) return null;
        return {
          ...base,
          imageObservations: [
            {
              description,
              mimeType: images[0]!.mimeType,
            },
          ],
        };
      } catch (error) {
        this.logger.error("图片理解失败：", error);
        if (direct) {
          return {
            ...direct,
            text: `${direct.text}\n[附带图片暂时无法识别]`,
          };
        }
        await this.sendText({
          toUserId: raw.from_user_id,
          contextToken: raw.context_token,
          text: "这张图片我暂时没能看清，可以稍后再发一次。",
        });
        return null;
      }
    }
    if (direct || !this.voiceMediaDownloader.hasDownloadableVoice(raw)) {
      return direct;
    }
    if (!raw.from_user_id || !raw.context_token) return null;
    if (!this.voiceTranscriber) {
      this.logger.warn("收到未附带文字的语音，但没有配置语音识别器。");
      await this.sendText({
        toUserId: raw.from_user_id,
        contextToken: raw.context_token,
        text: "我收到了语音，但当前还没有配置语音识别服务。",
      });
      return null;
    }
    try {
      const audio = await this.voiceMediaDownloader.downloadAsWav(raw);
      const transcription = await this.voiceTranscriber({
        audio,
        mimeType: "audio/wav",
        filename: `weixin-${raw.message_id ?? Date.now()}.wav`,
        language: "zh",
      });
      return parseIncomingText(raw, transcription);
    } catch (error) {
      this.logger.error("语音识别失败：", error);
      await this.sendText({
        toUserId: raw.from_user_id,
        contextToken: raw.context_token,
        text: "这条语音我暂时没听清，可以再说一次或改成文字吗？",
      });
      return null;
    }
  }

  private async handleMessage(
    handler: MessageHandler,
    message: IncomingTextMessage,
  ): Promise<void> {
    const stopTyping = await this.startTyping(message);
    let deliveredParts = 0;
    try {
      const reply = await handler(message);
      const normalized = normalizeReply(reply);
      const deliveredMemoryReplies: string[] = [];
      await this.enqueueOutbound(message.senderId, async () => {
        try {
          for (const [index, part] of normalized.parts.entries()) {
            if (index > 0) {
              const visibleText =
                part.type === "text" ? part.text : "[图片]";
              const bubbleDelayMs = calculateBubbleDelayMs(
                visibleText,
                this.bubbleDelay,
              );
              if (bubbleDelayMs > 0) await wait(bubbleDelayMs);
            }
            if (part.type === "text") {
              await this.sendTextNow({
                toUserId: message.senderId,
                contextToken: message.contextToken,
                text: part.text,
              });
              deliveredMemoryReplies.push(part.text);
              deliveredParts += 1;
              continue;
            }
            try {
              if (part.type === "generated_image") {
                await this.sendGeneratedImageNow({
                  toUserId: message.senderId,
                  contextToken: message.contextToken,
                  data: part.data,
                });
                deliveredMemoryReplies.push(part.memoryText);
              } else {
                await this.sendImageFromUrlNow({
                  toUserId: message.senderId,
                  contextToken: message.contextToken,
                  sourceUrl: part.sourceUrl,
                });
                deliveredMemoryReplies.push("[发送了一张图片]");
              }
              deliveredParts += 1;
            } catch (error) {
              this.logger.warn("图片发送失败，已回退为文字提示。");
              this.logger.warn(
                `图片发送失败原因：${safeImageDeliveryFailure(error)}`,
              );
              const fallback =
                part.fallbackText ?? "这张图片暂时没能发出去。";
              await this.sendTextNow({
                toUserId: message.senderId,
                contextToken: message.contextToken,
                text: fallback,
              });
              deliveredMemoryReplies.push(fallback);
              deliveredParts += 1;
            }
          }
        } finally {
          await normalized.finalizeDelivery?.(deliveredMemoryReplies);
        }
      });
    } catch (error) {
      this.logger.error(
        `处理来自 ${message.senderId} 的消息失败：`,
        error,
      );
      if (deliveredParts === 0) {
        await this.sendText({
          toUserId: message.senderId,
          contextToken: message.contextToken,
          text: "刚才没有生成可发送的回复，请再发一次。",
        }).catch((fallbackError: unknown) => {
          this.logger.warn("发送模型失败提示也失败了：", fallbackError);
        });
      }
    } finally {
      await stopTyping();
    }
  }

  private async startTyping(
    message: IncomingTextMessage,
  ): Promise<() => Promise<void>> {
    const api = this.requireApi();
    let ticket: string;
    try {
      ticket = await this.getTypingTicket(message);
      if (!ticket) return async () => undefined;
      await api.sendTyping({
        userId: message.senderId,
        typingTicket: ticket,
        status: TypingStatus.TYPING,
      });
    } catch (error) {
      this.typingTickets.delete(message.senderId);
      this.logger.warn("发送“正在输入”状态失败，将继续正常回复：", error);
      return async () => undefined;
    }

    let stopped = false;
    let keepalive: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (stopped || keepalive) return;
      keepalive = api
        .sendTyping({
          userId: message.senderId,
          typingTicket: ticket,
          status: TypingStatus.TYPING,
        })
        .catch((error: unknown) => {
          this.logger.warn("续期“正在输入”状态失败：", error);
        })
        .finally(() => {
          keepalive = undefined;
        });
    }, TYPING_KEEPALIVE_MS);
    timer.unref();

    return async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await keepalive;
      await api
        .sendTyping({
          userId: message.senderId,
          typingTicket: ticket,
          status: TypingStatus.CANCEL,
        })
        .catch((error: unknown) => {
          this.logger.warn("取消“正在输入”状态失败：", error);
        });
    };
  }

  private async getTypingTicket(
    message: IncomingTextMessage,
  ): Promise<string> {
    const cached = this.typingTickets.get(message.senderId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;
    const ticket = await this.requireApi().getTypingTicket({
      userId: message.senderId,
      contextToken: message.contextToken,
    });
    if (ticket) {
      this.typingTickets.set(message.senderId, {
        ticket,
        expiresAt: Date.now() + TYPING_TICKET_TTL_MS,
      });
    }
    return ticket;
  }

  private isDuplicate(messageId?: number): boolean {
    if (messageId === undefined) return false;
    if (this.seenIds.has(messageId)) return true;
    this.seenIds.add(messageId);
    if (this.seenIds.size > 1_000) {
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    return false;
  }

  private isAllowed(senderId: string): boolean {
    return (
      this.effectiveAllowFrom === "any" ||
      this.effectiveAllowFrom.has(senderId)
    );
  }

  private requireApi(): ILinkApiClient {
    if (!this.api) {
      throw new Error("Adapter 尚未初始化，请先调用 initialize()。");
    }
    return this.api;
  }
}

function safeImageDeliveryFailure(error: unknown): string {
  if (!(error instanceof Error)) return "未知错误。";
  const message = error.message.trim();
  const allowed = [
    /^图片超过允许大小。$/u,
    /^链接内容不是支持的图片格式。$/u,
    /^图片格式与服务器声明不一致。$/u,
    /^微信没有返回图片上传地址。$/u,
    /^微信返回了无效的图片上传地址。$/u,
    /^微信返回了不安全的图片上传地址。$/u,
    /^微信返回的图片上传地址不是公网地址。$/u,
    /^微信图片上传超时。$/u,
    /^微信图片上传被拒绝：HTTP \d{3}$/u,
    /^微信图片上传失败：HTTP \d{3}$/u,
    /^微信图片上传失败，请稍后再试。$/u,
    /^微信图片上传响应缺少媒体凭证。$/u,
  ];
  return allowed.some((pattern) => pattern.test(message))
    ? message
    : "未公开的上游错误。";
}

interface NormalizedReply {
  parts: OutgoingReplyPart[];
  finalizeDelivery?: NonNullable<
    OutgoingReplyEnvelope["finalizeDelivery"]
  >;
}

function normalizeReply(reply: MessageReply): NormalizedReply {
  if (typeof reply === "string") {
    return {
      parts: reply.trim() ? [{ type: "text", text: reply }] : [],
    };
  }
  const envelope = isReplyEnvelope(reply) ? reply : undefined;
  const sourceParts: readonly (string | OutgoingReplyPart)[] =
    envelope?.parts ?? (Array.isArray(reply) ? reply : []);
  const parts: OutgoingReplyPart[] = [];
  for (const part of sourceParts) {
    if (typeof part === "string") {
      if (part.trim()) parts.push({ type: "text", text: part.trim() });
      continue;
    }
    if (part.type === "text") {
      if (part.text.trim()) {
        parts.push({ type: "text", text: part.text.trim() });
      }
      continue;
    }
    if (part.type === "image" && part.sourceUrl.trim()) {
      parts.push({
        type: "image",
        sourceUrl: part.sourceUrl.trim(),
        ...(part.fallbackText?.trim()
          ? { fallbackText: part.fallbackText.trim() }
          : {}),
      });
      continue;
    }
    if (
      part.type === "generated_image" &&
      Buffer.isBuffer(part.data) &&
      part.data.byteLength > 0 &&
      part.memoryText.trim()
    ) {
      parts.push({
        type: "generated_image",
        data: part.data,
        mimeType: part.mimeType,
        memoryText: part.memoryText.trim(),
        ...(part.fallbackText?.trim()
          ? { fallbackText: part.fallbackText.trim() }
          : {}),
      });
    }
  }
  const finalizeDelivery = envelope?.finalizeDelivery;
  return {
    parts,
    ...(finalizeDelivery ? { finalizeDelivery } : {}),
  };
}

function isReplyEnvelope(value: unknown): value is OutgoingReplyEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "parts" in value &&
    Array.isArray((value as { parts?: unknown }).parts)
  );
}

interface BubbleDelayOptions {
  baseMs: number;
  perCharacterMs: number;
  minMs: number;
  maxMs: number;
}

export function calculateBubbleDelayMs(
  text: string,
  options: BubbleDelayOptions,
): number {
  const visibleCharacters = countVisibleCharacters(text);
  return Math.min(
    options.maxMs,
    Math.max(
      options.minMs,
      options.baseMs + visibleCharacters * options.perCharacterMs,
    ),
  );
}

export function countVisibleCharacters(text: string): number {
  let count = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    if (!/^\s+$/u.test(segment)) count += 1;
  }
  return count;
}

function normalizeBubbleDelayOptions(
  options: WeixinAdapterOptions,
): BubbleDelayOptions {
  const hasAdaptiveOption =
    options.bubbleBaseDelayMs !== undefined ||
    options.bubbleDelayPerCharacterMs !== undefined ||
    options.bubbleMinDelayMs !== undefined ||
    options.bubbleMaxDelayMs !== undefined;
  if (!hasAdaptiveOption && options.bubbleDelayMs !== undefined) {
    const fixed = normalizeDelay(
      options.bubbleDelayMs,
      DEFAULT_BUBBLE_BASE_DELAY_MS,
      0,
      30_000,
    );
    return {
      baseMs: fixed,
      perCharacterMs: 0,
      minMs: fixed,
      maxMs: fixed,
    };
  }
  const baseMs = normalizeDelay(
    options.bubbleBaseDelayMs ?? options.bubbleDelayMs,
    DEFAULT_BUBBLE_BASE_DELAY_MS,
    0,
    10_000,
  );
  const perCharacterMs = normalizeDelay(
    options.bubbleDelayPerCharacterMs,
    DEFAULT_BUBBLE_DELAY_PER_CHARACTER_MS,
    0,
    1_000,
  );
  const minMs = normalizeDelay(
    options.bubbleMinDelayMs,
    DEFAULT_BUBBLE_MIN_DELAY_MS,
    0,
    30_000,
  );
  const requestedMax = normalizeDelay(
    options.bubbleMaxDelayMs,
    DEFAULT_BUBBLE_MAX_DELAY_MS,
    0,
    30_000,
  );
  return {
    baseMs,
    perCharacterMs,
    minMs,
    maxMs: Math.max(minMs, requestedMax),
  };
}

function normalizeDelay(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value ?? fallback)));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
