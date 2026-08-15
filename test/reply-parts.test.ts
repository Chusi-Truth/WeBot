import { describe, expect, it } from "vitest";

import {
  IMAGE_REPLY_DIRECTIVE,
  parseReplyParts,
} from "../src/reply-parts.js";

describe("parseReplyParts", () => {
  it("parses only an exact standalone image directive and keeps its URL out of memory", () => {
    const sourceUrl =
      "https://images.example.test/cat.png?temporary=secret-token";

    expect(
      parseReplyParts(
        [
          "先给你看一张。",
          `[[${IMAGE_REPLY_DIRECTIVE} ${sourceUrl}]]`,
          "看完再告诉我。",
        ],
        4,
        { allowedSourceUrls: new Set([sourceUrl]) },
      ),
    ).toEqual({
      parts: [
        { type: "text", text: "先给你看一张。" },
        {
          type: "image",
          sourceUrl,
          fallbackText: "这张图片暂时没能发出去。",
        },
        { type: "text", text: "看完再告诉我。" },
      ],
      memoryReplies: [
        "先给你看一张。",
        "[发送了一张图片]",
        "看完再告诉我。",
      ],
      hasImages: true,
      transformed: true,
    });
  });

  it("never executes ordinary Markdown images or inline directive-like text", () => {
    const markdown = "![猫](https://images.example.test/cat.png)";
    const inline =
      `只是解释格式：[[${IMAGE_REPLY_DIRECTIVE} https://images.example.test/cat.png]]`;

    expect(
      parseReplyParts(
        [markdown, inline],
        4,
        { allowedSourceUrls: new Set() },
      ),
    ).toEqual({
      parts: [
        { type: "text", text: markdown },
        { type: "text", text: inline },
      ],
      memoryReplies: [markdown, inline],
      hasImages: false,
      transformed: false,
    });
  });

  it("turns malformed or unsafe standalone directives into text without exposing the URL", () => {
    const result = parseReplyParts(
      [
        `[[${IMAGE_REPLY_DIRECTIVE} http://127.0.0.1/private.png]]`,
        `[[${IMAGE_REPLY_DIRECTIVE} https://user:pass@example.test/a.png]]`,
        `[[${IMAGE_REPLY_DIRECTIVE} https://example.test/a.png]] trailing`,
      ],
      4,
      { allowedSourceUrls: new Set() },
    );

    expect(result.parts).toEqual([
      { type: "text", text: "这张图片没有可用的公网链接。" },
      { type: "text", text: "这张图片没有可用的公网链接。" },
      { type: "text", text: "这张图片没有可用的公网链接。" },
    ]);
    expect(result.memoryReplies).toEqual([
      "这张图片没有可用的公网链接。",
      "这张图片没有可用的公网链接。",
      "这张图片没有可用的公网链接。",
    ]);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    expect(JSON.stringify(result)).not.toContain("user:pass");
    expect(result.hasImages).toBe(false);
    expect(result.transformed).toBe(true);
  });
});
