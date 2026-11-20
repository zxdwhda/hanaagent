import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const qqEvents = vi.hoisted(() => ({
  message: null as ((data: string) => void) | null,
  sockets: [] as Array<{
    close: (code?: number) => void;
    emit: (event: string, data?: string | number) => void;
    sent: Array<Record<string, any>>;
  }>,
}));

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    sent: Array<Record<string, any>> = [];
    handlers = new Map<string, (data?: any) => void>();
    constructor() {
      qqEvents.sockets.push(this);
    }
    on(event: string, callback: (data?: any) => void) {
      if (event === "message") qqEvents.message = callback;
      this.handlers.set(event, callback);
    }
    emit(event: string, data?: string | number) {
      this.handlers.get(event)?.(data);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000) {
      this.readyState = 3;
      this.emit("close", code);
    }
  }
  return { default: MockWebSocket };
});

vi.mock("../packages/engine/lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// #1612：adapter 的所有出站 REST 必须经由 Bridge outbound HTTP helper（带 stage），
// 这里 mock 成 globalThis.fetch 透传，既捕获 stage 标签，又让既有断言继续工作。
const outboundCapture = vi.hoisted(() => ({
  platforms: [] as string[],
  requests: [] as Array<{ stage: string; url: string; method: string }>,
}));

vi.mock("../packages/engine/lib/bridge/outbound-http.ts", () => ({
  createBridgeOutboundHttp: ({ platform }: any) => {
    outboundCapture.platforms.push(platform);
    return {
      request: async ({ stage, url, method = "GET", headers, body }: any) => {
        outboundCapture.requests.push({ stage, url: String(url), method });
        return (globalThis as any).fetch(url, { method, headers, body });
      },
    };
  },
}));

import { createQQAdapter, deriveQQPrincipal } from "../packages/engine/lib/bridge/qq-adapter.ts";
import { QQ_FILE_TYPE, uploadQQLocalFile } from "../packages/engine/lib/bridge/qq-local-upload.ts";

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  };
}

