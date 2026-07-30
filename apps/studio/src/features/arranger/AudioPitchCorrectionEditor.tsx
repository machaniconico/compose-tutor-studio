import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  mergeAudioPitchRegions,
  splitAudioPitchRegion,
  type AudioClip,
  type AudioPitchRegion,
  type AudioWarp,
  type AudioWarpEditErrorCode,
  type Project,
  type ReadyAudioAsset,
} from '@cts/project-model';
import { isInScale } from '@cts/theory-engine';
import {
  analyzeAudioClipPitch,
  audioClipAnalysisErrorMessage,
  AudioClipAnalysisError,
  MIN_AUDIO_CLIP_PITCH_REGION_FRAMES,
  type AudioClipAnalysisResult,
  type AudioClipPitchCandidate,
} from '../../audio/audioClipAnalysis';
import {
  getAudioAssetBytesResolver,
  getAudioAssetPlaybackCache,
} from '../../audio/audioAssetResolver';
import { useStore } from '../../state/store';
import type { AudioWarpEditorNotice } from './AudioWarpPitchEditor';

type Props = Readonly<{
  project: Project;
  clip: AudioClip;
  asset: ReadyAudioAsset;
  warp: AudioWarp;
  onCommit: (warp: AudioWarp | undefined, message: string) => boolean;
  onNotice: (notice: AudioWarpEditorNotice | null) => void;
  onReject?: (code: AudioWarpEditErrorCode) => void;
  disabled: boolean;
  comparePitchBefore: boolean;
  onComparePitchBeforeChange: (beforeCorrection: boolean) => boolean;
}>;

const confidenceLabel = (confidence: number): string =>
  confidence < 0.65 ? '信頼度が低い' : confidence < 0.85 ? '信頼度は中程度' : '信頼度が高い';

function persistedCandidates(
  regions: readonly AudioPitchRegion[],
): readonly AudioClipPitchCandidate[] {
  return regions.map((region) => ({ ...region, confidence: 1 }));
}

function stripCandidate(region: AudioClipPitchCandidate): AudioPitchRegion {
  const { confidence: _confidence, ...persisted } = region;
  return persisted;
}

function closestScaleMidi(midi: number, project: Project): number {
  const rounded = Math.round(midi);
  for (let distance = 0; distance <= 3; distance += 1) {
    for (const candidate of distance === 0
      ? [rounded]
      : [rounded - distance, rounded + distance]) {
      if (isInScale(candidate, project.key, project.scale)) return candidate;
    }
  }
  return rounded;
}

type PitchDisplayRange = Readonly<{
  low: number;
  high: number;
  guides: readonly number[];
}>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function timelinePercent(seconds: number, durationSeconds: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  return clamp(seconds / durationSeconds * 100, 0, 100);
}

function waveformY(value: number): number {
  return clamp(50 - clamp(Number.isFinite(value) ? value : 0, -1, 1) * 45, 5, 95);
}

function pitchDisplayRange(
  analysis: AudioClipAnalysisResult,
  regions: readonly AudioClipPitchCandidate[],
): PitchDisplayRange {
  const pitches = [
    ...analysis.pitchFrames.flatMap((frame) => frame.midi === null ? [] : [frame.midi]),
    ...regions.flatMap((candidate) => [
      candidate.sourcePitchCents / 100,
      candidate.targetPitchCents / 100,
    ]),
  ].filter(Number.isFinite);
  const minimum = pitches.length > 0 ? Math.min(...pitches) : 60;
  const maximum = pitches.length > 0 ? Math.max(...pitches) : 60;
  let low = clamp(Math.floor(minimum) - 2, 0, 126);
  let high = clamp(Math.ceil(maximum) + 2, 1, 127);
  if (high <= low) {
    low = clamp(low - 1, 0, 126);
    high = low + 1;
  }
  return {
    low,
    high,
    guides: Array.from({ length: high - low + 1 }, (_, index) => low + index),
  };
}

function pitchY(midi: number, range: PitchDisplayRange): number {
  return clamp(100 - (midi - range.low) / Math.max(1, range.high - range.low) * 100, 0, 100);
}

