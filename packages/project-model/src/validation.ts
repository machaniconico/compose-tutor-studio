// Project validation. Enforces docs/06_data_model.md section 5 plus structural
// integrity checks (unique ids, clip.trackId references an existing track).

import { beatsPerBar, projectLengthBeats as projectTimelineLengthBeats } from './time';
import type { Project } from './types';
import {
  MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
  preflightScheduleEventBudget,
} from './schedule-budget';
import { MAX_CLIPS_PER_TRACK, MIN_EVENT_DURATION_BEATS } from './limits';

export { MAX_CLIPS_PER_TRACK, MIN_EVENT_DURATION_BEATS } from './limits';

export type ValidationError = {
  /** Dot/bracket path to the offending value, e.g. `tracks[0].clips[1].startBeat`. */
  path: string;
  message: string;
};

export type ValidationResult = {
  /** `ok` is true when there are no errors. */
  ok: boolean;
  /** @deprecated Use `ok`. Kept for backward compatibility. */
  valid: boolean;
  errors: ValidationError[];
};

const VALID_DENOMINATORS = new Set([2, 4, 8, 16]);
export const MAX_PROJECT_LENGTH_BARS = 256;
export const MAX_TIME_SIGNATURE_NUMERATOR = 32;
export const MAX_DRUM_STEPS_PER_BAR = 128;
export const MAX_PROJECT_TRACKS = 128;
export const MAX_EVENTS_PER_CLIP = 20_000;
export const MAX_TRACK_EFFECTS = 64;
export const MAX_CHORD_EVENTS = 4_096;
export const MAX_PROJECT_SECTIONS = 256;
export const MAX_PROJECT_TIMELINE_BEATS =
  MAX_PROJECT_LENGTH_BARS * MAX_TIME_SIGNATURE_NUMERATOR;
export const MAX_PROJECT_VALIDATION_ERRORS = 100;
export const SAFE_TRACK_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Validate a project against the data-model rules.
 * Returns every violation found (does not stop at the first error).
 */
