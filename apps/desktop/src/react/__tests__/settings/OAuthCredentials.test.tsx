/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ProviderSummary } from '../../settings/store';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

import { OAuthCredentials } from '../../settings/tabs/providers/OAuthCredentials';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

const summary: ProviderSummary = {
  type: 'oauth',
  auth_type: 'oauth',
  display_name: 'ChatGPT Plus/Pro',
  base_url: '',
  api: 'openai-responses',
  api_key: '',
  models: [],
  custom_models: [],
  has_credentials: false,
  logged_in: false,
  supports_oauth: true,
  can_delete: false,
};

describe('OAuthCredentials', () => {
  beforeEach(() => {
    mocks.hanaFetch.mockReset();
    mocks.hanaFetch.mockResolvedValue(jsonResponse({
      sessionId: 'oauth-session-1',
      url: 'https://auth.example/start',
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('requests the explicit browser login method and keeps the callback session local', async () => {
    const onRefresh = vi.fn(async () => {});
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={summary}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.oauth.login' }));

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledTimes(1));
    const [startPath, startOptions] = mocks.hanaFetch.mock.calls[0];
    expect(startPath).toBe('/api/auth/oauth/start');
    expect(JSON.parse(String((startOptions as RequestInit).body))).toEqual({
      provider: 'openai-codex-oauth',
      loginMethod: 'browser',
    });

    mocks.hanaFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'manual-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.oauth.submit' }));

    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledTimes(2));
    const [callbackPath, callbackOptions] = mocks.hanaFetch.mock.calls[1];
    expect(callbackPath).toBe('/api/auth/oauth/callback');
    expect(JSON.parse(String((callbackOptions as RequestInit).body))).toEqual({
      sessionId: 'oauth-session-1',
      code: 'manual-code',
    });
  });

  it('keeps polling the same login after a transient connection failure', async () => {
    vi.useFakeTimers();
    mocks.hanaFetch
      .mockResolvedValueOnce(jsonResponse({
        sessionId: 'oauth-session-1',
        url: 'https://auth.example/start',
        polling: true,
      }))
      .mockRejectedValueOnce(new TypeError('Network disconnected'))
      .mockResolvedValueOnce(jsonResponse({ status: 'done' }));
    const onRefresh = vi.fn(async () => {});
    render(
      <OAuthCredentials
        providerId="openai-codex-oauth"
        summary={summary}
        onRefresh={onRefresh}
      />,
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.oauth.login' })));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText('settings.oauth.waiting')).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(mocks.hanaFetch.mock.calls.slice(1).map(([url]) => url)).toEqual([
      '/api/auth/oauth/poll/oauth-session-1',
      '/api/auth/oauth/poll/oauth-session-1',
    ]);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('settings.oauth.waiting')).not.toBeInTheDocument();
  });

  it('allows manual completion of a browser flow and stops its automatic polling', async () => {
    vi.useFakeTimers();
    mocks.hanaFetch
      .mockResolvedValueOnce(jsonResponse({
        sessionId: 'browser-flow',
        url: 'https://auth.example/start',
        polling: true,
        manualCodeSupported: true,
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onRefresh = vi.fn(async () => {});
    render(
      <OAuthCredentials providerId="openai-codex-oauth" summary={summary} onRefresh={onRefresh} />,
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.oauth.login' })));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'manual-code' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.oauth.submit' })));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(mocks.hanaFetch).toHaveBeenCalledTimes(2);
    const [callbackPath, callbackOptions] = mocks.hanaFetch.mock.calls[1];
    expect(callbackPath).toBe('/api/auth/oauth/callback');
    expect(JSON.parse(String((callbackOptions as RequestInit).body))).toEqual({
      sessionId: 'browser-flow',
      code: 'manual-code',
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
