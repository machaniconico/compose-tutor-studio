import { describe, expect, it } from 'vitest';
import { selectedTrackWavFileName } from '../src/features/export/trackWavExport';

describe('selected Track WAV export', () => {
  it('sanitizes both names in the suggested filename', () => {
    expect(selectedTrackWavFileName('My/Project', 'Lead:One')).toBe(
      'My_Project - Lead_One.wav',
    );
    expect(selectedTrackWavFileName(
      'Mix\u0000🙂',
      'Lead\uD800\nVox',
    )).toBe('Mix_🙂 - Lead__Vox.wav');
  });
});
