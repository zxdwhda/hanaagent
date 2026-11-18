/**
 * Event-aware visible-text accumulator for Bridge outbound capture.
 *
 * Raw text_delta concatenation around hidden tools glues prose segments so
 * Telegram/WeChat formatters cannot recover a paragraph break. This helper
 * inserts a normalized `\n\n` when a tool intervenes between visible prose.
 */

import { getMissingCompletedAssistantText } from "../../../shared/text-signature.ts";

function paragraphBoundaryPrefix(existing: string, incoming: string): string {
  if (!existing || !incoming) return "";
  const trailingNewlines = (existing.match(/\n*$/)?.[0] || "").length;
  const leadingNewlines = (incoming.match(/^\n*/)?.[0] || "").length;
  const needed = 2 - (trailingNewlines + leadingNewlines);
  return needed > 0 ? "\n".repeat(needed) : "";
}

export function createVisibleTextAccumulator() {
  let text = "";
  let pendingParagraphBoundary = false;
  let streamedMessageText = "";

  return {
    appendAssistantEvent(event: any) {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update?.type !== "text_delta" || !update.delta) return null;
        streamedMessageText += update.delta;
        return this.appendTextDelta(update.delta);
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return null;
      const tail = getMissingCompletedAssistantText(event.message, streamedMessageText);
      streamedMessageText = "";
      return tail ? this.appendTextDelta(tail) : null;
    },

    appendTextDelta(delta: string) {
      const raw = delta || "";
      if (!raw) return { emittedDelta: "", text };

      let emittedDelta = raw;
      if (pendingParagraphBoundary && text) {
        const prefix = paragraphBoundaryPrefix(text, raw);
        emittedDelta = prefix + raw;
        pendingParagraphBoundary = false;
      } else if (pendingParagraphBoundary) {
        // First visible prose after a leading tool — no leading blank lines.
        pendingParagraphBoundary = false;
      }

      text += emittedDelta;
      return { emittedDelta, text };
    },

    markHiddenToolBoundary() {
      pendingParagraphBoundary = true;
    },

    appendVisibleDetail(detail: string) {
      if (!detail) return "";
      pendingParagraphBoundary = false;
      const chunk = (text ? "\n\n" : "") + detail;
      text += chunk;
      return chunk;
    },

    getText() {
      return text;
    },
  };
}
