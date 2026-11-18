/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  testConnection: vi.fn(),
  saveProvider: vi.fn(),
}));

vi.mock('../../onboarding-actions', () => ({
  describeOnboardingError: (_error: unknown, fallback: string) => fallback,
  testConnection: (...args: unknown[]) => mocks.testConnection(...args),
  saveProvider: (...args: unknown[]) => mocks.saveProvider(...args),
}));

import { ProviderStep } from '../ProviderStep';

describe('ProviderStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('t', (key: string) => key);
    vi.stubGlobal('i18n', { locale: 'en' });
    mocks.testConnection.mockResolvedValue({ ok: true, text: 'ok' });
    mocks.saveProvider.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses a dropdown with the model settings provider presets and saves the selected provider', async () => {
    const goToStep = vi.fn();
    const onProviderReady = vi.fn();

    render(
      <ProviderStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        goToStep={goToStep}
        showError={vi.fn()}
        onProviderReady={onProviderReady}
      />,
    );

    expect(screen.queryByText('OpenRouter')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.selectPlaceholder' }));

    expect(screen.getByRole('button', { name: 'Kimi Coding Plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OpenRouter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xiaomi (MiMo)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Kimi Coding Plan' }));
    fireEvent.change(screen.getByPlaceholderText('onboarding.provider.keyPlaceholder'), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.test' }));

    await waitFor(() => {
      expect(mocks.testConnection).toHaveBeenCalledWith(expect.objectContaining({
        providerUrl: 'https://api.kimi.com/coding/',
        providerApi: 'anthropic-messages',
        apiKey: 'sk-test',
      }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.next' }));

    await waitFor(() => {
      expect(mocks.saveProvider).toHaveBeenCalledWith(expect.objectContaining({
        providerName: 'kimi-coding',
        providerUrl: 'https://api.kimi.com/coding/',
        providerApi: 'anthropic-messages',
        apiKey: 'sk-test',
      }));
    });
    expect(onProviderReady).toHaveBeenCalledWith('kimi-coding', 'https://api.kimi.com/coding/', 'anthropic-messages', 'sk-test');
    expect(goToStep).toHaveBeenCalledWith(3);
  });

  it('advances with an existing Codex OAuth login and no API key', async () => {
    const hanaFetch = vi.fn(async () => Response.json({
      'openai-codex': { loggedIn: true, modelCount: 1 },
    }));
    const goToStep = vi.fn();
    const onProviderReady = vi.fn();
    render(
      <ProviderStep
        preview={false}
        hanaFetch={hanaFetch}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        goToStep={goToStep}
        showError={vi.fn()}
        onProviderReady={onProviderReady}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.selectPlaceholder' }));
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI Codex (OAuth)' }));
    expect(screen.queryByPlaceholderText('onboarding.provider.keyPlaceholder')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.next' }));
    expect(onProviderReady).toHaveBeenCalledWith('openai-codex-oauth', '', 'openai-codex-responses', '');
    expect(goToStep).toHaveBeenCalledWith(3);
    expect(mocks.testConnection).not.toHaveBeenCalled();
    expect(mocks.saveProvider).not.toHaveBeenCalled();
  });

  it('lets a fresh setup complete browser OAuth before moving to model selection', async () => {
    vi.useFakeTimers();
    const hanaFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ 'openai-codex': { loggedIn: false, modelCount: 0 } }))
      .mockResolvedValueOnce(Response.json({
        sessionId: 'codex-flow', url: 'https://auth.example/start', polling: true, manualCodeSupported: true,
      }))
      .mockResolvedValueOnce(Response.json({ status: 'done' }))
      .mockResolvedValueOnce(Response.json({ 'openai-codex': { loggedIn: true, modelCount: 1 } }));
    const goToStep = vi.fn();
    render(
      <ProviderStep
        preview={false}
        hanaFetch={hanaFetch}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        goToStep={goToStep}
        showError={vi.fn()}
        onProviderReady={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.selectPlaceholder' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'OpenAI Codex (OAuth)' })));
    expect(screen.getByRole('button', { name: 'onboarding.provider.next' })).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.oauth.login' })));
    expect(screen.getByText('settings.oauth.waiting')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(hanaFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/auth/oauth/status', '/api/auth/oauth/start', '/api/auth/oauth/poll/codex-flow', '/api/auth/oauth/status',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.next' }));
    expect(goToStep).toHaveBeenCalledWith(3);
  });

  it('shows Codex login after the initial status request times out', async () => {
    vi.useFakeTimers();
    const hanaFetch = vi.fn((_path: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const showError = vi.fn();
    render(
      <ProviderStep
        preview={false}
        hanaFetch={hanaFetch}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        goToStep={vi.fn()}
        showError={showError}
        onProviderReady={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.provider.selectPlaceholder' }));
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI Codex (OAuth)' }));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(hanaFetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(showError).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'settings.oauth.login' })).toBeEnabled();
  });
});
