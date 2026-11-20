import { beforeEach, describe, expect, it, vi } from "vitest";

const { botInstances } = vi.hoisted(() => ({ botInstances: [] as any[] }));

vi.mock("node-telegram-bot-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("node-telegram-bot-api")>();
  class MockBot {
    api = {
      getMe: vi.fn(async () => ({ username: "hana" })),
      getUserProfilePhotos: vi.fn(async () => ({
        photos: [[{ file_id: "avatar-small" }, { file_id: "avatar-large" }]],
      })),
      getFile: vi.fn(async ({ file_id }) => ({ file_path: `pictures/${file_id}.jpg` })),
      sendChatAction: vi.fn(),
      sendMessage: vi.fn(),
      sendPhoto: vi.fn(),
      sendVideo: vi.fn(),
      sendAudio: vi.fn(),
      sendDocument: vi.fn(),
      sendMessageDraft: vi.fn(),
      sendRichMessageDraft: vi.fn(),
      sendRichMessage: vi.fn(),
    };
    on = vi.fn();
    catch = vi.fn();
    rejectPolling: (reason: unknown) => void;
    resolvePolling: () => void;
    startPolling = vi.fn(() => new Promise<void>((resolve, reject) => {
      this.rejectPolling = reject;
      this.resolvePolling = resolve;
    }));
    stop = vi.fn(() => this.resolvePolling());
    close = vi.fn(async () => {});

    constructor(_token: string, readonly options: Record<string, any>) {
      botInstances.push(this);
    }
  }
  return { ...real, Bot: MockBot };
});

