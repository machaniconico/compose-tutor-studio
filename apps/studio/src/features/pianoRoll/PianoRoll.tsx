import { useStore } from '../../state/store';
import type { Clip, Track } from '@cts/project-model';
import { isInScale, midiNoteName, pitchClass, PITCH_CLASS } from '../../state/music';
import { pxPerBeat } from '../timeline';

const HIGH_MIDI = 84; // C6
const LOW_MIDI = 48; // C3
const ROW_HEIGHT = 14;

/** Find the currently selected MIDI clip across all tracks. */
function findSelectedClip(tracks: readonly Track[], clipId: string | null): Clip | null {
  if (!clipId) return null;
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

/**
 * Crude read-only piano roll. Renders the notes of the selected clip as
 * positioned divs on a beat/pitch grid. Scale rows are tinted; chord tones are
 * recolored. Wave 2 replaces the internals with an interactive editor.
 */
export function PianoRoll() {
  const project = useStore((s) => s.project);
  const editor = useStore((s) => s.editor);

  const clip = findSelectedClip(project.tracks, editor.selectedClipId);
  const ppb = pxPerBeat(editor.zoomX);
  const tonicPc = PITCH_CLASS[project.key];

  // Chord-tone set: pitch classes of the first chord (skeleton heuristic).
  const firstChord = project.chordTrack[0];
  const chordTonePcs = new Set(
    editor.chordToneHighlight && firstChord ? firstChord.notes.map((n) => pitchClass(n)) : [],
  );

  if (!clip || clip.type !== 'midi') {
    return <div className="empty-hint">MIDIクリップを選択するとノートが表示されます。</div>;
  }

  const notes = clip.notes ?? [];
  const rows: number[] = [];
  for (let midi = HIGH_MIDI; midi >= LOW_MIDI; midi -= 1) rows.push(midi);
  const height = rows.length * ROW_HEIGHT;

  return (
    <div className="piano-roll" style={{ height }}>
      {rows.map((midi, rowIndex) => {
        const inScale = editor.scaleSnap && isInScale(midi, tonicPc, project.scale);
        return (
          <div
            key={midi}
            className={`piano-roll__row${inScale ? ' is-scale-in' : ''}`}
            style={{ top: rowIndex * ROW_HEIGHT }}
          >
            <span className="piano-roll__row-label">{midiNoteName(midi)}</span>
          </div>
        );
      })}

      {notes.map((note) => {
        const rowIndex = HIGH_MIDI - note.pitch;
        if (rowIndex < 0 || rowIndex >= rows.length) return null;
        const isChordTone = chordTonePcs.has(pitchClass(note.pitch));
        return (
          <div
            key={note.id}
            className={`piano-roll__note${isChordTone ? ' is-chord-tone' : ''}`}
            style={{
              top: rowIndex * ROW_HEIGHT + 1,
              left: 44 + note.startBeat * ppb,
              width: Math.max(4, note.durationBeats * ppb - 2),
            }}
            title={`${midiNoteName(note.pitch)} vel ${note.velocity}`}
          />
        );
      })}
    </div>
  );
}
