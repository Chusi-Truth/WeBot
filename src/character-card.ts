import type {
  AgentDirectorEvent,
  AgentImageBehavior,
  AgentProfile,
  AgentRoleplayProfile,
  CharacterLorebook,
  CharacterLorebookEntry,
} from "./agent-types.js";

export type CharacterCardVersion = "chara_card_v2" | "chara_card_v3";

export interface CharacterCard {
  spec: CharacterCardVersion;
  spec_version: "2.0" | "3.0";
  data: Record<string, unknown> & {
    name: string;
    description: string;
  };
}

const MAX_CARD_BYTES = 512 * 1024;
const MAX_TEXT = 20_000;
const MAX_LORE_ENTRIES = 500;
const MAX_CARD_EXTENSIONS_BYTES = 256 * 1024;
const MAX_WRITING_STYLE_EXAMPLES = 20;
const MAX_WRITING_STYLE_EXAMPLE_TEXT = 8_000;
const MAX_WRITING_STYLE_EXAMPLES_TEXT = 48_000;
const MAX_DIRECTOR_EVENT_TITLE = 200;
const MAX_DIRECTOR_EVENT_TEXT = 20_000;
const MAX_VISUAL_IDENTITY_PROMPT = 8_000;
export const MIN_IMAGE_COOLDOWN_MINUTES = 0;
export const MAX_IMAGE_COOLDOWN_MINUTES = 10_080;
export const DEFAULT_AGENT_IMAGE_BEHAVIOR: Readonly<AgentImageBehavior> =
  Object.freeze({
    mode: "explicit",
    cooldownMinutes: 0,
    allowAutonomous: false,
    visualIdentityPrompt: "",
  });

export function parseCharacterCard(value: unknown): {
  name: string;
  identity: string;
  roleplay: AgentRoleplayProfile;
  imageBehavior: AgentImageBehavior;
} {
  if (!isRecord(value)) throw new Error("角色卡必须是 JSON 对象。");
  if (JSON.stringify(value).length > MAX_CARD_BYTES) {
    throw new Error("角色卡不能超过 512 KB。");
  }
  const spec = value.spec;
  if (spec !== "chara_card_v2" && spec !== "chara_card_v3") {
    throw new Error("仅支持 Character Card V2 或 V3。");
  }
  if (!isRecord(value.data)) throw new Error("角色卡缺少 data 对象。");
  const data = value.data;
  const name = requiredText(data.name, "角色名称", 80);
  const identity = optionalText(data.description, "角色描述") ||
    optionalText(data.personality, "角色性格") ||
    `你是${name}，请始终保持角色身份。`;
  const roleplay = compactObject({
    personality: optionalText(data.personality, "角色性格"),
    scenario: optionalText(data.scenario, "场景"),
    stylePrompt: parseWebotStylePrompt(data.extensions),
    writingStyleExamples: parseWebotWritingStyleExamples(data.extensions),
    firstMessage: optionalText(data.first_mes, "开场白"),
    exampleMessages: optionalText(data.mes_example, "示例对话"),
    systemPrompt: optionalText(data.system_prompt, "系统提示词"),
    postHistoryInstructions: optionalText(
      data.post_history_instructions,
      "历史后指令",
    ),
    alternateGreetings: stringArray(data.alternate_greetings, "备用开场白"),
    tags: stringArray(data.tags, "标签", 100, 80),
    creator: optionalText(data.creator, "作者", 200),
    characterVersion: optionalText(data.character_version, "角色版本", 100),
    creatorNotes: optionalText(data.creator_notes, "作者备注"),
    nickname: optionalText(data.nickname, "昵称", 80),
    lorebook: parseLorebook(data.character_book),
    characterCardExtensions: cloneCardExtensions(
      data.extensions,
      "角色卡扩展",
    ),
  }) as unknown as AgentRoleplayProfile;
  return {
    name,
    identity,
    roleplay,
    // A character card is untrusted content. Import only static preferences;
    // it must never silently opt an Agent into natural or autonomous sending.
    imageBehavior: parseWebotImageBehaviorPreferences(data.extensions),
  };
}

