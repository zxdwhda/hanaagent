import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callText } from "../packages/engine/core/llm-client.ts";
import { compileEditableFacts } from "../packages/engine/lib/memory/compile.ts";
import { processDirtySessions } from "../packages/engine/lib/memory/deep-memory.ts";
import { resolveUserFactProvenance } from "../packages/engine/lib/memory/user-fact-provenance.ts";

vi.mock("../packages/engine/lib/i18n.ts", () => ({ getLocale: () => "zh-CN" }));
vi.mock("../packages/engine/core/llm-client.ts", () => ({ callText: vi.fn() }));

const model = { model: "test", api: "openai-completions", api_key: "unused", base_url: "http://unused" };
const trueStatement = "我喜欢在秋天观察候鸟。";
const assistantSuggestion = "你可以试试养兰花。";
const denied = "我没有兴趣养兰花。";
const knownFact = `用户原话：${trueStatement}`;
const misattributedFact = "用户喜欢养兰花。";
const messages = [
  { role: "assistant", entryId: "a1", content: assistantSuggestion },
  { role: "user", entryId: "u1", content: denied },
  { role: "user", entryId: "u2", content: trueStatement },
];
const project = (source = messages) => ({ messages: source, rootLineageHash: "root", prefixHashes: {} });
const summaryText = (facts: string[]) => [
  "### 重要事实", ...facts.map((fact) => "- " + fact), "### 事情经过", "- 无",
].join("\n");
const verifiedText = summaryText([`[user:u2] ${trueStatement}`]);
const session = {
  session_id: "synthetic-session",
  updated_at: "2026-11-18T01:50:00.000Z",
  summary: summaryText([misattributedFact, trueStatement]),
  cursor: { coveredLeafId: null, lineageHash: "root" },
  userFactProvenance: resolveUserFactProvenance(verifiedText, messages),
};

let directory: string;
let factsPath: string;
let statePath: string;
const userEdit = "- 手工记下：我喜欢清晨散步。\n";

