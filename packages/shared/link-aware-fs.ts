import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { promisify } from "node:util";

export function canonicalFilesystemPathSync(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
}

export function filesystemIdentityKeySync(filePath) {
  return filesystemIdentityKey(canonicalFilesystemPathSync(filePath));
}

function filesystemIdentityKey(canonical) {
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

function direntPath(directory, entry) {
  return path.join(directory, entry.name);
}

export function direntTargetKindSync(directory, entry) {
  if (entry?.isDirectory?.()) return "directory";
  if (entry?.isFile?.()) return "file";
  if (!entry?.isSymbolicLink?.() && process.platform !== "win32") return null;

  try {
    const stat = fs.statSync(direntPath(directory, entry));
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {
    return null;
  }
  return null;
}

export async function direntTargetKind(directory, entry) {
  if (entry?.isDirectory?.()) return "directory";
  if (entry?.isFile?.()) return "file";
  if (!entry?.isSymbolicLink?.() && process.platform !== "win32") return null;

  try {
    const stat = await fsp.stat(direntPath(directory, entry));
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {
    return null;
  }
  return null;
}

export function isDirectoryLikeDirentSync(directory, entry) {
  return direntTargetKindSync(directory, entry) === "directory";
}

export function isFileLikeDirentSync(directory, entry) {
  return direntTargetKindSync(directory, entry) === "file";
}

export function readDirectoryLikeDirentsSync(directory, opts: any = {}) {
  const dedupeRealpath = opts.dedupeRealpath !== false;
  const seen = new Set();
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!isDirectoryLikeDirentSync(directory, entry)) continue;
    if (dedupeRealpath) {
      const key = filesystemIdentityKeySync(direntPath(directory, entry));
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(entry);
  }
  return out;
}

export function readFileLikePathsSync(directory, opts: any = {}) {
  const extension = typeof opts.extension === "string" ? opts.extension : null;
  const dedupeRealpath = opts.dedupeRealpath !== false;
  const seen = new Set();
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (extension && !entry.name.endsWith(extension)) continue;
    if (!isFileLikeDirentSync(directory, entry)) continue;
    const filePath = direntPath(directory, entry);
    if (dedupeRealpath) {
      const key = filesystemIdentityKeySync(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(filePath);
  }
  return out;
}

export async function readFileLikePaths(directory, opts: any = {}) {
  const extension = typeof opts.extension === "string" ? opts.extension : null;
  const dedupeRealpath = opts.dedupeRealpath !== false;
  const seen = new Set();
  const realpathNative = dedupeRealpath ? promisify(fs.realpath.native) : null;
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const out = [];
  // Preserve directory order when deduplicating aliases, while keeping
  // filesystem work off the event loop and the in-flight batch bounded.
  for (let index = 0; index < entries.length; index += 16) {
    const candidates = await Promise.all(entries.slice(index, index + 16).map(async (entry) => {
      if (extension && !entry.name.endsWith(extension)) return null;
      if ((await direntTargetKind(directory, entry)) !== "file") return null;
      const filePath = direntPath(directory, entry);
      const canonical = realpathNative ? await realpathNative(filePath).catch(() => null) : null;
      return { filePath, canonical };
    }));
    for (const candidate of candidates) {
      if (!candidate) continue;
      const { filePath, canonical } = candidate;
      if (dedupeRealpath) {
        const key = filesystemIdentityKey(canonical ?? path.resolve(filePath));
        if (seen.has(key)) continue;
        seen.add(key);
        if (canonical) opts.onRealpathKey?.(filePath, key, canonical);
      }
      out.push(filePath);
    }
  }
  return out;
}
