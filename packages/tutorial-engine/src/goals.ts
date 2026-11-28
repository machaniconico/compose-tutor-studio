// Goal evaluation — project predicates and event matching

import {
  buildClipIndex,
  resolveClipContent,
  type Project,
} from '@cts/project-model';
import type {
  AppEvent,
  AppEventType,
  EventMatch,
  ProjectPredicate,
  StepGoal,
} from './types.js';

// ─── Project Predicate Evaluator ──────────────────────────────────────────────

export function evaluateProjectPredicate(
  predicate: ProjectPredicate,
  project: Project,
): boolean {
  switch (predicate.type) {
    case 'chordCountAtLeast': {
      return project.chordTrack.length >= predicate.value;
    }

    case 'progressionEquals': {
      const symbols = project.chordTrack
        .slice()
        .sort((a, b) => a.startBeat - b.startBeat)
        .map((c) => c.symbol);
      if (symbols.length !== predicate.symbols.length) return false;
      return predicate.symbols.every((s, i) => symbols[i] === s);
    }

    case 'drumLaneActive': {
      const clipIndex = buildClipIndex(project);
      for (const track of project.tracks) {
        if (track.type !== 'drum') continue;
        let activeStepCount = 0;
        for (const clip of track.clips) {
          const effectiveClip = resolveClipContent(project, clip, clipIndex);
          if (!effectiveClip?.drumEvents) continue;
          activeStepCount += effectiveClip.drumEvents.filter(
            (e) => e.lane === predicate.lane,
          ).length;
          if (activeStepCount >= predicate.minSteps) return true;
        }
      }
      return false;
    }

    case 'noteCountAtLeast': {
      const clipIndex = buildClipIndex(project);
      for (const track of project.tracks) {
        if (track.name !== predicate.trackName) continue;
        let count = 0;
        for (const clip of track.clips) {
          count += resolveClipContent(project, clip, clipIndex)?.notes?.length ?? 0;
        }
        if (count >= predicate.value) return true;
      }
      return false;
    }

    case 'hasSection': {
      return project.sections.some((s) => s.type === predicate.sectionType);
    }

    case 'bpmInRange': {
      return project.bpm >= predicate.min && project.bpm <= predicate.max;
    }

    case 'trackVolumeInRange': {
      for (const track of project.tracks) {
        if (track.name !== predicate.trackName) continue;
        if (track.volume >= predicate.min && track.volume <= predicate.max) {
          return true;
        }
      }
      return false;
    }

  }
}

// ─── Event Matching ───────────────────────────────────────────────────────────

/** Match keys compared for equality against the payload field of the same name. */
const EQUALITY_KEYS = [
  'pitch', 'inScale', 'key', 'scale', 'lane', 'trackName', 'format',
  'effectType', 'trackType', 'sampleRate', 'bitDepth',
] as const;

/**
 * Whether the event's payload satisfies every condition in `match`.
 *
 * The payload comes from app code but is treated as untrusted: it must be a
 * non-null, non-array object, only its own properties count, and any throw
 * (hostile getter, revoked Proxy) is a non-match rather than an exception.
 */
function matchesEventMatch(event: AppEvent, match: EventMatch): boolean {
  try {
    const payload: unknown = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
    const read = (key: string): unknown => (
      Object.hasOwn(payload, key) ? (payload as Record<string, unknown>)[key] : undefined
    );
    if (match.chordSymbol !== undefined) {
      const symbol = read('chordSymbol');
      if ((symbol === undefined ? '' : symbol) !== match.chordSymbol) return false;
    }
    for (const key of EQUALITY_KEYS) {
      const wanted = match[key];
      if (wanted !== undefined && read(key) !== wanted) return false;
    }
    if (match.swingAtLeast !== undefined) {
      const swing = read('swing');
      if (typeof swing !== 'number' || swing < match.swingAtLeast) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Event-based goal evaluation ─────────────────────────────────────────────

/**
 * Returns whether the accumulated event count satisfies the goal.
 * currentCount is the number of matching events seen before this one.
 */
export function evaluateEventGoal(
  eventType: AppEventType,
  match: EventMatch | undefined,
  requiredCount: number,
  event: AppEvent,
  currentCount: number,
): { matches: boolean; newCount: number } {
  let sameType = false;
  try {
    sameType = event.type === eventType;
  } catch {
    sameType = false;
  }
  if (!sameType) {
    return { matches: false, newCount: currentCount };
  }
  if (match && !matchesEventMatch(event, match)) {
    return { matches: false, newCount: currentCount };
  }
  const newCount = currentCount + 1;
  return { matches: newCount >= requiredCount, newCount };
}

// ─── Combined goal check (called by engine on each event) ────────────────────

export function checkGoalOnEvent(
  goal: StepGoal,
  event: AppEvent,
  project: Project,
  eventCount: number,
): { satisfied: boolean; newEventCount: number } {
  if (goal.kind === 'exercise') {
    return { satisfied: false, newEventCount: eventCount };
  }

  if (goal.kind === 'project') {
    const satisfied = evaluateProjectPredicate(goal.predicate, project);
    return { satisfied, newEventCount: eventCount };
  }

  // goal.kind === 'event'
  const required = goal.count ?? 1;
  const { matches, newCount } = evaluateEventGoal(
    goal.eventType,
    goal.match,
    required,
    event,
    eventCount,
  );
  return { satisfied: matches, newEventCount: newCount };
}
