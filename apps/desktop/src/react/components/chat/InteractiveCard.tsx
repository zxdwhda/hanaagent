/**
 * InteractiveCard — show_card tool 的渲染组件
 *
 * 加载方式（关键架构）：
 *   卡片 HTML 由本地 Hana server 经 http 提供（server/routes/cards.ts），
 *   iframe 用 src 加载，**不用 srcdoc/blob**。原因：srcdoc/blob 会继承渲染进程
 *   的 `script-src 'self'` CSP，导致 iframe 内所有内联脚本（高度上报 + agent 的
 *   onclick/addEventListener）被静默阻断。真实 HTTP 响应使用卡片专属 CSP，
 *   允许内联脚本在受限 iframe 中运行。
 *   这与插件 surface（PluginCardBlock 等）走的是同一条经过验证的路径。
 *
 * 数据流：
 *   挂载 → 采集当前主题变量 → PUT /api/cards/:cardId {code,title,varsCss} 注册
 *        → 本机沿用卡片 URL，远端使用经过会话授权后返回的短期预览地址。
 *   直播与历史走同一条路（两者 block 都带 cardId+code），server 缓存为瞬态 LRU，
 *   重启后下次渲染自动回填。
 *
 * 高度机制：iframe 内 ResizeObserver 上报内容高度 → 设置显式 height；
 *   宿主在 load 后主动 ping 兜底首报竞态；上限 900px，超出后 iframe 滚动。
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import s from './InteractiveCard.module.css';
import { useStore } from '../../stores';
import { hanaFetch, hanaUrl } from '../../hooks/use-hana-fetch';
import { sessionIdForPathFromLocatorState } from '../../stores/session-slice';
import { buildConnectionUrl, isLocalOwnerConnection } from '../../services/server-connection';

// ── 宿主注入 iframe 的主题 CSS 变量 ──
// 从 document root 的 computed style 中提取，随注册 PUT 给 server 注入到 iframe :root。
const THEME_VARS = [
  '--bg', '--bg-card', '--sidebar-bg',
  '--text', '--text-light', '--text-muted',
  '--border',
  '--accent', '--accent-hover', '--accent-light', '--accent-rgb',
  '--green', '--danger',
  '--radius-chat-card', '--radius-chat-card-inner',
  '--space-xs', '--space-sm', '--space-md', '--space-lg',
] as const;

function collectThemeVars(): string {
  const root = getComputedStyle(document.documentElement);
  return THEME_VARS
    .map(name => {
      const val = root.getPropertyValue(name).trim();
      return val ? `  ${name}: ${val};` : '';
    })
    .filter(Boolean)
    .join('\n');
}

// ── 高度 cap ──
const HEIGHT_CAP = 900;

interface InteractiveCardProps {
  sessionPath?: string;
  block: {
    type: 'interactive_card';
    cardId: string;
    title: string;
    code: string;
  };
}

export const InteractiveCard = memo(function InteractiveCard({ block, sessionPath }: InteractiveCardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [explicitHeight, setExplicitHeight] = useState<number | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  // 连接就绪信号：作为 effect 依赖，连接建立后自动触发注册。
  const connection = useStore(st => st.activeServerConnection);
  // 单调递增版本号：code/vars 变化重注册时改变 src，强制 iframe reload。
  const verRef = useRef(0);

  // 注册卡片代码 → 拿到可加载的 http URL
  useEffect(() => {
    setSrc(null);
    const cardId = block.cardId;
    if (!cardId || !connection) return;
    const local = isLocalOwnerConnection(connection);
    if (!local && !sessionPath) return;
    const sessionId = sessionPath && sessionIdForPathFromLocatorState(useStore.getState(), sessionPath);
    const sessionTarget = sessionId ? { sessionId } : { sessionPath };
    const route = `/api/cards/${encodeURIComponent(cardId)}`;
    const varsCss = collectThemeVars();
    const controller = new AbortController();
    (async () => {
      try {
        const response = await hanaFetch(local ? route : `${route}/render`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: block.code, title: block.title, varsCss, ...(local ? {} : sessionTarget) }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!local) {
          const { viewPath } = await response.json();
          if (typeof viewPath !== 'string' || !/^\/api\/cards\/view\/[A-Za-z0-9_-]{32}$/.test(viewPath)) {
            throw new Error('Unexpected card preview URL');
          }
          if (!controller.signal.aborted) setSrc(buildConnectionUrl(connection, viewPath));
          return;
        }
        const base = hanaUrl(route);
        verRef.current += 1;
        const sep = base.includes('?') ? '&' : '?';
        setSrc(`${base}${sep}v=${verRef.current}`);
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('[InteractiveCard] register failed:', err);
          setSrc(null);
        }
      }
    })();
    return () => controller.abort();
  }, [block.cardId, block.code, block.title, connection, sessionPath]);

  // 监听 iframe 内容高度上报
  const handleMessage = useCallback((e: MessageEvent) => {
    if (e.source !== iframeRef.current?.contentWindow) return;
    if (e.data?.type !== 'hana.card-resize') return;

    const contentH = e.data.height;
    if (contentH > 0) {
      setExplicitHeight(Math.min(contentH, HEIGHT_CAP));
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  // iframe load 后主动 ping，确保高度上报不因竞态丢失
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => {
      iframe.contentWindow?.postMessage('hana.card-ping', '*');
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [src]);

  const isScrollable = explicitHeight !== null && explicitHeight >= HEIGHT_CAP;

  const frameStyle: React.CSSProperties = explicitHeight != null
    ? { height: explicitHeight }
    : {};

  const frameClassName = [
    s.interactiveCardFrame,
    isScrollable ? s.interactiveCardFrameScrollable : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={s.interactiveCard}>
      <div
        className={frameClassName}
        style={frameStyle}
      >
        {src && (
          <iframe
            ref={iframeRef}
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={block.title || 'Interactive card'}
          />
        )}
      </div>
    </div>
  );
});
