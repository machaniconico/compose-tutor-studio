// Project menu in the top bar: create-from-template gallery (incl. まっさら),
// the saved-project list (load / delete), and inline rename of the active
// project title.

import { useEffect, useRef, useState } from 'react';
import {
  PROJECT_TEMPLATES,
  instantiateTemplate,
  type TemplateId,
} from '@cts/project-model';
import { importMidiBytes, importMidiFile } from '../../state/importMidi';
import { uid } from '../../state/ids';
import { useStore, type LocalDataEraseState } from '../../state/store';
import { pushToast } from '../../state/tutorialBridge';
import { studioRuntime } from '../../platform/runtime';
import { Dialog } from '../common/Dialog';
import {
  NativeFileGatewayError,
  nativeFileGateway,
} from '../../platform/nativeFileGateway';
import { handleTabKeyDown } from '../common/tabs';

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

const TABS: readonly Tab[] = ['new', 'saved'];
const projectMenuTabId = (tab: Tab): string => `project-menu-tab-${tab}`;
const projectMenuTabPanelId = (tab: Tab): string =>
  `project-menu-tabpanel-${tab}`;

type ProjectMenuContentProps = {
  onDone: () => void;
  onMidiImportBusyChange?: (busy: boolean) => void;
};

export const MIDI_IMPORT_UNCHANGED_ASSURANCE =
  'MIDI読み込みによる曲・選択・表示の変更はありません。';

export function withMidiImportUnchangedAssurance(message: string): string {
  const trimmed = message.trim();
  if (trimmed.includes(MIDI_IMPORT_UNCHANGED_ASSURANCE)) return trimmed;
  return `${trimmed}${trimmed.endsWith('。') ? '' : '。'}${MIDI_IMPORT_UNCHANGED_ASSURANCE}`;
}

export const ERASE_ALL_CONFIRMATION_PHRASE = 'すべて消去';

type LocalDataErasePhase = LocalDataEraseState['phase'];

type LocalDataEraseDialogProps = Readonly<{
  state: LocalDataEraseState;
  onErase: () => Promise<boolean>;
  onRequestClose: () => void;
  startDisabled?: boolean;
  /** Read synchronously after invoking the store action to distinguish refusal from one-way start. */
  hasEraseStarted?: () => boolean;
}>;

export function canConfirmLocalDataErase(value: string): boolean {
  return value === ERASE_ALL_CONFIRMATION_PHRASE;
}

export function canOpenLocalDataErase(
  projectOperationBusy: boolean,
  phase: LocalDataErasePhase,
): boolean {
  return !projectOperationBusy && phase === 'idle';
}

export function projectDeleteConfirmation(
  title: string,
  branchCount: number,
  includeFullDeviceGuidance: boolean,
): string {
  const branchWarning =
    branchCount > 0
      ? `\n未保存分岐 ${branchCount}件も削除されます。必要な分岐は先にコピーとして開いてください。`
      : '';
  const fullEraseGuidance = includeFullDeviceGuidance
    ? ' アプリが管理する端末内の全記録を消すには「この端末のデータをすべて消去」を使用してください。'
    : '';
  return `「${title}」を保存一覧から削除しますか？この操作は元に戻せません。${branchWarning}\n復旧・互換性確認の記録は端末内に残る場合があります。${fullEraseGuidance}`;
}

function localDataEraseProgress(phase: LocalDataErasePhase): string {
  switch (phase) {
    case 'quiescing':
      return '編集と保存処理を停止しています…';
    case 'native-pending':
      return 'プロジェクトと端末内の保存記録を消去しています…';
    case 'renderer-clearing':
      return '復旧データ、学習進捗、WebViewキャッシュを消去しています…';
    case 'erase-close-pending':
      return 'データの消去が完了しました。アプリの終了要求を送信しています…';
    case 'erase-close-accepted':
      return '終了要求を受け付けました。アプリを終了しています…';
    case 'erase-close-unknown':
      return 'データの消去は完了しています。終了要求の応答を確認できません…';
    case 'close-handoff':
      return '通常の終了要求の応答を確認しています…';
    case 'idle':
    case 'failed':
      return '消去を開始しています…';
  }
}

