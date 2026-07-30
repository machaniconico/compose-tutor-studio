import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  createLinearAudioWarp,
  type AudioClip,
  type AudioWarp,
  type AudioWarpEditErrorCode,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { setStudioAudioClipWarp } from '../../state/audioTrackActions';
import { useStore } from '../../state/store';
import { AudioTimingEditor } from './AudioTimingEditor';
import { AudioPitchCorrectionEditor } from './AudioPitchCorrectionEditor';

export type AudioWarpEditorNotice = Readonly<{
  kind: 'status' | 'error';
  message: string;
}>;

export function audioWarpEditErrorMessage(code: AudioWarpEditErrorCode): string {
  switch (code) {
    case 'marker-limit':
      return 'タイミング点は128個までです。不要な点を削除してから追加してください。';
    case 'endpoint-marker':
      return '素材の始点と終点は移動または削除できません。';
    case 'invalid-marker':
      return 'タイミング点は前後の点から40 ms以上離し、順番を保ってください。';
    case 'pitch-region-limit':
      return '音程補正区間は128個までです。不要な区間を削除してから分割してください。';
    case 'region-not-found':
      return '選択した音程区間が見つかりません。区間を選び直してください。';
    case 'invalid-pitch-region':
      return '隣り合い、音程と補正量が同じ区間だけを結合できます。';
  }
}

export function linearAudioWarp(clip: AudioClip): AudioWarp {
  return createLinearAudioWarp(clip);
}

type Props = Readonly<{
  project: Project;
  clip: AudioClip;
  asset: ReadyAudioAsset | null;
  disabledReason: string | null;
  busyReason?: string | null;
  activationId?: string;
}>;

const tabs = ['timing', 'pitch'] as const;
type Tab = (typeof tabs)[number];

