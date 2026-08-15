import type {
  AgentMemoryEpisode,
  AgentMemoryFact,
  AgentMemoryMajorEvent,
  AgentMemoryMessage,
} from "./agent-types.js";

const DEFAULT_FACT_LIMIT = 5;
const DEFAULT_EPISODE_LIMIT = 2;
const DEFAULT_RECENT_USER_MESSAGE_LIMIT = 4;
const DEFAULT_CRITICAL_FACT_LIMIT = 2;

const RECALL_CUE = /(?:还记得|记不记得|你记得|想起|回忆|回想|上次(?:我们|你|我|聊|说|提|发生|做|约|见|那|的)|那天(?:我们|你|我|发生|说|聊|的事)|之前(?:我们|你|我)?(?:聊|说|提|发生|做|约|见|的事)|以前(?:我们|你|我)(?:聊|说|提|发生|做|约|见)|当时(?:我们|你|我|发生|说|聊)|(?:do\s+you\s+)?remember(?:\s+when)?|last\s+time\s+(?:we|you|i)|what\s+happened\s+before)/iu;

const CONTINUATION_CUE = /^(?:[嗯哦啊唉哎好行对是]+|(?:这|那)(?:个|件|次|样|么|里|边)?[呢吗啊？?]*|刚才[的这那个件事呢吗啊？?]*|继续(?:说)?|接着(?:说)?|然后[呢吗啊？?]*|还有[呢吗啊？?]*|再说(?:说|下去)?|你呢|期待吗|可以吗|真的吗|是吗)[。！!，,\s]*$/u;

const LATIN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "but",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "was",
  "we",
  "were",
  "with",
  "you",
  "your",
]);

const HAN_STOP_CHARACTERS = new Set(
  [..."的一了是在我你他她它们和与也都就还又很吗呢吧啊呀哦嗯这那个有没不把被给让从到会能要想说问看做去来过着地得而及或如果然后现在今天最近用户信息事情东西起"],
);

const HAN_STOP_TOKENS = new Set([
  "一起",
  "两人",
  "双方",
  "用户",
  "角色",
  "当前",
  "最近",
  "相关",
  "事情",
  "东西",
  "对话",
  "经历",
  "发生",
  "之前",
  "上次",
  "那天",
  "当时",
  "过去",
  "以前",
  "记得",
]);

type CriticalFactKind =
  | "safe-word"
  | "boundary"
  | "relationship"
  | "name"
  | "address";

export interface MemoryRelevanceOptions {
  input: string;
  /** Owner-authored active context, such as a console-directed event. */
  ownerContext?: string;
  recentMessages?: readonly AgentMemoryMessage[];
  summary?: string;
  facts?: readonly AgentMemoryFact[];
  episodes?: readonly AgentMemoryEpisode[];
  majorEvents?: readonly AgentMemoryMajorEvent[];
  factLimit?: number;
  episodeLimit?: number;
  recentUserMessageLimit?: number;
  /** Maximum number of unrelated but identity/safety-critical facts retained. */
  criticalFactLimit?: number;
}

export interface RelevantMemorySelection {
  includeSummary: boolean;
  summary: string;
  facts: AgentMemoryFact[];
  episodes: AgentMemoryEpisode[];
  hasRecallCue: boolean;
}

interface Ranked<T> {
  value: T;
  index: number;
  score: number;
  updatedAt: number;
}

/**
 * Selects only memory that is lexically connected to the current conversation.
 *
 * It deliberately uses user text only: assistant replies can introduce a topic the
 * user never chose, and feeding that topic back would make it self-perpetuating.
 * The implementation is deterministic and local; it performs no model or network
 * calls.
 */
export function selectRelevantMemory(
  options: MemoryRelevanceOptions,
): RelevantMemorySelection {
  const factLimit = normalizeLimit(options.factLimit, DEFAULT_FACT_LIMIT);
  const episodeLimit = normalizeLimit(
    options.episodeLimit,
    DEFAULT_EPISODE_LIMIT,
  );
  const recentUserMessageLimit = normalizeLimit(
    options.recentUserMessageLimit,
    DEFAULT_RECENT_USER_MESSAGE_LIMIT,
  );
  const criticalFactLimit = Math.min(
    factLimit,
    normalizeLimit(options.criticalFactLimit, DEFAULT_CRITICAL_FACT_LIMIT),
  );
  const hasRecallCue = RECALL_CUE.test(options.input);
  const query = buildQueryTokens(
    options.input,
    options.recentMessages ?? [],
    recentUserMessageLimit,
  );
  if (options.ownerContext?.trim()) {
    addTokens(query, options.ownerContext, 1);
  }

  const facts = selectFacts(
    options.facts ?? [],
    query,
    factLimit,
    criticalFactLimit,
  );
  const episodes = selectEpisodes(
    options.episodes ?? [],
    options.majorEvents ?? [],
    query,
    episodeLimit,
    hasRecallCue,
  );
  const summary = selectRelevantSummary(options.summary ?? "", query);
  const includeSummary = Boolean(summary);

  return { includeSummary, summary, facts, episodes, hasRecallCue };
}

