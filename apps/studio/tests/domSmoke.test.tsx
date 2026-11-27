// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { FatalRecoveryScreen } from '../src/platform/FatalRecoveryScreen';

it('renders FatalRecoveryScreen in jsdom and reacts to a click', async () => {
  const onReload = vi.fn();
  render(<FatalRecoveryScreen reason="render" onReload={onReload} />);

  expect(
    screen.getByRole('heading', { name: 'アプリを続行できませんでした' }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'アプリを再読み込み' }));
  expect(onReload).toHaveBeenCalledTimes(1);
});
