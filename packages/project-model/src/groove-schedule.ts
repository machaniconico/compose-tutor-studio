// Shared v11 groove resolver for live playback, offline WAV and MIDI export.
//
// Legacy mode (`swing === 0 && hiHatChoke === false`, every migrated v10 file)
// never reaches this module: all three paths keep main's v10 code and bytes.
// Resolved mode (`swing > 0 || hiHatChoke === true`) takes every onset, drop
// and end decision from here, in integer ticks at PPQ 480. Each value is
// rounded to the 480 PPQ grid exactly once; an onset is dropped when
// `onsetTick >= min(clipEndTick, songEndTick)`. MIDI converts these 480 PPQ
// ticks to its own PPQ afterwards and never re-derives a drop.
import {
  applyDrumSwingToOccurrenceBeat,
  resolveDrumOccurrence,
  type DrumScheduleOccurrence,
} from './drum-schedule';
import { applyHiHatChoke, MAX_SWING_PERCENT, swingBeat } from './groove';
import { beatTick, PPQ } from './ticks';
import type { DrumLane, Project } from './types';

/** The single tick grid on which resolved-mode decisions are made. */
export const GROOVE_RESOLVER_PPQ = PPQ;

type GrooveProject = Pick<Project, 'swing' | 'hiHatChoke' | 'lengthBeats'>;

/** True when the project needs the v11 resolver; false keeps main's v10 paths. */
export function isGrooveResolvedMode(project: Pick<Project, 'swing' | 'hiHatChoke'>): boolean {
  return (Number.isFinite(project.swing) && project.swing > 0) || project.hiHatChoke === true;
}

function projectSwingPercent(project: GrooveProject): number {
  return Number.isFinite(project.swing)
    ? Math.min(MAX_SWING_PERCENT, Math.max(0, project.swing))
    : 0;
}

/** Exclusive onset limit: the earlier of the owning span end and the song end. */
function onsetLimitTick(project: GrooveProject, spanEndBeat: number): number {
  return Math.min(beatTick(spanEndBeat), beatTick(project.lengthBeats));
}

/**
 * A resolved pitched note. `sourceStartTick` / `sourceEndTick` are the same
 * note before swing (the stored grid), used to tell a swing-made overlap from
 * one that is already in the stored notes.
 */
/** Float-noise tolerance for stored-overlap checks (well under 1/480 beat). */
const STORED_OVERLAP_EPSILON_BEATS = 1e-9;

export type GrooveNoteSpan = Readonly<{
  onsetTick: number;
  endTick: number;
  /** Exact (unrounded) source position and end in beats. */
  sourceStartBeat: number;
  sourceEndBeat: number;
}>;

/**
 * Resolve one pitched note (a clip note occurrence or one realized chord voice).
 *
 * `spanEndBeat` is the owning clip end; a realized chord voice passes its own
 * end. Returns null when the swung onset is at or past that end or the song
 * end. The end is clamped to the owning span and is always after the onset.
 */
export function resolveGrooveNoteSpan(
  project: GrooveProject,
  sourceBeat: number,
  durationBeats: number,
  spanEndBeat: number,
): GrooveNoteSpan | null {
  const onsetBeat = swingBeat(sourceBeat, projectSwingPercent(project));
  const onsetTick = beatTick(onsetBeat);
  if (!Number.isFinite(onsetTick) || !(onsetTick < onsetLimitTick(project, spanEndBeat))) {
    return null;
  }
  const endTick = Math.min(
    beatTick(spanEndBeat),
    Math.max(onsetTick + 1, beatTick(onsetBeat + durationBeats)),
  );
  return {
    onsetTick,
    endTick,
    sourceStartBeat: sourceBeat,
    sourceEndBeat: Math.min(spanEndBeat, sourceBeat + durationBeats),
  };
}

/**
 * The one swing-overlap rule shared by playback, WAV, MIDI export and the edit
 * checks. `group` is one track + one pitch. When swing makes a note run into
 * the next onset of the same group, the earlier note is cut at that onset
 * (its sounding length stays at least 1 tick). Notes that already overlap in
 * the stored grid (before swing) are left alone. Returns the spans in input order.
 */