export function validateProject(project: Project): ValidationResult {
  const errors: ValidationError[] = [];
  const push = (path: string, message: string): void => {
    if (errors.length < MAX_PROJECT_VALIDATION_ERRORS) errors.push({ path, message });
  };
  const atErrorLimit = (): boolean => errors.length >= MAX_PROJECT_VALIDATION_ERRORS;

  // --- Project-level scalar rules ---
  if (!inRange(project.bpm, 20, 300)) {
    push('bpm', `bpm must be between 20 and 300 (got ${project.bpm})`);
  }

  const [, den] = project.timeSignature;
  if (!VALID_DENOMINATORS.has(den)) {
    push('timeSignature[1]', `time signature denominator must be 2, 4, 8, or 16 (got ${den})`);
  }
  if (
    !Number.isInteger(project.timeSignature[0]) ||
    project.timeSignature[0] <= 0 ||
    project.timeSignature[0] > MAX_TIME_SIGNATURE_NUMERATOR
  ) {
    push(
      'timeSignature[0]',
      `time signature numerator must be an integer between 1 and ${MAX_TIME_SIGNATURE_NUMERATOR} (got ${project.timeSignature[0]})`,
    );
  }
  const projectLengthBeats = projectTimelineLengthBeats(project);
  if (
    !Number.isFinite(projectLengthBeats) ||
    projectLengthBeats <= 0 ||
    projectLengthBeats > MAX_PROJECT_TIMELINE_BEATS
  ) {
    push(
      'lengthBars',
      `project timeline must not exceed ${MAX_PROJECT_TIMELINE_BEATS} quarter-note beats (got ${projectLengthBeats})`,
    );
  }

  if (
    !Number.isInteger(project.lengthBars) ||
    project.lengthBars <= 0 ||
    project.lengthBars > MAX_PROJECT_LENGTH_BARS
  ) {
    push(
      'lengthBars',
      `lengthBars must be an integer between 1 and ${MAX_PROJECT_LENGTH_BARS} (got ${project.lengthBars})`,
    );
  }

  // --- Id uniqueness (collect all ids across the project) ---
  const seenIds = new Set<string>();
  const markId = (id: string, path: string): void => {
    if (id.length === 0) {
      push(path, 'id must not be empty');
      return;
    }
    if (seenIds.has(id)) {
      push(path, `duplicate id "${id}"`);
    } else {
      seenIds.add(id);
    }
  };
  markId(project.id, 'id');

  if (project.tracks.length > MAX_PROJECT_TRACKS) {
    push('tracks', `tracks must contain at most ${MAX_PROJECT_TRACKS} items`);
  }
  if (project.chordTrack.length > MAX_CHORD_EVENTS) {
    push('chordTrack', `chordTrack must contain at most ${MAX_CHORD_EVENTS} items`);
  }
  if (project.sections.length > MAX_PROJECT_SECTIONS) {
    push('sections', `sections must contain at most ${MAX_PROJECT_SECTIONS} items`);
  }

  const trackIds = new Set<string>();
  project.tracks.forEach((track, ti) => {
    if (atErrorLimit()) return;
    markId(track.id, `tracks[${ti}].id`);
    trackIds.add(track.id);

    if (track.clips.length > MAX_CLIPS_PER_TRACK) {
      push(`tracks[${ti}].clips`, `clips must contain at most ${MAX_CLIPS_PER_TRACK} items`);
    }
    if (track.effects.length > MAX_TRACK_EFFECTS) {
      push(`tracks[${ti}].effects`, `effects must contain at most ${MAX_TRACK_EFFECTS} items`);
    }

    if (!inRange(track.volume, 0, 2)) {
      push(`tracks[${ti}].volume`, `volume must be between 0 and 2 (got ${track.volume})`);
    }
    if (!inRange(track.pan, -1, 1)) {
      push(`tracks[${ti}].pan`, `pan must be between -1 and 1 (got ${track.pan})`);
    }
    if (track.color !== undefined && !SAFE_TRACK_COLOR_PATTERN.test(track.color)) {
      push(
        `tracks[${ti}].color`,
        'color must be a hexadecimal CSS color such as #7c83ff',
      );
    }
    track.effects.forEach((effect, ei) => {
      if (atErrorLimit()) return;
      markId(effect.id, `tracks[${ti}].effects[${ei}].id`);
    });
  });

  const clipsById = new Map<string, { clip: Project['tracks'][number]['clips'][number]; trackId: string }>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clipsById.has(clip.id)) clipsById.set(clip.id, { clip, trackId: track.id });
    }
  }

  // --- Clips + nested events ---
  project.tracks.forEach((track, ti) => {
    if (atErrorLimit()) return;
    track.clips.forEach((clip, ci) => {
      if (atErrorLimit()) return;
      const clipPath = `tracks[${ti}].clips[${ci}]`;
      markId(clip.id, `${clipPath}.id`);

      if ((clip.notes?.length ?? 0) > MAX_EVENTS_PER_CLIP) {
        push(`${clipPath}.notes`, `notes must contain at most ${MAX_EVENTS_PER_CLIP} items`);
      }
      if ((clip.drumEvents?.length ?? 0) > MAX_EVENTS_PER_CLIP) {
        push(
          `${clipPath}.drumEvents`,
          `drumEvents must contain at most ${MAX_EVENTS_PER_CLIP} items`,
        );
      }

      if (!(clip.startBeat >= 0) || !Number.isFinite(clip.startBeat)) {
        push(`${clipPath}.startBeat`, `clip start must be >= 0 (got ${clip.startBeat})`);
      }
      if (
        !Number.isFinite(clip.lengthBeats) ||
        clip.lengthBeats < MIN_EVENT_DURATION_BEATS ||
        clip.lengthBeats > MAX_PROJECT_TIMELINE_BEATS
      ) {
        push(
          `${clipPath}.lengthBeats`,
          `clip length must be between ${MIN_EVENT_DURATION_BEATS} and ${MAX_PROJECT_TIMELINE_BEATS} beats (got ${clip.lengthBeats})`,
        );
      }
      if (
        Number.isFinite(projectLengthBeats) &&
        Number.isFinite(clip.startBeat) &&
        Number.isFinite(clip.lengthBeats) &&
        clip.startBeat + clip.lengthBeats > projectLengthBeats
      ) {
        push(`${clipPath}.lengthBeats`, 'clip must end within the project timeline');
      }
      if (clip.trackId !== track.id) {
        push(`${clipPath}.trackId`, `clip.trackId "${clip.trackId}" does not match containing track "${track.id}"`);
      } else if (!trackIds.has(clip.trackId)) {
        push(`${clipPath}.trackId`, `clip.trackId "${clip.trackId}" references a non-existent track`);
      }
      if (clip.aliasOf !== undefined) {
        if (clip.type !== 'midi' && clip.type !== 'drum') {
          push(`${clipPath}.aliasOf`, 'only MIDI and drum clips can be linked');
        }
        const source = clipsById.get(clip.aliasOf);
        if (clip.aliasOf === clip.id) {
          push(`${clipPath}.aliasOf`, 'linked clip must not reference itself');
        } else if (!source) {
          push(`${clipPath}.aliasOf`, `linked clip source "${clip.aliasOf}" does not exist`);
        } else {
          if (source.trackId !== track.id || source.clip.trackId !== track.id) {
            push(`${clipPath}.aliasOf`, 'linked clip source must belong to the same track');
          }
          if (source.clip.type !== clip.type) {
            push(`${clipPath}.aliasOf`, 'linked clip source must have the same clip type');
          }
          if (source.clip.aliasOf !== undefined) {
            push(`${clipPath}.aliasOf`, 'linked clip must reference a canonical source directly');
          }
          if (source.clip.lengthBeats !== clip.lengthBeats) {
            push(`${clipPath}.lengthBeats`, 'linked clip length must match its source');
          }
        }
        if (clip.notes !== undefined) {
          push(`${clipPath}.notes`, 'linked clip payload belongs to its source');
        }
        if (clip.drumEvents !== undefined) {
          push(`${clipPath}.drumEvents`, 'linked clip payload belongs to its source');
        }
        if (clip.stepsPerBar !== undefined) {
          push(`${clipPath}.stepsPerBar`, 'linked clip payload belongs to its source');
        }
        if (clip.drumGroove !== undefined) {
          push(`${clipPath}.drumGroove`, 'linked clip payload belongs to its source');
        }
        if (clip.audioAssetId !== undefined) {
          push(`${clipPath}.audioAssetId`, 'linked clip payload belongs to its source');
        }
      }
      if (
        clip.stepsPerBar !== undefined &&
        (!Number.isSafeInteger(clip.stepsPerBar) ||
          clip.stepsPerBar <= 0 ||
          clip.stepsPerBar > MAX_DRUM_STEPS_PER_BAR)
      ) {
        push(
          `${clipPath}.stepsPerBar`,
          `stepsPerBar must be an integer between 1 and ${MAX_DRUM_STEPS_PER_BAR} (got ${clip.stepsPerBar})`,
        );
      }
      if (clip.type !== 'midi' && clip.notes !== undefined) {
        push(`${clipPath}.notes`, 'notes are only allowed on midi clips');
      }
      if (clip.type !== 'drum' && clip.drumEvents !== undefined) {
        push(`${clipPath}.drumEvents`, 'drumEvents are only allowed on drum clips');
      }
      if (clip.type !== 'drum' && clip.stepsPerBar !== undefined) {
        push(`${clipPath}.stepsPerBar`, 'stepsPerBar is only allowed on drum clips');
      }
      if (clip.type !== 'drum' && clip.drumGroove !== undefined) {
        push(`${clipPath}.drumGroove`, 'drumGroove is only allowed on drum clips');
      }
      if (clip.type !== 'audio' && clip.audioAssetId !== undefined) {
        push(`${clipPath}.audioAssetId`, 'audioAssetId is only allowed on audio clips');
      }
      if (clip.drumGroove !== undefined) {
        const groovePath = `${clipPath}.drumGroove`;
        if (!inRange(clip.drumGroove.swing, 0, 1)) {
          push(`${groovePath}.swing`, 'swing must be between 0 and 1');
        }
        if (!inRange(clip.drumGroove.probability, 0, 1)) {
          push(`${groovePath}.probability`, 'probability must be between 0 and 1');
        }
        if (
          !Number.isInteger(clip.drumGroove.humanizeVelocity) ||
          !inRange(clip.drumGroove.humanizeVelocity, 0, 127)
        ) {
          push(
            `${groovePath}.humanizeVelocity`,
            'humanizeVelocity must be an integer between 0 and 127',
          );
        }
        if (!Number.isSafeInteger(clip.drumGroove.seed) || clip.drumGroove.seed <= 0) {
          push(`${groovePath}.seed`, 'seed must be a positive safe integer');
        }
      }

      clip.notes?.forEach((note, ni) => {
        if (atErrorLimit()) return;
        const notePath = `${clipPath}.notes[${ni}]`;
        markId(note.id, `${notePath}.id`);
        if (!inRange(note.pitch, 0, 127) || !Number.isInteger(note.pitch)) {
          push(`${notePath}.pitch`, `pitch must be an integer 0..127 (got ${note.pitch})`);
        }
        if (!inRange(note.velocity, 1, 127) || !Number.isInteger(note.velocity)) {
          push(`${notePath}.velocity`, `velocity must be an integer 1..127 (got ${note.velocity})`);
        }
        if (!(note.startBeat >= 0) || !Number.isFinite(note.startBeat)) {
          push(`${notePath}.startBeat`, `note start must be >= 0 (got ${note.startBeat})`);
        }
        if (
          !Number.isFinite(note.durationBeats) ||
          note.durationBeats < MIN_EVENT_DURATION_BEATS ||
          note.durationBeats > MAX_PROJECT_TIMELINE_BEATS
        ) {
          push(
            `${notePath}.durationBeats`,
            `note duration must be between ${MIN_EVENT_DURATION_BEATS} and ${MAX_PROJECT_TIMELINE_BEATS} beats (got ${note.durationBeats})`,
          );
        }
        if (
          Number.isFinite(note.startBeat) &&
          Number.isFinite(note.durationBeats) &&
          note.startBeat + note.durationBeats > clip.lengthBeats
        ) {
          push(`${notePath}.durationBeats`, 'note must end within its clip');
        }
      });

      clip.drumEvents?.forEach((drum, di) => {
        if (atErrorLimit()) return;
        const drumPath = `${clipPath}.drumEvents[${di}]`;
        markId(drum.id, `${drumPath}.id`);
        if (!inRange(drum.velocity, 1, 127) || !Number.isInteger(drum.velocity)) {
          push(`${drumPath}.velocity`, `velocity must be an integer 1..127 (got ${drum.velocity})`);
        }
        if (!Number.isInteger(drum.stepIndex) || drum.stepIndex < 0) {
          push(`${drumPath}.stepIndex`, `stepIndex must be a non-negative integer (got ${drum.stepIndex})`);
        }
        if (drum.probability !== undefined && !inRange(drum.probability, 0, 1)) {
          push(`${drumPath}.probability`, 'probability must be between 0 and 1');
        }
        const stepsPerBar = clip.stepsPerBar ?? 16;
        const drumBeat = drum.stepIndex * (beatsPerBar(project.timeSignature) / stepsPerBar);
        if (Number.isFinite(drumBeat) && drumBeat >= clip.lengthBeats) {
          push(`${drumPath}.stepIndex`, 'drum step must fall within its clip');
        }
      });
    });
  });

  // --- Chord track ---
  project.chordTrack.forEach((chord, i) => {
    if (atErrorLimit()) return;
    const chordPath = `chordTrack[${i}]`;
    markId(chord.id, `${chordPath}.id`);
    if (!(chord.startBeat >= 0) || !Number.isFinite(chord.startBeat)) {
      push(`${chordPath}.startBeat`, `chord start must be >= 0 (got ${chord.startBeat})`);
    }
    if (
      !Number.isFinite(chord.durationBeats) ||
      chord.durationBeats < MIN_EVENT_DURATION_BEATS ||
      chord.durationBeats > MAX_PROJECT_TIMELINE_BEATS
    ) {
      push(
        `${chordPath}.durationBeats`,
        `chord duration must be between ${MIN_EVENT_DURATION_BEATS} and ${MAX_PROJECT_TIMELINE_BEATS} beats (got ${chord.durationBeats})`,
      );
    }
    if (
      Number.isFinite(chord.startBeat) &&
      Number.isFinite(chord.durationBeats) &&
      chord.startBeat + chord.durationBeats > projectLengthBeats
    ) {
      push(`${chordPath}.durationBeats`, 'chord must end within the project timeline');
    }
    chord.notes.forEach((pitch, pi) => {
      if (atErrorLimit()) return;
      if (!inRange(pitch, 0, 127) || !Number.isInteger(pitch)) {
        push(`${chordPath}.notes[${pi}]`, `chord note must be an integer 0..127 (got ${pitch})`);
      }
    });
  });

  // --- Sections ---
  project.sections.forEach((section, i) => {
    if (atErrorLimit()) return;
    const sectionPath = `sections[${i}]`;
    markId(section.id, `${sectionPath}.id`);
    if (
      !Number.isInteger(section.startBar) ||
      section.startBar < 0 ||
      section.startBar >= MAX_PROJECT_LENGTH_BARS
    ) {
      push(
        `${sectionPath}.startBar`,
        `section startBar must be an integer between 0 and ${MAX_PROJECT_LENGTH_BARS - 1} (got ${section.startBar})`,
      );
    }
    if (
      !Number.isInteger(section.lengthBars) ||
      section.lengthBars <= 0 ||
      section.lengthBars > MAX_PROJECT_LENGTH_BARS
    ) {
      push(
        `${sectionPath}.lengthBars`,
        `section lengthBars must be an integer between 1 and ${MAX_PROJECT_LENGTH_BARS} (got ${section.lengthBars})`,
      );
    }
    if (section.startBar + section.lengthBars > project.lengthBars) {
      push(`${sectionPath}.lengthBars`, 'section must end within the project timeline');
    }
  });

  const scheduleBudget = preflightScheduleEventBudget(
    project,
    {
      limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
      projection: 'resolved-stored',
    },
  );
  if (!scheduleBudget.ok) {
    push(
      'tracks',
      `resolved playback events must not exceed ${scheduleBudget.limit} items (got at least ${scheduleBudget.observed})`,
    );
  }

  return { ok: errors.length === 0, valid: errors.length === 0, errors };
}

/**
 * Assert that a project is valid, returning it unchanged when valid.
 * Throws a single Error whose message lists all validation errors when invalid.
 */
export function assertValidProject(project: Project): Project {
  const result = validateProject(project);
  if (!result.ok) {
    const messages = result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    throw new Error(`Invalid project:\n${messages}`);
  }
  return project;
}
