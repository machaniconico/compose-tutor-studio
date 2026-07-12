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
  if (match.key !== undefined) {
    const key = p['key'] as string | undefined;
    if (key !== match.key) return false;
  }
  if (match.scale !== undefined) {
    const scale = p['scale'] as string | undefined;
    if (scale !== match.scale) return false;
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
  if (match.effectType !== undefined) {
    const effectType = p['effectType'] as string | undefined;
    if (effectType !== match.effectType) return false;
  }
  if (match.swingAtLeast !== undefined) {
    const swing = p['swing'] as number | undefined;
    if (swing === undefined || swing < match.swingAtLeast) return false;
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
