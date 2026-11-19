import { useCallback, useEffect, useMemo, useState } from 'react';
import { PLUGIN_SURFACE_SESSION_QUERY } from '@hana/plugin-protocol';
import { useStore } from '../stores';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  isLocalOwnerConnection,
  type ServerConnection,
} from '../services/server-connection';
import { DEFAULT_THEME } from '../../shared/theme-registry';

type SurfaceUrlStatus = 'loading' | 'ready' | 'error';

interface IssuedSurfaceCredentials {
  key: string;
  ticket: string | null;
  surfaceSession: string | null;
  surfaceSessionExpiresAt: number | null;
}

interface SurfaceIssueError {
  key: string;
  message: string;
}

export interface PluginSurfaceUrlState {
  iframeSrc: string | null;
  status: SurfaceUrlStatus;
  error: string | null;
  retry: () => void;
}

/**
 * 为插件 iframe 表面构造 src：
 * - 本地 owner 连接：文档加载沿用 loopback query token；
 * - 远程连接：文档加载使用一次性 iframe ticket（凭证不进 iframe URL 之外的位置）；
 * - 两种连接都向宿主签发 plugin surface session 并随 URL 下发
 *   （`pluginSurfaceSession`），页面脚本调用本插件 route handler 时显式携带，
 *   服务端据此铸造请求级 plugin principal（#1629）。
 */
export function usePluginSurfaceUrl(routeUrl: string | null, agentId?: string | null): PluginSurfaceUrlState {
  const connection = useStore(s => s.activeServerConnection);
  const [issued, setIssued] = useState<IssuedSurfaceCredentials | null>(null);
  const [issueError, setIssueError] = useState<SurfaceIssueError | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const requestKey = connection && routeUrl
    ? [
        connection.connectionId,
        connection.baseUrl,
        connection.token || '',
        routeUrl,
        retryNonce,
      ].join('|')
    : '';
  const localOwner = isLocalOwnerConnection(connection);

  useEffect(() => {
    if (!connection || !routeUrl) {
      setIssued(null);
      setIssueError(null);
      return;
    }

    const controller = new AbortController();
    const requestStartedAt = Date.now();
    setIssued(null);
    setIssueError(null);

    void fetch(buildConnectionUrl(connection, '/api/plugins/iframe-ticket'), {
      method: 'POST',
      headers: appendConnectionAuth(connection, { 'Content-Type': 'application/json' }),
      credentials: 'include',
      signal: controller.signal,
      body: JSON.stringify({ routeUrl }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`plugin iframe ticket failed: ${res.status} ${res.statusText}`);
      return res.json();
    }).then((data) => {
      if (controller.signal.aborted) return;
      const ticket = typeof data?.ticket === 'string' && data.ticket ? data.ticket : null;
      const surfaceSession = typeof data?.surfaceSession?.token === 'string' && data.surfaceSession.token
        ? data.surfaceSession.token
        : null;
      const expiresAt = Date.parse(data?.surfaceSession?.expiresAt);
      const issuedAt = Date.parse(data?.surfaceSession?.issuedAt);
      // When both server times are available, use the TTL so a remote
      // server's wall clock does not determine the local renewal deadline.
      const expiresLocally = Number.isFinite(issuedAt) ? requestStartedAt + (expiresAt - issuedAt) : expiresAt;
      if (!localOwner && !ticket) {
        throw new Error('plugin iframe ticket missing');
      }
      const surfaceSessionExpiresAt = surfaceSession && Number.isFinite(expiresLocally) ? expiresLocally : null;
      if (surfaceSessionExpiresAt !== null && surfaceSessionExpiresAt <= Date.now()) {
        throw new Error('plugin surface session expired before it could be loaded');
      }
      setIssued({ key: requestKey, ticket, surfaceSession, surfaceSessionExpiresAt });
    }).catch((err) => {
      if (controller.signal.aborted) return;
      setIssueError({ key: requestKey, message: err instanceof Error ? err.message : String(err) });
    });

    return () => controller.abort();
  }, [connection, localOwner, requestKey, routeUrl]);

  useEffect(() => {
    const expiresAt = issued?.surfaceSessionExpiresAt;
    if (issued?.key !== requestKey || expiresAt == null) return;

    let renewing = false;
    const renewIfExpired = () => {
      if (renewing || Date.now() < expiresAt) return;
      renewing = true;
      setRetryNonce(n => n + 1);
    };
    const timer = window.setTimeout(renewIfExpired, Math.max(0, expiresAt - Date.now()));
    window.addEventListener('focus', renewIfExpired);
    document.addEventListener('visibilitychange', renewIfExpired);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', renewIfExpired);
      document.removeEventListener('visibilitychange', renewIfExpired);
    };
  }, [issued, requestKey]);

  const iframeSrc = useMemo(() => {
    if (!connection || !routeUrl) return null;
    if (issued?.key !== requestKey) return null;
    return buildPluginSurfaceUrl({
      connection,
      routeUrl,
      agentId,
      ticket: localOwner ? null : issued.ticket,
      surfaceSession: issued.surfaceSession,
      theme: document.documentElement.dataset.theme || DEFAULT_THEME,
    });
  }, [agentId, connection, issued, localOwner, requestKey, routeUrl]);

  const retry = useCallback(() => setRetryNonce(n => n + 1), []);

  if (!connection || !routeUrl) return { iframeSrc: null, status: 'loading', error: null, retry };
  if (issueError?.key === requestKey) return { iframeSrc: null, status: 'error', error: issueError.message, retry };
  if (issued?.key === requestKey && iframeSrc) return { iframeSrc, status: 'ready', error: null, retry };
  return { iframeSrc: null, status: 'loading', error: null, retry };
}

export function buildPluginSurfaceUrl({
  connection,
  routeUrl,
  agentId,
  ticket,
  surfaceSession,
  theme,
}: {
  connection: ServerConnection;
  routeUrl: string;
  agentId?: string | null;
  ticket?: string | null;
  surfaceSession?: string | null;
  theme: string;
}): string {
  const cssUrl = buildConnectionUrl(
    connection,
    `/api/plugins/theme.css?theme=${encodeURIComponent(theme)}`,
    { includeTokenQuery: true },
  );
  const fullUrl = buildConnectionUrl(connection, routeUrl, { includeTokenQuery: true });
  const url = new URL(fullUrl);
  if (ticket) url.searchParams.set('pluginIframeTicket', ticket);
  if (surfaceSession) url.searchParams.set('pluginSurfaceSession', surfaceSession);
  // A surface can be opened without an agent, for example a preview. Sending
  // agentId= would claim the surface belongs to an agent whose id is empty;
  // leaving the parameter off says there is no agent.
  if (agentId) url.searchParams.set('agentId', agentId);
  url.searchParams.set('hana-theme', theme);
  url.searchParams.set('hana-css', cssUrl);
  return url.toString();
}
