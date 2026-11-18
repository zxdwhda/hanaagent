import React, { useEffect, useState, useRef } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import { DEFAULT_OAUTH_LOGIN_METHOD } from '../../../../../../../packages/shared/oauth-login.ts';
import styles from '../../Settings.module.css';

const platform = window.platform;

export function OAuthCredentials({ providerId, summary, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  onRefresh: () => Promise<void>;
}) {
  const showToast = useSettingsStore(s => s.showToast);
  return <OAuthLogin providerId={providerId} loggedIn={summary.logged_in === true} onRefresh={onRefresh} request={hanaFetch} notify={showToast} />;
}

export function OAuthLogin({ providerId, loggedIn, onRefresh, request: fetchOAuth, notify: showToast }: {
  providerId: string;
  loggedIn: boolean;
  onRefresh: () => Promise<void>;
  request: (path: string, options?: RequestInit) => Promise<Response>;
  notify: (message: string, type: 'success' | 'error') => void;
}) {
  const [codeInput, setCodeInput] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [acceptsCallbackUrl, setAcceptsCallbackUrl] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const loginRequestRef = useRef<AbortController | null>(null);
  const oauthSessionIdRef = useRef<string | null>(null);

  useEffect(() => () => loginRequestRef.current?.abort(), []);

  const finishLogin = async (request: AbortController) => {
    if (request.signal.aborted) return;
    request.abort();
    oauthSessionIdRef.current = null;
    setCodeInput('');
    setShowCodeInput(false);
    setDeviceCode(null);
    setPolling(false);
    showToast(t('settings.oauth.success'), 'success');
    await onRefresh();
  };

  const login = async () => {
    loginRequestRef.current?.abort();
    const request = new AbortController();
    loginRequestRef.current = request;
    oauthSessionIdRef.current = null;
    setCodeInput('');
    setShowCodeInput(false);
    try {
      const res = await fetchOAuth('/api/auth/oauth/start', {
        method: 'POST',
        signal: request.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerId,
          loginMethod: DEFAULT_OAUTH_LOGIN_METHOD,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (request.signal.aborted) return;
      if (data.error) throw new Error(data.error);
      platform?.openExternal?.(data.url);
      oauthSessionIdRef.current = data.sessionId;
      const shouldPoll = Boolean(data.instructions || data.polling);
      const supportsManualCallback = data.manualCodeSupported === true;
      setAcceptsCallbackUrl(supportsManualCallback);
      setShowCodeInput(!shouldPoll || supportsManualCallback);
      if (shouldPoll) {
        setDeviceCode(data.instructions || null);
        setPolling(true);
        await pollLogin(data.sessionId, request);
      }
    } catch (err: unknown) {
      if (request.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  const submitCode = async () => {
    const code = codeInput.trim();
    const request = loginRequestRef.current;
    const sessionId = oauthSessionIdRef.current;
    if (!code || !sessionId || !request || request.signal.aborted) return;
    try {
      const res = await fetchOAuth('/api/auth/oauth/callback', {
        method: 'POST',
        signal: request.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, code }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await finishLogin(request);
    } catch (err: unknown) {
      if (request.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  const pollLogin = async (sessionId: string, request: AbortController) => {
    const { signal } = request;
    let consecutiveFailures = 0;
    try {
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 3000));
        if (signal.aborted) return;
        let data: { status?: string; error?: string };
        try {
          const res = await fetchOAuth(`/api/auth/oauth/poll/${sessionId}`, { signal });
          data = await res.json();
          if (!res.ok && data.status !== 'error') throw new Error(`HTTP ${res.status}`);
          consecutiveFailures = 0;
        } catch (err) {
          if (signal.aborted) return;
          if ((err as { code?: string })?.code === 'OAUTH_FLOW_EXPIRED') throw err;
          consecutiveFailures++;
          if (consecutiveFailures >= 3) throw err;
          continue;
        }
        if (signal.aborted) return;
        if (data.status === 'done') {
          await finishLogin(request);
          return;
        }
        if (data.status === 'error') throw new Error(data.error || 'Login failed');
      }
      throw new Error(t('settings.mcp.oauthTimeout'));
    } finally {
      if (!signal.aborted) {
        setDeviceCode(null);
        setPolling(false);
      }
    }
  };

  const logout = async () => {
    try {
      const res = await fetchOAuth('/api/auth/oauth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t('settings.oauth.loggedOut'), 'success');
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.oauth.failed') + ': ' + msg, 'error');
    }
  };

  return (
    <div className={styles['pv-credentials']}>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>OAuth</span>
        {loggedIn ? (
          <div className={styles['pv-oauth-status']}>
            <span className={styles['oauth-status-badge']}>{t('settings.oauth.loggedIn')}</span>
            <button className={styles['oauth-logout-btn']} onClick={logout}>{t('settings.oauth.logout')}</button>
          </div>
        ) : (
          <button className={styles['oauth-login-btn']} onClick={login} disabled={polling}>{t('settings.oauth.login')}</button>
        )}
      </div>

      {showCodeInput && (
        <div className={styles['oauth-code-section']}>
          <input
            className={`${styles['settings-input']} ${styles['oauth-code-input']}`}
            type="text"
            placeholder={t(acceptsCallbackUrl ? 'settings.oauth.callbackPlaceholder' : 'settings.oauth.codePlaceholder')}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitCode(); }}
            autoFocus
          />
          <button className={styles['oauth-code-submit']} onClick={submitCode}>{t('settings.oauth.submit')}</button>
        </div>
      )}
      {deviceCode && (
        <div className={`${styles['oauth-code-section']} ${styles['oauth-device-code']}`}>
          <div
            className={styles['oauth-user-code']}
            title={t('settings.oauth.clickToCopy')}
            onClick={() => navigator.clipboard.writeText(deviceCode).then(() => showToast(t('settings.oauth.codeCopied'), 'success'))}
          >
            {deviceCode}
          </div>
          <div className={styles['oauth-device-hint']}>{t('settings.oauth.deviceHint')}</div>
          <div className={styles['oauth-device-spinner']}>{t('settings.oauth.waiting')}</div>
        </div>
      )}
      {polling && !deviceCode && (
        <div className={styles['oauth-code-section']}>
          <div className={styles['oauth-device-spinner']}>{t('settings.oauth.waiting')}</div>
        </div>
      )}
    </div>
  );
}
