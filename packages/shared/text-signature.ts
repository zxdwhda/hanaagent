export type AssistantTextPhase = "commentary" | "final_answer";

export interface AssistantTextSignature {
  v?: number;
  id?: string;
  phase?: AssistantTextPhase;
}

export function parseAssistantTextSignature(value: unknown): AssistantTextSignature | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const phase = (parsed as Record<string, unknown>).phase;
    if (phase !== "commentary" && phase !== "final_answer") return null;
    return {
      ...(typeof (parsed as Record<string, unknown>).v === "number" ? { v: (parsed as Record<string, unknown>).v as number } : {}),
      ...(typeof (parsed as Record<string, unknown>).id === "string" ? { id: (parsed as Record<string, unknown>).id as string } : {}),
      phase,
    };
  } catch {
    return null;
  }
}

export function getAssistantTextPhase(block: unknown): AssistantTextPhase | null {
  if (!block || typeof block !== "object") return null;
  const signature = parseAssistantTextSignature((block as Record<string, unknown>).textSignature);
  return signature?.phase || null;
}

export function isAssistantCommentaryTextBlock(block: unknown): boolean {
  return getAssistantTextPhase(block) === "commentary";
}

interface AssistantTextSource {
  api?: string;
  provider?: string;
  content?: unknown;
}

interface AssistantTextUpdate {
  type?: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: AssistantTextSource;
}

export type AssistantTextUpdateSlots = Map<number, { buffered: string; emitted: string }>;

export function projectAssistantTextUpdate(
  message: AssistantTextSource | null | undefined,
  update: AssistantTextUpdate | null | undefined,
  slots: AssistantTextUpdateSlots,
): string {
  if (update?.type !== "text_delta" && update?.type !== "text_end") return "";
  const apiValue = update.partial?.api ?? message?.api;
  const providerValue = update.partial?.provider ?? message?.provider;
  const api = typeof apiValue === "string" ? apiValue.toLowerCase() : "";
  const provider = typeof providerValue === "string" ? providerValue.toLowerCase() : "";
  const hasPhases = provider === "openai-codex"
    || api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses";
  if (!hasPhases) return update.type === "text_delta" ? update.delta || "" : "";

  const index = typeof update.contentIndex === "number" && Number.isInteger(update.contentIndex)
    ? update.contentIndex : -1;
  const blocks = Array.isArray(update.partial?.content) ? update.partial.content : message?.content;
  const block = Array.isArray(blocks)
    ? (index >= 0 ? blocks[index] : blocks.find(item => item?.type === "text"))
    : null;
  const phase = getAssistantTextPhase(block);
  if (phase === "commentary") {
    slots.delete(index);
    return "";
  }

  const slot = slots.get(index) ?? { buffered: "", emitted: "" };
  if (update.type === "text_delta") {
    slot.buffered += update.delta || "";
    slots.set(index, slot);
    if (phase !== "final_answer" && !slot.emitted) return "";
    const ready = slot.buffered;
    slot.buffered = "";
    slot.emitted += ready;
    return ready;
  }

  slots.delete(index);
  const completed = typeof update.content === "string" ? update.content
    : (typeof block?.text === "string" ? block.text : undefined);
  if (completed !== undefined) {
    if (completed.startsWith(slot.emitted)) return completed.slice(slot.emitted.length);
    return slot.buffered;
  }
  return slot.buffered;
}

export function getCompletedAssistantText(message: { role?: string; stopReason?: string; content?: unknown } | null | undefined): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  if (message.stopReason === "error" || message.stopReason === "aborted") return "";
  return message.content
    .filter(block => block?.type === "text" && typeof block.text === "string" && !isAssistantCommentaryTextBlock(block))
    .map(block => block.text)
    .join("");
}

export function getMissingCompletedAssistantText(message: Parameters<typeof getCompletedAssistantText>[0], streamedText: string): string {
  const completed = getCompletedAssistantText(message);
  return completed.startsWith(streamedText) ? completed.slice(streamedText.length) : "";
}
