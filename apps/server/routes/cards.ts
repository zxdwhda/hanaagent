/**
 * cards 路由 — Interactive Card 的 HTML 服务端点
 *
 * 为什么存在：卡片 iframe 必须从真实 http origin 加载，才能拿到不被父页面
 * 继承的 CSP 上下文，让内联脚本（高度上报 + agent 交互）得以执行。详见
 * server/cards/card-document.ts 顶部说明。
 *
 * 生命周期：内存 LRU，纯瞬态。卡片代码本身持久化在 session JSONL 的
 * toolResult.details.code 里；渲染器每次挂载（直播或历史）都会重新 PUT 注册，
 * 因此 server 重启后缓存为空也不影响——下次渲染会自动回填。不写盘、不归 session
 * 清理器管，符合 build-to-delete。
 */

import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { buildCardDocument } from "../cards/card-document.ts";
import { createRequestContext } from "../http/boundary.ts";
import { isValidSessionPath } from "../../../packages/engine/core/message-utils.ts";

const MAX_CARDS = 256;                    // LRU 容量上限
const MAX_CODE_BYTES = 512 * 1024;        // 单卡 code 体积上限（防滥用）
const MAX_VARS_BYTES = 16 * 1024;         // themeVars 体积上限
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VIEW_TTL_MS = 5 * 60 * 1000;
const CARD_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "sandbox allow-scripts",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join("; ");

interface CardEntry {
  code: string;
  varsCss: string;
  expiresAt?: number;
}

interface CardsEngine {
  agentsDir?: string;
  getSessionManifest?: (id: string) => { currentLocator?: { path?: string | null } | null } | null;
}

export function createCardsRoute(engine: CardsEngine) {
  const route = new Hono();
  // 插入序即 LRU 序：命中后 delete+set 提到队尾，超量从队首淘汰。
  const cache = new Map<string, CardEntry>();

  function touch(cardId: string, entry: CardEntry) {
    if (cache.has(cardId)) cache.delete(cardId);
    cache.set(cardId, entry);
    while (cache.size > MAX_CARDS) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function register(c: Context, isolatedView: boolean) {
    const cardId = c.req.param("cardId");
    if (!CARD_ID_RE.test(cardId)) {
      return c.json({ error: "invalid cardId" }, 400);
    }
    const body = await safeJson(c) as { code?: unknown; varsCss?: unknown; sessionId?: unknown; sessionPath?: unknown };
    if (isolatedView) {
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const sessionPath = sessionId
        ? engine.getSessionManifest?.(sessionId)?.currentLocator?.path
        : (typeof body?.sessionPath === "string" ? body.sessionPath : null);
      if (!sessionPath) return c.json({ error: "session_not_found" }, 404);
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) return c.json({ error: "invalid_session_path" }, 403);
      const auth = createRequestContext(c, engine).authorize("sessions.read", { kind: "session", sessionId, sessionPath });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
    }
    const code = typeof body?.code === "string" ? body.code : "";
    if (!code) return c.json({ error: "code required" }, 400);
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
      return c.json({ error: "code too large" }, 413);
    }
    let varsCss = typeof body?.varsCss === "string" ? body.varsCss : "";
    if (Buffer.byteLength(varsCss, "utf8") > MAX_VARS_BYTES) varsCss = "";
    if (isolatedView) {
      const viewId = randomBytes(24).toString("base64url");
      touch(`view:${viewId}`, { code, varsCss, expiresAt: Date.now() + VIEW_TTL_MS });
      c.header("Cache-Control", "no-store");
      return c.json({ viewPath: `/api/cards/view/${viewId}` });
    }
    touch(cardId, { code, varsCss });
    return c.json({ ok: true });
  }
  route.put("/cards/:cardId", c => register(c, false));
  route.put("/cards/:cardId/render", c => register(c, true));

  // 提供卡片 HTML。iframe src 指向这里。
  // 卡片保留内联脚本/样式能力，但 CSP 禁止联网、子框架、表单提交与导航。
  // 因此 show_card 的影响被限制在当前会话内的沙箱渲染。
  function serve(c: Context, key: string) {
    const entry = cache.get(key);
    if (!entry) {
      return c.text("card not found", 404);
    }
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      cache.delete(key);
      return c.text("card not found", 404);
    }
    // 命中刷新 LRU 时序
    touch(key, entry);
    const html = buildCardDocument({ code: entry.code, varsCss: entry.varsCss });
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", CARD_CONTENT_SECURITY_POLICY);
    c.header("Referrer-Policy", "no-referrer");
    return c.body(html);
  }
  route.get("/cards/:cardId", (c) => {
    const cardId = c.req.param("cardId");
    if (!CARD_ID_RE.test(cardId)) return c.text("invalid cardId", 400);
    return serve(c, cardId);
  });
  route.get("/cards/view/:viewId", c => serve(c, `view:${c.req.param("viewId")}`));

  return route;
}
