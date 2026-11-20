import { afterEach, describe, expect, it, vi } from "vitest";
import { getWechatQrcode, pollWechatQrcodeStatus } from "../packages/engine/lib/bridge/wechat-login.ts";

const endpoint = "https://ilinkai.weixin.qq.com";
const response = (data: unknown) => Response.json(data);

describe("WeChat iLink QR login", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses POST to identify the existing bot and recognizes a repeated binding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: "provider-code", qrcode_img_content: "https://example.com/scan" }))
      .mockResolvedValueOnce(response({ status: "binded_redirect" }));
    vi.stubGlobal("fetch", fetchMock);

    const start = await getWechatQrcode("agent-a", "saved-token");
    expect(start.qrcodeId).toBeTruthy();
    expect(start.qrcodeId).not.toBe("provider-code");
    expect(fetchMock).toHaveBeenNthCalledWith(1, endpoint + "/ilink/bot/get_bot_qrcode?bot_type=3", expect.objectContaining({
      method: "POST", body: JSON.stringify({ local_token_list: ["saved-token"] }), redirect: "error",
    }));
    expect(await pollWechatQrcodeStatus("agent-b", start.qrcodeId)).toMatchObject({ status: "expired" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await pollWechatQrcodeStatus("agent-a", start.qrcodeId)).toEqual({ status: "already_bound" });
  });

  it("follows a Tencent IDC host and submits the pairing code only when requested", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: "provider-code" }))
      .mockResolvedValueOnce(response({ status: "need_verifycode" }))
      .mockResolvedValueOnce(response({ status: "need_verifycode" }))
      .mockResolvedValueOnce(response({ status: "scaned_but_redirect", redirect_host: "idc-3.weixin.qq.com" }))
      .mockResolvedValueOnce(response({
        status: "confirmed", bot_token: "bot-token", ilink_bot_id: "bot-id",
        ilink_user_id: "owner-id", baseurl: "https://ilinkai.wechat.com/",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { qrcodeId } = await getWechatQrcode("agent-a");
    expect(await pollWechatQrcodeStatus("agent-a", qrcodeId)).toEqual({ status: "verification_required", incorrect: false });
    expect(await pollWechatQrcodeStatus("agent-a", qrcodeId)).toEqual({ status: "verification_required", incorrect: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await pollWechatQrcodeStatus("agent-a", qrcodeId, "123456")).toEqual({ status: "verification_required", incorrect: true });
    expect(await pollWechatQrcodeStatus("agent-a", qrcodeId, "654321")).toEqual({ status: "redirected" });
    expect(await pollWechatQrcodeStatus("agent-a", qrcodeId, "654321")).toMatchObject({
      status: "confirmed", botToken: "bot-token", userId: "owner-id", baseUrl: "https://ilinkai.wechat.com",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(5,
      "https://idc-3.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=provider-code&verify_code=654321",
      expect.objectContaining({ redirect: "error" }));
  });

  it("keeps the newer QR when upstream finishes requests in reverse order", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response({ qrcode: "new-code" }))
      .mockResolvedValueOnce(response({ status: "scaned" }));
    vi.stubGlobal("fetch", fetchMock);

    const older = getWechatQrcode("agent-race");
    const newer = await getWechatQrcode("agent-race");
    pending.resolve(response({ qrcode: "old-code" }));

    expect(await older).toMatchObject({ ok: false });
    expect(await pollWechatQrcodeStatus("agent-race", newer.qrcodeId)).toEqual({ status: "scanned" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      endpoint + "/ilink/bot/get_qrcode_status?qrcode=new-code", expect.anything(),
    );
  });

  it("rejects non-WeChat hosts before sending a poll or accepting credentials", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: "provider-code" }))
      .mockResolvedValueOnce(response({ status: "scaned_but_redirect", redirect_host: "weixin.qq.com.example.com" }));
    vi.stubGlobal("fetch", fetchMock);

    const { qrcodeId } = await getWechatQrcode("agent-c");
    expect(await pollWechatQrcodeStatus("agent-c", qrcodeId)).toMatchObject({ status: "invalid_endpoint" });
    expect(await pollWechatQrcodeStatus("agent-c", qrcodeId)).toMatchObject({ status: "expired" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
