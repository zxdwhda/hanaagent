import fs from "node:fs";
import path from "node:path";

export const LEGACY_CHANNEL_OWNER_MESSAGE = "作者版 HANA 仍在运行或状态无法确认。请先停止作者版，再启用 hanaagent 渠道。";

export interface ChannelOwnerState {
  blocked: boolean;
  reason?: "legacy_running" | "owner_info_unreadable" | "owner_info_invalid" | "owner_probe_failed";
}

/**
 * Protect the managed .hanaagent / .hanaagent-dev homes from the sibling author
 * installation. Arbitrary custom HANA_HOME fixtures/tools are outside this
 * deployment contract. An explicit legacyHome/probe is dependency injection for
 * tests; no environment variable can turn off the installed home's protection.
 * Never return the author server's token or other JSON contents.
 */
export function createLegacyChannelOwnerGuard({
  hanakoHome,
  legacyHome,
  kill = (pid: number, signal: 0) => process.kill(pid, signal),
}: {
  hanakoHome?: string;
  legacyHome?: string;
  kill?: (pid: number, signal: 0) => unknown;
}): () => ChannelOwnerState {
  if (typeof hanakoHome !== "string" || !hanakoHome.trim()) return () => ({ blocked: false });
  const ownHome = path.resolve(hanakoHome);
  const managed = [".hanaagent", ".hanaagent-dev"].includes(path.basename(ownHome));
  if (!managed && !legacyHome) return () => ({ blocked: false });
  const authorHome = path.resolve(legacyHome || path.join(path.dirname(ownHome), ".hanako"));
  if (ownHome === authorHome) return () => ({ blocked: false });
  const infoPath = path.join(authorHome, "server-info.json");
  return () => {
    let raw: string;
    try {
      raw = fs.readFileSync(infoPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { blocked: false };
      return { blocked: true, reason: "owner_info_unreadable" };
    }
    let pid: number;
    try {
      pid = JSON.parse(raw)?.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
        return { blocked: true, reason: "owner_info_invalid" };
      }
    } catch {
      return { blocked: true, reason: "owner_info_invalid" };
    }
    try {
      kill(pid, 0);
      return { blocked: true, reason: "legacy_running" };
    } catch (error) {
      if (error?.code === "ESRCH") return { blocked: false };
      // EPERM is evidence of a live inaccessible process, not a dead owner.
      return { blocked: true, reason: "owner_probe_failed" };
    }
  };
}
