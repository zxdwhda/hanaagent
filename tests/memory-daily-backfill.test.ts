import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callText } from "../packages/engine/core/llm-client.ts";
import { clearCompiledMemoryArtifacts, writeCompiledResetMarker } from "../packages/engine/lib/memory/compiled-memory-state.ts";
import { createMemoryTicker } from "../packages/engine/lib/memory/memory-ticker.ts";
import { SessionSummaryManager } from "../packages/engine/lib/memory/session-summary.ts";

vi.mock("../packages/engine/core/llm-client.ts", () => ({ callText: vi.fn() }));
vi.mock("../packages/engine/lib/i18n.ts", async (importOriginal) => ({
  ...await importOriginal<object>(),
  getLocale: () => "zh-CN",
}));

function logicalTime(date: string, time = "08:00:00") {
  return new Date(`${date}T${time}`);
}

describe("daily memory archive backfill", () => {
  let memoryDir: string;
  let dailyDir: string;
  let todayPath: string;
  let weekPath: string;
  let longtermPath: string;
  let ticker: ReturnType<typeof createMemoryTicker> | undefined;
  let requests: { operation: string; content: string }[];
  let failArchive = false;
  let failLongterm = false;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(logicalTime("2026-02-11"));
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-daily-backfill-"));
    dailyDir = path.join(memoryDir, "daily");
    todayPath = path.join(memoryDir, "today.md");
    weekPath = path.join(memoryDir, "week.md");
    longtermPath = path.join(memoryDir, "longterm.md");
    fs.mkdirSync(dailyDir);
    requests = [];
    failArchive = false;
    failLongterm = false;
    vi.resetAllMocks();
    vi.mocked(callText).mockImplementation(async ({ messages, usageContext }) => {
      const { operation } = (usageContext as { source: { operation: string } }).source;
      const content = messages.map((message) => message.content).join("\n");
      requests.push({ operation, content });
      if (operation === "compile_daily" && failArchive) throw new Error("fixture provider unavailable");
      if (operation === "compile_longterm" && failLongterm) throw new Error("fixture longterm provider unavailable");
      if (operation === "compile_longterm") return `沉淀：${content}`;
      if (operation === "compile_today" || operation === "compile_daily") return `记录：${content}`;
      throw new Error(`Unexpected model operation: ${operation}`);
    });
  });

  afterEach(async () => {
    await ticker?.stop();
    ticker = undefined;
    fs.rmSync(memoryDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeSummary(date: string, content: string) {
    new SessionSummaryManager(path.join(memoryDir, "summaries")).saveSummary(date, {
      session_id: date,
      updated_at: logicalTime(date).toISOString(),
      summary: `### 重要事实\n- 无\n\n### 事情经过\n- ${date} 08:00 ${content}`,
    });
  }

  function writeDay(date: string, content: string) {
    fs.writeFileSync(path.join(dailyDir, date + ".md"), `## ${date}\n\n${content}\n`);
  }

  async function startTicker() {
    await ticker?.stop();
    ticker = createMemoryTicker({
      agentId: "backfill-fixture",
      configPath: path.join(memoryDir, "config.yaml"),
      summaryManager: new SessionSummaryManager(path.join(memoryDir, "summaries")),
      factStore: {},
      getResolvedMemoryModel: () => ({ model: "fixture", api: "openai-completions", api_key: "unused", base_url: "http://unused" }),
      sessionDir: path.join(memoryDir, "sessions"),
      memoryDir,
      memoryMdPath: path.join(memoryDir, "memory.md"),
      todayMdPath: todayPath,
      weekMdPath: weekPath,
      longtermMdPath: longtermPath,
      factsMdPath: path.join(memoryDir, "facts.md"),
    });
    return ticker;
  }

  it("archives a failed activity day after restart on the next logical date", async () => {
    writeSummary("2026-02-10", "前一天有观鸟记录。");
    writeSummary("2026-02-11", "当天有种植记录。");
    failArchive = true;
    await (await startTicker()).tick();
    expect(fs.existsSync(path.join(dailyDir, "2026-02-10.md"))).toBe(false);

    vi.setSystemTime(logicalTime("2026-02-12"));
    failArchive = false;
    await (await startTicker()).tick();

    expect(fs.readFileSync(path.join(dailyDir, "2026-02-10.md"), "utf8")).toContain("前一天有观鸟记录");
    expect(fs.readFileSync(path.join(dailyDir, "2026-02-11.md"), "utf8")).toContain("当天有种植记录");
    expect(fs.readFileSync(weekPath, "utf8")).toContain("2026-02-10");
    expect(fs.existsSync(path.join(dailyDir, "2026-02-09.md"))).toBe(false);
  });

  it("keeps a date-verified draft-only archive source across a failed write and restart", async () => {
    fs.writeFileSync(todayPath, "编辑保留的观星记录。");
    fs.writeFileSync(path.join(memoryDir, "today-state.json"), JSON.stringify({
      schemaVersion: 1,
      logicalDate: "2026-02-10",
      lastCompiledSummaryUpdatedAt: logicalTime("2026-02-10").toISOString(),
    }));
    failArchive = true;
    await (await startTicker()).tick();
    expect(fs.readFileSync(todayPath, "utf8")).not.toContain("编辑保留的观星记录");

    vi.setSystemTime(logicalTime("2026-02-12"));
    failArchive = false;
    await (await startTicker()).tick();

    expect(fs.readFileSync(path.join(dailyDir, "2026-02-10.md"), "utf8")).toContain("编辑保留的观星记录");
    expect(fs.existsSync(path.join(dailyDir, "2026-02-11.md"))).toBe(false);
  });

  it("assembles the calendar week from only the six completed logical dates", async () => {
    writeDay("2026-02-04", "仍在等待折叠的旧日记。");
    writeDay("2026-02-05", "窗口起点。");
    writeDay("2026-02-10", "窗口末日。");
    writeDay("2026-02-11", "进行中的今天。");
    writeDay("2026-02-12", "未来日期。");
    writeSummary("2026-02-10", "当日写入失败仍需要生成旧日记。");
    failArchive = true;
    await (await startTicker()).tick();

    const week = fs.readFileSync(weekPath, "utf8");
    expect(week).toContain("窗口起点");
    expect(week).toContain("窗口末日");
    expect(week).not.toContain("仍在等待折叠的旧日记");
    expect(week).not.toContain("进行中的今天");
    expect(week).not.toContain("未来日期");
  });

  it("recovers the one unfinished day known to a legacy checkpoint without scanning unproven dates", async () => {
    vi.setSystemTime(logicalTime("2026-02-12"));
    writeSummary("2026-02-09", "没有补编凭据的旧日记。");
    writeSummary("2026-02-10", "旧版断点可确认的待归档日记。");
    fs.writeFileSync(path.join(memoryDir, "daily-state.json"), JSON.stringify({
      schemaVersion: 4,
      logicalDate: "2026-02-11",
      resetAt: null,
      completedSteps: { compileToday: logicalTime("2026-02-11").toISOString() },
      dailyCompletedAt: null,
    }));

    await (await startTicker()).tick();

    expect(fs.readFileSync(path.join(dailyDir, "2026-02-10.md"), "utf8")).toContain("旧版断点可确认");
    expect(fs.existsSync(path.join(dailyDir, "2026-02-09.md"))).toBe(false);
    expect(fs.existsSync(path.join(dailyDir, "2026-02-11.md"))).toBe(false);
  });

  it("migrates a legacy week once, then folds only actual days leaving the calendar window", async () => {
    fs.writeFileSync(weekPath, "导入前的独立旧周摘要。\n");
    writeSummary("2026-02-10", "观鸟日记归档。");
    writeSummary("2026-02-11", "种植日记归档。");
    await (await startTicker()).tick();
    expect(requests.filter(({ operation }) => operation === "compile_longterm").map(({ content }) => content))
      .toEqual([expect.stringContaining("导入前的独立旧周摘要")]);
    expect(fs.readFileSync(weekPath, "utf8")).toContain("观鸟日记归档");

    vi.setSystemTime(logicalTime("2026-02-12"));
    await (await startTicker()).tick();
    expect(requests.filter(({ operation }) => operation === "compile_longterm")).toHaveLength(1);

    vi.setSystemTime(logicalTime("2026-02-18"));
    await (await startTicker()).tick();
    expect(requests.filter(({ operation }) => operation === "compile_longterm")).toHaveLength(2);
    expect(requests.filter(({ operation }) => operation === "compile_longterm")[1].content).toContain("观鸟日记归档");
    expect(fs.readdirSync(dailyDir).filter((file) => file.endsWith(".md"))).toEqual([]);

    vi.setSystemTime(logicalTime("2026-02-19"));
    await (await startTicker()).tick();
    expect(requests.filter(({ operation }) => operation === "compile_longterm")).toHaveLength(2);
  });

  it("does not import a week already assembled by a partially completed v4 job", async () => {
    vi.setSystemTime(logicalTime("2026-02-12"));
    writeDay("2026-02-10", "仍在当周的已归档日记。");
    fs.copyFileSync(path.join(dailyDir, "2026-02-10.md"), weekPath);
    fs.writeFileSync(path.join(memoryDir, "daily-state.json"), JSON.stringify({
      schemaVersion: 4,
      logicalDate: "2026-02-11",
      resetAt: null,
      completedSteps: { compileToday: logicalTime("2026-02-11").toISOString() },
      dailyCompletedAt: null,
    }));

    await (await startTicker()).tick();

    expect(requests.filter(({ operation }) => operation === "compile_longterm")).toEqual([]);
    expect(fs.readFileSync(weekPath, "utf8")).toContain("仍在当周的已归档日记");
    expect(fs.existsSync(`${weekPath}.migrated.bak`)).toBe(false);
  });

  it("holds the legacy week and avoids folding past daily files while its migration fails", async () => {
    fs.writeFileSync(weekPath, "独立旧版周摘要。\n");
    writeDay("2026-02-04", "待折叠的日记。");
    failLongterm = true;

    await (await startTicker()).tick();

    expect(requests.filter(({ operation }) => operation === "compile_longterm").map(({ content }) => content))
      .toEqual([expect.stringContaining("独立旧版周摘要")]);
    expect(fs.readFileSync(weekPath, "utf8")).toBe("独立旧版周摘要。\n");
    expect(fs.existsSync(path.join(dailyDir, "2026-02-04.md"))).toBe(true);

    failLongterm = false;
    await (await startTicker()).tick();

    expect(fs.readFileSync(`${weekPath}.migrated.bak`, "utf8")).toContain("独立旧版周摘要");
    expect(fs.existsSync(path.join(dailyDir, "2026-02-04.md"))).toBe(false);
    expect(requests.filter(({ operation }) => operation === "compile_longterm")).toHaveLength(3);
  });

  it("drops a pre-reset draft snapshot instead of recreating its old archive", async () => {
    fs.writeFileSync(todayPath, "重置前的观星记录。");
    fs.writeFileSync(path.join(memoryDir, "today-state.json"), JSON.stringify({
      schemaVersion: 1,
      logicalDate: "2026-02-10",
      lastCompiledSummaryUpdatedAt: logicalTime("2026-02-10").toISOString(),
    }));
    failArchive = true;
    await (await startTicker()).tick();
    expect(requests.filter(({ operation }) => operation === "compile_daily")).toHaveLength(1);

    vi.setSystemTime(logicalTime("2026-02-12"));
    writeCompiledResetMarker(memoryDir);
    clearCompiledMemoryArtifacts(memoryDir);
    failArchive = false;
    await (await startTicker()).tick();

    expect(requests.filter(({ operation }) => operation === "compile_daily")).toHaveLength(1);
    expect(fs.existsSync(path.join(dailyDir, "2026-02-10.md"))).toBe(false);
    expect(fs.readFileSync(path.join(memoryDir, "daily-state.json"), "utf8")).not.toContain("重置前的观星记录");
  });
});
