import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlaybackLifecycleControl } from '../src/features/transport/TransportBar';
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
    expect(html).toContain('連動コピーを減らして');
    expect(html).toContain('編集内容はそのままです');
    expect(html).not.toContain('出力先と端末の音量');
  });
});
