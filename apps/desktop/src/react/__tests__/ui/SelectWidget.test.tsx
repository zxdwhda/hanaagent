// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SelectWidget, type SelectOption } from '../../ui/SelectWidget';

const options: SelectOption[] = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
];

function openPopup(container: HTMLElement) {
  const trigger = container.querySelector('button') as HTMLButtonElement;
  act(() => {
    fireEvent.click(trigger);
  });
  return trigger;
}

function getPopup() {
  return document.body.querySelector('[data-select-widget-popup]');
}

describe('SelectWidget scroll-close scope', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps the popup inside a settings dialog even when the viewport has space below it', () => {
    const { container } = render(
      <div role="dialog" aria-modal="true">
        <SelectWidget options={options} value="a" onChange={() => {}} popupMinWidth={500} />
      </div>,
    );
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const trigger = container.querySelector('button') as HTMLButtonElement;
    dialog.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 120, width: 440, height: 295 });
    trigger.getBoundingClientRect = () => DOMRect.fromRect({ x: 290, y: 375, width: 170, height: 30 });
    openPopup(container);
    const popup = getPopup() as HTMLElement;
    expect(popup.style.bottom).toBe(`${window.innerHeight - 375 + 2}px`);
    expect(popup.style.maxHeight).toBe('253px');
    expect(popup.style.maxWidth).toBe('360px');
  });

  it('stays open when an unrelated container (not an ancestor of the trigger) scrolls', () => {
    const { container } = render(
      <SelectWidget options={options} value="a" onChange={() => {}} />,
    );
    openPopup(container);
    expect(getPopup()).not.toBeNull();

    // A container elsewhere in the document — e.g. a background keep-alive chat panel — that
    // does not contain the trigger. Its scroll event must not close this popup.
    const unrelated = document.createElement('div');
    document.body.appendChild(unrelated);

    act(() => {
      unrelated.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    expect(getPopup()).not.toBeNull();
    unrelated.remove();
  });

  it('closes when an ancestor of the trigger scrolls', () => {
    const { container } = render(
      <SelectWidget options={options} value="a" onChange={() => {}} />,
    );
    const trigger = openPopup(container);
    expect(getPopup()).not.toBeNull();

    const ancestor = trigger.parentElement as HTMLElement;
    act(() => {
      ancestor.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    expect(getPopup()).toBeNull();
  });

  it('closes when the document scrolls', () => {
    const { container } = render(
      <SelectWidget options={options} value="a" onChange={() => {}} />,
    );
    openPopup(container);
    expect(getPopup()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    expect(getPopup()).toBeNull();
  });
});
