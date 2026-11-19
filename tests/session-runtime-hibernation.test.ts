import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, sessionManagerOpenMock, emitSessionShutdownMock, refreshSessionModelFromRegistryMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  sessionManagerOpenMock: vi.fn(),
  emitSessionShutdownMock: vi.fn(),
  refreshSessionModelFromRegistryMock: vi.fn(),
}));

vi.mock("../packages/engine/lib/pi-sdk/index.js", () => ({
  createAgentSession: createAgentSessionMock,
  emitSessionShutdown: emitSessionShutdownMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock,
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
  estimateTokens: vi.fn(() => 0),
  findCutPoint: vi.fn(() => 0),
  generateSummary: vi.fn(),
  refreshSessionModelFromRegistry: refreshSessionModelFromRegistryMock,
}));

vi.mock("../packages/engine/lib/debug-log.js", () => ({
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionCoordinator } from "../packages/engine/core/session-coordinator.ts";

const MODEL = {
  id: "test-model",
  name: "test-model",
  provider: "test",
  input: ["text", "image"],
};

function makeSession(sessionPath, overrides: any = {}) {
  const sessionManager = overrides.sessionManager || {
    getSessionFile: () => sessionPath,
    getCwd: () => path.dirname(sessionPath),
  };
  return {
    sessionManager,
    model: MODEL,
    isStreaming: false,
    isCompacting: false,
    messages: [],
    prompt: vi.fn(async () => {}),
    subscribe: vi.fn(() => vi.fn()),
    setActiveToolsByName: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

function makeAgent(root = "/tmp/hana-runtime-hibernation") {
  return {
    id: "hana",
    agentDir: path.join(root, "agents", "hana"),
    sessionDir: path.join(root, "agents", "hana", "sessions"),
    memoryMasterEnabled: true,
    sessionMemoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    buildSystemPrompt: () => "BASE",
    getToolsSnapshot: vi.fn(() => []),
    config: {},
  };
}

function makeCoordinator( overrides: any = {}) {
  const root = overrides.root || "/tmp/hana-runtime-hibernation";
  const agent = overrides.agent || makeAgent(root);
  const models = overrides.models || {
    currentModel: MODEL,
    availableModels: [MODEL],
    authStorage: {},
    modelRegistry: {},
    resolveThinkingLevel: () => "medium",
  };
  return new SessionCoordinator({
    agentsDir: path.join(root, "agents"),
    getAgent: () => agent,
    getActiveAgentId: () => agent.id,
    getModels: () => models,
    getResourceLoader: () => ({
      getSystemPrompt: () => "BASE",
      getAppendSystemPrompt: () => [],
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    }),
    getSkills: () => null,
    buildTools: vi.fn(() => ({ tools: [], customTools: [] })),
    emitEvent: vi.fn(),
    getHomeCwd: () => root,
    agentIdFromSessionPath: () => agent.id,
    switchAgentOnly: vi.fn(async () => {}),
    getConfig: () => ({}),
    getPrefs: () => ({ getThinkingLevel: () => "medium" }),
    getAgents: () => new Map([[agent.id, agent]]),
    getActivityStore: () => null,
    getAgentById: () => agent,
    listAgents: () => [agent],
    getDeferredResultStore: overrides.getDeferredResultStore || (() => null),
    memoryPressure: overrides.memoryPressure,
    getEngine: overrides.getEngine,
  });
}

describe("SessionCoordinator runtime hibernation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshSessionModelFromRegistryMock.mockImplementation((session, allowedModel) => {
      if (allowedModel !== undefined) {
        if (session?.agent?.state) session.agent.state.model = allowedModel;
        if (session && Object.prototype.hasOwnProperty.call(session, "model")) session.model = allowedModel;
      } else {
        session?._refreshCurrentModelFromRegistry?.();
      }
      return true;
    });
    emitSessionShutdownMock.mockResolvedValue(false);
    sessionManagerCreateMock.mockReturnValue({ getCwd: () => "/tmp/workspace", getSessionFile: () => "/tmp/session.jsonl" });
  });

  it("releases a focused runtime while preserving the current session path", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/current.jsonl";
    const session = makeSession(sessionPath, {
      getContextUsage: vi.fn(() => ({ tokens: 123, contextWindow: 1000, percent: 12.3 })),
    });
    const unsub = vi.fn();
    const coordinator = makeCoordinator();
    coordinator._session = session;
    coordinator._sessionStarted = true;
    coordinator._sessions.set(sessionPath, {
      session,
      unsub,
      agentId: "hana",
      modelId: "test-model",
      modelProvider: "test",
      workspaceFolders: ["/tmp/workspace", "/tmp/other"],
      permissionMode: "operate",
      accessMode: "operate",
      planMode: false,
      thinkingLevel: "high",
      lastTouchedAt: Date.now() - 60_000,
    });

    await expect(
      coordinator.hibernateSessionRuntime(sessionPath, "test"),
    ).resolves.toBe(true);

    expect(coordinator.getSessionByPath(sessionPath)).toBeNull();
    expect(coordinator.session).toBeNull();
    expect(coordinator.currentSessionPath).toBe(sessionPath);
    expect(coordinator.sessionStarted).toBe(true);
    expect(coordinator.getCurrentSessionModelRef()).toEqual({ id: "test-model", provider: "test" });
    expect(coordinator.getSessionWorkspaceFolders(sessionPath)).toEqual(["/tmp/workspace", "/tmp/other"]);
    expect(coordinator.getPermissionMode(sessionPath)).toBe("operate");
    expect(coordinator.getSessionThinkingLevel(sessionPath)).toBe("high");
    expect(coordinator.getSessionContextUsage(sessionPath)).toEqual({ tokens: 123, contextWindow: 1000, percent: 12.3 });
    expect(unsub).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("restores a hibernated focused runtime before prompting", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/current.jsonl";
    const manager = { getCwd: () => "/tmp/workspace", getSessionFile: () => sessionPath };
    const restored = makeSession(sessionPath, { sessionManager: manager });
    sessionManagerOpenMock.mockReturnValue(manager);
    createAgentSessionMock.mockResolvedValue({ session: restored });

    const coordinator = makeCoordinator();
    coordinator._currentSessionPath = sessionPath;
    coordinator._sessionStarted = true;

    await (coordinator as any).promptSession(sessionPath, "hello");

    expect(sessionManagerOpenMock).toHaveBeenCalledWith(sessionPath, expect.stringContaining("sessions"));
    expect(restored.prompt).toHaveBeenCalledWith("hello", undefined);
    expect(coordinator.session).toBe(restored);
    expect(coordinator.currentSessionPath).toBe(sessionPath);
  });

  it("waits for a runtime to finish hibernating before reopening it for a new prompt", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/reopen.jsonl";
    const manager = { getCwd: () => "/tmp/workspace", getSessionFile: () => sessionPath };
    const oldSession = makeSession(sessionPath);
    const newSession = makeSession(sessionPath, { sessionManager: manager });
    sessionManagerOpenMock.mockReturnValue(manager);
    createAgentSessionMock.mockResolvedValue({ session: newSession });
    let finishShutdown = () => {};
    emitSessionShutdownMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishShutdown = () => resolve(false);
    }));
    const coordinator = makeCoordinator();
    coordinator._sessions.set(sessionPath, { session: oldSession, agentId: "hana", unsub: vi.fn() });
    coordinator._session = oldSession;
    coordinator._currentSessionPath = sessionPath;
    const hibernating = coordinator.hibernateSessionRuntime(sessionPath, "test");
    const prompting = coordinator.promptSession(sessionPath, "after pressure", undefined);
    try {
      await vi.waitFor(() => expect(emitSessionShutdownMock).toHaveBeenCalledOnce());
      expect(oldSession.prompt).not.toHaveBeenCalled();
      expect(sessionManagerOpenMock).not.toHaveBeenCalled();
    } finally {
      finishShutdown();
      await Promise.allSettled([hibernating, prompting]);
    }
    await expect(hibernating).resolves.toBe(true);
    await expect(prompting).resolves.toBeUndefined();
    expect(oldSession.dispose).toHaveBeenCalledOnce();
    expect(newSession.prompt).toHaveBeenCalledOnce();
    expect(coordinator.getSessionByPath(sessionPath)).toBe(newSession);
  });

  it("rejects the next live-session prompt before vision or Pi when its model was disabled", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/gpt56.jsonl";
    const staleModel = {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      input: ["text"],
      contextWindow: 353400,
    };
    const models = {
      currentModel: staleModel,
      availableModels: [staleModel],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: () => "low",
    };
    const visionPrepare = vi.fn(async () => ({ text: "vision output", images: [] }));
    const session = makeSession(sessionPath, { model: staleModel });
    const coordinator = makeCoordinator({
      models,
      getEngine: () => ({
        isVisionAuxiliaryEnabled: () => true,
        getVisionBridge: () => ({ prepare: visionPrepare }),
      }),
    });
    coordinator._sessions.set(sessionPath, {
      session,
      agentId: "hana",
      modelId: staleModel.id,
      modelProvider: staleModel.provider,
      lastTouchedAt: 0,
    });

    models.availableModels = [];
    coordinator.refreshAllSessionsModels();

    const result = coordinator.promptSession(sessionPath, "describe image", {
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    });
    await expect(result).rejects.toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
      modelRef: "openai-codex/gpt-5.6-sol",
    });
    expect(visionPrepare).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(refreshSessionModelFromRegistryMock).not.toHaveBeenCalled();
  });

  it("rebinds a live session to current Hana metadata and continues prompting", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/gpt56-metadata.jsonl";
    const staleModel = {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://stale.example",
      contextWindow: 272000,
      thinkingLevels: ["low", "medium", "high"],
    };
    const freshModel = {
      ...staleModel,
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 353400,
      maxTokens: 128000,
      thinkingLevels: ["low", "medium", "high", "max"],
      thinkingLevelMap: { xhigh: "max" },
    };
    const models = {
      currentModel: freshModel,
      availableModels: [freshModel],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: (level) => level,
    };
    const session = makeSession(sessionPath, {
      model: staleModel,
      agent: { state: { model: staleModel, systemPrompt: "BASE", tools: [] } },
    });
    const coordinator = makeCoordinator({ models });
    coordinator._sessions.set(sessionPath, {
      session,
      agentId: "hana",
      modelId: staleModel.id,
      modelProvider: staleModel.provider,
      lastTouchedAt: 0,
    });

    coordinator.refreshAllSessionsModels();

    expect(refreshSessionModelFromRegistryMock).toHaveBeenCalledWith(session, freshModel);
    expect(session.model).toBe(freshModel);
    expect(session.model).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 353400,
      maxTokens: 128000,
      thinkingLevels: ["low", "medium", "high", "max"],
      thinkingLevelMap: { xhigh: "max" },
    });
    await expect(coordinator.promptSession(sessionPath, "hello", undefined)).resolves.toBeUndefined();
    expect(session.prompt).toHaveBeenCalledWith("hello", undefined);
  });

  it.each(["live", "hibernate", "reload"])("recovers a private plugin session when its exact provider model returns (%s)", async (mode) => {
    const sessionPath = `/tmp/hana-runtime-hibernation/agents/hana/sessions/plugin-${mode}.jsonl`;
    const staleModel = {
      id: "shared-model",
      provider: "plugin-provider",
      api: "openai-completions",
      baseUrl: "https://old.example",
      contextWindow: 128000,
    };
    const models = {
      currentModel: staleModel,
      availableModels: [staleModel],
      authStorage: {},
      modelRegistry: {},
      resolveThinkingLevel: (level) => level,
    };
    const session = makeSession(sessionPath, { model: staleModel });
    const coordinator = makeCoordinator({ models });
    coordinator._sessions.set(sessionPath, {
      session,
      agentId: "hana",
      ownerPluginId: "example-plugin",
      sessionVisibility: "plugin_private",
      modelId: staleModel.id,
      modelProvider: staleModel.provider,
      lastTouchedAt: 0,
    });

    models.availableModels = [];
    coordinator.refreshAllSessionsModels();
    if (mode !== "live") {
      const manager = {
        getSessionFile: () => sessionPath,
        getCwd: () => "/tmp/workspace",
        buildSessionContext: () => ({ model: { provider: staleModel.provider, modelId: staleModel.id } }),
      };
      sessionManagerOpenMock.mockReturnValue(manager);
      createAgentSessionMock.mockImplementationOnce(async ({ model }) => ({
        session: makeSession(sessionPath, { model, sessionManager: manager }),
      }));
      if (mode === "hibernate") {
        await expect(coordinator.hibernateSessionRuntime(sessionPath, "test")).resolves.toBe(true);
      } else {
        await coordinator.reloadSessionRuntime(sessionPath);
      }
    }
    models.availableModels = [{ ...staleModel, provider: "other-provider" }];
    await expect(coordinator.promptSession(sessionPath, "hello", undefined)).rejects.toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
      modelRef: "plugin-provider/shared-model",
    });
    const privateSession = coordinator.getSessionByPath(sessionPath);
    expect(privateSession.prompt).not.toHaveBeenCalled();

    const freshModel = { ...staleModel, baseUrl: "https://new.example" };
    models.availableModels.push(freshModel);
    coordinator.refreshAllSessionsModels();

    expect(privateSession.model).toBe(freshModel);
    await expect(coordinator.promptSession(sessionPath, "hello", undefined)).resolves.toBeUndefined();
    expect(privateSession.prompt).toHaveBeenCalledWith("hello", undefined);
    expect(coordinator.getSessionByPath(sessionPath)).toBe(privateSession);
  });

  it("hibernates only heavy idle runtimes under memory pressure", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/heavy.jsonl";
    const session = makeSession(sessionPath, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "analyze this" },
            { type: "image", data: "a".repeat(4096), mimeType: "image/png" },
          ],
        },
      ],
    });
    const coordinator = makeCoordinator({
      memoryPressure: {
        getMemoryUsage: () => ({
          rss: 2 * 1024 * 1024 * 1024,
          heapUsed: 128 * 1024 * 1024,
          external: 64 * 1024 * 1024,
          arrayBuffers: 64 * 1024 * 1024,
        }),
        thresholds: {
          minRetainedBytes: 1024,
          highRssBytes: 1024,
          highPayloadBytes: 4096,
        },
      },
    });
    coordinator._currentSessionPath = sessionPath;
    coordinator._session = session;
    coordinator._sessions.set(sessionPath, {
      session,
      unsub: vi.fn(),
      agentId: "hana",
      lastTouchedAt: Date.now() - 60_000,
    });

    await expect(
      coordinator.checkRuntimeMemoryPressure(sessionPath, "test"),
    ).resolves.toMatchObject({ hibernated: true });

    expect(coordinator.getSessionByPath(sessionPath)).toBeNull();
    expect(coordinator.currentSessionPath).toBe(sessionPath);
  });
  it("includes accumulated short turns in the retained payload", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/text.jsonl";
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant", content: [{ type: "thinking", thinking: `Reasoning ${index} ${"a".repeat(2048)}` }],
    }));
    const session = makeSession(sessionPath, { messages });
    const coordinator = makeCoordinator({
      memoryPressure: { getMemoryUsage: () => ({}), thresholds: { highPayloadBytes: 32 * 1024 } },
    });
    coordinator._sessions.set(sessionPath, { session, agentId: "hana" });

    await expect(coordinator.checkRuntimeMemoryPressure(sessionPath)).resolves.toMatchObject({ hibernated: true });
    expect(coordinator.getSessionByPath(sessionPath)).toBeNull();
  });

  it("counts one backing allocation shared by multiple message views", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/binary.jsonl";
    const buffer = new ArrayBuffer(32 * 1024);
    const session = makeSession(sessionPath, { messages: [
      { content: [new Uint8Array(buffer, 0, 24 * 1024), new Uint8Array(buffer, 8 * 1024)] },
    ] });
    const coordinator = makeCoordinator({
      memoryPressure: { getMemoryUsage: () => ({}), thresholds: { highPayloadBytes: 40 * 1024 } },
    });
    coordinator._sessions.set(sessionPath, { session, agentId: "hana" });

    await expect(coordinator.checkRuntimeMemoryPressure(sessionPath))
      .resolves.toMatchObject({ hibernated: false, retainedBytes: buffer.byteLength });
  });

  it("does not count ArrayBuffers twice when evaluating process pressure", async () => {
    const sessionPath = "/tmp/hana-runtime-hibernation/agents/hana/sessions/normal.jsonl";
    const session = makeSession(sessionPath, { messages: [{ role: "user", content: "a".repeat(8192) }] });
    const coordinator = makeCoordinator({
      memoryPressure: {
        getMemoryUsage: () => ({ external: 48 * 1024, arrayBuffers: 32 * 1024 }),
        thresholds: { highExternalBytes: 64 * 1024, minRetainedBytes: 4096 },
      },
    });
    coordinator._sessions.set(sessionPath, { session, agentId: "hana" });

    await expect(coordinator.checkRuntimeMemoryPressure(sessionPath)).resolves.toMatchObject({ hibernated: false });
    expect(coordinator.getSessionByPath(sessionPath)).toBe(session);
  });

  it("reclaims a heavier idle peer under process pressure without interrupting busy sessions", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = makeCoordinator({
        getDeferredResultStore: () => ({
          listPending: (sessionPath: string) => sessionPath.endsWith("/deferred.jsonl") ? [{}] : [],
        }),
        memoryPressure: {
          getMemoryUsage: () => ({ rss: 2048 }),
          thresholds: { checkDelayMs: 1, highRssBytes: 1024, minRetainedBytes: 4096 },
        },
      });
      const sessions = [
        ["trigger", 100, false],
        ["smaller-idle", 10000, false],
        ["largest-idle", 20000, false],
        ["streaming", 25000, true],
        ["deferred", 30000, false],
      ] as const;
      for (const [name, size, isStreaming] of sessions) {
        const sessionPath = `/tmp/hana-runtime-hibernation/agents/hana/sessions/${name}.jsonl`;
        const session = makeSession(sessionPath, { isStreaming, messages: [{ role: "user", content: "x".repeat(size) }] });
        coordinator._sessions.set(sessionPath, { session, agentId: "hana" });
      }
      coordinator._scheduleRuntimePressureCheck("/tmp/hana-runtime-hibernation/agents/hana/sessions/trigger.jsonl");
      await vi.advanceTimersByTimeAsync(1);

      for (const [name] of sessions) {
        const sessionPath = `/tmp/hana-runtime-hibernation/agents/hana/sessions/${name}.jsonl`;
        expect(Boolean(coordinator.getSessionByPath(sessionPath))).toBe(name !== "largest-idle");
      }
    } finally {
      vi.useRealTimers();
    }
  });

});