export function normalizeAgentImageBehavior(
  value: Partial<AgentImageBehavior> | undefined,
): AgentImageBehavior {
  if (value === undefined) return { ...DEFAULT_AGENT_IMAGE_BEHAVIOR };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("图片行为配置必须是对象。");
  }
  const mode = value.mode ?? DEFAULT_AGENT_IMAGE_BEHAVIOR.mode;
  if (mode !== "explicit" && mode !== "natural" && mode !== "off") {
    throw new Error("图片行为模式必须是 explicit、natural 或 off。");
  }
  const cooldownMinutes =
    value.cooldownMinutes ?? DEFAULT_AGENT_IMAGE_BEHAVIOR.cooldownMinutes;
  if (
    !Number.isInteger(cooldownMinutes) ||
    cooldownMinutes < MIN_IMAGE_COOLDOWN_MINUTES ||
    cooldownMinutes > MAX_IMAGE_COOLDOWN_MINUTES
  ) {
    throw new Error(
      `图片冷却时间必须是 ${MIN_IMAGE_COOLDOWN_MINUTES}–${MAX_IMAGE_COOLDOWN_MINUTES} 之间的整数分钟。`,
    );
  }
  const allowAutonomous =
    value.allowAutonomous ?? DEFAULT_AGENT_IMAGE_BEHAVIOR.allowAutonomous;
  if (typeof allowAutonomous !== "boolean") {
    throw new Error("自主发图开关必须是布尔值。");
  }
  const visualIdentityPrompt = normalizeVisualIdentityPrompt(
    value.visualIdentityPrompt,
  );
  // cooldownMinutes remains in the serialized shape only for compatibility
  // with existing profiles and older clients. It no longer limits sending.
  return { mode, cooldownMinutes: 0, allowAutonomous, visualIdentityPrompt };
}

export function normalizeRoleplayProfile(
  value: AgentRoleplayProfile | undefined,
): AgentRoleplayProfile | undefined {
  if (!value) return undefined;
  const normalized = compactObject({
    personality: optionalText(value.personality, "角色性格"),
    scenario: optionalText(value.scenario, "场景"),
    stylePrompt: optionalText(value.stylePrompt, "情景模式文风"),
    writingStyleExamples: writingStyleExamples(value.writingStyleExamples),
    directorEvent: normalizeDirectorEvent(value.directorEvent),
    firstMessage: optionalText(value.firstMessage, "开场白"),
    exampleMessages: optionalText(value.exampleMessages, "示例对话"),
    systemPrompt: optionalText(value.systemPrompt, "系统提示词"),
    postHistoryInstructions: optionalText(value.postHistoryInstructions, "历史后指令"),
    alternateGreetings: stringArray(value.alternateGreetings, "备用开场白"),
    tags: stringArray(value.tags, "标签", 100, 80),
    creator: optionalText(value.creator, "作者", 200),
    characterVersion: optionalText(value.characterVersion, "角色版本", 100),
    creatorNotes: optionalText(value.creatorNotes, "作者备注"),
    nickname: optionalText(value.nickname, "昵称", 80),
    lorebook: value.lorebook ? parseLorebook(exportLorebook(value.lorebook)) : undefined,
    characterCardExtensions: cloneCardExtensions(
      value.characterCardExtensions,
      "角色卡扩展",
    ),
  }) as AgentRoleplayProfile;
  return Object.keys(normalized).length ? normalized : undefined;
}

export function normalizeDirectorEvent(
  value: AgentDirectorEvent | undefined,
): AgentDirectorEvent | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("导演事件必须是对象。");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("导演事件的启用状态无效。");
  }
  const title = optionalText(
    value.title,
    "导演事件标题",
    MAX_DIRECTOR_EVENT_TITLE,
  );
  const premise = optionalText(
    value.premise,
    "导演事件前提",
    MAX_DIRECTOR_EVENT_TEXT,
  );
  const world = optionalText(
    value.world,
    "导演事件世界设定",
    MAX_DIRECTOR_EVENT_TEXT,
  );
  if (value.enabled && !premise) {
    throw new Error("启用导演事件前，请填写事件前提。");
  }
  if (!value.enabled && !title && !premise && !world) return undefined;
  return compactObject({
    enabled: value.enabled,
    title,
    premise,
    world,
  }) as unknown as AgentDirectorEvent;
}

