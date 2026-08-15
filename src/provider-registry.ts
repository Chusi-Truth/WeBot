import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  isEnvironmentName,
  ProviderSecretStore,
} from "./provider-secrets.js";
import type {
  ProviderAdminSummary,
  ProviderCatalog,
  ProviderConfigFile,
  ProviderDefinition,
  ProviderSummary,
} from "./provider-types.js";

const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  {
    id: "echo",
    label: "本地回声（无需 API）",
    api: "echo",
  },
  {
    id: "openai",
    label: "OpenAI",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-terra",
    apiKeyEnv: "OPENAI_API_KEY",
    timeoutMs: 90_000,
    maxOutputTokens: 2_000,
    reasoningEffort: "low",
    textVerbosity: "low",
    toolCalling: "native",
  },
  {
    id: "cliproxy",
    label: "Codex（本机 CLIProxyAPI）",
    api: "openai-responses",
    // CLIProxy is an independent media route by default. Configuring its key
    // must not silently move existing persona conversations off DeepSeek.
    autoSelect: false,
    baseUrl: "http://127.0.0.1:8317/v1",
    model: "gpt-5.6-sol",
    visionModel: "gpt-5.6-sol",
    imageGenerationModel: "gpt-image-2",
    apiKeyEnv: "CLIPROXY_API_KEY",
    timeoutMs: 180_000,
    maxOutputTokens: 4_000,
    reasoningEffort: "medium",
    textVerbosity: "low",
    toolCalling: "native",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    api: "chat-completions",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    userIdField: "user_id",
    timeoutMs: 90_000,
    personaMaxOutputTokens: 32_000,
    personaThinkingMode: "enabled",
    jsonResponseFormat: "json_object",
    toolCalling: "native",
  },
];

export interface ProviderRegistryOptions {
  stateDir: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export class ProviderRegistry implements ProviderCatalog {
  readonly defaultProviderId: string;
  private readonly providers: Map<string, ProviderDefinition>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly secretStore: ProviderSecretStore;
  private storedSecrets: Record<string, string>;
  readonly fetchImpl: typeof fetch;

  private constructor(params: {
    providers: ProviderDefinition[];
    defaultProviderId: string;
    env: NodeJS.ProcessEnv;
    fetchImpl: typeof fetch;
    secretStore: ProviderSecretStore;
    storedSecrets: Record<string, string>;
  }) {
    this.providers = new Map(
      params.providers.map((provider) => [provider.id, provider]),
    );
    this.defaultProviderId = params.defaultProviderId;
    this.env = params.env;
    this.fetchImpl = params.fetchImpl;
    this.secretStore = params.secretStore;
    this.storedSecrets = params.storedSecrets;
  }

  static async load(
    options: ProviderRegistryOptions,
  ): Promise<ProviderRegistry> {
    const env = options.env ?? process.env;
    const configPath =
      options.configPath ??
      env.WEBOT_PROVIDERS_FILE?.trim() ??
      path.join(options.stateDir, "providers.json");
    const fileConfig = await readConfigFile(configPath);
    const secretStore = new ProviderSecretStore(options.stateDir);
    const storedSecrets = await secretStore.load();
    const merged = mergeProviders(
      BUILTIN_PROVIDERS,
      fileConfig.providers ?? [],
    );
    const requestedDefault =
      env.WEBOT_DEFAULT_PROVIDER?.trim() ||
      fileConfig.defaultProvider?.trim() ||
      chooseConfiguredDefault(merged, env, storedSecrets);
    const defaultProviderId = merged.some(
      (provider) => provider.id === requestedDefault,
    )
      ? requestedDefault
      : "echo";

    return new ProviderRegistry({
      providers: merged,
      defaultProviderId,
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      secretStore,
      storedSecrets,
    });
  }

  listProviders(): ProviderSummary[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      label: provider.label,
      api: provider.api,
      ...(provider.model ? { model: provider.model } : {}),
      ...(provider.visionModel
        ? { visionModel: provider.visionModel }
        : {}),
      ...(provider.imageGenerationModel
        ? { imageGenerationModel: provider.imageGenerationModel }
        : {}),
      configured: this.isConfigured(provider),
    }));
  }

  listProvidersForAdmin(): ProviderAdminSummary[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      label: provider.label,
      api: provider.api,
      ...(provider.model ? { model: provider.model } : {}),
      ...(provider.visionModel
        ? { visionModel: provider.visionModel }
        : {}),
      ...(provider.imageGenerationModel
        ? { imageGenerationModel: provider.imageGenerationModel }
        : {}),
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
      configured: this.isConfigured(provider),
      keySource: this.keySource(provider),
    }));
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  resolve(
    providerId?: string,
    modelOverride?: string,
  ): {
    definition: ProviderDefinition;
    model?: string;
    apiKey?: string;
  } {
    const id = providerId?.trim() || this.defaultProviderId;
    const definition = this.providers.get(id);
    if (!definition) throw new Error(`没有配置 Provider“${id}”。`);
    const apiKey = definition.apiKeyEnv
      ? this.env[definition.apiKeyEnv]?.trim() ||
        this.storedSecrets[definition.apiKeyEnv]
      : undefined;
    if (definition.api !== "echo" && !apiKey) {
      throw new Error(
        `Provider“${id}”缺少环境变量 ${definition.apiKeyEnv ?? "API Key"}。`,
      );
    }
    const model = modelOverride?.trim() || definition.model;
    if (definition.api !== "echo" && !model) {
      throw new Error(`Provider“${id}”没有配置模型。`);
    }
    return {
      definition,
      ...(model ? { model } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }

  async setApiKey(environmentName: string, value: string): Promise<void> {
    if (!isEnvironmentName(environmentName)) {
      throw new Error("API Key 环境变量名无效。");
    }
    if (
      ![...this.providers.values()].some(
        (provider) => provider.apiKeyEnv === environmentName,
      )
    ) {
      throw new Error(`没有 Provider 使用 ${environmentName}。`);
    }
    const key = value.trim();
    if (!key) throw new Error("API Key 不能为空。");
    this.storedSecrets = {
      ...this.storedSecrets,
      [environmentName]: key,
    };
    await this.secretStore.save(this.storedSecrets);
  }

  async clearStoredApiKey(environmentName: string): Promise<void> {
    if (!isEnvironmentName(environmentName)) {
      throw new Error("API Key 环境变量名无效。");
    }
    const next = { ...this.storedSecrets };
    delete next[environmentName];
    this.storedSecrets = next;
    await this.secretStore.save(this.storedSecrets);
  }

  private isConfigured(provider: ProviderDefinition): boolean {
    return (
      provider.api === "echo" ||
      Boolean(
        provider.apiKeyEnv &&
          (this.env[provider.apiKeyEnv]?.trim() ||
            this.storedSecrets[provider.apiKeyEnv]) &&
          provider.baseUrl &&
          provider.model,
      )
    );
  }

  private keySource(
    provider: ProviderDefinition,
  ): ProviderAdminSummary["keySource"] {
    if (!provider.apiKeyEnv) return "none";
    if (this.env[provider.apiKeyEnv]?.trim()) return "environment";
    if (this.storedSecrets[provider.apiKeyEnv]) return "stored";
    return "none";
  }
}

async function readConfigFile(filePath: string): Promise<ProviderConfigFile> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("根节点必须是 JSON 对象");
    return parsed as ProviderConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`无法读取 Provider 配置 ${filePath}: ${String(error)}`, {
      cause: error,
    });
  }
}

