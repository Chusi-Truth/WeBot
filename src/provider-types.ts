import type { AgentExecutor } from "./agent-types.js";

export type ProviderApi = "echo" | "openai-responses" | "chat-completions";

export interface ProviderDefinition {
  id: string;
  label: string;
  api: ProviderApi;
  /** Whether this provider may become the implicit chat default when configured. */
  autoSelect?: boolean;
  baseUrl?: string;
  model?: string;
  /** Optional model used to turn inbound images into bounded observations. */
  visionModel?: string;
  /** Optional model exposed through the guarded image-generation tool. */
  imageGenerationModel?: string;
  apiKeyEnv?: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  timeoutMs?: number;
  /** Approximate maximum input tokens used by PromptCompiler. */
  inputTokenBudget?: number;
  maxOutputTokens?: number;
  /** Bounded application ceiling used only by PersonaAssistant retries. */
  personaMaxOutputTokens?: number;
  /** Selects provider-side thinking specifically for PersonaAssistant. */
  personaThinkingMode?: "enabled" | "disabled";
  temperature?: number;
  userIdField?: "user" | "user_id" | "none";
  /** Optional Chat Completions JSON response capability. */
  jsonResponseFormat?: "json_object";
  /** Enables native function/tool calling for providers that support it. */
  toolCalling?: "none" | "native";
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  textVerbosity?: "low" | "medium" | "high";
  headers?: Record<string, string>;
}

export interface ProviderConfigFile {
  defaultProvider?: string;
  providers?: ProviderDefinition[];
}

export interface ProviderSummary {
  id: string;
  label: string;
  api: ProviderApi;
  model?: string;
  visionModel?: string;
  imageGenerationModel?: string;
  configured: boolean;
}

export interface ProviderAdminSummary extends ProviderSummary {
  baseUrl?: string;
  apiKeyEnv?: string;
  keySource: "environment" | "stored" | "none";
}

export interface ProviderCatalog {
  readonly defaultProviderId: string;
  listProviders(): ProviderSummary[];
  hasProvider(id: string): boolean;
}

export type LlmExecutor = AgentExecutor;