describe("createQQAdapter media delivery", () => {
  let tmpDir = null;

  beforeEach(() => {
    qqEvents.message = null;
    qqEvents.sockets.length = 0;
    outboundCapture.platforms.length = 0;
    outboundCapture.requests.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("/app/getAppAccessToken")) {
        return jsonResponse({ access_token: "qq-token", expires_in: 7200 });
      }
      if (href.endsWith("/gateway")) {
        return jsonResponse({ url: "ws://localhost/qq" });
      }
      if (href.includes("cos.example.com")) {
        return emptyResponse();
      }
      if (href.includes("/upload_prepare")) {
        return jsonResponse({
          upload_id: "upload-1",
          block_size: 5,
          parts: [
            { index: 1, presigned_url: "https://cos.example.com/part-1" },
            { index: 2, presigned_url: "https://cos.example.com/part-2" },
          ],
          concurrency: 1,
        });
      }
      if (href.includes("/upload_part_finish")) {
        return emptyResponse();
      }
      if (href.includes("/files")) {
        return jsonResponse({ file_uuid: "file-uuid", file_info: "file-info", ttl: 3600 });
      }
      return jsonResponse({});
    }));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeTempFile(name, content) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-qq-adapter-"));
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function md5Hex(value) {
    return crypto.createHash("md5").update(value).digest("hex");
  }

  function sha1Hex(value) {
    return crypto.createHash("sha1").update(value).digest("hex");
  }

  it.each([true, false])("uses QQ's invalid-session recovery with resumable=%s", async (resumable) => {
    const adapter = createQQAdapter({
      appID: "fixture-app", appSecret: "fixture", agentId: "hana", onMessage: vi.fn(),
    } as any);
    const hello = JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const first = qqEvents.sockets[0];
      first.emit("message", hello);
      expect(first.sent[0]).toMatchObject({ op: 2 });
      first.emit("message", JSON.stringify({ op: 0, t: "READY", s: 0, d: { session_id: "session-1" } }));
      first.emit("message", JSON.stringify({ op: 9, d: resumable }));

      await vi.advanceTimersByTimeAsync(2999);
      expect(qqEvents.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(qqEvents.sockets).toHaveLength(2);
      const second = qqEvents.sockets[1];
      second.emit("message", hello);
      if (resumable) {
        expect(second.sent[0]).toEqual({ op: 6, d: { token: "QQBot qq-token", session_id: "session-1", seq: 0 } });
      } else {
        expect(second.sent[0]).toMatchObject({ op: 2 });
      }
    } finally {
      adapter.stop();
    }
  });

  it("refreshes a rejected token, backs off on rate limiting and stops on fatal gateway close", async () => {
    const onStatus = vi.fn();
    const adapter = createQQAdapter({
      appID: "fixture-app", appSecret: "fixture", agentId: "hana", onMessage: vi.fn(), onStatus,
    } as any);
    try {
      await vi.advanceTimersByTimeAsync(0);
      qqEvents.sockets[0].close(4004);
      await vi.advanceTimersByTimeAsync(1000);
      expect(outboundCapture.requests.filter(({ stage }) => stage === "token")).toHaveLength(2);
      expect(qqEvents.sockets).toHaveLength(2);

      qqEvents.sockets[1].close(4008);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(qqEvents.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(qqEvents.sockets).toHaveLength(3);

      qqEvents.sockets[2].close(4914);
      expect(onStatus).toHaveBeenLastCalledWith("error", expect.stringContaining("4914"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(qqEvents.sockets).toHaveLength(3);
    } finally {
      adapter.stop();
    }
  });

  it("forwards a replayed QQ attachment once and allows the user to send the same file again", async () => {
    const onMessage = vi.fn();
    const adapter = createQQAdapter({
      appID: "fixture-app", appSecret: "fixture", agentId: "hana", onMessage,
    } as any);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(qqEvents.message).not.toBeNull();
      const data = {
        id: "msg-1", content: "", author: { user_openid: "owner" },
        attachments: [{ filename: "report.pdf", url: "https://example.invalid/file", content_type: "application/pdf" }],
      };
      const dispatch = (d: typeof data) => qqEvents.message?.(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", d }));
      dispatch(data);
      dispatch(data);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0][0].attachments).toHaveLength(1);
      dispatch({ ...data, id: "msg-2" });
      expect(onMessage).toHaveBeenCalledTimes(2);
    } finally {
      adapter.stop();
    }
  });

  it("rejects local buffer media with an explicit unsupported error", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(
      adapter.sendMediaBuffer("chat-1", Buffer.from("png"), {
        mime: "image/png",
        filename: "image.png",
      }),
    ).rejects.toThrow(/QQ.*本地.*staged file/);

    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/files"),
      expect.anything(),
    );
    adapter.stop();
  });

  it("uploads local C2C staged files through QQ chunked upload before sending rich media", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMediaFile("user-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: false,
    });

    const prepareCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/upload_prepare"));
    expect(prepareCall).toBeTruthy();
    expect(JSON.parse(prepareCall[1].body)).toMatchObject({
      file_type: 4,
      file_name: "note.txt",
      file_size: 10,
      md5: md5Hex("helloworld"),
      sha1: sha1Hex("helloworld"),
      md5_10m: md5Hex("helloworld"),
    });

    const putCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("cos.example.com"));
    expect(putCalls).toHaveLength(2);
    expect(await putCalls[0][1].body.text()).toBe("hello");
    expect(await putCalls[1][1].body.text()).toBe("world");

    const partFinishCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("/v2/users/user-openid/upload_part_finish"));
    expect(partFinishCalls).toHaveLength(2);
    expect(JSON.parse(partFinishCalls[0][1].body)).toMatchObject({
      upload_id: "upload-1",
      part_index: 1,
      block_size: 5,
      md5: md5Hex("hello"),
    });
    expect(JSON.parse(partFinishCalls[1][1].body)).toMatchObject({
      upload_id: "upload-1",
      part_index: 2,
      block_size: 5,
      md5: md5Hex("world"),
    });

    const completeCall = (fetch as any).mock.calls.find(([url, init = {}]: any) =>
      String(url).includes("/v2/users/user-openid/files")
      && init.body
      && JSON.parse(init.body).upload_id === "upload-1"
    );
    expect(completeCall).toBeTruthy();

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it("rejects a staged file truncated after upload preparation before sending the short part", async () => {
    const filePath = makeTempFile("shrinking.txt", "helloworld");
    const apiRequest = vi.fn(async (_method, _endpoint, _body, { stage }) => {
      if (stage !== "upload_prepare") return {};
      fs.truncateSync(filePath, 3);
      return {
        upload_id: "upload-shrinking",
        block_size: 10,
        parts: [{ index: 1, presigned_url: "https://cos.example.com/part" }],
      };
    });
    const outboundHttp = { request: vi.fn(async () => emptyResponse()) };

    await expect(uploadQQLocalFile({
      apiRequest, outboundHttp, chatId: "fixture-user", filePath,
      fileType: QQ_FILE_TYPE.FILE, metadata: { isGroup: false },
    })).rejects.toThrow("QQ 文件在上传期间大小发生变化");
    expect(outboundHttp.request).not.toHaveBeenCalled();
    expect(apiRequest).toHaveBeenCalledOnce();
  });

  it("sends QQ group replies as markdown passive replies with msg_id and distinct msg_seq values", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("group-openid", "first", {
      messageId: "qq-mid-1",
      targetType: "group",
      isGroup: true,
    });
    await adapter.sendReply("group-openid", "second", {
      messageId: "qq-mid-1",
      targetType: "group",
      isGroup: true,
    });

    const messageCalls = (fetch as any).mock.calls.filter(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(messageCalls).toHaveLength(2);
    expect(JSON.parse(messageCalls[0][1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "first" },
      msg_id: "qq-mid-1",
      msg_seq: 1,
    });
    expect(JSON.parse(messageCalls[1][1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "second" },
      msg_id: "qq-mid-1",
      msg_seq: 2,
    });
    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/messages"))).toBe(false);
    adapter.stop();
  });

  it("sends QQ C2C replies as official markdown messages", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("user-openid", "**bold**\n- item", {
      messageId: "qq-dm-1",
      targetType: "user",
      isGroup: false,
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      content: " ",
      msg_type: 2,
      markdown: { content: "**bold**\n- item" },
      msg_id: "qq-dm-1",
      msg_seq: 1,
    });
    adapter.stop();
  });

  it("sends legacy QQ channel replies with the channel markdown object", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendReply("channel-id", "# Title", {
      messageId: "qq-channel-mid-1",
      targetType: "channel",
      isGroup: true,
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/channels/channel-id/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      markdown: { content: "# Title" },
      msg_id: "qq-channel-mid-1",
      msg_seq: 1,
    });
    expect(JSON.parse(messageCall[1].body)).not.toHaveProperty("msg_type");
    adapter.stop();
  });

  it("uploads local group images through QQ group chunked upload", async () => {
    const filePath = makeTempFile("image.png", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMediaFile("group-openid", filePath, {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
    });

    const prepareCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/upload_prepare"));
    expect(prepareCall).toBeTruthy();
    expect(JSON.parse(prepareCall[1].body)).toMatchObject({ file_type: 1 });
    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/upload_prepare"))).toBe(false);

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it("sends QQ rich media replies with passive reply context", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
      replyContext: {
        messageId: "qq-mid-1",
        targetType: "group",
      },
    });

    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
      msg_id: "qq-mid-1",
      msg_seq: 1,
    });
    adapter.stop();
  });

  it("rejects local group documents before chunked upload", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(adapter.sendMediaFile("group-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: true,
    })).rejects.toThrow(/群聊.*暂不开放文件类型/);

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/upload_prepare"))).toBe(false);
    adapter.stop();
  });

  it("uses staged file metadata to choose QQ rich-media image file_type for extensionless URLs", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("user-openid", "https://hana.example.com/api/bridge/media/token_123", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
    });

    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({
      file_type: 1,
      url: "https://hana.example.com/api/bridge/media/token_123",
      srv_send_msg: false,
    });
    const messageCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/messages"));
    expect(JSON.parse(messageCall[1].body)).toMatchObject({
      msg_type: 7,
      media: { file_info: "file-info" },
    });
    adapter.stop();
  });

  it("sends C2C documents with QQ rich-media file_type 4", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("user-openid", "https://cdn.example.com/note.txt", {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
    });

    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/users/user-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({
      file_type: 4,
      url: "https://cdn.example.com/note.txt",
      srv_send_msg: false,
    });
    adapter.stop();
  });

  it("uses the group rich-media endpoint directly when Bridge knows the target is a group", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await adapter.sendMedia("group-openid", "https://cdn.example.com/image.png", {
      kind: "image",
      mime: "image/png",
      filename: "image.png",
      isGroup: true,
    });

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/users/group-openid/files"))).toBe(false);
    const uploadCall = (fetch as any).mock.calls.find(([url]: any) => String(url).includes("/v2/groups/group-openid/files"));
    expect(uploadCall).toBeTruthy();
    expect(JSON.parse(uploadCall[1].body)).toMatchObject({ file_type: 1 });
    adapter.stop();
  });

  it("labels every QQ outbound REST call with an explicit stage for diagnostics (#1612)", async () => {
    const filePath = makeTempFile("note.txt", "helloworld");
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    // 排空后台 connect()（token + gateway）的微任务链
    await vi.advanceTimersByTimeAsync(0);

    await adapter.sendReply("user-openid", "hi", {
      messageId: "qq-dm-1",
      targetType: "user",
      isGroup: false,
    });
    await adapter.sendMediaFile("user-openid", filePath, {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: false,
    });

    expect(outboundCapture.platforms).toContain("qq");
    const stages = outboundCapture.requests.map((r) => r.stage);
    expect(stages).toContain("token");
    expect(stages).toContain("gateway");
    expect(stages).toContain("send_reply");
    expect(stages).toContain("upload_prepare");
    expect(stages).toContain("upload_part_put");
    expect(stages).toContain("upload_part_finish");
    expect(stages).toContain("upload_complete");
    expect(stages).toContain("send_media_message");
    // 每一笔出站调用都必须显式带 stage，禁止匿名出站
    expect(outboundCapture.requests.length).toBeGreaterThan(0);
    expect(outboundCapture.requests.every((r) => typeof r.stage === "string" && r.stage.length > 0)).toBe(true);
    adapter.stop();
  });

  it("rejects QQ group documents before upload because the official API has not opened file_type 4 for groups", async () => {
    const adapter = createQQAdapter({
      appID: "app-id",
      appSecret: "app-secret",
      agentId: "hana",
      onMessage: vi.fn(),
    } as any);

    await expect(adapter.sendMedia("group-openid", "https://cdn.example.com/note.txt", {
      kind: "document",
      mime: "text/plain",
      filename: "note.txt",
      isGroup: true,
    })).rejects.toThrow(/群聊.*暂不开放文件类型/);

    expect((fetch as any).mock.calls.some(([url]: any) => String(url).includes("/v2/groups/group-openid/files"))).toBe(false);
    adapter.stop();
  });
});

