import { useState, useEffect, useRef, useCallback } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import { Overlay } from '../../ui';
import styles from './WechatQrcodeOverlay.module.css';

type QrStatus = 'loading' | 'waiting' | 'scanned' | 'verify' | 'confirmed' | 'already-bound' | 'error';
type Login = { agentQuery: string; controller: AbortController };

const MAX_REFRESH = 3;

export function WechatQrcodeOverlay() {
  const [visible, setVisible] = useState(false);
  const [qrcodeUrl, setQrcodeUrl] = useState('');
  const [status, setStatus] = useState<QrStatus>('loading');
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<{ qrcodeId: string; incorrect: boolean; attempt: number } | null>(null);
  const [code, setCode] = useState('');
  const activeLogin = useRef<Login | null>(null);

  const close = useCallback(() => {
    activeLogin.current?.controller.abort();
    activeLogin.current = null;
    setVisible(false);
  }, []);

  const poll = useCallback(async function pollQr(login: Login, qrcodeId: string, attempt: number, verifyCode?: string) {
    const { agentQuery, controller: { signal } } = login;
    if (!qrcodeId) {
      await requestQr(attempt);
      return;
    }
    let failures = 0;
    while (!signal.aborted) {
      let data;
      try {
        const res = await hanaFetch(`/api/bridge/wechat/qrcode-status${agentQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qrcodeId, verifyCode }),
          timeout: 45_000,
          signal,
        });
        data = await res.json();
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        if (++failures >= 3) {
          setError(err instanceof Error ? err.message : t('settings.bridge.wechatLoginFailed'));
          setStatus('error');
          return;
        }
      }
      if (signal.aborted) return;
      if (data?.status === 'scanned') {
        verifyCode = undefined;
        setStatus('scanned');
      } else if (data?.status === 'redirected') {
        setStatus('scanned');
      } else if (data?.status === 'verification_required') {
        setCode('');
        setVerification({ qrcodeId, incorrect: data.incorrect === true, attempt });
        setStatus('verify');
        return;
      } else if (data?.status === 'already_bound' || data?.status === 'confirmed') {
        setStatus(data.status === 'already_bound' ? 'already-bound' : 'confirmed');
        window.dispatchEvent(new Event('hana-bridge-reload'));
        if (data.status === 'confirmed') {
          setTimeout(() => { if (!signal.aborted) close(); }, 1200);
        }
        return;
      } else if (data?.status === 'expired') {
        if (attempt >= MAX_REFRESH) {
          setError(t('settings.bridge.wechatExpired'));
          setStatus('error');
        } else {
          await requestQr(attempt + 1);
        }
        return;
      } else if (['verify_code_blocked', 'invalid_endpoint', 'error'].includes(data?.status)) {
        setError(data.error || t(data.status === 'verify_code_blocked'
          ? 'settings.bridge.wechatVerifyBlocked'
          : 'settings.bridge.wechatLoginFailed'));
        setStatus('error');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    async function requestQr(nextAttempt: number) {
      setStatus('loading');
      setError('');
      setVerification(null);
      try {
        const res = await hanaFetch(`/api/bridge/wechat/qrcode${agentQuery}`, {
          method: 'POST',
          timeout: 45_000,
          signal,
        });
        const data = await res.json();
        if (signal.aborted) return;
        if (!data.ok || !data.qrcodeUrl || !data.qrcodeId) {
          throw new Error(data.error || t('settings.bridge.wechatLoginFailed'));
        }
        setQrcodeUrl(data.qrcodeUrl);
        setStatus('waiting');
        void pollQr(login, data.qrcodeId, nextAttempt);
      } catch (err) {
        if (signal.aborted) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : t('settings.bridge.wechatLoginFailed'));
      }
    }
  }, [close]);

  useEffect(() => {
    const show = (e: Event) => {
      const agentId = (e as CustomEvent<{ agentId?: string | null }>).detail?.agentId;
      if (!agentId) return;
      activeLogin.current?.controller.abort();
      const login = { agentQuery: `?agentId=${encodeURIComponent(agentId)}`, controller: new AbortController() };
      activeLogin.current = login;
      setVisible(true);
      setQrcodeUrl('');
      void poll(login, '', 1);
    };
    window.addEventListener('hana-show-wechat-qrcode', show);
    return () => {
      window.removeEventListener('hana-show-wechat-qrcode', show);
      activeLogin.current?.controller.abort();
    };
  }, [poll]);

  const statusLabel = (() => {
    switch (status) {
      case 'loading':
      case 'waiting': return t('settings.bridge.wechatScanning');
      case 'scanned': return t('settings.bridge.wechatScanned');
      case 'verify': return t(verification?.incorrect
        ? 'settings.bridge.wechatVerifyIncorrect'
        : 'settings.bridge.wechatVerifyPrompt');
      case 'confirmed': return t('settings.bridge.wechatLoginSuccess');
      case 'already-bound': return t('settings.bridge.wechatLoggedIn');
      case 'error': return error || t('settings.bridge.wechatLoginFailed');
    }
  })();

  const statusClass = status === 'confirmed' || status === 'already-bound' ? styles.success
    : status === 'error' ? styles.error
      : '';

  return (
    <Overlay
      scope="inline"
      open={visible}
      onClose={close}
      backdrop="blur"
      zIndex={100}
      className={styles.card}
      disableContainerAnimation
    >
        <button className={styles.closeBtn} onClick={close} aria-label="close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className={styles.title}>{t('settings.bridge.wechat')}</div>

        <div className={styles.qrcodeContainer}>
          {status === 'loading' && <span className={styles.loading}>...</span>}
          {qrcodeUrl && status !== 'loading' && (
            <img className={styles.qrcodeImg} src={qrcodeUrl} alt="WeChat QR Code" />
          )}
        </div>

        <div className={`${styles.statusText} ${statusClass}`} role="status">{statusLabel}</div>
        {status === 'verify' && verification && (
          <form className={styles.verifyForm} onSubmit={(event) => {
            event.preventDefault();
            const login = activeLogin.current;
            if (!login || !/^\d{1,12}$/.test(code)) return;
            setStatus('scanned');
            void poll(login, verification.qrcodeId, verification.attempt, code);
          }}>
            <input
              aria-label={t('settings.bridge.wechatVerifyPrompt')}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={12}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
            <button type="submit" disabled={!code}>{t('settings.bridge.wechatVerifySubmit')}</button>
          </form>
        )}
    </Overlay>
  );
}
