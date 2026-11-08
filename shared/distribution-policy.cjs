"use strict";

// This distribution is installed, updated and rolled back by the local release manager.
// There is intentionally no environment switch that re-enables the author's update feeds.
const LOCAL_MANAGED_MESSAGE = "[local-managed] hanaagent 由本地发布管理器安装、更新和回退，不连接作者更新渠道。";

function isLocalManagedDistribution() {
  return true;
}

function localManagedUpdateResult() {
  return {
    ok: false,
    outcome: "error",
    status: "local-managed",
    code: "local-managed",
    error: LOCAL_MANAGED_MESSAGE,
    message: LOCAL_MANAGED_MESSAGE,
  };
}

function assertRemoteUpdatesAllowed() {
  if (isLocalManagedDistribution()) {
    throw Object.assign(new Error(LOCAL_MANAGED_MESSAGE), { code: "local-managed" });
  }
}

module.exports = Object.freeze({
  isLocalManagedDistribution,
  localManagedUpdateResult,
  assertRemoteUpdatesAllowed,
});
