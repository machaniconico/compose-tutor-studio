import type { Clip, DrumLane, TrackType } from './types';
import { beatTick, PPQ } from './time';

export const DEFAULT_STEPS_PER_BAR = 16;
export const MIN_LOOP_PERIOD_BEATS = 1 / 64;

export type ExpandedNote = {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
  cut?: true;
};

export type ExpandedDrumHit = { lane: DrumLane; beat: number; velocity: number };

type SourcePosition = { sourceIndex: number; repeat: number; unswungStartBeat: number };
export type ClipOnset = SourcePosition & (
  | (ExpandedNote & { kind: 'note' })
  | { kind: 'drum'; lane: DrumLane; startBeat: number; velocity: number }
);

const SILENT_TRACK_LABEL: Record<Exclude<TrackType, 'instrument' | 'drum'>, string> = {
  audio: 'オーディオのトラック',
  bus: 'まとめ用のトラック(バス)',
  master: 'マスタートラック',
};

/**
 * Follow `aliasOf` links to the clip that owns the content. Returns the
 * problem text instead when the chain is cut or loops back on itself.
 */
export function resolveLinkSource(clip: Clip, allClips: readonly Clip[] | ReadonlyMap<string, Clip>): Clip | string {
  const find = (id: string): Clip | undefined => 'get' in allClips
    ? allClips.get(id)
    : allClips.find((candidate) => candidate.id === id);
  const visited = new Set<string>([clip.id]);
  let current = clip;
  while (current.aliasOf !== undefined) {
    const targetId = current.aliasOf;
    if (visited.has(targetId)) {
      return 'リンク(別のクリップと中身を共有する設定)が循環していて、たどると元のクリップに戻ってしまうため、このクリップは鳴りません。';
    }
    const target = find(targetId);
    if (target === undefined) {
      return 'リンク(別のクリップと中身を共有する設定)の相手のクリップが見つからないため、このクリップは鳴りません。リンク先が削除された可能性があります。';
    }
    visited.add(targetId);
    current = target;
  }
  return current;
}

export function clipSpan(clip: Clip, songEnd = Infinity) {
  const end = Math.min(clip.startBeat + clip.lengthBeats, songEnd);
  const period = clip.loop ? clip.contentLengthBeats ?? clip.lengthBeats : Infinity;
  return { end, period, firstEnd: Math.min(end, clip.startBeat + period) };
}

function startsBeforeClipEnd(start: number, end: number): boolean {
  return beatTick(start) < beatTick(end);
}

function placeOnset(
  clip: Clip,
  span: ReturnType<typeof clipSpan>,
  localBeat: number,
  repeat: number,
  swing: number,
) {
  const offset = repeat === 0 ? 0 : repeat * span.period;
  const start = clip.startBeat + (offset + localBeat);
  const repeatEnd = Math.min(span.end, clip.startBeat + (offset + span.period));
  if (!startsBeforeClipEnd(start, repeatEnd)) return undefined;
  const step = Math.round(start * 4);
  const delay = swing > 0 && step % 2 === 1 && beatTick(start) === beatTick(step / 4)
    ? swing / 400
    : 0;
  const startBeat = start + delay;
  if (!startsBeforeClipEnd(startBeat, repeatEnd)) return undefined;
  return { startBeat, unswungStartBeat: start, end: repeatEnd };
}

/** How many passes can contain an onset, before swing is applied. */
function repeatCount(clip: Clip, span: ReturnType<typeof clipSpan>, localBeat: number): number {
  if (!startsBeforeClipEnd(localBeat, span.period) || !startsBeforeClipEnd(clip.startBeat + localBeat, span.end)) return 0;
  if (!Number.isFinite(span.period) || span.period < MIN_LOOP_PERIOD_BEATS) return 1;

  // Rounding an onset to the end tick begins half a tick before the end tick.
  const endThreshold = (beatTick(span.end) - 0.5) / PPQ;
  return Math.max(1, Math.ceil((endThreshold - clip.startBeat - localBeat) / span.period));
}

