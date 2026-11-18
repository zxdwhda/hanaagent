/**
 * tests/outbound-proxy-dispatcher.test.ts
 *
 * #1612：fetchDispatcherForUrl 是 npm undici fetch 的 per-URL 代理 dispatcher
 * 唯一来源，与 WS 的 webSocketOptionsForUrl 共享同一份代理配置（apply 注入的
 * currentConfig）。Node 内建 fetch 不读取 npm undici 的 global dispatcher，
 * 所以依赖代理的出站 fetch 必须显式从这里拿 dispatcher。
 */

import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createOutboundProxyRuntime, fetchDispatcherForUrl, telegramBotOptions, webSocketOptionsForUrl } from "../packages/engine/lib/net/outbound-proxy.ts";

describe("fetchDispatcherForUrl", () => {
  const runtime = createOutboundProxyRuntime({ log: () => {}, warn: () => {}, env: {} });

  afterEach(() => {
    runtime.reset();
  });

  it("resolves a cached undici dispatcher for proxied targets", () => {
    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7890" });

    const first = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});
    expect(first.proxyUrl).toBe("http://127.0.0.1:7890");
    expect(first.dispatcher).toBeTruthy();

    // 同一代理地址复用同一 dispatcher（连接池不重复建）
    const second = fetchDispatcherForUrl("https://bots.qq.com/app/getAppAccessToken", {});
    expect(second.dispatcher).toBe(first.dispatcher);
  });

  it("returns no dispatcher in direct mode", () => {
    runtime.apply({ mode: "direct" });
    expect(fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {})).toEqual({
      dispatcher: null,
      proxyUrl: "",
    });
  });

  it("honors noProxy bypass from the shared proxy config", () => {
    runtime.apply({
      mode: "manual",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "api.sgroup.qq.com",
    });
    expect(fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {}).dispatcher).toBeNull();
    expect(fetchDispatcherForUrl("https://bots.qq.com/app/getAppAccessToken", {}).dispatcher).toBeTruthy();
  });

  it("rebuilds the dispatcher cache when a new proxy config is applied", () => {
    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:7890" });
    const before = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});

    runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:9999" });
    const after = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});

    expect(after.proxyUrl).toBe("http://127.0.0.1:9999");
    expect(after.dispatcher).not.toBe(before.dispatcher);
  });

  it("supports socks5 proxy urls like the WS path does", () => {
    runtime.apply({ mode: "manual", httpsProxy: "socks5://127.0.0.1:1080" });
    const resolved = fetchDispatcherForUrl("https://api.sgroup.qq.com/gateway", {});
    expect(resolved.proxyUrl).toBe("socks5://127.0.0.1:1080");
    expect(resolved.dispatcher).toBeTruthy();
  });
});

describe("Node-backed Bridge clients honor the selected proxy", () => {
  const runtime = createOutboundProxyRuntime({ env: {} });

  beforeEach(() => {
    for (const key of Object.keys(process.env).filter(key => /(?:^|_)(?:http|https|all|no|ws|wss)_proxy$/i.test(key))) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(() => {
    runtime.reset();
    vi.unstubAllEnvs();
  });

  it("sends Telegram HTTPS requests through the manually configured HTTP CONNECT endpoint", async () => {
    const connectTargets: string[] = [];
    const proxy = http.createServer();
    proxy.on("connect", (request, socket) => {
      connectTargets.push(request.url || "");
      socket.end("HTTP/1.1 502 Test endpoint\r\nConnection: close\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    try {
      const url = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
      runtime.apply({ mode: "manual", httpsProxy: url, noProxy: "bridge-bypass.invalid" });
      const options = telegramBotOptions().request;
      await new Promise<void>(resolve => {
        const request = https.get("https://api.telegram.org", {
          ...options,
          signal: AbortSignal.timeout(2000),
          lookup: (_host, _options, callback) => callback(new Error("Direct DNS disabled by fixture"), "", 4),
        }, response => {
          response.resume();
          resolve();
        });
        request.once("error", () => resolve());
      });
      expect(connectTargets).toEqual(["api.telegram.org:443"]);
      expect(webSocketOptionsForUrl("wss://bridge-bypass.invalid")).toEqual({});
      runtime.apply({ mode: "manual", httpsProxy: "http://127.0.0.1:1" });
      expect(options.agent.getProxyForUrl("https://api.telegram.org")).toBe("http://127.0.0.1:1");
      runtime.apply({ mode: "direct" });
      expect(options.agent.getProxyForUrl("https://api.telegram.org")).toBe("");
    } finally {
      proxy.close();
      await once(proxy, "close");
    }
  });

  it("starts a SOCKS5 dialogue for WebSocket clients rather than sending an HTTP request", async () => {
    const commands: Buffer[] = [];
    const proxy = net.createServer(socket => {
      socket.once("data", greeting => {
        commands.push(greeting);
        socket.write(Buffer.from([5, 0]));
        socket.once("data", request => {
          commands.push(request);
          socket.end(Buffer.from([5, 5, 0, 1, 127, 0, 0, 1, 0, 0]));
        });
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    try {
      runtime.apply({ mode: "manual", wssProxy: `socks5://127.0.0.1:${(proxy.address() as net.AddressInfo).port}` });
      const target = "wss://bridge.fixture.invalid";
      const ws = new WebSocket(target, {
        ...webSocketOptionsForUrl(target),
        handshakeTimeout: 2000,
        lookup: (_host, _options, callback) => callback(null, "127.0.0.2", 4),
      });
      ws.on("error", () => {});
      await new Promise<void>(resolve => ws.once("close", () => resolve()));
      expect(commands[0]?.[0]).toBe(5);
      expect(Array.from(commands[1]?.subarray(0, 4) || [])).toEqual([5, 1, 0, 1]);
    } finally {
      proxy.close();
      await once(proxy, "close");
    }
  });
});
