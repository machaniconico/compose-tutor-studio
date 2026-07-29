import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  MIN_EVENT_DURATION_BEATS,
  type AudioTake,
  type AudioTakeFolder,
  type Project,
} from '@cts/project-model';
import {
  deleteStudioUnusedAudioTake,
  moveStudioAudioCompBoundary,
  paintStudioAudioCompRange,
  studioCompingErrorMessage,
  type StudioCompingCommandResult,
} from '../../state/compingActions';
import {
  useStore,
  type AudioAssetRuntimeIssue,
} from '../../state/store';

type Notice = Readonly<{
  kind: 'error' | 'status';
  message: string;
}>;

type RangeDraft = Readonly<{
  takeId: string;
  start: string;
  end: string;
}>;

type DragPreview = Readonly<{
  pointerId: number;
  takeId: string;
  anchorBeat: number;
  currentBeat: number;
  projectSnapshot: Project;
  folderSnapshot: AudioTakeFolder;
}>;

type TakeLabel = Readonly<{
  short: string;
  detail: string;
}>;

function formatBeat(beat: number): string {
  return Number(beat.toFixed(6)).toString();
}

function stoppedSuffix(playbackStopped: boolean): string {
  return playbackStopped
    ? ' 安全に更新するため再生を停止し、再生位置は保持しました。'
    : '';
}

function initialRangeDraft(folder: AudioTakeFolder | null): RangeDraft {
  const take = folder?.takes[0];
  if (!take) return { takeId: '', start: '0', end: '0' };
  return rangeDraftForTake(take);
}

function rangeDraftForTake(take: AudioTake): RangeDraft {
  return {
    takeId: take.id,
    start: formatBeat(take.offsetBeats),
    end: formatBeat(take.offsetBeats + take.lengthBeats),
  };
}

function boundaryDrafts(folder: AudioTakeFolder | null): Record<string, string> {
  if (!folder) return {};
  return Object.fromEntries(
    folder.compSegments.slice(0, -1).map((segment) => [
      segment.id,
      formatBeat(segment.offsetBeats + segment.lengthBeats),
    ]),
  );
}

function assetIssueMessage(issue: AudioAssetRuntimeIssue): string {
  switch (issue) {
    case 'missing':
      return '使っている音声素材が見つかりません。素材を再リンクしてから編集してください。';
    case 'changed':
      return '使っている音声素材が変更または破損しています。素材を確認してから編集してください。';
    case 'unavailable':
      return '使っている音声素材を現在読み込めません。素材を再リンクしてから編集してください。';
  }
}

export function audioTakeFolderAssetBlockReason(
  project: Project,
  folder: AudioTakeFolder,
  issues: Readonly<Record<string, AudioAssetRuntimeIssue>>,
): string | null {
  for (const take of folder.takes) {
    const asset = project.audioAssets.find(
      (candidate) => candidate.id === take.audioAssetId,
    );
    if (!asset) {
      return '使っている音声素材がプロジェクト内にありません。素材を再リンクしてから編集してください。';
    }
    if (asset.availability !== 'ready') {
      return '未解決の音声素材があります。素材を再リンクしてから編集してください。';
    }
    const issue = issues[asset.id];
    if (issue) return assetIssueMessage(issue);
  }
  return null;
}

export function nextTakeFocusId(
  takes: readonly AudioTake[],
  removedTakeId: string,
): string | null {
  const removedIndex = takes.findIndex((take) => take.id === removedTakeId);
  if (removedIndex < 0) return takes[0]?.id ?? null;
  return takes[removedIndex + 1]?.id
    ?? takes[removedIndex - 1]?.id
    ?? null;
}

