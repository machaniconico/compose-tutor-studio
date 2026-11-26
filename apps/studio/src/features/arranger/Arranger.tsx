import { useState } from 'react';
import type { Section } from '@cts/project-model';
import { addSection, beatsPerBar, updateSection } from '@cts/project-model';
import { textUndoProps, useStore } from '../../state/store';
import { publishAppEvent } from '../../state/appEvents';
import {
  deleteSectionFromSong,
  duplicateSectionInSong,
  loopSection,
  moveSectionInSong,
} from '../../state/editorActions';
import { pxPerBeat } from '../timeline';
import { Playhead, TimelineRuler } from '../transport/TimelineRuler';

/**
 * Section types with Japanese labels and a one-line description. The
 * descriptions explain song-structure terms, which do not change with the
 * difficulty setting, so they do not go through difficultyText.
 */
const SECTION_TYPES: { type: Section['type']; label: string; description: string }[] = [
  { type: 'intro', label: 'イントロ', description: '曲の入り口。歌や主旋律が始まる前に雰囲気を作る部分' },
  { type: 'verse', label: 'Aメロ', description: '歌い出し。曲のテーマを落ち着いて聞かせる部分' },
  { type: 'preChorus', label: 'Bメロ', description: 'サビへつなぐ部分。少しずつ盛り上げていく' },
  { type: 'chorus', label: 'サビ', description: '曲の一番盛り上がる部分' },
  { type: 'bridge', label: 'ブリッジ', description: '雰囲気を変えて、曲に変化をつける部分' },
  { type: 'outro', label: 'アウトロ', description: '曲の終わり。音を減らして締めくくる部分' },
];

function typeLabel(type: Section['type']): string {
  return SECTION_TYPES.find((t) => t.type === type)?.label ?? type;
}

function typeDescription(type: Section['type']): string {
  return SECTION_TYPES.find((t) => t.type === type)?.description ?? '';
}

/**
 * Section arranger: blocks on a bar timeline. Add a section with a type
 * picker, edit name / type / start / length, or remove. Clicking a section
 * loops its bars and opens it for editing, where it can also be duplicated,
 * swapped with a neighbour or deleted with its content. Blocks are colored
 * by type via CSS classes.
 */
export function Arranger() {
  const project = useStore((s) => s.project);
  const zoomX = useStore((s) => s.editor.zoomX);
  const applyProjectChange = useStore((s) => s.applyProjectChange);

  const [editingId, setEditingId] = useState<string | null>(null);

  const bpb = beatsPerBar(project.timeSignature);
  const ppb = pxPerBeat(zoomX);
  const barPx = bpb * ppb;
  const laneWidth = project.lengthBars * barPx;

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
    publishAppEvent({
      type: 'section.added',
      payload: { sectionType: 'verse', startBar: clampedStart, lengthBars: length },
    });
  };

  const onRemove = (id: string) => {
    applyProjectChange((p) => ({ ...p, sections: p.sections.filter((s) => s.id !== id) }));
    if (editingId === id) setEditingId(null);
  };

  const onDelete = (id: string) => {
    if (deleteSectionFromSong(id) && editingId === id) setEditingId(null);
  };

  const onSectionClick = (id: string) => {
    loopSection(id);
    setEditingId(id === editingId ? null : id);
  };

  const onPatch = (id: string, patch: Partial<Omit<Section, 'id'>>) => {
    applyProjectChange((p) => updateSection(p, id, patch));
  };

  const editing = editingId ? project.sections.find((s) => s.id === editingId) ?? null : null;
  const ordered = [...project.sections].sort((x, y) => x.startBar - y.startBar);
  const editingIndex = editing ? ordered.findIndex((s) => s.id === editing.id) : -1;

  return (
    <div className="arranger">
      <div className="arranger__toolbar">
        <strong>セクション（曲の構成）</strong>
        <button type="button" onClick={onAdd}>
          ＋ セクションを追加
        </button>
      </div>

      <TimelineRuler />
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
            className={`arranger__section is-${section.type}${editingId === section.id ? ' is-editing' : ''}`}
            style={{ left: section.startBar * barPx, width: section.lengthBars * barPx }}
            onClick={() => onSectionClick(section.id)}
            title={`${section.name} / ${typeLabel(section.type)}`}
          >
            <span className="arranger__section-name">{section.name}</span>
            <span className="arranger__section-type">{typeLabel(section.type)}</span>
          </button>
        ))}
        <Playhead ppb={ppb} />
      </div>

      {editing ? (
        <SectionEditor
          section={editing}
          maxBars={project.lengthBars}
          canMoveEarlier={editingIndex > 0}
          canMoveLater={editingIndex >= 0 && editingIndex < ordered.length - 1}
          onPatch={(patch) => onPatch(editing.id, patch)}
          onDuplicate={() => duplicateSectionInSong(editing.id)}
          onMove={(direction) => moveSectionInSong(editing.id, direction)}
          onDelete={() => onDelete(editing.id)}
          onRemove={() => onRemove(editing.id)}
          onClose={() => setEditingId(null)}
        />
      ) : (
        <p className="empty-hint">
          セクションをクリックすると、その小節をくり返し再生(ループ)して編集できます。イントロは控えめに、サビは要素を増やすと盛り上がります。
        </p>
      )}
    </div>
  );
}

function SectionEditor(props: {
  section: Section;
  maxBars: number;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  onPatch: (patch: Partial<Omit<Section, 'id'>>) => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { section, maxBars, canMoveEarlier, canMoveLater, onPatch, onDuplicate, onMove, onDelete, onRemove, onClose } =
    props;
  return (
    <div className="arranger__editor">
      <p className="arranger__section-description">
        {typeLabel(section.type)}: {typeDescription(section.type)}
      </p>
      <div className="arranger__editor-row">
        <label>
          <span>名前</span>
          <input
            {...textUndoProps}
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
            {...textUndoProps}
            type="number"
            min={0}
            max={maxBars - 1}
            value={section.startBar}
            onChange={(e) =>
              onPatch({ startBar: Math.max(0, Math.min(maxBars - 1, Number(e.target.value) || 0)) })
            }
            aria-label="開始小節"
          />
        </label>
        <label>
          <span>長さ（小節）</span>
          <input
            {...textUndoProps}
            type="number"
            min={1}
            max={maxBars}
            value={section.lengthBars}
            onChange={(e) =>
              onPatch({ lengthBars: Math.max(1, Math.min(maxBars, Number(e.target.value) || 1)) })
            }
            aria-label="長さ（小節）"
          />
        </label>
      </div>
      <div className="arranger__editor-actions">
        <button type="button" onClick={onDuplicate} title="中のクリップとコードごと、すぐ後ろに複製します">
          複製
        </button>
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={!canMoveEarlier}
          title="前のセクションと中身ごと入れ替えます"
        >
          前へ
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={!canMoveLater}
          title="後ろのセクションと中身ごと入れ替えます"
        >
          後ろへ
        </button>
        <button
          type="button"
          className="arranger__remove"
          onClick={onDelete}
          title="中のクリップとコードも消して、後ろを詰めます"
        >
          削除
        </button>
        <button type="button" onClick={onRemove} title="クリップとコードは残し、セクションの区切りだけ外します">
          区切りだけ外す
        </button>
        <button type="button" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
