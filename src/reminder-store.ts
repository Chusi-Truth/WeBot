import crypto from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const REMINDER_TIME_ZONE = "Asia/Shanghai" as const;
export const REMINDER_PROPOSAL_TTL_MS = 30 * 60 * 1_000;
export const MAX_PENDING_REMINDERS_PER_AGENT = 5;
export const MAX_ACTIVE_REMINDERS_PER_AGENT = 100;

const MINIMUM_LEAD_MS = 60 * 1_000;
const FILE_LOCKS = new Map<string, Promise<void>>();
const ACTIVE_STATUSES = new Set<ReminderStatus>([
  "scheduled",
  "waiting_context",
  "sending",
]);

export type ReminderStatus =
  | "scheduled"
  | "waiting_context"
  | "sending"
  | "api_accepted"
  | "failed"
  | "cancelled"
  | "expired";

export interface ReminderProposal {
  id: string;
  agentId: string;
  title: string;
  dueAt: string;
  timeZone: typeof REMINDER_TIME_ZONE;
  createdAt: string;
  expiresAt: string;
}

export interface ReminderItem {
  id: string;
  agentId: string;
  title: string;
  dueAt: string;
  timeZone: typeof REMINDER_TIME_ZONE;
  status: ReminderStatus;
  createdAt: string;
  confirmedAt?: string;
  lastAttemptAt?: string;
  lastMessage?: string;
  lastError?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export type Reminder = ReminderItem;

interface StoredAgentReminders {
  pending: ReminderProposal[];
  reminders: ReminderItem[];
}

interface StoredUserReminders {
  version: 1;
  userHash: string;
  agents: Record<string, StoredAgentReminders>;
}

export type ReminderStoreErrorCode =
  | "invalid_title"
  | "invalid_time"
  | "too_soon"
  | "too_far"
  | "pending_limit"
  | "active_limit";

export class ReminderStoreError extends Error {
  constructor(
    readonly code: ReminderStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReminderStoreError";
  }
}

export interface ReminderStoreOptions {
  now?: () => Date;
}

export class ReminderStore {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(stateDir: string, options: ReminderStoreOptions = {}) {
    this.rootDir = path.resolve(stateDir, "reminders");
    this.now = options.now ?? (() => new Date());
  }

  async propose(
    userId: string,
    agentId: string,
    input: { title: string; dueAt: string },
    proposedAt = this.nowIso(),
  ): Promise<ReminderProposal> {
    const createdAt = canonicalIso(proposedAt, "invalid_time");
    const dueAt = validateFutureDueAt(input.dueAt, createdAt);
    const title = validateTitle(input.title);

    return this.mutate(userId, createdAt, (state) => {
      const agent = requireAgent(state, agentId);
      if (agent.pending.length >= MAX_PENDING_REMINDERS_PER_AGENT) {
        throw new ReminderStoreError(
          "pending_limit",
          `每个人物最多只能保留 ${MAX_PENDING_REMINDERS_PER_AGENT} 个待确认提醒。`,
        );
      }
      const proposal: ReminderProposal = {
        id: createShortId(state),
        agentId,
        title,
        dueAt,
        timeZone: REMINDER_TIME_ZONE,
        createdAt,
        expiresAt: new Date(
          Date.parse(createdAt) + REMINDER_PROPOSAL_TTL_MS,
        ).toISOString(),
      };
      agent.pending.push(proposal);
      return cloneProposal(proposal);
    });
  }

  async getProposal(
    userId: string,
    agentId: string,
    proposalId: string,
  ): Promise<ReminderProposal | null> {
    const state = await this.read(userId);
    const proposal = state.agents[agentId]?.pending.find(
      (candidate) => candidate.id === proposalId,
    );
    return proposal ? cloneProposal(proposal) : null;
  }

