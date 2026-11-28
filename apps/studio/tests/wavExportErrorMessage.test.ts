import { describe, expect, it } from 'vitest';
import { ScheduleEventLimitError } from '@cts/project-model';
import { AudioAssetPlaybackError } from '../src/audio/audioAssetResolver';
import { AudioClipPlanLimitError } from '../src/audio/audioClipPlanner';
import { WavRenderLimitError } from '../src/audio/wav';
import { AudioWarpDspError } from '../src/audio/audioWarpDsp';
import { AudioWarpPlanError } from '../src/audio/audioWarpPlan';
import { wavExportFailureMessage, wavLevelsMessage } from '../src/features/export/ExportMenuContent';

describe('wavExportFailureMessage', () => {
  it.each([
    new ScheduleEventLimitError(10, 11),
    new AudioClipPlanLimitError(10, 11),
  ])('explains bounded schedule failures', (error) => {
    expect(wavExportFailureMessage(error)).toContain('再生イベントが多すぎ');
  });

  it('explains the bounded render duration', () => {
    expect(wavExportFailureMessage(new WavRenderLimitError(301, 1)))
      .toContain('5分以内');
  });

  it.each([
    ['asset-missing', '音声素材が見つからない'],
    ['asset-changed', '変更または破損'],
    ['asset-unavailable', '保存領域へアクセスできない'],
    ['resolver-unavailable', '保存領域へアクセスできない'],
    ['decode-failed', '音声素材を読み取れない'],
    ['resource-limit', 'メモリ上限'],
  ] as const)('explains %s asset failures', (code, expected) => {
    expect(wavExportFailureMessage(new AudioAssetPlaybackError(code, 'asset-1')))
      .toContain(expected);
  });

  it('sanitizes unrelated failures', () => {
    expect(wavExportFailureMessage(new Error('/private/source/path')))
      .toBe('WAVの書き出しに失敗しました。');
  });

  it.each([
    new AudioWarpPlanError('invalid-edit', 'clip-1', 'private detail'),
    new AudioWarpDspError('invalid-pcm', 'private detail'),
  ])('explains Elastic Audio failures without exposing internals', (error) => {
    const message = wavExportFailureMessage(error);
    expect(message).toContain('Elastic Audio');
    expect(message).toContain('元の音声素材');
    expect(message).not.toContain('private detail');
  });
});

describe('wavLevelsMessage', () => {
  const base = { appliedGainDb: 0, limitedByPeak: false, normalized: false, outputLoudness: 0 };

  it('shows the measured loudness with a plain explanation', () => {
    const text = wavLevelsMessage({ ...base, loudness: -13.6 });
    expect(text).toContain('約 -14 LUFS');
    expect(text).toContain('配信サービスはだいたい −14 LUFS に合わせます');
  });

  it('says so when the sound is too quiet to measure', () => {
    expect(wavLevelsMessage({ ...base, loudness: -Infinity })).toContain('測れません');
  });

  it('explains a peak-limited normalization as quieter than the target', () => {
    const text = wavLevelsMessage({
      loudness: -20, outputLoudness: -18, appliedGainDb: 2, limitedByPeak: true, normalized: true,
    });
    expect(text).toContain('約 -18 LUFS にそろえました');
    expect(text).toContain('目標の −14 LUFS より小さい');
  });

  it('says nothing was normalized when the loudness could not be measured', () => {
    const text = wavLevelsMessage({
      loudness: -Infinity, outputLoudness: -Infinity, appliedGainDb: 0, limitedByPeak: false, normalized: true,
    });
    expect(text).toContain('短すぎる・静かすぎるため測れず、音量はそろえていません');
  });

  it('shows the measured output loudness and no peak value when normalize is off', () => {
    const text = wavLevelsMessage({ ...base, loudness: -13.6 });
    expect(text).not.toMatch(/dBTP|ピーク/);
  });
});
