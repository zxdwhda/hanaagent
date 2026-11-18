import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createHeartbeatMock, heartbeatInstances, heartbeatOptions } = vi.hoisted(() => ({
  createHeartbeatMock: vi.fn(),
  heartbeatInstances: [],
  heartbeatOptions: [],
}));

vi.mock("../packages/engine/lib/desk/heartbeat.js", () => ({
  HEARTBEAT_ACTIVITY_DIR: ".hana-heartbeat",
  createHeartbeat: createHeartbeatMock,
}));

vi.mock("../packages/engine/lib/desk/cron-scheduler.js", () => ({
  createCronScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../packages/engine/lib/fresh-compact/daily-scheduler.js", () => ({
  createFreshCompactDailyScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../packages/engine/hub/fresh-compact-maintainer.js", () => ({
  FreshCompactMaintainer: vi.fn().mockImplementation(function () {
    this.runDaily = vi.fn();
  }),
}));

import { Scheduler } from "../packages/engine/hub/scheduler.ts";

describe("Scheduler heartbeat defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    heartbeatInstances.length = 0;
    heartbeatOptions.length = 0;
    createHeartbeatMock.mockImplementation((opts) => {
      const hb = {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      heartbeatInstances.push(hb);
      heartbeatOptions.push(opts);
      return hb;
    });
  });

  it("creates heartbeat handles for config-only agents but starts only explicit opt-in patrols", () => {
    const root = "/tmp/hana-heartbeat-default";
    const optedIn = {
      id: "opted-in",
      agentName: "Opted In",
      deskDir: path.join(root, "agents", "opted-in", "desk"),
      config: { desk: { heartbeat_enabled: true, heartbeat_interval: 31 } },
    };
    const implicitOff = {
      id: "implicit-off",
      agentName: "Implicit Off",
      deskDir: path.join(root, "agents", "implicit-off", "desk"),
      config: { desk: {} },
    };
    const engine = {
      agents: new Map([
        [optedIn.id, optedIn],
        [implicitOff.id, implicitOff],
      ]),
      getHeartbeatMaster: () => true,
      getHomeCwd: (agentId) => path.join(root, "home", agentId),
      emitDevLog: vi.fn(),
    };

    const scheduler = new Scheduler({ hub: { engine } });
    scheduler.startHeartbeat();

    expect(createHeartbeatMock).toHaveBeenCalledTimes(2);
    expect(heartbeatInstances[0].start).toHaveBeenCalledOnce();
    expect(heartbeatInstances[1].start).not.toHaveBeenCalled();
  });

  it("passes the Jian signal and scoped tools through and returns the execution promise", () => {
    const root = "/tmp/hana-heartbeat-jian-tools";
    const agent = {
      id: "agent-a",
      agentName: "Agent A",
      deskDir: path.join(root, "agents", "agent-a", "desk"),
      config: { desk: { heartbeat_enabled: true, heartbeat_interval: 31 } },
    };
    const engine = {
      agents: new Map([[agent.id, agent]]),
      getHeartbeatMaster: () => true,
      getHomeCwd: () => path.join(root, "home", agent.id),
      emitDevLog: vi.fn(),
    };
    const scheduler = new Scheduler({ hub: { engine } });
    const execution = Promise.resolve();
    scheduler._executeActivityForAgent = vi.fn(() => execution);
    scheduler.startHeartbeat();

    const scopedTool = { name: "jian_update_status", execute: vi.fn() };
    const cwd = path.join(root, "desk", "task-a");
    const { signal } = new AbortController();
    const result = heartbeatOptions[0].onJianBeat("jian prompt", cwd, { signal, customTools: [scopedTool] });

    expect(result).toBe(execution);
    expect(scheduler._executeActivityForAgent).toHaveBeenCalledWith(
      "agent-a",
      "jian prompt",
      "heartbeat",
      expect.any(String),
      {
        cwd,
        signal,
        extraCustomTools: [scopedTool],
      },
    );
    expect(heartbeatOptions[0].onBeat("workspace prompt", { signal })).toBe(execution);
    expect(scheduler._executeActivityForAgent).toHaveBeenLastCalledWith(
      "agent-a", "workspace prompt", "heartbeat", null, { signal, extraCustomTools: [] },
    );
  });

  it("cancels a patrol summary and records a timeout instead of successful completion", async () => {
    const controller = new AbortController();
    const summaryStarted = Promise.withResolvers<void>();
    const sessionPath = "/tmp/hana-patrol-summary.jsonl";
    const executeIsolated = vi.fn().mockResolvedValue({ sessionPath, error: null });
    const summarizeActivity = vi.fn(async () => {
      summaryStarted.resolve();
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "summary";
    });
    const addActivity = vi.fn();
    const engine = {
      agentsDir: "/tmp",
      getAgent: () => ({ agentName: "Hana" }),
      executeIsolated,
      summarizeActivity,
      getActivityStore: () => ({ add: addActivity }),
      emitDevLog: vi.fn(),
    };
    const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
    const patrol = scheduler._executeActivityForAgent(
      "agent-a", "patrol", "heartbeat", null, { signal: controller.signal },
    );

    const rejected = expect(patrol).rejects.toThrow("patrol timed out");
    await summaryStarted.promise;
    controller.abort(new Error("patrol timed out"));
    await rejected;
    expect(executeIsolated).toHaveBeenCalledWith("patrol", expect.objectContaining({ signal: controller.signal }));
    expect(summarizeActivity).toHaveBeenCalledWith(sessionPath, undefined, { agentId: "agent-a", signal: controller.signal });
    expect(addActivity).toHaveBeenCalledWith(expect.objectContaining({ status: "error", error: "patrol timed out" }));
  });
});
