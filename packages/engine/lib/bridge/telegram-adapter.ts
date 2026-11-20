/**
 * telegram-adapter.js — Telegram Bot 长轮询适配器
 *
 * 使用 node-telegram-bot-api 监听消息，
 * 通过 onMessage 回调将标准化消息交给 BridgeManager。
 */

import { Bot, InputFile, ParseError, TelegramApiError, isPollConflict, isTransientError } from "node-telegram-bot-api";
import type { User } from "node-telegram-bot-api";
import { debugLog } from "../debug-log.ts";
import { telegramBotOptions } from "../net/outbound-proxy.ts";
import { createMediaCapabilities } from "./media-capabilities.ts";
import { createStreamingCapabilities } from "./streaming-capabilities.ts";
import { createReceiptCapabilities } from "./receipt-capabilities.ts";
import { renderTelegramRichMessage } from "./bridge-presentation.ts";
import { formatTelegramMessageChunks } from "./telegram-format.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("telegram");

const MAX_MSG_SIZE = 100_000; // 100KB
const TELEGRAM_API_ROOT = "https://api.telegram.org";
const POLL_TIMEOUT_SECONDS = 10;
const POLL_REQUEST_TIMEOUT_MS = 25_000;
const POLL_RESTART_DELAY_MS = 30_000;

export const TELEGRAM_MEDIA_CAPABILITIES = createMediaCapabilities({
  platform: "telegram",
  inputModes: ["buffer", "remote_url", "public_url"],
  supportedKinds: ["image", "video", "audio", "document"],
  requiresReplyContext: false,
  deliveryByKind: {
    image: "native_image",
    video: "native_video",
    audio: "native_audio",
    document: "native_document",
  },
  maxBytes: {
    buffer: {
      image: 10 * 1024 * 1024,
      video: 50 * 1024 * 1024,
      audio: 50 * 1024 * 1024,
      document: 50 * 1024 * 1024,
    },
    remote_url: {
      image: 5 * 1024 * 1024,
      video: 20 * 1024 * 1024,
      audio: 20 * 1024 * 1024,
      document: 20 * 1024 * 1024,
    },
  },
  source: "lib/bridge/telegram-adapter.ts#TELEGRAM_MEDIA_CAPABILITIES",
});

export const TELEGRAM_STREAMING_CAPABILITIES = createStreamingCapabilities({
  platform: "telegram",
  mode: "draft",
  scopes: ["dm"],
  minIntervalMs: 500,
  maxChars: 4096,
  source: "https://core.telegram.org/bots/api#sendmessagedraft",
});

export const TELEGRAM_RICH_STREAMING_CAPABILITIES = createStreamingCapabilities({
  platform: "telegram",
  mode: "rich_draft",
  scopes: ["dm"],
  minIntervalMs: 500,
  maxChars: 32768,
  renderer: "telegram_rich_markdown",
  requiresRichStreaming: true,
  source: "https://core.telegram.org/bots/api#sendrichmessagedraft",
});

export const TELEGRAM_RECEIPT_CAPABILITIES = createReceiptCapabilities({
  platform: "telegram",
  mode: "native_typing",
  scopes: ["dm", "group"],
  refreshIntervalMs: 4000,
  source: "https://core.telegram.org/bots/api#sendchataction",
});

/** 从 URL 安全提取扩展名（小写，无点号） */
function safeExtFromUrl(url) {
  try { return new URL(url).pathname.split(".").pop()?.toLowerCase() || ""; }
  catch { return ""; }
}

function telegramMessageOptions(options: Record<string, any> = {}) {
  const messageThreadId = options.messageThreadId ?? options.replyContext?.messageThreadId;
  return messageThreadId != null && messageThreadId !== "" ? { message_thread_id: messageThreadId } : {};
}

function cleanTelegramString(value) {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}

function telegramDisplayName(user: Record<string, any> = {}) {
  const fullName = [cleanTelegramString(user.first_name), cleanTelegramString(user.last_name)]
    .filter(Boolean)
    .join(" ");
  return fullName || (cleanTelegramString(user.username) ? `@${cleanTelegramString(user.username)}` : null);
}

