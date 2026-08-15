import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import type { IncomingHttpHeaders } from "node:http";

import type { ILinkApiClient } from "./api-client.js";

const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
// iLink accepts media up to 20 MiB. Keep this aligned with MediaAiService so
// an image that passed generation validation is not rejected at delivery.
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
// Generated images are commonly several MiB. A 15 second total deadline was
// split across three upload attempts, leaving roughly five seconds per try and
// causing otherwise valid images to fail on slower cloud uplinks.
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 3;
const CDN_UPLOAD_ATTEMPTS = 3;

export interface DownloadedImage {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface ImageMediaSenderLike {
  sendFromUrl(params: {
    sourceUrl: string;
    toUserId: string;
    contextToken: string;
  }): Promise<string>;
  sendBuffer?(params: {
    data: Buffer;
    toUserId: string;
    contextToken: string;
  }): Promise<string>;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface ImageTransportResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type ImageResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;
type ImageTransport = (params: {
  url: URL;
  address: ResolvedAddress;
  maxBytes: number;
  timeoutMs: number;
}) => Promise<ImageTransportResponse>;

interface CdnUploadResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
}

export type CdnUploadTransport = (params: {
  url: URL;
  address: ResolvedAddress;
  body: Buffer;
  timeoutMs: number;
}) => Promise<CdnUploadResponse>;

export interface SafeImageDownloaderOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolver?: ImageResolver;
  transport?: ImageTransport;
}

/**
 * Downloads a public HTTPS image while pinning the request to an address that
 * was checked immediately beforehand. Redirect targets are checked again.
 */
export class SafeImageDownloader {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly resolver: ImageResolver;
  private readonly transport: ImageTransport;

  constructor(options: SafeImageDownloaderOptions = {}) {
    this.maxBytes = boundedInteger(
      options.maxBytes,
      DEFAULT_MAX_IMAGE_BYTES,
      1,
      20 * 1024 * 1024,
      "maxBytes",
    );
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_DOWNLOAD_TIMEOUT_MS,
      100,
      180_000,
      "timeoutMs",
    );
    this.maxRedirects = boundedInteger(
      options.maxRedirects,
      DEFAULT_MAX_REDIRECTS,
      0,
      5,
      "maxRedirects",
    );
    this.resolver = options.resolver ?? resolveHost;
    this.transport = options.transport ?? requestPinnedHttps;
  }

  async download(sourceUrl: string): Promise<DownloadedImage> {
    let current = parsePublicImageUrl(sourceUrl);
    const deadline = Date.now() + this.timeoutMs;

    for (let redirects = 0; ; redirects += 1) {
      const addresses = await withDeadline(
        this.resolver(normalizeHostname(current.hostname)),
        deadline,
        "图片下载超时。",
      );
      if (
        !addresses.length ||
        addresses.some((entry) => !isPublicIpAddress(entry.address))
      ) {
        throw new Error("图片地址不是可访问的公网地址。");
      }
      let response: ImageTransportResponse | undefined;
      let lastTransportError: unknown;
      for (const [index, address] of addresses.entries()) {
        const remaining = remainingTime(deadline, "图片下载超时。");
        const attemptTimeoutMs = Math.max(
          1,
          Math.floor(remaining / Math.max(1, addresses.length - index)),
        );
        try {
          response = await withDeadline(
            this.transport({
              url: current,
              address,
              maxBytes: this.maxBytes,
              timeoutMs: attemptTimeoutMs,
            }),
            deadline,
            "图片下载超时。",
          );
          break;
        } catch (error) {
          lastTransportError = error;
        }
      }
      if (!response) {
        if (lastTransportError instanceof Error) throw lastTransportError;
        throw new Error("图片下载失败。");
      }

      if (isRedirect(response.statusCode)) {
        if (redirects >= this.maxRedirects) {
          throw new Error("图片链接重定向次数过多。");
        }
        const location = firstHeader(response.headers.location);
        if (!location) throw new Error("图片链接重定向缺少目标地址。");
        current = parsePublicImageUrl(new URL(location, current).toString());
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`图片下载失败：HTTP ${response.statusCode}`);
      }
      if (response.body.byteLength > this.maxBytes) {
        throw new Error("图片超过允许大小。");
      }

      const declaredLength = Number(firstHeader(response.headers["content-length"]));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
        throw new Error("图片超过允许大小。");
      }
      return validateImage(
        response.body,
        firstHeader(response.headers["content-type"]),
      );
    }
  }
}

