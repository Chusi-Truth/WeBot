import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createPinnedLookup,
  ImageMediaSender,
  SafeImageDownloader,
} from "../src/image-media.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
]);

describe("SafeImageDownloader", () => {
  it("blocks a hostname resolving to a private address before transport", async () => {
    const transport = vi.fn();
    const downloader = new SafeImageDownloader({
      resolver: vi.fn().mockResolvedValue([
        { address: "127.0.0.1", family: 4 as const },
      ]),
      transport,
    });

    await expect(
      downloader.download("https://images.example.test/private.png"),
    ).rejects.toThrow("公网地址");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["NAT64 well-known", "64:ff9b::7f00:1"],
    ["NAT64 local-use", "64:ff9b:1::7f00:1"],
    ["6to4", "2002:7f00:1::"],
    ["deprecated site-local", "fec0::1"],
  ])("blocks %s IPv6 addresses before transport", async (_kind, address) => {
    const transport = vi.fn();
    const downloader = new SafeImageDownloader({
      resolver: vi.fn().mockResolvedValue([
        { address, family: 6 as const },
      ]),
      transport,
    });

    await expect(
      downloader.download("https://images.example.test/private.png"),
    ).rejects.toThrow("公网地址");
    expect(transport).not.toHaveBeenCalled();
  });

  it("revalidates a redirect target and never follows it into link-local metadata", async () => {
    const resolver = vi.fn(async (hostname: string) =>
      hostname === "images.example.test"
        ? [{ address: "8.8.8.8", family: 4 as const }]
        : [{ address: "169.254.169.254", family: 4 as const }]
    );
    const transport = vi.fn().mockResolvedValue({
      statusCode: 302,
      headers: {
        location: "https://metadata.example.test/latest/meta-data",
      },
      body: Buffer.alloc(0),
    });
    const downloader = new SafeImageDownloader({ resolver, transport });

    await expect(
      downloader.download("https://images.example.test/redirect.png"),
    ).rejects.toThrow("公网地址");
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe("createPinnedLookup", () => {
  it("returns an address array for the Node 22/24 all:true lookup shape", () => {
    const callback = vi.fn();
    const lookup = createPinnedLookup({
      address: "2606:4700:4700::1111",
      family: 6,
    });

    lookup("upload.example.test", { all: true }, callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(null, [
      {
        address: "2606:4700:4700::1111",
        family: 6,
      },
    ]);
  });

  it("returns one address and family for the Node 22/24 all:false lookup shape", () => {
    const callback = vi.fn();
    const lookup = createPinnedLookup({
      address: "8.8.8.8",
      family: 4,
    });

    lookup("upload.example.test", { all: false }, callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });
});

describe("ImageMediaSender", () => {
  it("encrypts the image, uploads it through a pinned CDN transport without Bot authorization, then sends its media reference", async () => {
    const getImageUploadUrl = vi.fn().mockResolvedValue({
      ret: 0,
      upload_full_url: "https://upload.example.test/image",
    });
    const sendImage = vi.fn().mockResolvedValue("image-client-id");
    const downloader = {
      download: vi.fn().mockResolvedValue({
        data: PNG_BYTES,
        mimeType: "image/png" as const,
      }),
    };
    const uploadTransport = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { "x-encrypted-param": "encrypted-cdn-reference" },
    });
    const sender = new ImageMediaSender({
      api: { getImageUploadUrl, sendImage },
      downloader,
      uploadTransport,
      uploadResolver: vi.fn().mockResolvedValue([
        { address: "8.8.8.8", family: 4 as const },
      ]),
    });

    await expect(
      sender.sendFromUrl({
        sourceUrl: "https://images.example.test/cat.png",
        toUserId: "alice@im.wechat",
        contextToken: "context-token",
      }),
    ).resolves.toBe("image-client-id");

    expect(downloader.download).toHaveBeenCalledWith(
      "https://images.example.test/cat.png",
    );
    expect(getImageUploadUrl).toHaveBeenCalledOnce();
    const uploadMetadata = getImageUploadUrl.mock.calls[0]?.[0];
    expect(uploadMetadata).toMatchObject({
      fileKey: expect.stringMatching(/^[a-f0-9]{32}$/),
      toUserId: "alice@im.wechat",
      rawSize: PNG_BYTES.byteLength,
      rawFileMd5: crypto.createHash("md5").update(PNG_BYTES).digest("hex"),
      encryptedSize: 32,
      aesKeyHex: expect.stringMatching(/^[a-f0-9]{32}$/),
    });

    expect(uploadTransport).toHaveBeenCalledOnce();
    const uploadRequest = uploadTransport.mock.calls[0]?.[0];
    expect(String(uploadRequest?.url)).toBe(
      "https://upload.example.test/image",
    );
    expect(uploadRequest?.address).toEqual({
      address: "8.8.8.8",
      family: 4,
    });
    expect(uploadRequest?.timeoutMs).toEqual(expect.any(Number));
    expect(uploadRequest).not.toHaveProperty("headers");
    const ciphertext = Buffer.from(uploadRequest?.body ?? []);
    expect(ciphertext.byteLength).toBe(32);
    expect(ciphertext.equals(PNG_BYTES)).toBe(false);
    const decipher = crypto.createDecipheriv(
      "aes-128-ecb",
      Buffer.from(String(uploadMetadata?.aesKeyHex), "hex"),
      null,
    );
    expect(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]),
    ).toEqual(PNG_BYTES);

    expect(sendImage).toHaveBeenCalledWith({
      toUserId: "alice@im.wechat",
      contextToken: "context-token",
      encryptedQueryParam: "encrypted-cdn-reference",
      aesKeyHex: uploadMetadata?.aesKeyHex,
      encryptedSize: ciphertext.byteLength,
    });
  });

  it("rejects a private CDN resolution before calling the upload transport", async () => {
    const getImageUploadUrl = vi.fn().mockResolvedValue({
      ret: 0,
      upload_full_url: "https://upload.example.test/image",
    });
    const sendImage = vi.fn();
    const uploadTransport = vi.fn();
    const sender = new ImageMediaSender({
      api: { getImageUploadUrl, sendImage },
      uploadResolver: vi.fn().mockResolvedValue([
        { address: "192.168.1.10", family: 4 as const },
      ]),
      uploadTransport,
    });

    await expect(
      sender.sendBuffer({
        data: PNG_BYTES,
        toUserId: "alice@im.wechat",
        contextToken: "context-token",
      }),
    ).rejects.toThrow("上传地址不是公网地址");

    expect(uploadTransport).not.toHaveBeenCalled();
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("bounds the end-to-end upload wall clock when each transport attempt honors timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const getImageUploadUrl = vi.fn().mockResolvedValue({
        ret: 0,
        upload_full_url: "https://upload.example.test/image",
      });
      const sendImage = vi.fn();
      const uploadTransport = vi.fn(
        ({ timeoutMs }: { timeoutMs: number }) =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              const error = new Error("transport timed out");
              error.name = "AbortError";
              reject(error);
            }, timeoutMs);
          }),
      );
      const sender = new ImageMediaSender({
        api: { getImageUploadUrl, sendImage },
        uploadResolver: vi.fn().mockResolvedValue([
          { address: "8.8.8.8", family: 4 as const },
        ]),
        uploadTransport,
        uploadTimeoutMs: 100,
      });
      const startedAt = Date.now();
      let settled = false;
      const send = sender.sendBuffer({
        data: PNG_BYTES,
        toUserId: "alice@im.wechat",
        contextToken: "context-token",
      }).finally(() => {
        settled = true;
      });
      const rejection = expect(send).rejects.toThrow("图片上传超时");

      await vi.advanceTimersByTimeAsync(99);
      expect(uploadTransport).toHaveBeenCalledTimes(3);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(Date.now() - startedAt).toBeLessThanOrEqual(100);
      expect(
        uploadTransport.mock.calls.reduce(
          (total, [request]) => total + request.timeoutMs,
          0,
        ),
      ).toBeLessThanOrEqual(100);
      expect(settled).toBe(true);
      expect(sendImage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
