// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from '../src/features/common/Dialog';

describe('DOM test infrastructure', () => {
  it('renders Dialog and calls onClose once from the close button', () => {
    const onClose = vi.fn();
    render(
      <Dialog title="テストダイアログ" onClose={onClose}>
        <p id="first-test-body">本文</p>
      </Dialog>,
    );
    expect(screen.getByText('テストダイアログ')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cleans up the DOM between tests', () => {
    expect(document.getElementById('first-test-body')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).toBe('');
  });
});