function takeLabel(
  project: Project,
  take: AudioTake,
  takeIndex: number,
): TakeLabel {
  const asset = project.audioAssets.find(
    (candidate) => candidate.id === take.audioAssetId,
  );
  const fallback = `テイク ${takeIndex + 1}`;
  if (!asset || asset.availability !== 'ready') {
    return { short: fallback, detail: `${fallback}（未解決の音声素材）` };
  }
  const originalName = asset.originalName.trim();
  return {
    short: originalName || fallback,
    detail: originalName
      ? `${fallback}：${originalName}`
      : fallback,
  };
}

function beatFromPointer(
  event: Pick<PointerEvent<HTMLButtonElement>, 'clientX' | 'currentTarget'>,
  folder: AudioTakeFolder,
  take: AudioTake,
): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const fraction = rect.width > 0
    ? (event.clientX - rect.left) / rect.width
    : 0;
  const folderBeat = Math.min(1, Math.max(0, fraction)) * folder.lengthBeats;
  return Math.min(
    take.offsetBeats + take.lengthBeats,
    Math.max(take.offsetBeats, Number(folderBeat.toFixed(6))),
  );
}

function mutationBlockReason(
  projectOperationBusy: boolean,
  audioRecordingOperationId: number | null,
  savePending: boolean,
  assetReason: string | null,
): string | null {
  if (projectOperationBusy) {
    return 'プロジェクトを切り替えています。完了してからテイクを編集してください。';
  }
  if (audioRecordingOperationId !== null) {
    return '録音中はテイクを編集できません。録音を終了してからお試しください。';
  }
  if (savePending) {
    return 'プロジェクトを保存しています。保存が完了してからテイクを編集してください。';
  }
  return assetReason;
}

function resultNotice(
  result: StudioCompingCommandResult,
  successMessage: string,
): Notice {
  if (!result.ok) {
    return {
      kind: 'error',
      message: studioCompingErrorMessage(result.code),
    };
  }
  return {
    kind: 'status',
    message: result.changed
      ? `${successMessage}${stoppedSuffix(result.playbackStopped)}`
      : '仕上がりはすでにこの内容です。変更はありません。',
  };
}

