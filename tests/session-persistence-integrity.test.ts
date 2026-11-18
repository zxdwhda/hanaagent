import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCoordinator } from "../packages/engine/core/session-coordinator.ts";
import { SessionManifestStore } from "../packages/engine/core/session-manifest/store.ts";
import {
  DEFAULT_SESSION_JSONL_MAX_LINE_BYTES,
  flushSessionManagerSnapshot,
  schedulePreAssistantSessionManagerFlush,
} from "../packages/engine/core/session-jsonl-file.ts";
import { SessionManager } from "../packages/engine/lib/pi-sdk/index.ts";
import { readCurrentSessionBranch } from "../packages/engine/lib/session-jsonl.ts";

// Keep the real session manager and persistence formats. No model calls run.
const { createAgentSession } = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
vi.mock("../packages/engine/lib/pi-sdk/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../packages/engine/lib/pi-sdk/index.js")>(),
  createAgentSession,
}));

function fakeAgentSession({ sessionManager }: { sessionManager: SessionManager }) {
  return { session: {
    sessionManager,
    subscribe: () => () => {},
    setActiveToolsByName: () => {},
  } };
}

function appendText(manager: SessionManager, role: "user" | "assistant", text: string) {
  return manager.appendMessage({ role, content: [{ type: "text", text }] } as any);
}

function ioError(code: string) {
  return Object.assign(new Error(`Injected session write failure: ${code}`), { code });
}