  async confirm(
    userId: string,
    agentId: string,
    proposalId: string,
    confirmedAt = this.nowIso(),
  ): Promise<ReminderItem | null> {
    const occurredAt = canonicalIso(confirmedAt, "invalid_time");
    return this.mutate(userId, occurredAt, (state) => {
      const agent = state.agents[agentId];
      if (!agent) return null;

      const existing = agent.reminders.find(
        (reminder) => reminder.id === proposalId,
      );
      if (existing) {
        return existing.status === "scheduled" ||
          existing.status === "waiting_context" ||
          existing.status === "sending"
          ? cloneReminder(existing)
          : null;
      }

      const proposalIndex = agent.pending.findIndex(
        (proposal) => proposal.id === proposalId,
      );
      if (proposalIndex < 0) return null;
      const proposal = agent.pending[proposalIndex]!;

      let dueAt: string;
      try {
        dueAt = validateFutureDueAt(proposal.dueAt, occurredAt);
      } catch (error) {
        if (
          error instanceof ReminderStoreError &&
          (error.code === "too_soon" || error.code === "too_far")
        ) {
          agent.pending.splice(proposalIndex, 1);
          return null;
        }
        throw error;
      }
      assertActiveCapacity(agent);

      const reminder: ReminderItem = {
        id: proposal.id,
        agentId,
        title: proposal.title,
        dueAt,
        timeZone: REMINDER_TIME_ZONE,
        status: "scheduled",
        createdAt: proposal.createdAt,
        confirmedAt: occurredAt,
      };
      agent.pending.splice(proposalIndex, 1);
      agent.reminders.push(reminder);
      return cloneReminder(reminder);
    });
  }

  async createDirect(
    userId: string,
    agentId: string,
    input: { title: string; dueAt: string },
    createdAt = this.nowIso(),
  ): Promise<ReminderItem> {
    const occurredAt = canonicalIso(createdAt, "invalid_time");
    const dueAt = validateFutureDueAt(input.dueAt, occurredAt);
    const title = validateTitle(input.title);

    return this.mutate(userId, occurredAt, (state) => {
      const agent = requireAgent(state, agentId);
      assertActiveCapacity(agent);
      const reminder: ReminderItem = {
        id: createShortId(state),
        agentId,
        title,
        dueAt,
        timeZone: REMINDER_TIME_ZONE,
        status: "scheduled",
        createdAt: occurredAt,
        confirmedAt: occurredAt,
      };
      agent.reminders.push(reminder);
      return cloneReminder(reminder);
    });
  }

  async list(userId: string, agentId: string): Promise<ReminderItem[]> {
    const state = await this.read(userId);
    return (state.agents[agentId]?.reminders ?? [])
      .map(cloneReminder)
      .sort(compareReminders);
  }

  async cancel(
    userId: string,
    agentId: string,
    id: string,
    cancelledAt = this.nowIso(),
  ): Promise<boolean> {
    const occurredAt = canonicalIso(cancelledAt, "invalid_time");
    return this.mutate(userId, occurredAt, (state) => {
      const agent = state.agents[agentId];
      if (!agent) return false;

      const proposalIndex = agent.pending.findIndex(
        (proposal) => proposal.id === id,
      );
      if (proposalIndex >= 0) {
        agent.pending.splice(proposalIndex, 1);
        return true;
      }

      const reminder = agent.reminders.find((candidate) => candidate.id === id);
      if (!reminder) return false;
      if (reminder.status === "cancelled") return true;
      if (
        reminder.status !== "scheduled" &&
        reminder.status !== "waiting_context"
      ) {
        return false;
      }
      reminder.status = "cancelled";
      reminder.cancelledAt = occurredAt;
      reminder.completedAt = occurredAt;
      delete reminder.lastError;
      return true;
    });
  }

  async deleteAgent(userId: string, agentId: string): Promise<void> {
    await this.mutate(userId, this.nowIso(), (state) => {
      delete state.agents[agentId];
    });
  }

  async listDue(
    userId: string,
    dueAt = this.nowIso(),
  ): Promise<ReminderItem[]> {
    const cutoff = Date.parse(canonicalIso(dueAt, "invalid_time"));
    const state = await this.read(userId);
    return Object.values(state.agents)
      .flatMap((agent) => agent.reminders)
      .filter(
        (reminder) =>
          (reminder.status === "scheduled" ||
            reminder.status === "waiting_context") &&
          Date.parse(reminder.dueAt) <= cutoff,
      )
      .map(cloneReminder)
      .sort(compareReminders);
  }

