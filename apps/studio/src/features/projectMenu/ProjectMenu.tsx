// Project menu in the top bar: create-from-template gallery (incl. まっさら),
// the saved-project list (load / delete), and inline rename of the active
// project title.

import { useState } from 'react';
import {
  PROJECT_TEMPLATES,
  instantiateTemplate,
  type TemplateId,
} from '@cts/project-model';
import { useStore } from '../../state/store';
import { pushToast } from '../../state/tutorialBridge';
import { Dialog } from '../common/Dialog';

/** Human-readable ja date for a saved project. */
function formatJaDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type Tab = 'new' | 'saved';

/** Top-bar project menu button + dialog. */
export function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('new');

  const title = useStore((s) => s.project.title);
  const setTitle = useStore((s) => s.setTitle);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="プロジェクトメニュー">
        ☰ プロジェクト
      </button>

      {open ? (
        <Dialog title="プロジェクト" onClose={() => setOpen(false)} className="dialog--wide">
          <div className="project-menu">
            <label className="project-menu__rename">
              <span>プロジェクト名</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="プロジェクト名を変更"
              />
            </label>

            <div className="project-menu__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'new'}
                className={tab === 'new' ? 'is-active' : ''}
                onClick={() => setTab('new')}
              >
                新規プロジェクト
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'saved'}
                className={tab === 'saved' ? 'is-active' : ''}
                onClick={() => setTab('saved')}
              >
                保存済み
              </button>
            </div>

            {tab === 'new' ? (
              <NewProjectGallery onDone={() => setOpen(false)} />
            ) : (
              <SavedProjectList onDone={() => setOpen(false)} />
            )}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function NewProjectGallery({ onDone }: { onDone: () => void }) {
  const createNewProject = useStore((s) => s.createNewProject);
  const replaceProject = useStore((s) => s.replaceProject);

  /** Confirm before discarding edits when history is non-empty. */
  const confirmDiscard = (): boolean => {
    const hasHistory = useStore.getState().past.length > 0;
    if (!hasHistory) return true;
    return window.confirm('現在の編集内容は失われます。新しいプロジェクトを作成しますか？');
  };

  const startBlank = () => {
    if (!confirmDiscard()) return;
    createNewProject('新しい曲');
    onDone();
    pushToast('まっさらなプロジェクトを作成しました。', 'success');
  };

  const startTemplate = (id: TemplateId) => {
    if (!confirmDiscard()) return;
    try {
      replaceProject(instantiateTemplate(id));
      onDone();
      pushToast(`テンプレート「${PROJECT_TEMPLATES[id].name}」で作成しました。`, 'success');
    } catch {
      pushToast('テンプレートの読み込みに失敗しました。', 'error');
    }
  };

  const templateIds = Object.keys(PROJECT_TEMPLATES) as TemplateId[];

  return (
    <div className="template-gallery">
      <button type="button" className="template-card template-card--blank" onClick={startBlank}>
        <span className="template-card__name">まっさら</span>
        <span className="template-card__desc">
          空のプロジェクトから自由に作り始めます。
        </span>
      </button>
      {templateIds.map((id) => {
        const t = PROJECT_TEMPLATES[id];
        return (
          <button
            key={id}
            type="button"
            className="template-card"
            onClick={() => startTemplate(id)}
          >
            <span className="template-card__name">{t.name}</span>
            <span className="template-card__desc">{t.description}</span>
            <span className="template-card__meta">
              {t.bpm} BPM ・ {t.key} ・ {t.lengthBars}小節
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SavedProjectList({ onDone }: { onDone: () => void }) {
  const listSavedProjects = useStore((s) => s.listSavedProjects);
  const loadProjectById = useStore((s) => s.loadProjectById);
  const deleteProject = useStore((s) => s.deleteProject);
  const activeId = useStore((s) => s.project.id);
  // Re-render trigger after delete.
  const [version, setVersion] = useState(0);

  const summaries = listSavedProjects();

  const load = (id: string) => {
    const hasHistory = useStore.getState().past.length > 0;
    if (hasHistory && !window.confirm('現在の編集内容は失われます。読み込みますか？')) {
      return;
    }
    if (loadProjectById(id)) {
      onDone();
      pushToast('プロジェクトを読み込みました。', 'success');
    } else {
      pushToast('プロジェクトの読み込みに失敗しました。', 'error');
    }
  };

  const remove = (id: string, title: string) => {
    if (!window.confirm(`「${title}」を削除しますか？この操作は元に戻せません。`)) return;
    deleteProject(id);
    setVersion((v) => v + 1);
    pushToast('プロジェクトを削除しました。', 'info');
  };

  if (summaries.length === 0) {
    return (
      <p className="project-menu__empty" data-version={version}>
        保存済みのプロジェクトはまだありません。
      </p>
    );
  }

  return (
    <ul className="saved-list" data-version={version}>
      {summaries.map((s) => (
        <li key={s.id} className={`saved-item${s.id === activeId ? ' is-active' : ''}`}>
          <button type="button" className="saved-item__main" onClick={() => load(s.id)}>
            <span className="saved-item__title">{s.title}</span>
            <span className="saved-item__date">更新: {formatJaDate(s.updatedAt)}</span>
          </button>
          <button
            type="button"
            className="saved-item__delete"
            aria-label={`${s.title}を削除`}
            onClick={() => remove(s.id, s.title)}
          >
            削除
          </button>
        </li>
      ))}
    </ul>
  );
}