export function AudioWarpPitchEditor({
  project,
  clip,
  asset,
  disabledReason,
  busyReason = null,
  activationId = useStore.getState().saveState.activationId,
}: Props) {
  const [tab, setTab] = useState<Tab>('timing');
  const [notice, setNotice] = useState<AudioWarpEditorNotice | null>(null);
  const timingId = useId();
  const pitchId = useId();
  const reasonId = useId();
  const warp = clip.audioWarp ?? linearAudioWarp(clip);
  const blockedReason = busyReason ?? disabledReason;
  const interactionDisabled = busyReason !== null;
  const lastFocusedControl = useRef<HTMLElement | null>(null);
  const wasInteractionDisabled = useRef(interactionDisabled);
  const interactionIdentity = `${activationId}:${project.id}:${clip.id}`;
  const disabledIdentity = useRef<string | null>(
    interactionDisabled ? interactionIdentity : null,
  );
  const [auditionClipId, setAuditionClipId] = useState(
    () => useStore.getState().audioWarpAuditionClipId,
  );

  const selectTab = (next: Tab): void => {
    if (interactionDisabled) return;
    setTab(next);
    requestAnimationFrame(() => {
      document.getElementById(next === 'timing' ? timingId : pitchId)?.focus();
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (interactionDisabled) return;
    const current = tabs.indexOf(tab);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[next]!);
  };

  const commit = (next: AudioWarp | undefined, message: string): boolean => {
    if (blockedReason) {
      setNotice({ kind: 'error', message: blockedReason });
      return false;
    }
    const result = setStudioAudioClipWarp(clip.id, next, {
      project,
      clip,
      activationId,
      audioAssetId: asset?.id ?? '',
    });
    if (!result.ok) {
      setNotice({
        kind: 'error',
        message: '音声補正を反映できませんでした。クリップを選び直してお試しください。',
      });
      return false;
    }
    if (!result.changed) return false;
    setNotice({
      kind: 'status',
      message: `${message}${result.playbackStopped ? ' 再生を停止し、再生位置は保持しました。' : ''}`,
    });
    return true;
  };

  useEffect(() => {
    const wasDisabled = wasInteractionDisabled.current;
    wasInteractionDisabled.current = interactionDisabled;
    if (!wasDisabled && interactionDisabled) {
      disabledIdentity.current = interactionIdentity;
      return;
    }
    if (!wasDisabled || interactionDisabled) return;
    const canRestore = disabledIdentity.current === interactionIdentity;
    disabledIdentity.current = null;
    if (!canRestore) return;
    requestAnimationFrame(() => {
      const target = lastFocusedControl.current;
      const active = document.activeElement;
      if (
        active
        && active !== document.body
        && active !== document.documentElement
      ) {
        return;
      }
      if (
        target?.isConnected
        && !('disabled' in target && Boolean(target.disabled))
      ) {
        target.focus({ preventScroll: true });
      }
    });
  }, [interactionDisabled, interactionIdentity]);
  useEffect(() => useStore.subscribe((next, previous) => {
    if (next.audioWarpAuditionClipId !== previous.audioWarpAuditionClipId) {
      setAuditionClipId(next.audioWarpAuditionClipId);
    }
  }), []);

  return (
    <div className="audio-warp-editor">
      <details>
        <summary
          aria-disabled={blockedReason !== null}
          aria-describedby={blockedReason ? reasonId : undefined}
          onClick={(event) => {
            if (blockedReason) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (blockedReason && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
            }
          }}
        >
          <span>音声を整える</span>
          <small>元の音声を変更せず、タイミングと一音ずつの音程を補正します。</small>
        </summary>
        {!disabledReason && asset ? (
        <div
          className="audio-warp-editor__body"
          aria-disabled={busyReason !== null ? true : undefined}
          aria-describedby={busyReason ? reasonId : undefined}
          onFocusCapture={(event) => {
            lastFocusedControl.current = event.target as HTMLElement;
          }}
        >
          <div className="audio-warp-editor__tabs" role="tablist" aria-label="音声補正の種類">
            <button
              id={timingId}
              type="button"
              role="tab"
              aria-selected={tab === 'timing'}
              aria-controls={`${timingId}-panel`}
              tabIndex={tab === 'timing' ? 0 : -1}
              disabled={interactionDisabled}
              onClick={() => setTab('timing')}
              onKeyDown={onTabKeyDown}
            >
              タイミング
            </button>
            <button
              id={pitchId}
              type="button"
              role="tab"
              aria-selected={tab === 'pitch'}
              aria-controls={`${pitchId}-panel`}
              tabIndex={tab === 'pitch' ? 0 : -1}
              disabled={interactionDisabled}
              onClick={() => setTab('pitch')}
              onKeyDown={onTabKeyDown}
            >
              単音ピッチ
            </button>
          </div>

          <div
            id={`${timingId}-panel`}
            role="tabpanel"
            aria-labelledby={timingId}
            hidden={tab !== 'timing'}
          >
            <AudioTimingEditor
              clip={clip}
              warp={warp}
              disabled={interactionDisabled}
              onCommit={commit}
              onReject={(code) => setNotice({
                kind: 'error',
                message: audioWarpEditErrorMessage(code),
              })}
            />
          </div>
          <div
            id={`${pitchId}-panel`}
            role="tabpanel"
            aria-labelledby={pitchId}
            hidden={tab !== 'pitch'}
          >
            <AudioPitchCorrectionEditor
              project={project}
              clip={clip}
              asset={asset}
              warp={warp}
              disabled={interactionDisabled}
              comparePitchBefore={auditionClipId === clip.id}
              onComparePitchBeforeChange={(beforeCorrection) =>
                useStore.getState().setAudioWarpAuditionClipId(
                  beforeCorrection ? clip.id : null,
                )}
              onCommit={commit}
              onNotice={setNotice}
              onReject={(code) => setNotice({
                kind: 'error',
                message: audioWarpEditErrorMessage(code),
              })}
            />
          </div>

        </div>
        ) : null}
      </details>
      {blockedReason ? (
        <p id={reasonId} className="audio-warp-editor__disabled-reason">{blockedReason}</p>
      ) : null}
      {notice ? (
        <p
          className={`audio-warp-editor__notice${notice.kind === 'error' ? ' is-error' : ''}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
        >
          {notice.message}
        </p>
      ) : (
        <p className="sr-only" role="status" aria-live="polite" />
      )}
    </div>
  );
}
