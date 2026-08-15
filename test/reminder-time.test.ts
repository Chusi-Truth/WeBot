import { describe, expect, it } from "vitest";

import {
  parseReminderTime,
  REMINDER_V1_TIME_ZONE,
} from "../src/reminder-time.js";

const NOW = new Date("2026-07-28T04:00:30.000Z");

describe("parseReminderTime", () => {
  it.each([
    ["今天下午3点提醒我交报告", "2026-07-28T07:00:00.000Z"],
    ["明天下午三点交报告", "2026-07-29T07:00:00.000Z"],
    ["明天09:30去复诊", "2026-07-29T01:30:00.000Z"],
    ["后天0点发布", "2026-07-29T16:00:00.000Z"],
    ["2026年8月1日14:05交稿", "2026-08-01T06:05:00.000Z"],
    ["8月1日14:05交稿", "2026-08-01T06:05:00.000Z"],
    ["2028年2月29日上午9点纪念日", "2028-02-29T01:00:00.000Z"],
    ["周五15:00开会", "2026-07-31T07:00:00.000Z"],
    ["周一15:00交材料", "2026-08-03T07:00:00.000Z"],
    ["下周二15:00开会", "2026-08-04T07:00:00.000Z"],
    ["2分钟后关火", "2026-07-28T04:02:30.000Z"],
    ["2小时后取快递", "2026-07-28T06:00:30.000Z"],
    ["两小时后取快递", "2026-07-28T06:00:30.000Z"],
    ["3天后浇花", "2026-07-31T04:00:30.000Z"],
    ["2026-07-28 15:00开会", "2026-07-28T07:00:00.000Z"],
    ["2026-07-28T15:00:00+08:00开会", "2026-07-28T07:00:00.000Z"],
    ["二〇二六年八月一日上午九点交稿", "2026-08-01T01:00:00.000Z"],
  ])("parses %s in Asia/Shanghai", (input, dueAt) => {
    expect(parseReminderTime(input, { now: NOW })).toMatchObject({
      ok: true,
      dueAt,
      timeZone: REMINDER_V1_TIME_ZONE,
    });
  });

  it("requires a meridiem for bare 1-12 点 notation", () => {
    expect(parseReminderTime("明天1点开会", { now: NOW })).toMatchObject({
      ok: false,
      code: "ambiguous",
    });
    expect(parseReminderTime("明天12点吃饭", { now: NOW })).toMatchObject({
      ok: false,
      code: "ambiguous",
    });
    expect(parseReminderTime("明天13点开会", { now: NOW })).toMatchObject({
      ok: true,
      dueAt: "2026-07-29T05:00:00.000Z",
    });
  });

  it("rejects missing, invalid, past, and multiply specified times", () => {
    expect(parseReminderTime("明天记得开会", { now: NOW })).toMatchObject({
      ok: false,
      code: "missing",
    });
    expect(parseReminderTime("下午3点开会", { now: NOW })).toMatchObject({
      ok: false,
      code: "missing",
    });
    expect(
      parseReminderTime("2027年2月29日09:00开会", { now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(parseReminderTime("7月20日09:00开会", { now: NOW })).toMatchObject({
      ok: false,
      code: "past_or_too_soon",
    });
    expect(
      parseReminderTime("明天下午3点开会，下午4点复盘", { now: NOW }),
    ).toMatchObject({ ok: false, code: "ambiguous" });
    expect(parseReminderTime("明天2小时后开会", { now: NOW })).toMatchObject({
      ok: false,
      code: "ambiguous",
    });
    expect(parseReminderTime("周五2天后开会", { now: NOW })).toMatchObject({
      ok: false,
      code: "ambiguous",
    });
    expect(
      parseReminderTime("2026-08-01 15:00，明天交报告", { now: NOW }),
    ).toMatchObject({ ok: false, code: "ambiguous" });
    expect(
      parseReminderTime("2026-08-01 15:00，下午4点复盘", { now: NOW }),
    ).toMatchObject({ ok: false, code: "ambiguous" });
    expect(
      parseReminderTime("2026-08-01 15:00和2026年8月2日", { now: NOW }),
    ).toMatchObject({ ok: false, code: "ambiguous" });
  });

  it("enforces a strict lead of more than 60 seconds", () => {
    expect(parseReminderTime("60秒后提醒", { now: NOW })).toMatchObject({
      ok: false,
      code: "past_or_too_soon",
    });
    expect(parseReminderTime("61秒后提醒", { now: NOW })).toMatchObject({
      ok: true,
      dueAt: "2026-07-28T04:01:31.000Z",
    });
    expect(
      parseReminderTime("今天12:01:30提醒", { now: NOW }),
    ).toMatchObject({
      ok: false,
      code: "past_or_too_soon",
    });
  });

  it("uses a five Shanghai-calendar-year upper bound", () => {
    expect(
      parseReminderTime("2031-07-28 12:00:30提醒", { now: NOW }),
    ).toMatchObject({
      ok: true,
      dueAt: "2031-07-28T04:00:30.000Z",
    });
    expect(
      parseReminderTime("2031-07-28 12:00:31提醒", { now: NOW }),
    ).toMatchObject({ ok: false, code: "too_far" });

    const leapNow = new Date("2028-02-29T04:00:00.000Z");
    expect(
      parseReminderTime("2033-02-28 12:00:00提醒", { now: leapNow }),
    ).toMatchObject({ ok: true });
    expect(
      parseReminderTime("2033-02-28 12:00:01提醒", { now: leapNow }),
    ).toMatchObject({ ok: false, code: "too_far" });
  });
});
