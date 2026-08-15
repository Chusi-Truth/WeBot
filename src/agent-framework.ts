import type {
  AgentExecutionContext,
  AgentExecutor,
  AgentMemoryContext,
  AgentMemoryCompressor,
  AgentMemoryEpisode,
  AgentMemoryEpisodeOrganizer,
  AgentMemoryFact,
  AgentMemoryMajorEvent,
  AgentMemoryMessage,
  AgentProfile,
  AgentAutonomyRuntime,
} from "./agent-types.js";
import { AgentStore } from "./agent-store.js";
import { selectRelevantLore } from "./character-card.js";
import { applyCharacterTemplates } from "./character-card.js";
import { usesWechatMode } from "./prompt-compiler.js";
import {
  collectUserImageUrls,
  IMAGE_REPLY_DIRECTIVE,
  parseReplyParts,
} from "./reply-parts.js";
import { splitModelReply } from "./reply-sequence.js";
import type { ProviderCatalog } from "./provider-types.js";
import type {
  GeneratedImageAttachment,
  IncomingImageObservation,
  OutgoingReplyEnvelope,
  OutgoingReplyPart,
} from "./types.js";

const HELP_TEXT = `WeBot 帮助

直接发送文字或语音，即可和当前 Agent 聊天。

常用指令：
/agent show　查看当前 Agent
/agent list　查看 Agent 列表
/agent use <名称>　切换 Agent
/agent mode wechat　微信聊天模式
/agent mode roleplay　沉浸情景模式
/memory show　查看记忆总览
/story　查看当前 Agent 的故事书
/story send <序号>　把完整故事发送到聊天框
/life status　查看自主生活状态
/reminder list　查看当前人物的提醒
/provider list　查看可用模型

详细帮助：
/help agent　Agent 创建、修改与删除
/help memory　记忆查看与清除
/help story　故事书阅读
/help life　自主生活与主动联系
/help reminder　备忘与定点提醒
/help image　发送图片
/help model　模型选择

不同 Agent 的记忆彼此隔离；同一 Agent 切换聊天模式时共用记忆。`;

const AGENT_HELP_TEXT = `Agent 指令：
/agent list　查看 Agent 列表
/agent show　查看当前 Agent
/agent use <名称>　切换 Agent
/agent create <名称> <身份描述>　创建 Agent
/agent update <新身份描述>　修改当前身份
/agent rename <新名称>　重命名当前 Agent
/agent mode wechat　切换为微信聊天
/agent mode roleplay　切换为沉浸情景
/agent delete <名称>　删除 Agent 及其记忆`;

const MEMORY_HELP_TEXT = `记忆指令：
/memory show　查看长期摘要、事实、关键经历和最近工作窗口
/memory show <条数>　兼容查看工作窗口最近消息，最多 20 条
/memory history [页码]　分页查看完整聊天，第 1 页为最新
/memory turn <轮号> [页码]　分页查看某一轮的完整原文
/memory summary [页码]　分页查看完整长期摘要
/memory facts [页码]　分页查看全部长期事实
/memory episodes [页码]　分页查看全部关键经历
/memory status　查看记忆数量与压缩状态
/memory clear　清空当前 Agent 的全部记忆`;

const MEMORY_HISTORY_TURNS_PER_PAGE = 5;
const MEMORY_TURN_CHARS_PER_PAGE = 1_600;
const MEMORY_SUMMARY_CHARS_PER_PAGE = 1_600;
const MEMORY_FACTS_PER_PAGE = 5;
const MEMORY_EPISODES_PER_PAGE = 2;
const MEMORY_COMMAND_MAX_CHARS = 3_500;
const MEMORY_HISTORY_TURN_MAX_CHARS = 560;
const STORY_CHAT_BUBBLE_MAX_CHARS = 3_200;

const MODEL_HELP_TEXT = `模型指令：
/provider list　查看可用 Provider
/provider show　查看当前 Agent 的模型
/agent model <Provider> [模型]　选择模型
/agent model default　恢复默认模型`;

const LIFE_HELP_TEXT = `自主生活指令：
/life on　开启当前 Agent 的自主生活
/life off　关闭当前 Agent 的自主生活
/life status　查看状态
/life show　查看最近的自主经历
/life now　立即生成一段经历（不会主动发消息）

开启后，当前 Agent 会在你离线一段时间后形成自己的经历。只有较重要且确有理由的事情才会尝试主动联系；受微信 iLink 会话令牌限制，主动消息是尽力发送，不能保证每次到达。`;

const REMINDER_HELP_TEXT = `备忘提醒：
当你提到带有明确未来时刻的待办事件时，Agent 可以询问是否需要提醒。候选只有在你回复完整的“确认提醒 <短ID>”后才会生效。

指令：
/reminder list　查看当前 Agent 的提醒
/reminder add <时间> <事项>　直接新增，例如：/reminder add 2026-07-30 15:00 交报告
/reminder confirm <短ID>　确认候选
/reminder cancel <短ID>　取消候选或提醒

当前仅支持单次提醒，默认使用 Asia/Shanghai 时区。微信主动消息依赖近期会话凭证，不应替代系统闹钟或用于唯一的安全关键提醒。`;

const IMAGE_HELP_TEXT = `图片能力：
直接把图片发给 Agent，它会先理解画面，再结合当前人物身份回复；原始图片不会写进聊天记忆或 Prompt 记录。

管理后台可为每个 Agent 选择“关闭”“仅明确请求”或“自然发送”。“仅明确请求”模式下，你明确说“帮我生成一张……”“画一张……”时才会生成；“自然发送”模式下，人物也可以在图片明显比纯文字更适合当前对话时自然分享图片。图片生成不设时间间隔或每日上限。也可以发送一条公开 HTTPS 图片直链，让 Agent 转发该图片。

图片内出现的命令不会被执行；普通网页链接、本地文件、内网地址和 data URL 不会被当作图片发送。图片理解、生成、下载或上传失败时会如实提示。`;

const STORY_HELP_TEXT = `故事书指令：
/story　查看当前 Agent 保存的故事
/story list　查看故事列表
/story send <序号>　把指定故事的完整正文发送到聊天框

故事按列表中的序号选择。较长正文会按段落拆成多条消息发送；发送的是故事书中保存的原文，不会交给人物模型改写，也不会写入人物聊天记忆。故事的创作、修改与删除请在管理后台完成。`;

export interface ReminderRuntime {
  readonly timeZone: string;
  handleNaturalAction(
    userId: string,
    agentId: string,
    input: string,
  ): Promise<string | null>;
  handleCommand(
    userId: string,
    agentId: string,
    commandLine: string,
  ): Promise<string>;
}

