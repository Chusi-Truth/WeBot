import crypto from "node:crypto";

import { MessageItemType, type CdnMedia, type WeixinMessage } from "./types.js";

const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_MAX_VOICE_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const SILK_SAMPLE_RATE = 24_000;

export interface VoiceMediaDownloaderOptions {
  cdnBaseUrl?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export class VoiceMediaDownloader {
  private readonly cdnBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: VoiceMediaDownloaderOptions = {}) {
    this.cdnBaseUrl = (options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_VOICE_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  hasDownloadableVoice(message: WeixinMessage): boolean {
    return Boolean(findVoiceMedia(message));
  }

  async downloadAsWav(message: WeixinMessage): Promise<Buffer> {
    const media = findVoiceMedia(message);
    if (!media) throw new Error("语音消息缺少可下载的媒体信息。");
    const encrypted = await this.download(media);
    const silk = decryptAesEcb(encrypted, parseAesKey(media.aes_key!));
    return silkToWav(silk);
  }

  private async download(media: CdnMedia): Promise<Buffer> {
    const url = media.full_url?.trim() || buildDownloadUrl(
      this.cdnBaseUrl,
      media.encrypt_query_param!,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`微信语音下载失败：HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (declaredLength > this.maxBytes) {
        throw new Error("微信语音文件超过允许大小。");
      }
      const value = Buffer.from(await response.arrayBuffer());
      if (value.byteLength > this.maxBytes) {
        throw new Error("微信语音文件超过允许大小。");
      }
      return value;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("微信语音下载超时。");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function findVoiceMedia(message: WeixinMessage): CdnMedia | undefined {
  for (const item of message.item_list ?? []) {
    if (item.type !== MessageItemType.VOICE || item.voice_item?.text?.trim()) {
      continue;
    }
    const media = item.voice_item?.media;
    if (
      media?.aes_key &&
      (media.full_url?.trim() || media.encrypt_query_param?.trim())
    ) {
      return media;
    }
  }
  return undefined;
}

function buildDownloadUrl(baseUrl: string, queryParam: string): string {
  return `${baseUrl}/download?encrypted_query_param=${encodeURIComponent(queryParam)}`;
}

function parseAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error("微信语音的 AES 密钥格式无效。");
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function silkToWav(silk: Buffer): Promise<Buffer> {
  const { decode } = await import("silk-wasm");
  const result = await decode(silk, SILK_SAMPLE_RATE);
  return pcmBytesToWav(result.data, SILK_SAMPLE_RATE);
}

function pcmBytesToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const output = Buffer.allocUnsafe(44 + pcm.byteLength);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(output, 44);
  return output;
}
