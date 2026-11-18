import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

import { hanaFetch } from '../../hooks/use-hana-fetch';
import {
  createLocalServerConnection,
  type ServerConnection,
} from '../../services/server-connection';

const t = (key: string) => key;

let executeDiary: typeof import('../../components/input/slash-commands').executeDiary;
let useStore: typeof import('../../stores').useStore;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('window', { i18n: { locale: 'zh' } });
  ({ executeDiary } = await import('../../components/input/slash-commands'));
  ({ useStore } = await import('../../stores'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function startDiary() {
  const addToast = vi.fn().mockReturnValue(42);
  const removeToast = vi.fn();
  const setInput = vi.fn();
  const setMenuOpen = vi.fn();
  const result = executeDiary(t, addToast, removeToast, setInput, setMenuOpen)();
  return { addToast, removeToast, setInput, setMenuOpen, result };
}

function pendingJob() {
  const [url, request] = vi.mocked(hanaFetch).mock.calls[0];
  expect(url).toBe('/api/diary/jobs');
  expect(request).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const { jobId } = JSON.parse(String(request?.body));
  expect(jobId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  return jobId;
}

function selectBackend() {
  const state = useStore.getState();
  const getState = vi.spyOn(useStore, 'getState');
  return (activeServerConnection: ServerConnection) => getState.mockReturnValue({
    ...state,
    activeServerConnection,
    activeServerConnectionId: null,
  });
}

describe('executeDiary', () => {
  it('checks the same job after a lost submission response and reports the confirmed write', async () => {
    vi.useFakeTimers();
    vi.mocked(hanaFetch)
      .mockRejectedValueOnce(new DOMException('request timed out', 'TimeoutError'))
      .mockResolvedValueOnce(Response.json({ error: 'not found' }, { status: 404 }))
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(Response.json({ status: 'succeeded', filePath: 'diary/2026-11-18.md' }));

    const { addToast, removeToast } = startDiary();
    await vi.advanceTimersByTimeAsync(6_000);

    const jobId = pendingJob();
    const requests = vi.mocked(hanaFetch).mock.calls;
    expect(requests.slice(1).map(([url, options]) => [url, options?.method])).toEqual([
      ['/api/diary/jobs/' + jobId, 'GET'],
      ['/api/diary/jobs/' + jobId, 'GET'],
      ['/api/diary/jobs/' + jobId, 'GET'],
    ]);
    expect(removeToast).toHaveBeenCalledExactlyOnceWith(42);
    expect(addToast).toHaveBeenLastCalledWith('slash.diaryDone', 'success', 5000);
  });

  it('runs diary writing in the background and reports progress through toast', async () => {
    vi.useFakeTimers();
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce(Response.json({ status: 'running' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ status: 'running' }))
      .mockResolvedValueOnce(Response.json({ status: 'succeeded', filePath: 'diary/2026-11-18.md' }));
    const { addToast, removeToast, setInput, setMenuOpen, result } = startDiary();
    const jobId = pendingJob();

    expect(result).toBeUndefined();
    expect(setInput).toHaveBeenCalledWith('');
    expect(setMenuOpen).toHaveBeenCalledWith(false);
    expect(addToast).toHaveBeenCalledWith('slash.diaryBusy', 'info', 0, {
      persistent: true,
      dedupeKey: 'slash-diary-progress:' + jobId,
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(removeToast).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(removeToast).toHaveBeenCalledExactlyOnceWith(42);
    expect(addToast).toHaveBeenLastCalledWith('slash.diaryDone', 'success', 5000);
  });

  it.each(['日记材料准备失败: simulated summary failure', undefined])(
    'cleans progress and reports terminal write failure with server detail %s',
    async (error) => {
      vi.mocked(hanaFetch)
        .mockResolvedValueOnce(Response.json({ status: 'running' }, { status: 202 }))
        .mockResolvedValueOnce(Response.json({ status: 'failed', error }));
      const { addToast, removeToast } = startDiary();

      await vi.waitFor(() => expect(removeToast).toHaveBeenCalledExactlyOnceWith(42));
      expect(addToast).toHaveBeenLastCalledWith(error || 'slash.diaryFailed', 'error', 6000);
    },
  );

  it.each(['日期格式错误', undefined])('reports a rejected submission with detail %s without polling', async (error) => {
    vi.mocked(hanaFetch).mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
    const { addToast, removeToast } = startDiary();

    await vi.waitFor(() => expect(removeToast).toHaveBeenCalledExactlyOnceWith(42));
    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenLastCalledWith(error || 'slash.diaryRejected', 'error', 6000);
  });

  it('warns after a bounded status wait when the result remains unknown without submitting again', async () => {
    vi.useFakeTimers();
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))
      .mockImplementation(async () => Response.json({ error: 'not found' }, { status: 404 }));
    const { addToast, removeToast } = startDiary();
    const jobId = pendingJob();

    await vi.advanceTimersByTimeAsync(149_999);
    expect(removeToast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(removeToast).toHaveBeenCalledExactlyOnceWith(42);
    expect(addToast).toHaveBeenLastCalledWith('slash.diaryUnknown', 'warning', 6000);
    const requests = vi.mocked(hanaFetch).mock.calls;
    const requestCount = requests.length;
    expect(requestCount).toBeGreaterThan(1);
    expect(requests.slice(1).every(([url, opts]) => url === '/api/diary/jobs/' + jobId && opts?.method === 'GET')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hanaFetch).toHaveBeenCalledTimes(requestCount);
  });

  it('polls the job if the accepted submission body stalls past the request timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(hanaFetch)
      .mockImplementationOnce(async (_url, opts) => {
        const response = Response.json({ status: 'running' }, { status: 202 });
        vi.spyOn(response, 'json').mockImplementation(() => new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
        }));
        return response;
      })
      .mockResolvedValueOnce(Response.json({ status: 'succeeded', filePath: 'diary/2026-11-18.md' }));
    const { addToast, removeToast } = startDiary();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(removeToast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hanaFetch).toHaveBeenNthCalledWith(2, '/api/diary/jobs/' + pendingJob(), expect.objectContaining({ method: 'GET' }));
    expect(removeToast).toHaveBeenCalledExactlyOnceWith(42);
    expect(addToast).toHaveBeenLastCalledWith('slash.diaryDone', 'success', 5000);
  });

  it('stops polling if the active server changes', async () => {
    vi.useFakeTimers();
    const state = useStore.getState();
    const getState = vi.spyOn(useStore, 'getState').mockReturnValue({
      ...state, activeServerConnection: null, activeServerConnectionId: null, serverPort: '12345',
    });
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce(Response.json({ status: 'running' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ status: 'running' }));
    const { addToast, removeToast } = startDiary();
    await vi.advanceTimersByTimeAsync(100);

    getState.mockReturnValue({
      ...state, activeServerConnection: null, activeServerConnectionId: null, serverPort: '12346',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(hanaFetch).toHaveBeenCalledTimes(2);
    expect(removeToast).toHaveBeenCalledExactlyOnceWith(42);
    expect(addToast).toHaveBeenLastCalledWith('slash.diaryUnknown', 'warning', 6000);
  });

  it.each(['POST', 'GET'])('ignores success from a %s that was in flight during a server switch', async (method) => {
    vi.useFakeTimers();
    const select = selectBackend();
    select(createLocalServerConnection({ serverPort: 12345 })!);
    const response = Promise.withResolvers<Response>();
    if (method === 'GET') {
      vi.mocked(hanaFetch).mockResolvedValueOnce(Response.json({ status: 'running' }, { status: 202 }));
    }
    vi.mocked(hanaFetch).mockReturnValueOnce(response.promise);
    const { addToast, removeToast } = startDiary();
    await vi.advanceTimersByTimeAsync(1);
    const requestCount = method === 'POST' ? 1 : 2;
    expect(hanaFetch).toHaveBeenCalledTimes(requestCount);

    select(createLocalServerConnection({ serverPort: 12346 })!);
    response.resolve(Response.json({ status: 'succeeded', filePath: 'diary/2026-11-18.md' }));
    await vi.advanceTimersByTimeAsync(1);

    expect(hanaFetch).toHaveBeenCalledTimes(requestCount);
    expect(removeToast).toHaveBeenCalledExactlyOnceWith(42);
    expect(addToast).toHaveBeenLastCalledWith('slash.diaryUnknown', 'warning', 6000);
  });

  it.each([
    { name: 'server ID', initial: {}, changed: { serverId: 'replacement-server' } },
    { name: 'server node ID', initial: {}, changed: { serverNodeId: 'replacement-node' } },
    { name: 'platform principal', initial: { platformAccountId: 'old-account' }, changed: { platformAccountId: 'new-account' } },
    { name: 'anonymous credential', initial: {}, changed: { token: 'replacement-token' } },
  ])('ignores in-flight success when the same connection ID rebinds its $name', async ({ initial, changed }) => {
    vi.useFakeTimers();
    const select = selectBackend();
    const original = {
      ...createLocalServerConnection({ serverPort: 12345, serverToken: 'old-token' })!,
      serverNodeId: 'old-node',
      ...initial,
    };
    select(original);
    const response = Promise.withResolvers<Response>();
    vi.mocked(hanaFetch)
      .mockResolvedValueOnce(Response.json({ status: 'running' }, { status: 202 }))
      .mockReturnValueOnce(response.promise);
    const { addToast, removeToast } = startDiary();
    await vi.advanceTimersByTimeAsync(1);
    expect(hanaFetch).toHaveBeenCalledTimes(2);

    select({ ...original, ...changed });
    response.resolve(Response.json({ status: 'succeeded', filePath: 'diary/2026-11-18.md' }));
    await vi.advanceTimersByTimeAsync(1);

    expect(hanaFetch).toHaveBeenCalledTimes(2);
    expect(removeToast).toHaveBeenCalledExactlyOnceWith(42);
    expect(addToast).toHaveBeenLastCalledWith('slash.diaryUnknown', 'warning', 6000);
  });

  it.each([{ userId: 'same-user' }, { platformAccountId: 'same-account' }])(
    'accepts terminal status after a token refresh for the same known principal %j',
    async (user) => {
      vi.useFakeTimers();
      const select = selectBackend();
      const original = { ...createLocalServerConnection({ serverPort: 12345, serverToken: 'old-token' })!, ...user };
      select(original);
      const response = Promise.withResolvers<Response>();
      vi.mocked(hanaFetch)
        .mockResolvedValueOnce(Response.json({ status: 'running' }, { status: 202 }))
        .mockReturnValueOnce(response.promise);
      const { addToast, removeToast } = startDiary();
      await vi.advanceTimersByTimeAsync(1);
      expect(hanaFetch).toHaveBeenCalledTimes(2);

      select({ ...original, token: 'refreshed-token' });
      response.resolve(Response.json({ status: 'succeeded', filePath: 'diary/2026-11-18.md' }));
      await vi.advanceTimersByTimeAsync(1);

      expect(removeToast).toHaveBeenCalledExactlyOnceWith(42);
      expect(addToast).toHaveBeenLastCalledWith('slash.diaryDone', 'success', 5000);
    },
  );

  it('creates a secure UUID when LAN browser access has no randomUUID API', async () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    vi.mocked(hanaFetch).mockResolvedValueOnce(
      Response.json({ status: 'succeeded', filePath: 'diary/2026-11-18.md' }),
    );
    const { addToast, removeToast } = startDiary();

    pendingJob();
    await vi.waitFor(() => expect(removeToast).toHaveBeenCalledExactlyOnceWith(42));
    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenLastCalledWith('slash.diaryDone', 'success', 5000);
  });
});
