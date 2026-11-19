import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assemble,
  compileEditableFacts,
  compileToday,
  TODAY_STATE_SCHEMA_VERSION,
} from "../packages/engine/lib/memory/compile.ts";

const model = {
  api: "openai-completions",
  base_url: "https://synthetic.invalid/v1",
  model: "test-memory-compiler",
};
const todayDate = "2026-11-18";
const yesterdayDate = "2026-11-17";
const todayDraft = "上午：用户喜欢观鸟。";
const facts = "用户喜欢观鸟。";
const validToday = "下午：用户关注「阳台能种罗勒吗？」这一主题。";
const validFacts = "用户喜欢观鸟和种植香草";
const cnRefusal = "收到，但没有上一版草稿。\n\n为了先整理今天的内容，我需要你提供更多时间线条目。";
const enRefusal = "I don't have enough source material. Could you provide the previous draft?";

function providerResponse(text: string, finishReason: string) {
  return Response.json({ choices: [{ message: { content: text }, finish_reason: finishReason }] });
}

describe("memory compile output integrity", () => {
  let directory: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 18, 16));
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hana-memory-output-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([true, false])("clamps the wire output budget to a small model limit (reasoning=%s)", async (reasoning) => {
    const outputPath = path.join(directory, "facts.md");
    fs.writeFileSync(outputPath, facts);
    fs.writeFileSync(path.join(directory, "editable-facts-state.json"), JSON.stringify({
      lastCompiledSummaryUpdatedAt: new Date(2026, 10, 18, 13).toISOString(),
    }));
    const manager = {
      getAllSummaries: () => [{
        session_id: "garden",
        updated_at: new Date().toISOString(),
        summary: "### 重要事实\n- 用户喜欢观鸟和种植香草。",
      }],
    };
    const lowBudgetModel = { ...model, model: { id: model.model, maxTokens: 256, reasoning } };
    const fetchModel = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return request.max_tokens === 256
        ? providerResponse(validFacts, "stop")
        : Response.json({ error: { message: "output budget exceeds model limit" } }, { status: 400 });
    });

    await expect(compileEditableFacts(manager, outputPath, lowBudgetModel)).resolves.toBe("compiled");
    expect(fetchModel).toHaveBeenCalledOnce();
    expect(fs.readFileSync(outputPath, "utf8")).toBe(validFacts);
  });

  it.each([
    { target: "today", response: cnRefusal, finish: "stop", error: "conversational reply" },
    {
      target: "today",
      response: "目前没有收到『上一版今日草稿』。需要我基于上一版草稿整合的话，请把草稿发我。",
      finish: "stop",
      error: "conversational reply",
    },
    { target: "today", response: cnRefusal, finish: "stop", error: "conversational reply", dayChanged: true },
    { target: "today", response: "下午：用户最近关注的是", finish: "length", error: "(length)" },
    { target: "facts", response: enRefusal, finish: "stop", error: "conversational reply" },
    { target: "facts", response: "用户喜欢观鸟，也在研究", finish: "length", error: "(length)" },
    { target: "facts", response: "## 重要事实", finish: "stop", error: "no memory content" },
  ])("holds the $target checkpoint for $error with dayChanged=$dayChanged", async ({
    target, response, finish, error, dayChanged,
  }) => {
    const todayPath = path.join(directory, "today.md");
    const factsPath = path.join(directory, "facts.md");
    const isToday = target === "today";
    const outputPath = isToday ? todayPath : factsPath;
    const statePath = path.join(directory, isToday ? "today-state.json" : "editable-facts-state.json");
    const state = JSON.stringify({
      ...(isToday ? {
        logicalDate: dayChanged ? yesterdayDate : todayDate,
        schemaVersion: TODAY_STATE_SCHEMA_VERSION,
      } : {}),
      lastCompiledSummaryUpdatedAt: new Date(2026, 10, dayChanged ? 17 : 18, 13).toISOString(),
    });
    fs.writeFileSync(todayPath, todayDraft);
    fs.writeFileSync(factsPath, facts);
    fs.writeFileSync(statePath, state);
    const summaryUpdatedAt = new Date(2026, 10, 18, 15).toISOString();
    const manager = {
      getAllSummaries: () => [{
        session_id: "garden",
        updated_at: summaryUpdatedAt,
        summary: "### 重要事实\n- 用户喜欢种植香草。\n\n### 事情经过\n- 2026-11-18 15:00 用户讨论香草种植。",
      }],
    };
    const valid = isToday ? validToday : validFacts;
    const fetchModel = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(providerResponse(response, finish))
      .mockResolvedValueOnce(providerResponse(valid, "stop"));
    const compile = () => isToday
      ? compileToday(manager, todayPath, model)
      : compileEditableFacts(manager, factsPath, model);

    await expect(compile()).rejects.toThrow(error);

    expect(fs.readFileSync(outputPath, "utf8")).toBe(isToday ? (dayChanged ? "" : todayDraft) : facts);
    expect(fs.readFileSync(statePath, "utf8")).toBe(state);
    const memoryPath = path.join(directory, "memory.md");
    assemble(factsPath, todayPath, path.join(directory, "week.md"), path.join(directory, "longterm.md"), memoryPath);
    const memory = fs.readFileSync(memoryPath, "utf8");
    expect(memory).toContain(facts);
    if (error !== "no memory content") expect(memory).not.toContain(response);
    if (dayChanged) {
      const modelRequest = fetchModel.mock.calls[0][1]?.body;
      expect(modelRequest).not.toContain(todayDraft);
    }

    await expect(compile()).resolves.toBe("compiled");
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(valid);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).lastCompiledSummaryUpdatedAt).toBe(summaryUpdatedAt);
  });
});