function selectFacts(
  facts: readonly AgentMemoryFact[],
  query: ReadonlyMap<string, number>,
  limit: number,
  criticalLimit: number,
): AgentMemoryFact[] {
  if (limit === 0) return [];

  const rankedCritical = facts
    .map((fact, index) => {
      const kind = criticalFactKind(fact.key);
      return kind
        ? {
            value: fact,
            index,
            score: criticalKindPriority(kind),
            updatedAt: timestamp(fact.updatedAt),
            kind,
          }
        : undefined;
    })
    .filter(
      (
        item,
      ): item is Ranked<AgentMemoryFact> & { kind: CriticalFactKind } =>
        item !== undefined,
    )
    .sort(compareRanked);

  // Do not let several aliases of one category consume every critical slot.
  const usedCriticalKinds = new Set<CriticalFactKind>();
  const critical: AgentMemoryFact[] = [];
  for (const item of rankedCritical) {
    if (critical.length >= criticalLimit) break;
    if (usedCriticalKinds.has(item.kind)) continue;
    usedCriticalKinds.add(item.kind);
    critical.push(item.value);
  }

  const criticalIds = new Set(critical.map((fact) => fact.id));
  const relevant = facts
    .map((fact, index): Ranked<AgentMemoryFact> => ({
      value: fact,
      index,
      score: lexicalOverlapScore(`${fact.key}\n${fact.value}`, query),
      updatedAt: timestamp(fact.updatedAt),
    }))
    .filter((item) => item.score > 0 && !criticalIds.has(item.value.id))
    .sort(compareRanked)
    .slice(0, limit - critical.length)
    .map((item) => item.value);

  return [...critical, ...relevant];
}

function selectEpisodes(
  episodes: readonly AgentMemoryEpisode[],
  majorEvents: readonly AgentMemoryMajorEvent[],
  query: ReadonlyMap<string, number>,
  limit: number,
  hasRecallCue: boolean,
): AgentMemoryEpisode[] {
  if (limit === 0) return [];
  const groupTextByDetailKey = new Map<string, string>();
  for (const group of majorEvents) {
    const groupText = `${group.title}\n${group.summary}`;
    for (const detailKey of group.detailKeys) {
      if (!groupTextByDetailKey.has(detailKey)) {
        groupTextByDetailKey.set(detailKey, groupText);
      }
    }
  }

  const relevant = episodes
    .map((episode, index): Ranked<AgentMemoryEpisode> => ({
      value: episode,
      index,
      score:
        lexicalOverlapScore(
          [
            groupTextByDetailKey.get(episode.sourceKey ?? episode.id) ?? "",
            episode.title,
            episode.content,
          ].join("\n"),
          query,
        ) *
          100 +
        episode.importance,
      updatedAt: timestamp(episode.updatedAt),
    }))
    // Importance is a tie-breaker, never a reason to inject an unrelated event.
    .filter((item) => item.score >= 100)
    .sort(compareRanked)
    .slice(0, limit)
    .map((item) => item.value);

  if (!hasRecallCue || relevant.length >= limit) return relevant;

  const selectedIds = new Set(relevant.map((episode) => episode.id));
  const recalled = episodes
    .map((episode, index): Ranked<AgentMemoryEpisode> => ({
      value: episode,
      index,
      score: episode.importance,
      updatedAt: timestamp(episode.updatedAt),
    }))
    .filter((item) => !selectedIds.has(item.value.id))
    .sort(compareRanked)
    .slice(0, limit - relevant.length)
    .map((item) => item.value);

  return [...relevant, ...recalled];
}

function buildQueryTokens(
  input: string,
  messages: readonly AgentMemoryMessage[],
  recentUserMessageLimit: number,
): Map<string, number> {
  const query = new Map<string, number>();
  addTokens(query, input, 4);

  if (!shouldUseRecentUserContext(input, query)) return query;

  const userMessages =
    recentUserMessageLimit === 0
      ? []
      : messages
          .filter((message) => message.role === "user")
          .slice(-recentUserMessageLimit)
          .reverse();
  for (const [index, message] of userMessages.entries()) {
    // Only a genuinely referential/continuing input inherits the recent topic.
    addTokens(query, message.content, 2 / (index + 1));
  }
  return query;
}

