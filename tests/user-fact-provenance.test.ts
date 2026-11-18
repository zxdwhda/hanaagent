import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callText } from "../packages/engine/core/llm-client.ts";
import {
  SessionSummaryManager,
  sessionSummaryRevision,
} from "../packages/engine/lib/memory/session-summary.ts";
import { revalidateUserFactProvenance } from "../packages/engine/lib/memory/user-fact-provenance.ts";
import { projectCurrentSessionBranchEntries } from "../packages/engine/lib/session-jsonl.ts";

vi.mock("../packages/engine/lib/i18n.ts", () => ({ getLocale: () => "zh-CN" }));
vi.mock("../packages/engine/core/llm-client.ts", () => ({ callText: vi.fn() }));

const model = { model: "test", api: "openai-completions", base_url: "https://synthetic.invalid" };
const birding = "是的，我每年秋天都会去看候鸟迁徙。";
const denial = "我不喜欢养兰花。我喜欢观察候鸟。";
const suggestion = "你应该会喜欢养兰花。";
const correction = "我以前喜欢养兰花，现在不喜欢了。";

function entry(id: string, parentId: string | null, role: "user" | "assistant", content: string, second: number) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(Date.UTC(2026, 10, 18, 9, 0, second)).toISOString(),
    message: { role, content },
  };
}

function answer(...facts: string[]) {
  return ["### 重要事实", ...facts, "### 事情经过", "- 用户讨论爱好。"].join("\n");
}

