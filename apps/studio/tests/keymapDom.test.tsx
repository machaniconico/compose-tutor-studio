// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isEditableTarget, isTypingTarget } from '../src/features/common/keymap';

function within(html: string, selector: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  const el = host.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(selector);
  return el;
}

describe('editable-target guard', () => {
  it('treats every editable contenteditable form as editable, not just ="true"', () => {
    for (const value of ['', 'true', 'plaintext-only', 'TRUE']) {
      const el = within(`<div contenteditable="${value}"><span id="t">x</span></div>`, '#t');
      expect(isEditableTarget(el), value).toBe(true);
      expect(isTypingTarget(el), value).toBe(true);
    }
  });

  it('honours contenteditable="false" islands and plain elements', () => {
    const island = within(
      '<div contenteditable="true"><span contenteditable="false"><b id="t">x</b></span></div>',
      '#t',
    );
    expect(isEditableTarget(island)).toBe(false);
    expect(isEditableTarget(within('<div><span id="t">x</span></div>', '#t'))).toBe(false);
  });
});