  async markWaiting(
    userId: string,
    agentId: string,
    id: string,
    occurredAt = this.nowIso(),
    reason = "等待用户发来新消息，以刷新微信回复凭证。",
  ): Promise<boolean> {
    const timestamp = canonicalIso(occurredAt, "invalid_time");
    return this.mutate(userId, timestamp, (state) => {
      const reminder = findReminder(state, agentId, id);
      if (!reminder) return false;
      if (
        reminder.status !== "scheduled" &&
        reminder.status !== "waiting_context"
      ) {
        return false;
      }
      reminder.status = "waiting_context";
      reminder.lastAttemptAt = timestamp;
      reminder.lastError = reason.slice(0, 500);
      return true;
    });
  }

  async markWaitingContext(
    userId: string,
    agentId: string,
    id: string,
    occurredAt = this.nowIso(),
    reason?: string,
  ): Promise<boolean> {
    return reason === undefined
      ? this.markWaiting(userId, agentId, id, occurredAt)
      : this.markWaiting(userId, agentId, id, occurredAt, reason);
  }

  async claim(
    userId: string,
    agentId: string,
    id: string,
    occurredAt = this.nowIso(),
  ): Promise<boolean> {
    const timestamp = canonicalIso(occurredAt, "invalid_time");
    return this.mutate(userId, timestamp, (state) => {
      const reminder = findReminder(state, agentId, id);
      if (!reminder) return false;
      if (
        reminder.status !== "scheduled" &&
        reminder.status !== "waiting_context"
      ) {
        return false;
      }
      if (Date.parse(reminder.dueAt) > Date.parse(timestamp)) return false;
      reminder.status = "sending";
      reminder.lastAttemptAt = timestamp;
      delete reminder.lastError;
      return true;
    });
  }

  async complete(
    userId: string,
    agentId: string,
    id: string,
    update: {
      status: "api_accepted" | "failed" | "expired";
      occurredAt?: string;
      message?: string;
      error?: string;
    },
  ): Promise<boolean> {
    const occurredAt = canonicalIso(
      update.occurredAt ?? this.nowIso(),
      "invalid_time",
    );
    return this.mutate(userId, occurredAt, (state) => {
      const reminder = findReminder(state, agentId, id);
      if (!reminder) return false;
      if (reminder.status === update.status) return true;

      const canExpire =
        update.status === "expired" &&
        (reminder.status === "scheduled" ||
          reminder.status === "waiting_context");
      const canFinishSending =
        reminder.status === "sending" &&
        (update.status === "api_accepted" || update.status === "failed");
      if (!canExpire && !canFinishSending) return false;

      reminder.status = update.status;
      reminder.completedAt = occurredAt;
      if (update.message) reminder.lastMessage = update.message.slice(0, 1_000);
      else delete reminder.lastMessage;
      if (update.error) reminder.lastError = update.error.slice(0, 500);
      else delete reminder.lastError;
      return true;
    });
  }

  private async mutate<T>(
    userId: string,
    occurredAt: string,
    operation: (state: StoredUserReminders) => T,
  ): Promise<T> {
    return this.withLock(userId, async () => {
      const state = await this.read(userId);
      purgeExpiredProposals(state, Date.parse(occurredAt));
      const result = operation(state);
      await this.write(userId, state);
      return result;
    });
  }

