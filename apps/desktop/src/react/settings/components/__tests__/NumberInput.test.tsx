/** @vitest-environment jsdom */
import React, { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NumberInput } from '../NumberInput';

afterEach(cleanup);

it('lets users clear and replace a number while keeping the last valid setting', () => {
  const onChange = vi.fn();
  function Setting() {
    const [value, setValue] = useState(30);
    return <NumberInput value={value} onChange={(next) => { setValue(next); onChange(next); }} />;
  }
  const input = render(<Setting />).getByRole('spinbutton') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '' } });
  expect(input.value).toBe('');
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.blur(input);
  expect(input.value).toBe('30');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.change(input, { target: { value: '45' } });
  expect(input.value).toBe('45');
  expect(onChange).toHaveBeenCalledExactlyOnceWith(45);
});
