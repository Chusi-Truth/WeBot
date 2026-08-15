#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { loadEnvFile, stdin as input, stdout as output } from "node:process";

import qrcode from "qrcode-terminal";

import { AdminServer } from "./admin-server.js";
import { ILinkApiClient } from "./api-client.js";
import { WeixinAdapter } from "./adapter.js";
import { AgentFramework } from "./agent-framework.js";
import { AgentStore } from "./agent-store.js";
import { AutonomyScheduler } from "./autonomy-scheduler.js";
import { LlmProviderExecutor } from "./llm-executor.js";
import { MediaAiService } from "./media-ai.js";
import { PersonaAssistant } from "./persona-assistant.js";
import { ProviderRegistry } from "./provider-registry.js";
import { PromptTraceStore } from "./prompt-trace-store.js";
import { QrLogin } from "./qr-login.js";
import { ReminderScheduler } from "./reminder-scheduler.js";
import { ReminderStore } from "./reminder-store.js";
import { StateStore } from "./storage.js";
import { ToolRegistry } from "./tool-registry.js";
import { ProviderVoiceTranscriber } from "./voice-transcriber.js";
import { WeatherScheduleStore } from "./weather-schedule-store.js";
import { WeatherScheduler } from "./weather-scheduler.js";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const command = process.argv[2] ?? "help";
const store = new StateStore();

switch (command) {
  case "login":
    await login();
    break;
  case "start":
    await start();
    break;
  case "admin":
    await adminOnly();
    break;
  case "status":
    await status();
    break;
  case "logout":
    await logout();
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    console.error(`未知命令：${command}\n`);
    printHelp();
    process.exitCode = 1;
}

async function login(): Promise<void> {
  const api = new ILinkApiClient({
    baseUrl: process.env.WEBOT_API_BASE_URL ?? "https://ilinkai.weixin.qq.com",
  });
  const flow = new QrLogin(api, store);
  const readline = createInterface({ input, output });
  let lastStatus = "";

  try {
    const credential = await flow.login({
      botType: process.env.WEBOT_BOT_TYPE ?? "3",
      onQrCode: (url) => {
        console.log("\n请用手机微信扫描二维码并确认授权：\n");
        qrcode.generate(url, { small: true });
        console.log(`\n备用链接：${url}\n`);
      },
      onStatus: (next) => {
        if (next !== lastStatus) {
          const labels: Partial<Record<typeof next, string>> = {
            wait: "等待扫码…",
            scaned: "已扫码，请在手机上确认…",
            need_verifycode: "需要验证码…",
            confirmed: "授权成功。",
            expired: "二维码已过期，正在刷新…",
            scaned_but_redirect: "正在切换微信接入节点…",
            verify_code_blocked: "验证码多次错误，正在刷新二维码…",
            binded_redirect: "该微信已经绑定。",
          };
          console.log(labels[next] ?? next);
          lastStatus = next;
        }
      },
      requestVerificationCode: async () =>
        readline.question("请输入手机微信显示的数字："),
    });
    console.log(`\n登录凭证已安全保存：${store.credentialPath}`);
    console.log(`账号：${credential.accountId}`);
  } finally {
    readline.close();
  }
}