  private async read(userId: string): Promise<StoredUserReminders> {
    try {
      const value = JSON.parse(
        await readFile(this.filePath(userId), "utf8"),
      ) as StoredUserReminders;
      if (
        value?.version === 1 &&
        value.userHash === userHash(userId) &&
        value.agents &&
        typeof value.agents === "object"
      ) {
        return value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, userHash: userHash(userId), agents: {} };
  }

  private async write(
    userId: string,
    value: StoredUserReminders,
  ): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    const filePath = this.filePath(userId);
    const temporaryPath =
      `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  }

  private filePath(userId: string): string {
    return path.join(this.rootDir, `${userHash(userId)}.json`);
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

  private nowIso(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new ReminderStoreError("invalid_time", "当前时间无效。");
    }
    return value.toISOString();
  }
}

function requireAgent(
  state: StoredUserReminders,
  agentId: string,
): StoredAgentReminders {
  const existing = state.agents[agentId];
  if (existing) return existing;
  const created: StoredAgentReminders = { pending: [], reminders: [] };
  state.agents[agentId] = created;
  return created;
}

function findReminder(
  state: StoredUserReminders,
  agentId: string,
  id: string,
): ReminderItem | undefined {
  return state.agents[agentId]?.reminders.find(
    (reminder) => reminder.id === id,
  );
}

function purgeExpiredProposals(
  state: StoredUserReminders,
  occurredAtMs: number,
): void {
  for (const agent of Object.values(state.agents)) {
    agent.pending = agent.pending.filter(
      (proposal) => Date.parse(proposal.expiresAt) > occurredAtMs,
    );
  }
}

function assertActiveCapacity(agent: StoredAgentReminders): void {
  const activeCount = agent.reminders.filter((reminder) =>
    ACTIVE_STATUSES.has(reminder.status)
  ).length;
  if (activeCount >= MAX_ACTIVE_REMINDERS_PER_AGENT) {
    throw new ReminderStoreError(
      "active_limit",
      `每个人物最多只能保留 ${MAX_ACTIVE_REMINDERS_PER_AGENT} 个有效提醒。`,
    );
  }
}

function createShortId(state: StoredUserReminders): string {
  const used = new Set(
    Object.values(state.agents).flatMap((agent) => [
      ...agent.pending.map((proposal) => proposal.id),
      ...agent.reminders.map((reminder) => reminder.id),
    ]),
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = crypto.randomBytes(4).toString("hex");
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("无法生成唯一的提醒短 ID。");
}

function validateTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 300 || /[\u0000-\u001f\u007f]/u.test(title)) {
    throw new ReminderStoreError(
      "invalid_title",
      "提醒事项必须是 1–300 个可见字符。",
    );
  }
  return title;
}

function canonicalIso(value: string, code: ReminderStoreErrorCode): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ReminderStoreError(code, "提醒时间格式无效。");
  }
  return new Date(milliseconds).toISOString();
}

function validateFutureDueAt(dueAt: string, referenceAt: string): string {
  const canonical = canonicalIso(dueAt, "invalid_time");
  const dueAtMs = Date.parse(canonical);
  const referenceAtMs = Date.parse(referenceAt);
  if (dueAtMs - referenceAtMs <= MINIMUM_LEAD_MS) {
    throw new ReminderStoreError(
      "too_soon",
      "提醒时间必须比当前时间晚 60 秒以上。",
    );
  }
  if (dueAtMs > addFiveCalendarYears(referenceAtMs)) {
    throw new ReminderStoreError(
      "too_far",
      "提醒时间不能超过未来 5 年。",
    );
  }
  return canonical;
}

function addFiveCalendarYears(instantMs: number): number {
  const shanghai = new Date(instantMs + 8 * 60 * 60 * 1_000);
  const targetYear = shanghai.getUTCFullYear() + 5;
  const month = shanghai.getUTCMonth();
  const day = Math.min(
    shanghai.getUTCDate(),
    new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate(),
  );
  return Date.UTC(
    targetYear,
    month,
    day,
    shanghai.getUTCHours(),
    shanghai.getUTCMinutes(),
    shanghai.getUTCSeconds(),
    shanghai.getUTCMilliseconds(),
  ) - 8 * 60 * 60 * 1_000;
}

function userHash(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex");
}

function cloneProposal(proposal: ReminderProposal): ReminderProposal {
  return { ...proposal };
}

function cloneReminder(reminder: ReminderItem): ReminderItem {
  return { ...reminder };
}

function compareReminders(left: ReminderItem, right: ReminderItem): number {
  return (
    Date.parse(left.dueAt) - Date.parse(right.dueAt) ||
    left.id.localeCompare(right.id)
  );
}
