import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  compileMusicalTime,
  MIN_EVENT_DURATION_BEATS,
} from '@cts/project-model';
import {
  formatMusicalPosition,
  formatLoopRangeSummary,
  isPunchEditingLocked,
  LoopRangeControl,
  LoopRangeDialog,
  LoopRangeEditor,
  MAX_PUNCH_ROLL_BEATS,
  PlaybackLifecycleControl,
  PunchRangeControl,
  PunchRangeDialog,
  PunchRangeEditor,
  RecordingOpenControl,
  validateLoopRangeDraft,
  validatePunchRangeDraft,
} from '../src/features/transport/TransportBar';
import { Dialog } from '../src/features/common/Dialog';
import type { TransportState } from '../src/state/store';

const stopped: TransportState = {
  phase: 'stopped',
  isPlaying: false,
  playbackRequestId: 1,
  audioIssue: null,
  positionBeat: 0,
  loopEnabled: false,
  loopStartBeat: 0,
  loopEndBeat: 4,
  punchEnabled: false,
  punchInBeat: 0,
  punchOutBeat: 4,
  punchPreRollBeats: 4,
  punchPostRollBeats: 4,
  metronome: false,
};

function renderTransport(transport: TransportState): string {
  return renderToStaticMarkup(
    <PlaybackLifecycleControl
      transport={transport}
      onPlay={() => undefined}
      onStop={() => undefined}
    />,
  );
}

type ElementProps = {
  children?: ReactNode;
  type?: string;
  onClick?: () => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
};

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<ElementProps>(node)) return null;
  if (predicate(node)) return node;
  return findElement(node.props.children, predicate);
}