async function start(): Promise<void> {
  const stateDir = store.stateDir;
  const providers = await ProviderRegistry.load({
    stateDir,
  });
  const mediaAi = new MediaAiService(providers);
  const voiceTranscriber = new ProviderVoiceTranscriber(providers);
  const adapter = new WeixinAdapter({
    stateDir,
    voiceTranscriber: voiceTranscriber.transcribe,
    imageAnalyzer: (request) => mediaAi.describeImages(request),
    messageDebounceMs: readBoundedInteger(
      "WEBOT_MESSAGE_DEBOUNCE_MS",
      1_500,
      0,
      10_000,
    ),
    messageMaxWaitMs: readBoundedInteger(
      "WEBOT_MESSAGE_MAX_WAIT_MS",
      5_000,
      0,
      30_000,
    ),
    bubbleBaseDelayMs: readBubbleBaseDelay(),
    bubbleDelayPerCharacterMs: readBoundedInteger(
      "WEBOT_BUBBLE_MS_PER_CHARACTER",
      120,
      0,
      1_000,
    ),
    bubbleMinDelayMs: readBoundedInteger(
      "WEBOT_BUBBLE_MIN_DELAY_MS",
      1_000,
      0,
      30_000,
    ),
    bubbleMaxDelayMs: readBoundedInteger(
      "WEBOT_BUBBLE_MAX_DELAY_MS",
      7_000,
      0,
      30_000,
    ),
  });
  const credential = await adapter.initialize();
  const traces = createPromptTraceStore(stateDir);
  const reminderStore = new ReminderStore(stateDir);
  const agentStore = createAgentStore(
    adapter.store.stateDir,
    traces,
    reminderStore,
  );
  const tools = new ToolRegistry({
    stateDir,
    reminders: reminderStore,
    imageGenerator: {
      isAvailable: () => mediaAi.isImageGenerationAvailable(),
      generate: (request) => mediaAi.generateImage(request),
    },
  });
  const llm = new LlmProviderExecutor(providers, {
    traces,
    tools,
    promptBudgetTokens: readBoundedInteger(
      "WEBOT_PROMPT_BUDGET_TOKENS",
      24_000,
      4_096,
      200_000,
    ),
  });
  const personaAssistant = new PersonaAssistant(providers);
  if (credential.userId) {
    await agentStore.getRegistry(credential.userId);
  }
  const autonomy = new AutonomyScheduler({
    stateDir: adapter.store.stateDir,
    agents: agentStore,
    generator: (request) => llm.generateAutonomousEvent(request),
    sendText: (params) => adapter.sendText(params),
    sendAutonomousImage: async ({
      userId,
      agent,
      contextToken,
      prompt,
      includesAgent,
    }) => {
      if (!agent.imageBehavior) {
        throw new Error("Agent 没有有效的图片行为配置。");
      }
      return tools.generateAndDeliverAutonomousImage({
        userId,
        agentId: agent.id,
        imageBehavior: agent.imageBehavior,
        prompt,
        includesAgent,
        deliver: (image) =>
          adapter.sendGeneratedImage({
            toUserId: userId,
            contextToken,
            data: image.data,
          }),
      });
    },
    defaultEnabled: readBoolean("WEBOT_AUTONOMY_DEFAULT_ENABLED", false),
    idleHours: readPositiveNumber("WEBOT_AUTONOMY_IDLE_HOURS", 6),
    generationIntervalHours: readPositiveNumber(
      "WEBOT_AUTONOMY_INTERVAL_HOURS",
      6,
    ),
    maxContactsPerDay: readNonNegativeInteger(
      "WEBOT_AUTONOMY_MAX_CONTACTS_PER_DAY",
      1,
    ),
    timeZone: process.env.WEBOT_AUTONOMY_TIME_ZONE ?? "Asia/Shanghai",
    contextMaxAgeHours: readPositiveNumber(
      "WEBOT_CONTEXT_TOKEN_MAX_AGE_HOURS",
      24,
    ),
  });
  const weather = new WeatherScheduler({
    stateDir: adapter.store.stateDir,
    agents: agentStore,
    tools,
    getDeliveryContext: (userId) => autonomy.getDeliveryContext(userId),
    sendText: (params) => adapter.sendText(params),
    generateComment: (params) => llm.generateScheduledWeatherComment(params),
    catchUpMinutes: readNonNegativeInteger(
      "WEBOT_WEATHER_CATCH_UP_MINUTES",
      180,
    ),
    contextMaxAgeHours: readPositiveNumber(
      "WEBOT_CONTEXT_TOKEN_MAX_AGE_HOURS",
      24,
    ),
  });
  const reminders = new ReminderScheduler({
    stateDir: adapter.store.stateDir,
    agents: agentStore,
    getDeliveryContext: (userId) => autonomy.getDeliveryContext(userId),
    sendText: (params) => adapter.sendText(params),
    selectTone: (params) => llm.selectScheduledWeatherTone(params),
    catchUpHours: readPositiveNumber("WEBOT_REMINDER_CATCH_UP_HOURS", 24),
    contextMaxAgeHours: readPositiveNumber(
      "WEBOT_CONTEXT_TOKEN_MAX_AGE_HOURS",
      24,
    ),
  });
  const agents = new AgentFramework({
    store: agentStore,
    providers,
    executor: (context) => llm.execute(context),
    capturePromptTraceGeneration: (userId, agentId) =>
      traces.captureGeneration(userId, agentId),
    memoryCompressor: (request) => llm.compressMemory(request),
    memoryEpisodeOrganizer: (request) => llm.organizeMemoryEpisodes(request),
    autonomy,
    reminders,
    outboundImages: true,
    generatedImages: () => mediaAi.isImageGenerationAvailable(),
  });
  const admin =
    process.env.WEBOT_ADMIN_ENABLED?.trim().toLowerCase() === "false"
      ? undefined
      : new AdminServer({
          stateDir: adapter.store.stateDir,
          agents: agentStore,
          providers,
          personaDraftGenerator: (request) =>
            personaAssistant.generateDraft(request),
          writingExampleDraftGenerator: (request) =>
            personaAssistant.generateWritingExampleDraft(request),
          directorEventDraftGenerator: (request) =>
            personaAssistant.generateDirectorEventDraft(request),
          storyDraftGenerator: (request) =>
            personaAssistant.generateStoryDraft(request),
          memoryEpisodeExtractor: (request) =>
            llm.extractMemoryEpisodes(request),
          memoryEpisodeOrganizer: (request) =>
            llm.organizeMemoryEpisodes(request),
          autonomy,
          weather,
          traces,
          port: readAdminPort(),
        });
  if (admin) {
    const { loginUrl } = await admin.start();
    console.log(`管理后台：${loginUrl}`);
  }
  console.log(
    `默认模型 Provider：${providers.defaultProviderId}（发送 /provider list 查看）`,
  );

  const stop = () => {
    console.log("\n正在停止…");
    autonomy.stop();
    weather.stop();
    reminders.stop();
    adapter.stop();
    void admin?.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    autonomy.start();
    weather.start();
    reminders.start();
    await adapter.start(
      async (message) => {
        console.log(`[${message.senderId}] ${message.text}`);
        return agents.handle(message.senderId, message.text, {
          ...(message.createdAt === undefined
            ? {}
            : { receivedAt: message.createdAt }),
          ...(message.imageObservations?.length
            ? { imageObservations: message.imageObservations }
            : {}),
        });
      },
      async (context) => {
        await autonomy.recordInteraction(
          context.senderId,
          context.contextToken,
        );
      },
    );
  } finally {
    autonomy.stop();
    weather.stop();
    reminders.stop();
    await admin?.stop();
  }
}

