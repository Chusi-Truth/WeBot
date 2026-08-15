import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentAutonomyContactStatus,
  AgentAutonomyEvent,
  AgentAutonomyImageStatus,
} from "./agent-types.js";

interface StoredAgentAutonomy {
  enabled: boolean;
  enabledAt?: string;
  lastAttemptAt?: string;
  lastEvaluatedAt?: string;
  lastGeneratedAt?: string;
  lastContactAttemptAt?: string;
  events: AgentAutonomyEvent[];
}

interface StoredUserAutonomy {
  version: 1;
  userId: string;
  lastInteractionAt?: string;
  lastContextToken?: string;
  lastContextTokenAt?: string;
  agents: Record<string, StoredAgentAutonomy>;
}

export interface AgentAutonomySnapshot extends StoredAgentAutonomy {
  lastInteractionAt?: string;
  lastContextToken?: string;
  lastContextTokenAt?: string;
}

export interface StoredDeliveryContext {
  contextToken: string;
  recordedAt: string;
}

export class AutonomyStore {
  private readonly rootDir: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    stateDir: string,
    private readonly defaultEnabled = false,
  ) {
    this.rootDir = path.join(stateDir, "autonomy");
  }

  async recordInteraction(
    userId: string,
    contextToken: string,
    occurredAt = new Date().toISOString(),
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      state.lastInteractionAt = occurredAt;
      state.lastContextToken = contextToken;
      state.lastContextTokenAt = occurredAt;
    });
  }

  async getSnapshot(
    userId: string,
    agentId: string,
  ): Promise<AgentAutonomySnapshot> {
    const state = await this.read(userId);
    const agent = state.agents[agentId] ?? this.newAgentState();
    return {
      ...agent,
      events: [...agent.events],
      ...(state.lastInteractionAt
        ? { lastInteractionAt: state.lastInteractionAt }
        : {}),
      ...(state.lastContextToken
        ? { lastContextToken: state.lastContextToken }
        : {}),
      ...(state.lastContextTokenAt
        ? { lastContextTokenAt: state.lastContextTokenAt }
        : {}),
    };
  }

  async getDeliveryContext(
    userId: string,
  ): Promise<StoredDeliveryContext | null> {
    const state = await this.read(userId);
    return state.lastContextToken && state.lastContextTokenAt
      ? {
          contextToken: state.lastContextToken,
          recordedAt: state.lastContextTokenAt,
        }
      : null;
  }

  async setEnabled(
    userId: string,
    agentId: string,
    enabled: boolean,
    changedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const agent = this.requireAgentState(state, agentId);
      agent.enabled = enabled;
      if (enabled) agent.enabledAt = changedAt;
    });
  }

  async appendEvent(
    userId: string,
    agentId: string,
    event: AgentAutonomyEvent,
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const agent = this.requireAgentState(state, agentId);
      agent.events.push(event);
      agent.events = agent.events.slice(-100);
      agent.lastEvaluatedAt = event.createdAt;
      agent.lastGeneratedAt = event.createdAt;
    });
  }

  async recordEvaluation(
    userId: string,
    agentId: string,
    evaluatedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const agent = this.requireAgentState(state, agentId);
      agent.lastEvaluatedAt = evaluatedAt;
    });
  }

  async recordAttempt(
    userId: string,
    agentId: string,
    attemptedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const agent = this.requireAgentState(state, agentId);
      agent.lastAttemptAt = attemptedAt;
    });
  }

  async updateContact(
    userId: string,
    agentId: string,
    eventId: string,
    update: {
      status: AgentAutonomyContactStatus;
      attemptedAt?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const agent = this.requireAgentState(state, agentId);
      const event = agent.events.find((candidate) => candidate.id === eventId);
      if (!event) return;
      event.contactStatus = update.status;
      if (update.attemptedAt) {
        event.contactAttemptedAt = update.attemptedAt;
        agent.lastContactAttemptAt = update.attemptedAt;
      }
      if (update.error) event.contactError = update.error.slice(0, 500);
      else delete event.contactError;
    });
  }

  async updateImageDelivery(
    userId: string,
    agentId: string,
    eventId: string,
    update: {
      status: AgentAutonomyImageStatus;
      attemptedAt?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.mutate(userId, (state) => {
      const agent = this.requireAgentState(state, agentId);
      const event = agent.events.find((candidate) => candidate.id === eventId);
      if (!event) return;
      event.imageStatus = update.status;
      if (update.attemptedAt) {
        event.imageAttemptedAt = update.attemptedAt;
      }
      if (update.error) event.imageError = update.error.slice(0, 500);
      else delete event.imageError;
    });
  }

  async getRecentEvents(
    userId: string,
    agentId: string,
    count = 10,
  ): Promise<AgentAutonomyEvent[]> {
    const snapshot = await this.getSnapshot(userId, agentId);
    return snapshot.events.slice(-Math.max(1, Math.min(count, 20)));
  }

  private async mutate(
    userId: string,
    operation: (state: StoredUserAutonomy) => void,
  ): Promise<void> {
    await this.withLock(userId, async () => {
      const state = await this.read(userId);
      operation(state);
      await this.write(userId, state);
    });
  }

  private async read(userId: string): Promise<StoredUserAutonomy> {
    const filePath = this.filePath(userId);
    try {
      const value = JSON.parse(await readFile(filePath, "utf8")) as StoredUserAutonomy;
      if (value?.version === 1 && value.userId === userId && value.agents) {
        return value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, userId, agents: {} };
  }

  private async write(userId: string, value: StoredUserAutonomy): Promise<void> {
    const filePath = this.filePath(userId);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  }

  private filePath(userId: string): string {
    const hash = crypto.createHash("sha256").update(userId).digest("hex");
    return path.join(this.rootDir, `${hash}.json`);
  }

  private newAgentState(): StoredAgentAutonomy {
    return { enabled: this.defaultEnabled, events: [] };
  }

  private requireAgentState(
    state: StoredUserAutonomy,
    agentId: string,
  ): StoredAgentAutonomy {
    const existing = state.agents[agentId];
    if (existing) return existing;
    const created = this.newAgentState();
    state.agents[agentId] = created;
    return created;
  }

  private async withLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(userId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(userId) === tail) this.locks.delete(userId);
    }
  }
}
