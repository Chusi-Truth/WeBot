export interface AgentProfile {
  id: string;
  name: string;
  identity: string;
  /** Uses the provider registry default when omitted. */
  providerId?: string;
  /** Uses the selected provider's default model when omitted. */
  model?: string;
  /** Optional roleplay fields compatible with Character Card V2/V3. */
  roleplay?: AgentRoleplayProfile;
  /** Controls how the character's response is presented to the user. */
  conversationMode?: AgentConversationMode;
  /** Per-Agent policy for generating and sharing images. */
  imageBehavior?: AgentImageBehavior;
  createdAt: string;
  updatedAt: string;
}

export type AgentConversationMode = "roleplay" | "wechat";

export type AgentImageBehaviorMode = "explicit" | "natural" | "off";

export interface AgentImageBehavior {
  /** Explicit requests only, contextual natural sharing, or fully disabled. */
  mode: AgentImageBehaviorMode;
  /** @deprecated Retained as 0 for older profile compatibility; no quota applies. */
  cooldownMinutes: number;
  /** Whether an autonomous/offline task may initiate an image send. */
  allowAutonomous: boolean;
  /** Owner-authored visual continuity constraints, such as appearance. */
  visualIdentityPrompt: string;
}

/**
 * Owner-authored event that is treated as established canon while roleplay
 * mode is active. The event changes what is happening, not who controls the
 * user's dialogue, actions, thoughts, or choices.
 */
export interface AgentDirectorEvent {
  enabled: boolean;
  title?: string;
  premise?: string;
  world?: string;
}

/**
 * A complete prose work created in the private Story Book workspace. Unlike a
 * director event, this is reading/editing material and is never injected into
 * live roleplay prompts.
 */
