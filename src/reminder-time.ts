export const REMINDER_V1_TIME_ZONE = "Asia/Shanghai" as const;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const MINIMUM_LEAD_MS = 60 * 1_000;

export type ReminderTimeParseErrorCode =
  | "missing"
  | "ambiguous"
  | "invalid"
  | "past_or_too_soon"
  | "too_far";

export type ReminderTimeParseResult =
  | {
      ok: true;
      dueAt: string;
      matchedText: string;
      timeZone: typeof REMINDER_V1_TIME_ZONE;
    }
  | {
      ok: false;
      code: ReminderTimeParseErrorCode;
      message: string;
    };

export interface ReminderTimeParseOptions {
  now?: Date;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

interface ParsedClock {
  hour: number;
  minute: number;
  second: number;
  dayCarry: number;
  matchedText: string;
}

interface ClockCandidate {
  raw: string;
  period?: string;
  hour: number;
  minute: number;
  second: number;
  pointNotation: boolean;
}

const CLOCK_PATTERN =
  /(?:(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜间)\s*)?(\d{1,2})(?:(?:\s*:\s*)(\d{2})(?:(?:\s*:\s*)(\d{2}))?|\s*(?:点|时)(?:(半)|\s*(\d{1,2})\s*分?)?)/gu;
const ISO_LOCAL_PATTERN =
  /(?<!\d)(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?(?![\d:])/gu;
const RELATIVE_PATTERN =
  /(?<![\d.])(\d+(?:\.\d+)?)\s*(秒钟?|分钟?|小时|天)\s*(?:以?后)(?!\w)/gu;

export function parseReminderTime(
  input: string,
  options: ReminderTimeParseOptions = {},
): ReminderTimeParseResult {
  const now = options.now ? new Date(options.now.getTime()) : new Date();
  if (!Number.isFinite(now.getTime())) {
    return failure("invalid", "当前时间无效，无法设置提醒。");
  }
  const text = normalizeChineseTimeNumbers(input.normalize("NFKC")).trim();
  if (!text) {
    return failure("missing", "请提供明确的提醒日期和具体时刻。");
  }

  const isoMatches = [...text.matchAll(ISO_LOCAL_PATTERN)];
  const relativeMatches = [...text.matchAll(RELATIVE_PATTERN)];
  if (isoMatches.length > 1 || (isoMatches.length > 0 && relativeMatches.length > 0)) {
    return failure("ambiguous", "消息中有多个时间，请只保留一个提醒时刻。");
  }
  if (isoMatches.length === 1) {
    const match = isoMatches[0]!;
    const matchStart = match.index ?? 0;
    const remainder =
      text.slice(0, matchStart) + text.slice(matchStart + match[0].length);
    if (
      relativeMatches.length > 0 ||
      hasCalendarDateMarker(remainder) ||
      extractClockCandidates(remainder).length > 0
    ) {
      return failure(
        "ambiguous",
        "消息中有多个日期或时刻，请只保留一个提醒时间。",
      );
    }
    const parsed = parseIsoLike(match);
    if (!parsed) {
      return failure("invalid", "日期或时刻无效，请检查后重试。");
    }
    return finish(parsed, match[0], now);
  }

  const clockCandidates = extractClockCandidates(text);
  if (clockCandidates.length > 1) {
    return failure("ambiguous", "消息中有多个具体时刻，请说明要在哪一个时刻提醒。");
  }
  const clockResult =
    clockCandidates.length === 1
      ? parseClock(clockCandidates[0]!)
      : undefined;
  if (clockResult && !clockResult.ok) return clockResult.result;
  const clock = clockResult?.clock;

  if (relativeMatches.length > 1) {
    return failure("ambiguous", "消息中有多个相对时间，请只保留一个提醒时刻。");
  }
  if (relativeMatches.length === 1) {
    if (hasCalendarDateMarker(text)) {
      return failure(
        "ambiguous",
        "消息同时包含日历日期和相对时间，请只保留一种提醒时刻。",
      );
    }
    const relative = relativeMatches[0]!;
    const amount = Number(relative[1]);
    const unit = relative[2]!;
    if (!Number.isFinite(amount) || amount <= 0) {
      return failure("invalid", "相对时间必须是大于 0 的数值。");
    }
    if (clock) {
      if (unit !== "天" || !Number.isInteger(amount)) {
        return failure(
          "ambiguous",
          "相对时间和具体时刻同时出现时，请改成明确的日期和时刻。",
        );
      }
      const localNow = shanghaiDate(now);
      const date = addLocalDays(localNow, amount);
      const instant = localToInstant(date, clock);
      if (instant === null) {
        return failure("invalid", "日期或时刻无效，请检查后重试。");
      }
      return finish(instant, `${relative[0]}${clock.matchedText}`, now);
    }
    const unitMs =
      unit.startsWith("秒")
        ? 1_000
        : unit.startsWith("分钟")
          ? 60 * 1_000
          : unit === "小时"
            ? 60 * 60 * 1_000
            : 24 * 60 * 60 * 1_000;
    return finish(now.getTime() + amount * unitMs, relative[0], now);
  }

  const localNow = shanghaiDate(now);
  const dateCandidates: Array<{
    date: LocalDateParts | null;
    raw: string;
  }> = [];

  for (const match of text.matchAll(/今天|明天|后天/gu)) {
    const offset = match[0] === "今天" ? 0 : match[0] === "明天" ? 1 : 2;
    dateCandidates.push({
      date: addLocalDays(localNow, offset),
      raw: match[0],
    });
  }

  for (
    const match of text.matchAll(
      /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]/gu,
    )
  ) {
    dateCandidates.push({
      date: {
        year: match[1] ? Number(match[1]) : localNow.year,
        month: Number(match[2]),
        day: Number(match[3]),
      },
      raw: match[0],
    });
  }

  for (
    const match of text.matchAll(
      /(下周|下星期|本周|本星期|这周|这星期|周|星期)([一二三四五六日天])/gu,
    )
  ) {
    dateCandidates.push({
      date: resolveWeekday(localNow, match[1]!, match[2]!),
      raw: match[0],
    });
  }

  if (dateCandidates.length > 1) {
    return failure("ambiguous", "消息中有多个日期，请只保留一个提醒日期。");
  }
  if (!clock && dateCandidates.length > 0) {
    return failure("missing", "日期已经明确，请再说明具体几点提醒。");
  }
  if (clock && dateCandidates.length === 0) {
    return failure("missing", "时刻已经明确，请再说明是哪一天。");
  }
  if (!clock || dateCandidates.length === 0) {
    return failure(
      "missing",
      "没有找到明确的未来日期和具体时刻，请换一种说法。",
    );
  }

  const candidate = dateCandidates[0]!;
  if (!candidate.date || !isValidLocalDate(candidate.date)) {
    return failure("invalid", "日期无效，请检查年月日后重试。");
  }
  const instant = localToInstant(candidate.date, clock);
  if (instant === null) {
    return failure("invalid", "日期或时刻无效，请检查后重试。");
  }
  return finish(instant, `${candidate.raw}${clock.matchedText}`, now);
}

function extractClockCandidates(text: string): ClockCandidate[] {
  return [...text.matchAll(CLOCK_PATTERN)].map((match) => ({
    raw: match[0],
    ...(match[1] ? { period: match[1] } : {}),
    hour: Number(match[2]),
    minute: match[5] ? 30 : Number(match[3] ?? match[6] ?? 0),
    second: Number(match[4] ?? 0),
    pointNotation: match[3] === undefined,
  }));
}

function parseClock(
  candidate: ClockCandidate,
):
  | { ok: true; clock: ParsedClock }
  | { ok: false; result: ReminderTimeParseResult } {
  let { hour } = candidate;
  let dayCarry = 0;
  if (
    hour < 0 ||
    hour > 23 ||
    candidate.minute < 0 ||
    candidate.minute > 59 ||
    candidate.second < 0 ||
    candidate.second > 59
  ) {
    return {
      ok: false,
      result: failure("invalid", "具体时刻无效，请使用 0:00–23:59。"),
    };
  }

  if (!candidate.period) {
    if (candidate.pointNotation && hour >= 1 && hour <= 12) {
      return {
        ok: false,
        result: failure(
          "ambiguous",
          `${hour} 点可能是上午也可能是下午，请明确说明。`,
        ),
      };
    }
  } else {
    const period = candidate.period;
    if (hour > 12) {
      return {
        ok: false,
        result: failure("invalid", "带上午或下午时，小时应在 1–12 之间。"),
      };
    }
    if (period === "凌晨") {
      if (hour === 12) hour = 0;
      else if (hour > 5) return invalidPeriod();
    } else if (period === "清晨" || period === "早上" || period === "上午") {
      if (hour < 1 || hour > 11) return invalidPeriod();
    } else if (period === "中午") {
      if (hour === 1 || hour === 2) hour += 12;
      else if (hour !== 11 && hour !== 12) return invalidPeriod();
    } else if (period === "下午") {
      if (hour >= 1 && hour <= 11) hour += 12;
      else if (hour !== 12) return invalidPeriod();
    } else {
      if (hour === 12) {
        hour = 0;
        dayCarry = 1;
      } else if (hour >= 1 && hour <= 11) {
        hour += 12;
      } else {
        return invalidPeriod();
      }
    }
  }

  return {
    ok: true,
    clock: {
      hour,
      minute: candidate.minute,
      second: candidate.second,
      dayCarry,
      matchedText: candidate.raw,
    },
  };
}

function invalidPeriod(): {
  ok: false;
  result: ReminderTimeParseResult;
} {
  return {
    ok: false,
    result: failure("invalid", "时段和小时互相冲突，请换成明确的 24 小时制。"),
  };
}

function parseIsoLike(match: RegExpMatchArray): number | null {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const date = { year, month, day };
  if (
    !isValidLocalDate(date) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const localWallClock = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = match[7];
  if (!offset) return localWallClock - SHANGHAI_OFFSET_MS;
  if (offset === "Z") return localWallClock;
  const sign = offset.startsWith("-") ? -1 : 1;
  const [offsetHourText, offsetMinuteText] = offset.slice(1).split(":");
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  if (
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }
  return localWallClock - sign * (offsetHour * 60 + offsetMinute) * 60 * 1_000;
}

function resolveWeekday(
  localNow: LocalDateParts,
  qualifier: string,
  weekdayText: string,
): LocalDateParts {
  const weekdayNumbers: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 7,
    天: 7,
  };
  const target = weekdayNumbers[weekdayText]!;
  const currentJsDay = new Date(
    Date.UTC(localNow.year, localNow.month - 1, localNow.day),
  ).getUTCDay();
  const current = currentJsDay === 0 ? 7 : currentJsDay;
  if (qualifier.startsWith("下")) {
    return addLocalDays(localNow, 7 - current + target);
  }
  if (qualifier.startsWith("本") || qualifier.startsWith("这")) {
    return addLocalDays(localNow, target - current);
  }
  return addLocalDays(localNow, (target - current + 7) % 7);
}

function shanghaiDate(now: Date): LocalDateParts {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

function addLocalDays(date: LocalDateParts, days: number): LocalDateParts {
  const value = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function localToInstant(
  date: LocalDateParts,
  clock: ParsedClock,
): number | null {
  if (!isValidLocalDate(date)) return null;
  const adjustedDate = addLocalDays(date, clock.dayCarry);
  return (
    Date.UTC(
      adjustedDate.year,
      adjustedDate.month - 1,
      adjustedDate.day,
      clock.hour,
      clock.minute,
      clock.second,
    ) - SHANGHAI_OFFSET_MS
  );
}

function isValidLocalDate(date: LocalDateParts): boolean {
  if (
    !Number.isInteger(date.year) ||
    !Number.isInteger(date.month) ||
    !Number.isInteger(date.day) ||
    date.year < 1 ||
    date.month < 1 ||
    date.month > 12 ||
    date.day < 1
  ) {
    return false;
  }
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return (
    value.getUTCFullYear() === date.year &&
    value.getUTCMonth() + 1 === date.month &&
    value.getUTCDate() === date.day
  );
}

function finish(
  instantMs: number,
  matchedText: string,
  now: Date,
): ReminderTimeParseResult {
  if (!Number.isFinite(instantMs)) {
    return failure("invalid", "日期或时刻无效，请检查后重试。");
  }
  const leadMs = instantMs - now.getTime();
  if (leadMs <= MINIMUM_LEAD_MS) {
    return failure(
      "past_or_too_soon",
      leadMs <= 0
        ? "这个时刻已经过去，请提供未来的明确时间。"
        : "提醒时间必须比当前时间晚 60 秒以上。",
    );
  }
  if (instantMs > addFiveShanghaiCalendarYears(now)) {
    return failure("too_far", "提醒时间不能超过未来 5 年。");
  }
  return {
    ok: true,
    dueAt: new Date(instantMs).toISOString(),
    matchedText,
    timeZone: REMINDER_V1_TIME_ZONE,
  };
}

function addFiveShanghaiCalendarYears(now: Date): number {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear() + 5;
  const month = local.getUTCMonth();
  const day = Math.min(
    local.getUTCDate(),
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
  );
  return (
    Date.UTC(
      year,
      month,
      day,
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ) - SHANGHAI_OFFSET_MS
  );
}

function normalizeChineseTimeNumbers(value: string): string {
  return value.replace(
    /[零〇一二两三四五六七八九十百千]+(?=\s*(?:分钟?|小时|秒钟?|天|年|月|[日号]|[点时]|分))/gu,
    (raw) => {
      const parsed = parseChineseInteger(raw);
      return parsed === null ? raw : String(parsed);
    },
  );
}

function hasCalendarDateMarker(value: string): boolean {
  return (
    /今天|明天|后天/u.test(value) ||
    /(?:(?:\d{4})年)?\d{1,2}月\d{1,2}[日号]/u.test(value) ||
    /(下周|下星期|本周|本星期|这周|这星期|周|星期)[一二三四五六日天]/u.test(
      value,
    )
  );
}

function parseChineseInteger(value: string): number | null {
  const digits: Readonly<Record<string, number>> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (!/[十百千]/u.test(value)) {
    const parts = [...value].map((character) => digits[character]);
    if (parts.some((digit) => digit === undefined)) return null;
    return Number(parts.join(""));
  }

  const units: Readonly<Record<string, number>> = {
    十: 10,
    百: 100,
    千: 1_000,
  };
  let total = 0;
  let currentDigit = 0;
  for (const character of value) {
    const digit = digits[character];
    if (digit !== undefined) {
      currentDigit = digit;
      continue;
    }
    const unit = units[character];
    if (!unit) return null;
    total += (currentDigit || 1) * unit;
    currentDigit = 0;
  }
  return total + currentDigit;
}

function failure(
  code: ReminderTimeParseErrorCode,
  message: string,
): ReminderTimeParseResult {
  return { ok: false, code, message };
}
