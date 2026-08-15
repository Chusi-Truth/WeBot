import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderRegistry } from "../src/provider-registry.js";

describe("ProviderRegistry media routing", () => {
  it("does not let configured CLIProxy replace the implicit chat provider", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-provider-routing-"),
    );
    const providers = await ProviderRegistry.load({
      stateDir,
      env: {
        CLIPROXY_API_KEY: "media-key",
        DEEPSEEK_API_KEY: "chat-key",
      },
    });

    expect(providers.defaultProviderId).toBe("deepseek");
    expect(
      providers.listProviders().find((provider) => provider.id === "cliproxy"),
    ).toMatchObject({ configured: true });
  });

  it("still allows an explicit CLIProxy chat default", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-provider-routing-explicit-"),
    );
    const providers = await ProviderRegistry.load({
      stateDir,
      env: {
        CLIPROXY_API_KEY: "media-key",
        DEEPSEEK_API_KEY: "chat-key",
        WEBOT_DEFAULT_PROVIDER: "cliproxy",
      },
    });

    expect(providers.defaultProviderId).toBe("cliproxy");
  });
});