/** Pure, bounded SVG path used by the local pitch-analysis view and its tests. */
export function audioClipPitchTracePath(
  analysis: AudioClipAnalysisResult,
  regions: readonly AudioClipPitchCandidate[] = analysis.regions,
): string {
  const range = pitchDisplayRange(analysis, regions);
  const commands: string[] = [];
  let beginsSubpath = true;
  for (const frame of analysis.pitchFrames) {
    if (frame.midi === null || !Number.isFinite(frame.midi)) {
      beginsSubpath = true;
      continue;
    }
    const midpoint = (frame.startSeconds + frame.endSeconds) / 2;
    commands.push(
      `${beginsSubpath ? 'M' : 'L'} ${timelinePercent(
        midpoint,
        analysis.durationSeconds,
      ).toFixed(4)} ${pitchY(frame.midi, range).toFixed(4)}`,
    );
    beginsSubpath = false;
  }
  return commands.join(' ');
}

export function isAudioClipAnalysisSnapshotCurrent(
  requestGeneration: number,
  currentGeneration: number,
  snapshotProject: Project,
  latestProject: Project,
  expectedProjectId: string,
  snapshotActivationId: string,
  latestActivationId: string,
): boolean {
  return requestGeneration === currentGeneration
    && latestProject === snapshotProject
    && latestProject.id === expectedProjectId
    && latestActivationId === snapshotActivationId;
}

