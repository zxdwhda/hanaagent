import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callText } from "../packages/engine/core/llm-client.ts";
import { processDirtySessions } from "../packages/engine/lib/memory/deep-memory.ts";

vi.mock("../packages/engine/core/llm-client.ts", () => ({ callText: vi.fn() }));

const model = { model: "test", api: "openai-completions", base_url: "https://synthetic.invalid" };
const fact = { fact: '用户喜欢书名中的 [括号]、{花括号} 和 "引号"。', tags: ["阅读"], time: null };
const array = JSON.stringify([fact]);

async function extractFromModelResponse(output: string) {
  const sessionId = randomUUID();
  vi.mocked(callText).mockResolvedValueOnce(output);
  const summaryManager = {
    getDirtySessions: () => [{
      session_id: sessionId,
      summary: "### 重要事实\n- 用户喜欢读书。",
      snapshot: "",
      updated_at: "2026-11-18T01:01:00Z",
    }],
    markProcessed: vi.fn(),
  };
  const factStore = { addBatch: vi.fn() };
  await processDirtySessions(summaryManager, factStore, model);
  return { sessionId, summaryManager, factStore };
}

describe("deep-memory JSON output", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["pure array", array],
    ["fenced array", ["```json", array, "```"].join("\n")],
    ["leading thought", "<thought>检查事实范围。</thought>\n" + array],
    ["leading prose", "提取出的事实如下：\n" + array],
    ["trailing prose", array + "\n\n以上是这次提取出的事实。"],
    ["trailing prose starting with a quotation", array + '\n\n"阅读"是本次提取的主题。'],
  ])("processes one %s while preserving bracket and quote characters inside its strings", async (_label, output) => {
    const { sessionId, summaryManager, factStore } = await extractFromModelResponse(output);
    expect(factStore.addBatch).toHaveBeenCalledExactlyOnceWith([
      { ...fact, session_id: sessionId },
    ]);
    expect(summaryManager.markProcessed).toHaveBeenCalledExactlyOnceWith(sessionId);
  });

  it("processes an explicit empty array followed by an explanation", async () => {
    const { sessionId, summaryManager, factStore } = await extractFromModelResponse("[]\n\n没有可提取的事实。");
    expect(factStore.addBatch).not.toHaveBeenCalled();
    expect(summaryManager.markProcessed).toHaveBeenCalledExactlyOnceWith(sessionId);
  });

  it.each([
    ["malformed array", '[{"fact": "内容",}]\n说明文字。'],
    ["unterminated array", array.slice(0, -1) + "\n说明文字。"],
    ["unmatched closing bracket", array + "]\n说明文字。"],
    ["second array", "提取结果：\n" + array + "\n\n替代结果：\n[]"],
    ["second object", "提取结果：\n" + array + '\n\n{"fact":"意外的第二份载荷"}'],
    ["second JSON value", array + "\n\nnull"],
    ["a second scalar surrounded by prose", array + "\n说明：\nnull\n以上是全部内容。"],
    ["a second quoted scalar followed by prose", array + '\n"extra output"\n以上是全部内容。'],
    ["a truncated quoted scalar", array + '\n"unfinished'],
  ])("leaves the session retryable for %s", async (_label, output) => {
    const { summaryManager, factStore } = await extractFromModelResponse(output);
    expect(factStore.addBatch).not.toHaveBeenCalled();
    expect(summaryManager.markProcessed).not.toHaveBeenCalled();
  });
});
