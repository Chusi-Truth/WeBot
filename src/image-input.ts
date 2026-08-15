import crypto from "node:crypto";

import {
  MessageItemType,
  type CdnMedia,
  type ImageItem,
  type WeixinMessage,
} from "./types.js";

const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_ENCRYPTED_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_DECRYPTED_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const AES_BLOCK_BYTES = 16;

export type InputImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export interface DownloadedInputImage {
  data: Buffer;
  mimeType: InputImageMimeType;
}

export interface ImageInputDownloaderOptions {
  cdnBaseUrl?: string;
  fetchImpl?: typeof fetch;
  maxImages?: number;
  maxEncryptedBytes?: number;
  maxDecryptedBytes?: number;
  timeoutMs?: number;
}

interface DownloadableImageMedia {
  media: CdnMedia;
  aesKey?: string;
}

interface DownloadableImage {
  candidates: DownloadableImageMedia[];
}

class ImageInputError extends Error {}

/** Downloads and decrypts image items from an inbound Weixin message. */
export class ImageInputDownloader {
  private readonly cdnBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxImages: number;
  private readonly maxEncryptedBytes: number;
  private readonly maxDecryptedBytes: number;
  private readonly timeoutMs: number;

  constructor(options: ImageInputDownloaderOptions = {}) {
    this.cdnBaseUrl = (options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).replace(
      /\/+$/u,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxImages = positiveInteger(
      options.maxImages,
      DEFAULT_MAX_IMAGES,
      "maxImages",
    );
    this.maxEncryptedBytes = positiveInteger(
      options.maxEncryptedBytes,
      DEFAULT_MAX_ENCRYPTED_BYTES,
      "maxEncryptedBytes",
    );
    this.maxDecryptedBytes = positiveInteger(
      options.maxDecryptedBytes,
      DEFAULT_MAX_DECRYPTED_BYTES,
      "maxDecryptedBytes",
    );
    this.timeoutMs = positiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
  }

  hasDownloadableImage(message: WeixinMessage): boolean {
    return hasDownloadableImage(message);
  }

  async downloadAll(message: WeixinMessage): Promise<DownloadedInputImage[]> {
    const images = findDownloadableImages(message);
    if (images.length > this.maxImages) {
      throw new ImageInputError("微信图片数量超过允许上限。");
    }

    const result: DownloadedInputImage[] = [];
    for (const image of images) {
      let downloaded: DownloadedInputImage | undefined;
      let lastError: ImageInputError | undefined;
      for (const candidate of image.candidates) {
        try {
          const key = candidate.aesKey
            ? parseAesKey(candidate.aesKey)
            : undefined;
          const payload = await this.downloadMedia(candidate.media);
          const plain = key
            ? decryptAesEcb(
                payload,
                key,
                this.maxDecryptedBytes,
              )
            : payload;
          if (plain.byteLength > this.maxDecryptedBytes) {
            throw new ImageInputError("微信图片超过允许大小。");
          }
          downloaded = validateImage(plain);
          break;
        } catch (error) {
          if (!(error instanceof ImageInputError)) throw error;
          lastError = error;
        }
      }
      if (!downloaded) {
        throw lastError ?? new ImageInputError("微信图片没有可下载的媒体信息。");
      }
      result.push(downloaded);
    }
    return result;
  }

  private async downloadMedia(media: CdnMedia): Promise<Buffer> {
    const sourceUrl = media.full_url?.trim() || buildDownloadUrl(
      this.cdnBaseUrl,
      media.encrypt_query_param!,
    );
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ImageInputError("微信图片下载超时。"));
      }, this.timeoutMs);
    });

    const operation = (async () => {
      const response = await this.fetchImpl(sourceUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ImageInputError(
          `微信图片下载失败：HTTP ${response.status}`,
        );
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > this.maxEncryptedBytes
      ) {
        throw new ImageInputError("微信图片加密文件超过允许大小。");
      }
      return readResponseBody(response, this.maxEncryptedBytes);
    })();

    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (
        timedOut ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new ImageInputError("微信图片下载超时。");
      }
      if (error instanceof ImageInputError) throw error;
      // Fetch and stream errors can contain the complete request URL. Do not
      // propagate them because its query parameter is a media credential.
      throw new ImageInputError("微信图片下载失败。");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function hasDownloadableImage(message: WeixinMessage): boolean {
  return findDownloadableImages(message).length > 0;
}

