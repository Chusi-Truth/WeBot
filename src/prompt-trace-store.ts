import crypto from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { PromptMode, PromptPlan } from "./prompt-compiler.js";
import type { ProviderApi } from "./provider-types.js";

export type PromptTraceStatus = "success" | "error";

export interface PromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimate";
}

export interface PromptTrace {
  version: 1;
  id: string;
  kind: "chat";
  createdAt: string;
  agentId: string;
  agentName: string;
  userHash: string;
  mode: PromptMode;
  providerId: string;
  providerLabel: string;
  api: ProviderApi;
  model?: string;
  endpoint: string;
  status: PromptTraceStatus;
  durationMs: number;
  usage: PromptUsage;
  plan: PromptPlan;
  outputCharacters?: number;
  outputNormalized?: boolean;
  error?: {
    name: string;
    message: string;
  };
  storageTruncated?: boolean;
  originalSerializedBytes?: number;
  storageTruncation?: {
    reason: "max_trace_bytes";
    stage: "content" | "collections" | "compact" | "metadata_only";
    maxBytes: number;
    omittedBlocks: number;
    omittedInputMessages: number;
    omittedBlockMessages: number;
    omittedSourceRefs: number;
  };
}

export interface PromptTraceInput
  extends Omit<PromptTrace, "version" | "userHash"> {}

export interface PromptTraceSummary {
  id: string;
  kind: PromptTrace["kind"];
  createdAt: string;
  agentId: string;
  agentName: string;
  mode: PromptMode;
  providerId: string;
  providerLabel: string;
  api: ProviderApi;
  model?: string;
  status: PromptTraceStatus;
  durationMs: number;
  usage: PromptUsage;
  estimatedInputTokens: number;
  budgetTokens: number;
  includedBlocks: number;
  truncatedBlocks: number;
  omittedBlocks: number;
  storageTruncated?: boolean;
}

interface StoredPromptTraces {
  version: 1;
  traces: PromptTrace[];
}

export interface PromptTraceStoreOptions {
  retention?: number;
  maxTraceBytes?: number;
}

const DEFAULT_RETENTION = 20;
const DEFAULT_MAX_TRACE_BYTES = 256 * 1024;

export class PromptTraceStore {
  private readonly rootDir: string;
  private readonly retention: number;
  private readonly maxTraceBytes: number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  constructor(
    stateDir: string,
    options: PromptTraceStoreOptions = {},
  ) {
    this.rootDir = path.join(stateDir, "prompt-traces");
    this.retention = clampInteger(
      options.retention,
      DEFAULT_RETENTION,
      1,
      100,
    );
    this.maxTraceBytes = clampInteger(
      options.maxTraceBytes,
      DEFAULT_MAX_TRACE_BYTES,
      32 * 1024,
      2 * 1024 * 1024,
    );
  }

  captureGeneration(userId: string, agentId: string): number {
    return this.generations.get(this.key(userId, agentId)) ?? 0;
  }

  async append(
    userId: string,
    input: PromptTraceInput,
    expectedGeneration?: number,
  ): Promise<void> {
    const key = this.key(userId, input.agentId);
    await this.withLock(key, async () => {
      if (
        expectedGeneration !== undefined &&
        expectedGeneration !== (this.generations.get(key) ?? 0)
      ) {
        return;
      }
      const state = await this.read(userId, input.agentId);
      const trace = boundTrace(
        {
          ...input,
          version: 1,
          userHash: hashUserId(userId),
        },
        this.maxTraceBytes,
      );
      state.traces.push(trace);
      state.traces = state.traces.slice(-this.retention);
      await this.write(userId, input.agentId, state);
    });
  }

  async list(
    userId: string,
    agentId: string,
    limit = this.retention,
  ): Promise<PromptTraceSummary[]> {
    const state = await this.read(userId, agentId);
    const boundedLimit = clampInteger(limit, this.retention, 1, this.retention);
    return state.traces
      .slice(-boundedLimit)
      .reverse()
      .map(toSummary);
  }

  async get(
    userId: string,
    agentId: string,
    traceId: string,
  ): Promise<PromptTrace | null> {
    const state = await this.read(userId, agentId);
    return state.traces.find((trace) => trace.id === traceId) ?? null;
  }

  async clear(userId: string, agentId: string): Promise<void> {
    const key = this.key(userId, agentId);
    await this.withLock(key, async () => {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      await rm(this.filePath(userId, agentId), { force: true });
    });
  }

  private async read(
    userId: string,
    agentId: string,
  ): Promise<StoredPromptTraces> {
    try {
      const value = JSON.parse(
        await readFile(this.filePath(userId, agentId), "utf8"),
      ) as unknown;
      if (
        isRecord(value) &&
        value.version === 1 &&
        Array.isArray(value.traces)
      ) {
        return value as unknown as StoredPromptTraces;
      }
      throw new Error("Prompt Trace 文件格式无效。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, traces: [] };
      }
      throw new Error(`无法读取 Prompt Trace：${String(error)}`, {
        cause: error,
      });
    }
  }

