import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourceAudioFileError } from '../src/audio/sourceAudio';
import { VocalCutError } from '../src/audio/vocalCut';
import {
  VocalCutToolContent,
  vocalCutFailureMessage,
  vocalCutPreflightDurationSeconds,
} from '../src/features/vocalCut/VocalCutToolContent';

describe('VocalCutToolContent', () => {
  it('renders a labeled three-step local workflow with permanent quality limits', () => {
    const html = renderToStaticMarkup(
      <VocalCutToolContent onBusyChange={() => undefined} />,
    );
    expect(html).toContain('data-modal-initial-focus="true"');
    expect(html).toContain('音源を外部へ送信しません');
    expect(html).toContain('WAV / MP3 / M4A（AAC-LC） / AAC');
    expect(html).toContain('完全なボーカル除去やAIステム分離ではありません');
    expect(html).toContain('自分で利用・加工する権利を持つ音源だけ');
    expect(html).toContain('name="vocal-cut-preset"');
  });

  it('maps bounded file, mono, near-mono and duration failures to actionable copy', () => {
    expect(vocalCutFailureMessage(new SourceAudioFileError('file-too-large'))).toContain('128 MB');
    expect(vocalCutFailureMessage(new VocalCutError('stereo-required'))).toContain('ステレオ');
    expect(vocalCutFailureMessage(new VocalCutError('near-mono'))).toContain('伴奏まで消える');
    expect(vocalCutFailureMessage(new VocalCutError('duration-limit-exceeded'))).toContain('5分以内');
  });

  it('applies the user duration limit to presentation time without codec padding', () => {
    expect(
      vocalCutPreflightDurationSeconds(300, {
        format: 'mp3',
        mimeType: 'audio/mpeg',
        sampleRate: 44_100,
        channelCount: 2,
        decodeChannelCountUpperBound: 2,
        containerDurationSeconds: 300.068572,
        decodeDurationSeconds: 300.999,
      }),
    ).toBe(300);
    expect(
      vocalCutPreflightDurationSeconds(307.76386, {
        format: 'aac',
        mimeType: 'audio/aac',
        sampleRate: 44_100,
        channelCount: 2,
        decodeChannelCountUpperBound: 2,
        containerDurationSeconds: 300.025035,
        decodeDurationSeconds: 300.025035,
      }),
    ).toBe(300);
    expect(
      vocalCutPreflightDurationSeconds(300.001995, {
        format: 'm4a',
        mimeType: 'audio/mp4',
        sampleRate: 44_100,
        channelCount: 2,
        decodeChannelCountUpperBound: 2,
        containerDurationSeconds: 300.049706,
        decodeDurationSeconds: 300.071474,
      }),
    ).toBe(300);
  });
});
