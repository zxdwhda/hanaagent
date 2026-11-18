import { createHash } from "node:crypto";
import { scrubPII } from "../pii-guard.ts";
import { extractFactSection, replaceFactSection } from "./rolling-summary-format.ts";

export type ProjectedMemoryMessage = {
  entryId?: string;
  role?: string;
  content?: unknown;
};

export type VerifiedUserFact = {
  text: string;
  source: { entryId: string; sentenceHash: string };
};

export type UserFactProvenance = {
  status: "verified" | "unresolved";
  candidates: VerifiedUserFact[];
};

const ENTRY_ID = /^[a-z0-9_.-]{1,128}$/i;
const MAX_FACT_TEXT_LENGTH = 320;
const ACKNOWLEDGMENT = /^(?:(?:ok(?:ay)?|yes|yeah|yep|no|nah|sure|right|correct|exactly|indeed|absolutely|certainly|noted|thanks|thank you(?: very much)?|sounds good|got it|i see|i agree|agreed|fine|great|perfect|makes sense|understood)(?=$|\s)|嗯+|哦+|噢+|好的|好啊|好呀|好|是的|是|对的|对|行|可以|当然|没问题|没错|收到|知道了|明白(?:了)?|了解(?:了)?|谢谢(?:你)?|多谢|听起来不错)(?:\s*)/iu;

function userText(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  // Blocks with attachments, forms or other media are not a standalone
  // text statement and may depend on context outside the user's text.
  if (content.some((block) => block?.type !== "text" || typeof block.text !== "string")) return "";
  return content.map((block) => block.text).join("").trim();
}

function isStandaloneStatement(text: string) {
  if (text.length > MAX_FACT_TEXT_LENGTH || /[\r\n\u2028\u2029]/u.test(text)) return false;
  if (!/[\p{L}\p{N}]/u.test(text) || /^[“"「『‘'>]/u.test(text) || /[?？]$/u.test(text)) return false;
  const words = text.replace(/[\p{P}\p{S}]+/gu, " ").trim();
  let remaining = words;
  while (remaining && ACKNOWLEDGMENT.test(remaining)) {
    remaining = remaining.replace(ACKNOWLEDGMENT, "");
  }
  return remaining.length > 0;
}

export function buildUserFactSourceIndex(messages: readonly ProjectedMemoryMessage[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const message of messages) {
    if (message?.role !== "user" || typeof message.entryId !== "string" || !ENTRY_ID.test(message.entryId)) continue;
    const text = userText(message.content);
    if (isStandaloneStatement(text)) sources.set(message.entryId, text);
  }
  return sources;
}

function factFromSource(entryId: string, utterance: string): VerifiedUserFact {
  const { cleaned } = scrubPII(utterance);
  return {
    text: cleaned,
    source: {
      entryId,
      sentenceHash: createHash("sha256").update(utterance).digest("hex"),
    },
  };
}

export function buildUserFactProvenanceInstructions(locale: string) {
  if (locale.startsWith("zh")) {
    return [
      "重要事实必须以用户本人在当前分支中明确陈述或完整确认的内容为准。",
      "每项格式为 \`- [user:<entryId>] <该用户消息完整原文>\`，只能使用输入中标有该来源 ID 的用户消息。不改写，不截句，不省略否认或更正。用户后来更正时只选最新有效陈述。",
      "助手建议、已有记忆、引用、提问、没有重述事实的附和和客套话不算。整条证据不是一段可独立理解的简短用户陈述时跳过。没有符合条件的事实就写 \`- 无\`。事情经过一节不添加来源标记。",
    ].join("\n");
  }
  return [
    "Key Facts must come from the user's own explicit statement or complete confirmation on the current branch.",
    "Each item must be \`- [user:<entryId>] <entire verbatim user message>\` using a source ID shown on a user message. Do not paraphrase, quote a fragment, or omit a denial or correction. If the user corrected a fact later, select only the latest valid statement.",
    "Assistant suggestions, prior memories, quotations, questions, acknowledgments without a restatement and pleasantries do not count. Skip evidence that is not a short standalone statement. If none qualifies, write \`- None\`. Keep source markers out of the Timeline.",
  ].join("\n");
}

export function resolveUserFactProvenance(
  summary: string,
  messages: readonly ProjectedMemoryMessage[] | null | undefined,
): UserFactProvenance {
  const byId = buildUserFactSourceIndex(messages ?? []);
  const candidates = new Map<string, VerifiedUserFact>();
  const lines = extractFactSection(summary).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && /^- (?:无|none)$/iu.test(lines[0])) {
    return { status: messages ? "verified" : "unresolved", candidates: [] };
  }

  let unresolved = !messages || lines.length === 0;
  for (const line of lines) {
    const annotation = /^- \[user:([a-zA-Z0-9_.-]{1,128})\] (.+)$/u.exec(line);
    const utterance = annotation ? byId.get(annotation[1]) : undefined;
    if (!annotation || !utterance || utterance !== annotation[2]) {
      unresolved = true;
      continue;
    }
    candidates.set(annotation[1], factFromSource(annotation[1], utterance));
  }
  return { status: unresolved ? "unresolved" : "verified", candidates: [...candidates.values()] };
}

export function revalidateUserFactProvenance(
  provenance: UserFactProvenance,
  messages: readonly ProjectedMemoryMessage[],
): boolean {
  if (
    !Array.isArray(provenance?.candidates)
    || (provenance.status !== "verified" && provenance.status !== "unresolved")
  ) return false;
  const sources = buildUserFactSourceIndex(messages);
  return provenance.candidates.every((candidate) => {
    const entryId = candidate?.source?.entryId;
    const utterance = sources.get(entryId);
    if (!utterance) return false;
    const expected = factFromSource(entryId, utterance);
    return expected.source.sentenceHash === candidate.source.sentenceHash && expected.text === candidate.text;
  });
}

export function applyUserFactProvenanceToSummary(summary: string, provenance: UserFactProvenance, locale: string) {
  const factBody = provenance.candidates.map(({ text }) => "- " + text).join("\n")
    || (locale.startsWith("zh") ? "- 无" : "- None");
  return replaceFactSection(summary, factBody);
}
