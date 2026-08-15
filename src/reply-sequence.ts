export const REPLY_BUBBLE_MARKER = "[[下一条]]";

export type ReplyMode = "wechat" | "roleplay";

const EXCLUSIVE_MARKER_LINE =
  /^[\t ]*\[\[[\t ]*下一条[\t ]*\]\][\t ]*$/imu;
const EXCLUSIVE_MARKER_LINES =
  /^[\t ]*\[\[[\t ]*下一条[\t ]*\]\][\t ]*$/gimu;
const BLANK_LINE = /\n(?:[\t ]*\n)+/u;
const INTERNAL_CHAT_TIME_METADATA =
  /`?\[平台时间元数据[：:][^\]\r\n]{0,500}\]`?[\t ]*(?:\n)?/gu;

/**
 * Turns a model reply into the ordered messages that should be sent.
 *
 * Explicit marker lines take precedence over natural paragraph breaks. This
 * lets a prompt control bubble boundaries without splitting single-newline
 * lists or line-broken prose. Roleplay replies are deliberately kept intact.
 */
export function splitModelReply(
  reply: string,
  mode: ReplyMode,
  /** @deprecated Bubble count is no longer capped. */
  _legacyMaxBubbles?: number,
): string[] {
  const normalizedReply = stripInternalChatTimeMetadata(
    normalizeLineEndings(reply),
  ).trim();
  if (!normalizedReply) return [];

  if (mode === "roleplay") return [normalizedReply];

  const separator = EXCLUSIVE_MARKER_LINE.test(normalizedReply)
    ? EXCLUSIVE_MARKER_LINES
    : BLANK_LINE;
  return normalizedReply
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Platform timestamps are model context, never chat content. Models can
 * occasionally echo the trusted prefix despite being instructed not to, so
 * remove the exact internal marker at the final outbound boundary as a
 * fail-safe. Ordinary dates and times remain untouched.
 */
export function stripInternalChatTimeMetadata(value: string): string {
  return value.replace(INTERNAL_CHAT_TIME_METADATA, "");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}
