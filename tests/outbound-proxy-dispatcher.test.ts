/**
 * tests/outbound-proxy-dispatcher.test.ts
 *
 * #1612：fetchDispatcherForUrl 是 npm undici fetch 的 per-URL 代理 dispatcher
 * 来源，与 WS 的 webSocketOptionsForUrl 共享 apply 注入的代理配置。
 * 也覆盖 Node 24 的 SDK 请求经全局 dispatcher 应用本地模型等待时间。
 */

import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { getGlobalDispatcher } from "undici";
import { installAssistantStreamGuard } from "../packages/engine/lib/pi-sdk/stream-guard.ts";
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

describe("local model response header budget", () => {
  it("applies the budget to the SDK completion request and preserves cancellation and other traffic", async () => {
    const { stream } = await import("@earendil-works/pi-ai/api/openai-completions");
    const dispatchSpy = vi.spyOn(getGlobalDispatcher(), "dispatch");
    const runtime = createOutboundProxyRuntime({ env: { HANA_LLM_HEADERS_TIMEOUT_MS: "345000" } });
    const server = http.createServer((request, response) => {
      if (request.url === "/cancel/chat/completions") return;
      if (request.url === "/health") {
        response.end("ok");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = {
        id: "fixture", object: "chat.completion.chunk", created: 1, model: "local-fixture",
        choices: [{ index: 0, delta: { content: "completed" }, finish_reason: "stop" }],
      };
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, "127.0.0.1");

    try {
      await once(server, "listening");
      runtime.apply({ mode: "direct" });
      const { port } = server.address() as net.AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      const model: Parameters<typeof stream>[0] = {
        id: "local-fixture", name: "Local fixture", provider: "openai", api: "openai-completions",
        baseUrl: origin + "/v1", input: ["text"], reasoning: false,
        contextWindow: 8192, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const context: Parameters<typeof stream>[1] = {
        messages: [{ role: "user", content: "fixture", timestamp: 0 }],
      };
      const originalStream = vi.fn(stream);
      const session = { agent: { streamFn: originalStream } };
      installAssistantStreamGuard(session);

      const completed = await session.agent.streamFn(model, context, { apiKey: "fixture" });
      expect(originalStream.mock.calls[0]?.[2]?.timeoutMs).toBe(345_000);
      expect((await completed.result()).content).toEqual([{ type: "text", text: "completed" }]);
      const health = await fetch(origin + "/health", { method: "POST" });
      expect(await health.text()).toBe("ok");

      const cancel = new AbortController();
      const cancelRequest = once(server, "request");
      const cancelled = await session.agent.streamFn(
        { ...model, baseUrl: origin + "/cancel" }, context, { apiKey: "fixture", signal: cancel.signal },
      );
      await cancelRequest;
      cancel.abort();
      expect((await cancelled.result()).stopReason).toBe("aborted");

      const attempts = dispatchSpy.mock.calls.map(([options]) => [options.path, options.headersTimeout]);
      expect(attempts).toEqual([
        ["/v1/chat/completions", 345_000],
        ["/health", undefined],
        ["/cancel/chat/completions", 345_000],
      ]);
    } finally {
      runtime.reset();
      dispatchSpy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
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
