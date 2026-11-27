import {
  setProjectLengthBars,
  songBarAtBeat,
  type Project,
  type SongLengthBlocker,
  type SongLengthBlockerKind,
} from '@cts/project-model';
import { buildScheduleEvents } from '../audio/events';
import { resolveDrumOccurrence, type ScheduledEvent } from '../audio/scheduler';
import { useStore } from './store';

export type StudioSongLengthErrorCode =
  | 'invalid-length'
  | 'content-beyond-end'
  | 'project-not-adoptable'
  | 'invalid-project'
  | 'unexpected'
  | 'recording'
  | 'commit-rejected';

export type StudioSongLengthResult =
  | Readonly<{
      ok: true;
      changed: boolean;
      lengthBars: number;
      trimmedClips: number;
      removedClips: number;
      removedChords: number;
      trimmedChords: number;
      removedSections: number;
      trimmedSections: number;
      playbackStopped: boolean;
    }>
  | Readonly<{
      ok: false;
      code: StudioSongLengthErrorCode;
      blockers: readonly SongLengthBlocker[];
    }>;

function failed(
  code: StudioSongLengthErrorCode,
  blockers: readonly SongLengthBlocker[] = [],
): StudioSongLengthResult {
  return { ok: false, code, blockers };
}

type ResolvedEvent = Readonly<{
  key: string;
  beat: number;
  /** Onset before drum resolution (swing, clip end). */
  rawBeat: number;
  trackId: string | null;
}>;

/**
 * A drum hit that could ever sound: probability counts as certain and velocity
 * humanizing is off, so a random miss never hides lost content. Used only for
 * this comparison; playback resolves the real payload.
 */
function potentialHit(event: ScheduledEvent): ScheduledEvent {
  const payload = event.payload as { kind?: unknown };
  if (payload.kind !== 'drum') return event;
  return { ...event, payload: { ...payload, probability: 1, humanizeVelocity: 0 } };
}

/** The live / WAV schedule (drum occurrences resolved), chords excluded. */
function resolvedSchedule(project: Project): ResolvedEvent[] {
  const out: ResolvedEvent[] = [];
  for (const event of buildScheduleEvents({ ...project, chordTrack: [] })) {
    const resolved = resolveDrumOccurrence(potentialHit(event), event.beat);
    if (resolved === null) {
      // Inaudible, but still an event on the schedule: keep it for the end check.
      const raw = event.payload as { trackId?: unknown };
      out.push({
        key: '',
        beat: event.beat,
        rawBeat: event.beat,
        trackId: typeof raw.trackId === 'string' ? raw.trackId : null,
      });
      continue;
    }
    const payload = { ...(resolved.payload as Record<string, unknown>) };
    // The clip end moves with a trim; its audible effect is already in `resolved`.
    delete payload.clipEndBeat;
    out.push({
      key: JSON.stringify({ beat: resolved.beat, payload }),
      beat: resolved.beat,
      rawBeat: event.beat,
      trackId: typeof payload.trackId === 'string' ? payload.trackId : null,
    });
  }
  return out;
}

/**
 * Authoritative check: the candidate must sound exactly like the original
 * (same multiset of {beat, payload}) and have nothing at or past the new end.
 * Returns the first missing or extra event, or null when the change is safe.
 */
function firstScheduleDifference(
  original: Project,
  candidate: Project,
): { beat: number; trackId: string | null } | null {
  const before = resolvedSchedule(original);
  const after = resolvedSchedule(candidate);
  const remaining = new Map<string, ResolvedEvent[]>();
  for (const event of before) {
    if (event.key === '') continue;
    const bucket = remaining.get(event.key);
    if (bucket === undefined) remaining.set(event.key, [event]);
    else bucket.push(event);
  }
  const offenders: ResolvedEvent[] = [];
  for (const event of after) {
    if (event.rawBeat >= candidate.lengthBeats || event.beat >= candidate.lengthBeats) {
      offenders.push(event);
    }
    if (event.key === '') continue;
    const bucket = remaining.get(event.key);
    if (bucket !== undefined && bucket.length > 0) bucket.pop();
    else offenders.push(event);
  }
  for (const bucket of remaining.values()) offenders.push(...bucket);
  if (offenders.length === 0) return null;
  return offenders.reduce((first, event) => (event.beat < first.beat ? event : first));
}