/** Project creation/import/recovery controls loaded only after its dialog opens. */
export function ProjectMenuContent({
  onDone,
  onMidiImportBusyChange,
}: ProjectMenuContentProps) {
  const [tab, setTab] = useState<Tab>('new');

  const title = useStore((s) => s.project.title);
  const setTitle = useStore((s) => s.setTitle);
  const projectOperationBusy = useStore((s) => s.projectOperationBusy);

  return (
    <div className="project-menu">
            <label className="project-menu__rename">
              <span>プロジェクト名</span>
              <input
                type="text"
                value={title}
                disabled={projectOperationBusy}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="プロジェクト名を変更"
              />
            </label>
            {projectOperationBusy ? (
              <p className="project-menu__hint" role="status" aria-live="polite">
                プロジェクトを安全に処理しています…
              </p>
            ) : null}

            <MidiImportPanel
              onDone={onDone}
              onBusyChange={onMidiImportBusyChange}
            />

            <div
              className="project-menu__tabs"
              role="tablist"
              aria-label="プロジェクト表示切替"
            >
              <button
                type="button"
                role="tab"
                id={projectMenuTabId('new')}
                aria-controls={projectMenuTabPanelId('new')}
                aria-selected={tab === 'new'}
                tabIndex={tab === 'new' ? 0 : -1}
                className={tab === 'new' ? 'is-active' : ''}
                onClick={() => setTab('new')}
                onKeyDown={(event) =>
                  handleTabKeyDown(
                    event,
                    TABS,
                    'new',
                    setTab,
                    projectMenuTabId,
                  )
                }
              >
                新規プロジェクト
              </button>
              <button
                type="button"
                role="tab"
                id={projectMenuTabId('saved')}
                aria-controls={projectMenuTabPanelId('saved')}
                aria-selected={tab === 'saved'}
                tabIndex={tab === 'saved' ? 0 : -1}
                className={tab === 'saved' ? 'is-active' : ''}
                onClick={() => setTab('saved')}
                onKeyDown={(event) =>
                  handleTabKeyDown(
                    event,
                    TABS,
                    'saved',
                    setTab,
                    projectMenuTabId,
                  )
                }
              >
                保存済み
              </button>
            </div>

            {TABS.map((panelTab) => {
              const active = tab === panelTab;
              return (
                <div
                  key={panelTab}
                  id={projectMenuTabPanelId(panelTab)}
                  role="tabpanel"
                  aria-labelledby={projectMenuTabId(panelTab)}
                  hidden={!active}
                  tabIndex={active ? 0 : -1}
                >
                  {active && panelTab === 'new' ? (
                    <NewProjectGallery onDone={onDone} />
                  ) : null}
                  {active && panelTab === 'saved' ? (
                    <SavedProjectList onDone={onDone} />
                  ) : null}
                </div>
              );
            })}

            {studioRuntime.kind === 'native' ? <LocalDataEraseSection /> : null}
    </div>
  );
}

/** Native-only entry point for deleting every app-owned local data surface. */
function LocalDataEraseSection() {
  const state = useStore((s) => s.localDataErase);
  const eraseAllLocalData = useStore((s) => s.eraseAllLocalData);
  const projectOperationBusy = useStore((s) => s.projectOperationBusy);
  const [dialogOpen, setDialogOpen] = useState(state.phase !== 'idle');

  useEffect(() => {
    // A resumed or failed erase must not leave a path back to the editor.
    if (state.phase !== 'idle') setDialogOpen(true);
  }, [state.phase]);

  return (
    <section className="local-data-erase" aria-labelledby="local-data-erase-title">
      <h3 id="local-data-erase-title">この端末のデータ</h3>
      <p>
        通常のプロジェクト削除は保存一覧からの論理削除です。復旧や互換性確認の記録が端末内に残る場合があります。
      </p>
      <button
        type="button"
        className="local-data-erase__open"
        disabled={!canOpenLocalDataErase(projectOperationBusy, state.phase)}
        onClick={() => setDialogOpen(true)}
      >
        この端末のデータをすべて消去
      </button>

      {dialogOpen ? (
        <LocalDataEraseDialog
          state={state}
          onErase={eraseAllLocalData}
          onRequestClose={() => setDialogOpen(false)}
          startDisabled={projectOperationBusy}
          hasEraseStarted={() =>
            useStore.getState().localDataErase.phase !== 'idle'
          }
        />
      ) : null}
    </section>
  );
}