function mergeProviders(
  builtins: ProviderDefinition[],
  custom: ProviderDefinition[],
): ProviderDefinition[] {
  const providers = new Map<string, ProviderDefinition>();
  for (const provider of [...builtins, ...custom]) {
    validateProvider(provider);
    providers.set(provider.id, provider);
  }
  return [...providers.values()];
}

function validateProvider(provider: ProviderDefinition): void {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(provider.id)) {
    throw new Error(`Provider ID 无效：${provider.id}`);
  }
  if (!provider.label?.trim()) {
    throw new Error(`Provider“${provider.id}”缺少 label。`);
  }
  if (
    provider.api !== "echo" &&
    provider.api !== "openai-responses" &&
    provider.api !== "chat-completions"
  ) {
    throw new Error(`Provider“${provider.id}”的 api 类型无效。`);
  }
  if (provider.api !== "echo" && !provider.baseUrl) {
    throw new Error(`Provider“${provider.id}”缺少 baseUrl。`);
  }
  if (provider.api !== "echo" && !provider.apiKeyEnv) {
    throw new Error(`Provider“${provider.id}”缺少 apiKeyEnv。`);
  }
  if (
    provider.autoSelect !== undefined &&
    typeof provider.autoSelect !== "boolean"
  ) {
    throw new Error(`Provider“${provider.id}”的 autoSelect 必须是布尔值。`);
  }
  for (const [field, value] of [
    ["visionModel", provider.visionModel],
    ["imageGenerationModel", provider.imageGenerationModel],
  ] as const) {
    if (
      value !== undefined &&
      (!value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value))
    ) {
      throw new Error(`Provider“${provider.id}”的 ${field} 无效。`);
    }
  }
  if (
    provider.personaMaxOutputTokens !== undefined &&
    (provider.api !== "chat-completions" ||
      !Number.isInteger(provider.personaMaxOutputTokens) ||
      provider.personaMaxOutputTokens < 1_000 ||
      provider.personaMaxOutputTokens > 128_000)
  ) {
    throw new Error(
      `Provider“${provider.id}”的 personaMaxOutputTokens 仅支持 chat-completions，且必须是 1000–128000 的整数。`,
    );
  }
  if (
    provider.personaThinkingMode !== undefined &&
    (provider.api !== "chat-completions" ||
      (provider.personaThinkingMode !== "enabled" &&
        provider.personaThinkingMode !== "disabled"))
  ) {
    throw new Error(
      `Provider“${provider.id}”的 personaThinkingMode 仅支持 chat-completions 的 enabled 或 disabled。`,
    );
  }
  if (
    provider.jsonResponseFormat !== undefined &&
    (provider.api !== "chat-completions" ||
      provider.jsonResponseFormat !== "json_object")
  ) {
    throw new Error(
      `Provider“${provider.id}”的 jsonResponseFormat 仅支持 chat-completions 的 json_object。`,
    );
  }
  if (
    provider.toolCalling !== undefined &&
    provider.toolCalling !== "none" &&
    provider.toolCalling !== "native"
  ) {
    throw new Error(
      `Provider“${provider.id}”的 toolCalling 只能是 none 或 native。`,
    );
  }
}

function chooseConfiguredDefault(
  providers: ProviderDefinition[],
  env: NodeJS.ProcessEnv,
  storedSecrets: Record<string, string>,
): string {
  return (
    providers.find(
      (provider) =>
        provider.api !== "echo" &&
        provider.autoSelect !== false &&
        provider.apiKeyEnv &&
        (env[provider.apiKeyEnv]?.trim() ||
          storedSecrets[provider.apiKeyEnv]),
    )?.id ?? "echo"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
