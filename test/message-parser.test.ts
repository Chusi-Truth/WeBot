import { describe, expect, it } from "vitest";

import { parseIncomingText } from "../src/message-parser.js";
import { MessageItemType, MessageType } from "../src/types.js";

describe("parseIncomingText", () => {
  it("parses a user text message", () => {
    const result = parseIncomingText({
      message_id: 42,
      message_type: MessageType.USER,
      from_user_id: "user@im.wechat",
      context_token: "context",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "你好" },
        },
      ],
    });

    expect(result).toMatchObject({
      messageId: 42,
      senderId: "user@im.wechat",
      contextToken: "context",
      text: "你好",
    });
  });

  it("ignores bot messages and messages without a context token", () => {
    expect(
      parseIncomingText({
        message_type: MessageType.BOT,
        from_user_id: "bot",
        context_token: "context",
        item_list: [
          { type: MessageItemType.TEXT, text_item: { text: "ignore" } },
        ],
      }),
    ).toBeNull();

    expect(
      parseIncomingText({
        message_type: MessageType.USER,
        from_user_id: "user",
        item_list: [
          { type: MessageItemType.TEXT, text_item: { text: "ignore" } },
        ],
      }),
    ).toBeNull();
  });

  it("uses voice transcription and quoted text", () => {
    expect(
      parseIncomingText({
        message_type: MessageType.USER,
        from_user_id: "user",
        context_token: "context",
        item_list: [
          {
            type: MessageItemType.TEXT,
            text_item: { text: "回答" },
            ref_msg: {
              title: "Alice",
              message_item: {
                type: MessageItemType.TEXT,
                text_item: { text: "原消息" },
              },
            },
          },
          {
            type: MessageItemType.VOICE,
            voice_item: { text: "语音转写" },
          },
        ],
      })?.text,
    ).toBe(
      "[引用消息]\nAlice | 原消息\n[/引用消息]\n回答\n语音转写",
    );
  });

  it("uses a separately generated transcription for voice media", () => {
    expect(
      parseIncomingText(
        {
          message_type: MessageType.USER,
          from_user_id: "user",
          context_token: "context",
          item_list: [
            {
              type: MessageItemType.VOICE,
              voice_item: {
                media: {
                  aes_key: "key",
                  full_url: "https://example.com/voice",
                },
              },
            },
          ],
        },
        "这是外部语音识别结果",
      )?.text,
    ).toBe("这是外部语音识别结果");
  });

  it("describes quoted media instead of dropping the reference", () => {
    expect(
      parseIncomingText({
        message_type: MessageType.USER,
        from_user_id: "user",
        context_token: "context",
        item_list: [
          {
            type: MessageItemType.TEXT,
            text_item: { text: "你看这个" },
            ref_msg: {
              title: "Alice",
              message_item: { type: MessageItemType.IMAGE },
            },
          },
        ],
      })?.text,
    ).toContain("Alice | [图片消息]");
  });
});
