/**
 * session-meta 运行期隔离记录：_quarantineOversizedSessionMeta 成功 rename 后
 * 必须把隔离详情记进内存态 _metaQuarantines，供 engine.getSessionMetadataRecoveryStatus()
 * 聚合成侧边栏"部分会话待恢复"提示。
 */
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../packages/engine/lib/pi-sdk/index.js", () => ({
  createAgentSession: vi.fn(),
  emitSessionShutdown: vi.fn(),
  SessionManager: {
    create: vi.fn(),
    list: vi.fn(),
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  resizeModelImageInput: vi.fn(async (image) => image),
  formatModelImageDimensionNote: vi.fn(() => undefined),
  refreshSessionModelFromRegistry: vi.fn(),
}));

vi.mock("../packages/engine/lib/debug-log.js", () => ({
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SessionCoordinator } from "../packages/engine/core/session-coordinator.ts";

function minimalCoordinator(agentsDir = "/tmp/agents") {
  return new SessionCoordinator({
    agentsDir,
    getAgent: () => null,
    getActiveAgentId: () => "hana",
    getModels: () => ({ currentModel: null, authStorage: {}, modelRegistry: {}, resolveThinkingLevel: () => "medium" }),
    getResourceLoader: () => ({}),
    getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }),
    emitEvent: () => {},
    getHomeCwd: () => "/tmp/home",
    agentIdFromSessionPath: () => "hana",
    switchAgentOnly: async () => {},
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map(),
    getActivityStore: () => null,
    getAgentById: () => null,
    listAgents: () => [{ id: "hana", name: "Hana" }],
  });
}