  private async write(
    userId: string,
    agentId: string,
    value: StoredPromptTraces,
  ): Promise<void> {
    const filePath = this.filePath(userId, agentId);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath =
      `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  }

  private filePath(userId: string, agentId: string): string {
    const safeAgentId = /^[a-zA-Z0-9_-]{1,100}$/.test(agentId)
      ? agentId
      : crypto.createHash("sha256").update(agentId).digest("hex").slice(0, 32);
    return path.join(
      this.rootDir,
      hashUserId(userId).slice(0, 24),
      `${safeAgentId}.json`,
    );
  }

  private key(userId: string, agentId: string): string {
    return `${hashUserId(userId)}\0${agentId}`;
  }

  private async withLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

function toSummary(trace: PromptTrace): PromptTraceSummary {
  const includedBlocks = trace.plan.blocks.filter(
    (block) => block.status === "included",
  ).length;
  const truncatedBlocks = trace.plan.blocks.filter(
    (block) => block.status === "truncated",
  ).length;
  const omittedBlocks = trace.plan.blocks.filter(
    (block) => block.status === "omitted",
  ).length;
  return {
    id: trace.id,
    kind: trace.kind,
    createdAt: trace.createdAt,
    agentId: trace.agentId,
    agentName: trace.agentName,
    mode: trace.mode,
    providerId: trace.providerId,
    providerLabel: trace.providerLabel,
    api: trace.api,
    ...(trace.model ? { model: trace.model } : {}),
    status: trace.status,
    durationMs: trace.durationMs,
    usage: trace.usage,
    estimatedInputTokens: trace.plan.estimatedInputTokens,
    budgetTokens: trace.plan.budgetTokens,
    includedBlocks,
    truncatedBlocks,
    omittedBlocks,
    ...(trace.storageTruncated ? { storageTruncated: true } : {}),
  };
}

function boundTrace(trace: PromptTrace, maxBytes: number): PromptTrace {
  const serializedBytes = Buffer.byteLength(JSON.stringify(trace), "utf8");
  if (serializedBytes <= maxBytes) return trace;
  const candidates: Array<{
    stage: NonNullable<PromptTrace["storageTruncation"]>["stage"];
    trace: PromptTrace;
  }> = [
    {
      stage: "content",
      trace: trimTrace(trace, {
        instructions: 60_000,
        inputMessages: Number.POSITIVE_INFINITY,
        inputContent: 12_000,
        blocks: Number.POSITIVE_INFINITY,
        blockContent: 5_000,
        blockMessages: Number.POSITIVE_INFINITY,
        blockMessageContent: 2_000,
        sourceRefs: Number.POSITIVE_INFINITY,
        sourceRefContent: 2_000,
        metadata: Number.POSITIVE_INFINITY,
      }),
    },
    {
      stage: "collections",
      trace: trimTrace(trace, {
        instructions: 20_000,
        inputMessages: 64,
        inputContent: 2_000,
        blocks: 128,
        blockContent: 1_000,
        blockMessages: 16,
        blockMessageContent: 512,
        sourceRefs: 16,
        sourceRefContent: 512,
        metadata: 1_024,
      }),
    },
    {
      stage: "compact",
      trace: trimTrace(trace, {
        instructions: 4_000,
        inputMessages: 8,
        inputContent: 512,
        blocks: 16,
        blockContent: 256,
        blockMessages: 2,
        blockMessageContent: 256,
        sourceRefs: 2,
        sourceRefContent: 128,
        metadata: 256,
      }),
    },
  ];

  for (const candidate of candidates) {
    const annotated = annotateTruncation(
      trace,
      candidate.trace,
      candidate.stage,
      maxBytes,
      serializedBytes,
    );
    if (serializedTraceBytes(annotated) <= maxBytes) return annotated;
  }

  const metadataOnly = annotateTruncation(
    trace,
    metadataOnlyTrace(trace),
    "metadata_only",
    maxBytes,
    serializedBytes,
  );
  const minimumBytes = serializedTraceBytes(metadataOnly);
  if (minimumBytes <= maxBytes) return metadataOnly;

  throw new Error(
    `Prompt Trace 的最小元数据快照仍有 ${minimumBytes} 字节，` +
      `超过 maxTraceBytes=${maxBytes}，无法安全保存。`,
  );
}

interface TraceTrimLimits {
  instructions: number;
  inputMessages: number;
  inputContent: number;
  blocks: number;
  blockContent: number;
  blockMessages: number;
  blockMessageContent: number;
  sourceRefs: number;
  sourceRefContent: number;
  metadata: number;
}

function trimTrace(
  trace: PromptTrace,
  limits: TraceTrimLimits,
): PromptTrace {
  return {
    ...trace,
    id: boundText(trace.id, limits.metadata),
    agentId: boundText(trace.agentId, limits.metadata),
    agentName: boundText(trace.agentName, limits.metadata),
    providerId: boundText(trace.providerId, limits.metadata),
    providerLabel: boundText(trace.providerLabel, limits.metadata),
    ...(trace.model
      ? { model: boundText(trace.model, limits.metadata) }
      : {}),
    endpoint: boundText(trace.endpoint, limits.metadata),
    ...(trace.error
      ? {
          error: {
            name: boundText(trace.error.name, limits.metadata),
            message: boundText(trace.error.message, limits.metadata),
          },
        }
      : {}),
    plan: {
      ...trace.plan,
      instructions: boundText(trace.plan.instructions, limits.instructions),
      input: takeHeadAndTail(trace.plan.input, limits.inputMessages).map(
        (message) => ({
          ...message,
          content: boundText(message.content, limits.inputContent),
        }),
      ),
      blocks: takeHeadAndTail(trace.plan.blocks, limits.blocks).map(
        (block) => ({
          ...block,
          id: boundText(block.id, limits.metadata),
          label: boundText(block.label, limits.metadata),
          content: boundText(block.content, limits.blockContent),
          messages: takeHeadAndTail(
            block.messages,
            limits.blockMessages,
          ).map((message) => ({
            ...message,
            content: boundText(
              message.content,
              limits.blockMessageContent,
            ),
          })),
          sourceRefs: takeHeadAndTail(
            block.sourceRefs,
            limits.sourceRefs,
          ).map((sourceRef) =>
            boundText(sourceRef, limits.sourceRefContent)
          ),
        }),
      ),
    },
  };
}

function metadataOnlyTrace(trace: PromptTrace): PromptTrace {
  return {
    version: 1,
    id: boundText(trace.id, 256),
    kind: "chat",
    createdAt: boundText(trace.createdAt, 64),
    agentId: boundText(trace.agentId, 256),
    agentName: boundText(trace.agentName, 256),
    userHash: boundText(trace.userHash, 128),
    mode: trace.mode,
    providerId: boundText(trace.providerId, 256),
    providerLabel: boundText(trace.providerLabel, 256),
    api: trace.api,
    ...(trace.model ? { model: boundText(trace.model, 256) } : {}),
    endpoint: boundText(trace.endpoint, 512),
    status: trace.status,
    durationMs: trace.durationMs,
    usage: { ...trace.usage },
    plan: {
      version: 1,
      mode: trace.plan.mode,
      budgetTokens: trace.plan.budgetTokens,
      estimatedInputTokens: trace.plan.estimatedInputTokens,
      blocks: [],
      instructions: "",
      input: [],
    },
    ...(trace.outputCharacters !== undefined
      ? { outputCharacters: trace.outputCharacters }
      : {}),
    ...(trace.outputNormalized !== undefined
      ? { outputNormalized: trace.outputNormalized }
      : {}),
    ...(trace.error
      ? {
          error: {
            name: boundText(trace.error.name, 128),
            message: boundText(trace.error.message, 512),
          },
        }
      : {}),
  };
}

function annotateTruncation(
  original: PromptTrace,
  candidate: PromptTrace,
  stage: NonNullable<PromptTrace["storageTruncation"]>["stage"],
  maxBytes: number,
  originalSerializedBytes: number,
): PromptTrace {
  const originalCounts = collectionCounts(original);
  const candidateCounts = collectionCounts(candidate);
  return {
    ...candidate,
    storageTruncated: true,
    originalSerializedBytes,
    storageTruncation: {
      reason: "max_trace_bytes",
      stage,
      maxBytes,
      omittedBlocks: originalCounts.blocks - candidateCounts.blocks,
      omittedInputMessages:
        originalCounts.inputMessages - candidateCounts.inputMessages,
      omittedBlockMessages:
        originalCounts.blockMessages - candidateCounts.blockMessages,
      omittedSourceRefs:
        originalCounts.sourceRefs - candidateCounts.sourceRefs,
    },
  };
}

function collectionCounts(trace: PromptTrace): {
  blocks: number;
  inputMessages: number;
  blockMessages: number;
  sourceRefs: number;
} {
  return {
    blocks: trace.plan.blocks.length,
    inputMessages: trace.plan.input.length,
    blockMessages: trace.plan.blocks.reduce(
      (total, block) => total + block.messages.length,
      0,
    ),
    sourceRefs: trace.plan.blocks.reduce(
      (total, block) => total + block.sourceRefs.length,
      0,
    ),
  };
}

function serializedTraceBytes(trace: PromptTrace): number {
  return Buffer.byteLength(JSON.stringify(trace), "utf8");
}

function takeHeadAndTail<T>(values: T[], limit: number): T[] {
  if (!Number.isFinite(limit) || values.length <= limit) return values;
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const headSize = Math.ceil(boundedLimit / 2);
  const tailSize = boundedLimit - headSize;
  return [
    ...values.slice(0, headSize),
    ...(tailSize > 0 ? values.slice(-tailSize) : []),
  ];
}

function boundText(value: string, maxCharacters: number): string {
  if (!Number.isFinite(maxCharacters) || value.length <= maxCharacters) {
    return value;
  }
  const boundedLimit = Math.max(0, Math.floor(maxCharacters));
  if (boundedLimit === 0) return "";
  const marker = "…[存储裁剪]";
  if (boundedLimit <= marker.length) return marker.slice(0, boundedLimit);
  return `${value.slice(0, boundedLimit - marker.length)}${marker}`;
}

function hashUserId(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex");
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(value ?? fallback, maximum));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
