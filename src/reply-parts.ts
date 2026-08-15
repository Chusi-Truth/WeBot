import type { OutgoingReplyPart } from "./types.js";

export const IMAGE_REPLY_DIRECTIVE = "WEBOT_IMAGE_V1";

const IMAGE_DIRECTIVE =
  /^\[\[WEBOT_IMAGE_V1[ \t]+(\S+)\]\]$/u;
const POSSIBLE_IMAGE_DIRECTIVE = /^\[\[WEBOT_IMAGE_V1\b/iu;
const MAX_IMAGE_URL_LENGTH = 2_048;

export interface ParsedReplyParts {
  parts: OutgoingReplyPart[];
  memoryReplies: string[];
  hasImages: boolean;
  transformed: boolean;
}

export interface ParseReplyPartsOptions {
  /**
   * When present, an image directive must copy one of these normalized URLs
   * exactly. This prevents a model from encoding private context into a new
   * attacker-controlled URL.
   */
  allowedSourceUrls: ReadonlySet<string>;
}

/**
 * Converts the deliberately narrow model-side image directive into a typed
 * outbound part. Ordinary Markdown is never interpreted as an action.
 */
export function parseReplyParts(
  bubbles: readonly string[],
  maxImages: number,
  options: ParseReplyPartsOptions,
): ParsedReplyParts {
  const parts: OutgoingReplyPart[] = [];
  const memoryReplies: string[] = [];
  let imageCount = 0;
  let transformed = false;

  for (const bubble of bubbles) {
    const match = IMAGE_DIRECTIVE.exec(bubble.trim());
    if (!match) {
      if (POSSIBLE_IMAGE_DIRECTIVE.test(bubble.trim())) {
        transformed = true;
        const fallback = "这张图片没有可用的公网链接。";
        parts.push({ type: "text", text: fallback });
        memoryReplies.push(fallback);
      } else {
        parts.push({ type: "text", text: bubble });
        memoryReplies.push(bubble);
      }
      continue;
    }

    if (imageCount >= maxImages) {
      transformed = true;
      const fallback = "这次要发送的图片太多了，我先停在这里。";
      parts.push({ type: "text", text: fallback });
      memoryReplies.push(fallback);
      continue;
    }

    const sourceUrl = normalizeImageUrl(match[1]!);
    if (
      !sourceUrl ||
      !options.allowedSourceUrls.has(sourceUrl)
    ) {
      transformed = true;
      const fallback = "这张图片没有可用的公网链接。";
      parts.push({ type: "text", text: fallback });
      memoryReplies.push(fallback);
      continue;
    }

    imageCount += 1;
    transformed = true;
    parts.push({
      type: "image",
      sourceUrl,
      fallbackText: "这张图片暂时没能发出去。",
    });
    // Never persist a temporary or signed source URL in long-term memory.
    memoryReplies.push("[发送了一张图片]");
  }

  return {
    parts,
    memoryReplies,
    hasImages: imageCount > 0,
    transformed,
  };
}

export function collectUserImageUrls(
  values: readonly string[],
): ReadonlySet<string> {
  const urls = new Set<string>();
  const candidatePattern = /https:\/\/[^\s<>"'`]+/giu;
  for (const value of values) {
    for (const match of value.matchAll(candidatePattern)) {
      const candidate = trimUrlPunctuation(match[0]);
      const normalized = normalizeImageUrl(candidate);
      if (normalized) urls.add(normalized);
    }
  }
  return urls;
}

function normalizeImageUrl(value: string): string | null {
  if (!value || value.length > MAX_IMAGE_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[)\]}>.,!?;:，。！？；：）】》]+$/gu, "");
}