/** Change the song length in whole bars as exactly one Undo step. */
export function setStudioSongLengthBars(bars: unknown): StudioSongLengthResult {
  const state = useStore.getState();
  if (state.audioRecordingOperationId !== null) return failed('recording');
  const snapshot: Project = state.project;
  const playbackWasActive = state.transport.phase !== 'stopped';
  const result = setProjectLengthBars(snapshot, bars);
  if (!result.ok) return failed(result.error.code, result.error.blockers ?? []);
  if (!result.changed) {
    return {
      ok: true, changed: false, lengthBars: result.lengthBars,
      trimmedClips: 0, removedClips: 0, removedChords: 0, trimmedChords: 0,
      removedSections: 0, trimmedSections: 0, playbackStopped: false,
    };
  }
  if (result.lengthBeats < snapshot.lengthBeats) {
    let difference: ReturnType<typeof firstScheduleDifference>;
    try {
      difference = firstScheduleDifference(snapshot, result.project);
    } catch {
      return failed('invalid-project');
    }
    if (difference !== null) {
      const track = snapshot.tracks.find((t) => t.id === difference?.trackId);
      return failed('content-beyond-end', [{
        kind: 'note',
        name: track?.name ?? '',
        bar: songBarAtBeat(snapshot, difference.beat),
      }]);
    }
  }
  if (state.projectOperationBusy) return failed('commit-rejected');
  // An open drag gesture becomes its own committed step first, as Undo does,
  // so a later cancel of that gesture cannot revert this resize.
  state.finalizeProjectTransaction();
  if (
    useStore.getState().project !== snapshot
    || !useStore.getState().applyProjectChange((current) => (
      current === snapshot ? result.project : current
    ))
    || useStore.getState().project === snapshot
  ) {
    return failed('commit-rejected');
  }
  return {
    ok: true,
    changed: true,
    lengthBars: result.lengthBars,
    trimmedClips: result.trimmedClips,
    removedClips: result.removedClips,
    removedChords: result.removedChords,
    trimmedChords: result.trimmedChords,
    removedSections: result.removedSections,
    trimmedSections: result.trimmedSections,
    playbackStopped: playbackWasActive && useStore.getState().transport.phase === 'stopped',
  };
}

const BLOCKER_KIND_LABEL: Record<SongLengthBlockerKind, string> = {
  clip: 'クリップ',
  note: '音符またはドラムの音',
  'note-overrun': '曲の終わりをまたぐ長い音符',
  'audio-take-folder': '録音テイク',
  'automation-point': 'オートメーションの点',
  'tempo-event': 'テンポの変化',
  'time-signature-event': '拍子の変化',
};

function describeBlocker(blocker: SongLengthBlocker): string {
  const kind = BLOCKER_KIND_LABEL[blocker.kind];
  const name = typeof blocker.name === 'string' && blocker.name !== '' ? `「${blocker.name}」` : '';
  return `${blocker.bar}小節目の${kind}${name}`;
}

export function studioSongLengthErrorMessage(
  code: StudioSongLengthErrorCode,
  blockers: readonly SongLengthBlocker[] = [],
  maxBars = 256,
): string {
  switch (code) {
    case 'invalid-length':
      return `曲の長さは、1〜${maxBars}の整数の小節数で指定してください。`;
    case 'content-beyond-end': {
      const shown = blockers.slice(0, 5).map(describeBlocker).join('、');
      const rest = blockers.length > 5 ? `ほか${blockers.length - 5}件` : '';
      const overrun = blockers.some((b) => b.kind === 'note-overrun')
        ? '曲の終わりをまたぐ音符は、音符を短くしてから曲を短くしてください。'
        : '';
      return `曲を短くすると消えてしまう内容があるため、変更しませんでした。新しい終わりより後ろに、${shown}${rest}があります。先に移動または削除してから、もう一度短くしてください。${overrun}`;
    }
    case 'recording':
      return '録音中は曲の長さを変更できません。録音を止めてからお試しください。';
    case 'commit-rejected':
      return '別の処理が先に実行されたため、曲の長さは変更していません。もう一度お試しください。';
    case 'project-not-adoptable':
    case 'invalid-project':
      return 'この長さでは曲を安全に保存できないため、変更しませんでした。';
    case 'unexpected':
      return '曲の長さを変更できませんでした。プロジェクトは変更されていません。';
  }
}

function countPhrase(chords: number, sections: number): string {
  const parts: string[] = [];
  if (chords > 0) parts.push(`コード ${chords} 個`);
  if (sections > 0) parts.push(`セクション ${sections} 個`);
  return parts.join('・');
}

/** Beginner-facing status for a successful length change. */
export function studioSongLengthStatusMessage(
  result: Extract<StudioSongLengthResult, { ok: true }>,
): string {
  if (!result.changed) return `曲の長さはすでに${result.lengthBars}小節です。`;
  const notes: string[] = [];
  const removed = countPhrase(result.removedChords, result.removedSections);
  if (removed !== '') notes.push(`${removed}を取り除きました(元に戻すで復元できます)`);
  const trimmed = countPhrase(result.trimmedChords, result.trimmedSections);
  if (trimmed !== '') notes.push(`${trimmed}を曲の終わりまでに短くしました`);
  if (result.trimmedClips + result.removedClips > 0) {
    notes.push(
      `曲の終わりを越えていた空のクリップを整えました(短縮${result.trimmedClips}件・削除${result.removedClips}件)`,
    );
  }
  return [
    `曲の長さを${result.lengthBars}小節にしました。`,
    ...notes.map((note) => `${note}。`),
    result.playbackStopped ? '再生を止めました。' : '',
  ].join('');
}
