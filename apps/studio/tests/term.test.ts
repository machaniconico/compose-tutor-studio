// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Term, placeTooltip } from '../src/features/common/Term';
import { findGlossaryEntry } from '../src/features/tutorial/glossary';
import { useStore } from '../src/state/store';

describe('Term', () => {
  const initialDifficulty = useStore.getState().editor.difficulty;
  afterEach(() => {
    useStore.getState().setDifficulty(initialDifficulty);
  });

  it('shows a tooltip on focus and closes it with Escape', () => {
    render(createElement(Term, { id: 'swing' }, 'スウィング'));
    const el = screen.getByText('スウィング');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(el);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent ?? '').not.toBe('');
    expect(el.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays open while the pointer moves from the term onto the tooltip', () => {
    render(createElement(Term, { id: 'swing' }, 'スウィング'));
    const el = screen.getByText('スウィング');
    fireEvent.mouseEnter(el);
    const tip = screen.getByRole('tooltip');
    // The tooltip lives under body (so panel overflow cannot clip it) but is
    // still a React child of the term, so crossing onto it is not a leave.
    expect(tip.parentElement).toBe(document.body);
    fireEvent.mouseOut(el, { relatedTarget: tip });
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    fireEvent.mouseLeave(el);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes a hover-only tooltip with Escape even when focus is elsewhere', () => {
    render(
      createElement(
        'div',
        null,
        createElement('button', { type: 'button' }, 'ほか'),
        createElement(Term, { id: 'swing' }, 'スウィング'),
      ),
    );
    const other = screen.getByRole('button', { name: 'ほか' });
    other.focus();
    fireEvent.mouseEnter(screen.getByText('スウィング'));
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    fireEvent.keyDown(other, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps the tooltip open and swaps the text when the difficulty changes', () => {
    const entry = findGlossaryEntry('swing');
    if (!entry) throw new Error('glossary entry missing');
    useStore.getState().setDifficulty('beginner');
    render(createElement(Term, { id: 'swing' }, 'スウィング'));
    fireEvent.focus(screen.getByText('スウィング'));
    expect(screen.getByRole('tooltip').textContent).toBe(entry.label + entry.description.beginner);
    act(() => useStore.getState().setDifficulty('advanced'));
    expect(screen.getByRole('tooltip').textContent).toBe(entry.label + entry.description.advanced);
  });
});

describe('placeTooltip', () => {
  const viewport = { width: 1280, height: 900 };
  const tip = { width: 240, height: 60 };

  it('sits under the term, left-aligned, when there is room', () => {
    const p = placeTooltip({ left: 100, top: 100, width: 40, height: 16 }, tip, viewport);
    expect(p).toEqual({ left: 100, top: 120, above: false });
  });

  it('clamps to the right edge of the viewport', () => {
    const p = placeTooltip({ left: 1115, top: 100, width: 40, height: 16 }, tip, viewport);
    expect(p.left + tip.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(p.left).toBe(1280 - 8 - 240);
    expect(p.above).toBe(false);
  });

  it('never goes past the left edge, even for a tooltip wider than the viewport', () => {
    const p = placeTooltip({ left: -20, top: 100, width: 40, height: 16 }, tip, viewport);
    expect(p.left).toBe(8);
    const wide = placeTooltip({ left: 300, top: 100, width: 40, height: 16 }, { width: 2000, height: 60 }, viewport);
    expect(wide.left).toBe(8);
  });

  it('flips above the term when it would run off the bottom', () => {
    const p = placeTooltip({ left: 100, top: 870, width: 40, height: 16 }, tip, viewport);
    expect(p.above).toBe(true);
    expect(p.top).toBe(870 - 4 - 60);
    expect(p.top + tip.height).toBeLessThanOrEqual(870);
  });

  it('stays below when it fits neither side', () => {
    const p = placeTooltip({ left: 100, top: 30, width: 40, height: 16 }, { width: 240, height: 900 }, viewport);
    expect(p.above).toBe(false);
    expect(p.top).toBe(50);
  });
});
