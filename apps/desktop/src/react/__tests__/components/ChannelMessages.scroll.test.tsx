// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import fs from 'fs';
import path from 'path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelMessages } from '../../components/ChannelsPanel';
import * as hanaFetchModule from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

function setScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value) => { metrics.scrollTop = value; },
  });
}

describe('ChannelMessages scroll behavior', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useStore.setState({
      currentChannel: 'ch_crew',
      channels: [{
        id: 'ch_crew',
        name: 'crew',
        members: ['hanako'],
        lastMessage: '',
        lastSender: '',
        lastTimestamp: '',
        newMessageCount: 0,
        isDM: false,
      }],
      channelMessages: [
        { sender: 'user', timestamp: '2026-05-07 17:00:00', body: 'old' },
      ],
      channelHistory: {},
      agents: [],
      userName: 'user',
      userAvatarUrl: '',
      currentAgentId: 'hanako',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the reader position when a new message arrives while scrolled up', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 120 };
    const { container } = render(
      <div className="channel-messages">
        <ChannelMessages />
      </div>,
    );
    const scroller = container.querySelector('.channel-messages') as HTMLElement;
    setScrollMetrics(scroller, metrics);

    act(() => {
      metrics.scrollTop = 120;
      fireEvent.scroll(scroller);
      useStore.setState({
        channelMessages: [
          { sender: 'user', timestamp: '2026-05-07 17:00:00', body: 'old' },
          { sender: 'hanako', timestamp: '2026-05-07 17:01:00', body: 'new reply' },
        ],
      } as never);
    });

    expect(screen.getByText('new reply')).toBeInTheDocument();
    expect(metrics.scrollTop).toBe(120);
  });

  it('lands at the bottom immediately when channel history hydrates', () => {
    useStore.setState({
      channelMessages: [],
    } as never);
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 };
    const { container } = render(
      <div className="channel-messages">
        <ChannelMessages />
      </div>,
    );
    const scroller = container.querySelector('.channel-messages') as HTMLElement;
    setScrollMetrics(scroller, metrics);

    act(() => {
      useStore.setState({
        channelMessages: [
          { sender: 'user', timestamp: '2026-05-07 17:00:00', body: 'old' },
          { sender: 'hanako', timestamp: '2026-05-07 17:01:00', body: 'latest' },
        ],
      } as never);
    });

    expect(screen.getByText('latest')).toBeInTheDocument();
    expect(metrics.scrollTop).toBe(700);
  });

  it('loads an older page from the button and anchors the existing message', async () => {
    const metrics = { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 };
    useStore.setState({ channelHistory: { ch_crew: { before: 120, prepended: 0 } } });
    let anchorOffset = 40;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains('channel-messages')
        ? 40
        : this.textContent?.includes('old') ? anchorOffset - metrics.scrollTop : 0;
      return { top } as DOMRect;
    });
    const { container } = render(<div className="channel-messages"><ChannelMessages /></div>);
    const scroller = container.querySelector('.channel-messages') as HTMLElement;
    setScrollMetrics(scroller, metrics);
    const existingNode = screen.getByText('old');
    const request = vi.spyOn(hanaFetchModule, 'hanaFetch').mockResolvedValue(Response.json({
      messages: [{ sender: 'hanako', timestamp: '2026-05-07 16:59:00', body: 'earlier' }],
      nextBefore: null,
    }));

    await act(async () => {
      fireEvent.scroll(scroller);
      anchorOffset = 320;
      metrics.scrollHeight = 1280;
      fireEvent.click(screen.getByRole('button'));
    });

    expect(request).toHaveBeenCalledWith('/api/channels/ch_crew?limit=100&before=120', { throwOnHttpError: false });
    expect(screen.getByText('earlier')).toBeInTheDocument();
    expect(screen.getByText('old')).toBe(existingNode);
    expect(metrics.scrollTop).toBe(280);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not give the channel message container global smooth scrolling', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'apps/desktop/src/styles.css'), 'utf8');
    const block = css.match(/\.channel-messages\s*\{[^}]*\}/)?.[0] || '';

    expect(block).not.toMatch(/scroll-behavior\s*:\s*smooth/);
  });
});
