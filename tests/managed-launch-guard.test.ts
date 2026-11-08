import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkManagedLaunch } from "../desktop/src/shared/managed-launch-guard.cjs";

const homes: string[] = [];
function fixture(contents?: string) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-launch-operation-"));
  homes.push(homeDir);
  const managerRoot = path.join(homeDir, "zxdwhda", "hanaagent");
  fs.mkdirSync(managerRoot, { recursive: true });
  const lockPath = path.join(managerRoot, "operation.lock");
  if (contents !== undefined) fs.writeFileSync(lockPath, contents);
  return { homeDir, hanakoHome: path.join(homeDir, ".hanaagent"), lockPath };
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("managed installation launch guard", () => {
  it("permits normal startup when no management operation holds a lock", () => {
    expect(checkManagedLaunch(fixture())).toEqual({ blocked: false });
  });

  it("blocks a live operation before the app opens the managed data home", () => {
    const item = fixture("321\n");
    const kill = vi.fn();
    const result = checkManagedLaunch({ ...item, kill });
    expect(kill).toHaveBeenCalledWith(321, 0);
    expect(result).toMatchObject({ blocked: true, reason: "operation-running" });
    expect(result.message).toContain("正在安装/更新/回退");
  });

  it("treats EPERM as a live operation without weakening process ownership checks", () => {
    const kill = vi.fn(() => { throw Object.assign(new Error("permission"), { code: "EPERM" }); });
    expect(checkManagedLaunch({ ...fixture("321"), kill })).toMatchObject({ blocked: true, reason: "operation-running" });
  });

  it("permits startup for a dead stale lock without deleting the manager's lock file", () => {
    const item = fixture("321");
    const kill = vi.fn(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(checkManagedLaunch({ ...item, kill })).toEqual({ blocked: false });
    expect(fs.readFileSync(item.lockPath, "utf8")).toBe("321");
  });

  it.each(["", "0", "-1", "1.5", "123junk", "2147483648"])("refuses malformed operation lock %j", (contents) => {
    const kill = vi.fn();
    const result = checkManagedLaunch({ ...fixture(contents), kill });
    expect(result).toMatchObject({ blocked: true, reason: "operation-lock-invalid" });
    expect(result.message).toContain("recover");
    expect(kill).not.toHaveBeenCalled();
  });

  it("leaves arbitrary development and test homes untouched", () => {
    const item = fixture("321");
    const readFile = vi.fn(() => { throw new Error("must not inspect manager lock"); });
    const kill = vi.fn();
    expect(checkManagedLaunch({ ...item, hanakoHome: path.join(item.homeDir, ".hanaagent-dev"), readFile, kill })).toEqual({ blocked: false });
    expect(readFile).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses an unreadable lock instead of assuming no operation is active", () => {
    const readFile = vi.fn(() => { throw Object.assign(new Error("permission"), { code: "EACCES" }); });
    expect(checkManagedLaunch({ ...fixture(), readFile })).toMatchObject({ blocked: true, reason: "operation-lock-unreadable" });
  });
});
