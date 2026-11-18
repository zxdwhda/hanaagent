const { execFileSync } = require("node:child_process");

function readProcessStartStamp(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !["darwin", "linux"].includes(process.platform)) return null;
  try {
    const stamp = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 750,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().replace(/\s+/g, " ");
    return /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(stamp) ? stamp : null;
  } catch {
    return null;
  }
}

module.exports = { readProcessStartStamp };
