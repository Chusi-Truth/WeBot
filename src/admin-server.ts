import crypto from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import { AgentStore } from "./agent-store.js";
import type {
  AgentAutonomyAdminEvent,
  AgentAutonomyAdminRuntime,
  AgentAutonomyAdminSnapshot,
  AgentConversationMode,
  AgentDirectorEvent,
  AgentImageBehavior,
  AgentMemoryEpisode,
  AgentMemoryEpisodeExtractor,
  AgentMemoryEpisodeOrganizer,
  AgentMemoryMessage,
  AgentProfile,
  AgentRoleplayProfile,
  AgentStoryBookEntry,
} from "./agent-types.js";
import {
  exportCharacterCard,
  normalizeAgentImageBehavior,
  normalizeDirectorEvent,
  parseCharacterCard,
} from "./character-card.js";
import type {
  DirectorEventDraftGenerator,
  PersonaDraftGenerator,
  PersonaDraftTarget,
  StoryDraftGenerator,
  WritingExampleDraftGenerator,
} from "./persona-assistant.js";
import { ProviderRegistry } from "./provider-registry.js";
import { PromptTraceStore } from "./prompt-trace-store.js";
import type {
  WeatherAdminSnapshot,
  WeatherScheduleAdminRuntime,
} from "./weather-scheduler.js";

const COOKIE_NAME = "webot_admin";
const ADMIN_PASSWORD_FILE = "admin-password.json";
const ADMIN_PASSWORD_MIN_CHARACTERS = 10;
const ADMIN_PASSWORD_MAX_CHARACTERS = 200;
const MAX_BODY_BYTES = 768 * 1024;
const EPISODE_REBUILD_BATCH_CHARACTERS = 48_000;
const EPISODE_REBUILD_BATCH_MESSAGES = 80;
const EPISODE_REBUILD_FRAGMENT_CHARACTERS = 44_000;

interface EpisodeRebuildBatch {
  messages: EpisodeRebuildSourceMessage[];
  completedSourceMessages: number;
}

interface EpisodeRebuildSourceMessage extends AgentMemoryMessage {
  sourceOrder: number;
}

interface MemoryEpisodeRebuildStatus {
  status: "running" | "complete" | "error";
  startedAt: string;
  updatedAt: string;
  totalMessages: number;
  processedMessages: number;
  extractedEpisodes: number;
  error?: string;
}

interface MemoryEpisodeOrganizationStatus {
  status: "running" | "complete" | "error";
  startedAt: string;
  updatedAt: string;
  sourceEpisodes: number;
  majorEvents: number;
  error?: string;
}

interface AdminPasswordRecord {
  version: 1;
  salt: string;
  hash: string;
}

export interface AdminServerOptions {
  stateDir: string;
  agents: AgentStore;
  providers: ProviderRegistry;
  personaDraftGenerator?: PersonaDraftGenerator;
  writingExampleDraftGenerator?: WritingExampleDraftGenerator;
  directorEventDraftGenerator?: DirectorEventDraftGenerator;
  storyDraftGenerator?: StoryDraftGenerator;
  memoryEpisodeExtractor?: AgentMemoryEpisodeExtractor;
  memoryEpisodeOrganizer?: AgentMemoryEpisodeOrganizer;
  autonomy?: AgentAutonomyAdminRuntime;
  weather?: WeatherScheduleAdminRuntime;
  traces?: PromptTraceStore;
  port?: number;
  host?: "127.0.0.1";
}

export class AdminServer {
  private readonly stateDir: string;
  private readonly agents: AgentStore;
  private readonly providers: ProviderRegistry;
  private readonly personaDraftGenerator: PersonaDraftGenerator | undefined;
  private readonly writingExampleDraftGenerator:
    | WritingExampleDraftGenerator
    | undefined;
  private readonly directorEventDraftGenerator:
    | DirectorEventDraftGenerator
    | undefined;
  private readonly storyDraftGenerator: StoryDraftGenerator | undefined;
  private readonly memoryEpisodeExtractor:
    | AgentMemoryEpisodeExtractor
    | undefined;
  private readonly memoryEpisodeOrganizer:
    | AgentMemoryEpisodeOrganizer
    | undefined;
  private readonly autonomy: AgentAutonomyAdminRuntime | undefined;
  private readonly weather: WeatherScheduleAdminRuntime | undefined;
  private readonly traces: PromptTraceStore | undefined;
  private readonly port: number;
  private readonly host: "127.0.0.1";
  private boundPort: number;
  private server: Server | undefined;
  private token = "";
  private passwordRecord: AdminPasswordRecord | undefined;
  private failedLoginAttempts: number[] = [];
  private readonly personaDraftsInFlight = new Set<string>();
  private readonly episodeRebuildsInFlight = new Set<string>();
  private readonly episodeRebuildStatuses = new Map<
    string,
    MemoryEpisodeRebuildStatus
  >();
  private readonly episodeOrganizationsInFlight = new Set<string>();
  private readonly episodeOrganizationStatuses = new Map<
    string,
    MemoryEpisodeOrganizationStatus
  >();

  constructor(options: AdminServerOptions) {
    this.stateDir = options.stateDir;
    this.agents = options.agents;
    this.providers = options.providers;
    this.personaDraftGenerator = options.personaDraftGenerator;
    this.writingExampleDraftGenerator =
      options.writingExampleDraftGenerator;
    this.directorEventDraftGenerator = options.directorEventDraftGenerator;
    this.storyDraftGenerator = options.storyDraftGenerator;
    this.memoryEpisodeExtractor = options.memoryEpisodeExtractor;
    this.memoryEpisodeOrganizer = options.memoryEpisodeOrganizer;
    this.autonomy = options.autonomy;
    this.weather = options.weather;
    this.traces = options.traces;
    this.port = options.port ?? 3210;
    this.boundPort = this.port;
    this.host = options.host ?? "127.0.0.1";
  }

