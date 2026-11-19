import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { guardAssistantMessageStream, installAssistantStreamGuard } from "../packages/engine/lib/pi-sdk/stream-guard.ts";

afterEach(() => vi.unstubAllGlobals());

function makeStream(events, result) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: vi.fn(async () => result),
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

function assistantMessage(content) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("Pi SDK stream guard", () => {
  it("uses unique names on the Qiniu Kimi wire and restores the tool call before execution and replay", async () => {
    const model = {
      id: "moonshotai/kimi-k3",
      name: "Kimi",
      provider: "custom-qiniu",
      api: "openai-completions",
      baseUrl: "https://api.qnaigc.com/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as const;
    const wirePayloads = [];
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      wirePayloads.push(body);
      const toolNames = body.tools.map((tool) => tool.function.name);
      if (toolNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
        return Response.json({ error: { message: "tools[].function.name is invalid" } }, { status: 400 });
      }
      const alias = toolNames[0];
      const chunk = (delta, finish_reason = null) => ({
        id: "chatcmpl-fixture", object: "chat.completion.chunk", model: model.id, created: 1,
        choices: [{ index: 0, delta, finish_reason }],
      });
      return new Response([
        chunk({ role: "assistant", tool_calls: [{
          index: 0,
          id: "call_fixture",
          type: "function",
          function: { name: alias, arguments: '{"document":"sample"}' },
        }] }),
        chunk({}, "tool_calls"),
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const agent = { streamFn: streamSimple as any };
    installAssistantStreamGuard({ agent });
    const toolName = "office_read-document";
    const existingName = "office_read_document";
    const context = {
      messages: [{ role: "user", content: "Read the sample", timestamp: 1 }],
      tools: [toolName, existingName].map((name) => ({
        name, description: "Read a document", parameters: { type: "object" },
      })),
    };

    const first = await collect(await agent.streamFn(model, context, { apiKey: "fixture" }));
    expect(first.result.stopReason).toBe("toolUse");
    const toolCall = first.result.content.find(({ type }) => type === "toolCall");
    expect(toolCall).toMatchObject({ id: "call_fixture", name: toolName, arguments: { document: "sample" } });
    expect(first.events.find(({ type }) => type === "toolcall_end")?.toolCall.name).toBe(toolName);
    const alias = wirePayloads[0].tools[0].function.name;
    expect(alias).not.toBe(existingName);
    expect(wirePayloads[0].tools[1].function.name).toBe(existingName);
    expect(context.tools[0].name).toBe(toolName);

    const replay = { ...context, messages: [...context.messages, first.result, {
      role: "toolResult", toolCallId: toolCall.id, toolName, isError: false,
      content: [{ type: "text", text: "sample text" }], timestamp: 2,
    }] };
    await collect(await agent.streamFn(model, replay, { apiKey: "fixture" }));
    expect(wirePayloads[1].messages.find(({ tool_calls }) => tool_calls)?.tool_calls[0]).toMatchObject({
      id: "call_fixture",
      function: { name: alias },
    });
    expect(wirePayloads[1].messages.find(({ role }) => role === "tool")?.tool_call_id).toBe("call_fixture");
    expect(toolCall.name).toBe(toolName);

    await collect(await agent.streamFn({ ...model, id: "z-ai/glm-5.3" }, context, { apiKey: "fixture" }));
    expect(wirePayloads[2].tools[0].function.name).toBe(toolName);
  });

  it("drops empty-name tool calls before the agent loop can execute them", async () => {
    const invalidTool = { type: "toolCall", id: "call_empty", name: "", arguments: {}, partialArgs: "" };
    const finalMessage = assistantMessage([invalidTool]);
    const inner = makeStream([
      { type: "start", partial: assistantMessage([]) },
      { type: "toolcall_start", contentIndex: 0, partial: assistantMessage([invalidTool]) },
      { type: "toolcall_delta", contentIndex: 0, delta: "", partial: assistantMessage([invalidTool]) },
      { type: "toolcall_end", contentIndex: 0, toolCall: invalidTool, partial: assistantMessage([invalidTool]) },
      { type: "done", reason: "stop", message: finalMessage },
    ], finalMessage);

    const { events, result } = await collect(guardAssistantMessageStream(inner));

    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(result.content).toEqual([]);
  });

  it("recovers plain text that a provider reported as an empty-name tool call", async () => {
    const invalidTool = {
      type: "toolCall",
      id: "call_empty",
      name: "",
      arguments: {},
      partialArgs: "正文里提到 <tool_call> 标签时，后续内容也应继续显示。",
    };
    const finalMessage = assistantMessage([invalidTool]);
    const inner = makeStream([
      { type: "start", partial: assistantMessage([]) },
      { type: "toolcall_start", contentIndex: 0, partial: assistantMessage([invalidTool]) },
      { type: "toolcall_end", contentIndex: 0, toolCall: invalidTool, partial: assistantMessage([invalidTool]) },
      { type: "done", reason: "stop", message: finalMessage },
    ], finalMessage);

    const { events, result } = await collect(guardAssistantMessageStream(inner));

    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(events.find((event) => event.type === "text_delta")?.delta).toBe("正文里提到 <tool_call> 标签时，后续内容也应继续显示。");
    expect(result.content).toEqual([
      { type: "text", text: "正文里提到 <tool_call> 标签时，后续内容也应继续显示。" },
    ]);
  });

  it("recovers backtick text streamed through empty-name tool call deltas", async () => {
    const startTool = {
      type: "toolCall",
      id: "call_empty_backtick",
      name: "",
      arguments: {},
      partialArgs: "`",
    };
    const deltaTool = {
      ...startTool,
      partialArgs: "`inline code` 后续文字",
    };
    const endTool = {
      ...startTool,
      partialArgs: "",
    };
    const finalMessage = assistantMessage([endTool]);
    const inner = makeStream([
      { type: "start", partial: assistantMessage([]) },
      { type: "toolcall_start", contentIndex: 0, partial: assistantMessage([startTool]) },
      { type: "toolcall_delta", contentIndex: 0, delta: "inline code", partial: assistantMessage([deltaTool]) },
      { type: "toolcall_delta", contentIndex: 0, delta: "` 后续文字", partial: assistantMessage([deltaTool]) },
      { type: "toolcall_end", contentIndex: 0, toolCall: endTool, partial: assistantMessage([endTool]) },
      { type: "done", reason: "stop", message: finalMessage },
    ], finalMessage);

    const { events, result } = await collect(guardAssistantMessageStream(inner));

    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(events.find((event) => event.type === "text_delta")?.delta).toBe("`inline code` 后续文字");
    expect(result.content).toEqual([
      { type: "text", text: "`inline code` 后续文字" },
    ]);
  });

  it("does NOT recover tool-protocol XML fragments as visible text (#1293)", async () => {
    // 模型尝试发起工具调用、SDK 抽 name 失败 → partialArgs 是工具协议 XML，
    // 不是 prose，不能回写成可见文本，否则 Bridge 会泄漏 <tool_calls>/<invoke>。
    const invalidTool = {
      type: "toolCall",
      id: "call_toolxml",
      name: "",
      arguments: {},
      partialArgs: '<tool_calls><invoke name="bash"><parameter name="command">ls -la</parameter></invoke></tool_calls>',
    };
    const finalMessage = assistantMessage([invalidTool]);
    const inner = makeStream([
      { type: "start", partial: assistantMessage([]) },
      { type: "toolcall_start", contentIndex: 0, partial: assistantMessage([invalidTool]) },
      { type: "toolcall_end", contentIndex: 0, toolCall: invalidTool, partial: assistantMessage([invalidTool]) },
      { type: "done", reason: "stop", message: finalMessage },
    ], finalMessage);

    const { events, result } = await collect(guardAssistantMessageStream(inner));

    // 不应产生任何 text_* 事件
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(result.content).toEqual([]);
  });

  it("does NOT recover bare <invoke / channel-marker fragments", async () => {
    const invalidTool = {
      type: "toolCall",
      id: "call_invoke",
      name: "",
      arguments: {},
      partialArgs: '<invoke name="read"><parameter name="path">a.txt',
    };
    const finalMessage = assistantMessage([invalidTool]);
    const inner = makeStream([
      { type: "start", partial: assistantMessage([]) },
      { type: "toolcall_end", contentIndex: 0, toolCall: invalidTool, partial: assistantMessage([invalidTool]) },
      { type: "done", reason: "stop", message: finalMessage },
    ], finalMessage);

    const { events, result } = await collect(guardAssistantMessageStream(inner));
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(result.content).toEqual([]);
  });

  it("does NOT recover antml / DSML / full-width tool protocol fragments as visible text", async () => {
    const cases = [
      '<antml:function_calls><antml:invoke name="bash"><antml:parameter name="command">pwd',
      '<dsml:tool_call name="browser.open"><dsml:parameter name="url">https://example.com',
      '＜tool_calls＞＜invoke name＝＂bash＂＞pwd',
    ];

    for (const [index, partialArgs] of cases.entries()) {
      const invalidTool = {
        type: "toolCall",
        id: `call_protocol_${index}`,
        name: "",
        arguments: {},
        partialArgs,
      };
      const finalMessage = assistantMessage([invalidTool]);
      const inner = makeStream([
        { type: "start", partial: assistantMessage([]) },
        { type: "toolcall_end", contentIndex: 0, toolCall: invalidTool, partial: assistantMessage([invalidTool]) },
        { type: "done", reason: "stop", message: finalMessage },
      ], finalMessage);

      const { events, result } = await collect(guardAssistantMessageStream(inner));
      expect(events.map((event) => event.type)).toEqual(["start", "done"]);
      expect(result.content).toEqual([]);
    }
  });

  it("leaves valid tool calls untouched", async () => {
    const validTool = { type: "toolCall", id: "call_read", name: "read", arguments: { path: "a.txt" }, partialArgs: "{\"path\":\"a.txt\"}" };
    const finalMessage = assistantMessage([validTool]);
    const inner = makeStream([
      { type: "start", partial: assistantMessage([]) },
      { type: "toolcall_start", contentIndex: 0, partial: assistantMessage([validTool]) },
      { type: "toolcall_end", contentIndex: 0, toolCall: validTool, partial: assistantMessage([validTool]) },
      { type: "done", reason: "stop", message: finalMessage },
    ], finalMessage);

    const { events, result } = await collect(guardAssistantMessageStream(inner));

    expect(events.map((event) => event.type)).toEqual(["start", "toolcall_start", "toolcall_end", "done"]);
    expect(result.content).toEqual([validTool]);
  });
});
