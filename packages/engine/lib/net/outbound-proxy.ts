// lib/net/outbound-proxy.ts

import { AsyncLocalStorage } from "node:async_hooks";
import {
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent,
  Socks5ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import {
  normalizeNetworkProxyConfig,
  proxyConfigFromEnvironment,
  resolveProxyForUrl,
} from "../../../shared/network-proxy.ts";
import { isLocalBaseUrl } from "../../../shared/net-utils.ts";

const originalGlobalDispatcher = getGlobalDispatcher();
const modelHeaderBudget = new AsyncLocalStorage<{ origin: string; timeoutMs: number } | null>();
const DEFAULT_LOCAL_MODEL_HEADERS_TIMEOUT_MS = 600_000;
let currentLocalModelHeadersTimeout = DEFAULT_LOCAL_MODEL_HEADERS_TIMEOUT_MS;

export function withLocalModelResponseHeaderBudget<T>(
  model: { api?: string; baseUrl?: string },
  request: (timeoutMs?: number) => T,
): T {
  const baseUrl = model?.baseUrl;
  const budget = model?.api === "openai-completions" && baseUrl && isLocalBaseUrl(baseUrl)
    ? { origin: new URL(baseUrl).origin, timeoutMs: currentLocalModelHeadersTimeout }
    : null;
  return modelHeaderBudget.run(budget, () => request(budget?.timeoutMs));
}

function localModelHeadersTimeout(env: NodeJS.ProcessEnv) {
  const configured = Number(env.HANA_LLM_HEADERS_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647
    ? configured
    : DEFAULT_LOCAL_MODEL_HEADERS_TIMEOUT_MS;
}
let currentConfig = normalizeNetworkProxyConfig(undefined);
let currentDispatcher: any = null;
let nodeProxyAgentCache: Map<string, any> = new Map();
let undiciProxyDispatcherCache: Map<string, any> = new Map();

function proxyProtocol(proxyUrl: any) {
  try {
    return new URL(proxyUrl).protocol;
  } catch {
    return "";
  }
}

function createUndiciProxyDispatcher(proxyUrl: any) {
  const protocol = proxyProtocol(proxyUrl);
  if (protocol === "http:" || protocol === "https:") {
    return new UndiciProxyAgent(proxyUrl);
  }
  if (protocol === "socks:" || protocol === "socks5:") {
    return new Socks5ProxyAgent(proxyUrl);
  }
  throw new Error(`unsupported proxy protocol: ${protocol || "(unknown)"}`);
}

function collectUnique(values: any[]) {
  return [...new Set(values.filter(Boolean))];
}

function buildEffectiveProxyConfig(config: any, env: any) {
  const normalized = normalizeNetworkProxyConfig(config);
  if (normalized.mode === "system") return proxyConfigFromEnvironment(env);
  return normalized;
}

function hasUsableProxy(config: any) {
  return !!(config.httpProxy || config.httpsProxy || config.wsProxy || config.wssProxy);
}

function createGlobalDispatcher(config: any, env = process.env) {
  const effective = buildEffectiveProxyConfig(config, env);
  const useProxy = effective.mode !== "direct" && hasUsableProxy(effective);
  const direct = useProxy ? new UndiciAgent() : null;
  const proxyUrls = useProxy ? collectUnique([effective.httpProxy, effective.httpsProxy]) : [];
  const proxyDispatchers = new Map(proxyUrls.map(url => [url, createUndiciProxyDispatcher(url)]));

  return {
    dispatch(opts: any, handler: any) {
      const origin = opts?.origin ? String(opts.origin) : "";
      const proxyUrl = useProxy && origin ? resolveProxyForUrl(origin, effective, env) : "";
      const dispatcher = (proxyUrl ? proxyDispatchers.get(proxyUrl) : null)
        ?? direct ?? originalGlobalDispatcher;
      // OpenAI's SDK uses global fetch. Match the model origin and POST so
      // unrelated traffic and cross-origin redirects keep the default budget.
      const budget = modelHeaderBudget.getStore();
      const isLocalModelRequest = budget && opts.method === "POST" && origin === budget.origin
        && opts.path?.split("?", 1)[0].endsWith("/chat/completions");
      const request = isLocalModelRequest
        ? { ...opts, headersTimeout: opts.headersTimeout ?? budget.timeoutMs }
        : opts;
      return dispatcher.dispatch(request, handler);
    },
    async close() {
      await Promise.allSettled([
        direct?.close?.(),
        ...[...proxyDispatchers.values()].map(dispatcher => dispatcher.close?.()),
      ]);
    },
    destroy(err: any) {
      direct?.destroy?.(err);
      for (const dispatcher of proxyDispatchers.values()) {
        dispatcher.destroy?.(err);
      }
    },
  };
}

function resetNodeProxyAgentCache() {
  for (const agent of nodeProxyAgentCache.values()) {
    agent.destroy?.();
  }
  nodeProxyAgentCache = new Map();
}

function resetUndiciProxyDispatcherCache() {
  for (const dispatcher of undiciProxyDispatcherCache.values()) {
    closeDispatcher(dispatcher);
  }
  undiciProxyDispatcherCache = new Map();
}

function closeDispatcher(dispatcher: any) {
  if (!dispatcher) return;
  try {
    dispatcher.close?.().catch?.(() => {});
  } catch {}
}

function describeProxyMode(config: any, env = process.env) {
  const effective = buildEffectiveProxyConfig(config, env);
  if (config.mode === "system") {
    return hasUsableProxy(effective) ? "system-env" : "system";
  }
  return config.mode;
}

export function createOutboundProxyRuntime({ log = (..._args: any[]) => {}, warn = (..._args: any[]) => {}, env = process.env }: { log?: (...args: any[]) => void; warn?: (...args: any[]) => void; env?: any } = {}) {
  return {
    apply(config: any) {
      const normalized = normalizeNetworkProxyConfig(config, { strict: true });
      const nextDispatcher = createGlobalDispatcher(normalized, env);
      closeDispatcher(currentDispatcher);
      resetNodeProxyAgentCache();
      resetUndiciProxyDispatcherCache();
      currentConfig = normalized;
      currentLocalModelHeadersTimeout = localModelHeadersTimeout(env);
      currentDispatcher = nextDispatcher;
      setGlobalDispatcher(nextDispatcher as any);
      const modeDesc = describeProxyMode(normalized, env);
      log(`[proxy] outbound mode=${modeDesc}`);
      if (modeDesc === "system-env") {
        const effective = buildEffectiveProxyConfig(normalized, env);
        const proxyAddr = effective.httpsProxy || effective.httpProxy || effective.wsProxy || "";
        warn(
          `[proxy] 出站流量正经由系统代理 ${proxyAddr}；若需直连，请在设置 > 网络中切换为「直连」模式。` +
          ` (Outbound is routed via system proxy ${proxyAddr}; switch to "direct" in Settings > Network to bypass it.)`
        );
      }
      return normalized;
    },
    getConfig() {
      return currentConfig;
    },
    reset() {
      closeDispatcher(currentDispatcher);
      resetNodeProxyAgentCache();
      resetUndiciProxyDispatcherCache();
      currentConfig = normalizeNetworkProxyConfig(undefined);
      currentLocalModelHeadersTimeout = DEFAULT_LOCAL_MODEL_HEADERS_TIMEOUT_MS;
      currentDispatcher = null;
      setGlobalDispatcher(originalGlobalDispatcher);
    },
  };
}

export function getOutboundProxyConfig() {
  return currentConfig;
}

export function getNodeProxyAgentForUrl(targetUrl, env = process.env) {
  const proxyUrl = resolveProxyForUrl(targetUrl, currentConfig, env);
  if (!proxyUrl) return null;
  let agent = nodeProxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new NodeProxyAgent({ getProxyForUrl: () => proxyUrl });
    nodeProxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * npm undici fetch 用的 per-URL 代理 dispatcher（与 WS 的 webSocketOptionsForUrl
 * 共享同一份 apply() 注入的代理配置）。
 *
 * 使用 npm undici fetch 的调用可以显式选择与目标 URL 匹配的代理，
 * 让 dispatcher 与 fetch 使用同一份 Undici API。
 */
export function fetchDispatcherForUrl(targetUrl: any, env = process.env) {
  const proxyUrl = resolveProxyForUrl(targetUrl, currentConfig, env);
  if (!proxyUrl) return { dispatcher: null, proxyUrl: "" };
  let dispatcher = undiciProxyDispatcherCache.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = createUndiciProxyDispatcher(proxyUrl);
    undiciProxyDispatcherCache.set(proxyUrl, dispatcher);
  }
  return { dispatcher, proxyUrl };
}

export function webSocketOptionsForUrl(targetUrl: any) {
  const agent = getNodeProxyAgentForUrl(targetUrl);
  return agent ? { agent } : {};
}

export function telegramBotOptions() {
  // Resolve again on every call so a running poller follows network settings.
  const fetchWithProxy: typeof fetch = (input, init) => {
    const target = typeof input === "string" || input instanceof URL ? input : input.url;
    const { dispatcher } = fetchDispatcherForUrl(target);
    const options = dispatcher ? { ...init, dispatcher } : init;
    return globalThis.fetch(input, options);
  };
  return {
    fetch: fetchWithProxy,
    // A failed transport may already have delivered a non-idempotent send.
    maxRetries: 0,
  };
}

