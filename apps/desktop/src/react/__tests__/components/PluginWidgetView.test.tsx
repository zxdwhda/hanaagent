// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginWidgetView } from '../../components/plugin/PluginWidgetView';

const surface = vi.hoisted(() => ({
  status: 'ready',
  iframeSrc: 'https://hana.example/api/plugins/plain-widget/widget?pluginIframeTicket=one',
  retry: vi.fn(),
}));

vi.mock('../../stores', () => ({
  useStore: vi.fn((select) => select({
    pluginWidgets: [{ pluginId: 'plain-widget', routeUrl: '/api/plugins/plain-widget/widget' }],
    currentAgentId: null,
  })),
}));

vi.mock('../../hooks/use-plugin-surface-url', () => ({
  usePluginSurfaceUrl: () => surface,
}));

describe('PluginWidgetView', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows a plain HTML widget without an SDK ready handshake', () => {
    vi.stubGlobal('t', (key: string) => key);
    vi.useFakeTimers();

    const { container } = render(<PluginWidgetView pluginId="plain-widget" />);
    const iframe = container.querySelector('iframe');
    expect(iframe?.style.opacity).toBe('0');
    act(() => vi.advanceTimersByTime(5000));
    expect(iframe?.style.opacity).toBe('1');
    expect(container.textContent).not.toContain('plugin.widget.loadFailed');
  });
});
