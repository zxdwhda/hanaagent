import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDiaryRoute } from "../apps/server/routes/diary.ts";

describe("diary route", () => {
  const jobId = "560394e5-e213-4c20-b434-1dd79b0f62f2";
  const jobPath = "/api/diary/jobs/" + jobId;
  const submit = (targetDate?: string) => ({
    method: "POST",
    body: JSON.stringify({ jobId, targetDate }),
    headers: { "content-type": "application/json" },
  });

  function makeApp(engine: any) {
    const app = new Hono();
    app.route("/api", createDiaryRoute(engine));
    return app;
  }

  it("keeps the legacy no-body diary write contract", async () => {
    const engine = {
      writeDiary: vi.fn().mockResolvedValue({
        filePath: "/tmp/diary.md",
        content: "# diary",
        logicalDate: "2026-05-07",
      }),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/diary/write", { method: "POST" });

    expect(res.status).toBe(200);
    expect(engine.writeDiary).toHaveBeenCalledWith({ targetDate: undefined });
  });

  it("passes an explicit targetDate to the diary writer", async () => {
    const engine = {
      writeDiary: vi.fn().mockResolvedValue({
        filePath: "/tmp/diary.md",
        content: "# diary",
        logicalDate: "2026-05-06",
      }),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/diary/write", {
      method: "POST",
      body: JSON.stringify({ targetDate: "2026-05-06" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(engine.writeDiary).toHaveBeenCalledWith({ targetDate: "2026-05-06" });
  });

  it("returns immediately and lets a disconnected caller query the eventual stored result", async () => {
    const write = Promise.withResolvers<{ filePath: string; logicalDate: string }>();
    const engine = { writeDiary: vi.fn(() => write.promise) };
    const app = makeApp(engine);

    const controller = new AbortController();
    const accepted = await app.request("/api/diary/jobs", {
      ...submit("2026-05-06"), signal: controller.signal,
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ status: "running" });
    controller.abort();
    expect(await (await app.request(jobPath)).json()).toEqual({ status: "running" });

    write.resolve({ filePath: "/tmp/verified-diary.md", logicalDate: "2026-05-06" });
    await vi.waitFor(async () => {
      const endpoint = await app.request(jobPath);
      expect(endpoint.status).toBe(200);
      expect(endpoint.headers.get("Cache-Control")).toBe("no-store");
      expect(await endpoint.json()).toMatchObject({ status: "succeeded", filePath: "/tmp/verified-diary.md" });
    });
    expect(engine.writeDiary).toHaveBeenCalledOnce();
  });

  it("reuses a task ID and reports real writer failures from the job endpoint", async () => {
    const write = Promise.withResolvers<{ error: string }>();
    const engine = { writeDiary: vi.fn(() => write.promise) };
    const app = makeApp(engine);
    expect((await app.request(jobPath)).status).toBe(404);
    expect((await app.request("/api/diary/jobs", submit("2026-05-06"))).status).toBe(202);
    expect((await app.request("/api/diary/jobs", submit("2026-05-06"))).status).toBe(202);
    expect((await app.request("/api/diary/jobs", submit("2026-05-07"))).status).toBe(409);
    expect(engine.writeDiary).toHaveBeenCalledOnce();

    write.resolve({ error: "No notes for that date" });
    await vi.waitFor(async () => {
      const endpoint = await app.request(jobPath);
      expect(await endpoint.json()).toEqual({ status: "failed", error: "No notes for that date" });
    });
    expect((await app.request("/api/diary/jobs", submit("2026-05-06"))).status).toBe(200);
    expect(engine.writeDiary).toHaveBeenCalledOnce();
  });

  it("expires retained results while keeping long-running jobs queryable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const write = Promise.withResolvers<{ filePath: string }>();
      const engine = { writeDiary: vi.fn(() => write.promise) };
      const app = makeApp(engine);
      expect((await app.request("/api/diary/jobs", submit())).status).toBe(202);

      vi.setSystemTime(Date.now() + 31 * 60_000);
      expect(await (await app.request(jobPath)).json()).toEqual({ status: "running" });

      write.resolve({ filePath: "/tmp/long-diary.md" });
      await vi.waitFor(async () => {
        expect(await (await app.request(jobPath)).json()).toMatchObject({ status: "succeeded" });
      });
      vi.setSystemTime(Date.now() + 31 * 60_000);
      expect((await app.request(jobPath)).status).toBe(404);
      expect(engine.writeDiary).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
