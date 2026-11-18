import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { FileEntry, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolvePath as pathForSession } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js";
import { createModuleLogger } from "../debug-log.ts";

type FileRevision = fs.BigIntStats | null;
const log = createModuleLogger("session-persistence");

function readRevision(file: string): FileRevision {
  try {
    return fs.statSync(file, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertRevision(actual: FileRevision, expected: FileRevision) {
  if (actual === expected || (actual && expected
    && actual.dev === expected.dev && actual.ino === expected.ino
    && actual.size === expected.size && actual.mtimeNs === expected.mtimeNs)) return;
  throw Object.assign(new Error("The session history changed on disk. Reopen the session before saving."), {
    code: "session_persistence_conflict",
  });
}

function entryLine(entry: FileEntry) {
  return JSON.stringify(entry) + "\n";
}

/** Hold the original file in place until the replacement is fully written. */
export function writeSessionEntriesAtomically(
  file: string,
  entries: readonly FileEntry[],
  expected: FileRevision = readRevision(file),
): fs.BigIntStats {
  assertRevision(readRevision(file), expected);
  // Rename the link's target, not the symlink, to preserve an existing locator.
  const destination = expected && fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file;
  const temp = `${destination}.tmp-${randomUUID()}`;
  const mode = expected ? Number(expected.mode & 0o777n) : 0o666;
  const fd = fs.openSync(temp, "wx", mode);
  try {
    let revision: fs.BigIntStats;
    try {
      for (const entry of entries) fs.writeFileSync(fd, entryLine(entry));
      fs.fsyncSync(fd);
      revision = fs.fstatSync(fd, { bigint: true });
    } finally {
      fs.closeSync(fd);
    }
    assertRevision(readRevision(file), expected);
    fs.renameSync(temp, destination);
    // The published inode is the prepared file. Do not do fallible I/O after
    // publication that could cause the caller to roll back only its memory.
    return revision;
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort temp cleanup */ }
  }
}

function restorePartialAppend(fd: number, before: fs.BigIntStats, line: Buffer) {
  const after = fs.fstatSync(fd, { bigint: true });
  const added = after.size - before.size;
  if (added === 0n) return after;
  if (added < 0n || added > BigInt(line.length)) {
    throw new Error("Cannot restore the previous session tail after an unexpected file size change.");
  }
  const tail = Buffer.alloc(Number(added));
  const count = fs.readSync(fd, tail, 0, tail.length, before.size);
  if (count !== tail.length || !tail.equals(line.subarray(0, tail.length))) {
    throw new Error("Cannot restore the previous session tail after an unexpected file write.");
  }
  fs.ftruncateSync(fd, Number(before.size));
  return fs.fstatSync(fd, { bigint: true });
}

function persistAppend(
  file: string,
  entry: SessionEntry,
  expected: FileRevision,
  saveRevision: (revision: fs.BigIntStats) => void,
) {
  const line = Buffer.from(entryLine(entry));
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assertRevision(before, expected);
    try {
      fs.writeFileSync(fd, line);
      saveRevision(fs.fstatSync(fd, { bigint: true }));
    } catch (error) {
      // Repair only a tail matching this write. Leave the manager's old
      // revision fenced off if the file has changed in an unexpected way.
      try {
        saveRevision(restorePartialAppend(fd, before, line));
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Session append and tail rollback failed.");
      }
      throw error;
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      // Closing does not change the outcome of a write already completed
      // or rolled back above. Keep the disk and the manager consistent.
      log.warn(`Could not close the session append descriptor: ${error.message}`);
    }
  }
}

type PiSessionPersistenceState = {
  persist: boolean;
  fileEntries: FileEntry[];
  byId: Map<string, SessionEntry>;
  leafId: string | null;
  sessionFile?: string;
  flushed: boolean;
  setSessionFile(file: string): void;
  _rewriteFile(): void;
  _appendEntry(entry: SessionEntry): void;
  branchWithSummary: SessionManager["branchWithSummary"];
};

const installed = Symbol.for("hana.pi-session-persistence");

/** Adapt the pinned Pi SessionManager write hooks, including calls made within Pi. */
export function installSessionPersistenceAdapter(SessionManagerClass: typeof SessionManager) {
  const prototype = SessionManagerClass.prototype as unknown as PiSessionPersistenceState & {
    [installed]?: boolean;
  };
  if (prototype[installed]) return;
  const revisions = new WeakMap<PiSessionPersistenceState, { file: string; revision: FileRevision }>();
  const saveRevision = (manager: PiSessionPersistenceState, file: string, revision: FileRevision) => {
    revisions.set(manager, { file, revision });
  };
  const expectedRevision = (manager: PiSessionPersistenceState, file: string) => {
    const saved = revisions.get(manager);
    return saved?.file === file ? saved.revision : null;
  };
  const { setSessionFile, branchWithSummary } = prototype;

  prototype.setSessionFile = function (file) {
    // Pi can rewrite during migration, before the original method returns.
    const resolved = pathForSession(file);
    saveRevision(this, resolved, readRevision(resolved));
    setSessionFile.call(this, file);
  };
  prototype._rewriteFile = function () {
    if (!this.persist || !this.sessionFile) return;
    const file = this.sessionFile;
    saveRevision(this, file, writeSessionEntriesAtomically(file, this.fileEntries, expectedRevision(this, file)));
  };
  prototype._appendEntry = function (entry) {
    if (this.persist && this.sessionFile) {
      const file = this.sessionFile;
      const expected = expectedRevision(this, file);
      if (this.flushed) {
        persistAppend(file, entry, expected, (revision) => saveRevision(this, file, revision));
      } else if (entry.type === "message" && entry.message.role === "assistant") {
        saveRevision(this, file, writeSessionEntriesAtomically(file, [...this.fileEntries, entry], expected));
        this.flushed = true;
      }
    }
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  };
  prototype.branchWithSummary = function (...args) {
    const previousLeaf = this.leafId;
    try {
      return branchWithSummary.apply(this, args);
    } catch (error) {
      this.leafId = previousLeaf;
      throw error;
    }
  };
  prototype[installed] = true;
}