describe("QQ principal metadata", () => {
  it("prefers stable author id as principal while keeping C2C openid as delivery alias", () => {
    expect(deriveQQPrincipal({
      id: "stable-user-id",
      user_openid: "c2c-openid",
      username: "User",
    })).toEqual({
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "c2c-openid"],
      displayName: null,
      fallbackName: "QQ stab…r-id",
    });
  });

  it("uses member openid as a QQ alias without treating placeholder username as display name", () => {
    expect(deriveQQPrincipal({
      id: "stable-user-id",
      member_openid: "member-openid",
      username: "User",
    })).toEqual({
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "member-openid"],
      displayName: null,
      fallbackName: "QQ stab…r-id",
    });
  });

  it("uses QQ member card and avatar metadata when username is a placeholder", () => {
    expect(deriveQQPrincipal({
      id: "stable-user-id",
      username: "User",
      avatar: "https://example.com/fallback.png",
    }, {
      member_openid: "member-openid",
      card: "Alice Card",
      avatarUrl: "https://example.com/alice.png",
    })).toEqual({
      principalId: "stable-user-id",
      aliases: ["stable-user-id", "member-openid"],
      displayName: "Alice Card",
      avatarUrl: "https://example.com/alice.png",
      fallbackName: "QQ stab…r-id",
    });
  });
});