describe("rolling summary user-fact provenance", () => {
  let directory: string;
  let manager: SessionSummaryManager;

  beforeEach(() => {
    vi.resetAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hana-user-fact-provenance-"));
    manager = new SessionSummaryManager(directory);
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("writes verified user utterances and strips rejected assistant, sibling and partial claims", async () => {
    const projection = projectCurrentSessionBranchEntries([
      entry("u1", null, "user", denial, 1),
      entry("a1", "u1", "assistant", suggestion, 2),
      entry("u-old", "a1", "user", "我以前养了兰花。", 3),
      entry("u2", "a1", "user", "听起来不错，谢谢。", 4),
      entry("u3", "u2", "user", birding, 5),
    ]);
    vi.mocked(callText).mockResolvedValueOnce(answer(
      "- [user:a1] " + suggestion,
      "- [user:u-old] 我以前养了兰花。",
      "- [user:u1] 我喜欢养兰花。",
      "- [user:u1] 我喜欢观察候鸟。",
      "- [user:u2] 听起来不错，谢谢。",
      "- [user:u1] " + denial,
      "- [user:u3] " + birding,
      "- 用户喜欢收藏钟表。",
    ));

    await manager.rollingSummary("s1", projection.messages, model, { projection });

    const persisted = manager.getSummary("s1");
    expect(persisted.userFactProvenance).toEqual({
      status: "unresolved",
      candidates: [
        { text: denial, source: { entryId: "u1", sentenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        { text: birding, source: { entryId: "u3", sentenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) } },
      ],
    });
    expect(persisted.summary).toBe(answer("- " + denial, "- " + birding).replace("\n### 事情经过", "\n\n### 事情经过"));
    expect(revalidateUserFactProvenance(persisted.userFactProvenance, projection.messages)).toBe(true);
    const request = vi.mocked(callText).mock.calls[0][0];
    expect(request.messages?.[0].content).toContain("[user:u1] " + denial);
    expect(request.messages?.[0].content).not.toContain("[user:u2]");
    expect(request.messages?.[0].content).not.toContain("[user:a1]");
    expect(request.messages?.[0].content).not.toContain("我以前养了兰花。");
    expect(callText).toHaveBeenCalledOnce();
  });

  it("re-selects a later correction without losing its polarity and retains only the processed prior provenance as a snapshot", async () => {
    const first = entry("u1", null, "user", "我喜欢养兰花。", 1);
    const firstProjection = projectCurrentSessionBranchEntries([first]);
    vi.mocked(callText).mockResolvedValueOnce(answer("- [user:u1] 我喜欢养兰花。"));
    await manager.rollingSummary("s1", firstProjection.messages, model, { projection: firstProjection });
    const before = manager.getSummary("s1");
    expect(manager.markProcessedIfCurrent("s1", sessionSummaryRevision(before))).toBe(true);
    const snapshot = manager.getSummary("s1");
    expect(snapshot.snapshotUserFactProvenance).toEqual(before.userFactProvenance);
    expect(manager.getDirtySessions()).toEqual([]);

    const projection = projectCurrentSessionBranchEntries([
      first,
      entry("u2", "u1", "user", correction, 2),
    ]);
    vi.mocked(callText).mockResolvedValueOnce(answer("- [user:u2] " + correction));
    await manager.rollingSummary("s1", projection.messages, model, { projection });

    const latest = manager.getSummary("s1");
    expect(latest.userFactProvenance).toEqual({
      status: "verified",
      candidates: [{ text: correction, source: { entryId: "u2", sentenceHash: expect.any(String) } }],
    });
    expect(latest.snapshotUserFactProvenance).toEqual(before.userFactProvenance);
    expect(latest.summary).not.toContain("我喜欢养兰花。");
    expect(manager.getDirtySessions()).toEqual([latest]);
    expect(vi.mocked(callText).mock.calls[1][0].messages?.[0].content).toContain("[user:u1] 我喜欢养兰花。");
  });

  it("distinguishes verified empty, malformed output, and a legacy input without source", async () => {
    const projection = projectCurrentSessionBranchEntries([
      entry("a1", null, "assistant", suggestion, 1),
    ]);
    vi.mocked(callText)
      .mockResolvedValueOnce(answer("- 无"))
      .mockResolvedValueOnce(answer("- 用户喜欢养兰花。"))
      .mockResolvedValueOnce(answer("- 无"));
    await manager.rollingSummary("empty", projection.messages, model, { projection });
    await manager.rollingSummary("unresolved", projection.messages, model, { projection });
    await manager.rollingSummary("legacy", [{ role: "user", content: birding }], model);

    expect(manager.getSummary("empty").userFactProvenance).toEqual({ status: "verified", candidates: [] });
    expect(manager.getSummary("unresolved").userFactProvenance).toEqual({ status: "unresolved", candidates: [] });
    expect(manager.getSummary("legacy")).not.toHaveProperty("userFactProvenance");
  });

  it("rejects a bare question and accepts a fact that quotes a question", async () => {
    const fact = "我最喜欢的书是『秋天会回来吗？』";
    const question = "我会喜欢养兰花吗？";
    const projection = projectCurrentSessionBranchEntries([
      entry("u1", null, "user", question, 1),
      entry("u2", "u1", "user", fact, 2),
    ]);
    vi.mocked(callText).mockResolvedValueOnce(answer(
      "- [user:u1] " + question,
      "- [user:u2] " + fact,
    ));

    await manager.rollingSummary("s1", projection.messages, model, { projection });

    expect(manager.getSummary("s1").userFactProvenance).toMatchObject({
      status: "unresolved",
      candidates: [{ text: fact, source: { entryId: "u2" } }],
    });
  });

  it("rebuilds a legacy pending replacement with no new turns and an already current cursor", async () => {
    const projection = projectCurrentSessionBranchEntries([
      entry("u1", null, "user", birding, 1),
    ]);
    manager.saveSummary("s1", {
      session_id: "s1",
      summary: answer("- 用户喜欢养兰花。"),
      cursor: { coveredLeafId: projection.selectedLeafId, lineageHash: projection.lineageHash },
      factReplacementRequired: true,
    });
    vi.mocked(callText).mockResolvedValueOnce(answer("- [user:u1] " + birding));

    const result = await manager.rollingSummary("s1", projection.messages, model, { projection, returnResult: true });

    expect(result).toMatchObject({
      mode: "replace",
      data: {
        factReplacementRequired: true,
        userFactProvenance: {
          status: "verified",
          candidates: [{ text: birding, source: { entryId: "u1" } }],
        },
      },
    });
    const request = vi.mocked(callText).mock.calls[0][0].messages?.[0].content;
    expect(request).not.toContain("用户喜欢养兰花。");
    expect(request).toContain("[user:u1] " + birding);
  });

  it.each([
    { name: "source-backed facts", response: "- [user:u1] " + birding, candidates: [birding] },
    { name: "explicitly empty facts", response: "- 无", candidates: [] },
  ])("retries a pending unproven replacement on the same cursor with $name", async ({
    response, candidates,
  }) => {
    const projection = projectCurrentSessionBranchEntries([
      entry("u1", null, "user", birding, 1),
    ]);
    const cursor = { coveredLeafId: projection.selectedLeafId, lineageHash: projection.lineageHash };
    manager.saveSummary("s1", {
      session_id: "s1",
      summary: answer("- 用户喜欢养兰花。"),
      cursor,
      factReplacementRequired: true,
    });
    vi.mocked(callText)
      .mockResolvedValueOnce(answer("- [user:u1] 每年秋天都会去看候鸟迁徙。"))
      .mockResolvedValueOnce(answer(response));

    await manager.rollingSummary("s1", projection.messages, model, { projection });
    expect(manager.getSummary("s1")).toMatchObject({
      cursor,
      factReplacementRequired: true,
      userFactProvenance: { status: "unresolved", candidates: [] },
    });

    const result = await manager.rollingSummary("s1", projection.messages, model, { projection, returnResult: true });
    expect(result).toMatchObject({ mode: "replace", data: { cursor, factReplacementRequired: true } });
    const proof = manager.getSummary("s1").userFactProvenance;
    expect(proof.status).toBe("verified");
    expect(proof.candidates.map(({ text }: { text: string }) => text)).toEqual(candidates);

    // The existing marked replacement still awaits the consumer, without redoing
    // the successful proof when there is no new turn.
    await manager.rollingSummary("s1", projection.messages, model, { projection });
    expect(callText).toHaveBeenCalledTimes(2);
  });

  it("persists a scrubbed fact and proof without persisting its redacted segment", async () => {
    const syntheticSsn = "000-00-0000";
    const utterance = "我登记的测试号码是 " + syntheticSsn + "。";
    const projection = projectCurrentSessionBranchEntries([
      entry("u1", null, "user", utterance, 1),
    ]);
    vi.mocked(callText).mockResolvedValueOnce(answer("- [user:u1] " + utterance));
    await manager.rollingSummary("s1", projection.messages, model, { projection });
    const serialized = fs.readFileSync(path.join(directory, "s1.json"), "utf8");
    const persisted = JSON.parse(serialized);

    expect(serialized).not.toContain(syntheticSsn);
    expect(serialized).not.toContain("[user:u1]");
    expect(persisted.userFactProvenance.candidates[0].text).toContain("[REDACTED]");
    expect(revalidateUserFactProvenance(persisted.userFactProvenance, projection.messages)).toBe(true);
    expect(revalidateUserFactProvenance(persisted.userFactProvenance, [
      { role: "user", entryId: "u1", content: "我没有登记号码。" },
    ])).toBe(false);
  });
});
