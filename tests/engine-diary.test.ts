import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../packages/engine/core/engine.ts";
import { callText } from "../packages/engine/core/llm-client.ts";
import { SessionSummaryManager } from "../packages/engine/lib/memory/session-summary.ts";

vi.mock("../packages/engine/core/llm-client.ts", () => ({ callText: vi.fn() }));

const priorDay = "2026-09-06";
const nextDay = "2026-09-07";

describe("HanaEngine diary requests", () => {
  let root: string;
  let engine: HanaEngine;
  let resolves: ReturnType<typeof vi.fn>;
  let indexes: number;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${nextDay}T03:59:00`));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hana-engine-diary-"));
    engine = Object.create(HanaEngine.prototype);
    engine._agentMgr = {
      getActivityStore: (id: string) => ({ list: () => [{
        startedAt: new Date(`${priorDay}T12:00:00`).getTime(),
        summary: `${id} activity`,
      }] }),
    };
    engine._sessionCoord = {};
    engine._configCoord = { getHomeFolder: (id: string) => path.join(root, id) };
    resolves = vi.fn(async (id) => ({ model: id, api: "openai-completions", api_key: "unused", base_url: "http://unused" }));
    engine._models = { resolveModelWithCredentialsFresh: resolves };
    // Keep a real writer so a duplicate model invocation would produce a second file.
    indexes = 0;
    vi.mocked(callText).mockImplementation(async () => `# Diary ${++indexes}\n\nA fixture diary.`);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function addAgent(id: string) {
    const agentDir = path.join(root, id);
    const sessionDir = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const memoryMdPath = path.join(agentDir, "memory.md");
    fs.writeFileSync(memoryMdPath, `${id} background`);
    const summaryManager = new SessionSummaryManager(path.join(agentDir, "summaries"));
    for (const date of [priorDay, nextDay]) {
      const at = new Date(`${date}T12:00:00`).toISOString();
      summaryManager.saveSummary(`${id}-${date}`, {
        session_id: `${id}-${date}`, summary: `${id} observed birds on ${date}.`, created_at: at, updated_at: at,
      });
    }
    return {
      id,
      sessionDir,
      memoryMdPath,
      summaryManager,
      config: { models: { chat: `${id}-model` } },
      personality: `${id} personality`,
      userName: "Guest",
      agentName: id,
      isSessionMemoryEnabledFor: () => true,
      memoryTicker: { flushSession: vi.fn(async (_sessionPath: string) => {}) },
    };
  }

  function focus(agent: ReturnType<typeof addAgent>) {
    engine._agentMgr.agent = agent;
    engine._agentMgr.activeAgentId = agent.id;
    engine._sessionCoord.currentSessionPath = path.join(agent.sessionDir, "active.jsonl");
  }

  it("writes one diary for concurrent default and explicit requests, but allows a later new request", async () => {
    const agent = addAgent("hana");
    focus(agent);
    const inFlight = Promise.withResolvers<void>();
    vi.mocked(callText).mockImplementation(async () => {
      const index = ++indexes;
      await inFlight.promise;
      return `# Diary ${index}\n\nA fixture diary.`;
    });

    const first = engine.writeDiary();
    const second = engine.writeDiary({ targetDate: priorDay });
    await vi.waitFor(() => expect(callText).toHaveBeenCalled());
    inFlight.resolve();
    const [result, joined] = await Promise.all([first, second]);

    expect(result).toMatchObject({ logicalDate: priorDay });
    expect(joined).toEqual(result);
    expect(callText).toHaveBeenCalledOnce();
    expect(agent.memoryTicker.flushSession).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.dirname(result.filePath))).toHaveLength(1);

    const later = await engine.writeDiary({ targetDate: priorDay });
    expect(later.filePath).not.toBe(result.filePath);
    expect(fs.readdirSync(path.dirname(result.filePath))).toHaveLength(2);
  });

  it("keeps the starting agent, focused session, model, workspace and logical date after switching", async () => {
    const first = addAgent("hana");
    const second = addAgent("riku");
    const paused = Promise.withResolvers<void>();
    first.memoryTicker.flushSession.mockReturnValueOnce(paused.promise);
    focus(first);
    const diary = engine.writeDiary({ targetDate: "invalid-explicit-date" });

    focus(second);
    vi.setSystemTime(new Date(`${nextDay}T04:01:00`));
    paused.resolve();

    const result = await diary;
    expect(first.memoryTicker.flushSession).toHaveBeenCalledWith(path.join(first.sessionDir, "active.jsonl"));
    expect(second.memoryTicker.flushSession).not.toHaveBeenCalled();
    expect(resolves).toHaveBeenCalledWith("hana-model");
    expect(result).toMatchObject({ logicalDate: priorDay });
    expect(result.filePath).toContain(path.join(root, first.id));
    expect(vi.mocked(callText).mock.calls[0][0].messages[0].content).toContain("hana activity");
    expect(vi.mocked(callText).mock.calls[0][0].messages[0].content).not.toContain("riku");
  });

  it("allows different dates and agents to write independently", async () => {
    const first = addAgent("hana");
    const second = addAgent("riku");
    focus(first);
    const one = engine.writeDiary({ targetDate: priorDay });
    const two = engine.writeDiary({ targetDate: nextDay });
    focus(second);
    const three = engine.writeDiary({ targetDate: priorDay });

    const results = await Promise.all([one, two, three]);
    expect(callText).toHaveBeenCalledTimes(3);
    expect(new Set(results.map((entry) => entry.filePath)).size).toBe(3);
    expect(results.map((entry) => entry.logicalDate)).toEqual([priorDay, nextDay, priorDay]);
  });

  it("releases the shared job after a failure so a retry can proceed", async () => {
    const agent = addAgent("hana");
    focus(agent);
    resolves.mockRejectedValueOnce(new Error("fixture credentials unavailable"));
    const results = await Promise.allSettled([engine.writeDiary(), engine.writeDiary()]);
    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "fixture credentials unavailable" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "fixture credentials unavailable" }) },
    ]);
    expect(callText).not.toHaveBeenCalled();

    await expect(engine.writeDiary()).resolves.toMatchObject({ logicalDate: priorDay });
    expect(callText).toHaveBeenCalledOnce();
  });
});
