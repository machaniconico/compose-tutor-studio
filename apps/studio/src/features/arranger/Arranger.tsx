import { useState } from 'react';
import type { Section } from '@cts/project-model';
import { addSection, updateSection } from '@cts/project-model';
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

/**
 * Section arranger: blocks on a bar timeline. Add a section with a type
 * picker, edit name / type / start / length, or remove. Blocks are colored
 * by type via CSS classes.
 */
export function Arranger() {
  const project = useStore((s) => s.project);
  const zoomX = useStore((s) => s.editor.zoomX);
  const applyProjectChange = useStore((s) => s.applyProjectChange);

  const [editingId, setEditingId] = useState<string | null>(null);

  const bpb = project.timeSignature[0];
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
  };

  const onRemove = (id: string) => {
    applyProjectChange((p) => ({ ...p, sections: p.sections.filter((s) => s.id !== id) }));
    if (editingId === id) setEditingId(null);
  };

  const onPatch = (id: string, patch: Partial<Omit<Section, 'id'>>) => {
    applyProjectChange((p) => updateSection(p, id, patch));
  };

  const editing = editingId ? project.sections.find((s) => s.id === editingId) ?? null : null;

  return (
    <div className="arranger">
      <div className="arranger__toolbar">
        <strong>セクション（曲の構成）</strong>
        <button type="button" onClick={onAdd}>
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
            className={`arranger__section is-${section.type}${editingId === section.id ? ' is-editing' : ''}`}
            style={{ left: section.startBar * barPx, width: section.lengthBars * barPx }}
            onClick={() => setEditingId(section.id === editingId ? null : section.id)}
            title={`${section.name} / ${typeLabel(section.type)}`}
          >
            <span className="arranger__section-name">{section.name}</span>
            <span className="arranger__section-type">{typeLabel(section.type)}</span>
          </button>
        ))}
      </div>

      {editing ? (
        <SectionEditor
          section={editing}
          maxBars={project.lengthBars}
          onPatch={(patch) => onPatch(editing.id, patch)}
          onRemove={() => onRemove(editing.id)}
          onClose={() => setEditingId(null)}
        />
      ) : (
        <p className="empty-hint">
          セクションをクリックすると編集できます。イントロは控えめに、サビは要素を増やすと盛り上がります。
        </p>
      )}
    </div>
  );
}

function SectionEditor(props: {
  section: Section;
  maxBars: number;
  onPatch: (patch: Partial<Omit<Section, 'id'>>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { section, maxBars, onPatch, onRemove, onClose } = props;
  return (
    <div className="arranger__editor">
      <div className="arranger__editor-row">
        <label>
          <span>名前</span>
          <input
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
        <button type="button" className="arranger__remove" onClick={onRemove}>
          このセクションを削除
        </button>
        <button type="button" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