export function exportCharacterCard(
  agent: AgentProfile,
  version: "2.0" | "3.0" = "3.0",
): CharacterCard {
  const roleplay = agent.roleplay ?? {};
  const data: Record<string, unknown> & { name: string; description: string } = {
    name: agent.name,
    description: agent.identity,
    personality: roleplay.personality ?? "",
    scenario: roleplay.scenario ?? "",
    first_mes: roleplay.firstMessage ?? "",
    mes_example: roleplay.exampleMessages ?? "",
    creator_notes: roleplay.creatorNotes ?? "",
    system_prompt: roleplay.systemPrompt ?? "",
    post_history_instructions: roleplay.postHistoryInstructions ?? "",
    alternate_greetings: roleplay.alternateGreetings ?? [],
    tags: roleplay.tags ?? [],
    creator: roleplay.creator ?? "",
    character_version: roleplay.characterVersion ?? "",
    extensions: exportCardExtensions(
      roleplay.characterCardExtensions,
      roleplay.stylePrompt,
      roleplay.writingStyleExamples,
      agent.imageBehavior,
    ),
  };
  if (roleplay.lorebook) data.character_book = exportLorebook(roleplay.lorebook);
  if (version === "3.0") {
    data.nickname = roleplay.nickname ?? "";
    data.group_only_greetings = [];
  }
  return {
    spec: version === "3.0" ? "chara_card_v3" : "chara_card_v2",
    spec_version: version,
    data,
  };
}

function parseWebotStylePrompt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.webot)) {
    const nested = optionalText(
      value.webot.roleplay_style_prompt,
      "WeBot 情景模式文风",
    );
    if (nested) return nested;
  }
  return optionalText(
    value.webot_roleplay_style_prompt,
    "WeBot 情景模式文风",
  );
}

function parseWebotWritingStyleExamples(
  value: unknown,
): string[] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    isRecord(value.webot) &&
    Object.hasOwn(value.webot, "writing_style_examples")
  ) {
    return writingStyleExamples(
      value.webot.writing_style_examples,
      "WeBot 写作风格示例",
    );
  }
  return writingStyleExamples(
    value.webot_writing_style_examples,
    "WeBot 写作风格示例",
  );
}

function exportCardExtensions(
  value: Record<string, unknown> | undefined,
  stylePrompt: string | undefined,
  writingStyleExamples: string[] | undefined,
  imageBehavior: AgentImageBehavior | undefined,
): Record<string, unknown> {
  const extensions = cloneCardExtensions(value, "角色卡扩展") ?? {};
  const hasConflictingWebot =
    Object.hasOwn(extensions, "webot") &&
    !isRecord(extensions.webot);
  if (hasConflictingWebot) {
    if (stylePrompt?.trim()) {
      extensions.webot_roleplay_style_prompt = stylePrompt.trim();
    } else {
      delete extensions.webot_roleplay_style_prompt;
    }
    if (writingStyleExamples?.length) {
      extensions.webot_writing_style_examples = [...writingStyleExamples];
    } else {
      delete extensions.webot_writing_style_examples;
    }
    const imagePreferences = exportImageBehaviorPreferences(imageBehavior);
    if (imagePreferences) {
      extensions.webot_image_behavior_preferences = imagePreferences;
    } else {
      delete extensions.webot_image_behavior_preferences;
    }
    return cloneCardExtensions(extensions, "角色卡扩展") ?? {};
  }
  delete extensions.webot_roleplay_style_prompt;
  delete extensions.webot_writing_style_examples;
  delete extensions.webot_image_behavior_preferences;
  const currentWebot = isRecord(extensions.webot) ? extensions.webot : {};
  const webot = { ...currentWebot };
  if (stylePrompt?.trim()) {
    webot.roleplay_style_prompt = stylePrompt.trim();
  } else {
    delete webot.roleplay_style_prompt;
  }
  if (writingStyleExamples?.length) {
    webot.writing_style_examples = [...writingStyleExamples];
  } else {
    delete webot.writing_style_examples;
  }
  const imagePreferences = exportImageBehaviorPreferences(imageBehavior);
  if (imagePreferences) {
    webot.image_behavior_preferences = imagePreferences;
  } else {
    delete webot.image_behavior_preferences;
  }
  if (Object.keys(webot).length) extensions.webot = webot;
  else if (isRecord(extensions.webot)) delete extensions.webot;
  return cloneCardExtensions(extensions, "角色卡扩展") ?? {};
}

function parseWebotImageBehaviorPreferences(value: unknown): AgentImageBehavior {
  if (!isRecord(value)) return { ...DEFAULT_AGENT_IMAGE_BEHAVIOR };
  const raw = isRecord(value.webot) &&
      Object.hasOwn(value.webot, "image_behavior_preferences")
    ? value.webot.image_behavior_preferences
    : value.webot_image_behavior_preferences;
  if (raw === undefined) return { ...DEFAULT_AGENT_IMAGE_BEHAVIOR };
  if (!isRecord(raw)) {
    throw new Error("WeBot 图片偏好必须是对象。");
  }
  const visualIdentityPrompt = raw.visual_identity_prompt === undefined
    ? ""
    : raw.visual_identity_prompt;
  // Intentionally ignore any mode/allow_autonomous fields supplied by a card.
  return normalizeAgentImageBehavior({
    mode: "explicit",
    cooldownMinutes: 0,
    allowAutonomous: false,
    visualIdentityPrompt: visualIdentityPrompt as string,
  });
}

