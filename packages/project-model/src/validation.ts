// Project validation. Enforces docs/06_data_model.md section 5 plus structural
// integrity checks (unique ids, clip.trackId references an existing track).

import { MAX_AUTOMATION_POINTS } from './automation';
import type { InstrumentMacros, Project, TrackRole } from './types';
import { findProjectSoundingLimitProblem, MAX_SONG_BARS, maxSongBars, MIN_LOOP_PERIOD_BEATS } from './sounding';
import { clipTickSpan, tickSpansOverlap } from './time';

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
const VALID_TRACK_ROLES = new Set<TrackRole>(['chords', 'bass', 'melody', 'drums']);

/** Allowed ranges for optional eq / compressor parameters. */
const EFFECT_PARAM_RANGES: Partial<Record<string, Record<string, [number, number]>>> = {
  eq: { lowGainDb: [-12, 12], midGainDb: [-12, 12], highGainDb: [-12, 12] },
  compressor: {
    thresholdDb: [-60, 0],
    ratio: [1, 20],
    attackSeconds: [0, 1],
    releaseSeconds: [0.01, 1],
  },
};

const MACRO_KEYS = ['brightness', 'release', 'width', 'attack'] as const satisfies ReadonlyArray<keyof InstrumentMacros>;
const MACRO_LABELS: Record<keyof InstrumentMacros, string> = {
  brightness: '明るさ',
  release: '余韻',
  width: '広がり',
  attack: '立ち上がり',
};

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Validate a project against the data-model rules.
 * Returns every violation found (does not stop at the first error).
 */
/**
 * A saved value for an error message without calling its own methods: numbers
 * as is, anything else as its typeof ('null' for null). `String(value)` would
 * throw for objects such as `{ toString: null }`.
 */
function describeValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  return value === null ? 'null' : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAutomation(
  automation: unknown,
  path: string,
  push: (path: string, message: string) => void,
): void {
  if (automation === undefined) return;
  if (!isRecord(automation)) {
    push(path, `音量の変化はオブジェクトで保存してください (現在: ${describeValue(automation)})`);
    return;
  }
  const lane = automation.volume;
  if (lane === undefined) return;
  const lanePath = `${path}.volume`;
  if (!isRecord(lane)) {
    push(lanePath, `音量の変化はオブジェクトで保存してください (現在: ${describeValue(lane)})`);
    return;
  }
  const { points } = lane;
  const pointsPath = `${lanePath}.points`;
  if (!Array.isArray(points)) {
    push(pointsPath, `音量の点は配列で保存してください (現在: ${describeValue(points)})`);
    return;
  }
  if (points.length > MAX_AUTOMATION_POINTS) {
    push(pointsPath, `音量の点は ${MAX_AUTOMATION_POINTS} 個までです`);
    return;
  }
  let previousBeat = 0;
  for (const [index, point] of points.entries()) {
    const pointPath = `${pointsPath}[${index}]`;
    if (!isRecord(point)) {
      push(pointPath, `音量の点には拍と音量を入れてください (現在: ${describeValue(point)})`);
      continue;
    }
    const { beat, value } = point;
    if (typeof beat !== 'number' || !Number.isFinite(beat) || beat < 0) {
      push(`${pointPath}.beat`, `拍は 0 以上の有限な数にしてください (現在: ${describeValue(beat)})`);
    } else {
      if (beat < previousBeat) push(`${pointPath}.beat`, '音量の点は拍の早い順に並べてください');
      previousBeat = beat;
    }
    if (typeof value !== 'number' || !inRange(value, 0, 1)) {
      push(`${pointPath}.value`, `音量は 0〜1 の数にしてください (現在: ${describeValue(value)})`);
    }
  }
}

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

  const barLimit = maxSongBars(project);
  if (project.legacyBarLimit !== undefined && barLimit === MAX_SONG_BARS) {
    push('legacyBarLimit', 'legacyBarLimit must be a valid converted v1 song length');
  }
  if (!Number.isInteger(project.lengthBars) || project.lengthBars <= 0 || project.lengthBars > barLimit) {
    push('lengthBars', `lengthBars must be an integer from 1 to ${barLimit} (got ${project.lengthBars})`);
  }

  if (project.swing !== undefined && !inRange(project.swing, 0, 60)) {
    push('swing', `swing must be between 0 and 60 (got ${project.swing})`);
  }

  const loopRange = project.loopRange;
  if (loopRange !== undefined) {
    const start = loopRange?.startBeat;
    const end = loopRange?.endBeat;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      push('loopRange', `loop range must satisfy 0 <= start < end (got ${start} to ${end})`);
    }
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
    if (track.type === 'master' && track.automation?.volume !== undefined) {
      push(`tracks[${ti}].automation.volume`, 'マスタートラックには音量の変化を設定できません。');
    } else {
      validateAutomation(track.automation, `tracks[${ti}].automation`, push);
    }

    if (typeof track.name !== 'string') {
      push(`tracks[${ti}].name`, 'track name must be a string');
    }
    if (!inRange(track.volume, 0, 2)) {
      push(`tracks[${ti}].volume`, `volume must be between 0 and 2 (got ${track.volume})`);
    }
    if (!inRange(track.pan, -1, 1)) {
      push(`tracks[${ti}].pan`, `pan must be between -1 and 1 (got ${track.pan})`);
    }
    (track.effects ?? []).forEach((effect, ei) => {
      const ranges = EFFECT_PARAM_RANGES[effect.type];
      if (!ranges) return;
      for (const [key, [min, max]] of Object.entries(ranges)) {
        const value = effect.params?.[key];
        if (value !== undefined && !inRange(value, min, max)) {
          push(
            `tracks[${ti}].effects[${ei}].params.${key}`,
            `${effect.type} ${key} must be between ${min} and ${max} (got ${value})`,
          );
        }
      }
    });
    const instrument = track.instrument;
    if (instrument && typeof instrument.preset !== 'string') {
      push(
        `tracks[${ti}].instrument.preset`,
        `音色名は文字列にしてください(現在: ${describeValue(instrument.preset)})`,
      );
    }
    const macros = instrument?.macros;
    if (macros !== undefined && (macros === null || typeof macros !== 'object' || Array.isArray(macros))) {
      push(`tracks[${ti}].instrument.macros`, `音色マクロは 0〜1 の数値の組にしてください(現在: ${describeValue(macros)})`);
    } else if (macros !== undefined) {
      for (const key of MACRO_KEYS) {
        const value = macros[key];
        if (typeof value !== 'number' || !inRange(value, 0, 1)) {
          push(
            `tracks[${ti}].instrument.macros.${key}`,
            `音色マクロ「${MACRO_LABELS[key]}」は 0〜1 の数値にしてください(現在: ${describeValue(value)})`,
          );
        }
      }
    }
    if (track.role !== undefined && !VALID_TRACK_ROLES.has(track.role)) {
      push(`tracks[${ti}].role`, `role must be chords, bass, melody, or drums (got ${track.role})`);
    }
  });

  // --- Clips + nested events ---
  const allClips = new Map(project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
  project.tracks.forEach((track, ti) => {
    let previousEndTick = 0;
    const sorted = track.clips.map((clip, index) => ({ clip, index }))
      .sort((a, b) => a.clip.startBeat - b.clip.startBeat);
    sorted.forEach(({ clip, index: ci }) => {
      const clipPath = `tracks[${ti}].clips[${ci}]`;
      markId(clip.id, `${clipPath}.id`);

      if (!(clip.startBeat >= 0) || !Number.isFinite(clip.startBeat)) {
        push(`${clipPath}.startBeat`, `clip start must be >= 0 (got ${clip.startBeat})`);
      }
      if (!(clip.lengthBeats > 0) || !Number.isFinite(clip.lengthBeats)) {
        push(`${clipPath}.lengthBeats`, `clip length must be > 0 (got ${clip.lengthBeats})`);
      }
      if (
        clip.contentLengthBeats !== undefined &&
        (!(clip.contentLengthBeats > 0) || !Number.isFinite(clip.contentLengthBeats))
      ) {
        push(
          `${clipPath}.contentLengthBeats`,
          `clip content length must be > 0 (got ${clip.contentLengthBeats})`,
        );
      }
      if (clip.loop && (clip.contentLengthBeats ?? clip.lengthBeats) < MIN_LOOP_PERIOD_BEATS) {
        push(`${clipPath}.contentLengthBeats`, `loop period must be at least ${MIN_LOOP_PERIOD_BEATS} beats`);
      }
      if (clip.aliasOf !== undefined) {
        const source = allClips.get(clip.aliasOf);
        if (!source || source.aliasOf !== undefined || source.type !== clip.type) {
          push(`${clipPath}.aliasOf`, 'a link must point directly to a clip of the same type');
        }
        if (clip.notes?.length || clip.drumEvents?.length || clip.audioAssetId !== undefined) {
          push(`${clipPath}.aliasOf`, 'a linked clip cannot own content');
        }
      }
      const span = clipTickSpan(clip.startBeat, clip.lengthBeats);
      // The earlier clips (sorted by start) cover at most (-Infinity, previousEndTick).
      if (tickSpansOverlap(span, [-Infinity, previousEndTick])) {
        push(`${clipPath}.startBeat`, 'clips on the same track cannot overlap');
      }
      previousEndTick = Math.max(previousEndTick, span[1]);
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
      push(`${sectionPath}.lengthBars`, `section lengthBars must be an integer from 1 to ${MAX_SONG_BARS} (got ${section.lengthBars})`);
    }
  });

  if (errors.length === 0) {
    const problem = findProjectSoundingLimitProblem(project);
    if (problem) push('tracks', problem);
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
