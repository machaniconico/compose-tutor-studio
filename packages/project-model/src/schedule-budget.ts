// Conservative Project -> playback occurrence preflight.
//
// The persisted ceiling preserves the historical 200,000-item codec envelope.
// Runtime scheduling is intentionally tighter because every occurrence becomes
// an object and may create Web Audio nodes during offline rendering.

import { buildClipIndex, resolveClipSource, type ClipIndex } from './clip-resolution';
import {
  countRealizedChordNotes,
  visitRealizedChordPitches,
} from './chord-realization';
import {
  countMidiClipNoteOccurrences,
  visitMidiClipNoteOccurrences,
} from './midi-clip-loop';
import {
  beatsPerBar,
  compileDrumStepProjector,
  compileMusicalTime,
  projectDrumStep,
} from './time';
import type { Project } from './types';

/** Compatibility-safe invariant enforced by the TypeScript and Rust codecs. */
export const MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS = 200_000;
/** Live allocation/scan ceiling; offline WAV applies a lower caller limit. */
export const MAX_RUNTIME_SCHEDULE_EVENTS = 20_000;
/** Wider than the 0.6 beats covered by 120ms at the validated 300 BPM maximum. */
export const RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS = 0.75;
export const MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW = 256;

export type ScheduleEventBudgetResult =
  | Readonly<{ ok: true; eventCount: number; limit: number }>
  | Readonly<{
      ok: false;
      code: 'schedule-event-limit-exceeded';
      reason: 'total' | 'density';
      limit: number;
      observed: number;
      windowStartBeat?: number;
    }>;

export type ScheduleEventBudgetProjection = 'resolved-stored' | 'audible';

export type ScheduleEventBudgetOptions = Readonly<{
  limit: number;
  /** Persisted validation excludes derived chord notes for legacy compatibility. */
  projection: ScheduleEventBudgetProjection;
  clipIndex?: ClipIndex;
  density?: Readonly<{
    windowBeats: number;
    maxEventsPerWindow: number;
  }>;
}>;

/** Plain, typed failure raised before a playback schedule is allocated. */
export class ScheduleEventLimitError extends Error {
  readonly code = 'schedule-event-limit-exceeded' as const;

  constructor(
    readonly limit: number,
    readonly observed: number,
    readonly reason: 'total' | 'density' = 'total',
    readonly windowStartBeat?: number,
  ) {
    super(
      reason === 'density'
        ? `Project would create more than ${limit} playback events in one short timeline window; reduce simultaneous notes, drum hits, or linked clip copies`
        : `Project would create more than ${limit} playback events; reduce notes, drum hits, or linked clip copies`,
    );
    this.name = 'ScheduleEventLimitError';
  }
}

function clampUnit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value ?? 0));
}

function appendFiniteOnset(onsets: number[], onsetBeat: number): void {
  if (Number.isFinite(onsetBeat)) onsets.push(onsetBeat);
}

function saturatingAdd(total: number, amount: number): number {
  if (
    !Number.isSafeInteger(total)
    || total < 0
    || !Number.isSafeInteger(amount)
    || amount < 0
    || total > Number.MAX_SAFE_INTEGER - amount
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  return total + amount;
}

/**
 * Count effective MIDI notes, drum hits and generated chord notes without
 * materializing schedule-event objects. Linked clips count their resolved
 * source payload once per timeline instance.
 */
export function preflightScheduleEventBudget(
  project: Project,
  options: ScheduleEventBudgetOptions,
): ScheduleEventBudgetResult {
  const { limit, projection } = options;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('schedule event limit must be a positive safe integer');
  }

  const clipIndex = options.clipIndex ?? buildClipIndex(project);
  let eventCount = projection === 'audible' ? countRealizedChordNotes(project) : 0;
  for (const track of project.tracks) {
    if (track.type === 'master') continue;
    for (const clip of track.clips) {
      const source = resolveClipSource(project, clip, clipIndex);
      if (!source) continue;
      const noteCount = projection === 'audible' && clip.type === 'midi'
        ? countMidiClipNoteOccurrences({
            lengthBeats: clip.lengthBeats,
            loop: clip.loop,
            notes: source.notes,
          })
        : source.notes?.length ?? 0;
      eventCount = saturatingAdd(eventCount, noteCount);
      eventCount = saturatingAdd(eventCount, source.drumEvents?.length ?? 0);
    }
  }

  return eventCount > limit
    ? {
        ok: false,
        code: 'schedule-event-limit-exceeded',
        reason: 'total',
        limit,
        observed: eventCount,
      }
    : preflightDensity(project, options, clipIndex, eventCount);
}

