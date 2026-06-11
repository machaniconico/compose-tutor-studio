// Project validation. Enforces docs/06_data_model.md section 5 plus structural
// integrity checks (unique ids, clip.trackId references an existing track).

import type { Project } from './types';

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
    errors.push({ path, message });
  };

  // --- Project-level scalar rules ---
  if (!inRange(project.bpm, 20, 300)) {
    push('bpm', `bpm must be between 20 and 300 (got ${project.bpm})`);
  }

  const [, den] = project.timeSignature;
  if (!VALID_DENOMINATORS.has(den)) {
    push('timeSignature[1]', `time signature denominator must be 2, 4, 8, or 16 (got ${den})`);
  }
  if (!Number.isInteger(project.timeSignature[0]) || project.timeSignature[0] <= 0) {
    push('timeSignature[0]', `time signature numerator must be a positive integer (got ${project.timeSignature[0]})`);
  }

  if (!Number.isInteger(project.lengthBars) || project.lengthBars <= 0) {
    push('lengthBars', `lengthBars must be a positive integer (got ${project.lengthBars})`);
  }

  // --- Id uniqueness (collect all ids across the project) ---
  const seenIds = new Set<string>();
  const markId = (id: string, path: string): void => {
    if (seenIds.has(id)) {
      push(path, `duplicate id "${id}"`);
    } else {
      seenIds.add(id);
    }
  };
  markId(project.id, 'id');

  const trackIds = new Set<string>();
  project.tracks.forEach((track, ti) => {
    markId(track.id, `tracks[${ti}].id`);
    trackIds.add(track.id);

    if (!inRange(track.volume, 0, 2)) {
      push(`tracks[${ti}].volume`, `volume must be between 0 and 2 (got ${track.volume})`);
    }
    if (!inRange(track.pan, -1, 1)) {
      push(`tracks[${ti}].pan`, `pan must be between -1 and 1 (got ${track.pan})`);
    }
  });

  // --- Clips + nested events ---
  project.tracks.forEach((track, ti) => {
    track.clips.forEach((clip, ci) => {
      const clipPath = `tracks[${ti}].clips[${ci}]`;
      markId(clip.id, `${clipPath}.id`);

      if (!(clip.startBeat >= 0) || !Number.isFinite(clip.startBeat)) {
        push(`${clipPath}.startBeat`, `clip start must be >= 0 (got ${clip.startBeat})`);
      }
      if (!(clip.lengthBeats > 0) || !Number.isFinite(clip.lengthBeats)) {
        push(`${clipPath}.lengthBeats`, `clip length must be > 0 (got ${clip.lengthBeats})`);
      }
      if (clip.trackId !== track.id) {
        push(`${clipPath}.trackId`, `clip.trackId "${clip.trackId}" does not match containing track "${track.id}"`);
      } else if (!trackIds.has(clip.trackId)) {
        push(`${clipPath}.trackId`, `clip.trackId "${clip.trackId}" references a non-existent track`);
      }

      clip.notes?.forEach((note, ni) => {
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
        if (!(note.durationBeats > 0) || !Number.isFinite(note.durationBeats)) {
          push(`${notePath}.durationBeats`, `note duration must be > 0 (got ${note.durationBeats})`);
        }
      });

      clip.drumEvents?.forEach((drum, di) => {
        const drumPath = `${clipPath}.drumEvents[${di}]`;
        markId(drum.id, `${drumPath}.id`);
        if (!inRange(drum.velocity, 1, 127) || !Number.isInteger(drum.velocity)) {
          push(`${drumPath}.velocity`, `velocity must be an integer 1..127 (got ${drum.velocity})`);
        }
        if (!Number.isInteger(drum.stepIndex) || drum.stepIndex < 0) {
          push(`${drumPath}.stepIndex`, `stepIndex must be a non-negative integer (got ${drum.stepIndex})`);
        }
      });
    });
  });

  // --- Chord track ---
  project.chordTrack.forEach((chord, i) => {
    const chordPath = `chordTrack[${i}]`;
    markId(chord.id, `${chordPath}.id`);
    if (!(chord.startBeat >= 0) || !Number.isFinite(chord.startBeat)) {
      push(`${chordPath}.startBeat`, `chord start must be >= 0 (got ${chord.startBeat})`);
    }
    if (!(chord.durationBeats > 0) || !Number.isFinite(chord.durationBeats)) {
      push(`${chordPath}.durationBeats`, `chord duration must be > 0 (got ${chord.durationBeats})`);
    }
    chord.notes.forEach((pitch, pi) => {
      if (!inRange(pitch, 0, 127) || !Number.isInteger(pitch)) {
        push(`${chordPath}.notes[${pi}]`, `chord note must be an integer 0..127 (got ${pitch})`);
      }
    });
  });

  // --- Sections ---
  project.sections.forEach((section, i) => {
    const sectionPath = `sections[${i}]`;
    markId(section.id, `${sectionPath}.id`);
    if (!Number.isInteger(section.startBar) || section.startBar < 0) {
      push(`${sectionPath}.startBar`, `section startBar must be a non-negative integer (got ${section.startBar})`);
    }
    if (!Number.isInteger(section.lengthBars) || section.lengthBars <= 0) {
      push(`${sectionPath}.lengthBars`, `section lengthBars must be a positive integer (got ${section.lengthBars})`);
    }
  });

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
