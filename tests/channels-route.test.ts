import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import { createChannelsRoute } from "../apps/server/routes/channels.ts";
import { ChannelManager } from "../packages/engine/core/channel-manager.ts";
import { appendMessage, createChannel, getChannelMeta, readBookmarks, updateChannelMeta } from "../packages/engine/lib/channels/channel-store.ts";
import { updateAgentPhoneRuntime } from "../packages/engine/lib/conversations/agent-phone-runtime.ts";
import { AutomationSuggestionStore } from "../packages/engine/lib/tools/automation-suggestion-store.ts";
import { createAutomationTool } from "../packages/engine/lib/tools/automation-tool.ts";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  updateAgentPhoneProjectionMeta,
} from "../packages/engine/lib/conversations/agent-phone-projection.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-channels-route-test-"));
}

describe("channels route membership contract", () => {
  let tmpDir;
  let app;
  let engine;
  let refreshChannelProactiveSchedule;
  let triggerChannelDelivery;
  let abortAgentPhoneSessions;
  let agentList;
  let channelsEnabled;

  beforeEach(() => {
    tmpDir = mktemp();
    agentList = [];
    channelsEnabled = true;
    engine = {
      channelsDir: path.join(tmpDir, "channels"),
      agentsDir: path.join(tmpDir, "agents"),
      userDir: path.join(tmpDir, "user"),
      userName: "user",
      currentAgentId: "alice",
      getPrimaryAgentId: () => "alice",
      isChannelsEnabled: () => channelsEnabled,
      setChannelsEnabled: vi.fn(async (enabled) => {
        channelsEnabled = !!enabled;
      }),
      availableModels: [
        { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" },
      ],
      listAgents: () => agentList,
      getAgent: (id) => ["alice", "bob", "carol"].includes(id)
        ? { id, agentDir: path.join(tmpDir, "agents", id) }
        : null,
    };
    fs.mkdirSync(engine.channelsDir, { recursive: true });
    fs.mkdirSync(engine.agentsDir, { recursive: true });
    fs.mkdirSync(engine.userDir, { recursive: true });
    for (const id of ["alice", "bob", "carol"]) {
      fs.mkdirSync(path.join(engine.agentsDir, id), { recursive: true });
    }
    const channelManager = new ChannelManager({
      channelsDir: engine.channelsDir,
      agentsDir: engine.agentsDir,
      userDir: engine.userDir,
      getHub: () => ({ eventBus: { emit: vi.fn() } }),
    });
    engine.createChannelEntry = (input) => channelManager.createChannelEntry(input);

    refreshChannelProactiveSchedule = vi.fn();
    triggerChannelDelivery = vi.fn(() => Promise.resolve());
    abortAgentPhoneSessions = vi.fn();
    app = new Hono();
    app.route("/api", createChannelsRoute(engine, {
      triggerChannelDelivery,
      refreshChannelProactiveSchedule,
      abortAgentPhoneSessions,
      agentPhoneActivities: {
        snapshot: (conversationId) => conversationId === "ch_crew"
          ? [{ conversationId, agentId: "hana", state: "idle", summary: "已回复" }]
          : [],
      },
      channelRouter: {
        tickerSnapshot: (conversationId) => conversationId === "ch_crew"
          ? { active: { channelName: conversationId, agentId: "hana", delivered: 1, agentCount: 2 } }
          : null,
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exposes a pending automation from a member's phone session only in its channel and Studio", async () => {
    await createChannel(engine.channelsDir, {
      id: "ch_crew", name: "Crew", members: ["alice", "bob"], description: "", intro: "",
    });
    await createChannel(engine.channelsDir, {
      id: "ch_other", name: "Other", members: ["alice", "bob"], description: "", intro: "",
    });
    const agentDir = path.join(engine.agentsDir, "alice");
    const phoneSession = "phone/sessions/ch_crew/one.jsonl";
    const sessionPath = path.join(agentDir, phoneSession);
    await updateAgentPhoneRuntime({
      agentDir, agentId: "alice", conversationId: "ch_crew", conversationType: "channel",
      patch: { phoneSessionFile: phoneSession },
    });
    engine.getSessionIdForPath = (value) => value === sessionPath ? "phone-session" : null;
    engine.getRuntimeContext = () => ({ studioId: "studio-1" });
    const store = new AutomationSuggestionStore();
    engine.getAutomationSuggestionStore = () => store;
    const addJob = vi.fn();
    const tool = createAutomationTool({ studioId: "studio-1", listJobs: () => [], addJob }, {
      automationSuggestionStore: store,
      getAgentId: () => "alice",
      getHomeCwd: () => agentDir,
    });
    const draft = await tool.execute(
      "automation-tool", { action: "create", scheduleType: "cron", schedule: "0 9 * * *", prompt: "Review the board" },
      undefined, undefined, { sessionId: "phone-session", sessionManager: { getSessionFile: () => sessionPath } },
    );
    const id = (draft.details as any).suggestionId;
    expect(id).toBeTruthy();
    expect(addJob).not.toHaveBeenCalled();
    const response = await app.request("/api/channels/ch_crew/automation-suggestions");
    expect(response.status).toBe(200);
    const { suggestions } = await response.json();
    expect(suggestions).toEqual([{
      sessionId: "phone-session",
      block: expect.objectContaining({ suggestionId: id, status: "pending", title: "Review the board" }),
    }]);
    const other = await app.request("/api/channels/ch_other/automation-suggestions");
    expect(await other.json()).toEqual({ suggestions: [] });
    engine.getRuntimeContext = () => ({ studioId: "studio-2" });
    expect(await (await app.request("/api/channels/ch_crew/automation-suggestions")).json()).toEqual({ suggestions: [] });
    engine.getRuntimeContext = () => ({ studioId: "studio-1" });
    await store.apply({ sessionId: "phone-session", studioId: "studio-1", ref: id });
    expect(addJob).toHaveBeenCalledOnce();
    expect(await (await app.request("/api/channels/ch_crew/automation-suggestions")).json()).toEqual({ suggestions: [] });
  });

  it("pages old history by position while messages arrive and the metadata changes", async () => {
    const { filePath } = await createChannel(engine.channelsDir, {
      id: "ch_crew", name: "Crew", members: ["alice", "bob"], description: "", intro: "",
    });
    const bodies = Array.from({ length: 205 }, (_, index) =>
      index === 130 ? "旧消息🌸".repeat(18000) : `Message ${index}`);
    fs.appendFileSync(filePath, bodies.map(body =>
      `\n### 爱丽丝 | 2026-05-19 12:00:00\n\n${body}\n\n---\n`).join(""));

    const endpoint = "/api/channels/ch_crew";
    const first = await (await app.request(`${endpoint}?limit=100`)).json();
    expect(first.messages.map(message => message.body)).toEqual(bodies.slice(105));
    expect(first.nextBefore).toBeGreaterThan(0);
    await appendMessage(filePath, "bob", "Live reply");
    await updateChannelMeta(filePath, { description: "长描述".repeat(30000) });

    const second = await (await app.request(`${endpoint}?limit=100&before=${first.nextBefore}`)).json();
    expect(second.description).toHaveLength(90000);
    expect(second.messages.map(message => message.body)).toEqual(bodies.slice(5, 105));
    const oldest = await (await app.request(`${endpoint}?limit=100&before=${second.nextBefore}`)).json();
    expect(oldest.messages.map(message => message.body)).toEqual(bodies.slice(0, 5));
    expect(oldest.nextBefore).toBeNull();

    const latest = await (await app.request(`${endpoint}?limit=100`)).json();
    expect(latest.messages.map(message => message.body)).toEqual([...bodies.slice(106), "Live reply"]);
    const full = await (await app.request(endpoint)).json();
    expect(full.messages).toHaveLength(206);
    expect(full).not.toHaveProperty("nextBefore");
    expect((await app.request(`${endpoint}?limit=201`)).status).toBe(400);
    expect((await app.request(`${endpoint}?limit=100&before=${first.nextBefore + 1}`)).status).toBe(409);
  });

  it("rejects creating a group channel with fewer than two unique agent members", async () => {
    const res = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Solo",
        members: ["alice"],
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/at least 2/i);
  });

  it("downloads only the selected group conversation", async () => {
    const selected = await createChannel(engine.channelsDir, {
      id: "family",
      name: "Family",
      description: "",
      members: ["alice", "bob"],
      intro: "",
    });
    const other = await createChannel(engine.channelsDir, {
      id: "other",
      name: "Other",
      description: "",
      members: ["alice", "bob"],
      intro: "",
    });
    await appendMessage(selected.filePath, "alice", "selected group hello");
    await appendMessage(other.filePath, "alice", "other group hello");

    const res = await app.request("/api/conversations/ch_family/export");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="hana-channel-Family-/);
    const markdown = await res.text();
    expect(markdown).toContain("selected group hello");
    expect(markdown).not.toContain("other group hello");
  });

  it("downloads only the selected DM conversation", async () => {
    const selected = path.join(engine.agentsDir, "alice", "dm", "bob.md");
    const other = path.join(engine.agentsDir, "alice", "dm", "carol.md");
    fs.mkdirSync(path.dirname(selected), { recursive: true });
    await appendMessage(selected, "alice", "selected private hello");
    await appendMessage(other, "alice", "other private hello");

    const res = await app.request("/api/conversations/dm%3Abob/export?agentId=alice");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="hana-dm-alice-bob-/);
    const markdown = await res.text();
    expect(markdown).toContain("selected private hello");
    expect(markdown).not.toContain("other private hello");
  });

  it.each(["家庭频道", "日本語チャット", "a".repeat(63) + "𠮷"])("downloads the channel %s with a UTF-8 filename", async (name) => {
    const selected = await createChannel(engine.channelsDir, {
      id: "localized",
      name,
      description: "",
      members: ["alice", "bob"],
      intro: "",
    });
    await appendMessage(selected.filePath, "alice", "localized export fixture");

    const res = await app.request("/api/conversations/ch_localized/export");

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition");
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]+\.md"; filename\*=UTF-8''/);
    const encoded = disposition?.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded || "")).toContain(`hana-channel-${name}-`);
    const markdown = await res.text();
    expect(markdown).toContain(name);
    expect(markdown).toContain("localized export fixture");
  });

  it("rejects creating a channel with a missing agent member before writing the channel file", async () => {
    const res = await app.request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mixed Crew",
        members: ["alice", "ghost"],
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: "CHANNEL_AGENT_NOT_FOUND",
      error: "Agent not found: ghost",
    });
    expect(fs.readdirSync(engine.channelsDir)).toEqual([]);
    expect(fs.existsSync(path.join(engine.userDir, "channels.md"))).toBe(false);
  });

  it("freezes channel and phone settings routes when channels are disabled", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob"],
    } as any);
    channelsEnabled = false;

    const requests = [
      () => app.request("/api/conversations/ch_crew/agent-activities"),
      () => app.request("/api/conversations/ch_crew/agent-phone-settings"),
      () => app.request("/api/conversations/ch_crew/agent-phone-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write" }),
      }),
      () => app.request("/api/conversations/ch_crew/agent-phone-tool-mode"),
      () => app.request("/api/conversations/ch_crew/agent-phone-tool-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write" }),
      }),
      () => app.request("/api/conversations/dm%3Abob/agent-phone-settings"),
      () => app.request("/api/conversations/dm%3Abob/agent-phone-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write" }),
      }),
      () => app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode"),
      () => app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "write" }),
      }),
      () => app.request("/api/channels"),
      () => app.request("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Crew", members: ["alice", "bob"] }),
      }),
      () => app.request("/api/channels/ch_crew"),
      () => app.request("/api/channels/ch_crew/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: "carol" }),
      }),
      () => app.request("/api/channels/ch_crew/members/bob", { method: "DELETE" }),
      () => app.request("/api/channels/ch_crew/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      }),
      () => app.request("/api/channels/ch_crew/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp: new Date().toISOString() }),
      }),
      () => app.request("/api/channels/ch_crew", { method: "DELETE" }),
    ];

    for (const request of requests) {
      const res = await request();
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/disabled/i);
    }

    const toggleRes = await app.request("/api/channels/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(toggleRes.status).toBe(200);
    expect(await toggleRes.json()).toMatchObject({ ok: true, enabled: true });
    expect(engine.setChannelsEnabled).toHaveBeenCalledWith(true);
  });

  it("returns agent phone activities for a conversation", async () => {
    const res = await app.request("/api/conversations/ch_crew/agent-activities");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activities).toEqual([
      expect.objectContaining({
        conversationId: "ch_crew",
        agentId: "hana",
        state: "idle",
      }),
    ]);
    expect(data.ticker).toEqual({
      active: { channelName: "ch_crew", agentId: "hana", delivered: 1, agentCount: 2 },
    });
  });

  it("persists channel agent phone tool mode in channel metadata", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob"],
    } as any);

    const setRes = await app.request("/api/conversations/ch_crew/agent-phone-tool-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "write" }),
    });

    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ mode: "write" });
    expect(getChannelMeta(path.join(channelsDir, "ch_crew.md")).agentPhoneToolMode).toBe("write");

    const getRes = await app.request("/api/conversations/ch_crew/agent-phone-tool-mode");
    expect(await getRes.json()).toMatchObject({ mode: "write" });
  });

  it("persists DM agent phone tool mode in the owner agent's conversation projection (#1614 切换入口持久化)", async () => {
    // 默认 read_only（未配置过）
    const before = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode?agentId=alice");
    expect(await before.json()).toMatchObject({ mode: "read_only" });

    const setRes = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode?agentId=alice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "write" }),
    });
    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ ok: true, mode: "write" });

    // 状态归属：写进 conversation 自己的 projection meta（dm-router 回信时从这里读）
    const aliceDir = path.join(tmpDir, "agents", "alice");
    const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(aliceDir, "dm:bob"));
    expect((projection.meta as any).toolMode).toBe("write");

    const getRes = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode?agentId=alice");
    expect(await getRes.json()).toMatchObject({ mode: "write" });

    // 切回 read_only 同样持久化（双向切换）
    await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode?agentId=alice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "read_only" }),
    });
    const reverted = readAgentPhoneProjection(getAgentPhoneProjectionPath(aliceDir, "dm:bob"));
    expect((reverted.meta as any).toolMode).toBe("read_only");
  });

  it("aborts the removed member's running phone session when removing a channel member", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob", "carol"],
    } as any);

    const res = await app.request("/api/channels/ch_crew/members/bob", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, members: ["alice", "carol"] });
    expect(abortAgentPhoneSessions).toHaveBeenCalledWith("channel-member-removed", {
      agentId: "bob",
      conversationId: "ch_crew",
      conversationType: "channel",
    });
  });

  it("reports an error instead of guessing a DM owner when no primary agent is configured", async () => {
    engine.getPrimaryAgentId = () => null;
    engine.currentAgentId = "carol";

    const res = await app.request("/api/conversations/dm%3Abob/agent-phone-settings");

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/no primary agent/i);

    // An explicit owner still works with no primary agent configured.
    const explicitRes = await app.request("/api/conversations/dm%3Abob/agent-phone-settings?agentId=carol");
    expect(explicitRes.status).toBe(200);
  });

  it("reads DM phone settings from the primary agent when focus is different", async () => {
    engine.currentAgentId = "carol";
    await updateAgentPhoneProjectionMeta({
      agentDir: path.join(tmpDir, "agents", "alice"),
      agentId: "alice",
      conversationId: "dm:bob",
      conversationType: "dm",
      patch: {
        toolMode: "write",
        replyMinChars: "20",
        replyMaxChars: "80",
        proactiveEnabled: "false",
        reminderIntervalMinutes: "45",
        guardLimit: "7",
        modelOverrideEnabled: "true",
        modelOverrideId: "deepseek-v4-flash",
        modelOverrideProvider: "deepseek",
      },
    });

    const res = await app.request("/api/conversations/dm%3Abob/agent-phone-settings");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mode: "write",
      replyMinChars: 20,
      replyMaxChars: 80,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 7,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
  });

  it("persists DM phone settings with the same setting surface as two-agent conversations", async () => {
    engine.currentAgentId = "carol";

    const setRes = await app.request("/api/conversations/dm%3Abob/agent-phone-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "write",
        replyMinChars: 12,
        replyMaxChars: 34,
        proactiveEnabled: false,
        reminderIntervalMinutes: 45,
        guardLimit: 5,
        modelOverrideEnabled: true,
        modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
      }),
    });

    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({
      mode: "write",
      replyMinChars: 12,
      replyMaxChars: 34,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 5,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });

    const getRes = await app.request("/api/conversations/dm%3Abob/agent-phone-settings");
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({
      mode: "write",
      replyMinChars: 12,
      replyMaxChars: 34,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 5,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
  });

  it("persists channel phone settings without the removed reply-scope field", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob"],
    } as any);

    const setRes = await app.request("/api/conversations/ch_crew/agent-phone-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "write",
        replyMinChars: 20,
        replyMaxChars: 80,
        proactiveEnabled: false,
        reminderIntervalMinutes: 45,
        guardLimit: 9,
        modelOverrideEnabled: true,
        modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
      }),
    });

    expect(setRes.status).toBe(200);
    const setJson = await setRes.json();
    expect(setJson).toMatchObject({
      mode: "write",
      replyMinChars: 20,
      replyMaxChars: 80,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 9,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
    expect(setJson).not.toHaveProperty("replyInstructions");
    const meta = getChannelMeta(path.join(channelsDir, "ch_crew.md"));
    expect(meta.agentPhoneReplyInstructions).toBeUndefined();
    expect(meta.agentPhoneReplyMinChars).toBe("20");
    expect(meta.agentPhoneReplyMaxChars).toBe("80");
    expect(meta.agentPhoneProactiveEnabled).toBe("false");
    expect(meta.agentPhoneReminderIntervalMinutes).toBe("45");
    expect(meta.agentPhoneGuardLimit).toBe("9");
    expect(meta.agentPhoneModelOverrideEnabled).toBe("true");
    expect(meta.agentPhoneModelOverrideId).toBe("deepseek-v4-flash");
    expect(meta.agentPhoneModelOverrideProvider).toBe("deepseek");
    expect(refreshChannelProactiveSchedule).toHaveBeenCalledOnce();

    const getRes = await app.request("/api/conversations/ch_crew/agent-phone-settings");
    const getJson = await getRes.json();
    expect(getJson).toMatchObject({
      mode: "write",
      replyMinChars: 20,
      replyMaxChars: 80,
      proactiveEnabled: false,
      reminderIntervalMinutes: 45,
      guardLimit: 9,
      modelOverrideEnabled: true,
      modelOverrideModel: { id: "deepseek-v4-flash", provider: "deepseek" },
    });
    expect(getJson).not.toHaveProperty("replyInstructions");
  });

  it("returns default reminder and model override settings for legacy channel metadata", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_legacy",
      name: "Legacy",
      members: ["alice", "bob"],
    } as any);

    const res = await app.request("/api/conversations/ch_legacy/agent-phone-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      proactiveEnabled: true,
      reminderIntervalMinutes: 31,
      guardLimit: 24,
      modelOverrideEnabled: false,
      modelOverrideModel: null,
    });
  });

  it("adds an agent member and creates its channel bookmark", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob"],
    } as any);

    const res = await app.request("/api/channels/ch_crew/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "carol" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ members: ["alice", "bob", "carol"] });
    expect(getChannelMeta(path.join(channelsDir, "ch_crew.md")).members).toEqual(["alice", "bob", "carol"]);
    expect(readBookmarks(path.join(tmpDir, "agents", "carol", "channels.md")).get("ch_crew")).toBe("never");
  });

  it("removes an agent member but refuses to go below the group minimum", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob", "carol"],
    } as any);

    const removeCarol = await app.request("/api/channels/ch_crew/members/carol", {
      method: "DELETE",
    });
    expect(removeCarol.status).toBe(200);
    expect(await removeCarol.json()).toMatchObject({ members: ["alice", "bob"] });
    expect(readBookmarks(path.join(tmpDir, "agents", "carol", "channels.md")).has("ch_crew")).toBe(false);

    const removeBob = await app.request("/api/channels/ch_crew/members/bob", {
      method: "DELETE",
    });
    expect(removeBob.status).toBe(400);
    expect((await removeBob.json()).error).toMatch(/at least 2/i);
    expect(getChannelMeta(path.join(channelsDir, "ch_crew.md")).members).toEqual(["alice", "bob"]);
  });

  it("passes resolved @mentions as scheduling hints when the user posts a channel message", async () => {
    const channelsDir = path.join(tmpDir, "channels");
    agentList = [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob Ray" },
      { id: "carol", name: "Carol" },
    ];
    await createChannel(channelsDir, {
      id: "ch_crew",
      name: "Crew",
      members: ["alice", "bob", "carol"],
    } as any);

    const res = await app.request("/api/channels/ch_crew/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "@Bob Ray 可以看一下吗？" }),
    });

    expect(res.status).toBe(200);
    expect(triggerChannelDelivery).toHaveBeenCalledWith("ch_crew", { mentionedAgents: ["bob"] });
  });

  it("persists DM agent phone tool mode in the primary agent projection by default", async () => {
    const setRes = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "write" }),
    });

    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toMatchObject({ mode: "write" });

    const getRes = await app.request("/api/conversations/dm%3Abob/agent-phone-tool-mode");
    expect(await getRes.json()).toMatchObject({ mode: "write" });
  });
});
