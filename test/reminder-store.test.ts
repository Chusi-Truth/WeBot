import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_ACTIVE_REMINDERS_PER_AGENT,
  MAX_PENDING_REMINDERS_PER_AGENT,
  ReminderStore,
  ReminderStoreError,
} from "../src/reminder-store.js";

const userId = "alice@im.wechat";
const agentA = "agent-a";
const agentB = "agent-b";
const now = new Date("2026-07-28T04:00:00.000Z");
const dueAt = "2026-07-28T06:00:00.000Z";

describe("ReminderStore", () => {
  it("persists only a user hash with private directory and file modes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-reminders-"));
    const store = new ReminderStore(stateDir, { now: () => now });
    await store.propose(userId, agentA, { title: "交报告", dueAt });

    const remindersDir = path.join(stateDir, "reminders");
    const files = await readdir(remindersDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain(userId);
    expect((await stat(remindersDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(remindersDir, files[0]!))).mode & 0o777).toBe(
      0o600,
    );

    const persisted = await readFile(
      path.join(remindersDir, files[0]!),
      "utf8",
    );
    expect(persisted).not.toContain(userId);
    expect(persisted).not.toContain("contextToken");
    expect(JSON.parse(persisted)).toMatchObject({
      version: 1,
      userHash: files[0]!.replace(/\.json$/u, ""),
    });
  });

  it("atomically confirms once, remains idempotent, and isolates IDs by agent", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-confirm-"),
    );
    const proposer = new ReminderStore(stateDir, { now: () => now });
    const confirmer = new ReminderStore(stateDir, { now: () => now });
    const proposal = await proposer.propose(
      userId,
      agentA,
      { title: "交报告", dueAt },
      now.toISOString(),
    );

    expect(await confirmer.confirm(userId, agentB, proposal.id)).toBeNull();
    expect(await confirmer.getProposal(userId, agentB, proposal.id)).toBeNull();

    const [first, second] = await Promise.all([
      proposer.confirm(userId, agentA, proposal.id),
      confirmer.confirm(userId, agentA, proposal.id),
    ]);
    expect(first).toMatchObject({ id: proposal.id, status: "scheduled" });
    expect(second).toEqual(first);
    expect(await proposer.list(userId, agentA)).toHaveLength(1);
    expect(await proposer.getProposal(userId, agentA, proposal.id)).toBeNull();
  });

  it("expires pending proposals after 30 minutes and caps each agent at five", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-pending-"),
    );
    const store = new ReminderStore(stateDir, { now: () => now });
    const proposals = [];
    for (let index = 0; index < MAX_PENDING_REMINDERS_PER_AGENT; index += 1) {
      proposals.push(
        await store.propose(userId, agentA, {
          title: `事项 ${index}`,
          dueAt,
        }),
      );
    }
    await expect(
      store.propose(userId, agentA, { title: "超限", dueAt }),
    ).rejects.toMatchObject({ code: "pending_limit" });

    const afterTtl = "2026-07-28T04:31:00.000Z";
    expect(
      await store.confirm(userId, agentA, proposals[0]!.id, afterTtl),
    ).toBeNull();
    await expect(
      store.propose(
        userId,
        agentA,
        { title: "过期后可新增", dueAt },
        afterTtl,
      ),
    ).resolves.toMatchObject({ title: "过期后可新增" });
  });

  it("caps active reminders while allowing terminal history", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-active-"),
    );
    const store = new ReminderStore(stateDir, { now: () => now });
    for (let index = 0; index < MAX_ACTIVE_REMINDERS_PER_AGENT; index += 1) {
      await store.createDirect(userId, agentA, {
        title: `事项 ${index}`,
        dueAt,
      });
    }
    await expect(
      store.createDirect(userId, agentA, { title: "超限", dueAt }),
    ).rejects.toBeInstanceOf(ReminderStoreError);
    await expect(
      store.createDirect(userId, agentB, { title: "另一人物", dueAt }),
    ).resolves.toMatchObject({ agentId: agentB });
  });

  it("supports due lookup, waiting retry, single claim, completion, and cancellation", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-reminder-lifecycle-"),
    );
    const store = new ReminderStore(stateDir, { now: () => now });
    const reminder = await store.createDirect(userId, agentA, {
      title: "取快递",
      dueAt,
    });

    expect(
      await store.listDue(userId, "2026-07-28T05:59:59.000Z"),
    ).toEqual([]);
    expect(await store.listDue(userId, dueAt)).toMatchObject([
      { id: reminder.id, status: "scheduled" },
    ]);
    expect(await store.claim(userId, agentA, reminder.id, now.toISOString()))
      .toBe(false);
    expect(
      await store.markWaitingContext(
        userId,
        agentA,
        reminder.id,
        dueAt,
      ),
    ).toBe(true);
    expect(await store.claim(userId, agentA, reminder.id, dueAt)).toBe(true);
    expect(await store.claim(userId, agentA, reminder.id, dueAt)).toBe(false);
    expect(
      await store.markWaitingContext(
        userId,
        agentA,
        reminder.id,
        "2026-07-28T06:01:00.000Z",
      ),
    ).toBe(false);
    expect(
      await store.complete(userId, agentA, reminder.id, {
        status: "api_accepted",
        occurredAt: "2026-07-28T06:03:00.000Z",
        message: "已发送",
      }),
    ).toBe(true);
    expect(
      await store.claim(
        userId,
        agentA,
        reminder.id,
        "2026-07-28T06:04:00.000Z",
      ),
    ).toBe(false);
    expect(
      await store.confirm(
        userId,
        agentA,
        reminder.id,
        "2026-07-28T06:05:00.000Z",
      ),
    ).toBeNull();

    const cancellable = await store.createDirect(userId, agentA, {
      title: "可取消",
      dueAt: "2026-07-28T07:00:00.000Z",
    });
    expect(await store.cancel(userId, agentB, cancellable.id)).toBe(false);
    expect(await store.cancel(userId, agentA, cancellable.id)).toBe(true);
    expect(await store.cancel(userId, agentA, cancellable.id)).toBe(true);
    expect(
      await store.confirm(
        userId,
        agentA,
        cancellable.id,
        "2026-07-28T06:06:00.000Z",
      ),
    ).toBeNull();
    expect(await store.list(userId, agentA)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: cancellable.id,
          status: "cancelled",
        }),
      ]),
    );

    await store.deleteAgent(userId, agentA);
    expect(await store.list(userId, agentA)).toEqual([]);
  });
});