export function cutSwingOverlaps(
  entries: ReadonlyArray<Readonly<{ group: string; span: GrooveNoteSpan }>>,
): GrooveNoteSpan[] {
  const result = entries.map((entry) => entry.span);
  const byGroup = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const list = byGroup.get(entry.group);
    if (list) list.push(index);
    else byGroup.set(entry.group, [index]);
  });
  for (const indexes of byGroup.values()) {
    if (indexes.length < 2) continue;
    indexes.sort((a, b) => result[a]!.onsetTick - result[b]!.onsetTick || a - b);
    for (let i = 0; i + 1 < indexes.length; i += 1) {
      const current = result[indexes[i]!]!;
      const next = result[indexes[i + 1]!]!;
      // Cut only a pure swing overlap: the stored notes do not overlap (exact beats, with a
      // tolerance far below one tick for float noise), they keep their source order, and their
      // sounding onsets are strictly increasing. Anything else is left as it was.
      if (
        next.onsetTick < current.endTick
        && next.onsetTick > current.onsetTick
        && current.sourceStartBeat < next.sourceStartBeat
        && current.sourceEndBeat <= next.sourceStartBeat + STORED_OVERLAP_EPSILON_BEATS
      ) {
        result[indexes[i]!] = {
          ...current,
          endTick: Math.max(current.onsetTick + 1, next.onsetTick),
        };
      }
    }
  }
  return result;
}

/**
 * Resolve one raw drum occurrence built by `createDrumScheduleEvent`.
 *
 * Clip swing (`drumGroove.swing > 0`) wins over project swing. The returned
 * event sits on its 480 PPQ onset with `swing: 0`, so the per-pass occurrence
 * resolver adds no further delay. `authoredBeat` keeps the pre-swing beat so
 * probability, humanize and voiceSeed stay identical to legacy mode.
 * Null when the onset is dropped.
 */
export function resolveGrooveDrumEvent(
  project: GrooveProject,
  event: DrumScheduleOccurrence,
): DrumScheduleOccurrence | null {
  const { payload } = event;
  const onsetBeat = payload.swing > 0
    ? applyDrumSwingToOccurrenceBeat(
        event.beat,
        payload.sourceStepIndex,
        payload.swing,
        payload.stepsPerBar,
        payload.beatsPerBar,
      )
    : swingBeat(event.beat, projectSwingPercent(project));
  const onsetTick = beatTick(onsetBeat);
  if (!Number.isFinite(onsetTick) || !(onsetTick < onsetLimitTick(project, payload.clipEndBeat))) {
    return null;
  }
  const beat = onsetTick / PPQ;
  // Only a moved onset needs the authored beat; an unmoved one salts identically
  // (and keeps the P04 schedule payload unchanged).
  return {
    beat,
    payload: beat === event.beat
      ? { ...payload, swing: 0 }
      : { ...payload, swing: 0, authoredBeat: event.beat },
  };
}

function sameTickKey(lane: DrumLane, beat: number): string {
  return `${lane}:${beatTick(beat)}`;
}

/**
 * Finish one track's resolved drums: de-duplicate and apply the hi-hat choke.
 *
 * Hits of the same lane (one MIDI pitch) on the same tick collapse to the last
 * one in source order, so WAV plays exactly the notes MIDI can represent. With
 * `hiHatChoke`, each open hat gets `chokedAtBeat` from the first closed hat on
 * this track that actually sounds after it (first-pass probability).
 */
export function finalizeGrooveTrackDrums(
  project: Pick<Project, 'hiHatChoke'>,
  events: readonly DrumScheduleOccurrence[],
): DrumScheduleOccurrence[] {
  const lastIndexByKey = new Map<string, number>();
  events.forEach((event, index) => {
    lastIndexByKey.set(sameTickKey(event.payload.lane, event.beat), index);
  });
  const kept = events.filter(
    (event, index) => lastIndexByKey.get(sameTickKey(event.payload.lane, event.beat)) === index,
  );
  if (project.hiHatChoke !== true) return kept;

  const hats = kept.flatMap((event) => {
    const { lane } = event.payload;
    if (lane !== 'openHat' && lane !== 'closedHat') return [];
    const sounding = resolveDrumOccurrence(event);
    return sounding ? [{ event, lane, startBeat: sounding.beat }] : [];
  });
  applyHiHatChoke(hats, (open, closed) => {
    open.event.payload.chokedAtBeat = closed.startBeat;
  });
  return kept;
}
