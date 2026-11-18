import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCoordinator } from "../packages/engine/core/session-coordinator.ts";
import { SessionManifestStore } from "../packages/engine/core/session-manifest/store.ts";
import { callText } from "../packages/engine/core/llm-client.ts";
import { FactStore } from "../packages/engine/lib/memory/fact-store.ts";
import { createMemoryTicker } from "../packages/engine/lib/memory/memory-ticker.ts";
import { SessionSummaryManager } from "../packages/engine/lib/memory/session-summary.ts";
import { resolveUserFactProvenance } from "../packages/engine/lib/memory/user-fact-provenance.ts";

vi.mock("../packages/engine/core/llm-client.ts", () => ({ callText: vi.fn() }));
vi.mock("../packages/engine/lib/i18n.ts", async (importOriginal) => ({
  ...await importOriginal<object>(),
  getLocale: () => "zh-CN",
}));
vi.mock("../packages/engine/lib/memory/compile.ts", async (importOriginal) => ({
  ...await importOriginal<object>(),
  compileDaily: vi.fn(async () => "skipped"),
  compileToday: vi.fn(async () => "skipped"),
  rollDailyWindow: vi.fn(async () => ({ failed: [] })),
}));

const SYNTHETIC_FACT = "我喜欢观察候鸟。";
const DISCARDED_BRANCH = "我喜欢组装钟表。";
const ANNOTATED = `### 重要事实\n- [user:user-current] ${SYNTHETIC_FACT}\n\n### 事情经过\n- 无`;
const VALID_FACT = `用户原话：${SYNTHETIC_FACT}`;

