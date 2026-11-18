const net = require("node:net");

/**
 * stale-server-info.cjs — 启动期残留 server-info.json 的处置决策
 *
 * startServer 在 spawn 前发现残留 server-info.json 时，据此决定是否删除该文件、
 * 以及目标端口被残留活进程占用时是否 fail-fast。
 *
 * 契约（与 shutdownServer "杀不死就保留 server-info.json" 的约定对齐）：
 * - server-info.json 是定位残留 server 的唯一线索。对应 PID 只要还活着且未确认
 *   死亡，就必须保留该文件，供下次启动重新验证后复用或终止。
 * - 残留活进程占着目标监听端口时不再盲目 spawn（必然 EADDRINUSE），直接
 *   fail-fast 把 PID / 端口 / 原因带给用户。
 * - portConflict 为 null 表示期望网络配置不可读、无法排除冲突，按冲突处理。
 */
function resolveStaleServerInfoDisposition({ pidAlive, knownDead, portConflict }) {
  if (!pidAlive || knownDead) {
    return { removeInfoFile: true, failFast: false };
  }
  return { removeInfoFile: false, failFast: portConflict !== false };
}

function isLoopbackServerPortFree({ listenHost, listenPort }) {
  if (!["127.0.0.1", "::1"].includes(listenHost)
    || !Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = net.createServer((socket) => socket.destroy());
    probe.once("error", () => resolve(false));
    probe.listen({ host: listenHost, port: listenPort, exclusive: true }, () => {
      probe.close((error) => resolve(!error));
    });
  });
}

module.exports = { resolveStaleServerInfoDisposition, isLoopbackServerPortFree };
