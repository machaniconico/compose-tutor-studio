import { useState } from 'react';
import { roleFitsTrackType, sliderUndoProps, textUndoProps, useStore } from '../../state/store';
import type { Track, TrackRole, TrackType } from '@cts/project-model';

/** Tiny text label for each track type (no emoji, no SVG — simple shapes). */
const TYPE_LABEL: Record<TrackType, string> = {
  instrument: '鍵',
  drum: '打',
  audio: '音',
  bus: '束',
  master: '主',
};

/**
 * Role choices: what part the track plays in the song (used by generators and
 * tutorials). A drum track can only play the drums; an instrument track the rest.
 */
const ROLE_OPTIONS: { value: TrackRole; label: string }[] = [
  { value: 'chords', label: 'コード(和音)' },
  { value: 'bass', label: 'ベース(低音)' },
  { value: 'melody', label: 'メロディ(主旋律)' },
  { value: 'drums', label: 'ドラム(リズム)' },
];

/** Confirmation shown before deleting a track that still has clips. */
export function removeTrackConfirmText(track: Track): string {
  return `「${track.name}」には ${track.clips.length} 個のクリップ(音を入れる枠)があります。トラックごと削除しますか？(「元に戻す」で取り消せます)`;
}

/** Left column listing tracks with volume + mute/solo controls and track management. */
export function TrackList() {
  const tracks = useStore((s) => s.project.tracks);
  const selectedTrackId = useStore((s) => s.editor.selectedTrackId);
  const selectTrack = useStore((s) => s.selectTrack);
  const selectClip = useStore((s) => s.selectClip);
  const setTrackVolume = useStore((s) => s.setTrackVolume);
  const toggleMute = useStore((s) => s.toggleMute);
  const toggleSolo = useStore((s) => s.toggleSolo);
  const addTrack = useStore((s) => s.addTrack);
  const removeTrack = useStore((s) => s.removeTrack);
  const duplicateTrack = useStore((s) => s.duplicateTrack);
  const renameTrack = useStore((s) => s.renameTrack);
  const moveTrack = useStore((s) => s.moveTrack);
  const setTrackColor = useStore((s) => s.setTrackColor);
  const setTrackRole = useStore((s) => s.setTrackRole);
  const [renaming, setRenaming] = useState<{ trackId: string; draft: string } | null>(null);

  const movableIds = tracks.filter((t) => t.type !== 'master').map((t) => t.id);

  const handleRemove = (track: Track): void => {
    if (track.clips.length > 0 && !window.confirm(removeTrackConfirmText(track))) return;
    removeTrack(track.id);
  };

  const finishRename = (): void => {
    if (!renaming) return;
    renameTrack(renaming.trackId, renaming.draft);
    setRenaming(null);
  };

  return (
    <nav className="track-list" aria-label="トラック一覧">
      <div className="track-list__add">
        <button type="button" className="mini-btn" onClick={() => addTrack('instrument')}>
          楽器トラックを追加
        </button>
        <button type="button" className="mini-btn" onClick={() => addTrack('drum')}>
          ドラムトラックを追加
        </button>
      </div>
      {tracks.map((track) => {
        const isSelected = track.id === selectedTrackId;
        const movableIndex = movableIds.indexOf(track.id);
        const isMaster = track.type === 'master';
        const isRenaming = renaming?.trackId === track.id;
        return (
          <div
            key={track.id}
            className={`track-row${isSelected ? ' is-selected' : ''}`}
            onClick={() => {
              selectTrack(track.id);
              const firstClip = track.clips[0];
              selectClip(firstClip ? firstClip.id : null);
            }}
          >
            <span
              className="track-row__swatch"
              style={{ background: track.color ?? 'var(--accent)' }}
              aria-hidden="true"
            />
            <div>
              {isRenaming ? (
                <input
                  className="track-row__rename"
                  autoFocus
                  value={renaming.draft}
                  aria-label={`${track.name} の新しい名前`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenaming({ trackId: track.id, draft: e.target.value })}
                  onBlur={finishRename}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter') finishRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <div className="track-row__name">{track.name}</div>
              )}
              <div className="track-row__type">
                <span className="badge">{TYPE_LABEL[track.type]}</span> {track.type}
              </div>
            </div>

            <div className="track-row__controls" onClick={(e) => e.stopPropagation()}>
              <input
                type="range"
                {...sliderUndoProps}
                min={0}
                max={1}
                step={0.01}
                value={track.volume}
                aria-label={`${track.name} 音量`}
                onChange={(e) => setTrackVolume(track.id, Number(e.target.value))}
              />
              <button
                type="button"
                className={`mini-btn${track.mute ? ' is-active' : ''}`}
                aria-pressed={track.mute}
                onClick={() => toggleMute(track.id)}
                title="ミュート"
              >
                M
              </button>
              <button
                type="button"
                className={`mini-btn${track.solo ? ' is-active' : ''}`}
                aria-pressed={track.solo}
                onClick={() => toggleSolo(track.id)}
                title="ソロ"
              >
                S
              </button>
            </div>

            {!isMaster && (
              <div className="track-row__actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label={`${track.name} を上へ`}
                  disabled={movableIndex <= 0}
                  onClick={() => moveTrack(track.id, movableIndex - 1)}
                >
                  上へ
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label={`${track.name} を下へ`}
                  disabled={movableIndex >= movableIds.length - 1}
                  onClick={() => moveTrack(track.id, movableIndex + 1)}
                >
                  下へ
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label={`${track.name} を複製`}
                  onClick={() => duplicateTrack(track.id)}
                >
                  複製
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label={`${track.name} の名前の変更`}
                  onClick={() => setRenaming({ trackId: track.id, draft: track.name })}
                >
                  名前の変更
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  aria-label={`${track.name} を削除`}
                  onClick={() => handleRemove(track)}
                >
                  削除
                </button>
                <input
                  type="color"
                  {...textUndoProps}
                  className="track-row__color"
                  value={track.color ?? '#7c83ff'}
                  aria-label={`${track.name} の色`}
                  title="トラックの色"
                  onChange={(e) => setTrackColor(track.id, e.target.value)}
                />
                <select
                  className="track-row__role"
                  value={track.role ?? ''}
                  aria-label={`${track.name} の役割`}
                  title="役割: 曲の中でこのトラックが受け持つパート"
                  onChange={(e) =>
                    setTrackRole(track.id, e.target.value === '' ? null : (e.target.value as TrackRole))
                  }
                >
                  <option value="">役割なし</option>
                  {ROLE_OPTIONS.filter((option) => roleFitsTrackType(option.value, track.type)).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
