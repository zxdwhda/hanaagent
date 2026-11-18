/**
 * diary.js — 日记 REST API
 *
 * POST /api/diary/write — 生成当日日记
 * POST /api/diary/jobs — 开始生成并立即返回状态
 * GET  /api/diary/jobs/:jobId — 查询已提交的任务
 * GET  /api/diary/list  — 列出已有日记
 */

import fs from "fs";
import { Hono } from "hono";
import { resolveDiaryDir } from "../../../packages/engine/lib/diary/diary-writer.ts";
import { createModuleLogger } from "../../../packages/engine/lib/debug-log.ts";

const log = createModuleLogger("diary");
const DIARY_JOB_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const DIARY_RESULT_TTL_MS = 30 * 60 * 1000;
const MAX_DIARY_RESULTS = 128;

type DiaryJobState =
  | { status: "running" }
  | { status: "succeeded"; filePath: string }
  | { status: "failed"; error: string };

type DiaryJob = {
  targetDate: string | undefined;
  state: DiaryJobState;
  finishedAt: number | null;
};

export function createDiaryRoute(engine) {
  const route = new Hono();
  const jobs = new Map<string, DiaryJob>();

  function pruneDiaryResults() {
    const cutoff = Date.now() - DIARY_RESULT_TTL_MS;
    const retained = [];
    for (const [id, job] of jobs) {
      if (job.finishedAt === null) continue;
      if (job.finishedAt < cutoff) jobs.delete(id);
      else retained.push([id, job.finishedAt] as const);
    }
    if (retained.length <= MAX_DIARY_RESULTS) return;
    retained.sort((a, b) => a[1] - b[1]);
    for (const [id] of retained.slice(0, retained.length - MAX_DIARY_RESULTS)) jobs.delete(id);
  }

  async function runDiaryJob(job: DiaryJob) {
    try {
      const result = await engine.writeDiary({ targetDate: job.targetDate });
      job.state = result.error
        ? { status: "failed", error: result.error }
        : { status: "succeeded", filePath: result.filePath };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`write failed: ${error}`);
      job.state = { status: "failed", error };
    } finally {
      job.finishedAt = Date.now();
      pruneDiaryResults();
    }
  }

  route.post("/diary/jobs", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.jobId !== "string" || !DIARY_JOB_ID.test(body.jobId)) {
      return c.json({ error: "Invalid diary job ID" }, 400);
    }
    if (body.targetDate !== undefined && typeof body.targetDate !== "string") {
      return c.json({ error: "Invalid diary date" }, 400);
    }
    pruneDiaryResults();
    const id = body.jobId.toLowerCase();
    const existing = jobs.get(id);
    if (existing) {
      if (existing.targetDate !== body.targetDate) return c.json({ error: "Diary job ID already used" }, 409);
      return c.json(existing.state, existing.state.status === "running" ? 202 : 200);
    }

    const job: DiaryJob = {
      targetDate: body.targetDate,
      state: { status: "running" },
      finishedAt: null,
    };
    jobs.set(id, job);
    void runDiaryJob(job);
    return c.json({ status: "running" }, 202);
  });

  route.get("/diary/jobs/:jobId", (c) => {
    c.header("Cache-Control", "no-store");
    pruneDiaryResults();
    const job = jobs.get(c.req.param("jobId").toLowerCase());
    return job ? c.json(job.state) : c.json({ error: "Diary job not found" }, 404);
  });

  /** POST /diary/write — 触发日记生成 */
  route.post("/diary/write", async (c) => {
    try {
      let body: any = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const targetDate = typeof body?.targetDate === "string" ? body.targetDate : undefined;
      const result = await engine.writeDiary({ targetDate });
      if (result.error) {
        return c.json({
          error: result.error,
          ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        }, 400);
      }
      return c.json({
        filePath: result.filePath,
        content: result.content,
        logicalDate: result.logicalDate,
        ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      });
    } catch (err) {
      log.error(`write failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  /** GET /diary/list — 列出已有日记文件 */
  route.get("/diary/list", async (c) => {
    const cwd = engine.homeCwd || process.cwd();
    const diaryDir = resolveDiaryDir(cwd);
    try {
      const files = fs.readdirSync(diaryDir)
        .filter(f => f.endsWith(".md"))
        .sort()
        .reverse();
      return c.json({ files });
    } catch {
      return c.json({ files: [] });
    }
  });

  return route;
}
