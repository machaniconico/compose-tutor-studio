import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileMusicalTime } from '@cts/project-model';
import {
  formatMusicalPosition,
  PlaybackLifecycleControl,
} from '../src/features/transport/TransportBar';
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
    ['audio-resource-limit', '再生時のメモリ上限'],
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
