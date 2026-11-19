// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InteractiveCard } from '../../components/chat/InteractiveCard';
import { createLocalServerConnection } from '../../services/server-connection';
import { useStore } from '../../stores';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('registers cards for the source LAN session and embeds only the returned view URL', async () => {
  const local = createLocalServerConnection({ serverPort: '3210', serverToken: 'local-test-token' })!;
  const connection = {
    ...local,
    connectionId: 'lan:test-node:test-studio',
    kind: 'lan' as const,
    baseUrl: 'https://hana.example',
    wsUrl: 'wss://hana.example',
    credentialKind: 'device_credential' as const,
    trustState: 'lan' as const,
    token: 'lan-test-token',
  };
  const sessionPath = '/agent/sessions/card-test.jsonl';
  useStore.setState({
    activeServerConnection: connection,
    activeServerConnectionId: connection.connectionId,
    serverConnections: { [connection.connectionId]: connection },
    sessionLocatorsById: { sess_card_test: { path: sessionPath } },
  });

  const viewPath = `/api/cards/view/${'a'.repeat(32)}`;
  const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ viewPath }));
  vi.stubGlobal('fetch', fetchMock);
  render(<InteractiveCard
    sessionPath={sessionPath}
    block={{ type: 'interactive_card', cardId: 'demo_card', title: 'Demo', code: '<p>Hello</p>' }}
  />);

  const frame = await screen.findByTitle('Demo');
  expect(frame).toHaveAttribute('src', `https://hana.example${viewPath}`);
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');

  const [url, request] = fetchMock.mock.calls[0];
  expect(url).toBe('https://hana.example/api/cards/demo_card/render');
  expect(request.method).toBe('PUT');
  expect(new Headers(request.headers).get('authorization')).toBe('Bearer lan-test-token');
  expect(JSON.parse(String(request.body))).toMatchObject({ sessionId: 'sess_card_test', code: '<p>Hello</p>' });
});