export interface ImageMediaSenderOptions {
  api: Pick<ILinkApiClient, "getImageUploadUrl" | "sendImage">;
  downloader?: Pick<SafeImageDownloader, "download">;
  /** Test/custom resolver. Production uploads pin a validated public address. */
  uploadResolver?: ImageResolver;
  /** Test/custom upload transport. */
  uploadTransport?: CdnUploadTransport;
  cdnBaseUrl?: string;
  uploadTimeoutMs?: number;
  maxBytes?: number;
}

export class ImageMediaSender implements ImageMediaSenderLike {
  private readonly api: ImageMediaSenderOptions["api"];
  private readonly downloader: Pick<SafeImageDownloader, "download">;
  private readonly uploadResolver: ImageResolver;
  private readonly uploadTransport: CdnUploadTransport;
  private readonly cdnBaseUrl: string;
  private readonly uploadTimeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: ImageMediaSenderOptions) {
    this.api = options.api;
    this.maxBytes = boundedInteger(
      options.maxBytes,
      DEFAULT_MAX_IMAGE_BYTES,
      1,
      20 * 1024 * 1024,
      "maxBytes",
    );
    this.downloader =
      options.downloader ??
      new SafeImageDownloader({ maxBytes: this.maxBytes });
    this.uploadResolver = options.uploadResolver ?? resolveHost;
    this.uploadTransport =
      options.uploadTransport ?? requestPinnedCdnUpload;
    this.cdnBaseUrl = (options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).replace(
      /\/+$/u,
      "",
    );
    this.uploadTimeoutMs = boundedInteger(
      options.uploadTimeoutMs,
      DEFAULT_UPLOAD_TIMEOUT_MS,
      100,
      60_000,
      "uploadTimeoutMs",
    );
  }

  async sendFromUrl(params: {
    sourceUrl: string;
    toUserId: string;
    contextToken: string;
  }): Promise<string> {
    const image = await this.downloader.download(params.sourceUrl);
    return this.sendBuffer({
      data: image.data,
      toUserId: params.toUserId,
      contextToken: params.contextToken,
    });
  }

  async sendBuffer(params: {
    data: Buffer;
    toUserId: string;
    contextToken: string;
  }): Promise<string> {
    if (params.data.byteLength > this.maxBytes) {
      throw new Error("图片超过允许大小。");
    }
    validateImage(params.data);
    const fileKey = crypto.randomBytes(16).toString("hex");
    const aesKey = crypto.randomBytes(16);
    const aesKeyHex = aesKey.toString("hex");
    const encrypted = encryptAesEcb(params.data, aesKey);
    const upload = await this.api.getImageUploadUrl({
      fileKey,
      toUserId: params.toUserId,
      rawSize: params.data.byteLength,
      rawFileMd5: crypto.createHash("md5").update(params.data).digest("hex"),
      encryptedSize: encrypted.byteLength,
      aesKeyHex,
    });
    const uploadUrl = resolveUploadUrl(upload, this.cdnBaseUrl, fileKey);
    const encryptedQueryParam = await this.uploadCiphertext(
      uploadUrl,
      encrypted,
    );
    return this.api.sendImage({
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      encryptedQueryParam,
      aesKeyHex,
      encryptedSize: encrypted.byteLength,
    });
  }

  private async uploadCiphertext(
    uploadUrl: URL,
    encrypted: Buffer,
  ): Promise<string> {
    const deadline = Date.now() + this.uploadTimeoutMs;
    const addresses = await withDeadline(
      this.uploadResolver(normalizeHostname(uploadUrl.hostname)),
      deadline,
      "微信图片上传超时。",
    );
    if (
      !addresses.length ||
      addresses.some((entry) => !isPublicIpAddress(entry.address))
    ) {
      throw new Error("微信返回的图片上传地址不是公网地址。");
    }
    const address = addresses[0]!;
    let lastError: unknown;
    for (let attempt = 1; attempt <= CDN_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        const remaining = remainingTime(
          deadline,
          "微信图片上传超时。",
        );
        const attemptTimeoutMs = Math.max(
          1,
          Math.floor(
            remaining / (CDN_UPLOAD_ATTEMPTS - attempt + 1),
          ),
        );
        const response = await withDeadline(
          this.uploadTransport({
            url: uploadUrl,
            address: addresses[(attempt - 1) % addresses.length] ?? address,
            body: encrypted,
            timeoutMs: attemptTimeoutMs,
          }),
          deadline,
          "微信图片上传超时。",
        );
        if (response.statusCode >= 400 && response.statusCode < 500) {
          throw new NonRetryableUploadError(
            `微信图片上传被拒绝：HTTP ${response.statusCode}`,
          );
        }
        if (response.statusCode !== 200) {
          throw new Error(
            `微信图片上传失败：HTTP ${response.statusCode}`,
          );
        }
        const encryptedQueryParam = firstHeader(
          response.headers["x-encrypted-param"],
        )?.trim();
        if (!encryptedQueryParam) {
          throw new Error("微信图片上传响应缺少媒体凭证。");
        }
        return encryptedQueryParam;
      } catch (error) {
        if (error instanceof NonRetryableUploadError) throw error;
        lastError = error;
      }
    }
    if (
      lastError instanceof Error &&
      (lastError.name === "AbortError" ||
        lastError.message.includes("超时"))
    ) {
      throw new Error("微信图片上传超时。");
    }
    throw new Error("微信图片上传失败，请稍后再试。");
  }
}