function preflightDensity(
  project: Project,
  options: ScheduleEventBudgetOptions,
  clipIndex: ClipIndex,
  eventCount: number,
): ScheduleEventBudgetResult {
  const density = options.density;
  if (!density) return { ok: true, eventCount, limit: options.limit };
  if (
    !Number.isFinite(density.windowBeats)
    || density.windowBeats <= 0
    || !Number.isSafeInteger(density.maxEventsPerWindow)
    || density.maxEventsPerWindow <= 0
  ) {
    throw new RangeError('schedule density limits must be positive finite values');
  }

  const onsets: number[] = [];
  if (options.projection === 'audible') {
    visitRealizedChordPitches(project, (chord) => {
      appendFiniteOnset(onsets, chord.startBeat);
    });
  }

  const musicalTime = project.timeSignatureMap.length > 0 && project.tempoMap.length > 0
    ? compileMusicalTime(project)
    : null;
  const fixedBarBeats = beatsPerBar(project.timeSignature);
  for (const track of project.tracks) {
    if (track.type === 'master') continue;
    for (const instance of track.clips) {
      const source = resolveClipSource(project, instance, clipIndex);
      if (!source) continue;
      if (options.projection === 'audible' && instance.type === 'midi') {
        const midiPattern = {
          lengthBeats: instance.lengthBeats,
          loop: instance.loop,
          notes: source.notes,
        } as const;
        const occurrenceCount = countMidiClipNoteOccurrences(midiPattern);
        visitMidiClipNoteOccurrences(midiPattern, occurrenceCount, (occurrence) => {
          appendFiniteOnset(onsets, instance.startBeat + occurrence.localStartBeat);
        });
      } else {
        for (const note of source.notes ?? []) {
          appendFiniteOnset(onsets, instance.startBeat + note.startBeat);
        }
      }
      const stepsPerBar =
        Number.isSafeInteger(source.stepsPerBar) && (source.stepsPerBar ?? 0) > 0
          ? source.stepsPerBar!
          : 16;
      const drumProjector = musicalTime === null || (source.drumEvents?.length ?? 0) === 0
        ? null
        : compileDrumStepProjector(stepsPerBar, instance.startBeat, musicalTime);
      const swing = clampUnit(source.drumGroove?.swing);
      for (const drum of source.drumEvents ?? []) {
        const timing = drumProjector === null
          ? {
              beat: instance.startBeat
                + drum.stepIndex * (fixedBarBeats / stepsPerBar),
              beatsPerBar: fixedBarBeats,
            }
          : projectDrumStep(drumProjector, drum.stepIndex);
        const beatsPerStep = timing.beatsPerBar / stepsPerBar;
        const rawOnset = timing.beat;
        const onset = drum.stepIndex % 2 === 0
          ? rawOnset
          : rawOnset + beatsPerStep * 0.5 * swing;
        // The shared occurrence resolver drops swing-delayed hits at/after the
        // instance boundary, so they cannot add runtime density.
        if (onset >= instance.startBeat + instance.lengthBeats) continue;
        appendFiniteOnset(onsets, onset);
      }
    }
  }

  onsets.sort((left, right) => left - right);
  let windowStart = 0;
  for (let windowEnd = 0; windowEnd < onsets.length; windowEnd += 1) {
    const endBeat = onsets[windowEnd]!;
    while (
      windowStart < windowEnd
      && endBeat - onsets[windowStart]! >= density.windowBeats
    ) {
      windowStart += 1;
    }
    const observed = windowEnd - windowStart + 1;
    if (observed > density.maxEventsPerWindow) {
      return {
        ok: false,
        code: 'schedule-event-limit-exceeded',
        reason: 'density',
        limit: density.maxEventsPerWindow,
        observed,
        windowStartBeat: onsets[windowStart],
      };
    }
  }
  return { ok: true, eventCount, limit: options.limit };
}

export function assertScheduleEventBudget(
  project: Project,
  options: ScheduleEventBudgetOptions = {
    limit: MAX_RUNTIME_SCHEDULE_EVENTS,
    projection: 'audible',
    density: {
      windowBeats: RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
      maxEventsPerWindow: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
    },
  },
): number {
  const result = preflightScheduleEventBudget(project, options);
  if (!result.ok) {
    throw new ScheduleEventLimitError(
      result.limit,
      result.observed,
      result.reason,
      result.windowStartBeat,
    );
  }
  return result.eventCount;
}
