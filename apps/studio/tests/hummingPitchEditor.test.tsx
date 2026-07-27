import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HummingPitchEditor } from '../src/features/hummingToMelody/HummingPitchEditor';
import type { HummingPitchDraft } from '../src/features/hummingToMelody/hummingCandidateEditing';
import type {
  HummingPitchFrame,
  HummingWaveformBin,
} from '../src/audio/hummingTranscription';

const draft: HummingPitchDraft = {
  sourceDurationSeconds: 2,
  segments: [
    {
      id: 'stable-c4',
      startSeconds: 0.1,
      endSeconds: 0.7,
      midi: 60,
      confidence: 0.92,
    },
    {
      id: 'stable-d4',
      startSeconds: 0.8,
      endSeconds: 1.6,
      midi: 62,
      confidence: 0.58,
    },
  ],
};

const waveform: readonly HummingWaveformBin[] = [
  { startSeconds: 0, endSeconds: 1, min: -0.5, max: 0.7 },
  { startSeconds: 1, endSeconds: 2, min: -0.8, max: 0.4 },
];

const pitchFrames: readonly HummingPitchFrame[] = [
  {
    startSeconds: 0.1,
    endSeconds: 0.2,
    midi: 60.1,
    confidence: 0.9,
  },
  {
    startSeconds: 0.2,
    endSeconds: 0.3,
    midi: null,
    confidence: 0,
  },
  {
    startSeconds: 0.8,
    endSeconds: 0.9,
    midi: 61.9,
    confidence: 0.7,
  },
];

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof HummingPitchEditor>> = {},
): string {
  return renderToStaticMarkup(
    <HummingPitchEditor
      draft={draft}
      waveform={waveform}
      pitchFrames={pitchFrames}
      disabled={false}
      canUndo
      canRedo={false}
      onPitchChange={() => undefined}
      onMove={() => undefined}
      onResizeStart={() => undefined}
      onResizeEnd={() => undefined}
      onRemove={() => undefined}
      onSplit={() => undefined}
      onMergeNext={() => undefined}
      onUndo={() => undefined}
      onRedo={() => undefined}
      onReset={() => undefined}
      {...overrides}
    />,
  );
}

function segmentButtons(html: string): readonly string[] {
  return html.match(/<button[^>]*data-humming-segment-id="[^"]+"[^>]*>/g) ?? [];
}