/**
 * @param {object} opts
 * @param {string} opts.token - Telegram Bot Token（从 @BotFather 获取）
 * @param {(msg: BridgeMessage) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 * @returns {{ sendReply, stop, getMe }}
 */
export function createTelegramAdapter({ token, agentId, onMessage, onStatus }) {
  const lifecycle = new AbortController();
  let consecutiveErrors = 0;
  let lastStatus: { state: string; error?: string } | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  const userProfileCache = new Map();
  const sdkOptions = telegramBotOptions();
  const bot = new Bot(token, {
    ...sdkOptions,
    apiRoot: TELEGRAM_API_ROOT,
    async fetch(input, init) {
      // The SDK passes URLs as strings; leave its upload timeout untouched.
      const url = typeof input === "string" ? input : "";
      const isPoll = url.endsWith("/getUpdates");
      if (isPoll || url.endsWith("/getMe")) {
        const requestSignal = AbortSignal.timeout(isPoll ? POLL_REQUEST_TIMEOUT_MS : 10_000);
        const signals = isPoll ? [requestSignal] : [requestSignal, lifecycle.signal];
        if (init?.signal) signals.push(init.signal);
        init = { ...init, signal: AbortSignal.any(signals) };
      }
      const response = await sdkOptions.fetch(input, init);
      if (isPoll && response.ok && (lastStatus?.state !== "connected" || consecutiveErrors > 0)) {
        const envelope = await response.clone().json().catch(() => null);
        if (envelope?.ok === true && Array.isArray(envelope.result)) {
          consecutiveErrors = 0;
          reportStatus("connected");
        }
      }
      return response;
    },
  });

  function reportStatus(status: string, error?: string) {
    if (lifecycle.signal.aborted || (status === lastStatus?.state && error === lastStatus.error)) return;
    lastStatus = { state: status, error };
    if (error) onStatus?.(status, error);
    else onStatus?.(status);
  }

  function lookupSignal() {
    return AbortSignal.any([lifecycle.signal, AbortSignal.timeout(10_000)]);
  }

  async function getFileLink(fileId: string) {
    const file = await bot.api.getFile({ file_id: fileId }, lookupSignal());
    if (!file.file_path) throw new Error("Telegram returned no downloadable file path");
    return `${TELEGRAM_API_ROOT}/file/bot${token}/${file.file_path}`;
  }

  async function resolveUserProfile(user?: User) {
    const userId = cleanTelegramString(user?.id);
    const cached = userId ? userProfileCache.get(userId) : null;
    const displayName = telegramDisplayName(user) || cached?.displayName || "User";
    let avatarUrl = cached?.avatarUrl || null;

    if (user && !avatarUrl && !lifecycle.signal.aborted) {
      try {
        const photos = await bot.api.getUserProfilePhotos({ user_id: user.id, limit: 1 }, lookupSignal());
        const sizes = photos?.photos?.[0] || [];
        const best = sizes[sizes.length - 1];
        if (best?.file_id) avatarUrl = await getFileLink(best.file_id);
      } catch {
        avatarUrl = cached?.avatarUrl || null;
      }
    }

    const profile = { principalId: userId, displayName, avatarUrl };
    if (userId) userProfileCache.set(userId, profile);
    return profile;
  }

  bot.catch((err) => {
    // A rejected handler leaves the current update unconfirmed for the next poller.
    if (err === lifecycle.signal.reason && lifecycle.signal.aborted) throw err;
    log.error(`update handler failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  bot.on("message", async ({ message: msg }) => {
    lifecycle.signal.throwIfAborted();
    if (!msg) return;
    const text = msg.text || msg.caption || "";

    // 提取附件（每种类型独立 try/catch，单个失败不影响其他）
    const attachments = [];
    if (msg.photo?.length) {
      try {
        const best = msg.photo[msg.photo.length - 1];
        const url = await getFileLink(best.file_id);
        attachments.push({ type: "image", url, mimeType: "image/jpeg",
          width: best.width, height: best.height, platformRef: best.file_id });
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] photo 提取失败: ${err.message}`);
      }
    }
    if (msg.document) {
      try {
        const url = await getFileLink(msg.document.file_id);
        attachments.push({ type: "file", url, filename: msg.document.file_name,
          mimeType: msg.document.mime_type, size: msg.document.file_size,
          platformRef: msg.document.file_id });
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] document 提取失败: ${err.message}`);
      }
    }
    if (msg.voice) {
      try {
        const url = await getFileLink(msg.voice.file_id);
        attachments.push({ type: "audio", url, mimeType: msg.voice.mime_type,
          duration: msg.voice.duration, platformRef: msg.voice.file_id });
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] voice 提取失败: ${err.message}`);
      }
    }
    if (msg.video) {
      try {
        const url = await getFileLink(msg.video.file_id);
        attachments.push({ type: "video", url, filename: msg.video.file_name,
          mimeType: msg.video.mime_type, duration: msg.video.duration,
          platformRef: msg.video.file_id });
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] video 提取失败: ${err.message}`);
      }
    }

    lifecycle.signal.throwIfAborted();
    if (!text && !attachments.length) return;

    const trimmed = text.length > MAX_MSG_SIZE
      ? (log.warn(`消息过大（${text.length} chars），已截断`), text.slice(0, MAX_MSG_SIZE))
      : text;

    const profile = await resolveUserProfile(msg.from);
    lifecycle.signal.throwIfAborted();
    const chatId = String(msg.chat.id);
    const userId = profile.principalId || String(msg.from?.id || msg.chat.id);
    const chatType = msg.chat.type; // "private" | "group" | "supergroup" | "channel"
    const isGroup = chatType !== "private";
    const sessionKey = isGroup ? `tg_group_${chatId}@${agentId}` : `tg_dm_${userId}@${agentId}`;

    onMessage({
      platform: "telegram",
      agentId,
      chatId,
      userId,
      sessionKey,
      text: trimmed,
      senderName: profile.displayName,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl || undefined,
      principalId: profile.principalId || userId,
      isGroup,
      messageThreadId: msg.message_thread_id,
      attachments: attachments.length ? attachments : undefined,
    });
  });

  function logPollingError(err: unknown) {
    consecutiveErrors++;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`polling error: ${errMsg}`);
    debugLog()?.error("bridge", `telegram polling error (${consecutiveErrors}): ${errMsg}`);
    return errMsg;
  }

  function startPolling() {
    return bot.startPolling(undefined, {
      timeout: POLL_TIMEOUT_SECONDS,
      allowedUpdates: ["message"],
      onError(err) {
        const message = logPollingError(err);
        if (consecutiveErrors >= 3) reportStatus("error", message);
      },
    }).catch(err => {
      if (lifecycle.signal.aborted) return;
      reportStatus("error", logPollingError(err));
      // The SDK owns transient retries within a poll. Retry a terminated loop
      // only after it has released its slot, including failures during getMe.
      if (!isTransientError(err) && !isPollConflict(err) && !(err instanceof ParseError)) return;
      const retryAfterMs = err instanceof TelegramApiError ? (err.retryAfter ?? 0) * 1000 : 0;
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        polling = startPolling();
      }, Math.min(Math.max(POLL_RESTART_DELAY_MS, retryAfterMs), 2_147_483_647));
      restartTimer.unref();
    });
  }

  let polling = startPolling();

  async function sendText(chatId: string, text: string, options: Record<string, any>) {
    // Telegram 单条消息限制 4096 字符，超长时分段发送。
    const params = { chat_id: chatId, parse_mode: "HTML" as const, ...telegramMessageOptions(options) };
    for (const chunk of formatTelegramMessageChunks(text)) {
      await bot.api.sendMessage({ ...params, text: chunk });
    }
  }

  function sendMediaAttachment(
    chatId: string,
    kind: "image" | "video" | "audio" | "document",
    file: string | InputFile,
    options: Record<string, any>,
  ) {
    const params = { chat_id: chatId, ...telegramMessageOptions(options) };
    if (kind === "image") return bot.api.sendPhoto({ ...params, photo: file });
    if (kind === "video") return bot.api.sendVideo({ ...params, video: file });
    if (kind === "audio") return bot.api.sendAudio({ ...params, audio: file });
    return bot.api.sendDocument({ ...params, document: file });
  }

  /** 上次 block streaming 发送时间（用于 humanDelay） */
  let lastBlockTs = 0;

  return {
    mediaCapabilities: TELEGRAM_MEDIA_CAPABILITIES,
    richStreamingCapabilities: TELEGRAM_RICH_STREAMING_CAPABILITIES,
    streamingCapabilities: TELEGRAM_STREAMING_CAPABILITIES,
    receiptCapabilities: TELEGRAM_RECEIPT_CAPABILITIES,

    async sendTypingIndicator(chatId, options = {}) {
      try {
        await bot.api.sendChatAction({ chat_id: chatId, action: "typing", ...telegramMessageOptions(options) });
      } catch {}
    },

    async sendReply(chatId, text, options = {}) {
      await sendText(chatId, text, options);
    },

    /** block streaming 专用：发一条气泡，两条之间加 humanDelay */
    async sendBlockReply(chatId, text, options = {}) {
      const now = Date.now();
      const elapsed = now - lastBlockTs;
      const delay = 800 + Math.random() * 1200; // 800~2000ms
      if (lastBlockTs && elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
      await sendText(chatId, text, options);
      lastBlockTs = Date.now();
    },

    /** 流式草稿（Bot API 9.5 sendMessageDraft） */
    async sendDraft(chatId, text, options: Record<string, any> = {}) {
      const draftId = Number(options.draftId);
      if (!Number.isInteger(draftId) || draftId === 0) {
        throw new Error("Telegram sendDraft requires a non-zero integer draftId");
      }
      return bot.api.sendMessageDraft({ chat_id: chatId, draft_id: draftId, text, ...telegramMessageOptions(options) });
    },

    /** Rich streaming draft（Bot API sendRichMessageDraft） */
    async sendRichDraft(chatId, text, options: Record<string, any> = {}) {
      const draftId = Number(options.draftId);
      if (!Number.isInteger(draftId) || draftId === 0) {
        throw new Error("Telegram sendRichDraft requires a non-zero integer draftId");
      }
      const richMessage = renderTelegramRichMessage(text, {
        includeThinkingPlaceholder: options.includeThinkingPlaceholder,
        thinkingText: options.thinkingText,
      });
      return bot.api.sendRichMessageDraft({
        chat_id: chatId,
        draft_id: draftId,
        rich_message: richMessage,
        ...telegramMessageOptions(options),
      });
    },

    /** Persistent Rich Message final send（Bot API sendRichMessage） */
    async sendRichReply(chatId, text, options: Record<string, any> = {}) {
      return bot.api.sendRichMessage({
        chat_id: chatId,
        rich_message: renderTelegramRichMessage(text),
        ...telegramMessageOptions(options),
      });
    },

    /** 发送媒体（根据 URL 扩展名自动选择发送方式） */
    async sendMedia(chatId, url, metadata = {}) {
      const ext = safeExtFromUrl(url);
      const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
      const videoExts = ["mp4", "mov", "avi", "mkv"];
      const audioExts = ["mp3", "ogg", "wav", "m4a", "opus"];
      const kind = imageExts.includes(ext) ? "image"
        : videoExts.includes(ext) ? "video"
          : audioExts.includes(ext) ? "audio" : "document";
      try {
        await sendMediaAttachment(chatId, kind, url, metadata);
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] sendMedia 失败 (${ext}): ${err.message}`);
        throw err;
      }
    },

    /** 发送本地 staged file 内容：MediaDeliveryService 负责归属校验和读入 Buffer。 */
    async sendMediaBuffer(chatId, buffer, metadata: Record<string, any> = {}) {
      const mime = metadata.mime || "application/octet-stream";
      const kind = mime.startsWith("image/") ? "image"
        : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
      try {
        const media = new InputFile(buffer, { filename: metadata.filename, contentType: mime });
        await sendMediaAttachment(chatId, kind, media, metadata);
      } catch (err) {
        debugLog()?.warn("bridge", `[telegram] sendMediaBuffer 失败 (${mime}): ${err.message}`);
        throw err;
      }
    },

    stop() {
      if (lifecycle.signal.aborted) return;
      lifecycle.abort();
      clearTimeout(restartTimer);
      bot.stop();
      return polling.then(() => bot.close()).catch((err) => {
        debugLog()?.warn("bridge", `telegram bot cleanup failed: ${err.message}`);
      });
    },

    /** 验证 token 有效性 */
    async getMe() {
      return bot.api.getMe();
    },
  };
}
