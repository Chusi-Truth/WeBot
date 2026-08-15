import crypto from "node:crypto";

import { encode } from "silk-wasm";
import { describe, expect, it } from "vitest";

import { MessageItemType } from "../src/types.js";
import { VoiceMediaDownloader } from "../src/voice-media.js";

describe("VoiceMediaDownloader", () => {
  it("downloads, decrypts, and converts Weixin SILK voice to WAV", async () => {
    const pcm = new Uint8Array(24_000 / 10 * 2);
    const silk = await encode(pcm, 24_000);
    const key = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(silk.data)),
      cipher.final(),
    ]);
    const downloader = new VoiceMediaDownloader({
      fetchImpl: async () => new Response(encrypted),
    });
    const message = {
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: {
            media: {
              aes_key: key.toString("base64"),
              full_url: "https://example.com/voice",
            },
          },
        },
      ],
    };

    expect(downloader.hasDownloadableVoice(message)).toBe(true);
    const wav = await downloader.downloadAsWav(message);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.length).toBeGreaterThan(44);
  });
});
