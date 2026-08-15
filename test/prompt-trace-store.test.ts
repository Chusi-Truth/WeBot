import {
  mkdtemp,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PromptPlan } from "../src/prompt-compiler.js";
import {
  PromptTraceStore,
  type PromptTrace,
  type PromptTraceInput,
} from "../src/prompt-trace-store.js";

const MAX_TRACE_BYTES = 32 * 1024;

function plan(content = "实际发给模型的内容"): PromptPlan {
  return {
    version: 1,
    mode: "wechat",
    budgetTokens: 24_000,
    estimatedInputTokens: 20,
    blocks: [
      {
        id: "character.identity",
        label: "角色核心身份",
        placement: "instructions",
        source: "character",
        trust: "owner_config",
        priority: 115,
        required: true,
        status: "included",
        content,
        messages: [],
        originalCharacters: content.length,
        originalEstimatedTokens: 10,
        estimatedTokens: 10,
        sourceRefs: [],
      },
    ],
    instructions: content,
    input: [{ role: "user", content: "你好" }],
  };
}

function trace(id: string, promptPlan = plan()): PromptTraceInput {
  return {
    id,
    kind: "chat",
    createdAt: `2026-07-22T00:00:0${id.at(-1) ?? "0"}.000Z`,
    agentId: "agent-1",
    agentName: "林夏",
    mode: "wechat",
    providerId: "deepseek",
    providerLabel: "DeepSeek",
    api: "chat-completions",
    model: "deepseek-chat",
    endpoint: "/chat/completions",
    status: "success",
    durationMs: 120,
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, source: "provider" },
    plan: promptPlan,
    outputCharacters: 12,
    outputNormalized: false,
  };
}

