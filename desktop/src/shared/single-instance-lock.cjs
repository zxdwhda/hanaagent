/**
 * Electron client single-instance guard.
 *
 * Electron's requestSingleInstanceLock() is scoped by userData, so HanaAgent sets
 * userData from HANA_HOME before requesting the lock. Production and dev homes
 * get different namespaces, while duplicate launches within the same home are
 * redirected to the first client.
 */
const path = require("path");
const crypto = require("crypto");

function normalizeForCompare(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getUserDataAppName(hanakoHome, defaultHome) {
  if (normalizeForCompare(hanakoHome) === normalizeForCompare(defaultHome)) {
    return "com.zxdwhda.hanaagent";
  }
  if (normalizeForCompare(hanakoHome) === normalizeForCompare(`${defaultHome}-dev`)) {
    return "com.zxdwhda.hanaagent-dev";
  }
  // Different custom homes may share a basename; the full path owns the client lock.
  const suffix = crypto.createHash("sha256").update(normalizeForCompare(hanakoHome)).digest("hex").slice(0, 12);
  return `com.zxdwhda.hanaagent-${suffix}`;
}

function exitDuplicateClient(app) {
  if (typeof app.exit === "function") {
    app.exit(0);
    return;
  }
  app.quit();
}

function focusExistingWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  if (win.isMinimized?.()) win.restore?.();
  win.show?.();
  win.focus?.();
  return true;
}

function configureClientSingleInstance(app, opts) {
  const { hanakoHome, defaultHome, onSecondInstance } = opts;
  const appName = getUserDataAppName(hanakoHome, defaultHome);
  if (appName) {
    app.setPath("userData", path.join(app.getPath("appData"), appName));
  }

  const gotLock = app.requestSingleInstanceLock({ hanakoHome });
  if (!gotLock) {
    exitDuplicateClient(app);
    return false;
  }

  app.on("second-instance", () => {
    onSecondInstance?.();
  });
  return true;
}

module.exports = {
  configureClientSingleInstance,
  focusExistingWindow,
  getUserDataAppName,
};