describe("SessionCoordinator meta quarantine bookkeeping", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-coord-meta-quarantine-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeHistoryFixture() {
    const agentsDir = path.join(tmpDir, "agents");
    const sessionDir = path.join(agentsDir, "hana", "sessions");
    const sessionPath = path.join(sessionDir, "history.jsonl");
    const metaPath = path.join(sessionDir, "session-meta.json");
    const history = [
      { type: "session", id: "history", cwd: tmpDir, timestamp: "2026-04-29T07:00:00.000Z" },
      { type: "message", id: "u1", timestamp: "2026-04-29T07:01:00.000Z", message: { role: "user", content: "hello" } },
    ].map((entry) => `${JSON.stringify(entry)}\n`).join("");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, history);
    return { coordinator: minimalCoordinator(agentsDir), sessionPath, metaPath, history };
  }

  it("lists JSONL history and preserves an oversized index without reading it", async () => {
    const { coordinator, sessionPath, metaPath, history } = writeHistoryFixture();
    const size = 64 * 1024 * 1024 + 1;
    fs.writeFileSync(metaPath, "{}");
    fs.truncateSync(metaPath, size);
    const readFile = vi.spyOn(fsp, "readFile");

    expect(await coordinator.listSessions()).toMatchObject([{ path: sessionPath, firstMessage: "hello" }]);
    expect(readFile).not.toHaveBeenCalledWith(metaPath, expect.anything());
    const [quarantine] = coordinator.listMetaQuarantines();
    expect(quarantine).toMatchObject({ metaPath });
    expect(fs.statSync(quarantine.backupPath).size).toBe(size);

    await coordinator.writeSessionMeta(sessionPath, { memoryEnabled: false });
    expect(JSON.parse(fs.readFileSync(metaPath, "utf8"))).toEqual({ "history.jsonl": { memoryEnabled: false } });
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(history);
  });

  it.each(["{truncated", "null", "[]"])("preserves invalid index %s before rebuilding it", async (raw) => {
    const { coordinator, sessionPath, metaPath, history } = writeHistoryFixture();
    fs.writeFileSync(metaPath, raw);

    expect(await coordinator.listSessions()).toMatchObject([{ path: sessionPath, firstMessage: "hello" }]);
    await coordinator.writeSessionMeta(sessionPath, { memoryEnabled: false });

    const [quarantine] = coordinator.listMetaQuarantines();
    expect(quarantine).toMatchObject({ metaPath });
    expect(fs.readFileSync(quarantine.backupPath, "utf8")).toBe(raw);
    expect(JSON.parse(fs.readFileSync(metaPath, "utf8"))).toEqual({ "history.jsonl": { memoryEnabled: false } });
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(history);
  });

  it("lists history from the index without loading unrelated prompt sidecars", async () => {
    const { coordinator, sessionPath, metaPath } = writeHistoryFixture();
    const emptySessionPath = path.join(path.dirname(sessionPath), "empty.jsonl");
    fs.writeFileSync(emptySessionPath, `${JSON.stringify({ type: "session", id: "empty", cwd: tmpDir })}\n`);
    const promptSnapshot = { finalSystemPrompt: "frozen prompt" };
    await coordinator.writeSessionMeta(sessionPath, { projectId: "example", promptSnapshot });
    await coordinator.writeSessionMeta(emptySessionPath, { promptSnapshot: { finalSystemPrompt: "other prompt" } });
    const index = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const payloadPath = path.join(path.dirname(metaPath), index["history.jsonl"].promptSnapshot.path);
    const otherPayloadPath = path.join(path.dirname(metaPath), index["empty.jsonl"].promptSnapshot.path);
    const readFile = vi.spyOn(fsp, "readFile");

    expect(await coordinator.listSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: sessionPath, firstMessage: "hello", projectId: "example" }),
      expect.objectContaining({ path: emptySessionPath, messageCount: 0 }),
    ]));
    expect(readFile).not.toHaveBeenCalledWith(payloadPath, expect.anything());
    expect(await coordinator._readSessionMetaEntryCached(metaPath, sessionPath)).toMatchObject({ promptSnapshot });
    expect(readFile).toHaveBeenCalledWith(payloadPath, expect.anything());
    expect(readFile).not.toHaveBeenCalledWith(otherPayloadPath, expect.anything());
  });

  it("keeps the complete prior index if compaction cannot publish it", async () => {
    const { coordinator, sessionPath, metaPath } = writeHistoryFixture();
    const raw = JSON.stringify({ "history.jsonl": { promptSnapshot: { finalSystemPrompt: "p".repeat(1024 * 1024) } } });
    fs.writeFileSync(metaPath, raw);
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (source, dest) => {
      if (dest === metaPath) throw Object.assign(new Error("injected failure"), { code: "EIO" });
      await rename(source, dest);
    });

    expect(await coordinator.listSessions()).toMatchObject([{ path: sessionPath, firstMessage: "hello" }]);
    expect(fs.readFileSync(metaPath, "utf8")).toBe(raw);
    expect(fs.readdirSync(path.dirname(metaPath)).some((file) => file.startsWith("session-meta.json.tmp-"))).toBe(false);
    expect(coordinator.listMetaQuarantines()).toEqual([]);
  });

  it("keeps the referenced payload and removes staged files if an update cannot publish its index", async () => {
    const { coordinator, sessionPath, metaPath } = writeHistoryFixture();
    const prior = { finalSystemPrompt: "old prompt" };
    await coordinator.writeSessionMeta(sessionPath, { promptSnapshot: prior });
    const raw = fs.readFileSync(metaPath, "utf8");
    const payloadDir = path.join(path.dirname(metaPath), "session-meta-payloads");
    const priorFiles = fs.readdirSync(payloadDir);
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (source, dest) => {
      if (dest === metaPath) throw Object.assign(new Error("injected failure"), { code: "EIO" });
      await rename(source, dest);
    });

    await coordinator.writeSessionMeta(sessionPath, { promptSnapshot: { finalSystemPrompt: "new prompt" } });

    expect(await coordinator._readSessionMetaEntryCached(metaPath, sessionPath)).toMatchObject({ promptSnapshot: prior });
    expect(fs.readFileSync(metaPath, "utf8")).toBe(raw);
    expect(fs.readdirSync(payloadDir)).toEqual(priorFiles);
  });

  it("keeps a replaced payload until readers of the prior index have finished", async () => {
    const { coordinator, sessionPath, metaPath } = writeHistoryFixture();
    const prior = { finalSystemPrompt: "old prompt" };
    const next = { finalSystemPrompt: "new prompt" };
    await coordinator.writeSessionMeta(sessionPath, { promptSnapshot: prior });
    const index = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const priorPayloadPath = path.join(path.dirname(metaPath), index["history.jsonl"].promptSnapshot.path);
    const enteredRead = Promise.withResolvers<void>();
    const resumeRead = Promise.withResolvers<void>();
    const readFile = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
      if (args[0] === priorPayloadPath) {
        enteredRead.resolve();
        await resumeRead.promise;
      }
      return readFile(...args);
    });

    const oldRead = coordinator._readSessionMetaEntryCached(metaPath, sessionPath);
    await enteredRead.promise;
    try {
      await coordinator.writeSessionMeta(sessionPath, { promptSnapshot: next });
      expect(fs.existsSync(priorPayloadPath)).toBe(true);
    } finally {
      resumeRead.resolve();
    }
    expect(await oldRead).toMatchObject({ promptSnapshot: prior });
    expect(await coordinator._readSessionMetaEntryCached(metaPath, sessionPath)).toMatchObject({ promptSnapshot: next });
    await vi.waitFor(() => expect(fs.existsSync(priorPayloadPath)).toBe(false));
  });

  it("keeps a payload referenced by a recovery backup", async () => {
    const { coordinator, sessionPath, metaPath } = writeHistoryFixture();
    const prior = { finalSystemPrompt: "old prompt" };
    await coordinator.writeSessionMeta(sessionPath, { promptSnapshot: prior });
    const backupPath = path.join(path.dirname(metaPath), "session-meta.json.pre-v1.bak");
    fs.copyFileSync(metaPath, backupPath);

    await coordinator.writeSessionMeta(sessionPath, { promptSnapshot: { finalSystemPrompt: "new prompt" } });

    expect(await coordinator._readSessionMetaEntryCached(backupPath, sessionPath)).toMatchObject({ promptSnapshot: prior });
  });

  it("keeps the remaining index within its byte budget after deleting an entry", async () => {
    const { coordinator, metaPath } = writeHistoryFixture();
    const limit = 1024 * 1024;
    const removePath = path.join(path.dirname(metaPath), "remove.jsonl");
    const keep = { "history.jsonl": { projectId: "p".repeat(limit - 40) } };
    fs.writeFileSync(metaPath, JSON.stringify({ ...keep, "remove.jsonl": { memoryEnabled: false } }));
    expect(fs.statSync(metaPath).size).toBeGreaterThan(limit);
    expect(Buffer.byteLength(JSON.stringify(keep, null, 2), "utf8")).toBeGreaterThan(limit);

    expect(await coordinator._deleteSessionMetaEntry(removePath)).toBe(true);

    expect(fs.statSync(metaPath).size).toBeLessThanOrEqual(limit);
    expect(fs.readFileSync(metaPath, "utf8")).toBe(JSON.stringify(keep));
  });

  it("does not cache stale metadata when a write completes during a list read", async () => {
    const { coordinator, sessionPath, metaPath } = writeHistoryFixture();
    await coordinator.writeSessionMeta(sessionPath, { projectId: "before" });
    const enteredRead = Promise.withResolvers<void>();
    const resumeRead = Promise.withResolvers<void>();
    const readFile = fsp.readFile.bind(fsp);
    let blockRead = true;
    vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
      const result = await readFile(...args);
      if (args[0] === metaPath && blockRead) {
        blockRead = false;
        enteredRead.resolve();
        await resumeRead.promise;
      }
      return result;
    });

    const firstList = coordinator.listSessions();
    await enteredRead.promise;
    try {
      await coordinator.writeSessionMeta(sessionPath, { projectId: "after" });
    } finally {
      resumeRead.resolve();
    }
    expect(await firstList).toMatchObject([{ path: sessionPath }]);
    expect(await coordinator.listSessions()).toMatchObject([{ path: sessionPath, projectId: "after" }]);
  });

  it("starts with an empty quarantine list", () => {
    const coordinator = minimalCoordinator();
    expect(coordinator.listMetaQuarantines()).toEqual([]);
  });

  it("records metaPath/backupPath/quarantinedAt after a successful rename", async () => {
    const metaDir = path.join(tmpDir, "agents", "hana", "sessions");
    fs.mkdirSync(metaDir, { recursive: true });
    const metaPath = path.join(metaDir, "session-meta.json");
    fs.writeFileSync(metaPath, "{}");

    const coordinator = minimalCoordinator();
    await coordinator._quarantineOversizedSessionMeta(metaPath);

    const quarantines = coordinator.listMetaQuarantines();
    expect(quarantines).toHaveLength(1);
    expect(quarantines[0]).toMatchObject({ metaPath });
    expect(typeof quarantines[0].backupPath).toBe("string");
    expect(quarantines[0].backupPath).not.toBe(metaPath);
    expect(fs.existsSync(quarantines[0].backupPath)).toBe(true);
    expect(fs.existsSync(metaPath)).toBe(false);
    expect(typeof quarantines[0].quarantinedAt).toBe("string");
    expect(() => new Date(quarantines[0].quarantinedAt).toISOString()).not.toThrow();
  });

  it("does not record anything when the source file does not exist (rename ENOENT)", async () => {
    const coordinator = minimalCoordinator();
    await coordinator._quarantineOversizedSessionMeta(path.join(tmpDir, "does-not-exist.json"));
    expect(coordinator.listMetaQuarantines()).toEqual([]);
  });
});
