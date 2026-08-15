import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type WeatherScheduleRunStatus =
  | "never"
  | "running"
  | "waiting_context"
  | "api_accepted"
  | "failed"
  | "skipped";

export interface WeatherScheduleConfig {
  enabled: boolean;
  location: string;
  localTime: string;
  timeZone: string;
}

export interface WeatherScheduleSnapshot extends WeatherScheduleConfig {
  configuredAt?: string;
  lastLocalDate?: string;
  lastRunAt?: string;
  lastStatus: WeatherScheduleRunStatus;
  lastError?: string;
  lastMessage?: string;
}

interface StoredWeatherJob extends WeatherScheduleSnapshot {
  lastAttemptAt?: string;
}

interface StoredUserWeatherSchedules {
  version: 1;
  userHash: string;
  agents: Record<string, StoredWeatherJob>;
}

const DEFAULT_CONFIG: WeatherScheduleConfig = Object.freeze({
  enabled: false,
  location: "",
  localTime: "09:00",
  timeZone: "Asia/Shanghai",
});

// The CLI intentionally creates small store facades for separate subsystems.
// They must serialize mutations to the same physical user file, otherwise a
// late write from one instance can restore data deleted through another.
const FILE_LOCKS = new Map<string, Promise<void>>();

export class WeatherScheduleStore {
  private readonly rootDir: string;

  constructor(stateDir: string) {
    this.rootDir = path.resolve(stateDir, "weather-schedules");
  }

  async getSnapshot(
    userId: string,
    agentId: string,
  ): Promise<WeatherScheduleSnapshot> {
    const state = await this.read(userId);
    return publicSnapshot(state.agents[agentId] ?? newStoredJob());
  }

  async updateConfig(
    userId: string,
    agentId: string,
    config: WeatherScheduleConfig,
    configuredAt = new Date().toISOString(),
  ): Promise<WeatherScheduleSnapshot> {
    return this.mutate(userId, (state) => {
      const previous = state.agents[agentId] ?? newStoredJob();
      const next: StoredWeatherJob = {
        ...previous,
        ...config,
      };
      if (
        previous.location !== config.location ||
        previous.localTime !== config.localTime ||
        previous.timeZone !== config.timeZone ||
        (!previous.enabled && config.enabled)
      ) {
        next.configuredAt = configuredAt;
        delete next.lastLocalDate;
        delete next.lastRunAt;
        delete next.lastAttemptAt;
        delete next.lastError;
        delete next.lastMessage;
        next.lastStatus = "never";
      }
      state.agents[agentId] = next;
      return publicSnapshot(next);
    });
  }

  async deleteAgent(userId: string, agentId: string): Promise<void> {
    await this.mutate(userId, (state) => {
      delete state.agents[agentId];
    });
  }

  async markWaitingContext(
    userId: string,
    agentId: string,
    localDate: string,
    occurredAt: string,
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const job = state.agents[agentId];
      if (!job) return;
      if (job.lastLocalDate === localDate && job.lastStatus === "api_accepted") {
        return;
      }
      job.lastLocalDate = localDate;
      job.lastRunAt = occurredAt;
      job.lastStatus = "waiting_context";
      job.lastError = "等待用户发来新消息，以刷新微信回复凭证。";
    });
  }

  async markSkipped(
    userId: string,
    agentId: string,
    localDate: string,
    occurredAt: string,
    reason: string,
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const job = state.agents[agentId];
      if (!job) return;
      if (job.lastLocalDate === localDate && job.lastStatus === "api_accepted") {
        return;
      }
      job.lastLocalDate = localDate;
      job.lastRunAt = occurredAt;
      job.lastStatus = "skipped";
      job.lastError = reason.slice(0, 500);
    });
  }

  async claim(
    userId: string,
    agentId: string,
    localDate: string,
    occurredAt: string,
  ): Promise<boolean> {
    return this.mutate(userId, (state) => {
      const job = state.agents[agentId];
      if (!job) return false;
      if (!job.enabled || !job.location) return false;
      const retryWaiting =
        job.lastLocalDate === localDate &&
        job.lastStatus === "waiting_context";
      if (
        job.lastLocalDate === localDate &&
        !retryWaiting
      ) {
        return false;
      }
      job.lastLocalDate = localDate;
      job.lastRunAt = occurredAt;
      job.lastAttemptAt = occurredAt;
      job.lastStatus = "running";
      delete job.lastError;
      return true;
    });
  }

  async complete(
    userId: string,
    agentId: string,
    update: {
      status: "api_accepted" | "failed";
      occurredAt: string;
      message?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const job = state.agents[agentId];
      if (!job) return;
      job.lastRunAt = update.occurredAt;
      job.lastStatus = update.status;
      if (update.message) job.lastMessage = update.message.slice(0, 1_000);
      else delete job.lastMessage;
      if (update.error) job.lastError = update.error.slice(0, 500);
      else delete job.lastError;
    });
  }

  private async mutate<T>(
    userId: string,
    operation: (state: StoredUserWeatherSchedules) => T,
  ): Promise<T> {
    return this.withLock(userId, async () => {
      const state = await this.read(userId);
      const result = operation(state);
      await this.write(userId, state);
      return result;
    });
  }

  private async read(userId: string): Promise<StoredUserWeatherSchedules> {
    try {
      const value = JSON.parse(
        await readFile(this.filePath(userId), "utf8"),
      ) as StoredUserWeatherSchedules;
      if (
        value?.version === 1 &&
        value.userHash === this.userHash(userId) &&
        value.agents
      ) {
        return value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, userHash: this.userHash(userId), agents: {} };
  }

  private async write(
    userId: string,
    value: StoredUserWeatherSchedules,
  ): Promise<void> {
    const filePath = this.filePath(userId);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  }

  private filePath(userId: string): string {
    return path.join(this.rootDir, `${this.userHash(userId)}.json`);
  }

  private userHash(userId: string): string {
    return crypto.createHash("sha256").update(userId).digest("hex");
  }

  private async withLock<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.filePath(userId);
    const previous = FILE_LOCKS.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    FILE_LOCKS.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (FILE_LOCKS.get(key) === tail) FILE_LOCKS.delete(key);
    }
  }
}

function newStoredJob(): StoredWeatherJob {
  return { ...DEFAULT_CONFIG, lastStatus: "never" };
}

function publicSnapshot(job: StoredWeatherJob): WeatherScheduleSnapshot {
  return {
    enabled: job.enabled,
    location: job.location,
    localTime: job.localTime,
    timeZone: job.timeZone,
    lastStatus: job.lastStatus,
    ...(job.configuredAt ? { configuredAt: job.configuredAt } : {}),
    ...(job.lastLocalDate ? { lastLocalDate: job.lastLocalDate } : {}),
    ...(job.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
    ...(job.lastError ? { lastError: job.lastError } : {}),
    ...(job.lastMessage ? { lastMessage: job.lastMessage } : {}),
  };
}