export function AudioPitchCorrectionEditor({
  project,
  clip,
  asset,
  warp,
  onCommit,
  onNotice,
  onReject = () => undefined,
  disabled,
  comparePitchBefore,
  onComparePitchBeforeChange,
}: Props) {
  const [analysis, setAnalysis] = useState<AudioClipAnalysisResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'analyzing'>('idle');
  const [progress, setProgress] = useState(0);
  const [selected, setSelected] = useState(0);
  const [zoom, setZoom] = useState(1);
  const generation = useRef(0);
  const disabledRef = useRef(disabled);
  const abort = useRef<AbortController | null>(null);
  const analyzeButton = useRef<HTMLButtonElement>(null);
  const regionButtons = useRef(new Map<number, HTMLButtonElement>());
  const pendingFocus = useRef<number | 'analyze' | null>(null);
  const regions = warp.pitchRegions.length > 0
    ? persistedCandidates(warp.pitchRegions)
    : analysis?.regions ?? [];
  const selectedIndex = Math.max(0, Math.min(selected, regions.length - 1));
  const region = regions[selectedIndex];

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    disabledRef.current = disabled;
    if (!disabled) return;
    generation.current += 1;
    abort.current?.abort();
    abort.current = null;
    setPhase('idle');
    setProgress(0);
  }, [disabled]);
  useEffect(() => () => {
    const state = useStore.getState();
    if (state.audioWarpAuditionClipId === clip.id) {
      state.setAudioWarpAuditionClipId(null);
    }
  }, [clip.id]);
  useEffect(() => {
    setAnalysis(null);
    setSelected(0);
    generation.current += 1;
    abort.current?.abort();
    abort.current = null;
    setPhase('idle');
    setProgress(0);
  }, [clip.id, clip.audioAssetId, clip.sourceStartFrame, clip.sourceFrameCount]);
  useEffect(() => {
    if (disabled) return;
    const requested = pendingFocus.current;
    if (requested === null) return;
    pendingFocus.current = null;
    if (requested === 'analyze' || regions.length === 0) {
      requestAnimationFrame(() => analyzeButton.current?.focus());
      return;
    }
    const next = Math.max(0, Math.min(requested, regions.length - 1));
    setSelected(next);
    requestAnimationFrame(() => regionButtons.current.get(next)?.focus());
  }, [analysis, disabled, warp.pitchRegions]);

  const focus = (index: number): void => {
    const next = Math.max(0, Math.min(index, regions.length - 1));
    setSelected(next);
    requestAnimationFrame(() => regionButtons.current.get(next)?.focus());
  };

  const focusAfterRender = (target: number | 'analyze'): void => {
    pendingFocus.current = target;
    if (typeof target === 'number') setSelected(Math.max(0, target));
  };

  const commitRegions = (
    nextRegions: readonly AudioPitchRegion[],
    message: string,
  ): boolean => {
    const nextWarp = { ...warp, pitchRegions: nextRegions };
    const isLinearTiming = nextWarp.markers.length === 2
      && nextWarp.markers[0]?.sourceFrame === clip.sourceStartFrame
      && nextWarp.markers[0]?.targetBeatOffset === 0
      && nextWarp.markers[1]?.sourceFrame === clip.sourceStartFrame + clip.sourceFrameCount
      && nextWarp.markers[1]?.targetBeatOffset === clip.lengthBeats;
    return onCommit(
      nextRegions.length === 0 && isLinearTiming ? undefined : nextWarp,
      message,
    );
  };

  const commitRegionsWithFocus = (
    nextRegions: readonly AudioPitchRegion[],
    message: string,
    target: number | 'analyze',
  ): boolean => {
    focusAfterRender(target);
    if (commitRegions(nextRegions, message)) return true;
    pendingFocus.current = null;
    focus(selectedIndex);
    return false;
  };

  const baseRegions = (): AudioPitchRegion[] => regions.map(stripCandidate);

  const removeSelectedRegion = (index = selectedIndex): void => {
    if (disabled || !regions[index]) return;
    const next = baseRegions().filter((_, itemIndex) => itemIndex !== index);
    const nextFocus = next.length > 0 ? Math.min(index, next.length - 1) : 'analyze';
    if (warp.pitchRegions.length > 0) {
      commitRegionsWithFocus(
        next,
        '音程補正区間を削除しました。',
        nextFocus,
      );
      return;
    }
    focusAfterRender(nextFocus);
    setAnalysis((current) => current === null
      ? null
      : Object.freeze({
          ...current,
          regions: Object.freeze(
            current.regions.filter((_, itemIndex) => itemIndex !== index),
          ),
        }));
    onNotice({
      kind: 'status',
      message: '解析候補を外しました。まだプロジェクトは変更していません。',
    });
  };

  const updateSelected = (
    changes: Partial<Pick<AudioPitchRegion, 'targetPitchCents' | 'correctionAmount'>>,
    message: string,
  ): void => {
    if (disabled || !region) return;
    const next = baseRegions();
    next[selectedIndex] = { ...next[selectedIndex]!, ...changes };
    commitRegions(next, message);
  };

  const runAnalysis = async (): Promise<void> => {
    if (disabled || disabledRef.current) return;
    const resolver = getAudioAssetBytesResolver();
    if (!resolver) {
      onNotice({ kind: 'error', message: '端末内の音声素材を読み出せないため解析できません。' });
      analyzeButton.current?.focus();
      return;
    }
    const snapshot = useStore.getState();
    const snapshotProject = snapshot.project;
    const snapshotClip = snapshotProject.tracks
      .flatMap((track) => track.clips)
      .find((candidate): candidate is AudioClip =>
        candidate.type === 'audio'
        && candidate.id === clip.id
        && candidate.audioAssetId === asset.id);
    const snapshotAsset = snapshotProject.audioAssets
      .find((candidate): candidate is ReadyAudioAsset =>
        candidate.id === asset.id && candidate.availability === 'ready');
    if (
      snapshotProject !== project
      || !snapshotClip
      || !snapshotAsset
    ) {
      onNotice({
        kind: 'error',
        message: 'クリップまたはプロジェクトが変わったため、解析を開始しませんでした。',
      });
      requestAnimationFrame(() => analyzeButton.current?.focus());
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const requestGeneration = ++generation.current;
    const activationId = snapshot.saveState.activationId;
    setPhase('analyzing');
    setProgress(0);
    onNotice(null);
    try {
      const prepared = await getAudioAssetPlaybackCache().preflight(
        snapshotProject,
        resolver,
        controller.signal,
      );
      const preparedAsset = prepared.assets.find(
        (item) => item.asset.id === snapshotAsset.id,
      );
      if (!preparedAsset) throw new AudioClipAnalysisError('invalid-clip');
      const result = await analyzeAudioClipPitch(
        preparedAsset.bytes,
        snapshotAsset,
        snapshotClip,
        {
        signal: controller.signal,
        onProgress: (value) => setProgress(value.fraction),
        // Keep the browser responsive even for short clips. The shared humming
        // analyzer's larger batch default is appropriate for non-interactive
        // callers, but can otherwise finish a ~1 second clip before the cancel
        // control gets an event-loop turn.
        chunkSamples: 8_192,
        },
      );
      const latest = useStore.getState();
      if (!isAudioClipAnalysisSnapshotCurrent(
        requestGeneration,
        generation.current,
        snapshotProject,
        latest.project,
        snapshotProject.id,
        activationId,
        latest.saveState.activationId,
      ) || disabledRef.current) {
        onNotice({
          kind: 'error',
          message: disabledRef.current
            ? '保存処理が始まったため、解析結果を反映しませんでした。'
            : '解析中にクリップまたはプロジェクトが変わったため、結果を反映しませんでした。',
        });
        requestAnimationFrame(() => analyzeButton.current?.focus());
        return;
      }
      focusAfterRender(result.regions.length > 0 ? 0 : 'analyze');
      setAnalysis(result);
      setSelected(0);
      onNotice({
        kind: 'status',
        message: `${result.regions.length}個の単音区間を解析しました。まだプロジェクトは変更していません。`,
      });
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      const code = error instanceof AudioClipAnalysisError
        ? error.code
        : controller.signal.aborted ? 'cancelled' : 'analysis-failed';
      onNotice({ kind: code === 'cancelled' ? 'status' : 'error', message: audioClipAnalysisErrorMessage(code) });
      requestAnimationFrame(() => analyzeButton.current?.focus());
    } finally {
      if (requestGeneration === generation.current) {
        setPhase('idle');
        setProgress(0);
        abort.current = null;
      }
    }
  };

  const onRegionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (disabled) return;
    if (event.key === 'PageUp') focus(index - 1);
    else if (event.key === 'PageDown') focus(index + 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(regions.length - 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const current = regions[index];
      if (!current) return;
      const semitone = Math.round(current.targetPitchCents / 100)
        + (event.key === 'ArrowUp' ? 1 : -1);
      updateSelected(
        { targetPitchCents: semitone * 100 },
        '目標音程を変更しました。',
      );
      return;
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeSelectedRegion(index);
      return;
    } else return;
    event.preventDefault();
  };

  const splitSelected = (): void => {
    if (disabled || !region) return;
    if (region.sourceFrameCount < MIN_AUDIO_CLIP_PITCH_REGION_FRAMES * 2) {
      onReject('invalid-pitch-region');
      focus(selectedIndex);
      return;
    }
    const candidateWarp = { ...warp, pitchRegions: baseRegions() };
    const splitFrame = region.sourceStartFrame + Math.round(region.sourceFrameCount / 2);
    const result = splitAudioPitchRegion(candidateWarp, selectedIndex, splitFrame);
    if (!result.ok) {
      onReject(result.error.code);
      focus(selectedIndex);
      return;
    }
    if (result.changed) {
      commitRegionsWithFocus(
        result.audioWarp.pitchRegions,
        '音程補正区間を分割しました。',
        selectedIndex + 1,
      );
    }
  };

  const mergeNext = (): void => {
    if (disabled || !region || selectedIndex >= regions.length - 1) return;
    const result = mergeAudioPitchRegions(
      { ...warp, pitchRegions: baseRegions() },
      selectedIndex,
    );
    if (!result.ok) {
      onReject(result.error.code);
      focus(selectedIndex);
      return;
    }
    if (result.changed) {
      commitRegionsWithFocus(
        result.audioWarp.pitchRegions,
        '次の音程補正区間と結合しました。',
        selectedIndex,
      );
    }
  };

  const analysisRange = analysis ? pitchDisplayRange(analysis, regions) : null;
  const tracePath = analysis ? audioClipPitchTracePath(analysis, regions) : '';
  const canComparePitch = clip.audioWarp?.pitchEnabled === true
    && clip.audioWarp.pitchRegions.length > 0;
  const selectAudition = (beforeCorrection: boolean): void => {
    if (disabled || beforeCorrection === comparePitchBefore) return;
    if (!onComparePitchBeforeChange(beforeCorrection)) {
      onNotice({
        kind: 'error',
        message: 'A/B試聴を切り替えられませんでした。保存や録音が終わってからお試しください。',
      });
      return;
    }
    onNotice({
      kind: 'status',
      message: beforeCorrection
        ? 'A/Bをピッチ補正前へ切り替えました。メインの再生で確認できます。'
        : 'A/Bを補正後へ切り替えました。メインの再生で確認できます。',
    });
  };
  const cursorLeft = region
    ? ((region.sourceStartFrame + region.sourceFrameCount / 2 - clip.sourceStartFrame)
        / clip.sourceFrameCount) * 100
    : null;

  return (
    <section className="audio-pitch-editor" aria-label="単音ピッチ補正">
      <p className="audio-pitch-editor__limitation">
        歌声やベースなど、一度に一音だけ鳴る素材向けです。和音や複数人の声は正しく解析できません。
      </p>
      <div className="audio-warp-editor__toolbar">
        <button
          ref={analyzeButton}
          type="button"
          disabled={disabled || phase === 'analyzing'}
          onClick={() => void runAnalysis()}
        >
          音程をローカル解析
        </button>
        <button
          type="button"
          disabled={disabled || phase !== 'analyzing'}
          onClick={() => {
            if (disabled) return;
            generation.current += 1;
            abort.current?.abort();
            abort.current = null;
            setPhase('idle');
            setProgress(0);
            onNotice({
              kind: 'status',
              message: audioClipAnalysisErrorMessage('cancelled'),
            });
            requestAnimationFrame(() => analyzeButton.current?.focus());
          }}
        >
          解析をキャンセル
        </button>
        <label>
          <span>表示倍率</span>
          <input
            type="range"
            min="1"
            max="4"
            step="0.5"
            value={zoom}
            disabled={disabled}
            onChange={(event) => {
              if (!disabled) setZoom(Number(event.target.value));
            }}
          />
        </label>
        <div
          className="audio-pitch-editor__ab"
          role="group"
          aria-label="A/Bピッチ試聴"
        >
          <button
            type="button"
            aria-pressed={comparePitchBefore}
            disabled={disabled || !canComparePitch}
            onClick={() => selectAudition(true)}
          >
            ピッチ補正前
          </button>
          <button
            type="button"
            aria-pressed={!comparePitchBefore}
            disabled={disabled}
            onClick={() => selectAudition(false)}
          >
            補正後
          </button>
        </div>
      </div>
      <div
        className="audio-pitch-editor__progress"
        aria-busy={phase === 'analyzing'}
        aria-live="polite"
      >
        {phase === 'analyzing' ? (
          <>
            <progress value={progress} max={1} aria-label="音程解析の進行状況" />
            <span>端末内で解析中… {Math.round(progress * 100)}%</span>
          </>
        ) : null}
      </div>

      <div className="audio-warp-editor__timeline-scroll">
        <div
          className="audio-warp-editor__timeline audio-pitch-editor__timeline"
          style={{ width: `max(640px, ${Math.max(100, zoom * 100)}%)` }}
          aria-label="解析した単音区間"
        >
          {analysis && analysisRange ? (
            <>
              <svg
                className="audio-pitch-editor__waveform"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
                data-analysis-waveform
              >
                {analysis.waveform.map((bin, index) => {
                  const start = timelinePercent(bin.startSeconds, analysis.durationSeconds);
                  const end = timelinePercent(bin.endSeconds, analysis.durationSeconds);
                  return (
                    <line
                      key={`${index}-${bin.startSeconds}`}
                      x1={start}
                      x2={end}
                      y1={waveformY(bin.max)}
                      y2={waveformY(bin.min)}
                    />
                  );
                })}
              </svg>
              <svg
                className="audio-pitch-editor__pitch-curve"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
                data-analysis-pitch-trace
              >
                {analysisRange.guides.map((midi) => (
                  <line
                    key={midi}
                    className="audio-pitch-editor__semitone-guide"
                    x1="0"
                    x2="100"
                    y1={pitchY(midi, analysisRange)}
                    y2={pitchY(midi, analysisRange)}
                  />
                ))}
                {tracePath ? (
                  <path className="audio-pitch-editor__pitch-trace" d={tracePath} />
                ) : null}
              </svg>
            </>
          ) : null}
          {cursorLeft !== null ? (
            <span
              className="audio-pitch-editor__cursor"
              style={{ left: `${cursorLeft}%` }}
              aria-hidden="true"
              data-analysis-cursor
            />
          ) : null}
          {regions.map((candidate, index) => {
            const left = ((candidate.sourceStartFrame - clip.sourceStartFrame)
              / clip.sourceFrameCount) * 100;
            const width = (candidate.sourceFrameCount / clip.sourceFrameCount) * 100;
            const midpoint = left + width / 2;
            const lowConfidence = candidate.confidence < 0.65;
            return (
              <button
                key={`${candidate.sourceStartFrame}-${candidate.sourceFrameCount}`}
                ref={(node) => {
                  if (node) regionButtons.current.set(index, node);
                  else regionButtons.current.delete(index);
                }}
                type="button"
                disabled={disabled}
                className={`audio-pitch-editor__region${selectedIndex === index ? ' is-selected' : ''}${lowConfidence ? ' is-low-confidence' : ''}`}
                style={{
                  left: `clamp(22px, ${midpoint}%, calc(100% - 22px))`,
                  width: `${Math.max(2, width)}%`,
                }}
                tabIndex={selectedIndex === index ? 0 : -1}
                aria-pressed={selectedIndex === index}
                aria-label={`音程区間 ${index + 1}、${Math.round(candidate.targetPitchCents / 100)}半音、${confidenceLabel(candidate.confidence)}`}
                onFocus={() => setSelected(index)}
                onClick={() => setSelected(index)}
                onKeyDown={(event) => onRegionKeyDown(event, index)}
              >
                <span>{Math.round(candidate.targetPitchCents / 100)}</span>
                {lowConfidence ? <small>要確認</small> : null}
              </button>
            );
          })}
          {regions.length === 0 ? (
            <p className="audio-pitch-editor__empty">解析すると単音区間がここに表示されます。</p>
          ) : null}
        </div>
      </div>

      {region ? (
        <div className="audio-warp-editor__inspector" aria-label="選択音程区間のインスペクター">
          <div>
            <strong>区間 {selectedIndex + 1}</strong>
            <span className={region.confidence < 0.65 ? 'is-low-confidence' : ''}>
              {confidenceLabel(region.confidence)}
              {region.confidence < 0.65 ? '（目と耳で確認してください）' : ''}
            </span>
          </div>
          <label>
            <span>目標音程（MIDI半音）</span>
            <input
              type="number"
              step="1"
              min={Math.ceil(region.sourcePitchCents / 100 - 3)}
              max={Math.floor(region.sourcePitchCents / 100 + 3)}
              value={Math.round(region.targetPitchCents / 100)}
              disabled={disabled}
              onChange={(event) => updateSelected(
                { targetPitchCents: Number(event.target.value) * 100 },
                '目標音程を変更しました。',
              )}
            />
          </label>
          <label>
            <span>補正量（0〜100%）</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(region.correctionAmount * 100)}
              disabled={disabled}
              onChange={(event) => updateSelected(
                { correctionAmount: Number(event.target.value) / 100 },
                '音程の補正量を変更しました。',
              )}
            />
          </label>
          <div className="audio-warp-editor__toolbar" role="group" aria-label="音程区間操作">
            <button
              type="button"
              disabled={
                disabled
                || region.sourceFrameCount < MIN_AUDIO_CLIP_PITCH_REGION_FRAMES * 2
              }
              onClick={splitSelected}
            >
              区間を分割
            </button>
            <button
              type="button"
              disabled={disabled || selectedIndex >= regions.length - 1}
              onClick={mergeNext}
            >
              次と結合
            </button>
            <button
              type="button"
              disabled={disabled || regions.length === 0}
              onClick={() => removeSelectedRegion()}
            >
              {warp.pitchRegions.length === 0 ? '候補から外す' : '補正を削除'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="audio-warp-editor__toolbar" role="group" aria-label="音程の一括補正">
        <button
          type="button"
          disabled={disabled || regions.length === 0}
          onClick={() => {
            if (disabled) return;
            commitRegions(baseRegions().map((candidate) => ({
              ...candidate,
              targetPitchCents: Math.round(candidate.sourcePitchCents / 100) * 100,
              correctionAmount: 1,
            })), 'すべての音程を半音へ揃えました。');
          }}
        >
          すべて半音へ揃える
        </button>
        <button
          type="button"
          disabled={disabled || regions.length === 0}
          onClick={() => {
            if (disabled) return;
            commitRegions(baseRegions().map((candidate) => ({
              ...candidate,
              targetPitchCents: closestScaleMidi(
                candidate.sourcePitchCents / 100,
                project,
              ) * 100,
              correctionAmount: 1,
            })), `すべての音程を現在の${project.key}のスケールへ揃えました。`);
          }}
        >
          現在のキー／スケールへ揃える
        </button>
        <button
          type="button"
          disabled={disabled || warp.pitchRegions.length === 0}
          onClick={() => {
            if (disabled) return;
            if (commitRegionsWithFocus([], '音程補正をリセットしました。', 'analyze')) {
              setSelected(0);
            }
          }}
        >
          音程補正をリセット
        </button>
      </div>
      <p className="audio-pitch-editor__runtime-note">
        解析しただけでは波形、解析候補、表示倍率、選択、A/Bを保存や元に戻す履歴へ追加しません。
        目標音程または補正量を初めて変更すると、表示中の候補を補正区間として保存します。
        A/Bはメインの再生でタイミングを保ったままピッチ補正前／補正後を切り替えます。
      </p>
    </section>
  );
}
