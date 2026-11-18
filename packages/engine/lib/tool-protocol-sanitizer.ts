const TOOL_PROTOCOL_TAGS = Object.freeze([
  "tool_calls",
  "tool_call",
  "function_calls",
  "function_call",
  "tool_use",
  "invoke",
  "parameter",
]);

const TOOL_PROTOCOL_TAG_SET = new Set(TOOL_PROTOCOL_TAGS);

const CHANNEL_MARKER_RE = /[<＜]\|[\s\S]*?\|[>＞]/g;
// Guillemets are also normal quotation marks. Only accept the observed antml namespace there.
const TOOL_TAG_RE = /[<＜]\s*([/／]?)\s*([\p{L}\p{N}_.:：-]+)([^<＜>＞]*)[>＞]|«\s*([/／]?)\s*(antml[:：][\p{L}\p{N}_.-]+)([^«»]*)»/giu;
const START_TOOL_TAG_RE = new RegExp(TOOL_TAG_RE.source, "iyu");
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const BARE_GUILLEMET_INVOKE_RE = /^[ \t]*«\s*antml[:：]invoke\s*»[ \t]*$/iu;
const GUILLEMET_INVOKE_TARGET_RE = /^[ \t]*[\w.-]+:[\w.-]+[ \t]*$/;

export function isBareGuillemetInvocationLine(line: string) {
  return BARE_GUILLEMET_INVOKE_RE.test(line);
}

export function isGuillemetInvocationTargetLine(line: string) {
  return GUILLEMET_INVOKE_TARGET_RE.test(line);
}

function normalizeForProtocolDetection(value: any) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "");
}

function normalizeTagName(rawName: any) {
  const normalized = normalizeForProtocolDetection(rawName)
    .trim()
    .toLowerCase();
  const colon = normalized.lastIndexOf(":");
  return colon >= 0 ? normalized.slice(colon + 1) : normalized;
}

function attrsHaveName(rawAttrs: any) {
  return /\bname\s*=/.test(normalizeForProtocolDetection(rawAttrs).toLowerCase());
}

function readToolTag(match: RegExpExecArray) {
  const name = normalizeTagName(match[2] ?? match[5]);
  if (!TOOL_PROTOCOL_TAG_SET.has(name)) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
    name,
    guillemet: match[5] !== undefined,
    closing: normalizeForProtocolDetection(match[1] ?? match[4]) === "/",
    attrs: (match[3] ?? match[6]) || "",
  };
}

function readStartingToolTag(text: string) {
  START_TOOL_TAG_RE.lastIndex = 0;
  const match = START_TOOL_TAG_RE.exec(text);
  return match ? readToolTag(match) : null;
}

function parseToolTags(text: string) {
  const tags: any[] = [];
  TOOL_TAG_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_TAG_RE.exec(text)) !== null) {
    const tag = readToolTag(match);
    if (tag) tags.push(tag);
  }
  return tags;
}

function startsWithToolProtocolTag(text: string) {
  const normalized = normalizeForProtocolDetection(text).trimStart();
  return Boolean(readStartingToolTag(normalized));
}

function isStructuralOpenTag(tag: any, source: string) {
  if (attrsHaveName(tag.attrs)) return true;
  return startsWithToolProtocolTag(source.slice(tag.end));
}

function findMatchingClose(tags: any[], startIndex: number) {
  const opener = tags[startIndex];
  let depth = 1;
  for (let i = startIndex + 1; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.name !== opener.name || tag.guillemet !== opener.guillemet) continue;
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) return tag;
    } else {
      depth += 1;
    }
  }
  return null;
}

function removeRanges(text: string, ranges: Array<[number, number]>) {
  if (!ranges.length) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, start));
    cursor = Math.max(cursor, end);
  }
  return out + text.slice(cursor);
}

function findBareGuillemetInvocationEnd(tag: NonNullable<ReturnType<typeof readToolTag>>, source: string) {
  if (!tag.guillemet || tag.name !== "invoke") return null;
  const lineStart = source.lastIndexOf("\n", tag.start - 1) + 1;
  const firstBreak = source.indexOf("\n", tag.end);
  const lineEnd = firstBreak === -1 ? source.length : firstBreak;
  if (!isBareGuillemetInvocationLine(source.slice(lineStart, lineEnd).trimEnd())) return null;
  if (firstBreak === -1) return lineEnd;
  const secondBreak = source.indexOf("\n", firstBreak + 1);
  const targetEnd = secondBreak === -1 ? source.length : secondBreak;
  const target = source.slice(firstBreak + 1, targetEnd).trimEnd();
  return isGuillemetInvocationTargetLine(target) ? targetEnd : lineEnd;
}

export function stripPairedGuillemetToolProtocol(text: string, protectedRanges: Array<[number, number]>) {
  const tags = parseToolTags(text).filter(tag => tag.guillemet && !protectedRanges.some(
    ([start, end]) => tag.start < end && tag.end > start,
  ));
  const ranges: Array<[number, number]> = [];
  let coveredUntil = 0;
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.closing || tag.start < coveredUntil) continue;
    const close = findMatchingClose(tags, i);
    if (close) {
      ranges.push([tag.start, close.end]);
      coveredUntil = close.end;
    }
  }
  return removeRanges(text, ranges);
}

export function stripToolProtocolTagsFromProse(value: any) {
  let text = String(value ?? "");
  text = text.replace(CHANNEL_MARKER_RE, "");

  const tags = parseToolTags(text);
  const ranges: Array<[number, number]> = [];
  let coveredUntil = -1;

  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (tag.start < coveredUntil) continue;

    if (tag.closing) {
      ranges.push([tag.start, tag.end]);
      coveredUntil = tag.end;
      continue;
    }

    const close = findMatchingClose(tags, i);
    if (close) {
      ranges.push([tag.start, close.end]);
      coveredUntil = close.end;
      continue;
    }

    if (isStructuralOpenTag(tag, text)) {
      ranges.push([tag.start, text.length]);
      coveredUntil = text.length;
      break;
    }

    const bareEnd = tag.guillemet ? findBareGuillemetInvocationEnd(tag, text) : tag.end;
    if (bareEnd !== null) {
      ranges.push([tag.start, bareEnd]);
      coveredUntil = bareEnd;
    }
  }

  return removeRanges(text, ranges);
}

export function isToolProtocolFragment(value: any) {
  const normalized = normalizeForProtocolDetection(value).trimStart();
  if (!normalized) return false;
  if (/^<\|[\s\S]*?\|>/.test(normalized)) return true;

  const tag = readStartingToolTag(normalized);
  if (!tag) return false;
  if (tag.closing) return true;
  if (attrsHaveName(tag.attrs)) return true;
  if (startsWithToolProtocolTag(normalized.slice(tag.end))) return true;

  const stripped = stripToolProtocolTagsFromProse(normalized);
  return stripped.length < normalized.length && stripped.trim().length === 0;
}