/**
 * Confirmation remains mounted and non-dismissible after the Store confirms
 * the one-way erase start. A reversible lifecycle refusal stays cancellable.
 * The native command owns crash-resume; this view owns honest scope and retry.
 */
export function LocalDataEraseDialog({
  state,
  onErase,
  onRequestClose,
  startDisabled = false,
  hasEraseStarted = () => true,
}: LocalDataEraseDialogProps) {
  const [confirmation, setConfirmation] = useState('');
  const [eraseStarted, setEraseStarted] = useState(state.phase !== 'idle');
  const [submitting, setSubmitting] = useState(false);
  const [invocationFailure, setInvocationFailure] = useState<string | null>(null);
  const startedRef = useRef(state.phase !== 'idle');
  const inFlightRef = useRef(false);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);

  if (state.phase !== 'idle') startedRef.current = true;
  const closeLocked = startedRef.current || eraseStarted || state.phase !== 'idle';
  const failed =
    !submitting &&
    (state.phase === 'failed' ||
      state.phase === 'erase-close-unknown' ||
      state.phase === 'close-handoff' ||
      invocationFailure !== null);
  const busy =
    !failed &&
    (submitting ||
      state.phase === 'quiescing' ||
      state.phase === 'native-pending' ||
      state.phase === 'renderer-clearing' ||
      state.phase === 'erase-close-pending' ||
      state.phase === 'erase-close-accepted');

  useEffect(() => {
    if (failed) retryButtonRef.current?.focus({ preventScroll: true });
  }, [failed]);

  const requestClose = (): void => {
    if (!startedRef.current && !closeLocked) onRequestClose();
  };

  const runErase = async (): Promise<void> => {
    if (inFlightRef.current || (startDisabled && !startedRef.current)) return;
    inFlightRef.current = true;
    setSubmitting(true);
    setInvocationFailure(null);
    try {
      const operation = onErase();
      const didStart = hasEraseStarted();
      if (didStart) {
        startedRef.current = true;
        setEraseStarted(true);
      }
      if (!(await operation) && didStart) {
        setInvocationFailure(
          '端末データの消去を完了できませんでした。データは再び編集せず、この画面から再試行してください。',
        );
      }
    } catch {
      setInvocationFailure(
        '端末データの消去処理に接続できませんでした。データは再び編集せず、この画面から再試行してください。',
      );
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const failureMessage =
    state.message ??
    invocationFailure ??
    '端末データの消去を完了できませんでした。データは再び編集せず、この画面から再試行してください。';
  const closeHandoffUnknown = state.phase === 'close-handoff';
  const eraseCloseUnknown = state.phase === 'erase-close-unknown';
  const retryDisabledPermanently = closeHandoffUnknown || eraseCloseUnknown;

  return (
    <Dialog
      title="この端末のデータをすべて消去"
      onClose={requestClose}
      closeDisabled={closeLocked}
      busy={busy}
      className="dialog--erase-local-data"
    >
      <div className="local-data-erase-dialog">
        {!closeLocked ? (
          <>
            <p className="local-data-erase-dialog__lead">
              Compose Tutor Studio がこの端末内に保存した次のデータをすべて消去し、アプリを終了します。
            </p>
            <ul className="local-data-erase-dialog__scope">
              <li>すべてのプロジェクト、保存世代、削除記録</li>
              <li>未保存分岐、読み込めないデータ、新しい版のデータ</li>
              <li>旧版から移行した完全な保存記録</li>
              <li>緊急復旧データ</li>
              <li>チュートリアルと初回案内の進捗</li>
              <li>WebView のローカル保存とキャッシュ</li>
            </ul>
            <p className="local-data-erase-dialog__unaffected">
              外部へ書き出したプロジェクト、MIDI、WAVファイルは消えません。
            </p>
            <p className="local-data-erase-dialog__limitation">
              OSバックアップ、ファイルシステムのスナップショット、SSDの仕組みに残る痕跡は対象外です。復元不能にする「安全消去」を保証する機能ではありません。
            </p>

            <label className="local-data-erase-dialog__confirmation">
              <span>
                確認のため「<strong>{ERASE_ALL_CONFIRMATION_PHRASE}</strong>」と入力してください
              </span>
              <input
                type="text"
                value={confirmation}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>

            {state.message ? (
              <p
                className="local-data-erase-dialog__notice"
                role="status"
                aria-live="polite"
              >
                {state.message}
              </p>
            ) : null}

            <div className="local-data-erase-dialog__actions">
              <button
                type="button"
                data-modal-initial-focus
                onClick={requestClose}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="local-data-erase-dialog__confirm"
                disabled={
                  startDisabled || !canConfirmLocalDataErase(confirmation)
                }
                onClick={() => void runErase()}
              >
                すべて消去して終了
              </button>
            </div>
          </>
        ) : failed ? (
          <div
            className="local-data-erase-dialog__failure"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <h3>
              {closeHandoffUnknown
                ? 'データ消去は開始していません'
                : eraseCloseUnknown
                  ? 'データは消去済みですが、終了結果を確認できません'
                  : '消去を完了できませんでした'}
            </h3>
            <p>{failureMessage}</p>
            {!retryDisabledPermanently ? (
              <button
                ref={retryButtonRef}
                type="button"
                data-modal-initial-focus
                disabled={submitting}
                onClick={() => void runErase()}
              >
                消去を再試行
              </button>
            ) : null}
          </div>
        ) : (
          <div
            className="local-data-erase-dialog__progress"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={-1}
          >
            <span className="local-data-erase-dialog__spinner" aria-hidden="true" />
            <p>{localDataEraseProgress(state.phase)}</p>
            <small>完了するとアプリは自動的に終了します。この画面は閉じられません。</small>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function MidiImportPanel({
  onDone,
  onBusyChange,
}: {
  onDone: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<{
    trackCount: number;
    noteCount: number;
    warnings: string[];
  } | null>(null);
  const isNative = studioRuntime.kind === 'native';

  const finishImport = (result: Awaited<ReturnType<typeof importMidiFile>>) => {
    if (!result.ok) {
      const message = withMidiImportUnchangedAssurance(result.message);
      setError(message);
      pushToast(message, 'error');
      return;
    }
    const successMessage = `MIDIを読み込みました。${result.trackCount}トラック・${result.noteCount}音を追加しました。`;
    pushToast(successMessage, 'success');
    if (result.warnings.length > 0) {
      const remaining = result.warnings.length - 1;
      pushToast(
        `${result.warnings[0]}${remaining > 0 ? `（ほか${remaining}件）` : ''}`,
        'info',
      );
      setCompleted({
        trackCount: result.trackCount,
        noteCount: result.noteCount,
        warnings: result.warnings,
      });
      return;
    }
    onDone();
  };

  const onImportFile = async (file: File) => {
    setImporting(true);
    onBusyChange?.(true);
    setError(null);
    setCompleted(null);
    try {
      finishImport(await importMidiFile(file));
    } catch (error) {
      const message =
        error instanceof NativeFileGatewayError && error.code === 'file-too-large'
          ? 'MIDIファイルが大きすぎます（上限8MB）。'
          : error instanceof NativeFileGatewayError &&
              (error.code === 'invalid-file' ||
                error.code === 'invalid-envelope' ||
                error.code === 'invalid-filename')
            ? 'MIDIファイルを安全に検証できませんでした。別の.midファイルを試してください。'
            : 'MIDIの読み込みでエラーが起きました。別の.midファイルを試してください。';
      const assuredMessage = withMidiImportUnchangedAssurance(message);
      setError(assuredMessage);
      pushToast(assuredMessage, 'error');
    } finally {
      setImporting(false);
      onBusyChange?.(false);
    }
  };

  const openNativeMidiFile = async () => {
    if (importing) return;
    setImporting(true);
    onBusyChange?.(true);
    setError(null);
    setCompleted(null);
    try {
      const selected = await nativeFileGateway.openMidi();
      if (selected.status === 'cancelled') return;
      finishImport(await importMidiBytes(selected.fileName, selected.bytes));
    } catch (error) {
      const message =
        error instanceof NativeFileGatewayError && error.code === 'file-too-large'
          ? 'MIDIファイルが大きすぎます（上限8MB）。'
          : error instanceof NativeFileGatewayError &&
              (error.code === 'invalid-file' ||
                error.code === 'invalid-envelope' ||
                error.code === 'invalid-filename')
            ? 'MIDIファイルを安全に検証できませんでした。別の.midファイルを試してください。'
            : 'MIDIの読み込みでエラーが起きました。別の.midファイルを試してください。';
      const assuredMessage = withMidiImportUnchangedAssurance(message);
      setError(assuredMessage);
      pushToast(assuredMessage, 'error');
    } finally {
      setImporting(false);
      onBusyChange?.(false);
    }
  };

  return (
    <section className="project-menu__import">
      <p className="panel-section__title">MIDIインポート</p>
      {completed ? (
        <div className="project-menu__import-result" role="status" aria-live="polite">
          <p>
            {completed.trackCount}トラック・{completed.noteCount}音を追加しました。
          </p>
          <p className="project-menu__hint">次の違いを確認してください。</p>
          <ul>
            {completed.warnings.map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
          </ul>
          <button type="button" onClick={onDone}>
            閉じて編集を続ける
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => {
              if (isNative) void openNativeMidiFile();
              else fileInputRef.current?.click();
            }}
            disabled={importing}
          >
            {importing ? '読み込み中…' : 'MIDIインポート'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onImportFile(file);
              e.target.value = '';
            }}
          />
          <p className="project-menu__hint">
            .midファイルのパートとチャンネルを新しいトラックとして追加します。現在の曲のテンポと拍子は変更しません。
          </p>
          <p className="project-menu__hint">
            アプリの曲を正確に移す場合は、プロジェクトファイル（.ctsproj.json）を使ってください。
          </p>
          {error ? (
            <p className="project-menu__empty" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function NewProjectGallery({ onDone }: { onDone: () => void }) {
  const createNewProject = useStore((s) => s.createNewProject);
  const replaceProject = useStore((s) => s.replaceProject);
  const [busy, setBusy] = useState(false);

  const startBlank = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await createNewProject('新しい曲'))) {
        pushToast('現在のプロジェクトを保存できないため、切り替えを中止しました。', 'error');
        return;
      }
      onDone();
      const saveFailed = useStore.getState().saveState.phase === 'error';
      pushToast(
        saveFailed
          ? 'プロジェクトを作成しましたが、まだ端末に保存できていません。'
          : 'まっさらなプロジェクトを作成しました。',
        saveFailed ? 'error' : 'success',
      );
    } finally {
      setBusy(false);
    }
  };

  const startTemplate = async (id: TemplateId) => {
    if (busy) return;
    setBusy(true);
    try {
      const template = instantiateTemplate(id);
      // Never reuse a model-factory id as a persisted top-level identity. A
      // fresh Studio id also protects users upgrading from older deterministic
      // template ids.
      if (!(await replaceProject({ ...template, id: uid('project') }))) {
        pushToast('現在のプロジェクトを保存できないため、切り替えを中止しました。', 'error');
        return;
      }
      onDone();
      const saveFailed = useStore.getState().saveState.phase === 'error';
      pushToast(
        saveFailed
          ? `テンプレート「${PROJECT_TEMPLATES[id].name}」を開きましたが、まだ端末に保存できていません。`
          : `テンプレート「${PROJECT_TEMPLATES[id].name}」で作成しました。`,
        saveFailed ? 'error' : 'success',
      );
    } catch {
      pushToast('テンプレートの読み込みに失敗しました。', 'error');
    } finally {
      setBusy(false);
    }
  };

  const templateIds = Object.keys(PROJECT_TEMPLATES) as TemplateId[];

  return (
    <div className="template-gallery">
      <button
        type="button"
        className="template-card template-card--blank"
        disabled={busy}
        onClick={() => void startBlank()}
      >
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
            disabled={busy}
            onClick={() => void startTemplate(id)}
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
  const summaries = useStore((s) => s.savedProjects);
  const refreshSavedProjects = useStore((s) => s.refreshSavedProjects);
  const loadProjectById = useStore((s) => s.loadProjectById);
  const recoverProjectBranch = useStore((s) => s.recoverProjectBranch);
  const deleteProject = useStore((s) => s.deleteProject);
  const activeId = useStore((s) => s.project.id);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void refreshSavedProjects();
  }, [refreshSavedProjects]);

  const load = async (id: string) => {
    setBusyId(id);
    if (await loadProjectById(id)) {
      onDone();
      pushToast('プロジェクトを読み込みました。', 'success');
    } else {
      const currentSaveFailed = useStore.getState().saveState.phase === 'error';
      pushToast(
        currentSaveFailed
          ? '現在のプロジェクトを保存できないため、読み込みを中止しました。'
          : 'プロジェクトの読み込みに失敗しました。',
        'error',
      );
    }
    setBusyId(null);
  };

  const remove = async (id: string, title: string, branchCount = 0) => {
    if (
      !window.confirm(
        projectDeleteConfirmation(title, branchCount, studioRuntime.kind === 'native'),
      )
    ) {
      return;
    }
    setBusyId(id);
    if (!(await deleteProject(id))) {
      pushToast('プロジェクトを削除できませんでした。保存設定を確認してください。', 'error');
      setBusyId(null);
      return;
    }
    setBusyId(null);
    pushToast('プロジェクトを削除しました。', 'info');
  };

  const recoverBranch = async (projectId: string, branchId: string) => {
    const busyKey = `${projectId}:${branchId}`;
    setBusyId(busyKey);
    if (await recoverProjectBranch(projectId, branchId)) {
      onDone();
      const saveFailed = useStore.getState().saveState.phase === 'error';
      pushToast(
        saveFailed
          ? '未保存分岐をコピーとして開きましたが、まだ端末に保存できていません。'
          : '未保存分岐を新しいコピーとして開きました。',
        saveFailed ? 'error' : 'success',
      );
    } else {
      pushToast('未保存分岐を安全に開けませんでした。元データは保持しています。', 'error');
    }
    setBusyId(null);
  };

  const branchList = (
    projectId: string,
    branches: (typeof summaries)[number]['branches'],
  ) =>
    branches.length > 0 ? (
      <div className="saved-item__branches">
        <span className="saved-item__branches-title">
          保持中の未保存分岐 {branches.length}件
        </span>
        {branches.map((branch) => (
          <button
            key={branch.branchId}
            type="button"
            className="saved-item__branch"
            disabled={busyId !== null}
            onClick={() => void recoverBranch(projectId, branch.branchId)}
          >
            <span>{branch.title || '名称未設定'}をコピーとして開く</span>
            <small>
              {branch.source === 'recovery-journal'
                ? '終了時の退避'
                : branch.source === 'legacy-migration'
                  ? '旧保存データ'
                  : '中断された保存'}{' '}
              ・{' '}
              {formatJaDate(branch.savedAt)}
            </small>
          </button>
        ))}
      </div>
    ) : null;

  if (summaries.length === 0) {
    return (
      <p className="project-menu__empty">
        保存済みのプロジェクトはまだありません。
      </p>
    );
  }

  return (
    <ul className="saved-list">
      {summaries.map((summary) => {
        if (summary.status === 'unreadable') {
          const label = `読み込めないプロジェクト (${summary.id})`;
          return (
            <li key={summary.id} className="saved-item saved-item--unreadable">
              <div className="saved-item__main" role="status">
                <span className="saved-item__title">読み込みに注意が必要です</span>
                <span className="saved-item__date">
                  {summary.errorCode === 'unsupported-version'
                    ? '新しいアプリ版で作成されています'
                    : summary.errorCode === 'conflict'
                      ? '複数画面の未保存変更が競合しています'
                    : '保存データを検証できませんでした'}
                </span>
              </div>
              <button
                type="button"
                className="saved-item__delete"
                aria-label={`${label}を削除`}
                disabled={busyId !== null}
                onClick={() => void remove(summary.id, label, summary.branches.length)}
              >
                削除
              </button>
              {branchList(summary.id, summary.branches)}
            </li>
          );
        }
        return (
          <li
            key={summary.id}
            className={`saved-item${summary.id === activeId ? ' is-active' : ''}`}
          >
            <button
              type="button"
              className="saved-item__main"
              aria-current={summary.id === activeId ? 'true' : undefined}
              disabled={busyId !== null}
              onClick={() => void load(summary.id)}
            >
              <span className="saved-item__title">{summary.title}</span>
              <span className="saved-item__date">
                更新: {formatJaDate(summary.updatedAt)}
                {summary.recovered ? ' ・ 復元可能' : ''}
                {summary.branches.length > 0 ? ` ・ 未保存分岐 ${summary.branches.length}件` : ''}
              </span>
            </button>
            <button
              type="button"
              className="saved-item__delete"
              aria-label={`${summary.title}を削除`}
              disabled={busyId !== null}
              onClick={() => void remove(summary.id, summary.title, summary.branches.length)}
            >
              削除
            </button>
            {branchList(summary.id, summary.branches)}
          </li>
        );
      })}
    </ul>
  );
}
