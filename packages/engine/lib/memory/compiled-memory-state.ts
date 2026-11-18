import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../../shared/safe-fs.ts";

const COMPILED_FILES = ["memory.md", "facts.md", "today.md", "week.md", "longterm.md"];

export function resetMarkerPath(memoryDir) {
  return path.join(memoryDir, "reset.json");
}

export function readCompiledResetAt(memoryDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(resetMarkerPath(memoryDir), "utf-8"));
    const value = raw?.compiledResetAt;
    if (!value || Number.isNaN(Date.parse(value))) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeCompiledResetMarker(memoryDir, resetAt = new Date().toISOString()) {
  if (!resetAt || Number.isNaN(Date.parse(resetAt))) {
    throw new Error("compiledResetAt must be an ISO timestamp");
  }
  fs.mkdirSync(memoryDir, { recursive: true });
  const marker = {
    compiledResetAt: resetAt,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(resetMarkerPath(memoryDir), JSON.stringify(marker, null, 2) + "\n");
  return resetAt;
}

export function clearCompiledMemoryArtifacts(memoryDir) {
  fs.mkdirSync(memoryDir, { recursive: true });
  for (const name of COMPILED_FILES) {
    const filePath = path.join(memoryDir, name);
    fs.writeFileSync(filePath, "", "utf-8");
    removeIfExists(`${filePath}.fingerprint`);
  }
}

export function clearCompiledSummarySources(summariesDir, summaryManager = null) {
  fs.mkdirSync(summariesDir, { recursive: true });
  for (const entry of fs.readdirSync(summariesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    removeIfExists(path.join(summariesDir, entry.name));
  }
  summaryManager?.clearCache?.();
}

export function normalizeCompiledSectionBody(value) {
  const raw = stripThinkTagBlocks(String(value || "")).trim();
  if (!raw) return "";

  const parsedArray = parseStringArray(raw);
  const text = parsedArray
    ? parsedArray.map((item) => `- ${item.trim()}`).join("\n")
    : raw;

  return text
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s+\S/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeCompiledLLMResult(value, source = "compiled memory") {
  const normalized = normalizeCompiledSectionBody(value);
  if (!normalized && hasDanglingLeadingThinkTag(value)) {
    throw new Error(`${source} returned an unterminated thinking block`);
  }
  return normalized;
}

const COMPILER_ADDRESSING_USER = [
  /^(?:抱歉[，,。！!\s]*)?(?:目前|暂时)?我?(?:(?:没有|没|尚未)(?:收到|看到|拿到)|缺少)(?:任何|足够的)?[「『“"]?(?:上一版|先前|原有|摘要|时间线|原始资料|输入材料)/u,
  /^(?:抱歉[，,。！!\s]*)?我(?:暂时)?(?:无法|不能)(?:为你|帮你)?(?:生成|编译|整理|总结)/u,
  /^(?:为了[^，,。！？]{1,60}[，,]\s*)?(?:我需要你|请(?:你)?(?:先|再)?)\s*(?:提供|补充|贴出|发给我)/u,
  /^(?:sorry[,!.\s]+)?I (?:(?:can['’]t|cannot|(?:am )?unable to) (?:generate|compile|summari[sz]e)|(?:don['’]t have|haven['’]t received|need) (?:enough |the |a )?(?:source material|information|context|previous draft))/iu,
  /^(?:please|(?:could|can|would) you(?: please)?) (?:provide|share|send|paste|supply)\b/iu,
];

export function validateEditableMemoryCompileResult(value, source) {
  const body = normalizeCompiledLLMResult(value, source);
  if (!body) throw new Error(source + " returned no memory content");

  // Match assistant-to-user replies at the start of a line, including lists.
  // Ordinary narrative may include a question, a quote, or no final punctuation.
  const lines = body.split(/\r?\n/);
  if (lines.some((line) => {
    const text = line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    return COMPILER_ADDRESSING_USER.some((pattern) => pattern.test(text));
  })) {
    throw new Error(source + " returned a conversational reply instead of memory content");
  }
  return body;
}

export function stripThinkTagBlocks(value) {
  return String(value || "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/^\s*<think(?:ing)?>[\s\S]*$/i, "")
    .replace(/<\/think(?:ing)?>\s*/gi, "");
}

export function hasDanglingLeadingThinkTag(value) {
  const text = String(value || "");
  return /^\s*<think(?:ing)?>/i.test(text) && !/<\/think(?:ing)?>/i.test(text);
}

function parseStringArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((item) => typeof item === "string")) return null;
    return parsed.filter((item) => item.trim());
  } catch {
    return null;
  }
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, content);
}