class NonRetryableUploadError extends Error {}

function resolveUploadUrl(
  response: {
    upload_full_url?: string;
    upload_param?: string;
  },
  cdnBaseUrl: string,
  fileKey: string,
): URL {
  const value = response.upload_full_url?.trim() ||
    (response.upload_param
      ? `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(
          response.upload_param,
        )}&filekey=${encodeURIComponent(fileKey)}`
      : "");
  if (!value) throw new Error("微信没有返回图片上传地址。");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("微信返回了无效的图片上传地址。");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("微信返回了不安全的图片上传地址。");
  }
  return url;
}

function validateImage(
  data: Buffer,
  declaredContentType?: string,
): DownloadedImage {
  const mimeType = detectImageMime(data);
  if (!mimeType) throw new Error("链接内容不是支持的图片格式。");

  const declared = declaredContentType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    declared &&
    declared !== "application/octet-stream" &&
    declared !== mimeType
  ) {
    throw new Error("图片格式与服务器声明不一致。");
  }
  return { data, mimeType };
}

function detectImageMime(
  data: Buffer,
): DownloadedImage["mimeType"] | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

async function resolveHost(hostname: string): Promise<ResolvedAddress[]> {
  if (net.isIP(hostname)) {
    return [{
      address: hostname,
      family: net.isIPv4(hostname) ? 4 : 6,
    }];
  }
  const addresses = await dns.lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
}

function parsePublicImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("图片链接格式无效。");
  }
  const hostname = normalizeHostname(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("图片必须来自公开的 HTTPS 地址。");
  }
  return url;
}

function normalizeHostname(value: string): string {
  return value
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
}

