/**
 * slash-commands.ts — 斜杠命令定义和执行逻辑
 *
 * 从 InputArea.tsx 提取，减少主组件体量。
 */

import { hanaFetch } from '../../hooks/use-hana-fetch';
import { resolveServerConnection } from '../../services/server-connection';
import { getWebSocket } from '../../services/websocket';
import { useStore } from '../../stores';
import { ensureSession } from '../../stores/session-actions';
import { sessionScopedValue } from '../../stores/session-slice';

// ── Xing Prompt ──

const isZh = window.i18n?.locale?.startsWith?.('zh') ?? true;

export const XING_PROMPT = isZh
  ? `回顾本次对话中我（用户）发送的消息，提取可复用的工作流程、纠正和操作经验。

不要把用户的个人画像、审美喜好、兴趣、生活近况写进技能；这些属于记忆系统。
只把“以后遇到类似任务应该怎么做”的内容写成通用技能。

你必须先查阅 skill-creator 技能，按照其中 "Capture Intent" 和 "Write the SKILL.md" 部分的流程操作。
只做到创建并安装为止，不需要做 eval、benchmark 或 description optimization。

最终产物必须是完整 skill package：包含 SKILL.md，且 references/scripts/assets 等配套资源必须保留在同一个 skill 目录里。不要调用 install_skill 传 skill_content；模型侧 install_skill 只接受 GitHub 仓库等完整包来源。如果本轮生成的是本地 skill，请先把完整目录写到工作区并说明需要通过技能管理导入该目录或 zip，不能把单个 SKILL.md 冒充成完整安装。`
  : `Review the messages I (the user) sent in this session and extract reusable workflows, corrections, and operational lessons.

Do not write the user's personal profile, aesthetic tastes, interests, or life/current-state context into a skill; those belong in memory.
Only turn "how to handle similar tasks in the future" into a reusable skill.

You must first consult the skill-creator skill, following its "Capture Intent" and "Write the SKILL.md" sections.
Only go as far as creating and installing — do not run evals, benchmarks, or description optimization.

The final artifact must be a complete skill package: it must contain SKILL.md, and references/scripts/assets must stay in the same skill directory when needed. Do not call install_skill with skill_content; the model-facing install_skill tool only accepts complete package sources such as GitHub repositories. If this session creates a local skill, write the complete directory into the workspace and explain that the user should import that directory or zip through skill management; never treat a single SKILL.md as a complete install.`;

// ── Slash Command Interface ──

export interface SlashItem {
  name: string;
  aliases?: string[];
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  type: 'builtin' | 'skill' | 'server-command';
  execute: (inputText?: string) => Promise<void> | void;
}

export const MAX_SLASH_TRIGGER_LENGTH = 20;

/**
 * applySlashCompletion — 菜单选择 server-command 后，把编辑器原始文本改写为
 * canonical 命令文本（`/${item.name}`），保留首个 slash token 之后的一切内容
 * （空格、参数、多行）。非 slash 开头的文本走菜单按钮时丢弃输入，回退为纯
 * canonical 命令（复刻既有兜底语义）。一律替换为 canonical name（不保留用户
 * 输入的 alias），因为服务端 dispatch 的 alias 解析能力未验证。
 */
export function applySlashCompletion(
  text: string,
  item: Pick<SlashItem, 'name'>,
): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return `/${item.name}`;
  const tokenMatch = /^\/(\S*)/.exec(trimmed);
  if (!tokenMatch) return `/${item.name}`;
  return `/${item.name}${trimmed.slice(tokenMatch[0].length)}`;
}

export function getSlashMatches(text: string, commands: SlashItem[]): SlashItem[] {
  const normalized = text.trim();
  if (!normalized.startsWith('/')) return [];
  const query = normalized.slice(1).split(/\s+/, 1)[0].toLowerCase();
  if (query.length > MAX_SLASH_TRIGGER_LENGTH) return [];
  return commands.filter(command => {
    if (command.name.startsWith(query)) return true;
    return (command.aliases || []).some(alias => alias.toLowerCase().startsWith(query));
  });
}

export function resolveSlashSubmitSelection({
  text,
  skills,
  commands,
  selectedIndex,
  dismissedText,
}: {
  text: string;
  skills: string[];
  commands: SlashItem[];
  selectedIndex: number;
  dismissedText: string | null;
}): SlashItem | null {
  if (skills.length > 0) return null;
  const matches = getSlashMatches(text, commands);
  if (matches.length === 0) return null;
  if (dismissedText === text.trim()) return null;
  const selected = matches[selectedIndex] || matches[0] || null;
  if (!selected) return null;
  const hasArgs = /\s/.test(text.trim().slice(1));
  if (hasArgs && selected.type !== 'server-command') return null;
  return selected;
}

// ── Command Executors ──

type ToastType = 'success' | 'error' | 'info' | 'warning';
type AddToast = (
  text: string,
  type?: ToastType,
  duration?: number,
  opts?: { persistent?: boolean; dedupeKey?: string },
) => number | null;
type RemoveToast = (id: number) => void;