  async start(): Promise<{ loginUrl: string; baseUrl: string }> {
    if (this.server) throw new Error("管理后台已经启动。");
    this.token = await loadOrCreateAdminToken(this.stateDir);
    this.passwordRecord = await loadAdminPassword(this.stateDir);
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        console.error("管理后台请求失败：", error);
        if (!response.headersSent) {
          const isApiMutation =
            request.url?.startsWith("/api/") && request.method !== "GET";
          sendJson(
            response,
            isApiMutation ? 400 : 500,
            {
              error:
                isApiMutation && error instanceof Error
                  ? error.message.slice(0, 500)
                  : "管理后台发生内部错误。",
            },
          );
        } else {
          response.end();
        }
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    if (address && typeof address === "object") {
      this.boundPort = address.port;
    }
    const baseUrl = `http://${this.host}:${this.boundPort}`;
    return {
      baseUrl,
      loginUrl: this.passwordRecord
        ? `${baseUrl}/admin`
        : `${baseUrl}/admin?token=${encodeURIComponent(this.token)}`,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    setSecurityHeaders(response);
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`,
    );

    if (!this.isAllowedHost(request.headers.host)) {
      sendJson(response, 403, { error: "无效 Host。" });
      return;
    }

    if (requestUrl.pathname === "/admin" && requestUrl.searchParams.has("token")) {
      if (this.passwordRecord) {
        sendText(response, 403, "后台已经启用密码登录，管理令牌链接已停用。");
        return;
      }
      const supplied = requestUrl.searchParams.get("token") ?? "";
      if (!constantTimeEqual(supplied, this.token)) {
        sendText(response, 403, "管理令牌无效。");
        return;
      }
      response.statusCode = 303;
      response.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
      );
      response.setHeader("Location", "/admin");
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/login.css") {
      await sendFile(response, "login.css", "text/css; charset=utf-8");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/login.js") {
      await sendFile(response, "login.js", "text/javascript; charset=utf-8");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/auth/status") {
      sendJson(response, 200, {
        authenticated: this.isAuthenticated(request),
        setupRequired: !this.passwordRecord,
      });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/auth/login") {
      if (!this.passwordRecord) {
        sendJson(response, 409, { error: "请先使用启动日志中的一次性链接设置管理密码。" });
        return;
      }
      if (!this.isAllowedOrigin(request.headers.origin, request.headers.host)) {
        sendJson(response, 403, { error: "请求来源无效。" });
        return;
      }
      if (request.headers["x-webot-request"] !== "admin") {
        sendJson(response, 403, { error: "请求校验失败。" });
        return;
      }
      if (this.isLoginRateLimited()) {
        sendJson(response, 429, { error: "登录尝试过多，请稍后再试。" });
        return;
      }
      const body = await readJsonBody(request);
      const password = requireAdminPassword(body.password);
      if (!(await verifyAdminPassword(password, this.passwordRecord))) {
        this.recordFailedLogin();
        sendJson(response, 401, { error: "管理密码不正确。" });
        return;
      }
      this.failedLoginAttempts = [];
      setAdminCookie(response, this.token);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/admin" &&
      (!this.isAuthenticated(request) || !this.passwordRecord)
    ) {
      if (!this.passwordRecord && !this.isAuthenticated(request)) {
        sendText(
          response,
          401,
          "首次设置需要启动日志中的一次性管理链接。",
        );
        return;
      }
      await sendFile(response, "login.html", "text/html; charset=utf-8");
      return;
    }

    if (!this.isAuthenticated(request)) {
      if (requestUrl.pathname.startsWith("/api/")) {
        sendJson(response, 401, { error: "需要管理令牌。" });
      } else {
        sendText(
          response,
          401,
          "WeBot 管理后台已锁定。请使用启动日志中的管理链接访问。",
        );
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/auth/password") {
      if (!this.isAllowedOrigin(request.headers.origin, request.headers.host)) {
        sendJson(response, 403, { error: "请求来源无效。" });
        return;
      }
      if (request.headers["x-webot-request"] !== "admin") {
        sendJson(response, 403, { error: "请求校验失败。" });
        return;
      }
      const body = await readJsonBody(request);
      const nextPassword = requireAdminPassword(body.password);
      if (this.passwordRecord) {
        const currentPassword = requireAdminPassword(body.currentPassword);
        if (!(await verifyAdminPassword(currentPassword, this.passwordRecord))) {
          sendJson(response, 401, { error: "当前管理密码不正确。" });
          return;
        }
      }
      this.passwordRecord = await saveAdminPassword(
        this.stateDir,
        nextPassword,
      );
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
      if (!this.isAllowedOrigin(request.headers.origin, request.headers.host)) {
        sendJson(response, 403, { error: "请求来源无效。" });
        return;
      }
      if (request.headers["x-webot-request"] !== "admin") {
        sendJson(response, 403, { error: "请求校验失败。" });
        return;
      }
      response.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
      sendJson(response, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname.startsWith("/api/") && request.method !== "GET") {
      if (request.headers["x-webot-request"] !== "admin") {
        sendJson(response, 403, { error: "请求校验失败。" });
        return;
      }
      if (!this.isAllowedOrigin(request.headers.origin, request.headers.host)) {
        sendJson(response, 403, { error: "请求来源无效。" });
        return;
      }
    }

    if (request.method === "GET" && requestUrl.pathname === "/admin") {
      await sendFile(response, "admin.html", "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/admin.css") {
      await sendFile(response, "admin.css", "text/css; charset=utf-8");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/admin.js") {
      await sendFile(
        response,
        "admin.js",
        "text/javascript; charset=utf-8",
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/state") {
      sendJson(response, 200, await this.buildState());
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/autonomy"
    ) {
      const userId = requireQueryString(requestUrl, "userId");
      const agentId = requireQueryString(requestUrl, "agentId");
      await this.requireUserAgent(userId, agentId);
      if (!this.autonomy) {
        sendJson(response, 503, { error: "自主生活服务未启用。" });
        return;
      }
      const limit = parseAutonomyLimit(requestUrl.searchParams.get("limit"));
      const snapshot = await this.autonomy.getAdminSnapshot(
        userId,
        agentId,
        limit,
      );
      sendJson(response, 200, {
        autonomy: publicAutonomySnapshot(snapshot),
      });
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/weather"
    ) {
      const userId = requireQueryString(requestUrl, "userId");
      const agentId = requireQueryString(requestUrl, "agentId");
      await this.requireUserAgent(userId, agentId);
      if (!this.weather) {
        sendJson(response, 503, { error: "每日天气服务未启用。" });
        return;
      }
      sendJson(response, 200, {
        weather: publicWeatherSnapshot(
          await this.weather.getAdminSnapshot(userId, agentId),
        ),
      });
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/export"
    ) {
      const userId = requestUrl.searchParams.get("userId") ?? "";
      const agentId = requestUrl.searchParams.get("agentId") ?? "";
      const registry = await this.agents.getRegistry(userId);
      const agent = registry.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error("没有找到指定 Agent。");
      const version = requestUrl.searchParams.get("version") === "2" ? "2.0" : "3.0";
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="character.card.json"; filename*=UTF-8''${encodeURIComponent(`${safeFileName(agent.name)}.card.json`)}`,
      );
      response.end(`${JSON.stringify(exportCharacterCard(agent, version), null, 2)}\n`);
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/history"
    ) {
      const userId = requestUrl.searchParams.get("userId") ?? "";
      const agentId = requestUrl.searchParams.get("agentId") ?? "";
      const registry = await this.agents.getRegistry(userId);
      const agent = registry.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error("没有找到指定 Agent。");
      const history = await this.agents.getHistory(userId, agentId);
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="history.json"; filename*=UTF-8''${encodeURIComponent(`${safeFileName(agent.name)}-完整聊天.json`)}`,
      );
      response.end(`${JSON.stringify({ agent: agent.name, messages: history }, null, 2)}\n`);
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/memory-summaries"
    ) {
      const userId = requestUrl.searchParams.get("userId") ?? "";
      const agentId = requestUrl.searchParams.get("agentId") ?? "";
      const registry = await this.agents.getRegistry(userId);
      const agent = registry.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error("没有找到指定 Agent。");
      const archive = await this.agents.getMemorySummaryArchive(
        userId,
        agentId,
      );
      sendJson(response, 200, {
        agent: agent.name,
        compressionCount: archive.compressionCount,
        snapshots: [...archive.snapshots].reverse(),
      });
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/memory-episodes"
    ) {
      const userId = requestUrl.searchParams.get("userId") ?? "";
      const agentId = requestUrl.searchParams.get("agentId") ?? "";
      const agent = await this.requireUserAgent(userId, agentId);
      const archive = await this.agents.getMemoryEpisodeArchive(
        userId,
        agentId,
      );
      sendJson(response, 200, {
        agent: agent.name,
        rebuildAvailable: Boolean(this.memoryEpisodeExtractor),
        organizeAvailable: Boolean(this.memoryEpisodeOrganizer),
        rebuild:
          this.episodeRebuildStatuses.get(
            memoryEpisodeRebuildKey(userId, agentId),
          ) ?? { status: "idle" },
        organization:
          this.episodeOrganizationStatuses.get(
            memoryEpisodeRebuildKey(userId, agentId),
          ) ?? { status: "idle" },
        ...archive,
      });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/memory-episodes/organize"
    ) {
      if (!this.memoryEpisodeOrganizer) {
        throw new Error("当前没有可用的大事件整理模型。");
      }
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const agent = await this.requireUserAgent(userId, agentId);
      this.startMemoryEpisodeOrganization(userId, agent);
      sendJson(response, 202, {
        ok: true,
        organization:
          this.episodeOrganizationStatuses.get(
            memoryEpisodeRebuildKey(userId, agentId),
          ) ?? { status: "running" },
      });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/memory-episodes/rebuild"
    ) {
      if (!this.memoryEpisodeExtractor) {
        throw new Error("当前没有可用的事件记忆重建模型。");
      }
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const agent = await this.requireUserAgent(userId, agentId);
      this.startMemoryEpisodeRebuild(userId, agent);
      sendJson(response, 202, {
        ok: true,
        rebuild:
          this.episodeRebuildStatuses.get(
            memoryEpisodeRebuildKey(userId, agentId),
          ) ?? { status: "running" },
      });
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/prompt-traces"
    ) {
      const userId = requestUrl.searchParams.get("userId") ?? "";
      const agentId = requestUrl.searchParams.get("agentId") ?? "";
      await this.requireUserAgent(userId, agentId);
      const limit = Number.parseInt(
        requestUrl.searchParams.get("limit") ?? "20",
        10,
      );
      const traces = this.traces
        ? await this.traces.list(
            userId,
            agentId,
            Number.isInteger(limit) ? limit : 20,
          )
        : [];
      sendJson(response, 200, { traces });
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/prompt-trace"
    ) {
      const userId = requestUrl.searchParams.get("userId") ?? "";
      const agentId = requestUrl.searchParams.get("agentId") ?? "";
      const traceId = requestUrl.searchParams.get("traceId") ?? "";
      await this.requireUserAgent(userId, agentId);
      const trace = this.traces
        ? await this.traces.get(userId, agentId, traceId)
        : null;
      if (!trace) {
        sendJson(response, 404, { error: "没有找到指定 Prompt Trace。" });
        return;
      }
      const { userHash: _privateUserHash, ...publicTrace } = trace;
      sendJson(response, 200, { trace: publicTrace });
      return;
    }
    if (
      request.method === "GET" &&
      requestUrl.pathname === "/api/agents/story-book"
    ) {
      const userId = requestUrl.searchParams.get("userId") ?? "";
      const agentId = requestUrl.searchParams.get("agentId") ?? "";
      await this.requireUserAgent(userId, agentId);
      sendJson(response, 200, {
        book: await this.agents.getStoryBook(userId, agentId),
      });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/keys") {
      const body = await readJsonBody(request);
      const environmentName = requireString(body, "environmentName");
      const value = requireString(body, "value");
      await this.providers.setApiKey(environmentName, value);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "DELETE" && requestUrl.pathname === "/api/keys") {
      const body = await readJsonBody(request);
      await this.providers.clearStoredApiKey(
        requireString(body, "environmentName"),
      );
      sendJson(response, 200, { ok: true });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/autonomy/settings"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      await this.requireUserAgent(userId, agentId);
      if (!this.autonomy) {
        sendJson(response, 503, { error: "自主生活服务未启用。" });
        return;
      }
      const enabled = requireBoolean(body, "enabled");
      const snapshot = await this.autonomy.setAdminEnabled(
        userId,
        agentId,
        enabled,
      );
      sendJson(response, 200, {
        autonomy: publicAutonomySnapshot(snapshot),
      });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/weather/settings"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      await this.requireUserAgent(userId, agentId);
      if (!this.weather) {
        sendJson(response, 503, { error: "每日天气服务未启用。" });
        return;
      }
      const weather = await this.weather.updateAdminConfig(userId, agentId, {
        enabled: requireBoolean(body, "enabled"),
        location: requireString(body, "location"),
        localTime: requireString(body, "localTime"),
        timeZone: requireString(body, "timeZone"),
      });
      sendJson(response, 200, { weather: publicWeatherSnapshot(weather) });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/weather/preview"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      await this.requireUserAgent(userId, agentId);
      if (!this.weather) {
        sendJson(response, 503, { error: "每日天气服务未启用。" });
        return;
      }
      sendJson(response, 200, {
        preview: await this.weather.previewAdmin(userId, agentId),
      });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/weather/send-now"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      await this.requireUserAgent(userId, agentId);
      if (!this.weather) {
        sendJson(response, 503, { error: "每日天气服务未启用。" });
        return;
      }
      sendJson(response, 200, {
        weather: publicWeatherSnapshot(
          await this.weather.sendAdminNow(userId, agentId),
        ),
      });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/autonomy/generate"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      await this.requireUserAgent(userId, agentId);
      if (!this.autonomy) {
        sendJson(response, 503, { error: "自主生活服务未启用。" });
        return;
      }
      const event = await this.autonomy.generateAdminEvent(userId, agentId);
      if (!event) {
        sendJson(response, 409, {
          error: "这个人物已有一项自主经历生成任务正在运行，请稍候。",
        });
        return;
      }
      const snapshot = await this.autonomy.getAdminSnapshot(
        userId,
        agentId,
        50,
      );
      sendJson(response, 200, {
        event,
        autonomy: publicAutonomySnapshot(snapshot),
      });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/writing-example-draft"
    ) {
      if (!this.writingExampleDraftGenerator) {
        sendJson(response, 503, { error: "写作示例 AI 助手未启用。" });
        return;
      }
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const expectedUpdatedAt = requireString(body, "expectedUpdatedAt");
      const instruction = requireBoundedText(
        body,
        "instruction",
        8_000,
        false,
      );
      const currentExample = requireBoundedText(
        body,
        "currentExample",
        8_000,
        true,
      );
      const agent = await this.requireUserAgent(userId, agentId);
      if (agent.updatedAt !== expectedUpdatedAt) {
        sendJson(response, 409, {
          error: "人物设定已在其他位置更新，请重新打开示例库后再生成。",
        });
        return;
      }
      const inFlightKey = `${userId}\0${agentId}`;
      if (this.personaDraftsInFlight.has(inFlightKey)) {
        sendJson(response, 409, {
          error: "这个人物已有一份 AI 草稿正在生成，请稍候。",
        });
        return;
      }
      this.personaDraftsInFlight.add(inFlightKey);
      try {
        const result = await this.writingExampleDraftGenerator({
          userId,
          agent,
          instruction,
          currentExample,
        });
        sendJson(response, 200, result);
      } finally {
        this.personaDraftsInFlight.delete(inFlightKey);
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/story-book-draft"
    ) {
      if (!this.storyDraftGenerator) {
        sendJson(response, 503, { error: "故事书 AI 助手未启用。" });
        return;
      }
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const expectedUpdatedAt = requireString(body, "expectedUpdatedAt");
      const expectedBookUpdatedAt = requireString(
        body,
        "expectedBookUpdatedAt",
      );
      const instruction = requireBoundedText(
        body,
        "instruction",
        8_000,
        false,
      );
      const currentStory = requireStoryValue(body.currentStory, "currentStory");
      const agent = await this.requireUserAgent(userId, agentId);
      if (agent.updatedAt !== expectedUpdatedAt) {
        sendJson(response, 409, {
          error: "人物设定已更新，请重新打开故事书后再生成。",
        });
        return;
      }
      const book = await this.agents.getStoryBook(userId, agentId);
      if (book.updatedAt !== expectedBookUpdatedAt) {
        sendJson(response, 409, {
          error: "故事书已在其他位置更新，请重新打开后再生成。",
        });
        return;
      }
      const inFlightKey = `${userId}\0${agentId}`;
      if (this.personaDraftsInFlight.has(inFlightKey)) {
        sendJson(response, 409, {
          error: "这个人物已有一份 AI 草稿正在生成，请稍候。",
        });
        return;
      }
      this.personaDraftsInFlight.add(inFlightKey);
      try {
        const memory = await this.agents.getMemoryContext(userId, agentId);
        sendJson(
          response,
          200,
          await this.storyDraftGenerator({
            userId,
            agent,
            instruction,
            currentStory,
            memory,
          }),
        );
      } finally {
        this.personaDraftsInFlight.delete(inFlightKey);
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/director-event-draft"
    ) {
      if (!this.directorEventDraftGenerator) {
        sendJson(response, 503, { error: "导演事件 AI 助手未启用。" });
        return;
      }
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const expectedUpdatedAt = requireString(body, "expectedUpdatedAt");
      const instruction = requireBoundedText(
        body,
        "instruction",
        8_000,
        false,
      );
      const currentEvent = requireDirectorEventValue(
        body.currentEvent,
        "currentEvent",
      );
      const agent = await this.requireUserAgent(userId, agentId);
      if (agent.updatedAt !== expectedUpdatedAt) {
        sendJson(response, 409, {
          error: "人物设定已在其他位置更新，请重新打开导演事件后再生成。",
        });
        return;
      }
      const inFlightKey = `${userId}\0${agentId}`;
      if (this.personaDraftsInFlight.has(inFlightKey)) {
        sendJson(response, 409, {
          error: "这个人物已有一份 AI 草稿正在生成，请稍候。",
        });
        return;
      }
      this.personaDraftsInFlight.add(inFlightKey);
      try {
        const result = await this.directorEventDraftGenerator({
          userId,
          agent,
          instruction,
          currentEvent,
        });
        sendJson(response, 200, result);
      } finally {
        this.personaDraftsInFlight.delete(inFlightKey);
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/persona-draft"
    ) {
      if (!this.personaDraftGenerator) {
        sendJson(response, 503, { error: "人物设定 AI 助手未启用。" });
        return;
      }
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const agent = await this.requireUserAgent(userId, agentId);
      const inFlightKey = `${userId}\0${agentId}`;
      if (this.personaDraftsInFlight.has(inFlightKey)) {
        sendJson(response, 409, {
          error: "这个人物已有一份 AI 草稿正在生成，请稍候。",
        });
        return;
      }
      this.personaDraftsInFlight.add(inFlightKey);
      try {
        const target = optionalPersonaDraftTarget(body);
        const result = await this.personaDraftGenerator({
          userId,
          agent,
          instruction: requireString(body, "instruction"),
          ...(Object.hasOwn(body, "currentDraft")
            ? { currentDraft: body.currentDraft }
            : {}),
          ...(target ? { target } : {}),
        });
        sendJson(response, 200, result);
      } finally {
        this.personaDraftsInFlight.delete(inFlightKey);
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/import"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const parsed = parseCharacterCard(body.card);
      const agent = await this.agents.createAgent(userId, parsed);
      sendJson(response, 200, { agent });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/create"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const roleplay = optionalRoleplay(body);
      const conversationMode = optionalConversationMode(body);
      const imageBehavior = optionalImageBehavior(body);
      const agent = await this.agents.createAgent(userId, {
        name: requireString(body, "name"),
        identity: requireString(body, "identity"),
        ...(roleplay ? { roleplay } : {}),
        ...(conversationMode ? { conversationMode } : {}),
        ...(imageBehavior ? { imageBehavior } : {}),
      });
      const providerId = optionalString(body, "providerId");
      const model = optionalString(body, "model");
      const updated =
        providerId || model
          ? await this.agents.updateAgentById(userId, agent.id, {
              name: agent.name,
              identity: agent.identity,
              ...(providerId ? { providerId } : {}),
              ...(model ? { model } : {}),
              ...(agent.roleplay ? { roleplay: agent.roleplay } : {}),
              ...(agent.conversationMode
                ? { conversationMode: agent.conversationMode }
                : {}),
              ...(agent.imageBehavior
                ? { imageBehavior: agent.imageBehavior }
                : {}),
            })
          : agent;
      sendJson(response, 200, { agent: updated });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/image-behavior"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const expectedUpdatedAt = requireString(body, "expectedUpdatedAt");
      const imageBehavior = requireImageBehavior(body.imageBehavior);
      try {
        const agent = await this.agents.updateImageBehaviorByAgentId(
          userId,
          agentId,
          imageBehavior,
          expectedUpdatedAt,
        );
        sendJson(response, 200, { agent });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("已被其他会话更新")
        ) {
          sendJson(response, 409, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/director-event"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const expectedUpdatedAt = requireString(body, "expectedUpdatedAt");
      if (!Object.hasOwn(body, "event")) {
        throw new Error("缺少 event。");
      }
      const event = body.event === null
        ? null
        : normalizeDirectorEvent(
            requireDirectorEventValue(body.event, "event"),
          ) ?? null;
      try {
        const agent = await this.agents.updateDirectorEventByAgentId(
          userId,
          agentId,
          event,
          expectedUpdatedAt,
        );
        sendJson(response, 200, { agent });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("已被其他会话更新")
        ) {
          sendJson(response, 409, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/story-book"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const expectedBookUpdatedAt = requireString(
        body,
        "expectedBookUpdatedAt",
      );
      const story = requireStoryValue(body.story, "story");
      try {
        const book = await this.agents.saveStoryBookEntry(
          userId,
          agentId,
          story,
          expectedBookUpdatedAt,
        );
        sendJson(response, 200, { book });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("故事书已在其他位置更新")
        ) {
          sendJson(response, 409, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    if (
      request.method === "DELETE" &&
      requestUrl.pathname === "/api/agents/story-book"
    ) {
      const body = await readJsonBody(request);
      const userId = requireString(body, "userId");
      const agentId = requireString(body, "agentId");
      const storyId = requireString(body, "storyId");
      const expectedBookUpdatedAt = requireString(
        body,
        "expectedBookUpdatedAt",
      );
      try {
        const book = await this.agents.deleteStoryBookEntry(
          userId,
          agentId,
          storyId,
          expectedBookUpdatedAt,
        );
        sendJson(response, 200, { book });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("故事书已在其他位置更新")
        ) {
          sendJson(response, 409, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/update"
    ) {
      const body = await readJsonBody(request);
      const providerId = optionalString(body, "providerId");
      const model = optionalString(body, "model");
      const roleplay = optionalRoleplay(body);
      const conversationMode = optionalConversationMode(body);
      const imageBehavior = optionalImageBehavior(body);
      const expectedUpdatedAt = optionalString(body, "expectedUpdatedAt");
      const agent = await this.agents.updateAgentById(
        requireString(body, "userId"),
        requireString(body, "agentId"),
        {
          name: requireString(body, "name"),
          identity: requireString(body, "identity"),
          ...(providerId ? { providerId } : {}),
          ...(model ? { model } : {}),
          ...(roleplay ? { roleplay } : {}),
          ...(conversationMode ? { conversationMode } : {}),
          ...(imageBehavior ? { imageBehavior } : {}),
          ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        },
      );
      sendJson(response, 200, { agent });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/activate"
    ) {
      const body = await readJsonBody(request);
      const agent = await this.agents.switchAgentById(
        requireString(body, "userId"),
        requireString(body, "agentId"),
      );
      sendJson(response, 200, { agent });
      return;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/agents/clear-memory"
    ) {
      const body = await readJsonBody(request);
      const agent = await this.agents.clearMemoryByAgentId(
        requireString(body, "userId"),
        requireString(body, "agentId"),
      );
      sendJson(response, 200, { agent });
      return;
    }
    if (
      request.method === "DELETE" &&
      requestUrl.pathname === "/api/agents"
    ) {
      const body = await readJsonBody(request);
      await this.agents.deleteAgentById(
        requireString(body, "userId"),
        requireString(body, "agentId"),
      );
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: "未找到该页面。" });
  }

  private startMemoryEpisodeRebuild(
    userId: string,
    agent: AgentProfile,
  ): void {
    if (!this.memoryEpisodeExtractor) return;
    const key = memoryEpisodeRebuildKey(userId, agent.id);
    if (this.episodeRebuildsInFlight.has(key)) return;
    const startedAt = new Date().toISOString();
    const status: MemoryEpisodeRebuildStatus = {
      status: "running",
      startedAt,
      updatedAt: startedAt,
      totalMessages: 0,
      processedMessages: 0,
      extractedEpisodes: 0,
    };
    this.episodeRebuildsInFlight.add(key);
    this.episodeRebuildStatuses.set(key, status);
    const generation = this.agents.captureDataGeneration(userId, agent.id);

    void (async () => {
      try {
        const history = await this.agents.getHistory(userId, agent.id);
        const batches = chunkHistoryForEpisodeRebuild(history);
        status.totalMessages = history.length;
        status.updatedAt = new Date().toISOString();
        const extracted: AgentMemoryEpisode[] = [];
        for (const batch of batches) {
          const episodes = await this.memoryEpisodeExtractor!({
            userId,
            agent,
            messages: batch.messages,
          });
          const messageById = new Map(
            batch.messages
              .filter(
                (
                  message,
                ): message is EpisodeRebuildSourceMessage & { id: string } =>
                  Boolean(message.id),
              )
              .map((message) => [message.id, message]),
          );
          const fallbackOccurredAt = batch.messages
            .map((message) => normalizeEpisodeOccurredAt(message.createdAt))
            .find(Boolean);
          const fallbackSourceOrder = batch.messages[0]?.sourceOrder;
          extracted.push(
            ...episodes.map((episode) => {
              const requestedSourceMessageId =
                episode.sourceMessageId?.trim();
              const sourceMessage = requestedSourceMessageId
                ? messageById.get(requestedSourceMessageId)
                : undefined;
              const occurredAt =
                normalizeEpisodeOccurredAt(sourceMessage?.createdAt) ||
                fallbackOccurredAt;
              return {
                id: "",
                ...(episode.sourceKey
                  ? { sourceKey: episode.sourceKey }
                  : {}),
                title: episode.title,
                content: episode.content,
                importance: episode.importance,
                ...(sourceMessage?.id
                  ? { sourceMessageId: sourceMessage.id }
                  : {}),
                ...(sourceMessage?.sourceOrder !== undefined
                  ? { sourceOrder: sourceMessage.sourceOrder }
                  : fallbackSourceOrder !== undefined
                  ? { sourceOrder: fallbackSourceOrder }
                  : {}),
                ...(occurredAt ? { occurredAt } : {}),
                ...(occurredAt
                  ? {
                      occurrencePrecision: sourceMessage
                        ? "message" as const
                        : "batch" as const,
                    }
                  : {}),
                updatedAt: new Date().toISOString(),
              };
            }),
          );
          status.processedMessages = Math.min(
            history.length,
            status.processedMessages + batch.completedSourceMessages,
          );
          status.extractedEpisodes = extracted.length;
          status.updatedAt = new Date().toISOString();
        }
        const saved = await this.agents.saveReconstructedMemoryEpisodes(
          userId,
          agent.id,
          {
            episodes: mergeRebuiltEpisodesBySourceKey(extracted),
            sourceMessageCount: history.length,
            ...(history[0]?.createdAt
              ? { sourceStartedAt: history[0].createdAt }
              : {}),
            ...(history.at(-1)?.createdAt
              ? { sourceEndedAt: history.at(-1)!.createdAt }
              : {}),
          },
          generation,
        );
        if (!saved) {
          throw new Error("Agent 记忆已在重建期间被清空或删除。");
        }
        if (this.memoryEpisodeOrganizer) {
          this.startMemoryEpisodeOrganization(userId, agent, {
            ignorePreviousMajorEvents: true,
          });
        }
        status.status = "complete";
        status.processedMessages = history.length;
        status.updatedAt = new Date().toISOString();
      } catch (error) {
        status.status = "error";
        status.error = safeEpisodeRebuildError(error);
        status.updatedAt = new Date().toISOString();
      } finally {
        this.episodeRebuildsInFlight.delete(key);
      }
    })();
  }

  private startMemoryEpisodeOrganization(
    userId: string,
    agent: AgentProfile,
    options: { ignorePreviousMajorEvents?: boolean } = {},
  ): void {
    if (!this.memoryEpisodeOrganizer) return;
    const key = memoryEpisodeRebuildKey(userId, agent.id);
    if (this.episodeOrganizationsInFlight.has(key)) return;
    const startedAt = new Date().toISOString();
    const status: MemoryEpisodeOrganizationStatus = {
      status: "running",
      startedAt,
      updatedAt: startedAt,
      sourceEpisodes: 0,
      majorEvents: 0,
    };
    this.episodeOrganizationsInFlight.add(key);
    this.episodeOrganizationStatuses.set(key, status);
    const generation = this.agents.captureDataGeneration(userId, agent.id);

    void (async () => {
      try {
        const candidate =
          await this.agents.getMemoryEpisodeOrganizationCandidate(
            userId,
            agent.id,
          );
        status.sourceEpisodes = candidate.episodes.length;
        status.updatedAt = new Date().toISOString();
        const groups = await this.memoryEpisodeOrganizer!({
          userId,
          agent,
          episodes: candidate.episodes,
          sourceMessageCount: candidate.sourceMessageCount,
          previousMajorEvents: options.ignorePreviousMajorEvents
            ? []
            : candidate.previousMajorEvents,
        });
        const saved = await this.agents.saveMemoryEpisodeHierarchy(
          userId,
          agent.id,
          {
            inputFingerprint: candidate.inputFingerprint,
            groups,
            organizedDetailKeys: candidate.episodes.map(
              (episode) => episode.sourceKey,
            ),
          },
          generation,
        );
        if (!saved) {
          throw new Error("事件记忆在整理期间发生变化，请重新整理。");
        }
        status.status = "complete";
        status.majorEvents = groups.length;
        status.updatedAt = new Date().toISOString();
      } catch (error) {
        status.status = "error";
        status.error = safeEpisodeRebuildError(error);
        status.updatedAt = new Date().toISOString();
      } finally {
        this.episodeOrganizationsInFlight.delete(key);
      }
    })();
  }

  private async buildState(): Promise<unknown> {
    const userSummaries = await this.agents.listUsers();
    const users = await Promise.all(
      userSummaries.map(async (summary) => {
        const registry = await this.agents.getRegistry(summary.userId);
        const agents = await Promise.all(
          registry.agents.map(async (agent) => {
            const memory = await this.agents.getMemoryContext(summary.userId, agent.id);
            return {
              ...agent,
              memoryCount: memory.messages.length,
              memoryMessages: memory.messages,
              memorySummary: memory.summary,
              memoryFacts: memory.facts,
              memoryEpisodes: memory.episodes,
              archivedMemoryCount: memory.archivedMessageCount,
              totalMemoryCount: memory.totalMessageCount,
              memoryCompressionCount: memory.compressionCount,
              memoryLastCompressionAt: memory.lastCompressionAt,
            };
          }),
        );
        return {
          userId: summary.userId,
          activeAgentId: registry.activeAgentId,
          agents,
        };
      }),
    );
    return {
      personaAssistantAvailable: Boolean(this.personaDraftGenerator),
      writingExampleAssistantAvailable: Boolean(
        this.writingExampleDraftGenerator,
      ),
      directorEventAssistantAvailable: Boolean(
        this.directorEventDraftGenerator,
      ),
      storyBookAssistantAvailable: Boolean(this.storyDraftGenerator),
      autonomyAvailable: Boolean(this.autonomy),
      weatherAvailable: Boolean(this.weather),
      defaultProviderId: this.providers.defaultProviderId,
      providers: this.providers.listProvidersForAdmin(),
      users,
    };
  }

  private async requireUserAgent(
    userId: string,
    agentId: string,
  ): Promise<AgentProfile> {
    const registry = await this.agents.getRegistry(userId);
    const agent = registry.agents.find((item) => item.id === agentId);
    if (!agent) {
      throw new Error("没有找到指定 Agent。");
    }
    return agent;
  }

  private isAuthenticated(request: IncomingMessage): boolean {
    const cookies = parseCookies(request.headers.cookie ?? "");
    return constantTimeEqual(cookies[COOKIE_NAME] ?? "", this.token);
  }

  private isAllowedHost(host: string | undefined): boolean {
    return (
      host === `${this.host}:${this.boundPort}` ||
      host === `localhost:${this.boundPort}`
    );
  }

  private isAllowedOrigin(
    origin: string | undefined,
    host: string | undefined,
  ): boolean {
    if (!origin) return true;
    return origin === `http://${host}`;
  }

