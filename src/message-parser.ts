import {
  MessageItemType,
  MessageType,
  type IncomingTextMessage,
  type MessageItem,
  type WeixinMessage,
} from "./types.js";

export function parseIncomingText(
  message: WeixinMessage,
  voiceTranscription?: string,
): IncomingTextMessage | null {
  if (message.message_type !== MessageType.USER) return null;
  if (!message.from_user_id || !message.context_token) return null;

  const text = extractText(message.item_list, voiceTranscription);
  if (!text) return null;

  return {
    ...(message.message_id === undefined
      ? {}
      : { messageId: message.message_id }),
    senderId: message.from_user_id,
    ...(message.session_id ? { sessionId: message.session_id } : {}),
    text,
    contextToken: message.context_token,
    ...(message.create_time_ms === undefined
      ? {}
      : { createdAt: message.create_time_ms }),
    raw: message,
  };
}

function extractText(
  items?: MessageItem[],
  voiceTranscription?: string,
): string {
  if (!items?.length) return "";
  const parts: string[] = [];
  let usedVoiceTranscription = false;
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const quoted = extractQuotedText(item);
      parts.push(
        quoted
          ? `[引用消息]\n${quoted}\n[/引用消息]\n${item.text_item.text}`
          : item.text_item.text,
      );
    } else if (
      item.type === MessageItemType.VOICE &&
      item.voice_item?.text?.trim()
    ) {
      parts.push(item.voice_item.text.trim());
    } else if (
      item.type === MessageItemType.VOICE &&
      voiceTranscription?.trim() &&
      !usedVoiceTranscription
    ) {
      parts.push(voiceTranscription.trim());
      usedVoiceTranscription = true;
    }
  }
  return parts.join("\n").trim();
}

function extractQuotedText(item: MessageItem): string {
  const reference = item.ref_msg;
  if (!reference) return "";
  const parts = [
    reference.title,
    describeQuotedItem(reference.message_item),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim());
  return parts.join(" | ");
}

function describeQuotedItem(item?: MessageItem): string {
  if (!item) return "";
  if (item.type === MessageItemType.TEXT) {
    return item.text_item?.text?.trim() ?? "";
  }
  if (item.type === MessageItemType.VOICE) {
    return item.voice_item?.text?.trim() || "[语音消息]";
  }
  if (item.type === MessageItemType.IMAGE) return "[图片消息]";
  if (item.type === MessageItemType.FILE) return "[文件消息]";
  if (item.type === MessageItemType.VIDEO) return "[视频消息]";
  return "";
}