function isPublicIpAddress(value: string): boolean {
  const address = normalizeHostname(value).split("%", 1)[0]!;
  if (net.isIPv4(address)) return isPublicIpv4(address);
  if (!net.isIPv6(address)) return false;
  const bytes = parseIpv6(address);
  if (!bytes) return false;

  if (bytes.every((byte) => byte === 0)) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return false;
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return false;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false;
  // Deprecated site-local space can still be routed by some networks.
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return false;
  if (bytes[0] === 0xff) return false;
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return false;
  }
  // Do not allow transition mechanisms that can tunnel an embedded private
  // IPv4 address past the public-address check.
  const nat64WellKnown =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  const nat64Local =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01;
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
  const teredo =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00;
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  const ipv4Translatable =
    bytes.slice(0, 8).every((byte) => byte === 0) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0x00 &&
    bytes[11] === 0x00;
  if (
    nat64WellKnown ||
    nat64Local ||
    sixToFour ||
    teredo ||
    ipv4Compatible ||
    ipv4Translatable
  ) {
    return false;
  }
  const mappedPrefix = bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (mappedPrefix) {
    return isPublicIpv4(
      `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
    );
  }
  return true;
}

function isPublicIpv4(value: string): boolean {
  const [a, b] = value.split(".").map(Number);
  if (a === undefined || b === undefined) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIpv6(value: string): number[] | null {
  const lower = value.toLowerCase();
  const doubleColon = lower.indexOf("::");
  if (doubleColon !== lower.lastIndexOf("::")) return null;
  const left = (doubleColon >= 0 ? lower.slice(0, doubleColon) : lower)
    .split(":")
    .filter(Boolean);
  const right = (doubleColon >= 0 ? lower.slice(doubleColon + 2) : "")
    .split(":")
    .filter(Boolean);
  const missing = doubleColon >= 0 ? 8 - left.length - right.length : 0;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return null;
    const word = Number.parseInt(group, 16);
    bytes.push(word >> 8, word & 0xff);
  }
  return bytes;
}

function requestPinnedHttps(params: {
  url: URL;
  address: ResolvedAddress;
  maxBytes: number;
  timeoutMs: number;
}): Promise<ImageTransportResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finishResolve = (value: ImageTransportResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const lookup = createPinnedLookup(params.address);
    const request = https.request(
      params.url,
      {
        method: "GET",
        headers: {
          Accept: "image/png,image/jpeg,image/gif,image/webp",
          "User-Agent": "WeBot-image-fetch/1.0",
        },
        lookup,
      },
      (response) => {
        const declaredLength = Number(
          firstHeader(response.headers["content-length"]),
        );
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > params.maxBytes
        ) {
          request.destroy(new Error("图片超过允许大小。"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | Uint8Array) => {
          const value = Buffer.from(chunk);
          total += value.byteLength;
          if (total > params.maxBytes) {
            request.destroy(new Error("图片超过允许大小。"));
            return;
          }
          chunks.push(value);
        });
        response.once("end", () => {
          finishResolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.once("error", finishReject);
      },
    );
    timer = setTimeout(() => {
      request.destroy(new Error("图片下载超时。"));
    }, params.timeoutMs);
    request.once("error", finishReject);
    request.end();
  });
}

function requestPinnedCdnUpload(params: {
  url: URL;
  address: ResolvedAddress;
  body: Buffer;
  timeoutMs: number;
}): Promise<CdnUploadResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finishResolve = (value: CdnUploadResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const lookup = createPinnedLookup(params.address);
    const request = https.request(
      params.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(params.body.byteLength),
        },
        lookup,
      },
      (response) => {
        let responseBytes = 0;
        response.on("data", (chunk: Buffer | Uint8Array) => {
          responseBytes += chunk.byteLength;
          if (responseBytes > 64 * 1024) {
            request.destroy(
              new Error("微信图片上传响应异常，内容过大。"),
            );
          }
        });
        response.once("end", () => {
          finishResolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
          });
        });
        response.once("error", finishReject);
      },
    );
    timer = setTimeout(() => {
      request.destroy(new Error("微信图片上传超时。"));
    }, params.timeoutMs);
    request.once("error", finishReject);
    request.end(params.body);
  });
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** @internal Exported for a native Node lookup-shape regression test. */
export function createPinnedLookup(
  address: ResolvedAddress,
): NonNullable<https.RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      const callbackAll = callback as (
        error: NodeJS.ErrnoException | null,
        addresses: Array<{ address: string; family: number }>,
      ) => void;
      callbackAll(null, [address]);
      return;
    }
    const callbackOne = callback as (
      error: NodeJS.ErrnoException | null,
      resolvedAddress: string,
      family: number,
    ) => void;
    callbackOne(null, address.address, address.family);
  };
}

function remainingTime(deadline: number, message: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(message);
  return remaining;
}

function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  message: string,
): Promise<T> {
  const timeoutMs = remainingTime(deadline, message);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return result;
}