beforeEach(() => {
  vi.resetAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "hana-user-fact-test-"));
  factsPath = path.join(directory, "facts.md");
  statePath = path.join(directory, "editable-facts-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ lastCompiledSummaryUpdatedAt: "2026-11-18T01:00:00.000Z" }));
  fs.writeFileSync(factsPath, userEdit);
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("provenance-aware editable and deep facts", () => {
  it("preserves hand-edited facts and imports only original, verified user language", async () => {
    await compileEditableFacts({ getAllSummaries: () => [session] }, factsPath, model, {
      statePath,
      getCurrentBranchProjection: () => project(),
      requireUserFactProvenance: true,
    });
    expect(vi.mocked(callText)).not.toHaveBeenCalled();
    expect(fs.readFileSync(factsPath, "utf8")).toBe(userEdit + "- " + knownFact);
  });

  it("keeps a prior edit byte-for-byte when the source turn was changed", async () => {
    await compileEditableFacts({ getAllSummaries: () => [session] }, factsPath, model, {
      statePath,
      getCurrentBranchProjection: () => project(messages.slice(0, 2)),
      requireUserFactProvenance: true,
    });
    expect(fs.readFileSync(factsPath, "utf8")).toBe(userEdit);
  });

  it("can add a fact beside a hand-edited section already over the automatic budget", async () => {
    const full = "# 手记\n\n  - " + "已核实的内容".repeat(40) + "\n";
    fs.writeFileSync(factsPath, full);
    await compileEditableFacts({ getAllSummaries: () => [session] }, factsPath, model, {
      statePath,
      getCurrentBranchProjection: () => project(),
      requireUserFactProvenance: true,
    });
    expect(fs.readFileSync(factsPath, "utf8")).toBe(full + "- " + knownFact);
  });

  it.each(["none", "facts", "final state"])("can replace its own saved facts after an interrupted %s write", async (interruption) => {
    const manager = { getAllSummaries: vi.fn().mockReturnValue([session]) };
    const opts = { statePath, getCurrentBranchProjection: vi.fn(() => project()), requireUserFactProvenance: true };
    if (interruption !== "none") {
      let writesToState = 0;
      const rename = fs.renameSync.bind(fs);
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
        if (target === statePath) writesToState++;
        if ((interruption === "facts" && target === factsPath)
          || (interruption === "final state" && target === statePath && writesToState === 2)) {
          throw new Error("interrupted test write");
        }
        rename(source, target);
      });
      try {
        await expect(compileEditableFacts(manager, factsPath, model, opts)).rejects.toThrow("interrupted test write");
      } finally {
        renameSpy.mockRestore();
      }
      const pendingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(pendingState.lastCompiledSummaryUpdatedAt).toBe("2026-11-18T01:00:00.000Z");
      expect(pendingState.pendingAutomaticFacts.facts).toEqual([{ sessionId: session.session_id, line: "- " + knownFact }]);
      expect(fs.readFileSync(factsPath, "utf8")).toBe(interruption === "facts" ? userEdit : userEdit + "- " + knownFact);
    }
    await compileEditableFacts(manager, factsPath, model, opts);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).not.toHaveProperty("pendingAutomaticFacts");

    const corrected = "更正一下，我现在已经不喜欢在秋天观察候鸟了。";
    const correctedMessages = [...messages, { role: "user", entryId: "u3", content: corrected }];
    manager.getAllSummaries.mockReturnValue([{
      ...session,
      updated_at: "2026-11-18T02:00:00.000Z",
      userFactProvenance: resolveUserFactProvenance(summaryText([`[user:u3] ${corrected}`]), correctedMessages),
    }]);
    opts.getCurrentBranchProjection.mockReturnValue(project(correctedMessages));
    await compileEditableFacts(manager, factsPath, model, opts);
    expect(fs.readFileSync(factsPath, "utf8")).toBe(userEdit + "- 用户原话：" + corrected);
  });

  it("retries removal when both automatic blocks share the same last line", async () => {
    const first = {
      ...session,
      session_id: "first-session",
      updated_at: "2026-11-18T02:00:00.000Z",
      userFactProvenance: resolveUserFactProvenance(summaryText([`[user:u1] ${denied}`]), messages),
    };
    const manager = { getAllSummaries: vi.fn().mockReturnValue([session, first]) };
    const opts = { statePath, getCurrentBranchProjection: () => project(), requireUserFactProvenance: true };
    await compileEditableFacts(manager, factsPath, model, opts);
    expect(fs.readFileSync(factsPath, "utf8")).toBe(userEdit + "- 用户原话：" + denied + "\n- " + knownFact);

    manager.getAllSummaries.mockReturnValue([session, {
      ...first,
      updated_at: "2026-11-18T02:10:00.000Z",
      userFactProvenance: resolveUserFactProvenance(summaryText(["无"]), messages),
    }]);
    const rename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === factsPath) throw new Error("interrupted test write");
      rename(source, target);
    });
    try {
      await expect(compileEditableFacts(manager, factsPath, model, opts)).rejects.toThrow("interrupted test write");
    } finally {
      renameSpy.mockRestore();
    }
    await compileEditableFacts(manager, factsPath, model, opts);
    expect(fs.readFileSync(factsPath, "utf8")).toBe(userEdit + "- " + knownFact);
  });

  it("keeps a long verified statement intact instead of discarding it or cutting off a qualifier", async () => {
    const long = "我平时喜欢记录候鸟的迁徙，" + "会定期去林边观察，".repeat(25) + "但最近暂停了。";
    const source = [{ role: "user", entryId: "long", content: long }];
    const longSummary = {
      ...session,
      userFactProvenance: resolveUserFactProvenance(summaryText([`[user:long] ${long}`]), source),
    };
    await compileEditableFacts({ getAllSummaries: () => [longSummary] }, factsPath, model, {
      statePath, getCurrentBranchProjection: () => project(source), requireUserFactProvenance: true,
    });
    expect(fs.readFileSync(factsPath, "utf8")).toBe(userEdit + "- 用户原话：" + long);
  });

  it("uses a model response only for metadata about the verified fact", async () => {
    vi.mocked(callText).mockResolvedValue(JSON.stringify([
      { fact: misattributedFact, tags: ["兴趣"], time: null },
      { fact: knownFact, tags: ["候鸟"], time: null },
    ]));
    const manager = { getDirtySessions: () => [session], markProcessed: vi.fn() };
    const factStore = { addBatch: vi.fn() };
    const result = await processDirtySessions(manager, factStore, model, {
      getCurrentBranchProjection: () => project(),
      requireUserFactProvenance: true,
    });
    expect(result.factsAdded).toBe(1);
    expect(factStore.addBatch).toHaveBeenCalledWith([
      { fact: knownFact, tags: ["候鸟"], time: null, session_id: session.session_id },
    ]);
    expect(vi.mocked(callText).mock.calls[0][0].messages[0].content).not.toContain(misattributedFact);
  });

  it("keeps a legacy pending replacement until a new summary proves it is empty", async () => {
    const legacy = { ...session, userFactProvenance: undefined, factReplacementRequired: true };
    const factStore = { replaceBySession: vi.fn() };
    const manager = { getDirtySessions: vi.fn().mockReturnValue([legacy]), markProcessed: vi.fn() };
    const opts = { getCurrentBranchProjection: () => project(), requireUserFactProvenance: true };
    await processDirtySessions(manager, factStore, model, opts);
    expect(factStore.replaceBySession).not.toHaveBeenCalled();
    expect(manager.markProcessed).not.toHaveBeenCalled();

    manager.getDirtySessions.mockReturnValue([{
      ...legacy,
      userFactProvenance: resolveUserFactProvenance(summaryText(["无"]), messages),
    }]);
    await processDirtySessions(manager, factStore, model, opts);
    expect(factStore.replaceBySession).toHaveBeenCalledWith(session.session_id, []);
    expect(manager.markProcessed).toHaveBeenCalledWith(session.session_id);
  });

  it("does not insert the same source again after it was processed", async () => {
    const manager = {
      getDirtySessions: () => [{ ...session, snapshotUserFactProvenance: session.userFactProvenance }],
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };
    await processDirtySessions(manager, factStore, model, {
      getCurrentBranchProjection: () => project(),
      requireUserFactProvenance: true,
    });
    expect(vi.mocked(callText)).not.toHaveBeenCalled();
    expect(factStore.addBatch).not.toHaveBeenCalled();
    expect(manager.markProcessed).toHaveBeenCalledWith(session.session_id);
  });
});
