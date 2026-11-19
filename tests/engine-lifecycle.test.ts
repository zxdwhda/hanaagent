import fs from "fs";
import os from "os";
import path from "path";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HanaEngine } from "../packages/engine/core/engine.ts";
import { autoProjectIdForCwd, UNCATEGORIZED_PROJECT_ID } from "../packages/shared/session-projects.ts";
import { normalizeProviderPayload } from "../packages/engine/core/provider-compat.ts";
import {
  AuthStorage,
  createAgentSession,
  createModelRegistry,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "../packages/engine/lib/pi-sdk/index.ts";

it("uses the restored runtime thinking level on new and replayed turns with a stale history event", async () => {
  const requests: any[] = [];
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = {
      id: "fixture", object: "chat.completion.chunk", created: 1, model: payload.model,
      choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }],
    };
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  fixture.listen(0, "127.0.0.1");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hana-legacy-thinking-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    await once(fixture, "listening");
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const model = {
      id: "glm-5.3", provider: "zhipu-coding", name: "GLM 5.3", reasoning: true,
      api: "openai-completions", baseUrl, input: ["text" as const], maxTokens: 4096, contextWindow: 100_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as const;
    const history = SessionManager.create(directory, path.join(directory, "sessions"));
    history.appendModelChange(model.provider, model.id);
    history.appendThinkingLevelChange("off");
    history.appendMessage({ role: "user", content: "previous turn", timestamp: 1 });
    const previousAnswerId = history.appendMessage({
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 2,
      stopReason: "stop", content: [{ type: "text", text: "previous answer" }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...model.cost, total: 0 } },
    });
    const sessionPath = history.getSessionFile();
    if (!sessionPath) throw new Error("Missing fixture session path");
    const sessionManager = SessionManager.open(sessionPath);
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "local-fixture");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

    const engine = Object.create(HanaEngine.prototype);
    engine._models = { resolveThinkingLevel: (level: string) => level };
    engine._prefs = { getThinkingLevel: () => "high" };
    engine._sessionCoord = { getSessionByPath: (locator: string) => locator === sessionPath ? session : null };
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager, noSkills: true, noContextFiles: true,
      extensionFactories: [
        (pi) => pi.on("before_provider_request", (event, ctx) => normalizeProviderPayload(event.payload, ctx.model, {
          mode: "chat", reasoningLevel: engine.resolveRequestReasoningLevel(ctx),
        })),
      ],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: directory, agentDir: directory, sessionManager, settingsManager, resourceLoader, authStorage, tools: [],
      model: { ...model, input: ["text"] }, modelRegistry: createModelRegistry(authStorage, path.join(directory, "models.json")),
      thinkingLevel: "high",
    }));
    expect(sessionManager.buildSessionContext().thinkingLevel).toBe("off");
    expect(session.thinkingLevel).toBe("high");

    await session.prompt("new turn");
    sessionManager.branch(previousAnswerId);
    session.agent.state.messages = sessionManager.buildSessionContext().messages;
    await session.prompt("new turn");

    session.setThinkingLevel("off");
    await session.prompt("explicitly off");

    expect(requests.map(request => request.thinking?.type)).toEqual(["enabled", "enabled", "disabled"]);
  } finally {
    session?.dispose();
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Computer Use lazy runtime
// ---------------------------------------------------------------------------

describe("HanaEngine Computer Use lazy runtime", () => {
  let tmpDir = null;
  let engines: HanaEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0).reverse()) {
      await engine.dispose();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function trackEngine(engine: HanaEngine) {
    engines.push(engine);
    return engine;
  }

  function untrackEngine(engine: HanaEngine) {
    engines = engines.filter((candidate) => candidate !== engine);
  }

  function createEngine() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-engine-computer-use-"));
    return trackEngine(new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
    } as any));
  }

  it("does not construct the Computer Use runtime during engine construction", () => {
    const engine = createEngine();

    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();
  });

  it("constructs the Computer Use runtime when the global switch is enabled", () => {
    const engine = createEngine();

    const disabled = engine.setComputerUseSettings({ enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();

    const enabled = engine.setComputerUseSettings({ enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(engine._computerProviders).toBeTruthy();
    expect(engine._computerHost).toBeTruthy();
  });

  it("disposes the lazy Computer Use runtime during engine shutdown", async () => {
    const engine = createEngine();
    engine.setComputerUseSettings({ enabled: true });
    const dispose = vi.fn(async () => {});
    engine._computerHost = { dispose };

    await engine.dispose();
    untrackEngine(engine);

    expect(dispose).toHaveBeenCalledOnce();
    expect(engine._computerHost).toBeNull();
    expect(engine._computerProviders).toBeNull();
  });

  it("stores usage ledger entries under hanakoHome so engine restarts keep them", () => {
    const engine = createEngine();
    engine.usageLedger.record({
      model: { provider: "openai", modelId: "gpt-5", api: "openai-completions" },
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      usageContext: {
        source: { subsystem: "session", operation: "reply", surface: "desktop", trigger: "user" },
        attribution: { kind: "session", agentId: "hana", sessionPath: "/sessions/a.jsonl" },
      },
    });

    const restarted = trackEngine(new HanaEngine({
      hanakoHome: tmpDir,
      productDir: tmpDir,
      agentId: "hana",
    } as any));

    expect(restarted.usageLedger.list({}).entries).toMatchObject([
      {
        attribution: { kind: "session", sessionPath: "/sessions/a.jsonl" },
        usage: { totalTokens: 12 },
      },
    ]);
    expect(fs.existsSync(path.join(tmpDir, "usage-ledger.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extension factories
// ---------------------------------------------------------------------------

function makeFactory(name) {
  return Object.assign(() => {}, { _testName: name });
}

function names(factories) {
  return factories.map((factory) => factory._testName);
}

function makeEngine({ pluginFactories = [] } = {}) {
  const engine = Object.create(HanaEngine.prototype);
  engine._coreExtensionFactories = [
    makeFactory("core-provider"),
    makeFactory("core-image"),
  ];
  engine._frameworkExtFactories = [];
  engine._extensionFactories = [...engine._coreExtensionFactories];
  engine._pluginManager = {
    getExtensionFactories: vi.fn(() => pluginFactories),
  };
  engine._resourceLoader = {
    reload: vi.fn().mockResolvedValue(undefined),
  };
  engine._sessionCoord = null;
  return engine;
}

describe("HanaEngine extension factories", () => {
  it("reloads ResourceLoader after plugin extension factories are synced", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });

    await engine.syncPluginExtensions();

    expect(names(engine._extensionFactories)).toEqual([
      "core-provider",
      "core-image",
      "plugin-a",
    ]);
    expect(engine._resourceLoader.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps all core factories when framework factories are registered later", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });
    const frameworkFactory = makeFactory("framework-deferred");

    await engine.registerExtensionFactory(frameworkFactory);

    expect(names(engine._extensionFactories)).toEqual([
      "core-provider",
      "core-image",
      "framework-deferred",
      "plugin-a",
    ]);
    expect(engine._resourceLoader.reload).toHaveBeenCalledTimes(1);
  });

  it("marks loaded sessions for a safe refresh only when the plugin factory set changes", async () => {
    const engine = makeEngine({
      pluginFactories: [makeFactory("plugin-a")],
    });
    engine._sessionCoord = {
      markPluginExtensionsChanged: vi.fn(),
    };

    await engine.syncPluginExtensions();

    expect(engine._sessionCoord.markPluginExtensionsChanged).toHaveBeenCalledOnce();
    await engine.syncPluginExtensions();
    expect(engine._sessionCoord.markPluginExtensionsChanged).toHaveBeenCalledOnce();
    await engine.registerExtensionFactory(makeFactory("framework"));
    expect(engine._sessionCoord.markPluginExtensionsChanged).toHaveBeenCalledOnce();
  });

  it("marks sessions when the same plugin set is retried after a failed loader refresh", async () => {
    const engine = makeEngine({ pluginFactories: [makeFactory("plugin-a")] });
    const markPluginExtensionsChanged = vi.fn();
    engine._sessionCoord = { markPluginExtensionsChanged };
    engine._resourceLoader.reload.mockRejectedValueOnce(new Error("reload failed"));

    await expect(engine.syncPluginExtensions()).rejects.toThrow("reload failed");
    expect(markPluginExtensionsChanged).not.toHaveBeenCalled();
    await engine.syncPluginExtensions();
    expect(markPluginExtensionsChanged).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Session API
// ---------------------------------------------------------------------------

describe("HanaEngine session API", () => {
  it("exposes session model switch state without leaking coordinator internals", () => {
    const engine = Object.create(HanaEngine.prototype);
    engine._sessionCoord = {
      isSessionSwitching: vi.fn(() => true),
    };

    expect(engine.isSessionSwitching("/tmp/session.jsonl")).toBe(true);
    expect(engine._sessionCoord.isSessionSwitching).toHaveBeenCalledWith("/tmp/session.jsonl");
  });

  it("deletes a project by moving explicit and cwd-derived sessions to uncategorized", async () => {
    const engine = Object.create(HanaEngine.prototype);
    const cwdProjectId = autoProjectIdForCwd("/tmp/project-hana");
    engine._sessionProjects = {
      deleteProject: vi.fn(() => ({ folders: [], projects: [] })),
    };
    engine._sessionCoord = {
      listSessions: vi.fn(async () => [
        { path: "/tmp/agents/hana/sessions/explicit.jsonl", cwd: "/elsewhere", projectId: cwdProjectId },
        { path: "/tmp/agents/hana/sessions/implicit.jsonl", cwd: "/tmp/project-hana", projectId: null },
        { path: "/tmp/agents/hana/sessions/other.jsonl", cwd: "/tmp/other", projectId: null },
      ]),
      writeSessionMeta: vi.fn(async () => undefined),
    };

    const result = await engine.deleteSessionProject(cwdProjectId);

    expect(engine._sessionProjects.deleteProject).toHaveBeenCalledWith(cwdProjectId);
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledTimes(2);
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledWith(
      "/tmp/agents/hana/sessions/explicit.jsonl",
      { projectId: UNCATEGORIZED_PROJECT_ID },
    );
    expect(engine._sessionCoord.writeSessionMeta).toHaveBeenCalledWith(
      "/tmp/agents/hana/sessions/implicit.jsonl",
      { projectId: UNCATEGORIZED_PROJECT_ID },
    );
    expect(result).toEqual({
      catalog: { folders: [], projects: [] },
      assignment: {
        projectId: UNCATEGORIZED_PROJECT_ID,
        sessionPaths: [
          "/tmp/agents/hana/sessions/explicit.jsonl",
          "/tmp/agents/hana/sessions/implicit.jsonl",
        ],
      },
    });
  });
});