function diskEntries(sessionPath: string) {
  return fs.readFileSync(sessionPath, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
}

describe("session persistence integrity", () => {
  let directory: string;
  let manifestStore: SessionManifestStore | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-integrity-"));
    createAgentSession.mockReset().mockImplementation(fakeAgentSession);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    manifestStore?.close();
    manifestStore = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function createSession(messageCount = 2, sessionDir = directory) {
    const manager = SessionManager.create(directory, sessionDir);
    for (let index = 0; index < messageCount; index += 1) {
      appendText(manager, index % 2 === 0 ? "user" : "assistant", `message ${index}`);
    }
    return manager;
  }

  function failSnapshotAfterHeader(sessionPath: string) {
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    let snapshotFd: number | undefined;
    let writes = 0;
    const open = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = originalOpen(target, flags, mode);
      if ((target === sessionPath && (flags === "w" || flags === "wx"))
        || (typeof target === "string" && target.startsWith(sessionPath + ".tmp-"))) snapshotFd = fd;
      return fd;
    });
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (snapshotFd !== undefined && target === snapshotFd && ++writes === 2) throw ioError("EIO");
      originalWrite(target, data, options);
    });
    syncBuiltinESMExports();
    return () => {
      write.mockRestore();
      open.mockRestore();
      syncBuiltinESMExports();
      expect(writes).toBe(2);
    };
  }

  function createCoordinator() {
    const agentsDir = path.join(directory, "agents");
    const sessionDir = path.join(agentsDir, "fixture", "sessions");
    const agent = {
      id: "fixture",
      agentDir: path.dirname(sessionDir),
      sessionDir,
      runtimeInitialized: true,
      config: { tools: {} },
      buildSystemPrompt: () => "fixture prompt",
    };
    manifestStore = new SessionManifestStore({ dbPath: path.join(directory, "session-manifest.db") });
    const coordinator = new SessionCoordinator({
      agentsDir,
      sessionManifestStore: manifestStore,
      getAgent: () => agent,
      getAgentById: () => agent,
      getActiveAgentId: () => agent.id,
      agentIdFromSessionPath: () => agent.id,
      getHomeCwd: () => directory,
      getModels: () => ({ availableModels: [], resolveThinkingLevel: () => "medium" }),
      getResourceLoader: () => ({ getSystemPrompt: () => "fixture prompt" }),
      getSkills: () => null,
      buildTools: () => ({ tools: [], customTools: [] }),
      emitEvent: () => {},
      getConfig: () => ({}),
      getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    });
    return { coordinator, sessionDir };
  }

  function pauseNextRestore() {
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    createAgentSession.mockImplementationOnce(async (options) => {
      paused.resolve();
      await resume.promise;
      return fakeAgentSession(options);
    });
    return { paused, resume };
  }

  it("shares a single writer between concurrent cold desktop switch and attach", async () => {
    const { coordinator, sessionDir } = createCoordinator();
    const sessionPath = createSession(2, sessionDir).getSessionFile();
    const { paused, resume } = pauseNextRestore();
    const switching = coordinator.switchSession(sessionPath);
    try {
      await Promise.race([paused.promise, switching]);
      const attaching = coordinator.ensureSessionLoaded(sessionPath);
      resume.resolve();
      const [switched, attached] = await Promise.all([switching, attaching]);
      expect(createAgentSession).toHaveBeenCalledTimes(1);
      expect(switched).toBe(attached);
      expect(coordinator.currentSessionPath).toBe(sessionPath);
      const writer = attached.sessionManager as SessionManager;
      const previousLeaf = writer.getLeafId();
      const latestId = appendText(writer, "user", "the next turn");
      expect(diskEntries(sessionPath).at(-1)).toMatchObject({ id: latestId, parentId: previousLeaf });
      expect(() => readCurrentSessionBranch(sessionPath)).not.toThrow();
    } finally {
      resume.resolve();
      await switching.catch(() => {});
    }
  });

  it("does not roll back a later focus change when a different background load finishes", async () => {
    const { coordinator, sessionDir } = createCoordinator();
    const original = createSession(2, sessionDir).getSessionFile();
    const background = createSession(2, sessionDir).getSessionFile();
    const foreground = createSession(2, sessionDir).getSessionFile();
    await coordinator.switchSession(original);

    const { paused, resume } = pauseNextRestore();
    const attaching = coordinator.ensureSessionLoaded(background);
    try {
      await Promise.race([paused.promise, attaching]);
      await coordinator.switchSession(foreground);
      resume.resolve();
      await attaching;
      expect(coordinator.currentSessionPath).toBe(foreground);
    } finally {
      resume.resolve();
      await attaching.catch(() => {});
    }
  });

  it("preserves the original long history and manager state when oversized projection fails to write", () => {
    const manager = createSession(1058);
    const sessionPath = manager.getSessionFile();
    const oversizedId = manager.appendCustomEntry("oversized-fixture", {
      payload: "x".repeat(DEFAULT_SESSION_JSONL_MAX_LINE_BYTES),
    });
    const originalBytes = fs.readFileSync(sessionPath);
    const originalEntry = manager.getEntry(oversizedId);
    const restore = failSnapshotAfterHeader(sessionPath);
    try {
      SessionCoordinator.prototype._projectOversizedSessionHistory({ sessionManager: manager }, sessionPath);
    } finally {
      restore();
    }
    expect(fs.readFileSync(sessionPath).equals(originalBytes)).toBe(true);
    expect(manager.getEntry(oversizedId)).toBe(originalEntry);
    expect(manager.getLeafId()).toBe(oversizedId);
    expect(fs.readdirSync(directory)).toEqual([path.basename(sessionPath)]);
    const nextId = appendText(manager, "user", "usable after failed projection");
    expect(diskEntries(sessionPath)).toHaveLength(1061);
    expect(diskEntries(sessionPath).at(-1)).toMatchObject({ id: nextId, parentId: oversizedId });
    expect(() => readCurrentSessionBranch(sessionPath)).not.toThrow();
  });

  it("rejects rewriting an older manager snapshot over a newer persisted history", () => {
    const writer = createSession();
    const sessionPath = writer.getSessionFile();
    const stale = SessionManager.open(sessionPath, directory);
    appendText(writer, "user", "newer saved turn");
    const latestBytes = fs.readFileSync(sessionPath);
    expect(() => flushSessionManagerSnapshot(stale)).toThrow(expect.objectContaining({
      code: "session_persistence_conflict",
    }));
    expect(() => appendText(stale, "user", "new input in stale manager")).toThrow(expect.objectContaining({
      code: "session_persistence_conflict",
    }));
    expect(fs.readFileSync(sessionPath)).toEqual(latestBytes);
  });

  it("removes a failed partial append and retries from the same saved leaf", () => {
    const manager = createSession();
    const sessionPath = manager.getSessionFile();
    const previousLeaf = manager.getLeafId();
    const previousBytes = fs.readFileSync(sessionPath);
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    let appendFd: number | undefined;
    const open = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = originalOpen(target, flags, mode);
      if (target === sessionPath && typeof flags === "number" && (flags & fs.constants.O_APPEND)) appendFd = fd;
      return fd;
    });
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (appendFd !== undefined && target === appendFd) {
        originalWrite(target, Buffer.from(data as Buffer).subarray(0, 15));
        throw ioError("EIO");
      }
      originalWrite(target, data, options);
    });
    syncBuiltinESMExports();
    try {
      expect(() => appendText(manager, "user", "append is interrupted")).toThrow(expect.objectContaining({ code: "EIO" }));
    } finally {
      write.mockRestore();
      open.mockRestore();
      syncBuiltinESMExports();
    }
    expect(manager.getLeafId()).toBe(previousLeaf);
    expect(fs.readFileSync(sessionPath).equals(previousBytes)).toBe(true);
    const nextId = appendText(manager, "user", "retry after a short write");
    expect(diskEntries(sessionPath).at(-1)).toMatchObject({ id: nextId, parentId: previousLeaf });
    expect(() => readCurrentSessionBranch(sessionPath)).not.toThrow();
  });

  it("keeps the last saved parent after an append cannot open the file", () => {
    const manager = createSession();
    const sessionPath = manager.getSessionFile();
    const previousLeaf = manager.getLeafId();
    const previousEntries = manager.getEntries();
    const previousBytes = fs.readFileSync(sessionPath);
    const originalAppend = fs.appendFileSync;
    const originalOpen = fs.openSync;
    const append = vi.spyOn(fs, "appendFileSync").mockImplementation((target, data, options) => {
      if (target === sessionPath) throw ioError("EMFILE");
      originalAppend(target, data, options);
    });
    const open = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (target === sessionPath && typeof flags === "number" && (flags & fs.constants.O_APPEND)) {
        throw ioError("EMFILE");
      }
      return originalOpen(target, flags, mode);
    });
    syncBuiltinESMExports();
    try {
      expect(() => appendText(manager, "user", "not saved")).toThrow(expect.objectContaining({ code: "EMFILE" }));
    } finally {
      append.mockRestore();
      open.mockRestore();
      syncBuiltinESMExports();
    }
    expect(manager.getLeafId()).toBe(previousLeaf);
    expect(manager.getEntries()).toEqual(previousEntries);
    expect(fs.readFileSync(sessionPath)).toEqual(previousBytes);
    const nextId = appendText(manager, "user", "successfully saved");
    expect(diskEntries(sessionPath).at(-1)).toMatchObject({ id: nextId, parentId: previousLeaf });
    expect(() => readCurrentSessionBranch(sessionPath)).not.toThrow();
  });

  it("does not publish a partial first assistant snapshot and retries the buffered session", () => {
    const manager = SessionManager.create(directory, directory);
    const sessionPath = manager.getSessionFile();
    const userId = appendText(manager, "user", "first input");
    const restore = failSnapshotAfterHeader(sessionPath);
    try {
      expect(() => appendText(manager, "assistant", "first answer")).toThrow(expect.objectContaining({ code: "EIO" }));
    } finally {
      restore();
    }
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(manager.getLeafId()).toBe(userId);
    const answerId = appendText(manager, "assistant", "retry answer");
    expect(diskEntries(sessionPath).slice(1).map(entry => entry.id)).toEqual([userId, answerId]);
  });

  it("preserves first-user flush, reopen, and legitimate branches", async () => {
    const manager = SessionManager.create(directory, directory);
    const sessionPath = manager.getSessionFile();
    const userId = appendText(manager, "user", "first input");
    schedulePreAssistantSessionManagerFlush(manager);
    await Promise.resolve();
    const answerId = appendText(manager, "assistant", "first answer");
    const reopened = SessionManager.open(sessionPath, directory);
    reopened.branch(userId);
    const branchId = appendText(reopened, "assistant", "different branch");
    expect(diskEntries(sessionPath).slice(1).map(entry => entry.id)).toEqual([userId, answerId, branchId]);
    expect(reopened.getEntry(branchId)).toMatchObject({ parentId: userId });
    expect(reopened.getBranch().map(entry => entry.id)).toEqual([userId, branchId]);
  });
});
