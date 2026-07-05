import { describe, expect, it } from 'vitest';
import { audioPlaybackFailureMessage } from '../src/audio/playback';

describe('audio playback failure messaging', () => {
  it('asks the user to retry when playback is blocked by permission or gesture policy', () => {
    const message = audioPlaybackFailureMessage(
      new DOMException('play() failed because the user did not interact first', 'NotAllowedError'),
    );

    expect(message).toContain('許可');
    expect(message).toContain('再生ボタン');
  });

  it('explains unsupported audio environments without exposing raw exception text', () => {
    const message = audioPlaybackFailureMessage(new ReferenceError('AudioContext is not defined'));

    expect(message).toContain('音声機能');
    expect(message).toContain('WebView2');
    expect(message).not.toContain('ReferenceError');
  });

  it('points persistent unknown failures to support diagnostics', () => {
    const message = audioPlaybackFailureMessage(new Error('device switch failed'));

    expect(message).toContain('出力先');
    expect(message).toContain('診断情報');
  });
});