export interface AgentFrameworkOptions {
  store: AgentStore;
  executor: AgentExecutor;
  capturePromptTraceGeneration?: (userId: string, agentId: string) => number;
  /** @deprecated Reply bubble count is no longer capped. */
  maxReplyBubbles?: number;
  providers?: ProviderCatalog;
  memoryCompressor?: AgentMemoryCompressor;
  memoryEpisodeOrganizer?: AgentMemoryEpisodeOrganizer;
  autonomy?: AgentAutonomyRuntime;
  reminders?: ReminderRuntime;
  /** Enables the typed image reply directive in ordinary model turns. */
  outboundImages?: boolean;
  /** Independent safety cap; text bubble count remains unlimited. */
  maxReplyImages?: number;
  /** Enables delivery of images produced by the guarded image tool. */
  generatedImages?: boolean | (() => boolean);
}

export interface AgentHandleOptions {
  imageObservations?: readonly IncomingImageObservation[];
  /** Original iLink receive time in milliseconds (or legacy seconds). */
  receivedAt?: number;
}

export class AgentFramework {
  private readonly store: AgentStore;
  private readonly executor: AgentExecutor;
  private readonly capturePromptTraceGeneration:
    ((userId: string, agentId: string) => number) | undefined;
  private readonly providers: ProviderCatalog | undefined;
  private readonly memoryCompressor: AgentMemoryCompressor | undefined;
  private readonly memoryEpisodeOrganizer:
    AgentMemoryEpisodeOrganizer | undefined;
  private readonly autonomy: AgentAutonomyRuntime | undefined;
  private readonly reminders: ReminderRuntime | undefined;
  private readonly outboundImages: boolean;
  private readonly maxReplyImages: number;
  private readonly generatedImagesAvailable: () => boolean;
  private readonly compressionInFlight = new Set<string>();

  constructor(options: AgentFrameworkOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.capturePromptTraceGeneration = options.capturePromptTraceGeneration;
    this.providers = options.providers;
    this.memoryCompressor = options.memoryCompressor;
    this.memoryEpisodeOrganizer = options.memoryEpisodeOrganizer;
    this.autonomy = options.autonomy;
    this.reminders = options.reminders;
    this.outboundImages = options.outboundImages ?? false;
    this.maxReplyImages = normalizeReplyImageLimit(options.maxReplyImages);
    const generatedImages = options.generatedImages;
    this.generatedImagesAvailable =
      typeof generatedImages === "function"
        ? generatedImages
        : () => generatedImages ?? false;
  }

  async handle(
    userId: string,
    input: string,
    options: AgentHandleOptions = {},
  ): Promise<string | string[] | OutgoingReplyEnvelope> {
    const trimmed = input.trim();
    if (trimmed === "/help" || trimmed.startsWith("/help ")) {
      return this.handleHelpCommand(trimmed);
    }
    if (trimmed.startsWith("/agent")) {
      return this.handleAgentCommand(userId, trimmed);
    }
    if (trimmed.startsWith("/memory")) {
      return this.handleMemoryCommand(userId, trimmed);
    }
    if (trimmed === "/story" || trimmed.startsWith("/story ")) {
      return this.handleStoryCommand(userId, trimmed);
    }
    if (trimmed.startsWith("/provider")) {
      return this.handleProviderCommand(userId, trimmed);
    }
    if (trimmed === "/life" || trimmed.startsWith("/life ")) {
      return this.autonomy
        ? this.autonomy.handleCommand(userId, trimmed)
        : "当前没有启用自主生活服务。";
    }
    if (trimmed === "/reminder" || trimmed.startsWith("/reminder ")) {
      if (!this.reminders) return "当前没有启用备忘提醒服务。";
      const agent = await this.store.getActiveAgent(userId);
      return this.reminders.handleCommand(userId, agent.id, trimmed);
    }
    if (this.reminders) {
      const agent = await this.store.getActiveAgent(userId);
      const action = await this.reminders.handleNaturalAction(
        userId,
        agent.id,
        trimmed,
      );
      if (action) {
        const dataGeneration = this.store.captureDataGeneration(
          userId,
          agent.id,
        );
        const conversationMode = resolvedConversationMode(agent);
        await this.store.appendTurn(
          userId,
          agent.id,
          { input, replies: [action], conversationMode },
          dataGeneration,
        );
        return action;
      }
    }

    const agent = await this.store.getActiveAgent(userId);
    const currentTime = new Date();
    const currentMessageTime = normalizeReceivedAt(
      options.receivedAt,
      currentTime,
    );
    const chatTimeZone = this.reminders?.timeZone ?? "Asia/Shanghai";
    const dataGeneration = this.store.captureDataGeneration(userId, agent.id);
    // Capture both generations synchronously before loading memory. A clear
    // that starts afterwards will invalidate both eventual writes.
    const promptTraceGeneration = this.capturePromptTraceGeneration?.(
      userId,
      agent.id,
    );
    const memory = await this.store.getMemoryContext(userId, agent.id);
    const autonomousEvents = await this.autonomy?.getRecentEvents(
      userId,
      agent.id,
      10,
    );
    const imageObservations = normalizeImageObservations(
      options.imageObservations,
    );
    const generatedImagesEnabled =
      agent.imageBehavior?.mode !== "off" &&
      safelyCheckCapability(this.generatedImagesAvailable);
    const generatedImages: GeneratedImageAttachment[] = [];
    const context: AgentExecutionContext = {
      userId,
      agent,
      chatTime: {
        timeZone: chatTimeZone,
        currentTime: currentTime.toISOString(),
        currentMessageTime: currentMessageTime.toISOString(),
      },
      ...(this.reminders
        ? {
            reminderCapability: {
              timeZone: this.reminders.timeZone,
            },
          }
        : {}),
      ...(this.outboundImages
        ? {
            imageOutputCapability: {
              maxImagesPerReply: this.maxReplyImages,
              ...(generatedImagesEnabled ? { canGenerateImages: true } : {}),
            },
          }
        : {}),
      ...(promptTraceGeneration === undefined ? {} : { promptTraceGeneration }),
      memory: memory.messages,
      memorySummary: memory.summary,
      memoryFacts: memory.facts,
      memoryEpisodes: memory.episodes,
      memoryMajorEvents: memory.majorEvents ?? [],
      ...(autonomousEvents?.length ? { autonomousEvents } : {}),
      ...(imageObservations.length
        ? {
            imageObservations: imageObservations.map(
              (observation) => observation.description,
            ),
          }
        : {}),
      ...(generatedImagesEnabled
        ? {
            acceptGeneratedImage: (image: GeneratedImageAttachment) => {
              if (generatedImages.length >= this.maxReplyImages) {
                throw new Error("本轮生成图片数量超过安全限制。");
              }
              generatedImages.push(image);
            },
          }
        : {}),
      relevantLore: selectRelevantLore(
        agent.roleplay?.lorebook,
        imageObservations.length
          ? `${input}\n${imageObservations
              .map((observation) => observation.description)
              .join("\n")}`
          : input,
        memory.messages,
      ),
      input,
    };
    // Freeze the presentation mode for the whole turn. A concurrent admin
    // change must not relabel an in-flight reply as belonging to the new mode.
    const conversationMode = usesWechatMode(context) ? "wechat" : "roleplay";
    const rawReply = (await this.executor(context)).trim();
    if (!rawReply) throw new Error(`Agent“${agent.name}”返回了空回复。`);
    const containsImageDirective =
      this.outboundImages && rawReply.includes(`[[${IMAGE_REPLY_DIRECTIVE}`);
    const replies = splitModelReply(
      rawReply,
      containsImageDirective ? "wechat" : conversationMode,
    );
    if (!replies.length) throw new Error(`Agent“${agent.name}”返回了空回复。`);
    // A generated image is already attached out-of-band by the tool. Some
    // models still emit the legacy public-URL directive after a successful
    // tool call; treating that extra directive as a forwarding request creates
    // a misleading "no public link" bubble before the real image.
    const replyBubbles = generatedImages.length
      ? replies.filter(
          (reply) =>
            !reply.trim().toUpperCase().startsWith(`[[${IMAGE_REPLY_DIRECTIVE}`),
        )
      : replies;
    const parsedReply = this.outboundImages
      ? parseReplyParts(
          replyBubbles,
          Math.max(0, this.maxReplyImages - generatedImages.length),
          {
            allowedSourceUrls: collectUserImageUrls([
              input,
              ...memory.messages
                .filter((message) => message.role === "user")
                .slice(-12)
                .map((message) => message.content),
            ]),
          },
        )
      : undefined;
    const generatedImageParts = generatedImages
      .slice(0, this.maxReplyImages)
      .map((image): OutgoingReplyPart => ({
        type: "generated_image",
        data: image.data,
        mimeType: image.mimeType,
        memoryText: `[生成并发送了一张图片：${summarizeGeneratedImagePrompt(
          image.revisedPrompt ?? image.prompt,
        )}]`,
        fallbackText: "图片已经生成了，但这次没能发送出去。",
      }));
    if (parsedReply?.transformed || generatedImageParts.length) {
      const ordinaryParts: OutgoingReplyPart[] = parsedReply?.transformed
        ? [...parsedReply.parts]
        : replyBubbles.map((text) => ({ type: "text", text }));
      let finalization: Promise<void> | undefined;
      return {
        parts: [...ordinaryParts, ...generatedImageParts],
        finalizeDelivery: (deliveredMemoryReplies: readonly string[]) => {
          finalization ??= this.persistDeliveredTurn({
            userId,
            agent,
            input: memoryInput(input, imageObservations),
            replies: deliveredMemoryReplies.length
              ? deliveredMemoryReplies
              : ["[本轮回复未能送达]"],
            conversationMode,
            dataGeneration,
            inputCreatedAt: currentMessageTime.toISOString(),
          });
          return finalization;
        },
      };
    }
    const result: string | string[] =
      replies.length === 1 ? replies[0]! : replies;
    await this.persistDeliveredTurn({
      userId,
      agent,
      input: memoryInput(input, imageObservations),
      replies,
      conversationMode,
      dataGeneration,
      inputCreatedAt: currentMessageTime.toISOString(),
    });
    return result;
  }