describe('HummingPitchEditor accessibility rendering', () => {
  it('keeps SVG guides decorative and exposes pitch segments as one roving native-button tab stop', () => {
    const html = renderEditor();
    const svgs = html.match(/<svg[^>]*aria-hidden="true"[^>]*>/g) ?? [];
    const buttons = segmentButtons(html);

    expect(svgs).toHaveLength(2);
    expect(svgs.every((svg) => svg.includes('focusable="false"'))).toBe(true);
    expect(html).toContain('humming-pitch-editor__semitone-guide');
    expect(html).toContain('humming-pitch-editor__pitch-trace');
    expect(buttons).toHaveLength(2);
    expect(buttons.filter((button) => button.includes('tabindex="0"'))).toHaveLength(1);
    expect(buttons.filter((button) => button.includes('tabindex="-1"'))).toHaveLength(1);
    expect(buttons[0]).toContain('data-humming-segment-id="stable-c4"');
    expect(buttons[1]).toContain('data-humming-segment-id="stable-d4"');
    expect(buttons[0]).toContain('aria-pressed="true"');
    expect(buttons[1]).toContain('aria-pressed="false"');
    expect(html).toContain('信頼度 92%');
    expect(html).toContain('信頼度 58%');
    expect(html).toContain('is-confidence-high');
    expect(html).toContain('is-confidence-low');
  });

  it('publishes the complete keyboard contract, polite status, and timeline-only horizontal scroll boundary', () => {
    const html = renderEditor();

    expect(html).toContain(
      'aria-keyshortcuts="Control+Z Meta+Z Control+Shift+Z Meta+Shift+Z"',
    );
    expect(html).toContain(
      'aria-keyshortcuts="PageUp PageDown Home End ArrowUp ArrowDown ArrowLeft ArrowRight Alt+ArrowLeft Alt+ArrowRight Shift+ArrowLeft Shift+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Delete Backspace Control+Z Meta+Z Control+Shift+Z Meta+Shift+Z"',
    );
    expect(html).toContain(
      'role="status" aria-label="候補編集の状態" aria-live="polite" aria-atomic="true"',
    );
    expect(html).toContain('data-horizontal-scroll="timeline-only"');
    expect(html).toContain('overflow-x:auto');
    expect(html).toContain('<summary>キーボード操作</summary>');
    expect(html).toContain('Alt + 左右矢印は10ミリ秒');
    expect(html).toContain('Shift + 左右矢印で終了位置を変更');
  });

  it('renders a labeled inspector and preserves existing humming-result E2E labels', () => {
    const html = renderEditor();

    expect(html).toContain('<h4');
    expect(html).toContain('選択中の音');
    expect(html).toContain('<dt>音名</dt><dd>C4</dd>');
    expect(html).toContain('<dt>MIDI</dt><dd>60</dd>');
    expect(html).toContain('92%（高め）');
    expect(html).toContain('<dt>開始</dt><dd>0.100秒</dd>');
    expect(html).toContain('<dt>終了</dt><dd>0.700秒</dd>');
    expect(html).toContain('aria-label="1音目のMIDIノート"');
    expect(html).toContain('aria-label="1音目の開始秒"');
    expect(html).toContain('aria-label="1音目の終了秒"');
    expect(html).toMatch(
      /<input type="number" min="0" max="0.64" step="0.01" aria-label="1音目の開始秒"/,
    );
    expect(html).toMatch(
      /<input type="number" min="0.16" max="2" step="0.01" aria-label="1音目の終了秒"/,
    );
    expect(html).toContain('aria-label="1音目を1半音下げる"');
    expect(html).toContain('aria-label="1音目を1半音上げる"');
    expect(html).toContain('aria-label="1音目を中央で分割"');
    expect(html).toContain('aria-label="1音目を次の音と結合"');
    expect(html).toContain('aria-label="1音目を候補から外す"');
  });

  it('disables local history and editing controls without changing the accessibility structure', () => {
    const html = renderEditor({
      disabled: true,
      canUndo: true,
      canRedo: true,
    });

    expect(html).toMatch(
      /aria-label="候補の編集を元に戻す" disabled=""/,
    );
    expect(html).toMatch(
      /aria-label="候補の編集をやり直す" disabled=""/,
    );
    expect(html).toMatch(
      /aria-label="候補を解析結果に戻す" disabled=""/,
    );
    expect(segmentButtons(html).every((button) => button.includes('disabled=""'))).toBe(
      true,
    );
    expect(html).toMatch(/aria-label="1音目のMIDIノート"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="1音目を候補から外す" disabled=""/);
  });

  it('renders an actionable empty state and keeps the timeline keyboard reachable', () => {
    const html = renderEditor({
      draft: { sourceDurationSeconds: 2, segments: [] },
      canUndo: false,
      canRedo: false,
    });

    expect(segmentButtons(html)).toHaveLength(0);
    expect(html).toContain('編集できる音程区間はありません');
    expect(html).toMatch(
      /class="humming-pitch-editor__timeline"[^>]*tabindex="0"/,
    );
    expect(html).not.toContain('humming-pitch-editor__inspector');
    expect(html).toMatch(
      /aria-label="候補を解析結果に戻す" disabled=""/,
    );
  });

  it('guards invalid duration math and clamps every segment position to the timeline', () => {
    const guardedDraft = {
      sourceDurationSeconds: 0,
      segments: [
        {
          id: 'guarded',
          startSeconds: -1,
          endSeconds: 3,
          midi: 60,
          confidence: 0.5,
        },
      ],
    } as HummingPitchDraft;
    const html = renderEditor({
      draft: guardedDraft,
      waveform: [],
      pitchFrames: [],
    });
    const button = segmentButtons(html)[0] ?? '';

    expect(button).toContain('left:0%');
    expect(button).toContain('width:100%');
    expect(button).not.toMatch(/(?:NaN|Infinity)%/);
  });

  it('bounds long-source zoom inside the scroller and disables impossible midpoint splits', () => {
    const html = renderEditor({
      draft: {
        sourceDurationSeconds: 60,
        segments: [
          {
            id: 'short',
            startSeconds: 10,
            endSeconds: 10.1,
            midi: 64,
            confidence: 0.8,
          },
        ],
      },
      waveform: [],
      pitchFrames: [],
    });

    expect(html).toMatch(
      /class="humming-pitch-editor__timeline"[^>]*min-width:240rem/,
    );
    expect(html).toMatch(
      /aria-label="1音目を中央で分割"[^>]*disabled=""/,
    );
    expect(html).toContain('分割するには、音の長さが120ミリ秒以上必要です');
  });
});
