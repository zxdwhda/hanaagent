// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import { executeSlashViaWs } from '../../components/input/slash-commands';
import { sessionScopedValue } from '../../stores/session-slice';

const { sendMock, getWebSocketMock, ensureSessionMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getWebSocketMock: vi.fn(),
  ensureSessionMock: vi.fn(),
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: getWebSocketMock,
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession: ensureSessionMock,
}));

describe('executeSlashViaWs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getWebSocketMock.mockReturnValue({ readyState: WebSocket.OPEN, send: sendMock });
    useStore.setState({ currentSessionPath: '/session/a.jsonl', currentSessionId: null, pendingNewSession: false });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('carries the agent that owns this input box so the server never has to guess', async () => {
    await executeSlashViaWs('stop', 'agent-a', vi.fn(), vi.fn(), vi.fn())();

    expect(JSON.parse(sendMock.mock.calls[0][0])).toEqual({
      type: 'slash',
      text: '/stop',
      sessionPath: '/session/a.jsonl',
      agentId: 'agent-a',
    });
  });

  it('keeps the typed command line intact and still carries the identity', async () => {
    await executeSlashViaWs('reset', 'agent-b', vi.fn(), vi.fn(), vi.fn())('  /reset hard  ');

    expect(JSON.parse(sendMock.mock.calls[0][0])).toMatchObject({
      text: '/reset hard',
      agentId: 'agent-b',
    });
  });

  it('states an unknown identity explicitly instead of dropping the field', async () => {
    // Silently omitting the field is what made the server fall back to its own
    // lookup and then fail with a raw assertion; an explicit null keeps the
    // contract visible on the wire.
    await executeSlashViaWs('stop', null, vi.fn(), vi.fn(), vi.fn())();

    expect(JSON.parse(sendMock.mock.calls[0][0])).toHaveProperty('agentId', null);
  });

  it('waits for a new draft session before routing a /loop task', async () => {
    useStore.setState({ currentSessionPath: null, pendingNewSession: true, pendingDraftId: 'draft-1' });
    const identity = { sessionPath: '/session/b.jsonl', sessionId: 'sess_b', agentId: 'agent-b' };
    let complete = () => {};
    ensureSessionMock.mockImplementationOnce(() => new Promise((resolve) => {
      complete = () => {
        useStore.setState({ currentSessionPath: identity.sessionPath, currentSessionId: identity.sessionId });
        resolve(identity);
      };
    }));
    const clearComposer = vi.fn();
    const dispatch = executeSlashViaWs('loop', 'agent-a', vi.fn(), clearComposer, vi.fn())('/loop 检查构建状态');
    expect(ensureSessionMock).toHaveBeenCalledWith('draft-1');
    expect(sendMock).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
    complete();
    await dispatch;
    expect(JSON.parse(sendMock.mock.calls[0][0])).toEqual({
      type: 'slash', text: '/loop 检查构建状态', ...identity,
    });
    expect(clearComposer).toHaveBeenCalledWith('');
  });

  it('does not create a draft session just to query loop status', async () => {
    useStore.setState({ currentSessionPath: null, pendingNewSession: true, pendingDraftId: 'draft-2' });
    const clearComposer = vi.fn();
    await executeSlashViaWs('loop', 'agent-a', vi.fn(), clearComposer, vi.fn())('/loop status');
    expect(ensureSessionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
  });

  it('restores the command as a session draft if the socket closes while creating the session', async () => {
    useStore.setState({
      currentSessionPath: null, pendingNewSession: true, pendingDraftId: 'draft-3',
      drafts: {}, draftDocs: {},
    });
    const identity = { sessionPath: '/session/c.jsonl', sessionId: 'sess_c', agentId: 'agent-c' };
    ensureSessionMock.mockImplementationOnce(async () => {
      useStore.setState({ currentSessionPath: identity.sessionPath, currentSessionId: identity.sessionId, drafts: {} });
      return identity;
    });
    getWebSocketMock.mockReturnValueOnce({ readyState: WebSocket.OPEN, send: sendMock });
    getWebSocketMock.mockReturnValueOnce(null);
    const clearComposer = vi.fn();
    await executeSlashViaWs('loop', 'agent-a', vi.fn(), clearComposer, vi.fn())('/loop 检查构建状态');
    const latest = useStore.getState();
    expect(sessionScopedValue(latest, latest.drafts, identity.sessionPath)).toBe('/loop 检查构建状态');
    expect(sendMock).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
  });
});
