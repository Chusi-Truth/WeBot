import { describe, expect, it, vi } from "vitest";

import { ILinkApiClient } from "../src/api-client.js";

describe("ILinkApiClient", () => {
  it("sends the cursor and required authentication headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          msgs: [],
          get_updates_buf: "next",
        }),
        { status: 200 },
      ),
    );
    const client = new ILinkApiClient({
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.getUpdates("cursor")).resolves.toMatchObject({
      ret: 0,
      get_updates_buf: "next",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/ilink/bot/getupdates");
    expect(init?.headers).toMatchObject({
      AuthorizationType: "ilink_bot_token",
      Authorization: "Bearer secret-token",
      "iLink-App-Id": "bot",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      get_updates_buf: "cursor",
      base_info: {
        channel_version: "0.7.0",
        bot_agent: "WeBot/0.7.0",
      },
    });
  });

  it("constructs a complete text reply", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"ret":0}', { status: 200 }));
    const client = new ILinkApiClient({
      token: "secret-token",
      fetchImpl,
    });

    await client.sendText({
      toUserId: "user@im.wechat",
      contextToken: "context-token",
      text: "你好",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      msg: {
        to_user_id: "user@im.wechat",
        message_type: 2,
        message_state: 2,
        context_token: "context-token",
        item_list: [{ type: 1, text_item: { text: "你好" } }],
      },
    });
  });

  it("requests an image upload URL with the exact iLink media metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ret: 0,
          upload_full_url: "https://cdn.example.test/upload",
        }),
        { status: 200 },
      ),
    );
    const client = new ILinkApiClient({
      token: "secret-token",
      fetchImpl,
    });

    await expect(
      client.getImageUploadUrl({
        fileKey: "file-key",
        toUserId: "user@im.wechat",
        rawSize: 123,
        rawFileMd5: "0123456789abcdef0123456789abcdef",
        encryptedSize: 128,
        aesKeyHex: "00112233445566778899aabbccddeeff",
      }),
    ).resolves.toMatchObject({
      ret: 0,
      upload_full_url: "https://cdn.example.test/upload",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/ilink/bot/getuploadurl");
    expect(init?.headers).toMatchObject({
      AuthorizationType: "ilink_bot_token",
      Authorization: "Bearer secret-token",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      filekey: "file-key",
      media_type: 1,
      to_user_id: "user@im.wechat",
      rawsize: 123,
      rawfilemd5: "0123456789abcdef0123456789abcdef",
      filesize: 128,
      no_need_thumb: true,
      aeskey: "00112233445566778899aabbccddeeff",
      base_info: {
        channel_version: "0.7.0",
        bot_agent: "WeBot/0.7.0",
      },
    });
  });

  it("constructs an image message using the encrypted CDN reference", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"ret":0}', { status: 200 }));
    const client = new ILinkApiClient({
      token: "secret-token",
      fetchImpl,
    });
    const aesKeyHex = "00112233445566778899aabbccddeeff";

    await client.sendImage({
      toUserId: "user@im.wechat",
      contextToken: "context-token",
      encryptedQueryParam: "encrypted-query-param",
      aesKeyHex,
      encryptedSize: 144,
      runId: "run-id",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/ilink/bot/sendmessage");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      msg: {
        to_user_id: "user@im.wechat",
        message_type: 2,
        message_state: 2,
        context_token: "context-token",
        run_id: "run-id",
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: "encrypted-query-param",
                aes_key:
                  "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
                encrypt_type: 1,
              },
              mid_size: 144,
            },
          },
        ],
      },
    });
    expect(
      Buffer.from(aesKeyHex, "hex").toString("base64"),
    ).not.toBe(
      "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
    );
  });

  it("gets a typing ticket and sends typing status", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"ret":0,"typing_ticket":"ticket"}', {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('{"ret":0}', { status: 200 }));
    const client = new ILinkApiClient({
      token: "secret-token",
      fetchImpl,
    });

    await expect(
      client.getTypingTicket({
        userId: "user@im.wechat",
        contextToken: "context-token",
      }),
    ).resolves.toBe("ticket");
    await client.sendTyping({
      userId: "user@im.wechat",
      typingTicket: "ticket",
      status: 2,
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/ilink/bot/getconfig",
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      ilink_user_id: "user@im.wechat",
      context_token: "context-token",
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      "/ilink/bot/sendtyping",
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      ilink_user_id: "user@im.wechat",
      typing_ticket: "ticket",
      status: 2,
    });
  });
});