function exportImageBehaviorPreferences(
  value: AgentImageBehavior | undefined,
): Record<string, unknown> | undefined {
  const normalized = normalizeAgentImageBehavior(value);
  const result: Record<string, unknown> = {};
  if (normalized.visualIdentityPrompt) {
    result.visual_identity_prompt = normalized.visualIdentityPrompt;
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeVisualIdentityPrompt(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new Error("视觉身份设定必须是文本。");
  }
  const normalized = value.trim();
  if (normalized.length > MAX_VISUAL_IDENTITY_PROMPT) {
    throw new Error(
      `视觉身份设定不能超过 ${MAX_VISUAL_IDENTITY_PROMPT} 个字符。`,
    );
  }
  return normalized;
}

function writingStyleExamples(
  value: unknown,
  label = "写作风格示例",
): string[] | undefined {
  const examples = stringArray(
    value,
    label,
    MAX_WRITING_STYLE_EXAMPLES,
    MAX_WRITING_STYLE_EXAMPLE_TEXT,
  );
  if (
    examples &&
    examples.reduce((total, example) => total + example.length, 0) >
      MAX_WRITING_STYLE_EXAMPLES_TEXT
  ) {
    throw new Error(
      `${label}总长度不能超过 ${MAX_WRITING_STYLE_EXAMPLES_TEXT} 个字符。`,
    );
  }
  return examples;
}

function cloneCardExtensions(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${label}必须是对象。`);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_CARD_EXTENSIONS_BYTES) {
    throw new Error(`${label}不能超过 256 KB。`);
  }
  const cloned = JSON.parse(json) as unknown;
  assertSafeExtensionValue(cloned, label);
  return cloned as Record<string, unknown>;
}

function assertSafeExtensionValue(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => assertSafeExtensionValue(item, label));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor"
    ) {
      throw new Error(`${label}包含不安全的字段。`);
    }
    assertSafeExtensionValue(item, label);
  }
}

export function selectRelevantLore(
  lorebook: CharacterLorebook | undefined,
  input: string,
  recentMessages: readonly {
    content: string;
    role?: "user" | "assistant";
  }[],
): CharacterLorebookEntry[] {
  if (!lorebook?.entries.length) return [];
  const depth = Math.max(1, lorebook.scanDepth ?? 8);
  // Assistant wording must not activate more lore on the next turn. Otherwise
  // one domain-specific phrase can feed itself back into every later prompt.
  const recentUserMessages = recentMessages
    .slice(-depth)
    .filter((item) => item.role !== "assistant")
    .map((item) => item.content);
  const haystack = [...recentUserMessages, input].join("\n");
  const candidates = lorebook.entries
    .filter((entry) => entry.enabled && (entry.constant || matchesEntry(entry, haystack)))
    .sort((a, b) => {
      const priority = (b.priority ?? 0) - (a.priority ?? 0);
      return priority || a.insertionOrder - b.insertionOrder;
    });
  const characterBudget = Math.max(200, (lorebook.tokenBudget ?? 1_024) * 4);
  const selected: CharacterLorebookEntry[] = [];
  let used = 0;
  for (const entry of candidates) {
    if (used + entry.content.length > characterBudget && selected.length) continue;
    selected.push(entry);
    used += entry.content.length;
    if (used >= characterBudget) break;
  }
  return selected;
}

export function applyCharacterTemplates(
  value: string,
  agentName: string,
  userName = "用户",
): string {
  return value
    .replaceAll("{{char}}", agentName)
    .replaceAll("<char>", agentName)
    .replaceAll("<bot>", agentName)
    .replaceAll("{{user}}", userName)
    .replaceAll("<user>", userName);
}

export interface CharacterExampleMessage {
  role: "user" | "assistant";
  content: string;
}

/** Parses common Tavern-style <START> example dialogue into real chat turns. */
export function parseCharacterExamples(
  value: string | undefined,
  agentName: string,
  userName = "用户",
): CharacterExampleMessage[] {
  if (!value?.trim()) return [];
  const messages: CharacterExampleMessage[] = [];
  let current: CharacterExampleMessage | undefined;
  const flush = () => {
    if (current?.content.trim()) {
      current.content = applyCharacterTemplates(
        current.content.trim(),
        agentName,
        userName,
      );
      messages.push(current);
    }
    current = undefined;
  };
  for (const rawLine of value.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line || /^<START>$/i.test(line)) {
      if (/^<START>$/i.test(line)) flush();
      continue;
    }
    const user = line.match(/^(?:\{\{user\}\}|<user>|user)\s*[:：]\s*(.*)$/i);
    const character = line.match(
      /^(?:\{\{char\}\}|<char>|<bot>|assistant)\s*[:：]\s*(.*)$/i,
    );
    if (user || character) {
      flush();
      current = {
        role: user ? "user" : "assistant",
        content: (user?.[1] ?? character?.[1] ?? "").trim(),
      };
      continue;
    }
    if (current) current.content += `\n${rawLine.trimEnd()}`;
  }
  flush();
  return messages.slice(0, 12);
}

function parseLorebook(value: unknown): CharacterLorebook | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("character_book 格式无效。");
  if (!Array.isArray(value.entries)) throw new Error("character_book.entries 必须是数组。");
  if (value.entries.length > MAX_LORE_ENTRIES) throw new Error("世界书条目不能超过 500 条。");
  return compactObject({
    name: optionalText(value.name, "世界书名称", 200),
    description: optionalText(value.description, "世界书描述"),
    scanDepth: optionalNumber(value.scan_depth),
    tokenBudget: optionalNumber(value.token_budget),
    recursiveScanning: optionalBoolean(value.recursive_scanning),
    entries: value.entries.map((entry, index) => parseLoreEntry(entry, index)),
  }) as CharacterLorebook;
}

function parseLoreEntry(value: unknown, index: number): CharacterLorebookEntry {
  if (!isRecord(value)) throw new Error(`世界书第 ${index + 1} 条格式无效。`);
  return compactObject({
    id: optionalNumber(value.id),
    name: optionalText(value.name ?? value.comment, "世界书条目名称", 200),
    keys: stringArray(value.keys ?? value.key, "世界书关键词", 100, 200),
    secondaryKeys: stringArray(value.secondary_keys ?? value.keysecondary, "世界书次级关键词", 100, 200),
    content: requiredText(value.content, `世界书第 ${index + 1} 条内容`),
    enabled: typeof value.enabled === "boolean" ? value.enabled : !value.disable,
    constant: optionalBoolean(value.constant),
    selective: optionalBoolean(value.selective),
    caseSensitive: optionalBoolean(value.case_sensitive),
    priority: optionalNumber(value.priority),
    insertionOrder: optionalNumber(value.insertion_order) ?? index,
    position: value.position === "before_char" || value.position === "after_char"
      ? value.position
      : undefined,
  }) as CharacterLorebookEntry;
}

function exportLorebook(book: CharacterLorebook): Record<string, unknown> {
  return {
    name: book.name,
    description: book.description,
    scan_depth: book.scanDepth,
    token_budget: book.tokenBudget,
    recursive_scanning: book.recursiveScanning,
    extensions: {},
    entries: book.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      keys: entry.keys,
      secondary_keys: entry.secondaryKeys,
      content: entry.content,
      enabled: entry.enabled,
      constant: entry.constant,
      selective: entry.selective,
      case_sensitive: entry.caseSensitive,
      priority: entry.priority,
      insertion_order: entry.insertionOrder,
      position: entry.position,
      extensions: {},
    })),
  };
}

function matchesEntry(entry: CharacterLorebookEntry, haystack: string): boolean {
  const source = entry.caseSensitive ? haystack : haystack.toLocaleLowerCase();
  const matches = (keys: string[] | undefined) =>
    Boolean(keys?.some((key) => source.includes(entry.caseSensitive ? key : key.toLocaleLowerCase())));
  if (!matches(entry.keys)) return false;
  return !entry.selective || matches(entry.secondaryKeys);
}

function requiredText(value: unknown, label: string, max = MAX_TEXT): string {
  const text = optionalText(value, label, max);
  if (!text) throw new Error(`${label}不能为空。`);
  return text;
}

function optionalText(value: unknown, label: string, max = MAX_TEXT): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label}必须是文本。`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符。`);
  return text || undefined;
}

function stringArray(
  value: unknown,
  label: string,
  maxItems = 50,
  maxItemLength = MAX_TEXT,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组。`);
  if (value.length > maxItems) throw new Error(`${label}不能超过 ${maxItems} 项。`);
  const items = value.map((item) => requiredText(item, label, maxItemLength));
  return items.length ? items : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
