import { describe, expect, it } from 'vitest';
import { MidiExportError } from '@cts/midi-io';
import { midiExportFailureMessage } from '../src/features/export/ExportMenuContent';

describe('MIDI export failure guidance', () => {
  it('explains how to resolve ambiguous same-pitch overlap', () => {
    expect(midiExportFailureMessage(new MidiExportError({
      code: 'overlapping-note',
      message: 'internal detail',
    }))).toBe(
      '同じ音程のノートが重なっているためMIDIを書き出せません。重なりを短くするか、1つのノートにまとめてください。',
    );
  });

  it('keeps bounded-export and unknown failures actionable', () => {
    expect(midiExportFailureMessage(new MidiExportError({
      code: 'event-limit-exceeded',
      message: 'internal detail',
    }))).toContain('ノート、ループ、または連動コピーを減らしてください');
    expect(midiExportFailureMessage(new Error('native failure')))
      .toBe('MIDIの書き出しに失敗しました。');
  });
});
