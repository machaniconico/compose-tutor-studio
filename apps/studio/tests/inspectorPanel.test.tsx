import { PassThrough } from 'node:stream';
import type { ReactNode } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { InspectorPanel } from '../src/features/inspector/InspectorPanel';
import {
  __resetBridgeForTest,
  startLesson,
} from '../src/state/tutorialBridge';
import { installLocalStorage } from './localStorageStub';

beforeEach(() => {
  installLocalStorage();
  __resetBridgeForTest();
});

function renderAfterSuspense(node: ReactNode): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = '';
    const destination = new PassThrough();
    destination.setEncoding('utf8');
    destination.on('data', (chunk: string) => {
      html += chunk;
    });
    destination.on('end', () => resolve(html));
    destination.on('error', reject);

    const stream = renderToPipeableStream(node, {
      onAllReady: () => stream.pipe(destination),
      onError: reject,
    });
  });
}

describe('InspectorPanel controlled tabs', () => {
  it('renders an active lesson after the deferred tutorial panel is ready', async () => {
    startLesson('basic-1');

    const html = await renderAfterSuspense(
      <InspectorPanel activeTab="tutorial" onTabChange={() => undefined} />,
    );

    expect(html).toMatch(/id="right-tab-tutorial"[^>]*aria-selected="true"/);
    expect(html).toContain('aria-labelledby="right-tab-tutorial"');
    expect(html).toContain('音名と半音・全音');
    expect(html).toContain('ピアノロールに音を置いてみよう');
  });

  it('does not reveal a running lesson while another controlled tab is selected', async () => {
    startLesson('basic-1');

    const html = await renderAfterSuspense(
      <InspectorPanel activeTab="inspector" onTabChange={() => undefined} />,
    );

    expect(html).toMatch(/id="right-tab-inspector"[^>]*aria-selected="true"/);
    expect(html).not.toContain('ピアノロールに音を置いてみよう');
  });
});
