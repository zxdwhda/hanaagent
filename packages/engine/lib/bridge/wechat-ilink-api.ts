import { randomBytes } from "node:crypto";

export const WECHAT_ILINK_DEFAULT_URL = "https://ilinkai.weixin.qq.com";
const REFERENCE_VERSION = "2.4.10";

export const WECHAT_ILINK_HEADERS = {
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 10),
};

export const WECHAT_ILINK_BASE_INFO = {
  channel_version: REFERENCE_VERSION,
  bot_agent: "HanaAgent",
};

export function wechatIlinkHeaders(token?: string) {
  return {
    ...WECHAT_ILINK_HEADERS,
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64"),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Keep QR requests and bot credentials on WeChat infrastructure. */
export function resolveWechatIlinkOrigin(value: string = WECHAT_ILINK_DEFAULT_URL): string {
  const url = new URL(value || WECHAT_ILINK_DEFAULT_URL);
  const wechatHost = /^(?:[a-z0-9-]+\.)+(?:weixin\.qq\.com|wechat\.com)$/.test(url.hostname);
  if (!wechatHost || url.protocol !== "https:" || url.port || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid WeChat iLink endpoint");
  }
  return url.origin;
}
