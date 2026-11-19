export const INTERNAL_MOOD_TAGS = Object.freeze([
  "mood",
  "pulse",
  "reflect",
] as const);

export type InternalMoodTag = (typeof INTERNAL_MOOD_TAGS)[number];

type LeadingMoodInspection =
  | {
    kind: "open";
    prefix: string;
    tag: InternalMoodTag;
    openTag: string;
    remainder: string;
  }
  | {
    kind: "pending";
    prefix: string;
    pending: string;
  }
  | {
    kind: "text";
  };

export interface LeadingInternalMoodBlock {
  prefix: string;
  tag: InternalMoodTag;
  content: string;
  rest: string;
}

function isLeadingWhitespace(char: string): boolean {
  return char === "\uFEFF" || /\s/u.test(char);
}

/**
 * Classify only the response-leading position. `pending` means a streaming
 * caller must retain the partial opener until another chunk or flush arrives.
 */
export function inspectLeadingInternalMoodOpener(input: string): LeadingMoodInspection {
  let openerIndex = 0;
  while (openerIndex < input.length && isLeadingWhitespace(input[openerIndex])) {
    openerIndex += 1;
  }

  const prefix = input.slice(0, openerIndex);
  const candidate = input.slice(openerIndex);
  if (!candidate) return { kind: "pending", prefix, pending: "" };

  for (const tag of INTERNAL_MOOD_TAGS) {
    const openTag = `<${tag}>`;
    if (candidate.startsWith(openTag)) {
      return {
        kind: "open",
        prefix,
        tag,
        openTag,
        remainder: candidate.slice(openTag.length),
      };
    }
  }

  if (INTERNAL_MOOD_TAGS.some((tag) => `<${tag}>`.startsWith(candidate))) {
    return { kind: "pending", prefix, pending: candidate };
  }
  return { kind: "text" };
}

/** Include the known malformed closer emitted for the MOOD block. */
export function internalMoodClosingTags(tag: InternalMoodTag): string[] {
  return tag === "mood" ? ["</mood>", "</mid>"] : [`</${tag}>`];
}

export function findInternalMoodClose(input: string, tags: readonly string[]) {
  let close: { index: number; length: number } | null = null;
  for (const tag of tags) {
    const index = input.indexOf(tag);
    if (index >= 0 && (!close || index < close.index)) close = { index, length: tag.length };
  }
  return close;
}

/** Parse one complete internal block at response start. */
export function parseLeadingInternalMoodBlock(input: string): LeadingInternalMoodBlock | null {
  const inspection = inspectLeadingInternalMoodOpener(input);
  if (inspection.kind !== "open") return null;

  const close = findInternalMoodClose(inspection.remainder, internalMoodClosingTags(inspection.tag));
  if (!close) return null;

  return {
    prefix: inspection.prefix,
    tag: inspection.tag,
    content: inspection.remainder.slice(0, close.index),
    rest: inspection.remainder.slice(close.index + close.length),
  };
}

/** Recover an isolated, structured MOOD block after visible prose. */
export function parseLateInternalMoodBlock(input: string, { requireLineBreak = false } = {}): LeadingInternalMoodBlock | null {
  if (!input.includes("<mood>") || !input.includes("</mood>")) return null;
  const lines = input.split("\n");
  let offset = 0;
  let fence: string | null = null;
  let codeTicks: number | null = null;
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence && codeTicks === null) fence = marker[1];
      else if (fence && marker[1].startsWith(fence) && !marker[2].trim()) fence = null;
    } else if (!fence) {
      if (codeTicks === null && offset > 0 && /^ {0,3}<mood>/.test(line) && input.slice(0, offset).trim()) {
        const candidate = input.slice(offset, offset + 4200);
        const match = candidate.match(/^ {0,3}<mood>[ \t\r\n]*(Vibe[ \t]*[:：][\s\S]{1,4096}?)<\/mood>[ \t]*(?:\r?\n|$)/);
        if (match && (match[0].endsWith("\n") || (!requireLineBreak && offset + match[0].length === input.length))) {
          return { prefix: input.slice(0, offset), tag: "mood", content: match[1], rest: input.slice(offset + match[0].length) };
        }
      }
      for (const tickRun of line.matchAll(/(?<!\\)`+/g)) {
        if (codeTicks === null) codeTicks = tickRun[0].length;
        else if (codeTicks === tickRun[0].length) codeTicks = null;
      }
      if (!line.trim()) codeTicks = null;
    }
    offset += line.length + 1;
  }
  return null;
}