describe('TransportBar playback lifecycle', () => {
  it('renders startup as busy and cancellable instead of already playing', () => {
    const html = renderTransport({
      ...stopped,
      phase: 'starting',
      playbackRequestId: 2,
    });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('開始を中止');
    expect(html).toContain('音声を開始しています。');
    expect(html).not.toContain('一時停止');
  });

  it('renders interruption guidance, then clears it on a successful retry', () => {
    let html = renderTransport({ ...stopped, playbackRequestId: 3, audioIssue: 'interrupted' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('出力先が変わった可能性があります');
    expect(html).toContain('編集内容はそのままです');

    html = renderTransport({
      ...stopped,
      phase: 'playing',
      isPlaying: true,
      playbackRequestId: 4,
    });
    expect(html).toContain('一時停止');
    expect(html).not.toContain('出力先が変わった可能性があります');
  });

  it('explains a schedule limit without blaming the audio device', () => {
    const html = renderTransport({
      ...stopped,
      playbackRequestId: 5,
      audioIssue: 'event-limit-exceeded',
    });
    expect(html).toContain('再生イベントが多すぎます');
    expect(html).toContain('オーディオクリップ');
    expect(html).toContain('連動コピーを減らして');
    expect(html).toContain('編集内容はそのままです');
    expect(html).not.toContain('出力先と端末の音量');
  });

  it.each([
    ['audio-asset-missing', '音声素材が見つかりません'],
    ['audio-asset-changed', '変更または破損'],
    ['audio-asset-unavailable', '保存領域へ現在アクセスできません'],
    ['audio-decode-failed', '音声素材を読み取れませんでした'],
    ['audio-resource-limit', '再生時の音声処理またはメモリ上限'],
  ] as const)('explains %s without generic device advice', (audioIssue, expected) => {
    const html = renderTransport({
      ...stopped,
      playbackRequestId: 6,
      audioIssue,
    });
    expect(html).toContain(expected);
    expect(html).toContain('編集内容はそのままです');
    expect(html).not.toContain('出力先と端末の音量');
  });
});

describe('TransportBar loop range', () => {
  const musicalTime = compileMusicalTime({
    lengthBeats: 8,
    tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
    timeSignatureMap: [{ id: 'signature', beat: 0, numerator: 4, denominator: 4 }],
  });

  it('keeps a compact readable range summary outside the dialog', () => {
    expect(formatLoopRangeSummary(musicalTime, 0, 4)).toBe('1.1–2.1');
    const html = renderToStaticMarkup(
      <LoopRangeControl
        enabled
        expanded={false}
        disabled={false}
        summary="1.1–2.1"
        onToggle={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain('class="transport-bar__loop-control"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('1.1–2.1');
    expect(html).not.toContain('type="number"');
  });

  it('renders labelled exact fields, inline errors, and shared modal semantics', () => {
    const onClose = vi.fn();
    const tree = LoopRangeDialog({
      projectLength: 8,
      startValue: '2',
      endValue: '6',
      error: '終了拍は開始拍より後にしてください。',
      onStartValueChange: () => undefined,
      onEndValueChange: () => undefined,
      onSave: () => undefined,
      onClose,
    });
    expect(tree.type).toBe(Dialog);
    tree.props.onClose();
    expect(onClose).toHaveBeenCalledOnce();

    const html = renderToStaticMarkup(tree);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('>開始拍<');
    expect(html).toContain('>終了拍<');
    expect(html).toContain(`step="${MIN_EVENT_DURATION_BEATS}"`);
    expect(html).toContain('data-modal-initial-focus="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('終了拍は開始拍より後にしてください。');
    expect(html).toContain('>キャンセル</button>');
    expect(html).toContain('>範囲を設定</button>');
  });

  it('routes Cancel and submit through the controlled editor actions', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const tree = LoopRangeEditor({
      projectLength: 8,
      startValue: '2',
      endValue: '6',
      error: null,
      onStartValueChange: () => undefined,
      onEndValueChange: () => undefined,
      onSave,
      onClose,
    });
    const cancel = findElement(tree, (element) => element.props.children === 'キャンセル');
    const form = findElement(tree, (element) => element.type === 'form');
    expect(cancel).not.toBeNull();
    expect(form).not.toBeNull();

    cancel?.props.onClick?.();
    const preventDefault = vi.fn();
    form?.props.onSubmit?.({ preventDefault });
    expect(onClose).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it.each([
    ['', '4', '開始拍と終了拍を入力してください。'],
    ['nope', '4', '拍位置は数値で入力してください。'],
    ['-1', '4', '範囲は0〜8拍の中で指定してください。'],
    ['0', '9', '範囲は0〜8拍の中で指定してください。'],
    ['4', '4', '終了拍は開始拍より後にしてください。'],
    ['2', String(2 + MIN_EVENT_DURATION_BEATS / 2), 'ループ範囲が短すぎます。'],
  ])('explains invalid draft %s..%s beside the fields', (start, end, message) => {
    expect(validateLoopRangeDraft(start, end, 8)).toEqual({ ok: false, error: message });
  });
});

describe('TransportBar Auto Punch range', () => {
  it('keeps the toggle and mapped range compact, textual, and accessible', () => {
    const html = renderToStaticMarkup(
      <PunchRangeControl
        enabled
        expanded={false}
        disabled={false}
        summary="1.1–2.1"
        preRollBeats={4}
        postRollBeats={2}
        onToggle={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain('transport-bar__punch-control');
    expect(html).toContain('aria-label="オートパンチ録音"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('現在 1.1–2.1');
    expect(html).toContain('プリロール4拍、ポストロール2拍');
    expect(html).not.toContain('type="number"');
  });

  it('locks both Punch actions when transport or lifecycle work owns editing', () => {
    expect(isPunchEditingLocked('stopped', false, null)).toBe(false);
    expect(isPunchEditingLocked('starting', false, null)).toBe(true);
    expect(isPunchEditingLocked('playing', false, null)).toBe(true);
    expect(isPunchEditingLocked('stopped', true, null)).toBe(true);
    expect(isPunchEditingLocked('stopped', false, 8)).toBe(true);

    const html = renderToStaticMarkup(
      <PunchRangeControl
        enabled={false}
        expanded={false}
        disabled
        summary="1.1–2.1"
        preRollBeats={4}
        postRollBeats={4}
        onToggle={() => undefined}
        onEdit={() => undefined}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it('renders four labelled fields, bounded integer rolls, errors, and modal semantics', () => {
    const onClose = vi.fn();
    const tree = PunchRangeDialog({
      projectLength: 8,
      punchInValue: '2',
      punchOutValue: '6',
      preRollValue: '4',
      postRollValue: '2',
      error: 'パンチアウト拍はパンチイン拍より後にしてください。',
      onPunchInValueChange: () => undefined,
      onPunchOutValueChange: () => undefined,
      onPreRollValueChange: () => undefined,
      onPostRollValueChange: () => undefined,
      onSave: () => undefined,
      onClose,
    });
    expect(tree.type).toBe(Dialog);
    tree.props.onClose();
    expect(onClose).toHaveBeenCalledOnce();

    const html = renderToStaticMarkup(tree);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('>パンチイン拍<');
    expect(html).toContain('>パンチアウト拍<');
    expect(html).toContain('>プリロール（拍）<');
    expect(html).toContain('>ポストロール（拍）<');
    expect(html).toContain(`max="${MAX_PUNCH_ROLL_BEATS}"`);
    expect(html).toContain('step="1"');
    expect(html).toContain('data-modal-initial-focus="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('パンチアウト拍はパンチイン拍より後にしてください。');
    expect(html).toContain('>パンチ範囲を設定</button>');
  });

  it('routes Cancel and unlocked submit while blocking a locked submit', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const props = {
      projectLength: 8,
      punchInValue: '2',
      punchOutValue: '6',
      preRollValue: '4',
      postRollValue: '2',
      error: null,
      onPunchInValueChange: () => undefined,
      onPunchOutValueChange: () => undefined,
      onPreRollValueChange: () => undefined,
      onPostRollValueChange: () => undefined,
      onSave,
      onClose,
    };
    const tree = PunchRangeEditor(props);
    const cancel = findElement(tree, (element) => element.props.children === 'キャンセル');
    const form = findElement(tree, (element) => element.type === 'form');
    cancel?.props.onClick?.();
    const preventDefault = vi.fn();
    form?.props.onSubmit?.({ preventDefault });

    expect(onClose).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();

    const lockedForm = findElement(
      PunchRangeEditor({ ...props, disabled: true }),
      (element) => element.type === 'form',
    );
    lockedForm?.props.onSubmit?.({ preventDefault: vi.fn() });
    expect(onSave).toHaveBeenCalledOnce();
  });

  it.each([
    ['', '4', '4', '4', 'パンチイン拍とパンチアウト拍を入力してください。'],
    ['nope', '4', '4', '4', 'パンチ位置は数値で入力してください。'],
    ['-1', '4', '4', '4', 'パンチ範囲は0〜8拍の中で指定してください。'],
    ['0', '9', '4', '4', 'パンチ範囲は0〜8拍の中で指定してください。'],
    ['4', '4', '4', '4', 'パンチアウト拍はパンチイン拍より後にしてください。'],
    [
      '2',
      String(2 + MIN_EVENT_DURATION_BEATS / 2),
      '4',
      '4',
      'パンチ範囲が短すぎます。',
    ],
    ['2', '6', '', '4', 'プリロールとポストロールを入力してください。'],
    ['2', '6', '1.5', '4', 'プリロールとポストロールは0〜16の整数拍で指定してください。'],
    ['2', '6', '-1', '4', 'プリロールとポストロールは0〜16の整数拍で指定してください。'],
    ['2', '6', '4', '17', 'プリロールとポストロールは0〜16の整数拍で指定してください。'],
  ])(
    'explains invalid Punch draft %s..%s with %s/%s roll',
    (punchIn, punchOut, preRoll, postRoll, message) => {
      expect(validatePunchRangeDraft(
        punchIn,
        punchOut,
        preRoll,
        postRoll,
        8,
      )).toEqual({ ok: false, error: message });
    },
  );

  it('accepts fractional Punch locators and inclusive 0/16 integer rolls', () => {
    expect(validatePunchRangeDraft('1.5', '6.25', '0', '16', 8)).toEqual({
      ok: true,
      punchInBeat: 1.5,
      punchOutBeat: 6.25,
      preRollBeats: 0,
      postRollBeats: 16,
    });
  });

  it('tells Punch users to arm an existing Audio Track with R', () => {
    const needsTarget = renderToStaticMarkup(
      <RecordingOpenControl
        armedTrackName={null}
        punchEnabled
        disabled={false}
        onOpen={() => undefined}
      />,
    );
    expect(needsTarget).toContain(
      'title="録音先: 既存のオーディオトラックをRで録音待機してください"',
    );
    expect(needsTarget).toContain('R待機が必要');
    expect(needsTarget).not.toContain('新規Track');

    const armed = renderToStaticMarkup(
      <RecordingOpenControl
        armedTrackName="Lead Vox"
        punchEnabled
        disabled={false}
        onOpen={() => undefined}
      />,
    );
    expect(armed).toContain('title="録音先: Lead Vox"');
    expect(armed).toContain('Lead Vox');
    expect(armed).not.toContain('R待機が必要');
  });
});

describe('formatMusicalPosition', () => {
  it('formats fixed-map projects exactly as before', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 8,
      tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
      timeSignatureMap: [{ id: 'signature', beat: 0, numerator: 4, denominator: 4 }],
    });

    expect(formatMusicalPosition(musicalTime, 0)).toBe('1.1');
    expect(formatMusicalPosition(musicalTime, 5)).toBe('2.2');
    expect(formatMusicalPosition(musicalTime, -1)).toBe('1.1');
    expect(formatMusicalPosition(musicalTime, Number.NaN)).toBe('1.1');
  });

  it('advances bars at mapped time-signature boundaries', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 14,
      tempoMap: [{ id: 'tempo', beat: 0, bpm: 120 }],
      timeSignatureMap: [
        { id: 'signature-four-four', beat: 0, numerator: 4, denominator: 4 },
        { id: 'signature-three-four', beat: 8, numerator: 3, denominator: 4 },
      ],
    });

    expect(formatMusicalPosition(musicalTime, 8)).toBe('3.1');
    expect(formatMusicalPosition(musicalTime, 10.99)).toBe('3.3');
    expect(formatMusicalPosition(musicalTime, 11)).toBe('4.1');
  });

  it('counts eighth-note beats in a 6/8 measure', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 6,
      tempoMap: [{ id: 'tempo-six-eight', beat: 0, bpm: 120 }],
      timeSignatureMap: [{
        id: 'signature-six-eight',
        beat: 0,
        numerator: 6,
        denominator: 8,
      }],
    });

    expect([0, 0.5, 1, 1.5, 2, 2.5, 3].map((beat) =>
      formatMusicalPosition(musicalTime, beat)))
      .toEqual(['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1']);
  });

  it('does not count quarter-note subdivisions as beats in a 4/2 measure', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 8,
      tempoMap: [{ id: 'tempo-four-two', beat: 0, bpm: 120 }],
      timeSignatureMap: [{
        id: 'signature-four-two',
        beat: 0,
        numerator: 4,
        denominator: 2,
      }],
    });

    expect(formatMusicalPosition(musicalTime, 1)).toBe('1.1');
    expect(formatMusicalPosition(musicalTime, 2)).toBe('1.2');
    expect(formatMusicalPosition(musicalTime, 7.99)).toBe('1.4');
    expect(formatMusicalPosition(musicalTime, 8)).toBe('2.1');
  });
});
