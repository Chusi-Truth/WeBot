import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  downloadAll,
  hasDownloadableImage,
  ImageInputDownloader,
} from "../src/image-input.js";
import { MessageItemType, type WeixinMessage } from "../src/types.js";

const KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x01, 0x02, 0x03, 0x04,
]);

describe("ImageInputDownloader", () => {
  it.each([
    ["base64 bytes", KEY.toString("base64")],
    ["base64-wrapped hex", Buffer.from(KEY.toString("hex")).toString("base64")],
    ["direct hex", KEY.toString("hex")],
  ])("downloads and decrypts a full_url using a %s key", async (_kind, aesKey) => {
    const encrypted = encrypt(PNG, KEY);
    const fetchImpl = vi.fn(async () => responseWith(encrypted));
    const downloader = new ImageInputDownloader({ fetchImpl });
    const message = imageMessage({
      aesKey,
      fullUrl: "https://media.example.test/image?credential=private",
    });

    expect(downloader.hasDownloadableImage(message)).toBe(true);
    await expect(downloader.downloadAll(message)).resolves.toEqual([
      { data: PNG, mimeType: "image/png" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://media.example.test/image?credential=private",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("treats a main image with a full_url and no AES key as plaintext", async () => {
    const fetchImpl = vi.fn(async () => responseWith(PNG));
    const downloader = new ImageInputDownloader({
      cdnBaseUrl: "https://novac2c.example.test/c2c/",
      fetchImpl,
    });
    const message: WeixinMessage = {
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: { full_url: "https://media.example.test/plain-image" },
            thumb_media: {
              aes_key: KEY.toString("base64"),
              encrypt_query_param: "thumb token+/=&",
            },
          },
        },
      ],
    };

    expect(hasDownloadableImage(message)).toBe(true);
    await expect(downloader.downloadAll(message)).resolves.toEqual([
      { data: PNG, mimeType: "image/png" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://media.example.test/plain-image",
      { signal: expect.any(AbortSignal) },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("downloads plaintext media through the bounded CDN query URL fallback", async () => {
    const fetchImpl = vi.fn(async () => responseWith(PNG));
    const downloader = new ImageInputDownloader({
      cdnBaseUrl: "https://novac2c.example.test/c2c/",
      fetchImpl,
    });
    const message: WeixinMessage = {
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: { encrypt_query_param: "plain token+/=&" },
          },
        },
      ],
    };

    await expect(downloader.downloadAll(message)).resolves.toEqual([
      { data: PNG, mimeType: "image/png" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://novac2c.example.test/c2c/download?encrypted_query_param=plain%20token%2B%2F%3D%26",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("prefers image_item.aeskey over media.aes_key", async () => {
    const encrypted = encrypt(PNG, KEY);
    const fetchImpl = vi.fn(async () => responseWith(encrypted));
    const message: WeixinMessage = {
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            aeskey: KEY.toString("hex"),
            media: {
              aes_key: Buffer.alloc(16, 0xff).toString("base64"),
              full_url: "https://media.example.test/image",
            },
          },
        },
      ],
    };

    await expect(downloadAll(message, { fetchImpl })).resolves.toEqual([
      { data: PNG, mimeType: "image/png" },
    ]);
  });

  it("falls back to thumb_media only after the main media is actually unusable", async () => {
    const encryptedThumb = encrypt(PNG, KEY);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("main-image")) {
        return new Response("not found", { status: 404 });
      }
      return responseWith(encryptedThumb);
    });
    const downloader = new ImageInputDownloader({ fetchImpl });
    const message: WeixinMessage = {
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: { full_url: "https://media.example.test/main-image" },
            thumb_media: {
              full_url: "https://media.example.test/thumb-image",
              aes_key: KEY.toString("base64"),
            },
          },
        },
      ],
    };

    await expect(downloader.downloadAll(message)).resolves.toEqual([
      { data: PNG, mimeType: "image/png" },
    ]);
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      "https://media.example.test/main-image",
      "https://media.example.test/thumb-image",
    ]);
  });

  it("downloads a one-level image referenced from a text item", async () => {
    const fetchImpl = vi.fn(async () => responseWith(PNG));
    const downloader = new ImageInputDownloader({ fetchImpl });
    const message: WeixinMessage = {
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "这张图是什么？" },
          ref_msg: {
            message_item: {
              type: MessageItemType.IMAGE,
              image_item: {
                media: { full_url: "https://media.example.test/quoted-image" },
              },
            },
          },
        },
      ],
    };

    expect(downloader.hasDownloadableImage(message)).toBe(true);
    await expect(downloader.downloadAll(message)).resolves.toEqual([
      { data: PNG, mimeType: "image/png" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://media.example.test/quoted-image",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("rejects a bad key without exposing the key or URL credential", async () => {
    const badKey = "BAD_KEY_SHOULD_STAY_PRIVATE";
    const urlCredential = "URL_QUERY_SHOULD_STAY_PRIVATE";
    const fetchImpl = vi.fn(async () => responseWith(encrypt(PNG, KEY)));
    const downloader = new ImageInputDownloader({ fetchImpl });
    const error = await downloader.downloadAll(imageMessage({
      aesKey: badKey,
      fullUrl: `https://media.example.test/image?token=${urlCredential}`,
    })).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("AES 密钥格式无效");
    expect((error as Error).message).not.toContain(badKey);
    expect((error as Error).message).not.toContain(urlCredential);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes the crypto error produced by a well-formed but incorrect key", async () => {
    const wrongKey = Buffer.alloc(16, 0xff).toString("base64");
    const urlCredential = "DECRYPT_URL_SECRET";
    const downloader = new ImageInputDownloader({
      fetchImpl: vi.fn(async () => responseWith(encrypt(PNG, KEY))),
    });
    const error = await downloader.downloadAll(imageMessage({
      aesKey: wrongKey,
      fullUrl: `https://media.example.test/image?token=${urlCredential}`,
    })).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("微信图片解密失败。");
    expect((error as Error).message).not.toContain(wrongKey);
    expect((error as Error).message).not.toContain(urlCredential);
  });

  it("sanitizes transport errors that contain the full download URL", async () => {
    const querySecret = "QUERY_SECRET";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      throw new Error(`fetch failed for ${String(input)}`);
    });
    const downloader = new ImageInputDownloader({ fetchImpl });
    const error = await downloader.downloadAll(imageMessage({
      aesKey: KEY.toString("base64"),
      fullUrl: `https://media.example.test/image?token=${querySecret}`,
    })).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("微信图片下载失败。");
    expect((error as Error).message).not.toContain(querySecret);
  });

  it("rejects oversized encrypted content from both its header and streamed body", async () => {
    const message = imageMessage({
      aesKey: KEY.toString("base64"),
      fullUrl: "https://media.example.test/image",
    });
    const headerDownloader = new ImageInputDownloader({
      maxEncryptedBytes: 32,
      fetchImpl: vi.fn(async () => responseWith(encrypt(PNG, KEY), {
        headers: { "content-length": "33" },
      })),
    });
    const bodyDownloader = new ImageInputDownloader({
      maxEncryptedBytes: 16,
      fetchImpl: vi.fn(async () => responseWith(Buffer.alloc(17))),
    });

    await expect(headerDownloader.downloadAll(message)).rejects.toThrow(
      "加密文件超过允许大小",
    );
    await expect(bodyDownloader.downloadAll(message)).rejects.toThrow(
      "加密文件超过允许大小",
    );
  });

  it("enforces the decrypted-size and image-count limits", async () => {
    const fetchImpl = vi.fn(async () => responseWith(encrypt(PNG, KEY)));
    const message = imageMessage({
      aesKey: KEY.toString("base64"),
      fullUrl: "https://media.example.test/image",
    });
    const smallOutput = new ImageInputDownloader({
      fetchImpl,
      maxDecryptedBytes: 8,
    });
    const tooMany = new ImageInputDownloader({ fetchImpl, maxImages: 1 });

    await expect(smallOutput.downloadAll(message)).rejects.toThrow(
      "解密后超过允许大小",
    );
    await expect(tooMany.downloadAll({
      item_list: [...(message.item_list ?? []), ...(message.item_list ?? [])],
    })).rejects.toThrow("图片数量超过允许上限");
  });

  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [PNG, "image/png"],
    [Buffer.from("GIF89aDATA", "ascii"), "image/gif"],
    [Buffer.from("RIFF\x04\x00\x00\x00WEBPDATA", "binary"), "image/webp"],
  ])("detects image MIME from decrypted magic bytes", async (plain, mimeType) => {
    const downloader = new ImageInputDownloader({
      fetchImpl: vi.fn(async () => responseWith(encrypt(plain, KEY))),
    });

    await expect(downloader.downloadAll(imageMessage({
      aesKey: KEY.toString("base64"),
      fullUrl: "https://media.example.test/image",
    }))).resolves.toEqual([{ data: plain, mimeType }]);
  });

  it("rejects decrypted data whose magic bytes are not a supported image", async () => {
    const plain = Buffer.from("not really an image", "utf8");
    const downloader = new ImageInputDownloader({
      fetchImpl: vi.fn(async () => responseWith(encrypt(plain, KEY))),
    });

    await expect(downloader.downloadAll(imageMessage({
      aesKey: KEY.toString("base64"),
      fullUrl: "https://media.example.test/image",
    }))).rejects.toThrow("格式无效或不受支持");
  });

  it("times out even when a custom fetch implementation ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
      const downloader = new ImageInputDownloader({
        fetchImpl,
        timeoutMs: 25,
      });
      const request = downloader.downloadAll(imageMessage({
        aesKey: KEY.toString("base64"),
        fullUrl: "https://media.example.test/image?token=secret",
      }));
      const rejection = expect(request).rejects.toThrow("微信图片下载超时");

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports no downloadable image and returns an empty list when every media address is absent", async () => {
    const fetchImpl = vi.fn();
    const downloader = new ImageInputDownloader({ fetchImpl });
    const message: WeixinMessage = {
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: "hello" } },
        { type: MessageItemType.IMAGE, image_item: {} },
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: { aes_key: KEY.toString("base64") },
            thumb_media: {
              aes_key: KEY.toString("base64"),
            },
          },
        },
      ],
    };

    expect(hasDownloadableImage(message)).toBe(false);
    expect(downloader.hasDownloadableImage(message)).toBe(false);
    await expect(downloader.downloadAll(message)).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function imageMessage(params: {
  aesKey: string;
  fullUrl?: string;
  encryptQueryParam?: string;
}): WeixinMessage {
  return {
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            aes_key: params.aesKey,
            ...(params.fullUrl === undefined
              ? {}
              : { full_url: params.fullUrl }),
            ...(params.encryptQueryParam === undefined
              ? {}
              : { encrypt_query_param: params.encryptQueryParam }),
          },
        },
      },
    ],
  };
}

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function responseWith(body: Buffer, init?: ResponseInit): Response {
  return new Response(Uint8Array.from(body), init);
}
