import { useEffect, useRef, useState } from 'react';
import type { Clip, Section, Track } from '@cts/project-model';
import {
  addSection,
  beatsPerBar,
  duplicateClip,
  resizeClip,
  setMidiClipLoop,
  unlinkClip,
  updateSection,
} from '@cts/project-model';
import { useStore } from '../../state/store';
import { pxPerBeat } from '../timeline';

/** Section types with Japanese labels and an accent class. */
const SECTION_TYPES: { type: Section['type']; label: string }[] = [
  { type: 'intro', label: 'イントロ' },
  { type: 'verse', label: 'Aメロ' },
  { type: 'preChorus', label: 'Bメロ' },
  { type: 'chorus', label: 'サビ' },
  { type: 'bridge', label: 'ブリッジ' },
  { type: 'outro', label: 'アウトロ' },
];

function typeLabel(type: Section['type']): string {
  return SECTION_TYPES.find((t) => t.type === type)?.label ?? type;
}

function normalizedProjectBars(maxBars: number): number {
  return Number.isFinite(maxBars) ? Math.max(1, Math.floor(maxBars)) : 1;
}

function integerInputValue(value: string | number, fallback: number): number {
  if (value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function locateClip(
  tracks: readonly Track[],
  clipId: string | null,
): { track: Track; clip: Clip } | null {
  if (!clipId) return null;
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export type ClipNotice =
  | {
      kind: 'error';
      message: string;
    }
  | {
      kind: 'status';
      message: string;
      expected:
        | { operation: 'duplicate'; clipId: string }
        | { operation: 'unlink'; clipId: string }
        | { operation: 'resize'; clipId: string; startBeat: number; lengthBeats: number }
        | { operation: 'loop'; clipId: string; loop: boolean };
    };

/** Whether a success notice still describes the current undoable Project state. */
export function isClipNoticeCurrent(
  project: { tracks: readonly Track[] },
  notice: ClipNotice,
): boolean {
  if (notice.kind === 'error') return true;
  const located = locateClip(project.tracks, notice.expected.clipId);
  if (!located) return false;

  switch (notice.expected.operation) {
    case 'duplicate':
      return true;
    case 'unlink':
      return located.clip.aliasOf === undefined;
    case 'resize':
      return (
        located.clip.startBeat === notice.expected.startBeat &&
        located.clip.lengthBeats === notice.expected.lengthBeats
      );
    case 'loop':
      return located.clip.type === 'midi' && located.clip.loop === notice.expected.loop;
  }
}

export function clipOperationMessage(reason: string): string {
  switch (reason) {
    case 'invalid-destination':
    case 'invalid-range':
      return 'クリップが曲の外へ出るため変更できません。開始位置か長さを短くしてください。';
    case 'content-out-of-range':
      return '後半に音があるため短くできません。先に後半の音を移動または削除してください。';
    case 'linked-length-locked':
      return '連動コピーの長さは元クリップと共通です。先に「連動を解除」してください。';
    case 'linked-dependents':
      return '連動コピーがあるため元クリップだけの長さは変えられません。コピーの連動を解除してください。';
    case 'clip-limit':
      return 'このトラックにはこれ以上クリップを追加できません。';
    case 'event-limit':
      return 'このコピーで再生イベントが多くなりすぎるため追加できません。ノート、ドラム、またはコピーを減らしてください。';
    default:
      return 'クリップを安全に変更できませんでした。曲は変更されていません。';
  }
}

/** Latest start bar that keeps the section's current length inside the project. */
export function sectionStartMax(lengthBars: number, maxBars: number): number {
  const projectBars = normalizedProjectBars(maxBars);
  const safeLength = Math.max(
    1,
    Math.min(projectBars, integerInputValue(lengthBars, 1)),
  );
  return projectBars - safeLength;
}

/** Latest length that keeps a section at its current start inside the project. */
export function sectionLengthMax(startBar: number, maxBars: number): number {
  const projectBars = normalizedProjectBars(maxBars);
  const safeStart = Math.max(
    0,
    Math.min(projectBars - 1, integerInputValue(startBar, 0)),
  );
  return projectBars - safeStart;
}

export function clampSectionStart(
  value: string | number,
  lengthBars: number,
  maxBars: number,
): number {
  const maximum = sectionStartMax(lengthBars, maxBars);
  return Math.max(0, Math.min(maximum, integerInputValue(value, 0)));
}

export function clampSectionLength(
  value: string | number,
  startBar: number,
  maxBars: number,
): number {
  const maximum = sectionLengthMax(startBar, maxBars);
  return Math.max(1, Math.min(maximum, integerInputValue(value, 1)));
}

/**
 * Section arranger: blocks on a bar timeline. Add a section with a type
 * picker, edit name / type / start / length, or remove. Blocks are colored
 * by type via CSS classes.
 */
export function Arranger() {
  const project = useStore((s) => s.project);
  const zoomX = useStore((s) => s.editor.zoomX);
  const applyProjectChange = useStore((s) => s.applyProjectChange);
  const selectedClipId = useStore((s) => s.editor.selectedClipId);
  const selectTrack = useStore((s) => s.selectTrack);
  const selectClip = useStore((s) => s.selectClip);
  const setActiveView = useStore((s) => s.setActiveView);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [clipNotice, setClipNotice] = useState<ClipNotice | null>(null);
  const [focusClipId, setFocusClipId] = useState<string | null>(null);
  const clipButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusSectionTarget, setFocusSectionTarget] = useState<string | 'add' | null>(null);
  const sectionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const addSectionButtonRef = useRef<HTMLButtonElement>(null);

  const bpb = beatsPerBar(project.timeSignature);
  const ppb = pxPerBeat(zoomX);
  const barPx = bpb * ppb;
  const laneWidth = project.lengthBars * barPx;
  const clipTracks = project.tracks.filter(
    (track) => track.type !== 'master' && track.clips.length > 0,
  );
  const selected = locateClip(project.tracks, selectedClipId);

  useEffect(() => {
    setClipNotice((current) =>
      current && !isClipNoticeCurrent(project, current) ? null : current,
    );
  }, [project]);

  useEffect(() => {
    if (!focusClipId) return;
    const button = clipButtonRefs.current.get(focusClipId);
    if (!button?.isConnected) return;
    button.focus();
    setFocusClipId(null);
  }, [focusClipId, project]);

  useEffect(() => {
    if (!focusSectionTarget) return;
    const button =
      focusSectionTarget === 'add'
        ? addSectionButtonRef.current
        : sectionButtonRefs.current.get(focusSectionTarget);
    if (!button?.isConnected) return;
    button.focus();
    setFocusSectionTarget(null);
  }, [focusSectionTarget, project.sections]);

  const onAdd = () => {
    const startBar = project.sections.reduce(
      (max, s) => Math.max(max, s.startBar + s.lengthBars),
      0,
    );
    const clampedStart = Math.min(startBar, Math.max(0, project.lengthBars - 1));
    const length = Math.min(4, project.lengthBars - clampedStart) || 1;
    applyProjectChange((p) =>
      addSection(p, {
        name: '新しいセクション',
        type: 'verse',
        startBar: clampedStart,
        lengthBars: length,
      }),
    );
  };

  const onRemove = (id: string) => {
    const index = project.sections.findIndex((section) => section.id === id);
    const focusAfterDelete =
      project.sections[index + 1]?.id ?? project.sections[index - 1]?.id ?? 'add';
    const committed = applyProjectChange((p) => ({
      ...p,
      sections: p.sections.filter((s) => s.id !== id),
    }));
    if (!committed) return;
    if (editingId === id) setEditingId(null);
    setFocusSectionTarget(focusAfterDelete);
  };

  const onPatch = (id: string, patch: Partial<Omit<Section, 'id'>>) => {
    applyProjectChange((p) => updateSection(p, id, patch));
  };

  const editing = editingId ? project.sections.find((s) => s.id === editingId) ?? null : null;

  const selectArrangerClip = (track: Track, clip: Clip): void => {
    selectTrack(track.id);
    selectClip(clip.id);
    setClipNotice(null);
  };

  const duplicateSelected = (linked: boolean): void => {
    if (!selected) return;
    const current = useStore.getState().project;
    const outcome = duplicateClip(current, selected.clip.id, {
      startBeat: selected.clip.startBeat + selected.clip.lengthBeats,
      linked,
    });
    if (!outcome.ok) {
      setClipNotice({
        kind: 'error',
        message: clipOperationMessage(outcome.reason),
      });
      return;
    }
    const committed = applyProjectChange((latest) =>
      latest === current ? outcome.project : latest,
    );
    if (!committed) {
      setClipNotice({ kind: 'error', message: clipOperationMessage('failed') });
      return;
    }
    selectTrack(selected.track.id);
    selectClip(outcome.clipId);
    setFocusClipId(outcome.clipId);
    setClipNotice({
      kind: 'status',
      message: linked
        ? '連動コピーを右隣に作りました。どちらを編集しても同じ素材へ反映されます。'
        : '独立コピーを右隣に作りました。元とは別々に編集できます。',
      expected: { operation: 'duplicate', clipId: outcome.clipId },
    });
  };

  const unlinkSelected = (): void => {
    if (!selected?.clip.aliasOf) return;
    const current = useStore.getState().project;
    const outcome = unlinkClip(current, selected.clip.id);
    if (!outcome.ok) {
      setClipNotice({ kind: 'error', message: clipOperationMessage(outcome.reason) });
      return;
    }
    const committed = applyProjectChange((latest) =>
      latest === current ? outcome.project : latest,
    );
    if (!committed) {
      setClipNotice({ kind: 'error', message: clipOperationMessage('failed') });
      return;
    }
    setFocusClipId(selected.clip.id);
    setClipNotice({
      kind: 'status',
      message: '連動を解除しました。このクリップだけを変えられます。',
      expected: { operation: 'unlink', clipId: selected.clip.id },
    });
  };

  const resizeSelected = (startBeat: number, lengthBeats: number): boolean => {
    if (!selected) return false;
    const current = useStore.getState().project;
    const outcome = resizeClip(current, selected.clip.id, { startBeat, lengthBeats });
    if (!outcome.ok) {
      setClipNotice({
        kind: 'error',
        message: clipOperationMessage(outcome.reason),
      });
      return false;
    }
    const committed = applyProjectChange((latest) =>
      latest === current ? outcome.project : latest,
    );
    if (!committed) {
      setClipNotice({ kind: 'error', message: clipOperationMessage('failed') });
      return false;
    }
    setClipNotice({
      kind: 'status',
      message: 'クリップの配置を更新しました。',
      expected: {
        operation: 'resize',
        clipId: selected.clip.id,
        startBeat,
        lengthBeats,
      },
    });
    return true;
  };

  const setSelectedLoop = (loop: boolean): void => {
    if (!selected || selected.clip.type !== 'midi') return;
    const current = useStore.getState().project;
    const outcome = setMidiClipLoop(current, selected.clip.id, loop);
    if (!outcome.ok) {
      setClipNotice({ kind: 'error', message: clipOperationMessage(outcome.reason) });
      return;
    }
    const committed = applyProjectChange((latest) =>
      latest === current ? outcome.project : latest,
    );
    if (!committed) {
      setClipNotice({ kind: 'error', message: clipOperationMessage('failed') });
      return;
    }
    setClipNotice({
      kind: 'status',
      message: loop
        ? 'このクリップだけ、素材を末尾まで繰り返します。'
        : 'このクリップの素材は1回だけ再生します。',
      expected: { operation: 'loop', clipId: selected.clip.id, loop },
    });
  };

  return (
    <div className="arranger">
      <div className="arranger__toolbar">
        <strong>セクション（曲の構成）</strong>
        <button ref={addSectionButtonRef} type="button" onClick={onAdd}>
          ＋ セクションを追加
        </button>
      </div>

      <div className="arranger__timeline" style={{ width: laneWidth }}>
        {/* bar guides */}
        {Array.from({ length: project.lengthBars + 1 }, (_, bar) => (
          <div key={`bar-${bar}`} className="arranger__bar" style={{ left: bar * barPx }}>
            {bar % 4 === 0 ? <span className="arranger__bar-num">{bar + 1}</span> : null}
          </div>
        ))}

        {project.sections.map((section) => (
          <button
            type="button"
            key={section.id}
            ref={(button) => {
              if (button) sectionButtonRefs.current.set(section.id, button);
              else sectionButtonRefs.current.delete(section.id);
            }}
            className={`arranger__section is-${section.type}${editingId === section.id ? ' is-editing' : ''}`}
            style={{ left: section.startBar * barPx, width: section.lengthBars * barPx }}
            onClick={() => setEditingId(section.id === editingId ? null : section.id)}
            aria-expanded={editingId === section.id}
            aria-controls={editingId === section.id ? 'arranger-section-editor' : undefined}
            title={`${section.name} / ${typeLabel(section.type)}`}
          >
            <span className="arranger__section-name">{section.name}</span>
            <span className="arranger__section-type">{typeLabel(section.type)}</span>
          </button>
        ))}
      </div>

      <div className="arranger__clip-area" aria-label="トラック別クリップ配置">
        <div className="arranger__clip-canvas" style={{ width: laneWidth + 96 }}>
          {clipTracks.map((track) => (
            <div className="arranger__row" key={track.id}>
              <span className="arranger__name" title={track.name}>
                {track.name}
              </span>
              <div
                className="arranger__lane"
                style={{ width: laneWidth, flexBasis: laneWidth }}
                role="group"
                aria-label={`${track.name}のクリップ`}
              >
                {Array.from({ length: project.lengthBars + 1 }, (_, bar) => (
                  <span
                    key={bar}
                    aria-hidden="true"
                    className="arranger__lane-bar"
                    style={{ left: bar * barPx }}
                  />
                ))}
                {track.clips.map((clip, index) => (
                  <button
                    type="button"
                    key={clip.id}
                    ref={(button) => {
                      if (button) clipButtonRefs.current.set(clip.id, button);
                      else clipButtonRefs.current.delete(clip.id);
                    }}
                    className={`arranger__clip${selectedClipId === clip.id ? ' is-selected' : ''}${clip.aliasOf ? ' is-linked' : ''}`}
                    style={{
                      left: clip.startBeat * ppb,
                      width: clip.lengthBeats * ppb,
                    }}
                    aria-pressed={selectedClipId === clip.id}
                    aria-label={`${track.name}、クリップ${index + 1}、${(clip.startBeat / bpb).toFixed(1)}小節から${(clip.lengthBeats / bpb).toFixed(1)}小節${clip.aliasOf ? '、連動コピー' : ''}`}
                    onClick={() => selectArrangerClip(track, clip)}
                    onDoubleClick={() => {
                      selectArrangerClip(track, clip);
                      if (clip.type === 'drum') setActiveView('drums');
                      else if (clip.type === 'midi') setActiveView('pianoRoll');
                    }}
                  >
                    <span>{clip.aliasOf ? '連動' : `Clip ${index + 1}`}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {selected ? (
        <ClipEditor
          key={selected.clip.id}
          clip={selected.clip}
          trackName={selected.track.name}
          beatsInBar={bpb}
          projectLengthBeats={project.lengthBars * bpb}
          onCommit={resizeSelected}
          onDuplicate={(linked) => duplicateSelected(linked)}
          onUnlink={unlinkSelected}
          onLoopChange={setSelectedLoop}
        />
      ) : (
        <p className="empty-hint">
          クリップを選ぶと、配置、独立コピー、連動コピーを編集できます。
        </p>
      )}
      {clipNotice ? (
        <p
          className={`arranger__clip-notice${clipNotice.kind === 'error' ? ' is-error' : ''}`}
          role={clipNotice.kind === 'error' ? 'alert' : 'status'}
        >
          {clipNotice.message}
        </p>
      ) : null}

      {editing ? (
        <SectionEditor
          id="arranger-section-editor"
          section={editing}
          maxBars={project.lengthBars}
          onPatch={(patch) => onPatch(editing.id, patch)}
          onRemove={() => onRemove(editing.id)}
          onClose={() => {
            setEditingId(null);
            setFocusSectionTarget(editing.id);
          }}
        />
      ) : (
        <p className="empty-hint">
          セクションをクリックすると編集できます。イントロは控えめに、サビは要素を増やすと盛り上がります。
        </p>
      )}
    </div>
  );
}

function ClipEditor(props: {
  clip: Clip;
  trackName: string;
  beatsInBar: number;
  projectLengthBeats: number;
  onCommit: (startBeat: number, lengthBeats: number) => boolean;
  onDuplicate: (linked: boolean) => void;
  onUnlink: () => void;
  onLoopChange: (loop: boolean) => void;
}) {
  const {
    clip,
    trackName,
    beatsInBar,
    projectLengthBeats,
    onCommit,
    onDuplicate,
    onUnlink,
    onLoopChange,
  } = props;
  const [startBars, setStartBars] = useState(String(clip.startBeat / beatsInBar));
  const [lengthBars, setLengthBars] = useState(String(clip.lengthBeats / beatsInBar));

  useEffect(() => setStartBars(String(clip.startBeat / beatsInBar)), [clip.startBeat, beatsInBar]);
  useEffect(
    () => setLengthBars(String(clip.lengthBeats / beatsInBar)),
    [clip.lengthBeats, beatsInBar],
  );

  const commit = (): void => {
    const start = Number(startBars) * beatsInBar;
    const length = Number(lengthBars) * beatsInBar;
    if (!onCommit(start, length)) {
      setStartBars(String(clip.startBeat / beatsInBar));
      setLengthBars(String(clip.lengthBeats / beatsInBar));
    }
  };
  const duplicateStart = clip.startBeat + clip.lengthBeats;
  const canDuplicate = duplicateStart + clip.lengthBeats <= projectLengthBeats;

  return (
    <section className="arranger__clip-editor" aria-label="選択クリップの編集">
      <div className="arranger__clip-summary">
        <strong>{trackName}</strong>
        <span>{clip.aliasOf ? '連動コピー' : '独立クリップ'}</span>
      </div>
      <div className="arranger__editor-row">
        <label>
          <span>開始位置（小節・0から）</span>
          <input
            type="number"
            min={0}
            step={1}
            value={startBars}
            onChange={(event) => setStartBars(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
            }}
          />
        </label>
        <label>
          <span>長さ（小節）</span>
          <input
            type="number"
            min={1}
            step={1}
            value={lengthBars}
            disabled={clip.aliasOf !== undefined}
            onChange={(event) => setLengthBars(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
            }}
          />
        </label>
      </div>
      {clip.type === 'midi' ? (
        <label className="arranger__loop-toggle">
          <input
            type="checkbox"
            checked={clip.loop}
            onChange={(event) => onLoopChange(event.target.checked)}
          />
          <span>素材をクリップ末尾まで繰り返す</span>
        </label>
      ) : null}
      <div className="arranger__clip-actions">
        <button type="button" disabled={!canDuplicate} onClick={() => onDuplicate(false)}>
          独立コピーを右へ
        </button>
        <button type="button" disabled={!canDuplicate} onClick={() => onDuplicate(true)}>
          連動コピーを右へ
        </button>
        {clip.aliasOf ? (
          <button type="button" onClick={onUnlink}>
            連動を解除
          </button>
        ) : null}
      </div>
      {!canDuplicate ? (
        <p className="arranger__timing-hint">
          右側に同じ長さの空きがありません。先に長さを短くするか、開始位置を移動してください。
        </p>
      ) : (
        <p className="arranger__timing-hint">
          連動コピーは同じ素材を共有します。変化を付ける時は連動を解除してください。
        </p>
      )}
    </section>
  );
}

function SectionEditor(props: {
  id: string;
  section: Section;
  maxBars: number;
  onPatch: (patch: Partial<Omit<Section, 'id'>>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { id, section, maxBars, onPatch, onRemove, onClose } = props;
  const startMax = sectionStartMax(section.lengthBars, maxBars);
  const lengthMax = sectionLengthMax(section.startBar, maxBars);
  const [startDraft, setStartDraft] = useState(() => String(section.startBar));
  const [lengthDraft, setLengthDraft] = useState(() => String(section.lengthBars));
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, [section.id]);

  useEffect(() => {
    setStartDraft(String(section.startBar));
  }, [section.id, section.startBar]);
  useEffect(() => {
    setLengthDraft(String(section.lengthBars));
  }, [section.id, section.lengthBars]);

  const commitStartDraft = () => {
    const startBar =
      startDraft.trim() === ''
        ? section.startBar
        : clampSectionStart(startDraft, section.lengthBars, maxBars);
    setStartDraft(String(startBar));
    if (startBar !== section.startBar) onPatch({ startBar });
  };
  const commitLengthDraft = () => {
    const lengthBars =
      lengthDraft.trim() === ''
        ? section.lengthBars
        : clampSectionLength(lengthDraft, section.startBar, maxBars);
    setLengthDraft(String(lengthBars));
    if (lengthBars !== section.lengthBars) onPatch({ lengthBars });
  };

  const timingKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    commit: () => void,
    restore: () => void,
  ) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      restore();
    }
  };
  return (
    <section id={id} className="arranger__editor" aria-label="選択セクションの編集">
      <div className="arranger__editor-row">
        <label>
          <span>名前</span>
          <input
            ref={nameInputRef}
            value={section.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            aria-label="セクション名"
          />
        </label>
        <label>
          <span>種類</span>
          <select
            value={section.type}
            onChange={(e) => onPatch({ type: e.target.value as Section['type'] })}
            aria-label="セクション種類"
          >
            {SECTION_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="arranger__editor-row">
        <label>
          <span>開始小節</span>
          <input
            type="number"
            min={0}
            max={startMax}
            step={1}
            value={startDraft}
            onChange={(e) => setStartDraft(e.target.value)}
            onBlur={commitStartDraft}
            onKeyDown={(event) =>
              timingKeyDown(event, commitStartDraft, () => setStartDraft(String(section.startBar)))
            }
            aria-label="開始小節"
            aria-describedby="section-timing-bounds"
          />
        </label>
        <label>
          <span>長さ（小節）</span>
          <input
            type="number"
            min={1}
            max={lengthMax}
            step={1}
            value={lengthDraft}
            onChange={(e) => setLengthDraft(e.target.value)}
            onBlur={commitLengthDraft}
            onKeyDown={(event) =>
              timingKeyDown(event, commitLengthDraft, () =>
                setLengthDraft(String(section.lengthBars)),
              )
            }
            aria-label="長さ（小節）"
            aria-describedby="section-timing-bounds"
          />
        </label>
      </div>
      <p
        id="section-timing-bounds"
        className="arranger__timing-hint"
        role="status"
        aria-live="polite"
      >
        開始小節は0から{startMax}、長さは1から{lengthMax}小節までです。入力はEnterまたはフォーカス移動で確定します。
      </p>
      <div className="arranger__editor-actions">
        <button type="button" className="arranger__remove" onClick={onRemove}>
          このセクションを削除
        </button>
        <button type="button" onClick={onClose}>
          閉じる
        </button>
      </div>
    </section>
  );
}
