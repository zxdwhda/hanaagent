import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { DEFAULT_CHAT_OUTPUT_TOKENS } from "../../core/provider-compat/output-budget.ts";

const TINY_OUTPUT_BUDGET = 32;
const CONTEXT_SAFETY_TOKENS = 4_096; // Matches the Pi SDK default context clamp.
const MAX_BUFFERED_EVENTS = 128;
const OUTPUT_FIELDS = ["max_tokens", "max_completion_tokens"];

type UsageEpochMessage = {
  role?: string;
  timestamp?: number;
  usage?: { totalTokens?: number };
  stopReason?: string;
};

export function needsFirstCompactedTurnBudget(messages: readonly UsageEpochMessage[] | undefined) {
  if (!messages) return false;
  let summaryIndex = messages.length - 1;
  while (summaryIndex >= 0 && messages[summaryIndex]?.role !== "compactionSummary") summaryIndex -= 1;
  if (summaryIndex < 0) return false;
  const summaryTime = messages[summaryIndex].timestamp;
  if (summaryTime == null) return true;
  return !messages.slice(summaryIndex + 1).some((message) =>
    message?.role === "assistant"
    && (message.timestamp ?? 0) > summaryTime
    && (message.usage?.totalTokens ?? 0) > 0
    && message.stopReason !== "aborted"
    && message.stopReason !== "error");
}

function hasToolActivity(event: AssistantMessageEvent) {
  return event.type.startsWith("toolcall_")
    || (event.type === "done" && event.message.content.some((block) => block.type === "toolCall"));
}

type StartStream = (options: SimpleStreamOptions) => Promise<AssistantMessageEventStream>;

export async function streamWithCompactionBudgetRetry(
  start: StartStream,
  model: Model<Api>,
  options: SimpleStreamOptions = {},
) {
  let attempt: { payload: Record<string, unknown>; field: string; cap: number } | undefined;
  const first = await start({
    ...options,
    onPayload: async (payload, requestModel) => {
      const supplied = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const before = OUTPUT_FIELDS.filter((field) => Object.hasOwn(supplied, field))
        .map((field) => supplied[field]);
      const transformed = await options.onPayload?.(payload, requestModel);
      const prepared = transformed === undefined ? payload : transformed;
      if (prepared && typeof prepared === "object") {
        const body = prepared as Record<string, unknown>;
        const fields = OUTPUT_FIELDS.filter((field) => Object.hasOwn(body, field));
        const [field] = fields;
        const cap = body[field];
        if (fields.length === 1 && typeof cap === "number" && Number.isInteger(cap)
          && before.length === 1 && cap === before[0] && cap > 0 && cap <= TINY_OUTPUT_BUDGET) {
          attempt = { payload: body, field, cap };
        }
      }
      return prepared;
    },
  });
  return (async function* () {
    const original: AssistantMessageEvent[] = [];
    let mayRetry = true;
    for await (const event of first) {
      if (!attempt || !mayRetry || hasToolActivity(event) || original.length >= MAX_BUFFERED_EVENTS) {
        mayRetry = false;
        yield* original.splice(0);
        yield event;
      } else {
        original.push(event);
      }
    }
    const terminal = original.at(-1);
    if (attempt && terminal?.type === "done" && terminal.reason === "length" && !options.signal?.aborted) {
      const { input, cacheRead, cacheWrite } = terminal.message.usage;
      const promptTokens = input + cacheRead + cacheWrite;
      const cap = Math.min(
        model.maxTokens,
        DEFAULT_CHAT_OUTPUT_TOKENS,
        model.contextWindow - promptTokens - CONTEXT_SAFETY_TOKENS,
      );
      if ([input, cacheRead, cacheWrite, cap].every((n) => Number.isSafeInteger(n) && n >= 0)
        && promptTokens > 0 && cap > TINY_OUTPUT_BUDGET) {
        // The reported usage describes this exact input, including the tools.
        const payload = { ...attempt.payload, [attempt.field]: cap };
        try {
          const retry = await start({ ...options, onPayload: () => payload });
          const pending: AssistantMessageEvent[] = [];
          for await (const event of retry) {
            if (original.length) {
              if (event.type === "error" && !options.signal?.aborted) break;
              if (event.type !== "text_delta" && event.type !== "done"
                && event.type !== "error" && !hasToolActivity(event) && pending.length < MAX_BUFFERED_EVENTS) {
                pending.push(event);
                continue;
              }
              original.length = 0;
              yield* pending;
            }
            yield event;
          }
        } catch (error) {
          if (!original.length || options.signal?.aborted) throw error;
        }
      }
    }
    yield* original;
  })();
}