function addTokens(target: Map<string, number>, text: string, weight: number): void {
  const allowSingleHan = meaningfulHanCharacters(text).length === 1;
  for (const [token, tokenWeight] of tokenize(text)) {
    if (
      token.startsWith("han:") &&
      [...token.slice("han:".length)].length === 1 &&
      !allowSingleHan
    ) {
      continue;
    }
    target.set(token, (target.get(token) ?? 0) + tokenWeight * weight);
  }
}

function shouldUseRecentUserContext(
  input: string,
  currentQuery: ReadonlyMap<string, number>,
): boolean {
  const normalized = input.normalize("NFKC").trim();
  if (!normalized) return false;
  if (RECALL_CUE.test(normalized)) return false;
  if (CONTINUATION_CUE.test(normalized)) return true;
  if (currentQuery.size === 0) return true;
  const compactLength = [...normalized.replace(/[\s\p{P}\p{S}]/gu, "")].length;
  const asksBriefFollowUp = /(?:[？?]|[吗呢啊])[。！!，,\s]*$/u.test(normalized);
  const strongTokens = [...currentQuery.keys()].filter(
    (token) => !token.startsWith("han:") || [...token.slice(4)].length >= 2,
  ).length;
  return compactLength <= 12 && asksBriefFollowUp && strongTokens <= 1;
}

function meaningfulHanCharacters(text: string): string[] {
  return [...text.normalize("NFKC")].filter(
    (character) =>
      /\p{Script=Han}/u.test(character) &&
      !HAN_STOP_CHARACTERS.has(character),
  );
}

function tokenize(text: string): Map<string, number> {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en-US");
  const result = new Map<string, number>();

  for (const match of normalized.matchAll(/[\p{Script=Latin}\p{N}]+/gu)) {
    const token = match[0];
    if (LATIN_STOP_WORDS.has(token) || (token.length === 1 && !/^\d$/u.test(token))) {
      continue;
    }
    result.set(`latin:${token}`, 3);
  }

  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const segment = [...match[0]];
    for (let index = 0; index < segment.length; index += 1) {
      const character = segment[index];
      if (character && !HAN_STOP_CHARACTERS.has(character)) {
        result.set(`han:${character}`, 1);
      }
      const next = segment[index + 1];
      if (
        character &&
        next &&
        !HAN_STOP_CHARACTERS.has(character) &&
        !HAN_STOP_CHARACTERS.has(next) &&
        !HAN_STOP_TOKENS.has(`${character}${next}`)
      ) {
        result.set(`han:${character}${next}`, 3);
      }
    }
  }

  return result;
}

function lexicalOverlapScore(
  text: string,
  query: ReadonlyMap<string, number>,
): number {
  let score = 0;
  for (const token of tokenize(text).keys()) {
    score += query.get(token) ?? 0;
  }
  return score;
}

function selectRelevantSummary(
  summary: string,
  query: ReadonlyMap<string, number>,
): string {
  const trimmed = summary.trim();
  if (!trimmed || query.size === 0) return "";
  const sentences =
    trimmed.match(/[^。！？!?\uff1b;\n]+[。！？!?；;]?/gu)?.map((value) =>
      value.trim()
    ).filter(Boolean) ?? [];
  return sentences
    .map((value, index) => ({
      value,
      index,
      score: lexicalOverlapScore(value, query),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.value)
    .join("\n");
}

function criticalFactKind(key: string): CriticalFactKind | undefined {
  const normalized = key.normalize("NFKC").toLocaleLowerCase("en-US");
  const compact = normalized.replace(/[\s_\-—:：/]+/gu, "");
  if (/(?:安全词|停止词|safeword|stopsignal)/u.test(compact)) {
    return "safe-word";
  }
  if (/(?:边界|禁忌|底线|不接受|禁止|boundary|consent|hardlimit)/u.test(compact)) {
    return "boundary";
  }
  if (/(?:关系|伴侣|恋人|配偶|男朋友|女朋友|relationship|partner|spouse)/u.test(compact)) {
    return "relationship";
  }
  if (/(?:姓名|名字|称呼|昵称|name|nickname)/u.test(compact)) {
    return "name";
  }
  if (/(?:住址|地址|居住地|所在地|address|location|residence)/u.test(compact)) {
    return "address";
  }
  return undefined;
}

function criticalKindPriority(kind: CriticalFactKind): number {
  switch (kind) {
    case "safe-word":
      return 500;
    case "boundary":
      return 400;
    case "relationship":
      return 300;
    case "name":
      return 200;
    case "address":
      return 100;
  }
}

function compareRanked<T>(left: Ranked<T>, right: Ranked<T>): number {
  return (
    right.score - left.score ||
    right.updatedAt - left.updatedAt ||
    left.index - right.index
  );
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
