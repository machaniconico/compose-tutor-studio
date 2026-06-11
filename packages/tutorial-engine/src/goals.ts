// Goal evaluation — project predicates and event matching

import type { Project } from '@cts/project-model';
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
      for (const track of project.tracks) {
        if (track.type !== 'drum') continue;
        for (const clip of track.clips) {
          if (!clip.drumEvents) continue;
          // Count unique step indices for the requested lane (dedup in case of duplicates)
          const stepIndices = new Set(
            clip.drumEvents
              .filter((e) => e.lane === predicate.lane)
              .map((e) => e.stepIndex),
          );
          if (stepIndices.size >= predicate.minSteps) return true;
        }
      }
      return false;
    }

    case 'noteCountAtLeast': {
      for (const track of project.tracks) {
        if (track.name !== predicate.trackName) continue;
        let count = 0;
        for (const clip of track.clips) {
          count += clip.notes?.length ?? 0;
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

    case 'exportCompleted': {
      // Export state is not stored in Project; evaluated via events in checkGoalOnEvent.
      // This branch should not be reached in normal flow — returns false as a safe default.
      return false;
    }
  }
}

// ─── Event Matching ───────────────────────────────────────────────────────────

function matchesEventMatch(event: AppEvent, match: EventMatch): boolean {
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
  if (match.trackName !== undefined) {
    const trackName = p['trackName'] as string | undefined;
    if (trackName !== match.trackName) return false;
  }
  if (match.format !== undefined) {
    const format = p['format'] as string | undefined;
    if (format !== match.format) return false;
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
): { matches: boolean; newCount: number } {
  if (event.type !== eventType) {
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
  );
  return { satisfied: matches, newEventCount: newCount };
}