async function adminOnly(): Promise<void> {
  const traces = createPromptTraceStore(store.stateDir);
  const reminderStore = new ReminderStore(store.stateDir);
  const agentStore = createAgentStore(store.stateDir, traces, reminderStore);
  const credential = await store.loadCredential();
  if (credential?.userId) {
    await agentStore.getRegistry(credential.userId);
  }
  const providers = await ProviderRegistry.load({
    stateDir: store.stateDir,
  });
  const mediaAi = new MediaAiService(providers);
  const tools = new ToolRegistry({
    stateDir: store.stateDir,
    reminders: reminderStore,
    imageGenerator: {
      isAvailable: () => mediaAi.isImageGenerationAvailable(),
      generate: (request) => mediaAi.generateImage(request),
    },
  });
  const llm = new LlmProviderExecutor(providers, {
    traces,
    tools,
    promptBudgetTokens: readBoundedInteger(
      "WEBOT_PROMPT_BUDGET_TOKENS",
      24_000,
      4_096,
      200_000,
    ),
  });
  const personaAssistant = new PersonaAssistant(providers);
  const autonomy = new AutonomyScheduler({
    stateDir: store.stateDir,
    agents: agentStore,
    generator: (request) => llm.generateAutonomousEvent(request),
    sendText: async () => {
      throw new Error("仅管理后台模式不能主动发送微信消息。");
    },
    defaultEnabled: readBoolean("WEBOT_AUTONOMY_DEFAULT_ENABLED", false),
    idleHours: readPositiveNumber("WEBOT_AUTONOMY_IDLE_HOURS", 6),
    generationIntervalHours: readPositiveNumber(
      "WEBOT_AUTONOMY_INTERVAL_HOURS",
      6,
    ),
    maxContactsPerDay: readNonNegativeInteger(
      "WEBOT_AUTONOMY_MAX_CONTACTS_PER_DAY",
      1,
    ),
    timeZone: process.env.WEBOT_AUTONOMY_TIME_ZONE ?? "Asia/Shanghai",
    contextMaxAgeHours: readPositiveNumber(
      "WEBOT_CONTEXT_TOKEN_MAX_AGE_HOURS",
      24,
    ),
  });
  const weather = new WeatherScheduler({
    stateDir: store.stateDir,
    agents: agentStore,
    tools,
    getDeliveryContext: (userId) => autonomy.getDeliveryContext(userId),
    sendText: async () => {
      throw new Error("仅管理后台模式不能主动发送微信消息。");
    },
    generateComment: (params) => llm.generateScheduledWeatherComment(params),
    catchUpMinutes: readNonNegativeInteger(
      "WEBOT_WEATHER_CATCH_UP_MINUTES",
      180,
    ),
    contextMaxAgeHours: readPositiveNumber(
      "WEBOT_CONTEXT_TOKEN_MAX_AGE_HOURS",
      24,
    ),
    deliveryEnabled: false,
  });
  const admin = new AdminServer({
    stateDir: store.stateDir,
    agents: agentStore,
    providers,
    personaDraftGenerator: (request) => personaAssistant.generateDraft(request),
    writingExampleDraftGenerator: (request) =>
      personaAssistant.generateWritingExampleDraft(request),
    directorEventDraftGenerator: (request) =>
      personaAssistant.generateDirectorEventDraft(request),
    storyDraftGenerator: (request) =>
      personaAssistant.generateStoryDraft(request),
    memoryEpisodeExtractor: (request) => llm.extractMemoryEpisodes(request),
    memoryEpisodeOrganizer: (request) => llm.organizeMemoryEpisodes(request),
    autonomy,
    weather,
    traces,
    port: readAdminPort(),
  });
  const { loginUrl } = await admin.start();
  console.log(`WeBot 管理后台已启动：${loginUrl}`);
  console.log("按 Ctrl+C 停止。");
  await new Promise<void>((resolve) => {
    const stop = () => {
      autonomy.stop();
      weather.stop();
      void admin.stop().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function status(): Promise<void> {
  const credential = await store.loadCredential();
  if (!credential) {
    console.log("未登录。");
    return;
  }
  console.log("已登录。");
  console.log(`账号：${credential.accountId}`);
  console.log(`接入地址：${credential.baseUrl}`);
  console.log(`凭证保存时间：${credential.savedAt}`);
  console.log(`状态目录：${store.stateDir}`);
}

async function logout(): Promise<void> {
  await store.clearCredential();
  console.log("本地登录凭证和消息游标已删除。");
  console.log("如需彻底解绑，请同时在微信的 ClawBot 授权入口取消授权。");
}

function printHelp(): void {
  console.log(`WeBot iLink Adapter

用法：
  npm run login    扫码登录微信
  npm run start    启动文本消息机器人
  npm run admin    仅启动本机管理后台
  npm run status   查看本地登录状态
  npm run logout   删除本地凭证
  npm test         运行测试
`);
}

function readAdminPort(): number {
  const value = Number.parseInt(process.env.WEBOT_ADMIN_PORT ?? "3210", 10);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("WEBOT_ADMIN_PORT 必须是 1024–65535 之间的端口。");
  }
  return value;
}

function createAgentStore(
  stateDir: string,
  traces?: PromptTraceStore,
  reminders?: ReminderStore,
): AgentStore {
  const weatherSchedules = new WeatherScheduleStore(stateDir);
  return new AgentStore({
    stateDir,
    maxMemoryMessages: readPositiveEven(
      "WEBOT_MEMORY_COMPRESSION_THRESHOLD",
      40,
      4,
    ),
    retainRecentMessages: readPositiveEven(
      "WEBOT_MEMORY_RETAIN_MESSAGES",
      20,
      2,
    ),
    ...(traces
      ? {
          onClearAgentData: (userId: string, agentId: string) =>
            traces.clear(userId, agentId),
        }
      : {}),
    onDeleteAgent: async (userId, agentId) => {
      await Promise.all([
        weatherSchedules.deleteAgent(userId, agentId),
        ...(reminders ? [reminders.deleteAgent(userId, agentId)] : []),
      ]);
    },
  });
}

function createPromptTraceStore(stateDir: string): PromptTraceStore {
  return new PromptTraceStore(stateDir, {
    retention: readBoundedInteger("WEBOT_PROMPT_TRACE_RETENTION", 20, 1, 100),
  });
}

function readPositiveEven(
  environmentName: string,
  fallback: number,
  minimum: number,
): number {
  const raw = process.env[environmentName]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value % 2 !== 0) {
    throw new Error(`${environmentName} 必须是不小于 ${minimum} 的偶数。`);
  }
  return value;
}

function readBoolean(environmentName: string, fallback: boolean): boolean {
  const raw = process.env[environmentName]?.trim().toLocaleLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${environmentName} 必须是 true 或 false。`);
}

function readPositiveNumber(environmentName: string, fallback: number): number {
  const raw = process.env[environmentName]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${environmentName} 必须是正数。`);
  }
  return value;
}

function readNonNegativeInteger(
  environmentName: string,
  fallback: number,
): number {
  const raw = process.env[environmentName]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${environmentName} 必须是非负整数。`);
  }
  return value;
}

function readBoundedInteger(
  environmentName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[environmentName]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${environmentName} 必须是 ${minimum}–${maximum} 之间的整数。`,
    );
  }
  return value;
}

function readBubbleBaseDelay(): number {
  const environmentName = process.env.WEBOT_BUBBLE_BASE_DELAY_MS?.trim()
    ? "WEBOT_BUBBLE_BASE_DELAY_MS"
    : "WEBOT_BUBBLE_DELAY_MS";
  return readBoundedInteger(environmentName, 800, 0, 10_000);
}