export function downloadAll(
  message: WeixinMessage,
  options: ImageInputDownloaderOptions = {},
): Promise<DownloadedInputImage[]> {
  return new ImageInputDownloader(options).downloadAll(message);
}

function findDownloadableImages(
  message: WeixinMessage,
): DownloadableImage[] {
  const result: DownloadableImage[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type !== MessageItemType.IMAGE || !item.image_item) continue;
    const image = toDownloadableImage(item.image_item);
    if (image) result.push(image);
  }
  if (result.length > 0) return result;

  // Weixin represents a quoted image as a TEXT item whose ref_msg contains
  // the original IMAGE item. Only inspect one reference level so arbitrary
  // nested message data cannot expand media processing unexpectedly.
  for (const item of message.item_list ?? []) {
    if (item.type !== MessageItemType.TEXT) continue;
    const referenced = item.ref_msg?.message_item;
    if (
      referenced?.type !== MessageItemType.IMAGE ||
      !referenced.image_item
    ) {
      continue;
    }
    const image = toDownloadableImage(referenced.image_item);
    if (image) result.push(image);
  }
  return result;
}

function toDownloadableImage(
  image: ImageItem,
): DownloadableImage | undefined {
  const candidates = [
    toDownloadableMedia(image.media, image.aeskey),
    toDownloadableMedia(image.thumb_media, image.aeskey),
  ].filter((value): value is DownloadableImageMedia => value !== undefined);
  return candidates.length > 0 ? { candidates } : undefined;
}

function toDownloadableMedia(
  media: CdnMedia | undefined,
  fallbackAesKey: string | undefined,
): DownloadableImageMedia | undefined {
  // The image-level raw hex key is the authoritative inbound representation.
  // media.aes_key remains a compatibility fallback for older payloads.
  const aesKey = fallbackAesKey?.trim() || media?.aes_key?.trim();
  if (
    !media ||
    !(media.full_url?.trim() || media.encrypt_query_param?.trim())
  ) {
    return undefined;
  }
  return aesKey ? { media, aesKey } : { media };
}

function buildDownloadUrl(baseUrl: string, queryParam: string): string {
  return `${baseUrl}/download?encrypted_query_param=${encodeURIComponent(queryParam)}`;
}

function parseAesKey(value: string): Buffer {
  const normalized = value.trim();
  if (/^[0-9a-fA-F]{32}$/u.test(normalized)) {
    return Buffer.from(normalized, "hex");
  }

  if (
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) ||
    normalized.length % 4 === 1
  ) {
    throw new ImageInputError("微信图片的 AES 密钥格式无效。");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.byteLength === AES_BLOCK_BYTES) return decoded;
  if (
    decoded.byteLength === 32 &&
    /^[0-9a-fA-F]{32}$/u.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new ImageInputError("微信图片的 AES 密钥格式无效。");
}

function decryptAesEcb(
  encrypted: Buffer,
  key: Buffer,
  maxDecryptedBytes: number,
): Buffer {
  const largestAllowedCiphertext =
    Math.floor(maxDecryptedBytes / AES_BLOCK_BYTES) * AES_BLOCK_BYTES +
    AES_BLOCK_BYTES;
  if (encrypted.byteLength > largestAllowedCiphertext) {
    throw new ImageInputError("微信图片解密后超过允许大小。");
  }

  try {
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    if (decrypted.byteLength > maxDecryptedBytes) {
      throw new ImageInputError("微信图片解密后超过允许大小。");
    }
    return decrypted;
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError("微信图片解密失败。");
  }
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new ImageInputError("微信图片加密文件超过允许大小。");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function validateImage(data: Buffer): DownloadedInputImage {
  const mimeType = detectImageMimeType(data);
  if (!mimeType) {
    throw new ImageInputError("微信图片格式无效或不受支持。");
  }
  return { data, mimeType };
}

function detectImageMimeType(data: Buffer): InputImageMimeType | undefined {
  if (
    data.byteLength >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    data.byteLength >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.byteLength >= 6 &&
    (data.subarray(0, 6).equals(Buffer.from("GIF87a", "ascii")) ||
      data.subarray(0, 6).equals(Buffer.from("GIF89a", "ascii")))
  ) {
    return "image/gif";
  }
  if (
    data.byteLength >= 12 &&
    data.subarray(0, 4).equals(Buffer.from("RIFF", "ascii")) &&
    data.subarray(8, 12).equals(Buffer.from("WEBP", "ascii"))
  ) {
    return "image/webp";
  }
  return undefined;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${name} 必须是正整数。`);
  }
  return result;
}