  private isLoginRateLimited(): boolean {
    const cutoff = Date.now() - 15 * 60_000;
    this.failedLoginAttempts = this.failedLoginAttempts.filter(
      (attemptedAt) => attemptedAt >= cutoff,
    );
    return this.failedLoginAttempts.length >= 5;
  }

  private recordFailedLogin(): void {
    this.failedLoginAttempts.push(Date.now());
  }
}

async function loadOrCreateAdminToken(stateDir: string): Promise<string> {
  const filePath = path.join(stateDir, "admin-token");
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString("base64url");
  await writeFile(filePath, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
  return token;
}

async function loadAdminPassword(
  stateDir: string,
): Promise<AdminPasswordRecord | undefined> {
  const filePath = path.join(stateDir, ADMIN_PASSWORD_FILE);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.salt !== "string" ||
      typeof parsed.hash !== "string" ||
      !/^[A-Za-z0-9_-]{20,}$/u.test(parsed.salt) ||
      !/^[A-Za-z0-9_-]{40,}$/u.test(parsed.hash)
    ) {
      throw new Error("管理密码文件格式无效。");
    }
    return {
      version: 1,
      salt: parsed.salt,
      hash: parsed.hash,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveAdminPassword(
  stateDir: string,
  password: string,
): Promise<AdminPasswordRecord> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const salt = crypto.randomBytes(16);
  const hash = await deriveAdminPassword(password, salt);
  const record: AdminPasswordRecord = {
    version: 1,
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url"),
  };
  const filePath = path.join(stateDir, ADMIN_PASSWORD_FILE);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
  return record;
}

async function verifyAdminPassword(
  password: string,
  record: AdminPasswordRecord,
): Promise<boolean> {
  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(record.hash, "base64url");
    salt = Buffer.from(record.salt, "base64url");
  } catch {
    return false;
  }
  const actual = await deriveAdminPassword(password, salt);
  return (
    actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  );
}

function deriveAdminPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function requireAdminPassword(value: unknown): string {
  if (typeof value !== "string") throw new Error("请输入管理密码。");
  const password = value.normalize("NFKC");
  const characters = Array.from(password).length;
  if (characters < ADMIN_PASSWORD_MIN_CHARACTERS) {
    throw new Error(`管理密码至少需要 ${ADMIN_PASSWORD_MIN_CHARACTERS} 个字符。`);
  }
  if (characters > ADMIN_PASSWORD_MAX_CHARACTERS) {
    throw new Error(`管理密码不能超过 ${ADMIN_PASSWORD_MAX_CHARACTERS} 个字符。`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(password)) {
    throw new Error("管理密码不能包含控制字符。");
  }
  return password;
}

function setAdminCookie(response: ServerResponse, token: string): void {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
  );
}

async function sendFile(
  response: ServerResponse,
  fileName: string,
  contentType: string,
): Promise<void> {
  const filePath = new URL(`../public/${fileName}`, import.meta.url);
  const content = await readFile(filePath);
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.end(content);
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("请求必须使用 application/json。");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大。");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("请求 JSON 必须是对象。");
  return parsed;
}

function requireString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} 不能为空。`);
  }
  return value.trim();
}

function requireText(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new Error(`${field} 必须是文本。`);
  }
  return value;
}

function requireBoundedText(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  const text = requireText(body, field).trim();
  if (!allowEmpty && !text) throw new Error(`${field} 不能为空。`);
  if (text.length > maxLength) {
    throw new Error(`${field} 不能超过 ${maxLength} 个字符。`);
  }
  return text;
}

function requireBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean {
  const value = body[field];
  if (typeof value !== "boolean") {
    throw new Error(`${field} 必须是布尔值。`);
  }
  return value;
}

function requireDirectorEventValue(
  value: unknown,
  label: string,
): AgentDirectorEvent {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const allowed = new Set(["enabled", "title", "premise", "world"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} 不是允许的字段。`);
    }
  }
  return {
    enabled: requireBoolean(value, "enabled"),
    title: requireBoundedText(value, "title", 200, true),
    premise: requireBoundedText(value, "premise", 20_000, true),
    world: requireBoundedText(value, "world", 20_000, true),
  };
}