async function readTraceFile(stateDir: string): Promise<{
  raw: string;
  traces: PromptTrace[];
}> {
  const userDirectories = await readdir(path.join(stateDir, "prompt-traces"));
  const userDirectory = userDirectories[0];
  if (!userDirectory) throw new Error("缺少 Prompt Trace 用户目录。");
  const files = await readdir(
    path.join(stateDir, "prompt-traces", userDirectory),
  );
  const file = files[0];
  if (!file) throw new Error("缺少 Prompt Trace 文件。");
  const raw = await readFile(
    path.join(stateDir, "prompt-traces", userDirectory, file),
    "utf8",
  );
  const parsed = JSON.parse(raw) as { traces: PromptTrace[] };
  return { raw, traces: parsed.traces };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("PromptTraceStore", () => {
  it("isolates private traces, limits retention, and clears one agent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-traces-"));
    const store = new PromptTraceStore(stateDir, { retention: 2 });
    const userId = "private-owner@im.wechat";

    await Promise.all([
      store.append(userId, trace("trace-1")),
      store.append(userId, trace("trace-2")),
      store.append(userId, trace("trace-3")),
    ]);

    const summaries = await store.list(userId, "agent-1", 10);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      id: "trace-3",
      providerId: "deepseek",
      includedBlocks: 1,
      omittedBlocks: 0,
    });
    const detail = await store.get(userId, "agent-1", "trace-3");
    expect(detail?.plan.instructions).toContain("实际发给模型");
    expect(detail?.userHash).toMatch(/^[a-f0-9]{64}$/);

    const userDirectories = await readdir(path.join(stateDir, "prompt-traces"));
    expect(userDirectories).toHaveLength(1);
    expect(userDirectories[0]).not.toContain("private-owner");
    const filePath = path.join(
      stateDir,
      "prompt-traces",
      userDirectories[0] ?? "",
      "agent-1.json",
    );
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain(userId);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    await store.clear(userId, "agent-1");
    expect(await store.list(userId, "agent-1")).toEqual([]);
  });

  it("marks oversized trace snapshots when private storage is bounded", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-traces-"));
    const store = new PromptTraceStore(stateDir, {
      retention: 5,
      maxTraceBytes: MAX_TRACE_BYTES,
    });
    const largePlan = plan("长内容".repeat(50_000));

    await store.append("owner@im.wechat", trace("trace-large", largePlan));
    const saved = await store.get(
      "owner@im.wechat",
      "agent-1",
      "trace-large",
    );

    expect(saved?.storageTruncated).toBe(true);
    expect(saved?.originalSerializedBytes).toBeGreaterThan(MAX_TRACE_BYTES);
    expect(saved?.plan.instructions.length).toBeLessThan(
      largePlan.instructions.length,
    );
    expect(serializedBytes(saved)).toBeLessThanOrEqual(MAX_TRACE_BYTES);

    const persisted = await readTraceFile(stateDir);
    expect(persisted.traces).toHaveLength(1);
    expect(serializedBytes(persisted.traces[0])).toBeLessThanOrEqual(
      MAX_TRACE_BYTES,
    );
    expect(Buffer.byteLength(persisted.raw, "utf8")).toBeLessThan(
      MAX_TRACE_BYTES * 1.5,
    );
  });

  it("bounds traces with many short messages and source references", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-traces-"));
    const store = new PromptTraceStore(stateDir, {
      retention: 2,
      maxTraceBytes: MAX_TRACE_BYTES,
    });
    const baseBlock = plan().blocks[0];
    if (!baseBlock) throw new Error("测试 Prompt 缺少基础区块。");
    const blocks = Array.from({ length: 240 }, (_, blockIndex) => ({
      ...baseBlock,
      id: `block-${blockIndex}`,
      label: `区块 ${blockIndex}`,
      content: "短内容",
      messages: Array.from({ length: 40 }, (_, messageIndex) => ({
        role: messageIndex % 2 === 0 ? "user" as const : "assistant" as const,
        content: `短消息-${blockIndex}-${messageIndex}`,
      })),
      sourceRefs: Array.from(
        { length: 40 },
        (_, sourceIndex) => `ref-${blockIndex}-${sourceIndex}`,
      ),
    }));
    const manyCollectionsPlan: PromptPlan = {
      ...plan(),
      blocks,
      input: Array.from({ length: 500 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `消息-${index}`,
      })),
    };

    await store.append(
      "collections@im.wechat",
      trace("trace-collections", manyCollectionsPlan),
    );
    const saved = await store.get(
      "collections@im.wechat",
      "agent-1",
      "trace-collections",
    );

    expect(saved).not.toBeNull();
    expect(saved?.storageTruncated).toBe(true);
    expect(saved?.storageTruncation?.omittedInputMessages).toBeGreaterThan(0);
    expect(saved?.storageTruncation?.omittedBlockMessages).toBeGreaterThan(0);
    expect(saved?.storageTruncation?.omittedSourceRefs).toBeGreaterThan(0);
    expect(serializedBytes(saved)).toBeLessThanOrEqual(MAX_TRACE_BYTES);

    const persisted = await readTraceFile(stateDir);
    expect(serializedBytes(persisted.traces[0])).toBeLessThanOrEqual(
      MAX_TRACE_BYTES,
    );
  });

  it("falls back to an explainable metadata-only trace when compact data is still too large", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-traces-"));
    const store = new PromptTraceStore(stateDir, {
      maxTraceBytes: MAX_TRACE_BYTES,
    });
    const baseBlock = plan().blocks[0];
    if (!baseBlock) throw new Error("测试 Prompt 缺少基础区块。");
    const extremePlan: PromptPlan = {
      ...plan("指令".repeat(20_000)),
      blocks: Array.from({ length: 80 }, (_, index) => ({
        ...baseBlock,
        id: `区块编号-${index}-`.repeat(300),
        label: `极端元数据-${index}-`.repeat(300),
        content: "内容".repeat(1_000),
        messages: Array.from({ length: 10 }, () => ({
          role: "user" as const,
          content: "消息".repeat(1_000),
        })),
        sourceRefs: Array.from(
          { length: 10 },
          (_, refIndex) => `来源-${index}-${refIndex}-`.repeat(300),
        ),
      })),
    };
    const oversized = {
      ...trace("trace-metadata", extremePlan),
      agentName: "角色名".repeat(20_000),
      providerLabel: "供应商".repeat(20_000),
      endpoint: `/${"接口".repeat(20_000)}`,
      error: {
        name: "错误类型".repeat(10_000),
        message: "错误详情".repeat(30_000),
      },
      status: "error" as const,
    };

    await store.append("metadata@im.wechat", oversized);
    const [summary] = await store.list("metadata@im.wechat", "agent-1");
    if (!summary) throw new Error("缺少裁剪后的 Prompt Trace 摘要。");
    const saved = await store.get(
      "metadata@im.wechat",
      "agent-1",
      summary.id,
    );

    expect(saved?.storageTruncation).toMatchObject({
      reason: "max_trace_bytes",
      stage: "metadata_only",
      maxBytes: MAX_TRACE_BYTES,
      omittedBlocks: 80,
    });
    expect(saved?.plan.blocks).toEqual([]);
    expect(saved?.plan.input).toEqual([]);
    expect(saved?.plan.instructions).toBe("");
    expect(serializedBytes(saved)).toBeLessThanOrEqual(MAX_TRACE_BYTES);
  });

  it("does not resurrect a trace appended with a generation captured before clear", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-traces-"));
    const store = new PromptTraceStore(stateDir);
    const userId = "generation@im.wechat";
    const generationBeforeClear = store.captureGeneration(userId, "agent-1");

    await store.append(
      userId,
      trace("trace-before-clear"),
      generationBeforeClear,
    );
    await store.clear(userId, "agent-1");
    await store.append(
      userId,
      trace("trace-stale"),
      generationBeforeClear,
    );

    expect(await store.list(userId, "agent-1")).toEqual([]);
    const generationAfterClear = store.captureGeneration(userId, "agent-1");
    expect(generationAfterClear).toBe(generationBeforeClear + 1);

    await store.append(
      userId,
      trace("trace-after-clear"),
      generationAfterClear,
    );
    expect(await store.list(userId, "agent-1")).toMatchObject([
      { id: "trace-after-clear" },
    ]);
  });
});
