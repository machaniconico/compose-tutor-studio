// Launch start screen (docs/04 §2.1). Shown on every app start, on top of the
// studio shell. Five entries: new project / from template / continue last /
// start tutorial / listen to the sample song. "前回の続き" only appears when a
// saved project exists. Fully keyboard operable (Tab to move, Enter to pick,
// Escape to close).

import { useState, type KeyboardEvent } from 'react';
import {
  PROJECT_TEMPLATES,
  instantiateTemplate,
  type TemplateId,
} from '@cts/project-model';
import { useStore } from '../../state/store';
import { createSampleProject } from '../../state/sampleProject';
import { pushToast } from '../../state/tutorialBridge';
import './startScreen.css';

type View = 'menu' | 'templates';

/** Full-screen start menu overlay. Renders nothing once closed. */
export function StartScreen() {
  const open = useStore((s) => s.startScreenOpen);
  if (!open) return null;
  return <StartScreenDialog />;
}

function StartScreenDialog() {
  const [view, setView] = useState<View>('menu');

  const setStartScreenOpen = useStore((s) => s.setStartScreenOpen);
  const setRightPanelTab = useStore((s) => s.setRightPanelTab);
  const createNewProject = useStore((s) => s.createNewProject);
  const replaceProject = useStore((s) => s.replaceProject);
  const loadProjectById = useStore((s) => s.loadProjectById);
  const loadProjectForPreview = useStore((s) => s.loadProjectForPreview);
  const play = useStore((s) => s.play);

  // Saved projects are read once per render; the start screen is short-lived.
  const summaries = useStore.getState().listSavedProjects();
  const latest = summaries[0];

  const close = () => setStartScreenOpen(false);

  const handleNew = () => {
    createNewProject();
    close();
    pushToast('あたらしい曲を用意しました。再生ボタンでコードの響きを聴けます。', 'success');
  };

  const handleTemplate = (id: TemplateId) => {
    try {
      replaceProject(instantiateTemplate(id));
      close();
      pushToast(`テンプレート「${PROJECT_TEMPLATES[id].name}」で作成しました。`, 'success');
    } catch {
      pushToast('テンプレートの読み込みに失敗しました。', 'error');
    }
  };

  const handleContinue = () => {
    if (!latest) return;
    if (loadProjectById(latest.id)) {
      close();
      pushToast(`「${latest.title}」のつづきから再開します。`, 'success');
    } else {
      pushToast('前回のプロジェクトを読み込めませんでした。', 'error');
    }
  };

  const handleTutorial = () => {
    setRightPanelTab('tutorial');
    close();
    pushToast('チュートリアルを開きました。右のパネルからレッスンを選べます。', 'info');
  };

  const handleSample = () => {
    loadProjectForPreview(createSampleProject());
    play();
    close();
    pushToast('サンプル曲を再生します。気になるところは自由に編集してみてください。', 'info');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (view === 'templates') {
      setView('menu');
    } else {
      close();
    }
  };

  return (
    <div className="start-screen-backdrop" role="presentation">
      <div
        className="start-screen"
        role="dialog"
        aria-modal="true"
        aria-label="スタート画面"
        onKeyDown={handleKeyDown}
      >
        <h1 className="start-screen__title">Compose Tutor Studio</h1>
        <p className="start-screen__lead">
          作りながら音楽のしくみを学べる作曲アプリです。今日はどこから始めますか？
        </p>

        {view === 'menu' ? (
          <div className="start-menu">
            <button type="button" className="start-entry" onClick={handleNew} autoFocus>
              <span className="start-entry__name">新規作成</span>
              <span className="start-entry__desc">まっさらな8小節から、自分の曲を作り始めます。</span>
            </button>

            <button type="button" className="start-entry" onClick={() => setView('templates')}>
              <span className="start-entry__name">テンプレートから作る</span>
              <span className="start-entry__desc">
                ポップスやジングルなど、できあがりの形が見える下書きから始めます。
              </span>
            </button>

            {latest ? (
              <button type="button" className="start-entry" onClick={handleContinue}>
                <span className="start-entry__name">前回の続き</span>
                <span className="start-entry__desc">{`「${latest.title}」をこの前のところから再開します。`}</span>
              </button>
            ) : null}

            <button type="button" className="start-entry" onClick={handleTutorial}>
              <span className="start-entry__name">チュートリアルをはじめる</span>
              <span className="start-entry__desc">
                レッスンにそって、コードやメロディの作り方を1歩ずつ学びます。
              </span>
            </button>

            <button type="button" className="start-entry" onClick={handleSample}>
              <span className="start-entry__name">サンプルプロジェクトを聴く</span>
              <span className="start-entry__desc">
                完成した8小節のサンプル曲をすぐに再生して、ゴールのイメージをつかみます。
              </span>
            </button>
          </div>
        ) : (
          <div className="start-screen__templates">
            <button
              type="button"
              className="start-screen__back"
              onClick={() => setView('menu')}
              autoFocus
            >
              ← もどる
            </button>
            <div className="template-gallery">
              {(Object.keys(PROJECT_TEMPLATES) as TemplateId[]).map((id) => {
                const t = PROJECT_TEMPLATES[id];
                return (
                  <button
                    key={id}
                    type="button"
                    className="template-card"
                    onClick={() => handleTemplate(id)}
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
          </div>
        )}

        <p className="start-screen__hint">Tabキーで移動、Enterキーで決定できます。</p>
      </div>
    </div>
  );
}
