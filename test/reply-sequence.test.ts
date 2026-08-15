import { describe, expect, it } from "vitest";

import {
  REPLY_BUBBLE_MARKER,
  splitModelReply,
  stripInternalChatTimeMetadata,
} from "../src/reply-sequence.js";

describe("splitModelReply", () => {
  it("removes internal chat-time metadata before creating outbound bubbles", () => {
    const reply = [
      "[平台时间元数据：发送于 2026-08-13 周四 20:01:00（Asia/Shanghai）；距上一条消息约 3 分钟]",
      "刚看到。",
      "[[下一条]]",
      "`[平台时间元数据：发送于 2026-08-13 周四 20:01:01；几乎同时]` 你继续说。",
    ].join("\n");

    expect(splitModelReply(reply, "wechat")).toEqual([
      "刚看到。",
      "你继续说。",
    ]);
    expect(stripInternalChatTimeMetadata("现在是 20:01，早点休息。")).toBe(
      "现在是 20:01，早点休息。",
    );
  });

  it("keeps roleplay replies in one message", () => {
    expect(
      splitModelReply(
        `第一段\n\n${REPLY_BUBBLE_MARKER}\n\n第二段`,
        "roleplay",
      ),
    ).toEqual([`第一段\n\n${REPLY_BUBBLE_MARKER}\n\n第二段`]);
  });

  it("uses exclusive marker lines as explicit WeChat boundaries", () => {
    expect(
      splitModelReply(
        "  第一条  \r\n \t[[ 下一条 ]] \r\n第二条\r\n[[下一条]]\r\n第三条  ",
        "wechat",
      ),
    ).toEqual(["第一条", "第二条", "第三条"]);
  });

  it("does not treat an inline marker as a boundary", () => {
    expect(
      splitModelReply("先说 [[下一条]] 再说", "wechat"),
    ).toEqual(["先说 [[下一条]] 再说"]);
  });

  it("lets explicit markers take priority over blank paragraphs", () => {
    expect(
      splitModelReply(
        "第一段\n\n仍属于第一条\n[[下一条]]\n第二条",
        "wechat",
      ),
    ).toEqual(["第一段\n\n仍属于第一条", "第二条"]);
  });

  it("uses natural blank paragraphs when no marker is present", () => {
    expect(
      splitModelReply(
        "刚下班。\n\n  现在暂时守着图书馆。\n \n你突然问这个干什么？",
        "wechat",
      ),
    ).toEqual([
      "刚下班。",
      "现在暂时守着图书馆。",
      "你突然问这个干什么？",
    ]);
  });

  it("does not split ordinary single-newline lists", () => {
    const list = "今天要做：\n- 擦地图\n- 整理货架\n- 提前关门";
    expect(splitModelReply(list, "wechat")).toEqual([list]);
  });

  it("removes empty pieces produced by repeated markers", () => {
    expect(
      splitModelReply(
        "[[下一条]]\n[[下一条]]\n第一条\n[[下一条]]\n[[下一条]]",
        "wechat",
      ),
    ).toEqual(["第一条"]);
  });

  it("keeps every explicit bubble without merging overflow", () => {
    expect(
      splitModelReply(
        "一\n[[下一条]]\n二\n[[下一条]]\n三\n[[下一条]]\n四",
        "wechat",
        3,
      ),
    ).toEqual(["一", "二", "三", "四"]);
  });

  it("ignores the legacy maximum argument and does not cap natural bubbles", () => {
    const reply = "一\n\n二\n\n三\n\n四\n\n五\n\n六";
    expect(splitModelReply(reply, "wechat", 0)).toEqual([
      "一",
      "二",
      "三",
      "四",
      "五",
      "六",
    ]);
    expect(splitModelReply(reply, "wechat", 99)).toEqual([
      "一",
      "二",
      "三",
      "四",
      "五",
      "六",
    ]);
  });

  it("returns no bubbles for a blank model reply", () => {
    expect(splitModelReply(" \n\t\r\n ", "wechat")).toEqual([]);
    expect(splitModelReply("", "roleplay")).toEqual([]);
  });
});