  private async persistDeliveredTurn(params: {
    userId: string;
    agent: AgentProfile;
    input: string;
    replies: readonly string[];
    conversationMode: "wechat" | "roleplay";
    dataGeneration: number;
    inputCreatedAt?: string;
  }): Promise<void> {
    const persisted = await this.store.appendTurn(
      params.userId,
      params.agent.id,
      {
        input: params.input,
        replies: params.replies,
        conversationMode: params.conversationMode,
        ...(params.inputCreatedAt
          ? { inputCreatedAt: params.inputCreatedAt }
          : {}),
      },
      params.dataGeneration,
    );
    if (!persisted) return;
    const compression = await this.store.prepareMemoryCompression(
      params.userId,
      params.agent.id,
      params.dataGeneration,
    );
    if (compression) {
      if (this.memoryCompressor) {
        this.scheduleMemoryCompression(
          params.userId,
          params.agent,
          params.dataGeneration,
        );
      } else {
        await this.store.applyLocalMemoryCompression(
          params.userId,
          params.agent.id,
          compression,
          params.dataGeneration,
        );
      }
    }
  }

  private handleHelpCommand(commandLine: string): string {
    const [, topic] = splitOnce(commandLine);
    switch (topic.trim().toLocaleLowerCase()) {
      case "":
        return HELP_TEXT;
      case "agent":
        return AGENT_HELP_TEXT;
      case "memory":
        return MEMORY_HELP_TEXT;
      case "story":
      case "storybook":
        return STORY_HELP_TEXT;
      case "model":
      case "provider":
        return MODEL_HELP_TEXT;
      case "life":
        return LIFE_HELP_TEXT;
      case "reminder":
      case "remind":
        return REMINDER_HELP_TEXT;
      case "image":
      case "picture":
        return IMAGE_HELP_TEXT;
      default:
        return "没有这个帮助主题。可用主题：agent、memory、story、life、reminder、image、model\n发送 /help 查看常用指令。";
    }
  }

  private scheduleMemoryCompression(
    userId: string,
    agent: AgentProfile,
    dataGeneration: number,
  ): void {
    const key = `${userId}\0${agent.id}`;
    if (this.compressionInFlight.has(key) || !this.memoryCompressor) return;
    this.compressionInFlight.add(key);
    void (async () => {
      try {
        let candidate = await this.store.prepareMemoryCompression(
          userId,
          agent.id,
          dataGeneration,
        );
        while (candidate) {
          const result = await this.memoryCompressor?.({
            userId,
            agent,
            ...candidate,
          });
          if (!result) return;
          await this.store.applyMemoryCompression(
            userId,
            agent.id,
            candidate,
            result,
            dataGeneration,
          );
          candidate = await this.store.prepareMemoryCompression(
            userId,
            agent.id,
            dataGeneration,
          );
        }
        await this.organizeMemoryEpisodes(userId, agent, dataGeneration);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(
          `[memory] Agent“${agent.name}”压缩失败，原始聊天仍已保存：${detail}`,
        );
      } finally {
        this.compressionInFlight.delete(key);
      }
    })();
  }

