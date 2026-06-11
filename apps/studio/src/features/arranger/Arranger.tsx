import { useStore } from '../../state/store';
import { pxPerBeat, timelineWidth } from '../timeline';

/**
 * Read-only arrangement overview: one lane per track, clips positioned by
 * startBeat / lengthBeats. Wave 2 makes clips draggable.
 */
export function Arranger() {
  const project = useStore((s) => s.project);
  const zoomX = useStore((s) => s.editor.zoomX);

  const lengthBeats = project.lengthBars * project.timeSignature[0];
  const ppb = pxPerBeat(zoomX);
  const laneWidth = timelineWidth(lengthBeats, zoomX);

  return (
    <div className="arranger">
      {project.tracks.map((track) => (
        <div className="arranger__row" key={track.id}>
          <span className="arranger__name">{track.name}</span>
          <div className="arranger__lane" style={{ width: laneWidth }}>
            {track.clips.map((clip) => (
              <div
                key={clip.id}
                className="arranger__clip"
                style={{
                  left: clip.startBeat * ppb,
                  width: Math.max(8, clip.lengthBeats * ppb),
                }}
                title={`${clip.type} クリップ`}
              >
                {clip.type}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
