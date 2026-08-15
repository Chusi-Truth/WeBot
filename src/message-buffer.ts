import type { IncomingTextMessage } from "./types.js";

const DEFAULT_DEBOUNCE_MS = 1_500;
const DEFAULT_MAX_WINDOW_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface IncomingMessageBufferOptions {
  /** Sliding quiet period before a regular-message batch is processed. */
  debounceMs?: number;
  /** Hard limit measured from the first message in a batch. */
  maxWindowMs?: number;
}

export type BufferedMessageHandler = (
  message: IncomingTextMessage,
) => Promise<void> | void;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface PendingBatch {
  messages: IncomingTextMessage[];
  waiters: Deferred[];
  debounceTimer?: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Coalesces short bursts of messages without allowing one sender's work to
 * block another sender. Slash commands always retain their own message.
 */
export class IncomingMessageBuffer {
  private readonly debounceMs: number;
  private readonly maxWindowMs: number;
  private readonly pending = new Map<string, PendingBatch>();
  private readonly senderTails = new Map<string, Promise<void>>();
  private readonly activeJobs = new Set<Promise<void>>();

  constructor(
    private readonly handler: BufferedMessageHandler,
    options: IncomingMessageBufferOptions = {},
  ) {
    this.debounceMs = normalizeTiming(
      options.debounceMs,
      DEFAULT_DEBOUNCE_MS,
    );
    this.maxWindowMs = normalizeTiming(
      options.maxWindowMs,
      DEFAULT_MAX_WINDOW_MS,
    );
  }

  /** Resolves once the batch containing this input has finished processing. */
  enqueue(message: IncomingTextMessage): Promise<void> {
    const waiter = createDeferred();
    const senderId = message.senderId;

    if (message.text.trim().startsWith("/")) {
      this.flushSender(senderId);
      this.queue(senderId, [message], [waiter]);
      return waiter.promise;
    }

    const existing = this.pending.get(senderId);
    if (existing) {
      existing.messages.push(message);
      existing.waiters.push(waiter);
      if (existing.debounceTimer !== undefined) {
        clearTimeout(existing.debounceTimer);
      }
      if (this.debounceMs === 0) {
        this.flushSender(senderId);
        return waiter.promise;
      }
      existing.debounceTimer = this.scheduleFlush(
        senderId,
        this.debounceMs,
      );
      return waiter.promise;
    }

    const batch: PendingBatch = {
      messages: [message],
      waiters: [waiter],
    };
    this.pending.set(senderId, batch);
    if (this.debounceMs === 0 || this.maxWindowMs === 0) {
      this.flushSender(senderId);
      return waiter.promise;
    }
    batch.debounceTimer = this.scheduleFlush(senderId, this.debounceMs);
    batch.maxTimer = this.scheduleFlush(senderId, this.maxWindowMs);
    return waiter.promise;
  }

  /** Immediately flushes all buffered messages and waits for queued work. */
  async drain(): Promise<void> {
    while (this.pending.size > 0 || this.activeJobs.size > 0) {
      for (const senderId of [...this.pending.keys()]) {
        this.flushSender(senderId);
      }
      if (this.activeJobs.size > 0) {
        await Promise.all([...this.activeJobs]);
      }
    }
  }

  private scheduleFlush(
    senderId: string,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.flushSender(senderId), delayMs);
  }

  private flushSender(senderId: string): void {
    const batch = this.pending.get(senderId);
    if (!batch) return;
    this.pending.delete(senderId);
    if (batch.debounceTimer !== undefined) {
      clearTimeout(batch.debounceTimer);
    }
    if (batch.maxTimer !== undefined) {
      clearTimeout(batch.maxTimer);
    }
    this.queue(senderId, batch.messages, batch.waiters);
  }

  private queue(
    senderId: string,
    messages: IncomingTextMessage[],
    waiters: Deferred[],
  ): void {
    const combined = combineMessages(messages);
    const previous = this.senderTails.get(senderId) ?? Promise.resolve();
    const execution = previous.then(() => this.handler(combined));

    execution.then(
      () => {
        for (const waiter of waiters) waiter.resolve();
      },
      (error: unknown) => {
        for (const waiter of waiters) waiter.reject(error);
      },
    );

    // Keep the serialization chain usable after a failed handler. Jobs tracked
    // by drain are intentionally settled promises; enqueue carries the error.
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.senderTails.set(senderId, tail);
    this.activeJobs.add(tail);
    void tail.finally(() => {
      this.activeJobs.delete(tail);
      if (this.senderTails.get(senderId) === tail) {
        this.senderTails.delete(senderId);
      }
    });
  }
}

function combineMessages(
  messages: readonly IncomingTextMessage[],
): IncomingTextMessage {
  const latest = messages.at(-1);
  if (!latest) throw new Error("Cannot combine an empty message batch.");
  return {
    ...latest,
    text: messages.map((message) => message.text).join("\n"),
    ...(messages.some((message) => message.imageObservations?.length)
      ? {
          imageObservations: messages.flatMap(
            (message) => message.imageObservations ?? [],
          ),
        }
      : {}),
  };
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function normalizeTiming(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(MAX_TIMER_MS, Math.floor(value));
}
