import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall } from "@earendil-works/pi-ai";

const VALID_TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_ALIAS_LENGTH = 64;

function usesStrictToolNames(model: Model<Api>) {
  if (model?.api !== "openai-completions" || model.id.toLowerCase() !== "moonshotai/kimi-k3") return false;
  try {
    return new URL(model.baseUrl).hostname === "api.qnaigc.com";
  } catch {
    return false;
  }
}

function renameCall(call: ToolCall, names: ReadonlyMap<string, string>): ToolCall {
  const name = names.get(call.name);
  return name ? { ...call, name } : call;
}

function renameMessage(message: AssistantMessage, names: ReadonlyMap<string, string>): AssistantMessage {
  if (!message.content.some((block) => block.type === "toolCall" && names.has(block.name))) return message;
  return {
    ...message,
    content: message.content.map((block) => block.type === "toolCall" ? renameCall(block, names) : block),
  };
}

/** Translate only the provider's view. The agent and persisted history keep their original names. */
export function adaptQiniuKimiToolNames(model: Model<Api>, context: Context) {
  if (!usesStrictToolNames(model)) return null;

  const names = new Set(context.tools?.map((tool) => tool.name));
  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") names.add(block.name);
      }
    } else if (message.role === "toolResult") {
      names.add(message.toolName);
    }
  }

  const taken = new Set([...names].filter((name) => VALID_TOOL_NAME.test(name)));
  const encode = new Map<string, string>();
  const decode = new Map<string, string>();
  // Reserve every valid name first, then allocate aliases in stable order.
  for (const name of [...names].sort()) {
    if (!name || taken.has(name)) continue;
    const base = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
    let alias = base.slice(0, MAX_ALIAS_LENGTH);
    let index = 2;
    while (taken.has(alias)) {
      const suffix = `_${index++}`;
      alias = base.slice(0, MAX_ALIAS_LENGTH - suffix.length) + suffix;
    }
    taken.add(alias);
    encode.set(name, alias);
    decode.set(alias, name);
  }
  if (encode.size === 0) return null;

  const wireContext: Context = {
    ...context,
    tools: context.tools?.map((tool) => encode.has(tool.name) ? { ...tool, name: encode.get(tool.name)! } : tool),
    messages: context.messages.map((message) => {
      if (message.role === "assistant") return renameMessage(message, encode);
      if (message.role === "toolResult" && encode.has(message.toolName)) {
        return { ...message, toolName: encode.get(message.toolName)! };
      }
      return message;
    }),
  };

  return {
    context: wireContext,
    decodeEvent(event: AssistantMessageEvent): AssistantMessageEvent {
      if (event.type === "done") return { ...event, message: renameMessage(event.message, decode) };
      if (event.type === "error") return { ...event, error: renameMessage(event.error, decode) };
      const partial = renameMessage(event.partial, decode);
      if (event.type === "toolcall_end") return { ...event, partial, toolCall: renameCall(event.toolCall, decode) };
      return { ...event, partial };
    },
  };
}