export interface AgentStoryBookEntry {
  id: string;
  title: string;
  premise: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStoryBook {
  version: 1;
  agentId: string;
  updatedAt: string;
  stories: AgentStoryBookEntry[];
}

export interface AgentRoleplayProfile {
  personality?: string;
  scenario?: string;
  /**
   * Owner-authored presentation rules used only while conversationMode is
   * "roleplay". This controls prose style without changing character facts.
   */
  stylePrompt?: string;
  /**
   * Owner-authored prose samples used only as style references in roleplay
   * mode. Their events and facts are never treated as current canon.
   */
  writingStyleExamples?: string[];
  /** A console-controlled event that the character must enter when enabled. */
  directorEvent?: AgentDirectorEvent;
  firstMessage?: string;
  exampleMessages?: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  alternateGreetings?: string[];
  tags?: string[];
  creator?: string;
  characterVersion?: string;
  creatorNotes?: string;
  nickname?: string;
  lorebook?: CharacterLorebook;
  /**
   * Opaque Character Card data preserved across import, editing, and export.
   * It is never included in model-editable persona payloads.
   */
  characterCardExtensions?: Record<string, unknown>;
}

export interface CharacterLorebook {
  name?: string;
  description?: string;
  scanDepth?: number;
  tokenBudget?: number;
  recursiveScanning?: boolean;
  entries: CharacterLorebookEntry[];
}

export interface CharacterLorebookEntry {
  id?: number;
  name?: string;
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  enabled: boolean;
  constant?: boolean;
  selective?: boolean;
  caseSensitive?: boolean;
  priority?: number;
  insertionOrder: number;
  position?: "before_char" | "after_char";
}

export interface UserAgentRegistry {
  version: 1;
  /** Stored only in the private state directory for local administration. */
  userId?: string;
  activeAgentId: string;
  agents: AgentProfile[];
}

export interface AgentUserSummary {
  userId: string;
  activeAgentId: string;
  agentCount: number;
}

export type AgentMemoryRole = "user" | "assistant";

export interface AgentMemoryMessage {
  /** Stable within the local archive. Legacy v1/v2 records may omit it. */
  id?: string;
  role: AgentMemoryRole;
  content: string;
  createdAt: string;
  /**
   * Presentation mode active when this turn was generated.
   * Older records omit it and are treated as cross-mode context.
   */
  conversationMode?: AgentConversationMode;
}

export interface AgentMemory {
  version: 1 | 2 | 3;
  agentId: string;
  updatedAt: string;
  messages: AgentMemoryMessage[];
  /** LLM-curated record of messages that have rolled out of the working window. */
  summary?: string;
  /** Durable facts selected by the memory curator. */
  facts?: AgentMemoryFact[];
  /** Important shared events and relationship changes selected by the curator. */
  episodes?: AgentMemoryEpisode[];
  archivedMessageCount?: number;
  /** Total raw messages written to the append-only history archive. */
  totalMessageCount?: number;
  compressionCount?: number;
  lastCompressionAt?: string;
}

export interface AgentMemoryFact {
  id: string;
  key: string;
  value: string;
  source: string;
  updatedAt: string;
}

export interface AgentMemoryEpisode {
  id: string;
  /**
   * Stable merge identity for this event. Legacy records omit it and fall back
   * to their normalized (punctuation-preserving) title.
   */
  sourceKey?: string;
  title: string;
  content: string;
  importance: 1 | 2 | 3 | 4 | 5;
  /** Exact archived message chosen as the event's chronological anchor. */
  sourceMessageId?: string;
  /** Zero-based position of that message in the frozen history snapshot. */
  sourceOrder?: number;
  /** Time of the anchored message, or a conservative batch-level fallback. */
  occurredAt?: string;
  /** Distinguishes an exact message anchor from a batch-level fallback. */
  occurrencePrecision?: "message" | "batch";
  updatedAt: string;
}

export interface AgentMemoryArchivedEpisode extends AgentMemoryEpisode {
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  compressionSequences: number[];
  currentlyActive: boolean;
  reconstructed: boolean;
  migratedBaseline: boolean;
}

export type AgentMemoryMajorEventStatus =
  | "ongoing"
  | "resolved"
  | "uncertain";

export interface AgentMemoryMajorEvent {
  id: string;
  sourceKey: string;
  title: string;
  summary: string;
  importance: 1 | 2 | 3 | 4 | 5;
  status: AgentMemoryMajorEventStatus;
  /** References AgentMemoryEpisode.sourceKey without copying detail text. */
  detailKeys: string[];
  updatedAt: string;
}

export interface AgentMemoryArchivedMajorEvent
  extends AgentMemoryMajorEvent {
  details: AgentMemoryArchivedEpisode[];
  currentlyActive: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  firstSourceOrder?: number;
  lastSourceOrder?: number;
  firstOccurredAt?: string;
  lastOccurredAt?: string;
}

export interface AgentMemoryMajorEventIndex {
  version: 1;
  agentId: string;
  generatedAt: string;
  inputFingerprint: string;
  /** Fingerprint of the active prompt subset, used to reject stale groups. */
  activeInputFingerprint?: string;
  sourceEpisodeCount: number;
  groups: AgentMemoryMajorEvent[];
}

export interface AgentMemoryEpisodeRebuildSnapshot {
  version: 1;
  agentId: string;
  createdAt: string;
  sourceMessageCount: number;
  sourceStartedAt?: string;
  sourceEndedAt?: string;
  episodes: AgentMemoryEpisode[];
}

export interface AgentMemoryEpisodeExtractionRequest {
  userId: string;
  agent: AgentProfile;
  messages: Array<AgentMemoryMessage & {
    /** Trusted ordinal supplied by the rebuild coordinator, never the model. */
    sourceOrder?: number;
  }>;
}

export type AgentMemoryEpisodeExtractor = (
  request: AgentMemoryEpisodeExtractionRequest,
) => Promise<
  Array<{
    /** Stable event identity when the extractor can preserve one. */
    sourceKey?: string;
    /** Must reference one of the supplied conversation message IDs. */
    sourceMessageId?: string;
    title: string;
    content: string;
    importance: 1 | 2 | 3 | 4 | 5;
  }>
>;

export interface AgentMemoryEpisodeOrganizationRequest {
  userId: string;
  agent: AgentProfile;
  episodes: Array<{
    sourceKey: string;
    title: string;
    content: string;
    importance: 1 | 2 | 3 | 4 | 5;
    sourceMessageId?: string;
    sourceOrder?: number;
    occurredAt?: string;
    occurrencePrecision?: "message" | "batch";
    updatedAt: string;
  }>;
  /** Size of the frozen history snapshot used for chronology validation. */
  sourceMessageCount?: number;
  previousMajorEvents: AgentMemoryMajorEvent[];
}

export interface AgentMemoryMajorEventDraft {
  sourceKey?: string;
  title: string;
  summary: string;
  importance: 1 | 2 | 3 | 4 | 5;
  status: AgentMemoryMajorEventStatus;
  detailKeys: string[];
}

export type AgentMemoryEpisodeOrganizer = (
  request: AgentMemoryEpisodeOrganizationRequest,
) => Promise<AgentMemoryMajorEventDraft[]>;

export interface AgentMemoryContext {
  messages: AgentMemoryMessage[];
  summary: string;
  facts: AgentMemoryFact[];
  episodes: AgentMemoryEpisode[];
  /** Optional for callers that construct legacy contexts in tests/integrations. */
  majorEvents?: AgentMemoryMajorEvent[];
  archivedMessageCount: number;
  totalMessageCount: number;
  compressionCount: number;
  lastCompressionAt?: string;
}

/** Immutable audit snapshot written for each successful memory compression. */
export interface AgentMemorySummarySnapshot {
  version: 1;
  agentId: string;
  sequence: number;
  createdAt: string;
  compressedMessageCount: number;
  archivedMessageCount: number;
  compressedMessageIds: string[];
  sourceStartedAt?: string;
  sourceEndedAt?: string;
  summary: string;
  facts: AgentMemoryFact[];
  episodes: AgentMemoryEpisode[];
  /** Existing installations can only recover their latest pre-upgrade state. */
  migratedBaseline?: boolean;
}

export interface AgentMemoryCompressionCandidate {
  messages: Array<AgentMemoryMessage & { id: string }>;
  previousSummary: string;
  previousFacts: AgentMemoryFact[];
  previousEpisodes: AgentMemoryEpisode[];
}

export interface AgentMemoryCompressionResult {
  summary: string;
  facts: Array<{ key: string; value: string }>;
  episodes: Array<{
    /**
     * Stable identity supplied by the curator. Reuse it to correct an event;
     * use a new value for a different event, even when titles are identical.
     */
    sourceKey?: string;
    sourceMessageId?: string;
    sourceOrder?: number;
    occurredAt?: string;
    occurrencePrecision?: "message" | "batch";
    title: string;
    content: string;
    importance: 1 | 2 | 3 | 4 | 5;
  }>;
}

export interface AgentMemoryCompressionRequest
  extends AgentMemoryCompressionCandidate {
  userId: string;
  agent: AgentProfile;
}

export type AgentMemoryCompressor = (
  request: AgentMemoryCompressionRequest,
) => Promise<AgentMemoryCompressionResult>;

export interface AgentExecutionContext {
  userId: string;
  agent: AgentProfile;
  /** Trusted runtime capability metadata; never loaded from a character card. */
  reminderCapability?: {
    timeZone: string;
  };
  /** Trusted wall-clock context for WeChat continuity and message intervals. */
  chatTime?: {
    timeZone: string;
    currentTime: string;
    currentMessageTime: string;
  };
  /** Trusted runtime capability; never sourced from character/user content. */
  imageOutputCapability?: {
    maxImagesPerReply: number;
    canGenerateImages?: boolean;
  };
  /** Bounded, non-instructional observations of images attached this turn. */
  imageObservations?: readonly string[];
  /** Trusted runtime sink; never rendered into prompts or persisted. */
  acceptGeneratedImage?: (image: import("./types.js").GeneratedImageAttachment) => void;
  /** Generation captured before loading private context for race-safe tracing. */
  promptTraceGeneration?: number;
  memory: readonly AgentMemoryMessage[];
  memorySummary?: string;
  memoryFacts?: readonly AgentMemoryFact[];
  memoryEpisodes?: readonly AgentMemoryEpisode[];
  memoryMajorEvents?: readonly AgentMemoryMajorEvent[];
  autonomousEvents?: readonly AgentAutonomyEvent[];
  relevantLore?: readonly CharacterLorebookEntry[];
  input: string;
}

export type AgentAutonomyContactStatus =
  | "not_requested"
  | "pending"
  | "attempted"
  | "failed";

export type AgentAutonomyImageStatus =
  | "not_requested"
  | "pending"
  | "delivered"
  | "failed"
  | "skipped";

export type AgentAutonomyEventKind =
  | "goal_progress"
  | "discovery"
  | "decision"
  | "social"
  | "friction"
  | "opportunity"
  | "perspective_shift";

export interface AgentAutonomyEvent {
  id: string;
  createdAt: string;
  summary: string;
  mood: string;
  /** Optional for backward compatibility with previously stored events. */
  eventKind?: AgentAutonomyEventKind;
  /** A concrete topic this event makes worth discussing later. */
  conversationHook?: string;
  /** How naturally this event can support a real follow-up conversation. */
  conversationValue?: 1 | 2 | 3 | 4 | 5;
  /** An unresolved choice, consequence, or next step that later events may continue. */
  openThread?: string;
  /** Existing autonomous event continued by this one. */
  continuationOf?: string;
  importance: 1 | 2 | 3 | 4 | 5;
  shouldContactUser: boolean;
  contactReason?: string;
  message?: string;
  contactStatus: AgentAutonomyContactStatus;
  contactAttemptedAt?: string;
  contactError?: string;
  /** Optional image that may accompany a genuinely justified proactive DM. */
  imagePrompt?: string;
  imageIncludesAgent?: boolean;
  imageStatus?: AgentAutonomyImageStatus;
  imageAttemptedAt?: string;
  imageError?: string;
}

export interface AgentAutonomyAdminEvent {
  id: string;
  createdAt: string;
  summary: string;
  mood: string;
  eventKind?: AgentAutonomyEventKind;
  conversationHook?: string;
  conversationValue?: 1 | 2 | 3 | 4 | 5;
  openThread?: string;
  continuationOf?: string;
  importance: 1 | 2 | 3 | 4 | 5;
  shouldContactUser: boolean;
  contactReason?: string;
  message?: string;
  contactStatus: AgentAutonomyContactStatus;
  contactAttemptedAt?: string;
  imagePrompt?: string;
  imageIncludesAgent?: boolean;
  imageStatus?: AgentAutonomyImageStatus;
  imageAttemptedAt?: string;
}

export interface AgentAutonomyAdminSnapshot {
  enabled: boolean;
  enabledAt?: string;
  lastEvaluatedAt?: string;
  lastGeneratedAt?: string;
  lastContactAttemptAt?: string;
  lastInteractionAt?: string;
  contactAvailable: boolean;
  eventCount: number;
  events: AgentAutonomyAdminEvent[];
}

export interface AgentAutonomyAdminRuntime {
  getAdminSnapshot(
    userId: string,
    agentId: string,
    count?: number,
  ): Promise<AgentAutonomyAdminSnapshot>;
  setAdminEnabled(
    userId: string,
    agentId: string,
    enabled: boolean,
  ): Promise<AgentAutonomyAdminSnapshot>;
  generateAdminEvent(
    userId: string,
    agentId: string,
  ): Promise<AgentAutonomyAdminEvent | null>;
}

export interface AgentAutonomyGenerationRequest {
  userId: string;
  agent: AgentProfile;
  memory: AgentMemoryContext;
  previousEvents: readonly AgentAutonomyEvent[];
  currentTime: string;
  timeZone?: string;
  inactiveHours: number;
  /** Scheduled evaluation may decline to invent a low-value diary entry. */
  allowNoEvent?: boolean;
}

export interface AgentAutonomyGeneratedEvent {
  outcome?: "event";
  summary: string;
  mood: string;
  eventKind?: AgentAutonomyEventKind;
  conversationHook?: string;
  conversationValue?: 1 | 2 | 3 | 4 | 5;
  openThread?: string;
  continuationOf?: string;
  importance: 1 | 2 | 3 | 4 | 5;
  shouldContactUser: boolean;
  contactReason?: string;
  message?: string;
  imagePrompt?: string;
  imageIncludesAgent?: boolean;
}

export interface AgentAutonomyNoEvent {
  outcome: "none";
  reason?: string;
}

export type AgentAutonomyGenerationResult =
  | AgentAutonomyGeneratedEvent
  | AgentAutonomyNoEvent;

export type AgentAutonomyGenerator = (
  request: AgentAutonomyGenerationRequest,
) => Promise<AgentAutonomyGenerationResult>;

export interface AgentAutonomyRuntime {
  getRecentEvents(
    userId: string,
    agentId: string,
    count?: number,
  ): Promise<AgentAutonomyEvent[]>;
  handleCommand(userId: string, commandLine: string): Promise<string>;
}

export type AgentExecutor = (
  context: AgentExecutionContext,
) => Promise<string> | string;