  private async organizeMemoryEpisodes(
    userId: string,
    agent: AgentProfile,
    dataGeneration: number,
  ): Promise<void> {
    if (!this.memoryEpisodeOrganizer) return;
    try {
      const candidate = await this.store.getMemoryEpisodeOrganizationCandidate(
        userId,
        agent.id,
      );
      if (!candidate.needsOrganization || !candidate.episodes.length) return;
      const groups = await this.memoryEpisodeOrganizer({
        userId,
        agent,
        episodes: candidate.episodes,
        sourceMessageCount: candidate.sourceMessageCount,
        previousMajorEvents: candidate.previousMajorEvents,
      });
      const saved = await this.store.saveMemoryEpisodeHierarchy(
        userId,
        agent.id,
        {
          inputFingerprint: candidate.inputFingerprint,
          groups,
          organizedDetailKeys: candidate.episodes.map(
            (episode) => episode.sourceKey,
          ),
        },
        dataGeneration,
      );
      if (!saved) {
        console.warn(
          `[memory] Agent“${agent.name}”的大事件整理结果已过期，将在下次压缩后重试。`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[memory] Agent“${agent.name}”的大事件整理失败，原有事件细节仍已保存：${detail}`,
      );
    }
  }

  private async handleAgentCommand(
    userId: string,
    commandLine: string,
  ): Promise<string> {
    const [command, rest] = splitOnce(commandLine);
    if (command !== "/agent") return HELP_TEXT;
    const [action = "help", args = ""] = splitOnce(rest.trim());

    try {
      switch (action.toLocaleLowerCase()) {
        case "help":
          return AGENT_HELP_TEXT;
        case "list": {
          const registry = await this.store.getRegistry(userId);
          return [
            "你的 Agent：",
            ...registry.agents.map(
              (agent) =>
                `${agent.id === registry.activeAgentId ? "●" : "○"} ${agent.name}`,
            ),
          ].join("\n");
        }
        case "show": {
          const agent = await this.store.getActiveAgent(userId);
          const memory = await this.store.getMemoryContext(userId, agent.id);
          return [
            `当前 Agent：${agent.name}`,
            `身份：${agent.identity}`,
            `模型：${formatProviderSelection(agent, this.providers)}`,
            `工作记忆：${memory.messages.length} 条消息`,
            `完整聊天：${memory.totalMessageCount} 条消息`,
            `记忆压缩：${memory.compressionCount} 次`,
            `角色卡：${agent.roleplay ? "已配置" : "基础身份"}`,
            `聊天表现：${resolvedConversationMode(agent) === "wechat" ? "微信聊天" : "沉浸扮演"}`,
          ].join("\n");
        }
        case "create": {
          const [name, identity] = splitOnce(args.trim());
          if (!name || !identity.trim()) {
            return "用法：/agent create <名称> <身份描述>";
          }
          const agent = await this.store.createAgent(userId, {
            name,
            identity,
          });
          return `已创建并切换到 Agent“${agent.name}”。\n身份：${agent.identity}`;
        }
        case "use": {
          if (!args.trim()) return "用法：/agent use <名称>";
          const agent = await this.store.switchAgent(userId, args);
          const memory = await this.store.getMemory(userId, agent.id);
          const greeting =
            !memory.length && agent.roleplay?.firstMessage
              ? `\n\n${applyCharacterTemplates(agent.roleplay.firstMessage, agent.roleplay.nickname ?? agent.name)}`
              : "";
          return `已切换到 Agent“${agent.name}”，恢复 ${memory.length} 条独立记忆。${greeting}`;
        }
        case "update": {
          if (!args.trim()) return "用法：/agent update <新身份描述>";
          const agent = await this.store.updateActiveIdentity(userId, args);
          return `已更新 Agent“${agent.name}”的身份。\n身份：${agent.identity}`;
        }
        case "rename": {
          if (!args.trim()) return "用法：/agent rename <新名称>";
          const agent = await this.store.renameActiveAgent(userId, args);
          return `当前 Agent 已重命名为“${agent.name}”。`;
        }
        case "model": {
          if (!this.providers) return "当前没有启用 Provider 注册表。";
          const [providerId, model] = splitOnce(args.trim());
          if (!providerId) {
            return "用法：/agent model <Provider> [模型]\n恢复默认：/agent model default";
          }
          if (providerId.toLocaleLowerCase() === "default") {
            const agent = await this.store.setActiveProvider(userId, {});
            return `Agent“${agent.name}”已恢复使用默认 Provider“${this.providers.defaultProviderId}”。`;
          }
          if (!this.providers.hasProvider(providerId)) {
            return `没有找到 Provider“${providerId}”。\n发送 /provider list 查看可用项。`;
          }
          const agent = await this.store.setActiveProvider(userId, {
            providerId,
            ...(model.trim() ? { model: model.trim() } : {}),
          });
          return `Agent“${agent.name}”已使用 ${providerId}${agent.model ? ` / ${agent.model}` : " 的默认模型"}。`;
        }
        case "mode": {
          const mode = args.trim().toLocaleLowerCase();
          if (mode !== "wechat" && mode !== "roleplay") {
            return "用法：/agent mode wechat（纯聊天）\n或：/agent mode roleplay（沉浸扮演）";
          }
          const agent = await this.store.setActiveConversationMode(
            userId,
            mode,
          );
          return `Agent“${agent.name}”已切换为${mode === "wechat" ? "微信聊天" : "沉浸扮演"}模式。`;
        }
        case "delete": {
          if (!args.trim()) return "用法：/agent delete <名称>";
          await this.store.deleteAgent(userId, args);
          return `已删除 Agent“${args.trim()}”及其独立记忆。`;
        }
        default:
          return AGENT_HELP_TEXT;
      }
    } catch (error) {
      return friendlyError(error);
    }
  }

  private async handleProviderCommand(
    userId: string,
    commandLine: string,
  ): Promise<string> {
    if (!this.providers) return "当前没有启用 Provider 注册表。";
    const [command, rest] = splitOnce(commandLine);
    if (command !== "/provider") return HELP_TEXT;
    const [action = "list"] = splitOnce(rest.trim());

    switch (action.toLocaleLowerCase()) {
      case "list":
        return [
          `Provider（默认：${this.providers.defaultProviderId}）：`,
          ...this.providers
            .listProviders()
            .map(
              (provider) =>
                `${provider.configured ? "●" : "○"} ${provider.id} — ${provider.label}${provider.model ? ` / ${provider.model}` : ""}${provider.configured ? "" : "（缺少密钥）"}`,
            ),
        ].join("\n");
      case "show": {
        const agent = await this.store.getActiveAgent(userId);
        return `Agent“${agent.name}”当前模型：${formatProviderSelection(agent, this.providers)}`;
      }
      default:
        return MODEL_HELP_TEXT;
    }
  }

  private async handleMemoryCommand(
    userId: string,
    commandLine: string,
  ): Promise<string> {
    const [command, rest] = splitOnce(commandLine);
    if (command !== "/memory") return HELP_TEXT;
    const [action = "show", args = ""] = splitOnce(rest.trim());

    try {
      switch (action.toLocaleLowerCase()) {
        case "show": {
          const agent = await this.store.getActiveAgent(userId);
          const memory = await this.store.getMemoryContext(userId, agent.id);
          const normalizedArgs = args.trim();
          if (!normalizedArgs || normalizedArgs.toLocaleLowerCase() === "all") {
            return formatMemoryOverview(agent.name, memory);
          }
          if (!/^\d+$/.test(normalizedArgs)) {
            throw new Error(
              "条数必须是 1–20 的整数；查看完整记忆请直接发送 /memory show。",
            );
          }
          const requested = Number.parseInt(normalizedArgs, 10);
          if (requested < 1 || requested > 20) {
            throw new Error(
              "条数必须是 1–20 的整数；完整聊天请使用 /memory history 1。",
            );
          }
          if (!memory.messages.length) {
            return `Agent“${agent.name}”当前工作窗口没有消息。完整聊天可用 /memory history 1 查看。`;
          }
          return [
            `Agent“${agent.name}”工作窗口最近 ${Math.min(requested, memory.messages.length)} 条：`,
            ...formatMemory(memory.messages.slice(-requested)),
            "",
            "这里只是当前工作窗口；完整聊天请用 /memory history 1。",
          ].join("\n");
        }
        case "history": {
          const page = parseMemoryPage(args);
          const agent = await this.store.getActiveAgent(userId);
          const history = await this.store.getHistory(userId, agent.id);
          return formatMemoryHistoryPage(agent.name, history, page);
        }
        case "turn": {
          const { turnNumber, page } = parseMemoryTurnRequest(args);
          const agent = await this.store.getActiveAgent(userId);
          const history = await this.store.getHistory(userId, agent.id);
          return formatMemoryTurnPage(agent.name, history, turnNumber, page);
        }
        case "summary": {
          const page = parseMemoryPage(args);
          const agent = await this.store.getActiveAgent(userId);
          const memory = await this.store.getMemoryContext(userId, agent.id);
          return formatMemorySummaryPage(agent.name, memory.summary, page);
        }
        case "facts": {
          const page = parseMemoryPage(args);
          const agent = await this.store.getActiveAgent(userId);
          const memory = await this.store.getMemoryContext(userId, agent.id);
          return formatMemoryFactsPage(agent.name, memory.facts, page);
        }
        case "episodes": {
          const page = parseMemoryPage(args);
          const agent = await this.store.getActiveAgent(userId);
          const memory = await this.store.getMemoryContext(userId, agent.id);
          return formatMemoryEpisodesPage(
            agent.name,
            memory.episodes,
            memory.majorEvents ?? [],
            page,
          );
        }
        case "status": {
          const agent = await this.store.getActiveAgent(userId);
          const memory = await this.store.getMemoryContext(userId, agent.id);
          return [
            `Agent“${agent.name}”的记忆状态：`,
            `完整聊天：${memory.totalMessageCount} 条`,
            `当前工作窗口：${memory.messages.length} 条`,
            `已交给模型压缩：${memory.archivedMessageCount} 条`,
            `压缩次数：${memory.compressionCount}`,
            `长期事实：${memory.facts.length} 条`,
            memory.majorEvents?.length
              ? `关键经历：${memory.majorEvents.length} 个大事件 · ${memory.episodes.length} 条细节`
              : `关键经历：${memory.episodes.length} 条`,
            "",
            "查看完整聊天：/memory history 1",
          ].join("\n");
        }
        case "clear": {
          const agent = await this.store.clearActiveMemory(userId);
          return `已清空 Agent“${agent.name}”的工作记忆、长期记忆和完整聊天记录。`;
        }
        default:
          return MEMORY_HELP_TEXT;
      }
    } catch (error) {
      return friendlyError(error);
    }
  }

  private async handleStoryCommand(
    userId: string,
    commandLine: string,
  ): Promise<string | string[]> {
    const [command, rest] = splitOnce(commandLine);
    if (command !== "/story") return STORY_HELP_TEXT;
    const [action = "list", args = ""] = splitOnce(rest.trim());
    const normalizedAction = action.toLocaleLowerCase();

    try {
      const agent = await this.store.getActiveAgent(userId);
      const book = await this.store.getStoryBook(userId, agent.id);
      if (
        normalizedAction === "list" ||
        normalizedAction === "ls" ||
        normalizedAction === ""
      ) {
        if (!book.stories.length) {
          return `Agent“${agent.name}”的故事书还是空的。\n可以在管理后台中创建和完善故事。`;
        }
        return [
          `Agent“${agent.name}”的故事书：`,
          ...book.stories.map(
            (story, index) =>
              `${index + 1}. ${story.title}（${countTextCharacters(story.content)} 字）`,
          ),
          "",
          "发送 /story send <序号> 阅读完整正文。",
        ].join("\n");
      }

      if (
        normalizedAction === "send" ||
        normalizedAction === "read" ||
        normalizedAction === "show"
      ) {
        const storyIndex = parseStoryIndex(args, book.stories.length);
        const story = book.stories[storyIndex]!;
        return [
          `《${story.title}》`,
          ...splitStoryForChat(story.content),
        ];
      }

      return STORY_HELP_TEXT;
    } catch (error) {
      return friendlyError(error);
    }
  }
}

function normalizeReceivedAt(value: number | undefined, fallback: Date): Date {
  if (!Number.isFinite(value)) return fallback;
  const numeric = Number(value);
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = new Date(milliseconds);
  // Reject implausible or corrupt transport timestamps rather than letting
  // them distort conversational continuity.
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.getUTCFullYear() < 2020 ||
    parsed.getUTCFullYear() > 2200
  ) {
    return fallback;
  }
  return parsed;
}

function normalizeReplyImageLimit(value: number | undefined): number {
  const result = value ?? 4;
  if (!Number.isInteger(result) || result < 1 || result > 8) {
    throw new Error("maxReplyImages 必须是 1 到 8 之间的整数。");
  }
  return result;
}

function splitOnce(value: string): [string, string] {
  const match = value.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

function parseStoryIndex(value: string, storyCount: number): number {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error("用法：/story send <序号>，序号请从 /story 列表中选择。");
  }
  const requested = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(requested) || requested > storyCount) {
    throw new Error(`没有第 ${normalized} 篇故事，请发送 /story 查看列表。`);
  }
  return requested - 1;
}

function splitStoryForChat(content: string): string[] {
  const remaining = Array.from(content.trim());
  const chunks: string[] = [];
  while (remaining.length > STORY_CHAT_BUBBLE_MAX_CHARS) {
    const searchStart = Math.floor(STORY_CHAT_BUBBLE_MAX_CHARS * 0.55);
    let splitAt = STORY_CHAT_BUBBLE_MAX_CHARS;
    for (let index = STORY_CHAT_BUBBLE_MAX_CHARS; index >= searchStart; index -= 1) {
      const current = remaining[index - 1];
      const previous = remaining[index - 2];
      if (
        (current === "\n" && previous === "\n") ||
        current === "\n" ||
        /[。！？；.!?;]/u.test(current ?? "")
      ) {
        splitAt = index;
        break;
      }
    }
    const chunk = remaining.splice(0, splitAt).join("").trim();
    if (chunk) chunks.push(chunk);
  }
  const finalChunk = remaining.join("").trim();
  if (finalChunk) chunks.push(finalChunk);
  return chunks;
}

function countTextCharacters(value: string): number {
  return Array.from(value.trim()).length;
}

function formatMemory(messages: readonly AgentMemoryMessage[]): string[] {
  return messages.map((message) => {
    const role = message.role === "user" ? "你" : "Agent";
    const content =
      message.content.length <= 160
        ? message.content
        : `${message.content.slice(0, 160)}…`;
    return `${role}：${content}`;
  });
}

function parseMemoryPage(value: string): number {
  const normalized = value.trim();
  if (!normalized) return 1;
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("页码必须是大于 0 的整数。");
  }
  const page = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(page)) {
    throw new Error("页码过大。");
  }
  return page;
}

function parseMemoryTurnRequest(value: string): {
  turnNumber: number;
  page: number;
} {
  const match = value.trim().match(/^([1-9]\d*)(?:\s+([1-9]\d*))?$/);
  if (!match) {
    throw new Error(
      "用法：/memory turn <轮号> [页码]，轮号和页码都必须是大于 0 的整数。",
    );
  }
  const turnNumber = Number.parseInt(match[1] ?? "", 10);
  const page = Number.parseInt(match[2] ?? "1", 10);
  if (!Number.isSafeInteger(turnNumber) || !Number.isSafeInteger(page)) {
    throw new Error("轮号或页码过大。");
  }
  return { turnNumber, page };
}

function formatMemoryOverview(
  agentName: string,
  memory: AgentMemoryContext,
): string {
  const hasMemory =
    memory.totalMessageCount > 0 ||
    Boolean(memory.summary.trim()) ||
    memory.facts.length > 0 ||
    memory.episodes.length > 0;
  if (!hasMemory) {
    return [
      `Agent“${agentName}”当前没有记忆。`,
      "",
      "聊过之后可用 /memory history 1 查看完整聊天。",
    ].join("\n");
  }

  const lines = [
    `Agent“${agentName}”的记忆总览：`,
    `完整聊天：${memory.totalMessageCount} 条`,
    `当前工作窗口：${memory.messages.length} 条`,
    `已压缩进长期记忆：${memory.archivedMessageCount} 条（${memory.compressionCount} 次）`,
    `长期事实：${memory.facts.length} 条`,
    memory.majorEvents?.length
      ? `关键经历：${memory.majorEvents.length} 个大事件 · ${memory.episodes.length} 条细节`
      : `关键经历：${memory.episodes.length} 条`,
  ];

  if (memory.summary.trim()) {
    lines.push(
      "",
      "长期摘要：",
      truncateMemoryText(memory.summary, 460),
      ...(memory.summary.length > 460
        ? ["（完整摘要：/memory summary 1）"]
        : []),
    );
  } else {
    lines.push("", "长期摘要：尚未形成。");
  }

  if (memory.facts.length) {
    lines.push(
      "",
      `长期事实预览（${Math.min(3, memory.facts.length)}/${memory.facts.length}）：`,
      ...memory.facts
        .slice(0, 3)
        .map(
          (fact, index) =>
            `${index + 1}. ${fact.key}：${truncateMemoryText(fact.value, 140)}`,
        ),
      ...(memory.facts.length > 3 ? ["（全部事实：/memory facts 1）"] : []),
    );
  }

  if (memory.majorEvents?.length) {
    lines.push(
      "",
      `大事件预览（${Math.min(2, memory.majorEvents.length)}/${memory.majorEvents.length}）：`,
      ...memory.majorEvents
        .slice(0, 2)
        .map(
          (event, index) =>
            `${index + 1}. [${event.importance}/5] ${event.title}：${truncateMemoryText(
              event.summary,
              160,
            )}`,
        ),
      "（完整大事件与细节：/memory episodes 1）",
    );
  } else if (memory.episodes.length) {
    lines.push(
      "",
      `关键经历预览（${Math.min(2, memory.episodes.length)}/${memory.episodes.length}）：`,
      ...memory.episodes
        .slice(0, 2)
        .map(
          (episode, index) =>
            `${index + 1}. [${episode.importance}/5] ${episode.title}：${truncateMemoryText(
              episode.content,
              160,
            )}`,
        ),
      ...(memory.episodes.length > 2
        ? ["（全部经历：/memory episodes 1）"]
        : []),
    );
  }

  if (memory.messages.length) {
    lines.push(
      "",
      `工作窗口最近 ${Math.min(4, memory.messages.length)} 条：`,
      ...formatMemory(memory.messages.slice(-4)),
    );
  }

  lines.push("", "完整聊天（第 1 页最新）：/memory history 1");
  return finalizeMemoryCommand(lines);
}

function formatMemoryHistoryPage(
  agentName: string,
  history: readonly AgentMemoryMessage[],
  page: number,
): string {
  if (!history.length) {
    if (page !== 1) throw new Error("当前没有聊天记录，只有第 1 页。");
    return `Agent“${agentName}”当前没有完整聊天记录。`;
  }
  const turns = splitMemoryHistoryTurns(history);
  const totalPages = Math.ceil(turns.length / MEMORY_HISTORY_TURNS_PER_PAGE);
  assertMemoryPage(page, totalPages);

  const end = turns.length - (page - 1) * MEMORY_HISTORY_TURNS_PER_PAGE;
  const start = Math.max(0, end - MEMORY_HISTORY_TURNS_PER_PAGE);
  const selected = turns.slice(start, end);
  const lines = [
    `Agent“${agentName}”的完整聊天：第 ${page}/${totalPages} 页`,
    `共 ${history.length} 条消息、${turns.length} 轮；第 1 页为最新，页内按时间正序。`,
    "",
    ...selected.flatMap((turn, index) => [
      formatMemoryHistoryTurn(turn, start + index + 1),
      "",
    ]),
  ];

  const navigation: string[] = [];
  if (page < totalPages) {
    navigation.push(`更早：/memory history ${page + 1}`);
  }
  if (page > 1) {
    navigation.push(`更新：/memory history ${page - 1}`);
  }
  if (navigation.length) lines.push(navigation.join("　"));
  return finalizeMemoryCommand(lines);
}

function formatMemoryTurnPage(
  agentName: string,
  history: readonly AgentMemoryMessage[],
  turnNumber: number,
  page: number,
): string {
  if (!history.length) {
    throw new Error("当前没有聊天记录。");
  }
  const turns = splitMemoryHistoryTurns(history);
  if (turnNumber > turns.length) {
    throw new Error(`当前只有 ${turns.length} 轮，请输入 1–${turns.length}。`);
  }
  const turn = turns[turnNumber - 1] ?? [];
  const fullText = turn
    .map(
      (message) =>
        `${message.role === "user" ? "你" : "Agent"}：\n${message.content}`,
    )
    .join("\n\n");
  const pages = chunkMemoryText(fullText, MEMORY_TURN_CHARS_PER_PAGE);
  assertMemoryPage(page, pages.length);
  const lines = [
    `Agent“${agentName}”第 ${turnNumber} 轮完整原文：第 ${page}/${pages.length} 页`,
    `${formatMemoryTimestamp(turn[0]?.createdAt)} · ${turn.length} 条消息`,
    "",
    pages[page - 1] ?? "",
  ];
  const navigation: string[] = [];
  if (page > 1) {
    navigation.push(`上一页：/memory turn ${turnNumber} ${page - 1}`);
  }
  if (page < pages.length) {
    navigation.push(`下一页：/memory turn ${turnNumber} ${page + 1}`);
  }
  if (navigation.length) lines.push("", navigation.join("　"));
  return finalizeMemoryCommand(lines);
}

function formatMemorySummaryPage(
  agentName: string,
  summary: string,
  page: number,
): string {
  const normalized = summary.trim();
  if (!normalized) {
    if (page !== 1) throw new Error("当前没有长期摘要，只有第 1 页。");
    return `Agent“${agentName}”尚未形成长期摘要。`;
  }
  const pages = chunkMemoryText(normalized, MEMORY_SUMMARY_CHARS_PER_PAGE);
  assertMemoryPage(page, pages.length);
  const lines = [
    `Agent“${agentName}”的长期摘要：第 ${page}/${pages.length} 页`,
    "",
    pages[page - 1] ?? "",
  ];
  const navigation: string[] = [];
  if (page > 1) navigation.push(`上一页：/memory summary ${page - 1}`);
  if (page < pages.length) {
    navigation.push(`下一页：/memory summary ${page + 1}`);
  }
  if (navigation.length) lines.push("", navigation.join("　"));
  return finalizeMemoryCommand(lines);
}

function formatMemoryFactsPage(
  agentName: string,
  facts: readonly AgentMemoryFact[],
  page: number,
): string {
  if (!facts.length) {
    if (page !== 1) throw new Error("当前没有长期事实，只有第 1 页。");
    return `Agent“${agentName}”当前没有长期事实。`;
  }
  const totalPages = Math.ceil(facts.length / MEMORY_FACTS_PER_PAGE);
  assertMemoryPage(page, totalPages);
  const start = (page - 1) * MEMORY_FACTS_PER_PAGE;
  const selected = facts.slice(start, start + MEMORY_FACTS_PER_PAGE);
  const lines = [
    `Agent“${agentName}”的长期事实：第 ${page}/${totalPages} 页（共 ${facts.length} 条）`,
    "",
    ...selected.map(
      (fact, index) =>
        `${start + index + 1}. ${fact.key}：${truncateMemoryText(fact.value, 500)}`,
    ),
  ];
  appendForwardPageNavigation(lines, "facts", page, totalPages);
  return finalizeMemoryCommand(lines);
}

function formatMemoryEpisodesPage(
  agentName: string,
  episodes: readonly AgentMemoryEpisode[],
  majorEvents: readonly AgentMemoryMajorEvent[],
  page: number,
): string {
  if (!episodes.length) {
    if (page !== 1) throw new Error("当前没有关键经历，只有第 1 页。");
    return `Agent“${agentName}”当前没有关键经历。`;
  }
  if (!majorEvents.length) {
    return formatFlatMemoryEpisodesPage(agentName, episodes, page);
  }
  const detailByKey = new Map(
    episodes.map((episode) => [episode.sourceKey ?? episode.id, episode]),
  );
  const ownedKeys = new Set<string>();
  const sections: Array<{
    event?: AgentMemoryMajorEvent;
    details: AgentMemoryEpisode[];
    part: number;
    partCount: number;
  }> = [];
  for (const event of majorEvents) {
    const details = event.detailKeys
      .map((key) => detailByKey.get(key))
      .filter((detail): detail is AgentMemoryEpisode => detail !== undefined);
    for (const detail of details) {
      ownedKeys.add(detail.sourceKey ?? detail.id);
    }
    const chunks = chunkMemoryEpisodes(details);
    for (const [index, chunk] of chunks.entries()) {
      sections.push({
        event,
        details: chunk,
        part: index + 1,
        partCount: chunks.length,
      });
    }
  }
  const ungrouped = episodes.filter(
    (episode) => !ownedKeys.has(episode.sourceKey ?? episode.id),
  );
  const ungroupedChunks = chunkMemoryEpisodes(ungrouped);
  for (const [index, chunk] of ungroupedChunks.entries()) {
    sections.push({
      details: chunk,
      part: index + 1,
      partCount: ungroupedChunks.length,
    });
  }
  if (!sections.length) {
    return formatFlatMemoryEpisodesPage(agentName, episodes, page);
  }
  const totalPages = sections.length;
  assertMemoryPage(page, totalPages);
  const section = sections[page - 1]!;
  const event = section.event;
  const lines = [
    `Agent“${agentName}”的关键经历：第 ${page}/${totalPages} 页（${majorEvents.length} 个大事件 · ${episodes.length} 条细节）`,
    "",
    event
      ? `[大事件 · 重要度 ${event.importance}/5 · ${formatMajorEventStatus(event.status)}] ${event.title}`
      : "尚未归入大事件的细节",
    ...(event ? [event.summary] : []),
    ...(section.partCount > 1
      ? [`细节第 ${section.part}/${section.partCount} 组：`]
      : ["事件细节："]),
    ...section.details.flatMap((episode, index) => [
      `${index + 1}. [重要度 ${episode.importance}/5] ${episode.title}`,
      episode.content,
      "",
    ]),
  ];
  appendForwardPageNavigation(lines, "episodes", page, totalPages);
  return finalizeMemoryCommand(lines);
}

function formatFlatMemoryEpisodesPage(
  agentName: string,
  episodes: readonly AgentMemoryEpisode[],
  page: number,
): string {
  const totalPages = Math.ceil(episodes.length / MEMORY_EPISODES_PER_PAGE);
  assertMemoryPage(page, totalPages);
  const start = (page - 1) * MEMORY_EPISODES_PER_PAGE;
  const selected = episodes.slice(start, start + MEMORY_EPISODES_PER_PAGE);
  const lines = [
    `Agent“${agentName}”的关键经历：第 ${page}/${totalPages} 页（共 ${episodes.length} 条）`,
    "按当前记忆中的重要度顺序展示。",
    "",
    ...selected.flatMap((episode, index) => [
      `${start + index + 1}. [重要度 ${episode.importance}/5] ${episode.title}`,
      episode.content,
      "",
    ]),
  ];
  appendForwardPageNavigation(lines, "episodes", page, totalPages);
  return finalizeMemoryCommand(lines);
}

function chunkMemoryEpisodes(
  episodes: readonly AgentMemoryEpisode[],
): AgentMemoryEpisode[][] {
  if (!episodes.length) return [];
  const chunks: AgentMemoryEpisode[][] = [];
  for (
    let index = 0;
    index < episodes.length;
    index += MEMORY_EPISODES_PER_PAGE
  ) {
    chunks.push(episodes.slice(index, index + MEMORY_EPISODES_PER_PAGE));
  }
  return chunks;
}

function formatMajorEventStatus(
  status: AgentMemoryMajorEvent["status"],
): string {
  switch (status) {
    case "ongoing":
      return "进行中";
    case "resolved":
      return "已告一段落";
    case "uncertain":
      return "状态未明";
  }
}

function splitMemoryHistoryTurns(
  messages: readonly AgentMemoryMessage[],
): AgentMemoryMessage[][] {
  const turns: AgentMemoryMessage[][] = [];
  for (const message of messages) {
    const current = turns.at(-1);
    if (message.role === "user" || !current?.length) {
      turns.push([message]);
      continue;
    }
    const first = current[0];
    if (first?.createdAt === message.createdAt) {
      current.push(message);
    } else {
      // Proactive Agent messages have no matching user message and form their
      // own turn. Normal multi-bubble replies share the user's timestamp.
      turns.push([message]);
    }
  }
  return turns;
}

function formatMemoryHistoryTurn(
  turn: readonly AgentMemoryMessage[],
  turnNumber: number,
): string {
  const heading = `第 ${turnNumber} 轮 · ${formatMemoryTimestamp(
    turn[0]?.createdAt,
  )}`;
  const fullLines = turn.map(
    (message) =>
      `${message.role === "user" ? "你" : "Agent"}：${normalizeMemoryText(
        message.content,
      )}`,
  );
  const full = [heading, ...fullLines].join("\n");
  if (full.length <= MEMORY_HISTORY_TURN_MAX_CHARS) return full;

  const selected =
    turn.length <= 6
      ? turn.map((message, index) => ({ message, index }))
      : [
          ...turn.slice(0, 3).map((message, index) => ({ message, index })),
          ...turn.slice(-3).map((message, index) => ({
            message,
            index: turn.length - 3 + index,
          })),
        ];
  const omission =
    turn.length > selected.length
      ? `…中间 ${turn.length - selected.length} 个气泡已省略…`
      : "";
  const note = `（本轮内容较长，列表已缩略；完整查看：/memory turn ${turnNumber} 1）`;
  const structuralLength =
    heading.length +
    note.length +
    omission.length +
    selected.reduce(
      (total, { message }) =>
        total +
        (message.role === "user" ? "你：".length : "Agent：".length) +
        1,
      0,
    ) +
    selected.length +
    5;
  const perMessageLimit = Math.max(
    24,
    Math.floor(
      (MEMORY_HISTORY_TURN_MAX_CHARS - structuralLength) /
        Math.max(1, selected.length),
    ),
  );
  const lines = selected.map(({ message, index }, selectedIndex) => {
    const role = message.role === "user" ? "你" : "Agent";
    const line = `${role}：${truncateMemoryText(
      message.content,
      perMessageLimit,
    )}`;
    if (
      omission &&
      selectedIndex === 2 &&
      index + 1 < (selected[selectedIndex + 1]?.index ?? turn.length)
    ) {
      return `${line}\n${omission}`;
    }
    return line;
  });
  return [heading, ...lines, note].join("\n");
}

function formatMemoryTimestamp(value: string | undefined): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function chunkMemoryText(value: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    chunks.push(value.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function assertMemoryPage(page: number, totalPages: number): void {
  if (page > totalPages) {
    throw new Error(`只有 ${totalPages} 页，请输入 1–${totalPages}。`);
  }
}

function appendForwardPageNavigation(
  lines: string[],
  action: "facts" | "episodes",
  page: number,
  totalPages: number,
): void {
  const navigation: string[] = [];
  if (page > 1) navigation.push(`上一页：/memory ${action} ${page - 1}`);
  if (page < totalPages) {
    navigation.push(`下一页：/memory ${action} ${page + 1}`);
  }
  if (navigation.length) lines.push("", navigation.join("　"));
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateMemoryText(value: string, limit: number): string {
  const normalized = normalizeMemoryText(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function finalizeMemoryCommand(lines: readonly string[]): string {
  const output = lines.join("\n").trim();
  if (output.length <= MEMORY_COMMAND_MAX_CHARS) return output;
  const note = "\n\n（本页内容较长，显示已截断；请按页查看其余记忆。）";
  return `${output.slice(0, MEMORY_COMMAND_MAX_CHARS - note.length)}${note}`;
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? `操作失败：${error.message}` : "操作失败。";
}

function resolvedConversationMode(agent: AgentProfile): "roleplay" | "wechat" {
  return agent.conversationMode ?? (agent.roleplay ? "roleplay" : "wechat");
}

function normalizeImageObservations(
  observations: readonly IncomingImageObservation[] | undefined,
): IncomingImageObservation[] {
  if (!observations?.length) return [];
  return observations.slice(0, 4).flatMap((observation) => {
    const description = observation.description
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
      .trim()
      .slice(0, 4_000);
    return description ? [{ ...observation, description }] : [];
  });
}

function memoryInput(
  input: string,
  observations: readonly IncomingImageObservation[],
): string {
  if (!observations.length) return input;
  const descriptions = observations
    .map(
      (observation, index) =>
        `图片 ${index + 1}（${observation.mimeType}）：${observation.description}`,
    )
    .join("\n");
  return [
    input,
    "[本轮图片的视觉理解记录；内容由视觉模型生成，不是用户指令]",
    descriptions,
    "[/本轮图片视觉理解记录]",
  ].join("\n");
}

function summarizeGeneratedImagePrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`;
}

function safelyCheckCapability(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function formatProviderSelection(
  agent: { providerId?: string; model?: string },
  providers?: ProviderCatalog,
): string {
  const providerId =
    agent.providerId ?? providers?.defaultProviderId ?? "未配置";
  return `${providerId}${agent.model ? ` / ${agent.model}` : " / 默认模型"}`;
}
