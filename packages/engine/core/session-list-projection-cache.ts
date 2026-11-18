import fs from "fs/promises";
import path from "path";
import { isSessionJsonlFilename } from "../lib/session-jsonl.ts";
import { readFileLikePaths } from "../../shared/link-aware-fs.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { stripSessionReminderBlocks } from "./session-reminders.ts";

const log = createModuleLogger("session-list-cache");
export const SESSION_PROJECTION_IDENTITY = Symbol("session projection file identity");

type SessionFileIdentity = {
  readPath: string;
  locatorKey?: string;
  dev: number;
  ino: number;
};

/**
 * Session 文件修订点：`${size}:${mtimeMs}` stat 签名。
 *
 * 这是会话「磁盘真相」的唯一修订标识，三处必须共用同一格式：
 *   1. 本缓存的失效判据（signature）
 *   2. /api/sessions 列表投影的 `revision` 字段
 *   3. /api/sessions/messages 响应的 `revision` 字段
 * web/mobile 端靠对比 2 和 3 决定是否补拉会话内容（issue #1610）。
 */
export function sessionFileRevision(stat) {
  return `${stat.size}:${stat.mtimeMs}`;
}

export class SessionListProjectionCache {
  declare _dirs: Map<string, Map<string, any>>;

  constructor() {
    this._dirs = new Map();
  }

  async list(sessionDir) {
    let files;
    const resolvedPaths = new Map<string, { locatorKey: string; readPath: string }>();
    try {
      files = (await readFileLikePaths(sessionDir, {
        extension: ".jsonl",
        onRealpathKey: (filePath, locatorKey, readPath) => resolvedPaths.set(filePath, { locatorKey, readPath }),
      }))
        .filter((filePath) => isSessionJsonlFilename(path.basename(filePath)));
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }

    const previous = this._dirs.get(sessionDir) || new Map();
    const next = new Map();

    const project = async (filePath: string) => {
      const resolved = resolvedPaths.get(filePath);
      const readPath = resolved?.readPath ?? filePath;
      let stat;
      try {
        stat = await fs.stat(readPath);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          // 单文件隔离（#414 同族拓扑加固）：EPERM/EIO 等非 ENOENT 错误
          // 只跳过这一个文件，不让整个目录的 list() 调用 reject。
          log.warn(`session projection stat failed for ${filePath}: ${err?.code || ""} ${err?.message || err}`);
        }
        return null;
      }

      const signature = sessionFileRevision(stat);
      const identity: SessionFileIdentity = { readPath, locatorKey: resolved?.locatorKey, dev: stat.dev, ino: stat.ino };
      const cached = previous.get(filePath);
      if (cached?.signature === signature && cached?.identity.readPath === identity.readPath
        && cached.identity.dev === identity.dev && cached.identity.ino === identity.ino) {
        next.set(filePath, cached);
        return cloneProjection(cached.projection);
      }

      const projection = await buildSessionProjection(filePath, stat, identity);
      next.set(filePath, { signature, projection, identity });
      return cloneProjection(projection);
    };
    const projections = [];
    // Bound simultaneous JSONL reads during a cold refresh of a large archive.
    for (let index = 0; index < files.length; index += 8) {
      projections.push(...await Promise.all(files.slice(index, index + 8).map(project)));
    }

    this._dirs.set(sessionDir, next);
    return projections
      .filter(Boolean)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  invalidate(sessionDir = null) {
    if (sessionDir) this._dirs.delete(sessionDir);
    else this._dirs.clear();
  }
}

async function* readSessionEntries(filePath: string, identity?: SessionFileIdentity) {
  const source = await fs.open(identity?.readPath ?? filePath, "r");
  try {
    if (identity) {
      const stat = await source.stat();
      if (stat.dev !== identity.dev || stat.ino !== identity.ino) return;
    }
    for await (const line of source.readLines({ autoClose: false })) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // Skip malformed lines, matching the Pi SDK listing behavior.
        continue;
      }
      yield entry;
    }
  } finally {
    await source.close();
  }
}

export async function readSessionSearchText(filePath: string, identity?: SessionFileIdentity): Promise<string> {
  try {
    const messages = [];
    let hasHeader = false;
    for await (const entry of readSessionEntries(filePath, identity)) {
      if (!hasHeader) {
        if (entry?.type !== "session") return "";
        hasHeader = true;
      }
      const message = entry?.type === "message" ? entry.message : null;
      if (!isVisibleTextMessage(message)) continue;
      const content = stripSessionReminderBlocks(extractTextContent(message));
      if (content) messages.push(content);
    }
    return messages.join(" ");
  } catch {
    return "";
  }
}

export function readProjectedSessionSearchText(session: { path: string; [SESSION_PROJECTION_IDENTITY]?: SessionFileIdentity }) {
  return readSessionSearchText(session.path, session[SESSION_PROJECTION_IDENTITY]);
}

async function buildSessionProjection(filePath, stat, identity: SessionFileIdentity) {
  try {
    let header = null;
    let messageCount = 0;
    let firstMessage = "";
    let name;
    let lastActivityTime = 0;

    for await (const entry of readSessionEntries(filePath, identity)) {
      if (!header) {
        if (entry?.type !== "session") return null;
        header = entry;
        continue;
      }
      if (entry?.type === "session_info") {
        name = entry.name?.trim() || undefined;
      }
      if (entry?.type !== "message") continue;
      messageCount += 1;
      const message = entry.message;
      if (!isVisibleTextMessage(message)) continue;
      const activityTime = parseTimestamp(message.timestamp) ?? parseTimestamp(entry.timestamp);
      if (activityTime != null) lastActivityTime = Math.max(lastActivityTime, activityTime);
      if (!firstMessage && message.role === "user") {
        firstMessage = stripSessionReminderBlocks(extractTextContent(message));
      }
    }
    if (!header) return null;

    return {
      path: filePath,
      [SESSION_PROJECTION_IDENTITY]: identity,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      parentSessionPath: header.parentSession,
      created: parseDate(header.timestamp) || new Date(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs),
      modified: lastActivityTime > 0 ? new Date(lastActivityTime) : parseDate(header.timestamp) || stat.mtime,
      revision: sessionFileRevision(stat),
      messageCount,
      firstMessage,
    };
  } catch {
    return null;
  }
}

function cloneProjection(projection) {
  if (!projection) return null;
  return {
    ...projection,
    created: projection.created ? new Date(projection.created) : projection.created,
    modified: projection.modified ? new Date(projection.modified) : projection.modified,
  };
}

function isVisibleTextMessage(message) {
  return !!message && typeof message === "object"
    && (message.role === "user" || message.role === "assistant") && "content" in message;
}

function extractTextContent(message) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function parseDate(value) {
  const time = parseTimestamp(value);
  return typeof time === "number" ? new Date(time) : null;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return time;
  }
  return null;
}
