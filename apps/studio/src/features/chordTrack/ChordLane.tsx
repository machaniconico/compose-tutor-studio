import { useStore } from '../../state/store';
import { pxPerBeat, timelineWidth } from '../timeline';

/**
 * Chord strip rendered on a beat grid. Each chord chip is positioned by its
 * startBeat / durationBeats. Click selects; double-click is a placeholder for
 * the future inline chord editor.
 */
export function ChordLane() {
  const project = useStore((s) => s.project);
  const zoomX = useStore((s) => s.editor.zoomX);
  const selectedChordId = useStore((s) => s.editor.selectedChordId);
  const selectChord = useStore((s) => s.selectChord);
  const setInspectorContent = useStore((s) => s.setInspectorContent);

  const lengthBeats = project.lengthBars * project.timeSignature[0];
  const width = timelineWidth(lengthBeats, zoomX);
  const ppb = pxPerBeat(zoomX);

  return (
    <section className="chord-lane" aria-label="コードトラック">
      <div className="chord-lane__header">
        <strong>コードトラック</strong>
        <span>{project.chordTrack.length} 個</span>
      </div>
      <div className="chord-lane__grid" style={{ width }}>
        {project.chordTrack.map((chord) => {
          const isSelected = chord.id === selectedChordId;
          return (
            <button
              type="button"
              key={chord.id}
              className={`chord-chip${isSelected ? ' is-selected' : ''}`}
              style={{ left: chord.startBeat * ppb, width: chord.durationBeats * ppb }}
              onClick={() => {
                selectChord(chord.id);
                setInspectorContent(`chord:${chord.id}`);
              }}
              onDoubleClick={() => {
                // Placeholder: wave 2 opens an inline chord editor here.
                selectChord(chord.id);
              }}
              title={`${chord.symbol}${chord.degree ? ` (${chord.degree})` : ''}`}
            >
              <span className="chord-chip__symbol">{chord.symbol}</span>
              {chord.degree ? <span className="chord-chip__degree">{chord.degree}</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