describe("memory recovery of archived sessions through their manifest", () => {
  let tempDir: string;
  let manifestStore: SessionManifestStore;
  let factStore: FactStore;
  let ticker: ReturnType<typeof createMemoryTicker>;
  let modelOperations: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hana-archived-memory-")));
    modelOperations = [];
    vi.mocked(callText).mockImplementation(async ({ usageContext }) => {
      const operation = (usageContext as { source: { operation: string } }).source.operation;
      modelOperations.push(operation);
      if (operation === "rolling_summary") return ANNOTATED;
      if (operation === "extract_facts") return JSON.stringify([{ fact: VALID_FACT, tags: [], time: null }]);
      throw new Error(`Unexpected model operation for fixture: ${operation}`);
    });
  });

  afterEach(async () => {
    await ticker?.stop();
    factStore?.close();
    manifestStore?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function archiveSession({ withCursor = false, invalidBranch = false, unresolved = false, startActive = false } = {}) {
    const agentId = "hana";
    const agentsDir = path.join(tempDir, "agents");
    const agentDir = path.join(agentsDir, agentId);
    const sessionDir = path.join(agentDir, "sessions");
    const memoryDir = path.join(agentDir, "memory");
    const activePath = path.join(sessionDir, "history.jsonl");
    const archivedPath = path.join(sessionDir, "archived", "history.jsonl");
    const oldTimestamp = "2026-06-03T10:00:00.000Z";
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(activePath, [
      { type: "session", id: "history", version: 3, cwd: agentDir, timestamp: oldTimestamp },
      { type: "message", id: "user-current", parentId: null, timestamp: oldTimestamp, message: { role: "user", content: SYNTHETIC_FACT } },
      { type: "message", id: "user-discarded", parentId: null, timestamp: oldTimestamp, message: { role: "user", content: DISCARDED_BRANCH } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    fs.utimesSync(activePath, new Date(oldTimestamp), new Date(oldTimestamp));

    manifestStore = new SessionManifestStore({ dbPath: path.join(tempDir, "manifest.db") });
    const { sessionId } = manifestStore.createForPath({ sessionPath: activePath, ownerAgentId: agentId, domain: "desktop" });
    manifestStore.setBranchHead(sessionId, { leafId: "user-current", observedTailLeafId: "user-discarded", reason: "archive_fixture" });
    const coordinator = new SessionCoordinator({
      agentsDir,
      agentIdFromSessionPath: () => agentId,
      getActiveAgentId: () => agentId,
      getConfig: () => ({}),
      sessionManifestStore: manifestStore,
    });
    const archive = async () => {
      fs.renameSync(activePath, archivedPath);
      await coordinator.moveSessionLifecycle({ fromPath: activePath, toPath: archivedPath, lifecycle: "archived" });
    };
    if (!startActive) await archive();

    const projection = coordinator.getSessionBranchProjection(startActive ? activePath : archivedPath);
    const summaryManager = new SessionSummaryManager(path.join(memoryDir, "summaries"));
    const updatedAt = new Date(Date.now() - 60_000).toISOString();
    summaryManager.saveSummary(sessionId, {
      session_id: sessionId,
      summary: "### 重要事实\n- 旧摘要\n\n### 事情经过\n- 无",
      snapshot: "以前的快照",
      updated_at: updatedAt,
      messageCount: 1,
      factReplacementRequired: true,
      ...(withCursor ? {
        cursor: { coveredLeafId: projection.selectedLeafId, lineageHash: projection.lineageHash },
        userFactProvenance: unresolved
          ? { status: "unresolved", candidates: [] }
          : resolveUserFactProvenance(ANNOTATED, projection.messages),
      } : {}),
    });
    if (invalidBranch) {
      manifestStore.setBranchHead(sessionId, { leafId: "missing", observedTailLeafId: "user-discarded", reason: "archive_fixture_missing" });
    }
    factStore = new FactStore(path.join(memoryDir, "facts.db"));
    ticker = createMemoryTicker({
      agentId,
      agentDir,
      configPath: path.join(agentDir, "config.yaml"),
      sessionDir,
      memoryDir,
      summaryManager,
      factStore,
      getResolvedMemoryModel: () => ({ model: "fixture", api: "openai-completions", api_key: "unused", base_url: "http://unused" }),
      isSessionMemoryEnabled: (filePath) => coordinator.getSessionMemoryEnabled(filePath),
      getSessionIdForPath: (filePath) => manifestStore.resolveByLocatorPath(filePath)?.sessionId,
      getSessionManifest: (id) => manifestStore.getBySessionId(id),
      getSessionBranchHeadForPath: () => manifestStore.getBranchHead(sessionId),
      readSessionBranchForPath: (filePath, options) => coordinator.getSessionBranchProjection(filePath, options),
      memoryMdPath: path.join(memoryDir, "memory.md"),
      todayMdPath: path.join(memoryDir, "today.md"),
      weekMdPath: path.join(memoryDir, "week.md"),
      longtermMdPath: path.join(memoryDir, "longterm.md"),
      factsMdPath: path.join(memoryDir, "facts.md"),
    });
    return { activePath, archivedPath, archive, sessionId, summaryManager };
  }

  it("recovers an archived replacement with an existing cursor without another rolling summary", async () => {
    const { sessionId, summaryManager } = await archiveSession({ withCursor: true });
    await ticker.tick();

    expect(factStore.getBySession(sessionId).map((row) => row.fact)).toEqual([VALID_FACT]);
    expect(modelOperations).toEqual(["extract_facts"]);
    expect(summaryManager.getSummary(sessionId)?.factReplacementRequired).toBe(false);
  });

  it("rebuilds an archived replacement missing a cursor from the manifest-selected branch", async () => {
    const { sessionId, summaryManager } = await archiveSession();
    await ticker.tick();
    await ticker.tick();

    expect(factStore.getBySession(sessionId).map((row) => row.fact)).toEqual([VALID_FACT]);
    expect(modelOperations).toEqual(["rolling_summary", "extract_facts"]);
    expect(summaryManager.getSummary(sessionId)).toMatchObject({
      factReplacementRequired: false,
      cursor: { coveredLeafId: "user-current" },
    });
    expect(JSON.stringify(vi.mocked(callText).mock.calls[0][0].messages)).not.toContain(DISCARDED_BRANCH);
  });

  it("rebuilds archived provenance even when its recorded cursor still matches", async () => {
    const { sessionId, summaryManager } = await archiveSession({ withCursor: true, unresolved: true });
    await ticker.tick();
    await ticker.tick();

    expect(modelOperations).toEqual(["rolling_summary", "extract_facts"]);
    expect(factStore.getBySession(sessionId).map((row) => row.fact)).toEqual([VALID_FACT]);
    expect(summaryManager.getSummary(sessionId)?.factReplacementRequired).toBe(false);
  });

  it("finishes an in-memory replacement that failed while active and moved to the archive", async () => {
    const { activePath, archive, sessionId, summaryManager } = await archiveSession({ withCursor: true, startActive: true });
    vi.mocked(callText).mockRejectedValueOnce(new Error("fixture temporarily unreachable"));
    await ticker.notifyBranchChanged(activePath);
    expect(summaryManager.getSummary(sessionId)?.factReplacementRequired).toBe(true);
    expect(vi.mocked(callText)).toHaveBeenCalledOnce();
    await archive();

    await ticker.tick();
    await ticker.tick();

    expect(modelOperations).toEqual(["extract_facts"]);
    expect(factStore.getBySession(sessionId).map((row) => row.fact)).toEqual([VALID_FACT]);
    expect(summaryManager.getSummary(sessionId)?.factReplacementRequired).toBe(false);
  });

  it("does not call the model or replace facts if the archive has no usable branch proof", async () => {
    const { sessionId, summaryManager } = await archiveSession({ withCursor: true, invalidBranch: true });
    await ticker.tick();
    await ticker.tick();

    expect(modelOperations).toEqual([]);
    expect(factStore.getBySession(sessionId)).toEqual([]);
    expect(summaryManager.getSummary(sessionId)?.factReplacementRequired).toBe(true);
  });

  it("does not recover a restored copy at a former active locator if the archive is unavailable", async () => {
    const { activePath, archivedPath, sessionId, summaryManager } = await archiveSession();
    fs.copyFileSync(archivedPath, activePath);
    fs.rmSync(archivedPath);
    expect(manifestStore.resolveByLocatorPath(activePath)?.sessionId).toBe(sessionId);

    await ticker.tick();
    await ticker.tick();

    expect(modelOperations).toEqual([]);
    expect(factStore.getBySession(sessionId)).toEqual([]);
    expect(summaryManager.getSummary(sessionId)?.factReplacementRequired).toBe(true);
  });
});
