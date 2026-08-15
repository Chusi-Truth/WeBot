import crypto from "node:crypto";

import { ILinkApiError, SessionExpiredError } from "./errors.js";
import {
  MessageItemType,
  MessageState,
  MessageType,
  type BaseInfo,
  type GetUploadUrlResponse,
  type GetUpdatesResponse,
  type GetConfigResponse,
  type QrCodeResponse,
  type QrStatusResponse,
  type SendMessageResponse,
  type SendTypingResponse,
  TypingStatus,
} from "./types.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 40_000;
const CHANNEL_VERSION = "0.7.0";
const CLIENT_VERSION = (0 << 16) | (4 << 8) | 0;

type FetchLike = typeof fetch;

export interface ILinkApiClientOptions {
  baseUrl?: string;
  token?: string;
  appId?: string;
  botAgent?: string;
  fetchImpl?: FetchLike;
}

export class ILinkApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly appId: string;
  private readonly botAgent: string;
  private token: string | undefined;
  private baseUrl: string;

  constructor(options: ILinkApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.token = options.token;
    this.appId = options.appId ?? "bot";
    this.botAgent = options.botAgent ?? "WeBot/0.7.0";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  setSession(params: { token: string; baseUrl?: string }): void {
    this.token = params.token;
    if (params.baseUrl) this.baseUrl = normalizeBaseUrl(params.baseUrl);
  }

  async getQrCode(params: {
    botType?: string;
    localTokenList?: string[];
  } = {}): Promise<QrCodeResponse> {
    return this.requestJson<QrCodeResponse>({
      method: "POST",
      baseUrl: DEFAULT_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType ?? "3")}`,
      body: { local_token_list: params.localTokenList ?? [] },
      authenticated: false,
    });
  }

  async getQrStatus(params: {
    qrcode: string;
    baseUrl?: string;
    verifyCode?: string;
  }): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
    if (params.verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
    }
    return this.requestJson<QrStatusResponse>({
      method: "GET",
      baseUrl: params.baseUrl ?? DEFAULT_BASE_URL,
      endpoint,
      timeoutMs: 35_000,
      authenticated: false,
    });
  }

  async getUpdates(
    cursor: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<GetUpdatesResponse> {
    try {
      return await this.requestJson<GetUpdatesResponse>({
        method: "POST",
        endpoint: "ilink/bot/getupdates",
        body: {
          get_updates_buf: cursor,
          base_info: this.baseInfo(),
        },
        timeoutMs: options.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error) && !options.signal?.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }

  async sendText(params: {
    toUserId: string;
    contextToken: string;
    text: string;
    runId?: string;
  }): Promise<string> {
    const clientId = `webot:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const response = await this.requestJson<SendMessageResponse>({
      method: "POST",
      endpoint: "ilink/bot/sendmessage",
      body: {
        msg: {
          from_user_id: "",
          to_user_id: params.toUserId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: params.text },
            },
          ],
          context_token: params.contextToken,
          ...(params.runId ? { run_id: params.runId } : {}),
        },
        base_info: this.baseInfo(),
      },
    });
    assertApiSuccess(response, "sendmessage");
    return clientId;
  }

  async getImageUploadUrl(params: {
    fileKey: string;
    toUserId: string;
    rawSize: number;
    rawFileMd5: string;
    encryptedSize: number;
    aesKeyHex: string;
  }): Promise<GetUploadUrlResponse> {
    const response = await this.requestJson<GetUploadUrlResponse>({
      method: "POST",
      endpoint: "ilink/bot/getuploadurl",
      body: {
        filekey: params.fileKey,
        media_type: 1,
        to_user_id: params.toUserId,
        rawsize: params.rawSize,
        rawfilemd5: params.rawFileMd5,
        filesize: params.encryptedSize,
        no_need_thumb: true,
        aeskey: params.aesKeyHex,
        base_info: this.baseInfo(),
      },
    });
    assertApiSuccess(response, "getuploadurl");
    return response;
  }

  async sendImage(params: {
    toUserId: string;
    contextToken: string;
    encryptedQueryParam: string;
    aesKeyHex: string;
    encryptedSize: number;
    runId?: string;
  }): Promise<string> {
    const clientId = `webot:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const response = await this.requestJson<SendMessageResponse>({
      method: "POST",
      endpoint: "ilink/bot/sendmessage",
      body: {
        msg: {
          from_user_id: "",
          to_user_id: params.toUserId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [
            {
              type: MessageItemType.IMAGE,
              image_item: {
                media: {
                  encrypt_query_param: params.encryptedQueryParam,
                  // Tencent's current plugin base64-encodes the 32-character
                  // hex representation for outbound image compatibility.
                  aes_key: Buffer.from(params.aesKeyHex, "utf8").toString(
                    "base64",
                  ),
                  encrypt_type: 1,
                },
                mid_size: params.encryptedSize,
              },
            },
          ],
          context_token: params.contextToken,
          ...(params.runId ? { run_id: params.runId } : {}),
        },
        base_info: this.baseInfo(),
      },
    });
    assertApiSuccess(response, "sendmessage");
    return clientId;
  }

  async getTypingTicket(params: {
    userId: string;
    contextToken?: string;
  }): Promise<string> {
    const response = await this.requestJson<GetConfigResponse>({
      method: "POST",
      endpoint: "ilink/bot/getconfig",
      body: {
        ilink_user_id: params.userId,
        ...(params.contextToken
          ? { context_token: params.contextToken }
          : {}),
        base_info: this.baseInfo(),
      },
      timeoutMs: 10_000,
    });
    assertApiSuccess(response, "getconfig");
    return response.typing_ticket?.trim() ?? "";
  }

  async sendTyping(params: {
    userId: string;
    typingTicket: string;
    status?: (typeof TypingStatus)[keyof typeof TypingStatus];
  }): Promise<void> {
    const response = await this.requestJson<SendTypingResponse>({
      method: "POST",
      endpoint: "ilink/bot/sendtyping",
      body: {
        ilink_user_id: params.userId,
        typing_ticket: params.typingTicket,
        status: params.status ?? TypingStatus.TYPING,
        base_info: this.baseInfo(),
      },
      timeoutMs: 10_000,
    });
    assertApiSuccess(response, "sendtyping");
  }

  async notifyStart(): Promise<void> {
    await this.notify("ilink/bot/msg/notifystart");
  }

  async notifyStop(): Promise<void> {
    await this.notify("ilink/bot/msg/notifystop");
  }

  private async notify(endpoint: string): Promise<void> {
    const response = await this.requestJson<SendMessageResponse>({
      method: "POST",
      endpoint,
      body: { base_info: this.baseInfo() },
      timeoutMs: 10_000,
    });
    assertApiSuccess(response, endpoint);
  }

  private baseInfo(): BaseInfo {
    return {
      channel_version: CHANNEL_VERSION,
      bot_agent: this.botAgent,
    };
  }

  private async requestJson<T>(params: {
    method: "GET" | "POST";
    endpoint: string;
    baseUrl?: string;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    authenticated?: boolean;
  }): Promise<T> {
    const baseUrl = normalizeBaseUrl(params.baseUrl ?? this.baseUrl);
    const url = new URL(params.endpoint, `${baseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const onExternalAbort = () => controller.abort();
    params.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        "iLink-App-Id": this.appId,
        "iLink-App-ClientVersion": String(CLIENT_VERSION),
      };
      if (params.method === "POST") {
        headers["Content-Type"] = "application/json";
        headers.AuthorizationType = "ilink_bot_token";
        headers["X-WECHAT-UIN"] = randomWechatUin();
      }
      if (params.authenticated !== false) {
        if (!this.token) {
          throw new Error("缺少 iLink bot token，请先执行登录。");
        }
        headers.Authorization = `Bearer ${this.token}`;
      }

      const response = await this.fetchImpl(url, {
        method: params.method,
        headers,
        ...(params.body === undefined
          ? {}
          : { body: JSON.stringify(params.body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new ILinkApiError(
          `${params.endpoint} HTTP ${response.status}: ${truncate(raw)}`,
          response.status,
        );
      }
      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        throw new ILinkApiError(
          `${params.endpoint} 返回了无效 JSON: ${truncate(raw)}`,
        );
      }
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export function assertApiSuccess(
  response: {
    ret?: number;
    errcode?: number;
    errmsg?: string;
  },
  operation: string,
): void {
  const code =
    response.errcode && response.errcode !== 0
      ? response.errcode
      : response.ret ?? 0;
  if (code === -14) throw new SessionExpiredError();
  if (code !== 0) {
    throw new ILinkApiError(
      `${operation} 失败：${response.errmsg ?? `错误码 ${code}`}`,
      code,
    );
  }
}

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function normalizeBaseUrl(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function truncate(value: string, maxLength = 500): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