function requireStoryValue(
  value: unknown,
  label: string,
): Pick<AgentStoryBookEntry, "title" | "premise" | "content"> & {
  id?: string;
} {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const allowed = new Set(["id", "title", "premise", "content"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} 不是允许的字段。`);
    }
  }
  const id = Object.hasOwn(value, "id")
    ? requireBoundedText(value, "id", 200, true)
    : "";
  return {
    ...(id ? { id } : {}),
    title: requireBoundedText(value, "title", 200, true),
    premise: requireBoundedText(value, "premise", 20_000, true),
    content: requireBoundedText(value, "content", 100_000, true),
  };
}

function requireQueryString(requestUrl: URL, field: string): string {
  const value = requestUrl.searchParams.get(field)?.trim();
  if (!value) throw new Error(`${field} 不能为空。`);
  return value;
}

function parseAutonomyLimit(value: string | null): number {
  if (value === null || !value.trim()) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("limit 必须是 1–100 之间的整数。");
  }
  return parsed;
}

function publicAutonomySnapshot(
  snapshot: AgentAutonomyAdminSnapshot,
): AgentAutonomyAdminSnapshot {
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
    contactAvailable: snapshot.contactAvailable,
    eventCount: snapshot.eventCount,
    events: snapshot.events.map(publicAutonomyEvent),
  };
}

function publicAutonomyEvent(
  event: AgentAutonomyAdminEvent,
): AgentAutonomyAdminEvent {
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

function publicWeatherSnapshot(
  snapshot: WeatherAdminSnapshot,
): WeatherAdminSnapshot {
  return {
    enabled: snapshot.enabled,
    location: snapshot.location,
    localTime: snapshot.localTime,
    timeZone: snapshot.timeZone,
    lastStatus: snapshot.lastStatus,
    deliveryAvailable: snapshot.deliveryAvailable,
    deliveryState: snapshot.deliveryState,
    ...(snapshot.lastLocalDate
      ? { lastLocalDate: snapshot.lastLocalDate }
      : {}),
    ...(snapshot.lastRunAt ? { lastRunAt: snapshot.lastRunAt } : {}),
    ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}),
    ...(snapshot.lastMessage ? { lastMessage: snapshot.lastMessage } : {}),
    ...(snapshot.nextRunAt ? { nextRunAt: snapshot.nextRunAt } : {}),
  };
}

function memoryEpisodeRebuildKey(userId: string, agentId: string): string {
  return `${userId}\0${agentId}`;
}

function chunkHistoryForEpisodeRebuild(
  messages: readonly AgentMemoryMessage[],
): EpisodeRebuildBatch[] {
  const indexedMessages: EpisodeRebuildSourceMessage[] = messages.map(
    (message, sourceOrder) => ({ ...message, sourceOrder }),
  );
  const turns: EpisodeRebuildSourceMessage[][] = [];
  let turn: EpisodeRebuildSourceMessage[] = [];
  for (const message of indexedMessages) {
    if (message.role === "user" && turn.length) {
      turns.push(turn);
      turn = [];
    }
    turn.push(message);
  }
  if (turn.length) turns.push(turn);

  const batches: EpisodeRebuildBatch[] = [];
  let current: EpisodeRebuildSourceMessage[] = [];
  let currentCharacters = 0;
  let currentCompletedSourceMessages = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push({
      messages: current,
      completedSourceMessages: currentCompletedSourceMessages,
    });
    current = [];
    currentCharacters = 0;
    currentCompletedSourceMessages = 0;
  };
  for (const nextTurn of turns) {
    const turnCharacters = nextTurn.reduce(
      (total, message) => total + message.content.length + 160,
      0,
    );
    if (
      nextTurn.length > EPISODE_REBUILD_BATCH_MESSAGES ||
      turnCharacters > EPISODE_REBUILD_BATCH_CHARACTERS
    ) {
      flush();
      const fragments = nextTurn.flatMap((message) =>
        splitEpisodeRebuildMessage(message),
      );
      for (const fragment of fragments) {
        const fragmentCharacters = fragment.message.content.length + 160;
        if (
          current.length > 0 &&
          (current.length + 1 > EPISODE_REBUILD_BATCH_MESSAGES ||
            currentCharacters + fragmentCharacters >
              EPISODE_REBUILD_BATCH_CHARACTERS)
        ) {
          flush();
        }
        current.push(fragment.message);
        currentCharacters += fragmentCharacters;
        if (fragment.completesSourceMessage) {
          currentCompletedSourceMessages += 1;
        }
      }
      flush();
      continue;
    }
    if (
      current.length > 0 &&
      (current.length + nextTurn.length > EPISODE_REBUILD_BATCH_MESSAGES ||
        currentCharacters + turnCharacters >
          EPISODE_REBUILD_BATCH_CHARACTERS)
    ) {
      flush();
    }
    current.push(...nextTurn);
    currentCharacters += turnCharacters;
    currentCompletedSourceMessages += nextTurn.length;
  }
  flush();
  return batches;
}

function splitEpisodeRebuildMessage(
  message: EpisodeRebuildSourceMessage,
): Array<{
  message: EpisodeRebuildSourceMessage;
  completesSourceMessage: boolean;
}> {
  if (
    message.content.length + 160 <= EPISODE_REBUILD_BATCH_CHARACTERS
  ) {
    return [{ message, completesSourceMessage: true }];
  }
  const parts: string[] = [];
  for (
    let offset = 0;
    offset < message.content.length;
    offset += EPISODE_REBUILD_FRAGMENT_CHARACTERS
  ) {
    parts.push(
      message.content.slice(offset, offset + EPISODE_REBUILD_FRAGMENT_CHARACTERS),
    );
  }
  return parts.map((content, index) => ({
    message: {
      ...message,
      content: `[同一条原始消息，第 ${index + 1}/${parts.length} 段]\n${content}`,
    },
    completesSourceMessage: index === parts.length - 1,
  }));
}

function mergeRebuiltEpisodesBySourceKey(
  episodes: readonly AgentMemoryEpisode[],
): AgentMemoryEpisode[] {
  const ordered = [...episodes].sort((left, right) =>
    (left.sourceOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.sourceOrder ?? Number.MAX_SAFE_INTEGER) ||
    (Date.parse(left.occurredAt ?? "") || 0) -
      (Date.parse(right.occurredAt ?? "") || 0) ||
    left.title.localeCompare(right.title, "zh-CN") ||
    left.content.localeCompare(right.content, "zh-CN")
  );
  const merged = new Map<string, AgentMemoryEpisode>();
  for (const episode of ordered) {
    const baseKey = episode.sourceKey?.normalize("NFKC").trim() ||
      `rebuild:${crypto
        .createHash("sha256")
        .update(`${episode.title}\0${episode.content}`)
        .digest("hex")
        .slice(0, 24)}`;
    const previous = merged.get(baseKey);
    if (!previous) {
      merged.set(baseKey, { ...episode, sourceKey: baseKey });
      continue;
    }
    const previousContent = previous.content.trim();
    const nextContent = episode.content.trim();
    const combinedContent =
      !nextContent || previousContent.includes(nextContent)
        ? previousContent
        : !previousContent || nextContent.includes(previousContent)
        ? nextContent
        : `${previousContent}\n\n后续：${nextContent}`;
    const content = combinedContent.length <= 1_000
      ? combinedContent
      : `${combinedContent.slice(0, 480)}\n\n……\n\n${combinedContent.slice(-480)}`;
    merged.set(baseKey, {
      ...previous,
      sourceKey: baseKey,
      title: episode.title || previous.title,
      content,
      importance: Math.max(
        previous.importance,
        episode.importance,
      ) as AgentMemoryEpisode["importance"],
      updatedAt:
        previous.updatedAt.localeCompare(episode.updatedAt) >= 0
          ? previous.updatedAt
          : episode.updatedAt,
    });
  }
  return [...merged.values()];
}

function safeEpisodeRebuildError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300) ||
    "事件记忆重建失败。";
}

function normalizeEpisodeOccurredAt(value: string | undefined): string {
  if (typeof value !== "string") return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function optionalRoleplay(
  body: Record<string, unknown>,
): AgentRoleplayProfile | undefined {
  const value = body.roleplay;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("roleplay 必须是对象。");
  return value as AgentRoleplayProfile;
}

function optionalImageBehavior(
  body: Record<string, unknown>,
): AgentImageBehavior | undefined {
  if (!Object.hasOwn(body, "imageBehavior")) return undefined;
  return requireImageBehavior(body.imageBehavior);
}

function requireImageBehavior(value: unknown): AgentImageBehavior {
  if (!isRecord(value)) throw new Error("imageBehavior 必须是对象。");
  const allowed = new Set([
    "mode",
    "cooldownMinutes",
    "allowAutonomous",
    "visualIdentityPrompt",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`imageBehavior.${key} 不是允许的字段。`);
    }
  }
  return normalizeAgentImageBehavior(
    value as Partial<AgentImageBehavior>,
  );
}

function optionalConversationMode(
  body: Record<string, unknown>,
): AgentConversationMode | undefined {
  const value = body.conversationMode;
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "roleplay" && value !== "wechat") {
    throw new Error("conversationMode 必须是 roleplay 或 wechat。");
  }
  return value;
}

function optionalPersonaDraftTarget(
  body: Record<string, unknown>,
): PersonaDraftTarget | undefined {
  const value = body.target;
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "profile" && value !== "roleplayStyle") {
    throw new Error("target 必须是 profile 或 roleplayStyle。");
  }
  return value;
}

function safeFileName(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "character";
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function parseCookies(value: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of value.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(raw);
    } catch {
      cookies[key] = raw;
    }
  }
  return cookies;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

function sendText(
  response: ServerResponse,
  status: number,
  value: string,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
