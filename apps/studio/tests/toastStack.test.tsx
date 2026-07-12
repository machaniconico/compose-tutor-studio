import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastStack } from '../src/features/tutorial/ToastStack';
import {
  __resetBridgeForTest,
  pushToast,
} from '../src/state/tutorialBridge';

afterEach(() => __resetBridgeForTest());

describe('ToastStack announcements', () => {
  it('announces failures assertively and confirmations politely', () => {
    pushToast('書き出しに失敗しました。', 'error');
    pushToast('書き出しました。', 'success');
    const html = renderToStaticMarkup(<ToastStack />);

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
  });
});