export function TakeCompEditor() {
  const project = useStore((state) => state.project);
  const selectedTakeFolderId = useStore(
    (state) => state.editor.selectedTakeFolderId,
  );
  const selectTakeFolder = useStore((state) => state.selectTakeFolder);
  const projectOperationBusy = useStore((state) => state.projectOperationBusy);
  const audioRecordingOperationId = useStore(
    (state) => state.audioRecordingOperationId,
  );
  const savePending = useStore((state) => state.saveState.phase === 'pending');
  const audioAssetIssues = useStore((state) => state.audioAssetIssues);

  const folder = selectedTakeFolderId === null
    ? null
    : project.audioTakeFolders.find(
        (candidate) => candidate.id === selectedTakeFolderId,
      ) ?? null;
  const track = folder === null
    ? null
    : project.tracks.find((candidate) => candidate.id === folder.trackId) ?? null;

  const [rangeDraft, setRangeDraft] = useState<RangeDraft>(
    () => initialRangeDraft(folder),
  );
  const [boundaryValues, setBoundaryValues] = useState<Record<string, string>>(
    () => boundaryDrafts(folder),
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [focusTakeId, setFocusTakeId] = useState<string | null>(null);

  const dragPreviewRef = useRef<DragPreview | null>(null);
  const takeButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    setRangeDraft(initialRangeDraft(folder));
    setBoundaryValues(boundaryDrafts(folder));
    setNotice(null);
    setDragPreview(null);
    dragPreviewRef.current = null;
  }, [folder?.id]);

  useEffect(() => {
    setBoundaryValues(boundaryDrafts(folder));
  }, [folder?.compSegments]);

  useEffect(() => {
    const active = dragPreviewRef.current;
    if (
      active === null
      || (
        active.projectSnapshot === project
        && active.folderSnapshot === folder
      )
    ) {
      return;
    }
    dragPreviewRef.current = null;
    setDragPreview(null);
    setNotice({
      kind: 'status',
      message: '編集中にプロジェクトが変わったため、範囲選択を破棄しました。仕上がりは変更されていません。',
    });
  }, [folder, project]);

  useEffect(() => {
    if (focusTakeId === null) return;
    const target = takeButtonRefs.current.get(focusTakeId);
    // A project mutation immediately starts auto-save, which temporarily
    // disables take controls. Keep the focus request queued until the target
    // becomes interactive again instead of losing keyboard position.
    if (!target || target.disabled) return;
    target.focus();
    setFocusTakeId(null);
  }, [
    audioAssetIssues,
    audioRecordingOperationId,
    focusTakeId,
    folder?.takes,
    projectOperationBusy,
    savePending,
  ]);

  if (selectedTakeFolderId === null) {
    return (
      <section
        className="take-comp take-comp--message"
        aria-labelledby="take-comp-title"
      >
        <h3 id="take-comp-title">テイク編集</h3>
        {project.audioTakeFolders.length === 0 ? (
          <>
            <p>テイクフォルダーはまだありません。</p>
            <p>
              アレンジャーで同じ位置・長さのオーディオクリップを2つ以上まとめると、
              良い部分を選んで1つの仕上がりにできます。
            </p>
          </>
        ) : (
          <>
            <p>編集するテイクフォルダーを選んでください。</p>
            <ul className="take-comp__folder-list">
              {project.audioTakeFolders.map((candidate, index) => {
                const candidateTrack = project.tracks.find(
                  (item) => item.id === candidate.trackId,
                );
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => selectTakeFolder(candidate.id)}
                    >
                      {candidateTrack?.name ?? `オーディオトラック ${index + 1}`}：
                      {formatBeat(candidate.startBeat)}拍から
                      {formatBeat(candidate.lengthBeats)}拍
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    );
  }

  if (folder === null || track === null) {
    return (
      <section
        className="take-comp take-comp--message"
        aria-labelledby="take-comp-title"
      >
        <h3 id="take-comp-title">テイク編集</h3>
        <p role="alert">
          選択したテイクフォルダーを読み込めませんでした。アレンジャーから選び直してください。
        </p>
        <button type="button" onClick={() => selectTakeFolder(null)}>
          選択を解除
        </button>
      </section>
    );
  }

  if (folder.takes.length === 0) {
    return (
      <section
        className="take-comp take-comp--message"
        aria-labelledby="take-comp-title"
      >
        <h3 id="take-comp-title">テイク編集</h3>
        <p role="alert">
          このテイクフォルダーには編集できる音声がありません。プロジェクトを確認してください。
        </p>
      </section>
    );
  }

  const assetReason = audioTakeFolderAssetBlockReason(
    project,
    folder,
    audioAssetIssues,
  );
  const disabledReason = mutationBlockReason(
    projectOperationBusy,
    audioRecordingOperationId,
    savePending,
    assetReason,
  );
  const mutationsDisabled = disabledReason !== null;
  const selectedTake = folder.takes.find(
    (take) => take.id === rangeDraft.takeId,
  ) ?? folder.takes[0]!;
  const usedTakeIds = new Set(
    folder.compSegments.map((segment) => segment.takeId),
  );
  const labels = new Map(
    folder.takes.map((take, index) => [
      take.id,
      takeLabel(project, take, index),
    ]),
  );
  const previewStart = dragPreview
    ? Math.min(dragPreview.anchorBeat, dragPreview.currentBeat)
    : 0;
  const previewEnd = dragPreview
    ? Math.max(dragPreview.anchorBeat, dragPreview.currentBeat)
    : 0;
  const previewLabel = dragPreview
    ? labels.get(dragPreview.takeId) ?? null
    : null;
  const finishDescription = [
    `仕上がり。${folder.compSegments.length}区間`,
    ...folder.compSegments.map((segment) => {
      const label = labels.get(segment.takeId)?.detail
        ?? '不明なテイク';
      return `${label}、${formatBeat(segment.offsetBeats)}拍から${formatBeat(
        segment.offsetBeats + segment.lengthBeats,
      )}拍`;
    }),
    ...(dragPreview && previewLabel
      ? [
          `未確定プレビュー。${previewLabel.detail}、${formatBeat(
            previewStart,
          )}拍から${formatBeat(previewEnd)}拍`,
        ]
      : []),
  ].join('。');

  const setDrag = (next: DragPreview | null) => {
    dragPreviewRef.current = next;
    setDragPreview(next);
  };

  const completePaint = (
    takeId: string,
    start: number,
    end: number,
  ) => {
    const result = paintStudioAudioCompRange(
      folder.id,
      takeId,
      start,
      end - start,
    );
    setRangeDraft({
      takeId,
      start: formatBeat(start),
      end: formatBeat(end),
    });
    setNotice(resultNotice(result, '選んだ範囲を仕上がりに反映しました。'));
  };

  const submitExactRange = () => {
    const start = Number(rangeDraft.start);
    const end = Number(rangeDraft.end);
    if (
      rangeDraft.start.trim() === ''
      || rangeDraft.end.trim() === ''
      || !Number.isFinite(start)
      || !Number.isFinite(end)
      || end - start < MIN_EVENT_DURATION_BEATS
      || start < selectedTake.offsetBeats
      || end > selectedTake.offsetBeats + selectedTake.lengthBeats
      || start < 0
      || end > folder.lengthBeats
    ) {
      setNotice({
        kind: 'error',
        message: '開始と終了を、選んだテイクの範囲内で正しく入力してください。',
      });
      return;
    }
    completePaint(selectedTake.id, start, end);
  };

  return (
    <section className="take-comp" aria-labelledby="take-comp-title">
      <header className="take-comp__header">
        <div>
          <p className="take-comp__eyebrow">選択中のオーディオ</p>
          <h3 id="take-comp-title">{track.name}のテイク編集</h3>
          <p>
            {formatBeat(folder.startBeat)}拍から
            {formatBeat(folder.lengthBeats)}拍分。
            各テイクの良い範囲を選び、元の音声を消さずに仕上げます。
          </p>
        </div>
        <button type="button" onClick={() => selectTakeFolder(null)}>
          フォルダー一覧へ
        </button>
      </header>

      {disabledReason ? (
        <p
          id="take-comp-disabled-reason"
          className="take-comp__disabled-reason"
          role="note"
        >
          {disabledReason}
        </p>
      ) : null}

      <div
        className="take-comp__timeline-scroll"
        data-horizontal-scroll="timeline-only"
      >
        <div
          className="take-comp__timeline"
          style={{ minWidth: `${Math.max(640, folder.lengthBeats * 64)}px` }}
        >
          <div
            className="take-comp__finish-row"
            role="img"
            aria-label={finishDescription}
          >
            <strong className="take-comp__row-label">仕上がり</strong>
            <div className="take-comp__row-track" aria-hidden="true">
              {folder.compSegments.map((segment) => {
                const label = labels.get(segment.takeId)?.short
                  ?? '不明なテイク';
                return (
                  <span
                    key={segment.id}
                    className="take-comp__finish-segment"
                    data-comp-segment-id={segment.id}
                    style={{
                      left: `${(segment.offsetBeats / folder.lengthBeats) * 100}%`,
                      width: `${(segment.lengthBeats / folder.lengthBeats) * 100}%`,
                    }}
                  >
                    {label}
                  </span>
                );
              })}
              {dragPreview && previewLabel ? (
                <span
                  className="take-comp__drag-preview"
                  data-preview-start={formatBeat(previewStart)}
                  data-preview-end={formatBeat(previewEnd)}
                  aria-hidden="true"
                  style={{
                    left: `${(previewStart / folder.lengthBeats) * 100}%`,
                    width: `${(
                      (previewEnd - previewStart)
                      / folder.lengthBeats
                    ) * 100}%`,
                  }}
                >
                  {previewLabel.short}（プレビュー）
                </span>
              ) : null}
            </div>
          </div>

          <div
            className="take-comp__lanes"
            role="group"
            aria-label="録音テイク"
          >
            {folder.takes.map((take, index) => {
              const label = labels.get(take.id)!;
              const usedSegments = folder.compSegments.filter(
                (segment) => segment.takeId === take.id,
              );
              const takeUsed = usedSegments.length > 0;
              const takeStateLabel = takeUsed
                ? `採用中。${usedSegments.map((segment) => (
                    `${formatBeat(segment.offsetBeats)}拍から${formatBeat(
                      segment.offsetBeats + segment.lengthBeats,
                    )}拍`
                  )).join('、')}`
                : '未採用';
              const deleteReason = takeUsed
                ? '仕上がりで使っているため削除できません。'
                : folder.takes.length <= 2
                  ? 'テイク編集には2テイク以上必要です。'
                  : disabledReason;

              return (
                <div className="take-comp__take-row" key={take.id}>
                  <span className="take-comp__row-label" title={label.detail}>
                    {label.short}
                    <small className="take-comp__take-state">
                      ・{takeUsed ? '採用中' : '未採用'}
                    </small>
                  </span>
                  <button
                    ref={(node) => {
                      if (node) takeButtonRefs.current.set(take.id, node);
                      else takeButtonRefs.current.delete(take.id);
                    }}
                    type="button"
                    className={[
                      'take-comp__take-lane',
                      rangeDraft.takeId === take.id ? 'is-selected' : '',
                      takeUsed ? 'is-used' : 'is-unused',
                    ].filter(Boolean).join(' ')}
                    data-take-id={take.id}
                    data-comp-state={takeUsed ? 'used' : 'unused'}
                    aria-label={`${label.detail}。${takeStateLabel}。ドラッグして仕上がりに使う範囲を選択`}
                    aria-pressed={rangeDraft.takeId === take.id}
                    aria-describedby={
                      disabledReason ? 'take-comp-disabled-reason' : undefined
                    }
                    disabled={mutationsDisabled}
                    style={{ touchAction: 'none' }}
                    onClick={(event) => {
                      // Pointer selection is handled by the drag lifecycle above.
                      // Keep the synthetic click from replacing the committed
                      // range draft with the take's full available range.
                      if (event.detail !== 0) return;
                      setRangeDraft({
                        takeId: take.id,
                        start: formatBeat(take.offsetBeats),
                        end: formatBeat(take.offsetBeats + take.lengthBeats),
                      });
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                      const active = dragPreviewRef.current;
                      if (event.key !== 'Escape' || active?.takeId !== take.id) {
                        return;
                      }
                      event.preventDefault();
                      if (event.currentTarget.hasPointerCapture(active.pointerId)) {
                        event.currentTarget.releasePointerCapture(active.pointerId);
                      }
                      setDrag(null);
                      setNotice({
                        kind: 'status',
                        message: '範囲選択をキャンセルしました。仕上がりは変更されていません。',
                      });
                    }}
                    onPointerDown={(event) => {
                      if (mutationsDisabled || event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.focus();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const beat = beatFromPointer(event, folder, take);
                      setRangeDraft((current) => ({
                        ...current,
                        takeId: take.id,
                      }));
                      setDrag({
                        pointerId: event.pointerId,
                        takeId: take.id,
                        anchorBeat: beat,
                        currentBeat: beat,
                        projectSnapshot: project,
                        folderSnapshot: folder,
                      });
                    }}
                    onPointerMove={(event) => {
                      const active = dragPreviewRef.current;
                      if (
                        active?.takeId !== take.id
                        || active.pointerId !== event.pointerId
                      ) {
                        return;
                      }
                      setDrag({
                        ...active,
                        currentBeat: beatFromPointer(event, folder, take),
                      });
                    }}
                    onPointerUp={(event) => {
                      const active = dragPreviewRef.current;
                      if (
                        active?.takeId !== take.id
                        || active.pointerId !== event.pointerId
                      ) {
                        return;
                      }
                      event.preventDefault();
                      if (
                        active.projectSnapshot !== project
                        || active.folderSnapshot !== folder
                      ) {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                        setDrag(null);
                        setNotice({
                          kind: 'status',
                          message: '編集中にプロジェクトが変わったため、範囲選択を破棄しました。仕上がりは変更されていません。',
                        });
                        return;
                      }
                      const currentBeat = beatFromPointer(event, folder, take);
                      const start = Math.min(active.anchorBeat, currentBeat);
                      const end = Math.max(active.anchorBeat, currentBeat);
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      setDrag(null);
                      if (end - start < MIN_EVENT_DURATION_BEATS) {
                        setNotice({
                          kind: 'error',
                          message: '開始位置から終了位置までドラッグして範囲を選んでください。',
                        });
                        return;
                      }
                      completePaint(take.id, start, end);
                    }}
                    onPointerCancel={(event) => {
                      const active = dragPreviewRef.current;
                      if (
                        active?.takeId !== take.id
                        || active.pointerId !== event.pointerId
                      ) {
                        return;
                      }
                      setDrag(null);
                      setNotice({
                        kind: 'status',
                        message: '範囲選択をキャンセルしました。仕上がりは変更されていません。',
                      });
                    }}
                  >
                    <span
                      className="take-comp__available-range"
                      aria-hidden="true"
                      style={{
                        left: `${(take.offsetBeats / folder.lengthBeats) * 100}%`,
                        width: `${(take.lengthBeats / folder.lengthBeats) * 100}%`,
                      }}
                    />
                  </button>
                  <button
                    type="button"
                    className="take-comp__delete"
                    aria-label={`${label.detail}を削除`}
                    disabled={deleteReason !== null}
                    title={deleteReason ?? '仕上がりで使っていないテイクを削除'}
                    aria-describedby={
                      disabledReason ? 'take-comp-disabled-reason' : undefined
                    }
                    onClick={() => {
                      const nextFocus = nextTakeFocusId(folder.takes, take.id);
                      const result = deleteStudioUnusedAudioTake(folder.id, take.id);
                      setNotice(resultNotice(result, `${label.short}を削除しました。`));
                      if (!result.ok || !result.changed) return;
                      setRangeDraft((current) => (
                        current.takeId === take.id && nextFocus
                          ? rangeDraftForTake(
                              folder.takes.find(
                                (candidate) => candidate.id === nextFocus,
                              )!,
                            )
                          : current
                      ));
                      setFocusTakeId(nextFocus);
                    }}
                  >
                    削除
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <fieldset
        className="take-comp__exact-range"
        aria-describedby={
          disabledReason ? 'take-comp-disabled-reason' : undefined
        }
      >
        <legend>範囲を数値で指定</legend>
        <label>
          採用するテイク
          <select
            aria-label="採用するテイク"
            value={selectedTake.id}
            disabled={mutationsDisabled}
            onChange={(event) => {
              const take = folder.takes.find(
                (candidate) => candidate.id === event.currentTarget.value,
              );
              if (!take) return;
              setRangeDraft({
                takeId: take.id,
                start: formatBeat(take.offsetBeats),
                end: formatBeat(take.offsetBeats + take.lengthBeats),
              });
            }}
          >
            {folder.takes.map((take) => (
              <option value={take.id} key={take.id}>
                {labels.get(take.id)?.detail}
              </option>
            ))}
          </select>
        </label>
        <label>
          開始（拍）
          <input
            type="number"
            inputMode="decimal"
            min={selectedTake.offsetBeats}
            max={selectedTake.offsetBeats + selectedTake.lengthBeats}
            step={MIN_EVENT_DURATION_BEATS}
            value={rangeDraft.start}
            disabled={mutationsDisabled}
            onChange={(event) => setRangeDraft({
              ...rangeDraft,
              start: event.currentTarget.value,
            })}
          />
        </label>
        <label>
          終了（拍）
          <input
            type="number"
            inputMode="decimal"
            min={selectedTake.offsetBeats}
            max={selectedTake.offsetBeats + selectedTake.lengthBeats}
            step={MIN_EVENT_DURATION_BEATS}
            value={rangeDraft.end}
            disabled={mutationsDisabled}
            onChange={(event) => setRangeDraft({
              ...rangeDraft,
              end: event.currentTarget.value,
            })}
          />
        </label>
        <button
          type="button"
          className="take-comp__primary"
          disabled={mutationsDisabled}
          onClick={submitExactRange}
        >
          この範囲を採用
        </button>
      </fieldset>

      <fieldset
        className="take-comp__boundaries"
        aria-describedby={
          disabledReason ? 'take-comp-disabled-reason' : undefined
        }
      >
        <legend>つなぎ目を数値で調整</legend>
        {folder.compSegments.length < 2 ? (
          <p>仕上がりが1区間だけのため、調整するつなぎ目はありません。</p>
        ) : (
          folder.compSegments.slice(0, -1).map((leftSegment, index) => {
            const rightSegment = folder.compSegments[index + 1]!;
            const leftName = labels.get(leftSegment.takeId)?.short
              ?? '不明なテイク';
            const rightName = labels.get(rightSegment.takeId)?.short
              ?? '不明なテイク';
            const value = boundaryValues[leftSegment.id]
              ?? formatBeat(rightSegment.offsetBeats);
            return (
              <div className="take-comp__boundary-row" key={leftSegment.id}>
                <label>
                  {leftName} → {rightName} のつなぎ目（拍）
                  <input
                    type="number"
                    inputMode="decimal"
                    data-boundary-after={leftSegment.id}
                    min={leftSegment.offsetBeats + MIN_EVENT_DURATION_BEATS}
                    max={
                      rightSegment.offsetBeats
                      + rightSegment.lengthBeats
                      - MIN_EVENT_DURATION_BEATS
                    }
                    step={MIN_EVENT_DURATION_BEATS}
                    value={value}
                    disabled={mutationsDisabled}
                    onChange={(event) => setBoundaryValues({
                      ...boundaryValues,
                      [leftSegment.id]: event.currentTarget.value,
                    })}
                  />
                </label>
                <button
                  type="button"
                  disabled={mutationsDisabled}
                  onClick={() => {
                    const beat = Number(value);
                    if (value.trim() === '' || !Number.isFinite(beat)) {
                      setNotice({
                        kind: 'error',
                        message: 'つなぎ目の位置を数値で入力してください。',
                      });
                      return;
                    }
                    const result = moveStudioAudioCompBoundary(
                      folder.id,
                      leftSegment.id,
                      beat,
                    );
                    setNotice(resultNotice(result, 'つなぎ目を移動しました。'));
                  }}
                >
                  つなぎ目を反映
                </button>
              </div>
            );
          })
        )}
      </fieldset>

      <p
        className="take-comp__status"
        role={notice?.kind === 'error' ? 'alert' : 'status'}
        aria-live="polite"
      >
        {notice?.message ?? ''}
      </p>
      <details className="take-comp__help">
        <summary>操作のヒント</summary>
        <p>
          テイクの帯を左右にドラッグすると、その範囲だけを仕上がりに採用します。
          数値入力なら開始と終了を正確に指定できます。元のテイクは変更されません。
        </p>
        <p>ドラッグ中に Escape を押すと、仕上がりを変えずにキャンセルできます。</p>
      </details>
    </section>
  );
}
