import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  MIDI_IMPORT_UNCHANGED_ASSURANCE,
  ProjectMenuContent,
  withMidiImportUnchangedAssurance,
} from '../src/features/projectMenu/ProjectMenuContent';

describe('web project-menu erase boundary', () => {
  it('does not expose the native full-device erase entry on the web', () => {
    const html = renderToStaticMarkup(<ProjectMenuContent onDone={() => undefined} />);

    expect(html).not.toContain('この端末のデータをすべて消去');
  });

  it('adds the unchanged-song assurance to MIDI failures exactly once', () => {
    const first = withMidiImportUnchangedAssurance('MIDIファイルを読み込めませんでした。');

    expect(first).toBe(
      `MIDIファイルを読み込めませんでした。${MIDI_IMPORT_UNCHANGED_ASSURANCE}`,
    );
    expect(withMidiImportUnchangedAssurance(first)).toBe(first);
  });
});
