/**
 * WeChat iLink QR login. Protocol reference: Tencent openclaw-weixin 2.4.10 (MIT).
 * Keep the provider nonce and current IDC on the server for the lifetime of the QR.
 */
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import {
  resolveWechatIlinkOrigin,
  WECHAT_ILINK_DEFAULT_URL,
  WECHAT_ILINK_HEADERS,
  wechatIlinkHeaders,
} from "./wechat-ilink-api.ts";

const LOGIN_TTL_MS = 5 * 60_000;

type Confirmation = { status: "confirmed"; botToken: string; userId?: string; baseUrl: string };
type QrLogin = {
  id: string;
  qrcode: string;
  origin: string;
  expiresAt: number;
  hasExistingBinding: boolean;
  needsVerification: boolean;
  polling: boolean;
  confirmation?: Confirmation;
  completed?: boolean;
};
const logins = new Map<string, QrLogin>();

export async function getWechatQrcode(agentId: string, existingToken?: string) {
  for (const [key, login] of logins) {
    if (login.expiresAt <= Date.now()) logins.delete(key);
  }
  const login: QrLogin = {
    id: randomUUID(),
    qrcode: "",
    origin: WECHAT_ILINK_DEFAULT_URL,
    expiresAt: Date.now() + LOGIN_TTL_MS,
    hasExistingBinding: Boolean(existingToken),
    needsVerification: false,
    polling: false,
  };
  logins.set(agentId, login);
  const url = WECHAT_ILINK_DEFAULT_URL + "/ilink/bot/get_bot_qrcode?bot_type=3";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: wechatIlinkHeaders(),
      body: JSON.stringify({ local_token_list: existingToken ? [existingToken] : [] }),
      redirect: "error",
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) return { ok: false, error: `WeChat QR code request failed (HTTP ${res.status})` };
    const data = await res.json();
    if (typeof data.qrcode !== "string" || !data.qrcode) {
      return { ok: false, error: "WeChat did not return a QR code" };
    }
    const qrcodeUrl = await QRCode.toDataURL(data.qrcode_img_content || data.qrcode, { width: 280, margin: 2 });
    if (login !== logins.get(agentId)) return { ok: false, error: "WeChat QR code request was replaced" };
    login.qrcode = data.qrcode;
    login.expiresAt = Date.now() + LOGIN_TTL_MS;
    return { ok: true, qrcodeUrl, qrcodeId: login.id };
  } catch {
    return { ok: false, error: "WeChat QR code request failed" };
  } finally {
    if (!login.qrcode && logins.get(agentId) === login) logins.delete(agentId);
  }
}

export async function pollWechatQrcodeStatus(agentId: string, qrcodeId: unknown, verifyCode?: unknown) {
  const login = logins.get(agentId);
  if (!login?.qrcode || login.id !== qrcodeId || login.expiresAt <= Date.now()) return { status: "expired" } as const;
  if (login.completed) return { status: "completed" } as const;
  if (login.confirmation) return login.confirmation;
  if (login.needsVerification && (typeof verifyCode !== "string" || !/^\d{1,12}$/.test(verifyCode))) {
    return { status: "verification_required", incorrect: false } as const;
  }
  if (login.polling) return { status: "waiting" } as const;

  login.polling = true;
  try {
    const url = new URL("/ilink/bot/get_qrcode_status", login.origin);
    url.searchParams.set("qrcode", login.qrcode);
    if (login.needsVerification && typeof verifyCode === "string") url.searchParams.set("verify_code", verifyCode);
    const res = await fetch(url.toString(), {
      headers: WECHAT_ILINK_HEADERS,
      redirect: "error",
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) return { status: "waiting" } as const;
    const data = await res.json();
    if (login !== logins.get(agentId) || login.expiresAt <= Date.now()) return { status: "expired" } as const;

    switch (data.status) {
      case "scaned":
        login.needsVerification = false;
        return { status: "scanned" } as const;
      case "need_verifycode": {
        const incorrect = login.needsVerification;
        login.needsVerification = true;
        return { status: "verification_required", incorrect } as const;
      }
      case "scaned_but_redirect":
        try {
          if (typeof data.redirect_host !== "string" || !data.redirect_host) throw new Error();
          login.origin = resolveWechatIlinkOrigin(`https://${data.redirect_host}`);
          return { status: "redirected" } as const;
        } catch {
          logins.delete(agentId);
          return { status: "invalid_endpoint" } as const;
        }
      case "binded_redirect":
        logins.delete(agentId);
        return { status: login.hasExistingBinding ? "already_bound" : "error" } as const;
      case "expired":
      case "verify_code_blocked":
        logins.delete(agentId);
        return { status: data.status as "expired" | "verify_code_blocked" };
      case "confirmed":
        try {
          if (typeof data.bot_token !== "string" || !data.bot_token
            || typeof data.ilink_bot_id !== "string" || !data.ilink_bot_id) {
            logins.delete(agentId);
            return { status: "error" } as const;
          }
          login.confirmation = {
            status: "confirmed",
            botToken: data.bot_token,
            userId: typeof data.ilink_user_id === "string" ? data.ilink_user_id : undefined,
            baseUrl: resolveWechatIlinkOrigin(data.baseurl || login.origin),
          };
          return login.confirmation;
        } catch {
          logins.delete(agentId);
          return { status: "invalid_endpoint" } as const;
        }
      default:
        return { status: "waiting" } as const;
    }
  } catch {
    return { status: "waiting" } as const;
  } finally {
    login.polling = false;
  }
}

export function completeWechatQrcodeLogin(agentId: string, qrcodeId: unknown) {
  const login = logins.get(agentId);
  if (!login || login.id !== qrcodeId) return;
  delete login.confirmation;
  login.completed = true;
}
