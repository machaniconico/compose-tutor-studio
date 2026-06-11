import { useStore } from '../../state/store';

/**
 * Placeholder Learn/Tutorial panel. Toggled from the inspector. Wave 2 wires
 * @cts/tutorial-engine here.
 */
export function TutorialPanel() {
  const open = useStore((s) => s.tutorialPanelOpen);
  const toggle = useStore((s) => s.toggleTutorialPanel);

  return (
    <div className="panel-section">
      <p className="panel-section__title">学習パネル</p>
      <button type="button" className={open ? 'is-active' : ''} aria-pressed={open} onClick={() => toggle()}>
        {open ? '学習パネルを閉じる' : '学習パネルを開く'}
      </button>
      {open ? (
        <div className="tutorial-panel__body" style={{ marginTop: 'var(--sp-2)' }}>
          <p>ここに次の操作のヒントとレッスンが表示されます（準備中）。</p>
          <p>例: 「再生ボタンを押して、コード進行を聴いてみましょう。」</p>
        </div>
      ) : null}
    </div>
  );
}