vi.mock("../packages/engine/lib/debug-log.ts", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { InputFile, NetworkError, TelegramApiError } from "node-telegram-bot-api";
import { createTelegramAdapter } from "../packages/engine/lib/bridge/telegram-adapter.ts";

describe("createTelegramAdapter Bot API 2.x", () => {
  beforeEach(() => {
    botInstances.length = 0;
  });

  function makeAdapter() {
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const adapter = createTelegramAdapter({ token: "tg-token", agentId: "hana", onMessage, onStatus });
    return { adapter, bot: botInstances[0], onMessage, onStatus };
  }

  it.each([
    ["image/png", "image.png", "sendPhoto", "photo"],
    ["video/mp4", "video.mp4", "sendVideo", "video"],
    ["audio/mpeg", "audio.mp3", "sendAudio", "audio"],
    ["text/plain", "note.txt", "sendDocument", "document"],
  ])("sends local %s buffers with their filename and MIME type", async (mime, filename, method, field) => {
    const { adapter, bot } = makeAdapter();
    const buffer = Buffer.from("file");

    await adapter.sendMediaBuffer("chat-1", buffer, { mime, filename });

    expect(bot.api[method]).toHaveBeenCalledWith({
      chat_id: "chat-1",
      [field]: expect.any(InputFile),
    });
    expect(bot.api[method].mock.calls[0][0][field]).toMatchObject({
      data: buffer,
      meta: { filename, contentType: mime },
    });
    await adapter.stop();
  });

  it.each([
    ["https://example.com/image.png", "sendPhoto", "photo"],
    ["https://example.com/video.mp4", "sendVideo", "video"],
    ["https://example.com/audio.mp3", "sendAudio", "audio"],
    ["https://example.com/archive.zip", "sendDocument", "document"],
  ])("routes remote URL %s by extension", async (url, method, field) => {
    const { adapter, bot } = makeAdapter();
    await adapter.sendMedia("chat-1", url);
    expect(bot.api[method]).toHaveBeenCalledWith({ chat_id: "chat-1", [field]: url });
    await adapter.stop();
  });

  it("routes formatted replies and both media types to the inbound forum topic", async () => {
    const { adapter, bot } = makeAdapter();
    const thread = { chat_id: "chat-1", message_thread_id: 67890 };

    await adapter.sendReply("chat-1", "**bold** and `code`", { messageThreadId: 67890 });
    await adapter.sendBlockReply("chat-1", "- first\n- second", { messageThreadId: 67890 });
    await adapter.sendMedia("chat-1", "https://example.com/image.png", {
      replyContext: { messageThreadId: 67890 },
    });
    await adapter.sendMediaBuffer("chat-1", Buffer.from("png"), {
      mime: "image/png",
      filename: "image.png",
      replyContext: { messageThreadId: 67890 },
    });

    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(1, {
      ...thread, text: "<b>bold</b> and <code>code</code>", parse_mode: "HTML",
    });
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(2, {
      ...thread, text: "- first\n- second", parse_mode: "HTML",
    });
    expect(bot.api.sendPhoto).toHaveBeenNthCalledWith(1, { ...thread, photo: "https://example.com/image.png" });
    expect(bot.api.sendPhoto).toHaveBeenNthCalledWith(2, { ...thread, photo: expect.any(InputFile) });
    await adapter.stop();
  });

  it("uses getFile to resolve inbound attachments and profile photos", async () => {
    const { adapter, bot, onMessage } = makeAdapter();

    expect(bot.on).toHaveBeenCalledWith("message", expect.any(Function));
    await bot.on.mock.calls[0][1]({ message: {
      caption: "hello",
      photo: [{ file_id: "image", width: 50, height: 50 }],
      chat: { id: 123, type: "private" },
      from: { id: 456, first_name: "Ada", last_name: "Lovelace", username: "ada" },
    } });

    expect(bot.api.getUserProfilePhotos).toHaveBeenCalledWith({ user_id: 456, limit: 1 }, expect.any(AbortSignal));
    expect(bot.api.getFile.mock.calls.map(([params]) => params)).toEqual([
      { file_id: "image" }, { file_id: "avatar-large" },
    ]);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      platform: "telegram",
      text: "hello",
      chatId: "123",
      userId: "456",
      sessionKey: "tg_dm_456@hana",
      senderName: "Ada Lovelace",
      avatarUrl: "https://api.telegram.org/file/bottg-token/pictures/avatar-large.jpg",
      principalId: "456",
      attachments: [expect.objectContaining({
        type: "image",
        url: "https://api.telegram.org/file/bottg-token/pictures/image.jpg",
        platformRef: "image",
      })],
    }));
    await adapter.stop();
  });

  it("uses the public typed APIs for plain drafts, rich drafts, and final rich replies", async () => {
    const { adapter, bot } = makeAdapter();

    expect(adapter.streamingCapabilities).toMatchObject({ mode: "draft", scopes: ["dm"], maxChars: 4096 });
    expect(adapter.richStreamingCapabilities).toMatchObject({
      mode: "rich_draft", scopes: ["dm"], maxChars: 32768, requiresRichStreaming: true,
    });

    const draft = { chat_id: "chat-1", draft_id: 12345, message_thread_id: 67890 };
    const options = { draftId: draft.draft_id, messageThreadId: draft.message_thread_id };
    await adapter.sendDraft("chat-1", "streaming text", options);
    await adapter.sendRichDraft("chat-1", "**streaming**", options);
    await adapter.sendRichReply("chat-1", "# Final", options);

    expect(bot.api.sendMessageDraft).toHaveBeenCalledWith({ ...draft, text: "streaming text" });
    expect(bot.api.sendRichMessageDraft).toHaveBeenCalledWith({ ...draft, rich_message: { markdown: "**streaming**" } });
    expect(bot.api.sendRichMessage).toHaveBeenCalledWith({
      chat_id: "chat-1", message_thread_id: 67890, rich_message: { markdown: "# Final" },
    });
    await adapter.stop();
  });

  it("leaves transient polling retries to the SDK and restarts only after the old loop exits", async () => {
    vi.useFakeTimers();
    const { adapter, bot, onStatus } = makeAdapter();
    try {
      const [source, options] = bot.startPolling.mock.calls[0];
      expect(source).toBeUndefined();
      expect(options.allowedUpdates).toEqual(["message"]);
      expect(bot.options.maxRetries).toBe(0);

      const offline = new NetworkError("offline");
      for (let i = 0; i < 3; i++) options.onError(offline);
      expect(onStatus).toHaveBeenCalledWith("error", "offline");
      expect(bot.startPolling).toHaveBeenCalledTimes(1);

      bot.rejectPolling(offline);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(bot.startPolling).toHaveBeenCalledTimes(2);
      expect(botInstances).toHaveLength(1);

      bot.rejectPolling(new TelegramApiError(401, "Unauthorized"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onStatus).toHaveBeenCalledWith("error", "401: Unauthorized");
      expect(bot.startPolling).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });
});
