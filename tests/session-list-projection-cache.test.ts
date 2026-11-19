import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

import {
  SessionListProjectionCache,
  readSessionSearchText,
  readProjectedSessionSearchText,
  sessionFileRevision,
} from "../packages/engine/core/session-list-projection-cache.ts";

function writeSessionFile(dir: string, name: string, entries: unknown[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return filePath;
}

const HEADER = {
  type: "session",
  id: "sess-1",
  cwd: "/tmp/work",
  timestamp: "2026-06-01T00:00:00.000Z",
};

const USER_MESSAGE = {
  type: "message",
  timestamp: "2026-06-01T00:00:01.000Z",
  message: { role: "user", content: "hello", timestamp: "2026-06-01T00:00:01.000Z" },
};

describe("session-list-projection-cache revision", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-session-projection-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function tryLinkFile(target: string, linkPath: string): boolean {
    try {
      fs.symlinkSync(target, linkPath, "file");
      return true;
    } catch (error) {
      if (process.platform === "win32" && (error as any)?.code === "EPERM") return false;
      throw error;
    }
  }

  it("exposes the file stat signature as the projection revision", async () => {
    const filePath = writeSessionFile(tmpDir, "a.jsonl", [HEADER, USER_MESSAGE]);
    const stat = fs.statSync(filePath);

    const cache = new SessionListProjectionCache();
    const [projection] = await cache.list(tmpDir);

    expect(projection.revision).toBe(sessionFileRevision(stat));
    expect(projection.revision).toBe(`${stat.size}:${stat.mtimeMs}`);
  });

  it("advances the revision when the session file grows", async () => {
    const filePath = writeSessionFile(tmpDir, "a.jsonl", [HEADER, USER_MESSAGE]);

    const cache = new SessionListProjectionCache();
    const [before] = await cache.list(tmpDir);

    // 模拟 /rc 接管期间 Bridge 侧写入新消息
    fs.appendFileSync(filePath, JSON.stringify({
      type: "message",
      timestamp: "2026-06-01T00:10:00.000Z",
      message: { role: "user", content: "from bridge rc", timestamp: "2026-06-01T00:10:00.000Z" },
    }) + "\n");

    const [after] = await cache.list(tmpDir);

    expect(after.revision).not.toBe(before.revision);
  });

  it("keeps the cached projection revision consistent on cache hits", async () => {
    writeSessionFile(tmpDir, "a.jsonl", [HEADER, USER_MESSAGE]);

    const cache = new SessionListProjectionCache();
    const [first] = await cache.list(tmpDir);
    const [second] = await cache.list(tmpDir);

    expect(second.revision).toBe(first.revision);
  });

  it("keeps firstMessage empty for header-only sessions instead of returning a UI placeholder", async () => {
    writeSessionFile(tmpDir, "empty.jsonl", [HEADER]);

    const cache = new SessionListProjectionCache();
    const [projection] = await cache.list(tmpDir);

    expect(projection.messageCount).toBe(0);
    expect(projection.firstMessage).toBe("");
    expect(projection).not.toHaveProperty("allMessagesText");
    expect(await readSessionSearchText(projection.path)).toBe("");
  });

  it("does not expose reminder text in list previews or searchable projection text", async () => {
    writeSessionFile(tmpDir, "reminder.jsonl", [
      HEADER,
      {
        ...USER_MESSAGE,
        message: {
          role: "user",
          content: "[hana_reminder at 2026-07-05 14:05]\n- Plugin demo loaded\n[/hana_reminder]\n\nhello",
        },
      },
    ]);

    const cache = new SessionListProjectionCache();
    const [projection] = await cache.list(tmpDir);

    expect(projection.firstMessage).toBe("hello");
    expect(projection).not.toHaveProperty("allMessagesText");
    expect(await readSessionSearchText(projection.path)).toBe("hello");
  });

  it("uses the displayed text or strips session file markers from an untitled session preview", async () => {
    const marker = '[SessionFile] {"fileId":"fixture-attachment"}';
    writeSessionFile(tmpDir, "presented.jsonl", [
      HEADER,
      { type: "custom", customType: "hana-message-presentation", data: { displayText: "Summarize the notes" } },
      { ...USER_MESSAGE, message: { role: "user", content: marker + "\n\nmodel-facing prompt" } },
    ]);
    writeSessionFile(tmpDir, "legacy.jsonl", [
      HEADER,
      { ...USER_MESSAGE, message: { role: "user", content: marker + "\n\nSummarize the old notes" } },
    ]);
    const projections = await new SessionListProjectionCache().list(tmpDir);
    expect(projections.map(({ firstMessage }) => firstMessage)).toEqual(expect.arrayContaining([
      "Summarize the notes",
      "Summarize the old notes",
    ]));
  });

  it("includes jsonl files that are reached through a filesystem link", async () => {
    const realDir = path.join(tmpDir, "real");
    fs.mkdirSync(realDir, { recursive: true });
    const realFile = writeSessionFile(realDir, "linked.jsonl", [HEADER, USER_MESSAGE]);
    const linkedFile = path.join(tmpDir, "linked.jsonl");
    if (!tryLinkFile(realFile, linkedFile)) return;

    const cache = new SessionListProjectionCache();
    const [projection] = await cache.list(tmpDir);

    expect(projection.path).toBe(linkedFile);
    expect(projection.revision).toBe(sessionFileRevision(fs.statSync(linkedFile)));
  });

  it("does not list repair artifacts as sessions", async () => {
    const filePath = writeSessionFile(tmpDir, "a.jsonl", [HEADER, USER_MESSAGE]);
    writeSessionFile(tmpDir, "a.jsonl.repair.jsonl", [
      HEADER,
      {
        ...USER_MESSAGE,
        message: { role: "user", content: "[omitted 2048 chars by Hana session JSONL guard]" },
      },
    ]);

    const cache = new SessionListProjectionCache();
    const projections = await cache.list(tmpDir);

    expect(projections).toHaveLength(1);
    expect(projections[0].path).toBe(filePath);
  });

  it("refreshes a retargeted link even when both targets have the same file revision", async () => {
    const targets = path.join(tmpDir, "targets");
    fs.mkdirSync(targets);
    const oldTarget = writeSessionFile(targets, "old.jsonl", [HEADER, USER_MESSAGE]);
    const newTarget = writeSessionFile(targets, "new.jsonl", [HEADER, {
      ...USER_MESSAGE, message: { ...USER_MESSAGE.message, content: "other" },
    }]);
    fs.utimesSync(oldTarget, 100, 100);
    fs.utimesSync(newTarget, 100, 100);
    const link = path.join(tmpDir, "active.jsonl");
    if (!tryLinkFile(oldTarget, link)) return;
    const cache = new SessionListProjectionCache();
    const [original] = await cache.list(tmpDir);
    expect(original.firstMessage).toBe("hello");
    fs.unlinkSync(link);
    expect(tryLinkFile(newTarget, link)).toBe(true);
    const [updated] = await cache.list(tmpDir);
    expect(updated.revision).toBe(original.revision);
    expect(updated.firstMessage).toBe("other");
  });

  it("reads the observed file identity if an alias changes between discovery and opening", async () => {
    const targets = path.join(tmpDir, "targets");
    fs.mkdirSync(targets);
    const first = writeSessionFile(targets, "first.jsonl", [HEADER, USER_MESSAGE]);
    const second = writeSessionFile(targets, "second.jsonl", [HEADER, {
      ...USER_MESSAGE, message: { ...USER_MESSAGE.message, content: "different target" },
    }]);
    const link = path.join(tmpDir, "observed.jsonl");
    if (!tryLinkFile(first, link)) return;
    const firstCanonical = fs.realpathSync(first);
    const stat = fsp.stat.bind(fsp);
    const spy = vi.spyOn(fsp, "stat").mockImplementation(async (file, ...args) => {
      if (file === firstCanonical) {
        fs.unlinkSync(link);
        expect(tryLinkFile(second, link)).toBe(true);
      }
      return (stat as any)(file, ...args);
    });
    try {
      const [projection] = await new SessionListProjectionCache().list(tmpDir);
      expect(projection.firstMessage).toBe("hello");
      expect(await readProjectedSessionSearchText(projection)).toBe("hello");
      fs.renameSync(first, first + ".backup");
      expect(tryLinkFile(second, first)).toBe(true);
      expect(await readProjectedSessionSearchText(projection)).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
});
