// Goal evaluation — project predicates and event matching

import { beatTick, soundingEvents, type Project } from '@cts/project-model';
// NOTE: checker.ts とは相互import（goals → checker: 音楽的判定の委譲 /
// checker → goals: 従来predicateの委譲）。両モジュールとも関数宣言のみで
// トップレベル実行が無いため、ESM の循環importとして安全。
import { checkProjectPredicate } from './checker.js';
import { resolveTrackByPredicateName } from './trackResolve.js';
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

    case 'drumLaneActive':
    case 'drumPatternHas': {
      const lanes = predicate.type === 'drumLaneActive' ? [predicate] : predicate.lanes;
      const byLane = new Map<string, Map<string, Set<number>>>();
      for (const event of soundingEvents(project).events) {
        if (event.kind !== 'drum') continue;
        const clips = byLane.get(event.lane) ?? new Map<string, Set<number>>();
        const ticks = clips.get(event.clipId) ?? new Set<number>();
        ticks.add(beatTick(event.startBeat));
        clips.set(event.clipId, ticks);
        byLane.set(event.lane, clips);
      }
      return lanes.every(({ lane, minSteps }) =>
        [...(byLane.get(lane)?.values() ?? [])].some((ticks) => ticks.size >= minSteps),
      );
    }

    case 'noteCountAtLeast': {
      const track = resolveTrackByPredicateName(project, predicate.trackName);
      if (!track) return false;
      const count = soundingEvents(project).events.filter((event) => event.kind === 'note' && event.trackId === track.id).length;
      return count >= predicate.value;
    }

    case 'hasSection': {
      return project.sections.some((s) => s.type === predicate.sectionType);
    }

    case 'bpmInRange': {
      return project.bpm >= predicate.min && project.bpm <= predicate.max;
    }

    case 'trackVolumeInRange': {
      const track = resolveTrackByPredicateName(project, predicate.trackName);
      if (!track) return false;
      return track.volume >= predicate.min && track.volume <= predicate.max;
    }

    case 'exportCompleted': {
      // Export state is not stored in Project; evaluated via events in checkGoalOnEvent.
      // This branch should not be reached in normal flow — returns false as a safe default.
      return false;
    }

    case 'hasBassRootOnDownbeat':
    case 'hasMelodyChordToneOnStrongBeat':
    case 'hasNotesWithinScale':
    case 'hasDrumPattern': {
      // 音楽的判定 (docs/03 §4.2) — 純粋実装は checker.ts 側にある。
      return checkProjectPredicate(predicate, project);
    }
  }
}

// ─── Event Matching ───────────────────────────────────────────────────────────

/**
 * Same identity rule as the project predicates: the event's track is looked up
 * by id so a renamed track still counts, and it must be the track the project
 * predicates resolve to, so a lesson's event and note-count steps agree when
 * several tracks share a role. The payload name is only consulted when the track
 * is not in the project.
 */
function eventTrackMatches(
  payload: Record<string, unknown>,
  trackName: string,
  project: Project,
): boolean {
  const eventTrack = project.tracks.find((t) => t.id === payload['trackId']);
  if (!eventTrack) return payload['trackName'] === trackName;
  return resolveTrackByPredicateName(project, trackName)?.id === eventTrack.id;
}

function matchesEventMatch(event: AppEvent, match: EventMatch, project: Project): boolean {
  const p = event.payload as unknown as Record<string, unknown>;

  if (match.chordSymbol !== undefined) {
    const sym = (p['chordSymbol'] as string | undefined) ?? '';
    if (sym !== match.chordSymbol) return false;
  }
  if (match.pitch !== undefined) {
    const pitch = p['pitch'] as number | undefined;
    if (pitch !== match.pitch) return false;
  }
  if (match.inScale !== undefined) {
    const inScale = p['inScale'] as boolean | undefined;
    if (inScale !== match.inScale) return false;
  }
  if (match.lane !== undefined) {
    const lane = p['lane'] as string | undefined;
    if (lane !== match.lane) return false;
  }
  if (match.trackName !== undefined && !eventTrackMatches(p, match.trackName, project)) {
    return false;
  }
  if (match.format !== undefined) {
    const format = p['format'] as string | undefined;
    if (format !== match.format) return false;
  }
  if (match.trackType !== undefined && (event.type !== 'track.added' || event.payload.trackType !== match.trackType)) {
    return false;
  }
  if (match.effectType !== undefined && (event.type !== 'effect.added' || !event.payload.effectTypes.includes(match.effectType))) {
    return false;
  }
  if (match.parameter !== undefined && (event.type !== 'automation.pointAdded' || event.payload.parameter !== match.parameter)) {
    return false;
  }
  if (match.loopRangeSet !== undefined && (event.type !== 'loop.set' || (event.payload.range !== null) !== match.loopRangeSet)) {
    return false;
  }
  if (match.minSoundingEvents !== undefined) {
    const clipId = p['clipId'];
    if (typeof clipId !== 'string' || soundingEvents(project, { clipId }).events.length < match.minSoundingEvents) {
      return false;
    }
  }
  return true;
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
  project: Project,
): { matches: boolean; newCount: number } {
  if (event.type !== eventType) {
    return { matches: false, newCount: currentCount };
  }
  if (match && !matchesEventMatch(event, match, project)) {
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
    // exportCompleted cannot be evaluated from Project alone — check the triggering event instead.
    if (goal.predicate.type === 'exportCompleted') {
      const format = goal.predicate.format;
      const satisfied =
        (event.type === 'export.midi' && (format === undefined || format === 'midi')) ||
        (event.type === 'export.wav' && (format === undefined || format === 'wav'));
      return { satisfied, newEventCount: eventCount };
    }
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
    project,
  );
  return { satisfied: matches, newEventCount: newCount };
}