const DIARY_JOB_PATH = '/api/diary/jobs';
const DIARY_SUBMIT_TIMEOUT_MS = 10_000;
const DIARY_STATUS_TIMEOUT_MS = 5_000;
const DIARY_POLL_INTERVAL_MS = 2_000;
const DIARY_WAIT_MS = 150_000;

type DiaryOutcome =
  | { status: 'succeeded' }
  | { status: 'unknown' }
  | { status: 'failed' | 'rejected'; error?: string };

type DiaryJobPayload = { status?: string; filePath?: string; error?: string };

function createDiaryJobId() {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Browser access on non-secure LAN origins still supports getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

async function requestDiaryJob(path: string, timeout: number, options: RequestInit) {
  const controller = new AbortController();
  // hanaFetch's own timeout ends when headers arrive. Keep the request bounded
  // while reading the response body too.
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await hanaFetch(path, {
      ...options,
      timeout,
      signal: controller.signal,
      throwOnHttpError: false,
    });
    const data: DiaryJobPayload | null = await response.json().catch(() => null);
    return { ok: response.ok, code: response.status, data };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function diaryTerminalOutcome(response: Awaited<ReturnType<typeof requestDiaryJob>>): DiaryOutcome | null {
  if (!response?.ok) return null;
  const data = response.data;
  if (data?.status === 'succeeded' && typeof data.filePath === 'string' && data.filePath.trim()) {
    return { status: 'succeeded' };
  }
  if (data?.status === 'failed') {
    return { status: 'failed', error: typeof data.error === 'string' ? data.error : undefined };
  }
  return null;
}

function readDiaryBackendIdentity() {
  const connection = resolveServerConnection(useStore.getState());
  if (!connection) return null;
  return [
    connection.connectionId,
    connection.baseUrl,
    connection.serverId,
    connection.serverNodeId ?? connection.executionBoundary?.serverNodeId,
    connection.studioId,
    connection.credentialKind,
    connection.userId ?? null,
    connection.platformAccountId ?? null,
    // A rotating token is only identifying when no stable principal is known.
    connection.userId || connection.platformAccountId ? null : connection.token,
  ] as const;
}

async function waitForDiaryJob(jobId: string): Promise<DiaryOutcome> {
  const backend = readDiaryBackendIdentity();
  const stillOnBackend = () => {
    const active = readDiaryBackendIdentity();
    return backend === null ? active === null : active !== null && backend.every((part, index) => part === active[index]);
  };
  const deadline = performance.now() + DIARY_WAIT_MS;
  const submission = await requestDiaryJob(DIARY_JOB_PATH, DIARY_SUBMIT_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
  if (!stillOnBackend()) return { status: 'unknown' };
  const terminal = diaryTerminalOutcome(submission);
  if (terminal) return terminal;
  if (submission && [400, 401, 403, 409, 422].includes(submission.code)) {
    const error = submission.data?.error;
    return { status: 'rejected', error: typeof error === 'string' ? error : undefined };
  }

  // A missing acknowledgement (or an early 404) could precede acceptance.
  // Only query status from here so the original request can finish.
  for (let remaining = deadline - performance.now(); remaining > 0; remaining = deadline - performance.now()) {
    if (!stillOnBackend()) break;
    const status = await requestDiaryJob(DIARY_JOB_PATH + '/' + jobId, Math.min(remaining, DIARY_STATUS_TIMEOUT_MS), {
      method: 'GET',
    });
    if (!stillOnBackend()) break;
    const result = diaryTerminalOutcome(status);
    if (result) return result;
    const delay = Math.min(deadline - performance.now(), DIARY_POLL_INTERVAL_MS);
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  return { status: 'unknown' };
}

export function executeDiary(
  t: (key: string) => string,
  addToast: AddToast,
  removeToast: RemoveToast,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => void {
  return () => {
    setInput('');
    setMenuOpen(false);
    let jobId: string;
    try {
      jobId = createDiaryJobId();
    } catch {
      addToast(t('slash.diaryRejected'), 'error', 6000);
      return;
    }
    const progressToastId = addToast(t('slash.diaryBusy'), 'info', 0, {
      persistent: true,
      dedupeKey: 'slash-diary-progress:' + jobId,
    });

    void (async () => {
      const result = await waitForDiaryJob(jobId).catch((): DiaryOutcome => ({ status: 'unknown' }));
      if (progressToastId !== null) removeToast(progressToastId);
      if (result.status === 'succeeded') addToast(t('slash.diaryDone'), 'success', 5000);
      else if (result.status === 'unknown') addToast(t('slash.diaryUnknown'), 'warning', 6000);
      else addToast(result.error || t(result.status === 'failed' ? 'slash.diaryFailed' : 'slash.diaryRejected'), 'error', 6000);
    })();
  };
}

export function executeCompact(
  t: (key: string) => string,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    const state = useStore.getState();
    if (!state.currentSessionId) {
      state.addToast(t('error.noActiveSession'), 'error', 6000);
      return;
    }
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      state.addToast(t('status.disconnected'), 'error', 6000);
      return;
    }
    setBusy('compact');
    setInput('');
    setMenuOpen(false);
    try {
      ws.send(JSON.stringify({ type: 'compact', sessionId: state.currentSessionId }));
    } finally {
      setTimeout(() => setBusy(null), 1500);
    }
  };
}

/**
 * 通用的 WS slash 命令发送器。
 * 桌面端的入口是菜单里的 server-command 类命令（/loop、插件与扩展注册的命令），
 * 以及用户直接敲出的同名 slash 文本；桌面已有 GUI 的 core 命令不从这里走。
 * 后端在 server/routes/chat.ts 接收 {type:'slash'}，走 engine.slashDispatcher.tryDispatch。
 *
 * 普通命令使用输入框的会话与助手。草稿中的 /loop 启动请求先走普通首发的会话创建，
 * 再使用返回的固定会话标识；查看或控制循环不会创建新会话。
 *
 * 执行结果由服务端通过 WS {type:'slash_result'} 回来，ws-message-handler 的同名分支
 * 把它送进 inline notice 显示给用户。这里的 800ms setBusy(null) 与结果无关，只是给按钮
 * 一个防抖窗口，不代表命令已经执行完。
 */
export function executeSlashViaWs(
  cmd: string,
  agentId: string | null,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
  t: (key: string) => string = (key) => key,
): (inputText?: string) => Promise<void> {
  return async (inputText?: string) => {
    const rawText = typeof inputText === 'string' && inputText.trim().startsWith('/')
      ? inputText.trim()
      : `/${cmd}`;
    const state = useStore.getState();
    const connectedSocket = () => {
      const socket = getWebSocket();
      if (socket?.readyState === WebSocket.OPEN) return socket;
      state.addToast(t('status.disconnected'), 'error', 6000);
      return null;
    };
    let ws = connectedSocket();
    if (!ws) return;
    let sessionPath = state.currentSessionPath;
    let sessionId = state.currentSessionId;
    let targetAgentId = agentId;
    let draftActivated = false;
    const restoreDraftAfterDisconnect = () => {
      const latest = useStore.getState();
      if (draftActivated && sessionPath
        && !sessionScopedValue(latest, latest.drafts, sessionPath)
        && !sessionScopedValue(latest, latest.draftDocs, sessionPath)) {
        latest.setDraft(sessionPath, rawText);
      }
    };
    setBusy(cmd);
    try {
      if (cmd === 'loop' && !sessionPath) {
        const [, task] = rawText.split(/\s+/, 2);
        if (!state.pendingNewSession || !task || /^(stop|pause|resume|status)$/i.test(task)) {
          state.addToast(t('error.noActiveSession'), 'error', 6000);
          return;
        }
        const ref = await ensureSession(state.pendingDraftId);
        if (!ref) return;
        const latest = useStore.getState();
        if (latest.currentSessionId !== ref.sessionId || latest.currentSessionPath !== ref.sessionPath) return;
        ({ sessionPath, sessionId, agentId: targetAgentId } = ref);
        draftActivated = true;
        ws = connectedSocket();
        if (!ws) {
          restoreDraftAfterDisconnect();
          return;
        }
      }
      try {
        ws.send(JSON.stringify({
          type: 'slash',
          text: rawText,
          sessionPath,
          ...(sessionId ? { sessionId } : {}),
          agentId: targetAgentId || null,
        }));
      } catch {
        restoreDraftAfterDisconnect();
        state.addToast(t('status.disconnected'), 'error', 6000);
        return;
      }
      setInput('');
      setMenuOpen(false);
    } finally {
      setTimeout(() => setBusy(null), 800);
    }
  };
}

export function buildSlashCommands(
  t: (key: string) => string,
  executeDiaryFn: () => Promise<void> | void,
  executeXingFn: () => Promise<void>,
  executeCompactFn: () => Promise<void>,
): SlashItem[] {
  const list: SlashItem[] = [
    {
      name: 'diary',
      label: '/diary',
      description: t('slash.diary'),
      busyLabel: t('slash.diaryBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      type: 'builtin',
      execute: executeDiaryFn,
    },
    {
      name: 'xing',
      label: '/xing',
      description: t('slash.xing'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
      type: 'builtin',
      execute: executeXingFn,
    },
    {
      name: 'compact',
      label: '/compact',
      description: t('slash.compact'),
      busyLabel: t('slash.compactBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
      type: 'builtin',
      execute: executeCompactFn,
    },
    // /loop 是服务端命令且必须带参数（任务描述 / 子命令），所以走 server-command 通道：
    // 提交时由 InputArea 经 applySlashCompletion 保留参数原文，再整条发给服务端 dispatcher。
    {
      name: 'loop',
      label: '/loop',
      description: t('slash.loop'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
      type: 'server-command',
      execute: () => {},
    },
  ];
  return list;
}