export function renderClip(
  clip: Clip,
  source: Clip,
  bpb: number,
  trackType?: TrackType,
  songEnd = Infinity,
  swing = 0,
  emit?: (event: ClipOnset) => void,
): { count: number; problems: string[] } {
  const span = clipSpan(clip, songEnd);
  const problems: string[] = [];
  const beatsPerStep = bpb / (source.stepsPerBar && source.stepsPerBar > 0 ? source.stepsPerBar : DEFAULT_STEPS_PER_BAR);
  let count = 0;
  let rejectedNotes = 0;
  let rejectedDrums = 0;

  // Visit events by repeat, preserving the stored order within a pass.
  const placements: Array<{ repeats: number; place: (repeat: number) => void }> = [];
  let totalRepeats = 0;
  const prepare = (repeats: number, place: (repeat: number) => void): void => {
    count += repeats;
    if (!emit) return;
    placements.push({ repeats, place });
    totalRepeats = Math.max(totalRepeats, repeats);
  };

  source.notes?.forEach((note, sourceIndex) => {
    const repeats = repeatCount(clip, span, note.startBeat);
    if (repeats === 0) return;
    if (trackType !== undefined && trackType !== 'instrument') {
      rejectedNotes++;
      return;
    }
    prepare(repeats, (repeat) => {
      const timing = placeOnset(clip, span, note.startBeat, repeat, swing);
      if (!timing) return;
      const { startBeat, unswungStartBeat, end } = timing;
      const naturalEnd = startBeat + note.durationBeats;
      const cut = beatTick(naturalEnd) > beatTick(end) || (end === songEnd && naturalEnd > end);
      const durationBeats = cut ? end - startBeat : note.durationBeats;
      emit?.({
        kind: 'note', sourceIndex, repeat, startBeat, unswungStartBeat, durationBeats,
        pitch: note.pitch, velocity: note.velocity, ...(cut ? { cut: true } : {}),
      });
    });
  });

  source.drumEvents?.forEach((hit, sourceIndex) => {
    const localBeat = hit.stepIndex * beatsPerStep;
    const repeats = repeatCount(clip, span, localBeat);
    if (repeats === 0) return;
    if (trackType !== undefined && trackType !== 'drum') {
      rejectedDrums++;
      return;
    }
    prepare(repeats, (repeat) => {
      const timing = placeOnset(clip, span, localBeat, repeat, swing);
      if (!timing) return;
      emit?.({
        kind: 'drum', sourceIndex, repeat, startBeat: timing.startBeat,
        unswungStartBeat: timing.unswungStartBeat, lane: hit.lane, velocity: hit.velocity,
      });
    });
  });

  if (trackType === 'drum' && rejectedNotes > 0) {
    problems.push(`ドラムのトラックでは音符は鳴らないため、このクリップの音符 ${rejectedNotes} 個は鳴りません。音符は楽器のトラックのクリップに置きましょう。`);
  } else if (trackType === 'instrument' && rejectedDrums > 0) {
    problems.push(`楽器のトラックではドラムの音は鳴らないため、このクリップのドラムの音 ${rejectedDrums} 個は鳴りません。ドラムの音はドラムのトラックのクリップに置きましょう。`);
  } else if (trackType && trackType !== 'drum' && trackType !== 'instrument' && rejectedNotes + rejectedDrums > 0) {
    problems.push(`${SILENT_TRACK_LABEL[trackType]}では音符もドラムの音も鳴らないため、このクリップの音 ${rejectedNotes + rejectedDrums} 個は鳴りません。音符は楽器のトラック、ドラムの音はドラムのトラックのクリップに置きましょう。`);
  }

  for (let repeat = 0; repeat < totalRepeats; repeat++) {
    let keep = 0;
    for (const placement of placements) {
      if (repeat >= placement.repeats) continue;
      placement.place(repeat);
      placements[keep++] = placement;
    }
    placements.length = keep;
  }
  return { count, problems };
}

/** Single-clip expansion for edits that work without a project timeline. */
export function expandClip(clip: Clip, allClips: readonly Clip[], bpb = 4, trackType?: TrackType) {
  const notes: ExpandedNote[] = [];
  const drumHits: ExpandedDrumHit[] = [];
  const source = resolveLinkSource(clip, allClips);
  if (typeof source === 'string') return { notes, drumHits, problems: [source] };
  const { problems } = renderClip(clip, source, bpb, trackType, Infinity, 0, (event) => {
    if (event.kind === 'drum') {
      drumHits.push({ lane: event.lane, beat: event.startBeat, velocity: event.velocity });
    } else {
      const { pitch, startBeat, durationBeats, velocity, cut } = event;
      notes.push({ pitch, startBeat, durationBeats, velocity, ...(cut ? { cut } : {}) });
    }
  });
  return { notes, drumHits, problems };
}

/** Resolve an empty or filled drum cell to its first-pass grid step. */
export function drumSourceStep(clip: Clip, localBeat: number, stepBeats: number, songEnd: number, swing: number): number | null {
  const span = clipSpan(clip, songEnd);
  const repeat = Number.isFinite(span.period) && span.period >= MIN_LOOP_PERIOD_BEATS
    ? Math.floor(localBeat / span.period)
    : 0;
  // At a fractional seam the integer tick may belong to the next repeat.
  for (const pass of [repeat, repeat + 1]) {
    if (pass > 0 && (!Number.isFinite(span.period) || span.period < MIN_LOOP_PERIOD_BEATS)) break;
    const offset = pass === 0 ? 0 : pass * span.period;
    const step = Math.round((localBeat - offset) / stepBeats);
    if (step < 0) continue;
    const timing = placeOnset(clip, span, step * stepBeats, pass, swing);
    if (timing && beatTick(timing.unswungStartBeat - clip.startBeat) === beatTick(localBeat)) return step;
  }
  return null;
}

/** Count drum placements for meter-change previews, without materializing repeats. */
export function drumHitRepeatCount(clip: Clip, localBeat: number, availableBeats: number): number {
  return repeatCount(clip, clipSpan(clip, clip.startBeat + availableBeats), localBeat);
}
