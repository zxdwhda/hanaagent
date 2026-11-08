import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLegacyChannelOwnerGuard } from "../lib/bridge/channel-owner.ts";

const adapters = vi.hoisted(() => ({ create: vi.fn(), inbound: null as any }));
vi.mock("../lib/bridge/telegram-adapter.ts", () => ({ createTelegramAdapter: (...args) => adapters.create(...args) }));
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";

const dirs: string[] = [];
function homes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-owner-"));
  dirs.push(dir);
  const legacyHome = path.join(dir, ".hanako");
  fs.mkdirSync(legacyHome);
  fs.writeFileSync(path.join(legacyHome, "server-info.json"), JSON.stringify({ pid: 4321, token: "private-legacy-token" }));
  return { legacyHome, hanakoHome: path.join(dir, ".hanaagent") };
}

afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("legacy channel owner probe", () => {
  it("blocks a live author server without reflecting its credentials", () => {
    const h = homes(), kill = vi.fn();
    const state = createLegacyChannelOwnerGuard({ ...h, kill })();
    expect(state.blocked).toBe(true);
    expect(kill).toHaveBeenCalledWith(4321, 0);
    expect(JSON.stringify(state)).not.toContain("private-legacy-token");
  });

  it("allows an absent or dead server but treats EPERM as occupied", () => {
    const h = homes();
    const dead = createLegacyChannelOwnerGuard({ ...h, kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } });
    expect(dead().blocked).toBe(false);
    const denied = createLegacyChannelOwnerGuard({ ...h, kill: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } });
    expect(denied().blocked).toBe(true);
    fs.unlinkSync(path.join(h.legacyHome, "server-info.json"));
    expect(denied().blocked).toBe(false);
  });

  it("does not mistake the author itself or unrelated fixture homes for a fork", () => {
    const h = homes(), kill = vi.fn();
    expect(createLegacyChannelOwnerGuard({ hanakoHome: h.legacyHome, kill })().blocked).toBe(false);
    expect(createLegacyChannelOwnerGuard({ hanakoHome: os.tmpdir(), kill })().blocked).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("fails closed for unreadable or malformed owner metadata", () => {
    const h = homes();
    fs.writeFileSync(path.join(h.legacyHome, "server-info.json"), "{broken");
    expect(createLegacyChannelOwnerGuard(h)().blocked).toBe(true);
    fs.unlinkSync(path.join(h.legacyHome, "server-info.json"));
    fs.mkdirSync(path.join(h.legacyHome, "server-info.json"));
    expect(createLegacyChannelOwnerGuard(h)().blocked).toBe(true);
  });

  it.each([0, -1, 1.5, "4321", 0x80000000])("rejects invalid pid %s before probing processes", (pid) => {
    const h = homes(), kill = vi.fn();
    fs.writeFileSync(path.join(h.legacyHome, "server-info.json"), JSON.stringify({ pid }));
    expect(createLegacyChannelOwnerGuard({ ...h, kill })().blocked).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });
});

function fixture(guard: () => { blocked: boolean }) {
  const adapter = { sendReply: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  adapters.create.mockImplementation(({ onMessage }) => { adapters.inbound = onMessage; return adapter; });
  const hub = { eventBus: { emit: vi.fn() }, send: vi.fn() };
  const engine = { hanakoHome: os.tmpdir(), getAgent: vi.fn(), abortBridgeSession: vi.fn().mockResolvedValue(undefined) };
  const manager = new BridgeManager({ engine, hub, channelOwnerGuard: guard });
  return { manager, adapter, engine, hub };
}

describe("BridgeManager single-owner enforcement", () => {
  beforeEach(() => { adapters.create.mockReset(); vi.useFakeTimers(); });

  it("refuses both manual and automatic startup before adapter creation", () => {
    const { manager } = fixture(() => ({ blocked: true }));
    manager.startPlatform("telegram", { token: "new-private" }, "hanako");
    manager.autoStart(new Map([["hanako", { config: { bridge: { telegram: { enabled: true, token: "new-private" } } } }]]));
    expect(adapters.create).not.toHaveBeenCalled();
    expect(manager.getStatus("hanako").telegram).toMatchObject({ status: "error", error: expect.stringContaining("作者版") });
    expect(JSON.stringify(manager.getStatus(null))).not.toContain("private");
    manager.stopAll();
  });

  it("allows a free owner then stops its connection if the author appears", async () => {
    let occupied = false;
    const { manager, adapter } = fixture(() => ({ blocked: occupied }));
    manager.startPlatform("telegram", { token: "new-private" }, "hanako");
    const captured = manager._platforms.get("telegram:hanako").adapter;
    await captured.sendReply("owner", "before");
    expect(adapter.sendReply).toHaveBeenCalledOnce();
    occupied = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(manager.getStatus("hanako").telegram.status).toBe("error");
    expect(() => captured.sendReply("owner", "after")).toThrow("作者版");
    expect(adapter.sendReply).toHaveBeenCalledOnce();
    occupied = false;
    expect(() => captured.sendReply("owner", "stale connection")).toThrow("已停止");
    expect(adapter.sendReply).toHaveBeenCalledOnce();
    manager.stopAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blocks inbound dispatch immediately before the periodic poll", async () => {
    let occupied = false;
    const { manager, hub, adapter } = fixture(() => ({ blocked: occupied }));
    manager.startPlatform("telegram", { token: "new-private" }, "hanako");
    occupied = true;
    await adapters.inbound({ agentId: "hanako", sessionKey: "tg_dm_owner@hanako", userId: "owner", chatId: "owner", text: "hello" });
    expect(hub.send).not.toHaveBeenCalled();
    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(manager._pending.size).toBe(0);
    manager.stopAll();
  });

  it("checks outbound immediately even when a preexisting adapter reference is retained", () => {
    let occupied = false;
    const { manager, adapter } = fixture(() => ({ blocked: occupied }));
    manager.startPlatform("telegram", { token: "new-private" }, "hanako");
    const captured = manager._platforms.get("telegram:hanako").adapter;
    occupied = true;
    expect(() => captured.sendReply("owner", "must not send")).toThrow("作者版");
    expect(adapter.sendReply).not.toHaveBeenCalled();
    expect(adapter.stop).toHaveBeenCalledOnce();
    manager.stopAll();
  });

  it("closes an adapter if the author appears during its factory handshake", () => {
    let occupied = false;
    const { manager, adapter } = fixture(() => ({ blocked: occupied }));
    adapters.create.mockImplementation(({ onStatus }) => {
      occupied = true;
      onStatus("connected");
      return adapter;
    });
    manager.startPlatform("telegram", { token: "new-private" }, "hanako");
    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(manager.getStatus("hanako").telegram.status).toBe("error");
    expect(vi.getTimerCount()).toBe(0);
    manager.stopAll();
  });

  it("does not recurse when aborting an active session emits another bridge event", () => {
    let occupied = false;
    const { manager, adapter, engine } = fixture(() => ({ blocked: occupied }));
    manager.startPlatform("telegram", { token: "new-private" }, "hanako");
    manager._processing.add("tg_dm_owner@hanako");
    engine.abortBridgeSession.mockImplementation(() => { manager._checkChannelOwnership(); return Promise.resolve(); });
    occupied = true;
    expect(manager._checkChannelOwnership()).toBe(false);
    expect(engine.abortBridgeSession).toHaveBeenCalledOnce();
    expect(adapter.stop).toHaveBeenCalledOnce();
    manager.stopAll();
  });
});
