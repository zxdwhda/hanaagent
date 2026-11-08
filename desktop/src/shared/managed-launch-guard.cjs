"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveHanakoHome } = require("../../../shared/hana-runtime-paths.cjs");

function checkManagedLaunch({ hanakoHome, homeDir = os.homedir(), readFile = fs.readFileSync, kill = process.kill } = {}) {
  if (typeof hanakoHome !== "string" || path.resolve(hanakoHome) !== resolveHanakoHome(undefined, homeDir)) {
    return { blocked: false };
  }

  const lockPath = path.join(homeDir, "zxdwhda", "hanaagent", "operation.lock");
  const recoveryMessage = "管理锁无法确认，请先使用本地发布管理器的 recover 命令检查恢复，再启动 hanaagent。";
  let raw;
  try {
    raw = readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { blocked: false };
    return { blocked: true, reason: "operation-lock-unreadable", message: recoveryMessage };
  }

  const text = typeof raw === "string" ? raw.trim() : "";
  const pid = /^\d+$/.test(text) ? Number(text) : 0;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    return { blocked: true, reason: "operation-lock-invalid", message: recoveryMessage };
  }

  try {
    kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return { blocked: false };
    if (error?.code !== "EPERM") {
      return { blocked: true, reason: "operation-lock-unreadable", message: recoveryMessage };
    }
  }
  return { blocked: true, reason: "operation-running", message: "正在安装/更新/回退，请稍后启动 hanaagent。" };
}

module.exports = { checkManagedLaunch };
