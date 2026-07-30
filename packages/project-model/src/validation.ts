// Project validation. Enforces docs/06_data_model.md section 5 plus structural
// integrity checks (unique ids, clip.trackId references an existing track).

import {
  beatsPerBar,
  compileDrumStepProjector,
  compileMusicalTime,
  projectDrumStep,
  projectLengthBeats as projectTimelineLengthBeats,
  secondsBetweenBeats,
} from './time';
import {
  audioWarpTimingSegmentIssues,
  iterateAudioWarpTimingSegments,
} from './audio-warp';
import type { Project } from './types';
import { CURRENT_SCHEMA_VERSION } from './factories';
import {
  MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
  preflightScheduleEventBudget,
} from './schedule-budget';
import {
  MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER,
  MAX_AUDIO_TAKE_FOLDERS,
  MAX_AUDIO_TAKES_PER_FOLDER,
  MAX_AUDIO_PITCH_REGIONS,
  MAX_AUDIO_PITCH_SHIFT_CENTS,
  MAX_AUDIO_WARP_MARKERS,
  MAX_AUDIO_WARP_SECONDS,
  MAX_AUDIO_WARP_STRETCH,
  MAX_CLIPS_PER_TRACK,
  MIN_AUDIO_WARP_SEGMENT_SECONDS,
  MIN_AUDIO_WARP_STRETCH,
  MIN_EVENT_DURATION_BEATS,
} from './limits';
import { validateAudioRouting } from './audio-routing';
import {
  automationTargetTypesForTrack,
  effectiveMasterTrackId,
  isSupportedAutomationTarget,
} from './automation-targets';

export {
  MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER,
  MAX_AUDIO_TAKE_FOLDERS,
  MAX_AUDIO_TAKES_PER_FOLDER,
  MAX_AUDIO_PITCH_REGIONS,
  MAX_AUDIO_WARP_MARKERS,
  MAX_AUDIO_WARP_STRETCH,
  MAX_CLIPS_PER_TRACK,
  MIN_AUDIO_WARP_SEGMENT_SECONDS,
  MIN_AUDIO_WARP_STRETCH,
  MIN_EVENT_DURATION_BEATS,
} from './limits';

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
export const MAX_TEMPO_MAP_EVENTS = 4_096;
export const MAX_TIME_SIGNATURE_MAP_EVENTS = 1_024;
export const MAX_AUDIO_ASSETS = 4_096;
export const MAX_AUTOMATION_LANES = 2_048;
export const MAX_AUTOMATION_POINTS_PER_LANE = 20_000;
export const MAX_PROJECT_TIMELINE_BEATS =
  MAX_PROJECT_LENGTH_BARS * MAX_TIME_SIGNATURE_NUMERATOR;
export const MAX_PROJECT_VALIDATION_ERRORS = 100;
export const SAFE_TRACK_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const TRACK_ROLES = new Set([
  'general',
  'learning.chords',
  'learning.bass',
  'learning.melody',
]);

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function sameBeat(left: number, right: number): boolean {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= 1e-9;
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
  if (project.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    push(
      'schemaVersion',
      `schemaVersion must be ${CURRENT_SCHEMA_VERSION} (got ${project.schemaVersion})`,
    );
  }
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
  const projectLengthValid =
    Number.isFinite(projectLengthBeats)
    && projectLengthBeats > 0
    && projectLengthBeats <= MAX_PROJECT_TIMELINE_BEATS;
  if (!projectLengthValid) {
    push(
      'lengthBeats',
      `project timeline must not exceed ${MAX_PROJECT_TIMELINE_BEATS} quarter-note beats (got ${projectLengthBeats})`,
    );
  }

  const lengthBarsValid = Number.isInteger(project.lengthBars)
    && project.lengthBars > 0
    && project.lengthBars <= MAX_PROJECT_LENGTH_BARS;
  if (!lengthBarsValid) {
    push(
      'lengthBars',
      `lengthBars must be an integer between 1 and ${MAX_PROJECT_LENGTH_BARS} (got ${project.lengthBars})`,
    );
  }

  let tempoMapValid = projectLengthValid
    && project.tempoMap.length > 0
    && project.tempoMap.length <= MAX_TEMPO_MAP_EVENTS;
  if (project.tempoMap.length === 0) {
    push('tempoMap', 'tempoMap must contain a beat-0 event');
  } else if (project.tempoMap[0]?.beat !== 0) {
    push('tempoMap[0].beat', 'the first tempo event must start at beat 0');
    tempoMapValid = false;
  }
  if (project.tempoMap.length > MAX_TEMPO_MAP_EVENTS) {
    push('tempoMap', `tempoMap must contain at most ${MAX_TEMPO_MAP_EVENTS} items`);
    tempoMapValid = false;
  }
  let previousTempoBeat = Number.NEGATIVE_INFINITY;
  project.tempoMap.forEach((event, index) => {
    const path = `tempoMap[${index}]`;
    if (!inRange(event.bpm, 20, 300)) {
      push(`${path}.bpm`, `bpm must be between 20 and 300 (got ${event.bpm})`);
      tempoMapValid = false;
    }
    if (!inRange(event.beat, 0, projectLengthBeats)) {
      push(`${path}.beat`, 'tempo event beat must fall within the project timeline');
      tempoMapValid = false;
    }
    if (event.beat <= previousTempoBeat) {
      push(`${path}.beat`, 'tempo event beats must be strictly increasing');
      tempoMapValid = false;
    }
    previousTempoBeat = event.beat;
  });
  if (project.tempoMap[0] !== undefined && project.bpm !== project.tempoMap[0].bpm) {
    push('bpm', 'bpm must mirror tempoMap[0].bpm');
    tempoMapValid = false;
  }

  let signatureSegmentsValid = projectLengthValid
    && lengthBarsValid
    && project.timeSignatureMap.length > 0
    && project.timeSignatureMap.length <= MAX_TIME_SIGNATURE_MAP_EVENTS;
  if (project.timeSignatureMap.length === 0) {
    push('timeSignatureMap', 'timeSignatureMap must contain a beat-0 event');
  } else if (project.timeSignatureMap[0]?.beat !== 0) {
    push('timeSignatureMap[0].beat', 'the first time-signature event must start at beat 0');
    signatureSegmentsValid = false;
  }
  if (project.timeSignatureMap.length > MAX_TIME_SIGNATURE_MAP_EVENTS) {
    push(
      'timeSignatureMap',
      `timeSignatureMap must contain at most ${MAX_TIME_SIGNATURE_MAP_EVENTS} items`,
    );
    signatureSegmentsValid = false;
  }
  let previousSignatureBeat = Number.NEGATIVE_INFINITY;
  let previousSignatureBeatsPerBar = 0;
  let computedLengthBars = 0;
  project.timeSignatureMap.forEach((event, index) => {
    const path = `timeSignatureMap[${index}]`;
    if (
      !Number.isInteger(event.numerator)
      || event.numerator <= 0
      || event.numerator > MAX_TIME_SIGNATURE_NUMERATOR
    ) {
      push(
        `${path}.numerator`,
        `time signature numerator must be an integer between 1 and ${MAX_TIME_SIGNATURE_NUMERATOR}`,
      );
      signatureSegmentsValid = false;
    }
    if (!VALID_DENOMINATORS.has(event.denominator)) {
      push(`${path}.denominator`, 'time signature denominator must be 2, 4, 8, or 16');
      signatureSegmentsValid = false;
    }
    if (!inRange(event.beat, 0, projectLengthBeats)) {
      push(`${path}.beat`, 'time-signature event beat must fall within the project timeline');
      signatureSegmentsValid = false;
    }
    if (event.beat <= previousSignatureBeat) {
      push(`${path}.beat`, 'time-signature event beats must be strictly increasing');
      signatureSegmentsValid = false;
    }
    if (index > 0 && previousSignatureBeatsPerBar > 0) {
      const segmentBars = (event.beat - previousSignatureBeat) / previousSignatureBeatsPerBar;
      if (!Number.isInteger(segmentBars)) {
        push(`${path}.beat`, 'time-signature changes must occur on a bar boundary');
        signatureSegmentsValid = false;
      } else {
        computedLengthBars += segmentBars;
      }
    }
    previousSignatureBeat = event.beat;
    previousSignatureBeatsPerBar = beatsPerBar([event.numerator, event.denominator]);
  });
  if (signatureSegmentsValid && previousSignatureBeatsPerBar > 0) {
    const finalBars = (projectLengthBeats - previousSignatureBeat) / previousSignatureBeatsPerBar;
    if (!Number.isInteger(finalBars)) {
      push('lengthBeats', 'the project must end on a bar boundary');
      signatureSegmentsValid = false;
    } else {
      computedLengthBars += finalBars;
      if (project.lengthBars !== computedLengthBars) {
        push('lengthBars', 'lengthBars must mirror the actual time-signature-map bar count');
        signatureSegmentsValid = false;
      }
    }
  }
  const firstSignature = project.timeSignatureMap[0];
  if (
    firstSignature !== undefined
    && (project.timeSignature[0] !== firstSignature.numerator
      || project.timeSignature[1] !== firstSignature.denominator)
  ) {
    push('timeSignature', 'timeSignature must mirror the beat-0 timeSignatureMap event');
    signatureSegmentsValid = false;
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

  project.tempoMap.forEach((event, index) => {
    markId(event.id, `tempoMap[${index}].id`);
  });
  project.timeSignatureMap.forEach((event, index) => {
    markId(event.id, `timeSignatureMap[${index}].id`);
  });

  if (project.audioAssets.length > MAX_AUDIO_ASSETS) {
    push('audioAssets', `audioAssets must contain at most ${MAX_AUDIO_ASSETS} items`);
  }
  const audioAssetsById = new Map<string, Project['audioAssets'][number]>();
  project.audioAssets.forEach((asset, index) => {
    const path = `audioAssets[${index}]`;
    markId(asset.id, `${path}.id`);
    if (!audioAssetsById.has(asset.id)) audioAssetsById.set(asset.id, asset);
    if (asset.availability === 'ready') {
      if (!SHA256_PATTERN.test(asset.checksumSha256)) {
        push(`${path}.checksumSha256`, 'checksumSha256 must be 64 lowercase hexadecimal digits');
      }
      if (asset.originalName.length === 0) {
        push(`${path}.originalName`, 'originalName must not be empty');
      }
      if (!['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/aac'].includes(asset.mediaType)) {
        push(`${path}.mediaType`, 'unsupported audio media type');
      }
      if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0) {
        push(`${path}.byteLength`, 'byteLength must be a positive safe integer');
      }
      if (!Number.isSafeInteger(asset.sampleRate) || !inRange(asset.sampleRate, 8_000, 384_000)) {
        push(`${path}.sampleRate`, 'sampleRate must be an integer between 8000 and 384000');
      }
      if (!Number.isSafeInteger(asset.channelCount) || !inRange(asset.channelCount, 1, 32)) {
        push(`${path}.channelCount`, 'channelCount must be an integer between 1 and 32');
      }
      if (!Number.isSafeInteger(asset.frameCount) || asset.frameCount <= 0) {
        push(`${path}.frameCount`, 'frameCount must be a positive safe integer');
      }
    } else {
      if (asset.reason === 'legacy-reference') {
        if (asset.legacyAssetId === undefined || asset.legacyAssetId.length === 0) {
          push(`${path}.legacyAssetId`, 'legacy-reference assets require a non-empty legacyAssetId');
        }
      } else if (asset.legacyAssetId !== undefined) {
        push(`${path}.legacyAssetId`, 'missing-reference assets must not have legacyAssetId');
      }
    }
  });

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
  const tracksById = new Map<string, Project['tracks'][number]>();
  const claimedLearningRoles = new Set<string>();
  project.tracks.forEach((track, ti) => {
    if (atErrorLimit()) return;
    markId(track.id, `tracks[${ti}].id`);
    trackIds.add(track.id);
    if (!tracksById.has(track.id)) tracksById.set(track.id, track);

    if (!TRACK_ROLES.has(track.role)) {
      push(`tracks[${ti}].role`, `unsupported track role "${track.role}"`);
    }
    if (track.role !== 'general') {
      if (track.type !== 'instrument') {
        push(`tracks[${ti}].role`, 'learning roles are only allowed on instrument tracks');
      }
      if (claimedLearningRoles.has(track.role)) {
        push(`tracks[${ti}].role`, `learning role "${track.role}" must be unique`);
      } else {
        claimedLearningRoles.add(track.role);
      }
    }

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

  project.audioRouting.sends.forEach((send, index) => {
    if (atErrorLimit()) return;
    markId(send.id, `audioRouting.sends[${index}].id`);
  });
  const routingValidation = validateAudioRouting(project);
  for (const error of routingValidation.errors) {
    if (atErrorLimit()) break;
    push(error.path, error.message);
  }

  let musicalTimeIndex: ReturnType<typeof compileMusicalTime> | null = null;
  if (tempoMapValid && signatureSegmentsValid) {
    try {
      musicalTimeIndex = compileMusicalTime(project);
    } catch {
      // Map-specific errors above are more actionable than a derived-index error.
    }
  }

  if (project.audioTakeFolders.length > MAX_AUDIO_TAKE_FOLDERS) {
    push(
      'audioTakeFolders',
      `audioTakeFolders must contain at most ${MAX_AUDIO_TAKE_FOLDERS} items`,
    );
  }
  const seenAudioTakeFolderWindows: Array<Readonly<{
    trackId: string;
    startBeat: number;
    lengthBeats: number;
  }>> = [];
  project.audioTakeFolders.forEach((folder, folderIndex) => {
    if (atErrorLimit()) return;
    const folderPath = `audioTakeFolders[${folderIndex}]`;
    markId(folder.id, `${folderPath}.id`);
    const folderTrack = tracksById.get(folder.trackId);
    if (folderTrack === undefined) {
      push(
        `${folderPath}.trackId`,
        `Audio take folder references missing track "${folder.trackId}"`,
      );
    } else if (folderTrack.type !== 'audio') {
      push(`${folderPath}.trackId`, 'Audio take folders must belong to an Audio track');
    }
    if (seenAudioTakeFolderWindows.some((window) => (
      window.trackId === folder.trackId
      && sameBeat(window.startBeat, folder.startBeat)
      && sameBeat(window.lengthBeats, folder.lengthBeats)
    ))) {
      push(
        folderPath,
        'Only one Audio take folder may occupy the same track and timeline window',
      );
    } else {
      seenAudioTakeFolderWindows.push({
        trackId: folder.trackId,
        startBeat: folder.startBeat,
        lengthBeats: folder.lengthBeats,
      });
    }
    if (!inRange(folder.startBeat, 0, projectLengthBeats)) {
      push(`${folderPath}.startBeat`, 'Audio take folder start must fall within the project timeline');
    }
    if (
      !Number.isFinite(folder.lengthBeats)
      || folder.lengthBeats < MIN_EVENT_DURATION_BEATS
      || folder.lengthBeats > MAX_PROJECT_TIMELINE_BEATS
    ) {
      push(
        `${folderPath}.lengthBeats`,
        `Audio take folder length must be between ${MIN_EVENT_DURATION_BEATS} and ${MAX_PROJECT_TIMELINE_BEATS} beats`,
      );
    } else if (
      Number.isFinite(folder.startBeat)
      && folder.startBeat + folder.lengthBeats > projectLengthBeats
    ) {
      push(`${folderPath}.lengthBeats`, 'Audio take folder must end within the project timeline');
    }
    if (!inRange(folder.crossfadeMs, 0, 50)) {
      push(`${folderPath}.crossfadeMs`, 'crossfadeMs must be between 0 and 50');
    }
    if (folder.takes.length < 2 || folder.takes.length > MAX_AUDIO_TAKES_PER_FOLDER) {
      push(
        `${folderPath}.takes`,
        `Audio take folder must contain between 2 and ${MAX_AUDIO_TAKES_PER_FOLDER} takes`,
      );
    }
    if (
      folder.compSegments.length < 1
      || folder.compSegments.length > MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER
    ) {
      push(
        `${folderPath}.compSegments`,
        `Audio take folder must contain between 1 and ${MAX_AUDIO_COMP_SEGMENTS_PER_FOLDER} comp segments`,
      );
    }

    const takesById = new Map<string, Project['audioTakeFolders'][number]['takes'][number]>();
    folder.takes.forEach((take, takeIndex) => {
      if (atErrorLimit()) return;
      const takePath = `${folderPath}.takes[${takeIndex}]`;
      markId(take.id, `${takePath}.id`);
      if (!takesById.has(take.id)) takesById.set(take.id, take);
      const asset = audioAssetsById.get(take.audioAssetId);
      if (asset === undefined) {
        push(
          `${takePath}.audioAssetId`,
          `audioAssetId "${take.audioAssetId}" references a non-existent audio asset`,
        );
      } else if (asset.availability !== 'ready') {
        push(`${takePath}.audioAssetId`, 'Audio takes require a ready audio asset');
      }
      if (!inRange(take.offsetBeats, 0, folder.lengthBeats)) {
        push(`${takePath}.offsetBeats`, 'Audio take offset must fall within its folder');
      }
      if (
        !Number.isFinite(take.lengthBeats)
        || take.lengthBeats < MIN_EVENT_DURATION_BEATS
        || take.lengthBeats > folder.lengthBeats
      ) {
        push(`${takePath}.lengthBeats`, 'Audio take length must be positive and fit its folder');
      } else if (
        Number.isFinite(take.offsetBeats)
        && take.offsetBeats + take.lengthBeats > folder.lengthBeats
      ) {
        push(`${takePath}.lengthBeats`, 'Audio take range must fit within its folder');
      }
      if (!Number.isSafeInteger(take.sourceStartFrame) || take.sourceStartFrame < 0) {
        push(`${takePath}.sourceStartFrame`, 'sourceStartFrame must be a non-negative safe integer');
      }
      if (!Number.isSafeInteger(take.sourceFrameCount) || take.sourceFrameCount <= 0) {
        push(`${takePath}.sourceFrameCount`, 'sourceFrameCount must be a positive safe integer');
      }
      if (
        asset?.availability === 'ready'
        && Number.isSafeInteger(take.sourceStartFrame)
        && Number.isSafeInteger(take.sourceFrameCount)
        && take.sourceStartFrame + take.sourceFrameCount > asset.frameCount
      ) {
        push(`${takePath}.sourceFrameCount`, 'Audio take source range must fit within the asset');
      }
      if (
        asset?.availability === 'ready'
        && musicalTimeIndex !== null
        && Number.isFinite(folder.startBeat)
        && folder.startBeat >= 0
        && Number.isFinite(take.offsetBeats)
        && take.offsetBeats >= 0
        && Number.isFinite(take.lengthBeats)
        && take.lengthBeats >= MIN_EVENT_DURATION_BEATS
        && folder.startBeat + take.offsetBeats + take.lengthBeats
          <= musicalTimeIndex.lengthBeats
        && Number.isSafeInteger(take.sourceFrameCount)
        && take.sourceFrameCount > 0
      ) {
        const takeStartBeat = folder.startBeat + take.offsetBeats;
        const requiredFrames = secondsBetweenBeats(
          musicalTimeIndex,
          takeStartBeat,
          takeStartBeat + take.lengthBeats,
        ) * asset.sampleRate;
        if (
          Number.isFinite(requiredFrames)
          && requiredFrames > 0
          && take.sourceFrameCount + 1 < requiredFrames
        ) {
          push(
            `${takePath}.sourceFrameCount`,
            'Audio take source must cover its timeline window within one frame of rounding tolerance',
          );
        }
      }
      for (const field of ['fadeInFrames', 'fadeOutFrames'] as const) {
        if (!Number.isSafeInteger(take[field]) || take[field] < 0) {
          push(`${takePath}.${field}`, `${field} must be a non-negative safe integer`);
        }
      }
      if (
        Number.isSafeInteger(take.fadeInFrames)
        && Number.isSafeInteger(take.fadeOutFrames)
        && Number.isSafeInteger(take.sourceFrameCount)
        && take.fadeInFrames + take.fadeOutFrames > take.sourceFrameCount
      ) {
        push(`${takePath}.fadeOutFrames`, 'combined fades must not exceed sourceFrameCount');
      }
      if (!inRange(take.gainDb, -96, 24)) {
        push(`${takePath}.gainDb`, 'gainDb must be between -96 and 24');
      }
    });

    let expectedOffset = 0;
    let previousTakeId: string | undefined;
    folder.compSegments.forEach((segment, segmentIndex) => {
      if (atErrorLimit()) return;
      const segmentPath = `${folderPath}.compSegments[${segmentIndex}]`;
      markId(segment.id, `${segmentPath}.id`);
      const take = takesById.get(segment.takeId);
      if (take === undefined) {
        push(`${segmentPath}.takeId`, `Comp segment references missing take "${segment.takeId}"`);
      }
      if (previousTakeId === segment.takeId) {
        push(`${segmentPath}.takeId`, 'Adjacent comp segments for the same take must be merged');
      }
      if (!sameBeat(segment.offsetBeats, expectedOffset)) {
        push(
          `${segmentPath}.offsetBeats`,
          segment.offsetBeats < expectedOffset
            ? 'Comp segments must not overlap and must be sorted'
            : 'Comp segments must be gapless and sorted',
        );
      }
      if (
        !Number.isFinite(segment.lengthBeats)
        || segment.lengthBeats < MIN_EVENT_DURATION_BEATS
        || segment.lengthBeats > folder.lengthBeats
      ) {
        push(`${segmentPath}.lengthBeats`, 'Comp segment length must be positive and fit its folder');
      }
      if (
        take !== undefined
        && (
          segment.offsetBeats < take.offsetBeats
          || segment.offsetBeats + segment.lengthBeats > take.offsetBeats + take.lengthBeats
        )
      ) {
        push(`${segmentPath}.takeId`, 'Comp segment range must fit within its selected take');
      }
      expectedOffset = segment.offsetBeats + segment.lengthBeats;
      previousTakeId = segment.takeId;
    });
    if (
      folder.compSegments.length > 0
      && !sameBeat(expectedOffset, folder.lengthBeats)
    ) {
      push(`${folderPath}.compSegments`, 'Comp segments must exactly cover the Audio take folder');
    }
  });

  if (project.automationLanes.length > MAX_AUTOMATION_LANES) {
    push(
      'automationLanes',
      `automationLanes must contain at most ${MAX_AUTOMATION_LANES} items`,
    );
  }
  const automationTargets = new Set<string>();
  project.automationLanes.forEach((lane, laneIndex) => {
    if (atErrorLimit()) return;
    const lanePath = `automationLanes[${laneIndex}]`;
    markId(lane.id, `${lanePath}.id`);
    if (!trackIds.has(lane.target.trackId)) {
      push(`${lanePath}.target.trackId`, `automation target references missing track "${lane.target.trackId}"`);
    } else if (!isSupportedAutomationTarget(project, lane.target)) {
      push(
        `${lanePath}.target.trackId`,
        'automation target is not supported for this track',
      );
    }
    const targetKey = `${lane.target.type}\u0000${lane.target.trackId}`;
    if (automationTargets.has(targetKey)) {
      push(`${lanePath}.target`, 'only one automation lane is allowed per target');
    } else {
      automationTargets.add(targetKey);
    }
    if (lane.points.length > MAX_AUTOMATION_POINTS_PER_LANE) {
      push(
        `${lanePath}.points`,
        `automation lane must contain at most ${MAX_AUTOMATION_POINTS_PER_LANE} points`,
      );
    }
    let previousBeat = Number.NEGATIVE_INFINITY;
    lane.points.forEach((point, pointIndex) => {
      if (atErrorLimit()) return;
      const pointPath = `${lanePath}.points[${pointIndex}]`;
      markId(point.id, `${pointPath}.id`);
      if (!inRange(point.beat, 0, projectLengthBeats)) {
        push(`${pointPath}.beat`, 'automation point must fall within the project timeline');
      }
      if (point.beat <= previousBeat) {
        push(`${pointPath}.beat`, 'automation point beats must be strictly increasing');
      }
      previousBeat = point.beat;
      const valueRange = lane.target.type === 'track-volume' ? [0, 2] : [-1, 1];
      if (!inRange(point.value, valueRange[0] ?? 0, valueRange[1] ?? 0)) {
        push(
          `${pointPath}.value`,
          `${lane.target.type} automation value is outside its allowed range`,
        );
      }
    });
  });

  const automationReadState: unknown = project.automationReadState;
  if (
    typeof automationReadState !== 'object'
    || automationReadState === null
    || Array.isArray(automationReadState)
  ) {
    push('automationReadState', 'automationReadState must be an object');
  } else {
    const readState = automationReadState as Record<string, unknown>;
    for (const key of Object.keys(readState)) {
      if (key !== 'globalEnabled' && key !== 'disabledTrackIds') {
        push(`automationReadState.${key}`, `unknown automation Read field "${key}"`);
      }
    }
    if (typeof readState.globalEnabled !== 'boolean') {
      push(
        'automationReadState.globalEnabled',
        'globalEnabled must be a required boolean',
      );
    }
    const disabledTrackIds = readState.disabledTrackIds;
    if (!Array.isArray(disabledTrackIds)) {
      push(
        'automationReadState.disabledTrackIds',
        'disabledTrackIds must be a required string array',
      );
    } else {
      const disabledReadIds = new Set<string>();
      disabledTrackIds.forEach((trackId, index) => {
        const path = `automationReadState.disabledTrackIds[${index}]`;
        if (typeof trackId !== 'string') {
          push(path, 'automation Read track id must be a string');
          return;
        }
        if (disabledReadIds.has(trackId)) {
          push(path, `automation Read track id must be unique (duplicate id "${trackId}")`);
        } else {
          disabledReadIds.add(trackId);
        }
        const track = tracksById.get(trackId);
        if (!track) {
          push(path, `automation Read state references missing track "${trackId}"`);
        } else if (automationTargetTypesForTrack(project, track.id).length === 0) {
          push(path, 'automation Read state cannot reference this track');
        }
      });
      const effectiveMasterId = effectiveMasterTrackId(project);
      const canonicalDisabledReadIds = project.tracks
        .filter((track) =>
          (track.type !== 'master' || track.id === effectiveMasterId)
          && disabledReadIds.has(track.id))
        .map((track) => track.id);
      if (
        canonicalDisabledReadIds.length === disabledTrackIds.length
        && canonicalDisabledReadIds.some(
          (trackId, index) => disabledTrackIds[index] !== trackId,
        )
      ) {
        push(
          'automationReadState.disabledTrackIds',
          'automation Read track ids must use canonical project track order',
        );
      }
    }
  }

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
        if (clip.audioWarp !== undefined) {
          push(`${clipPath}.audioWarp`, 'linked clip payload belongs to its source');
        }
        for (const field of [
          'sourceStartFrame',
          'sourceFrameCount',
          'fadeInFrames',
          'fadeOutFrames',
          'gainDb',
        ] as const) {
          if (clip[field] !== undefined) {
            push(`${clipPath}.${field}`, 'linked clip payload belongs to its source');
          }
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
      if (clip.type !== 'audio' && clip.audioWarp !== undefined) {
        push(`${clipPath}.audioWarp`, 'audioWarp is only allowed on audio clips');
      }
      const audioFields = [
        'sourceStartFrame',
        'sourceFrameCount',
        'fadeInFrames',
        'fadeOutFrames',
        'gainDb',
      ] as const;
      if (clip.type !== 'audio') {
        for (const field of audioFields) {
          if (clip[field] !== undefined) {
            push(`${clipPath}.${field}`, `${field} is only allowed on audio clips`);
          }
        }
      } else {
        if (clip.audioAssetId === undefined || clip.audioAssetId.length === 0) {
          push(`${clipPath}.audioAssetId`, 'audio clips require a non-empty audioAssetId');
        }
        for (const field of audioFields) {
          if (clip[field] === undefined) {
            push(`${clipPath}.${field}`, `audio clips require ${field}`);
          }
        }
        const asset = clip.audioAssetId === undefined
          ? undefined
          : audioAssetsById.get(clip.audioAssetId);
        if (clip.audioAssetId !== undefined && asset === undefined) {
          push(
            `${clipPath}.audioAssetId`,
            `audioAssetId "${clip.audioAssetId}" references a non-existent audio asset`,
          );
        }
        if (!inRange(clip.gainDb ?? Number.NaN, -96, 24)) {
          push(`${clipPath}.gainDb`, 'gainDb must be between -96 and 24');
        }
        if (asset?.availability === 'ready') {
          if (track.type !== 'audio') {
            push(`${clipPath}.audioAssetId`, 'ready audio assets may only be used on audio tracks');
          }
          if (!Number.isSafeInteger(clip.sourceStartFrame) || (clip.sourceStartFrame ?? -1) < 0) {
            push(`${clipPath}.sourceStartFrame`, 'sourceStartFrame must be a non-negative safe integer');
          }
          if (!Number.isSafeInteger(clip.sourceFrameCount) || (clip.sourceFrameCount ?? 0) <= 0) {
            push(`${clipPath}.sourceFrameCount`, 'ready audio clips require a positive sourceFrameCount');
          }
          if (
            Number.isSafeInteger(clip.sourceStartFrame)
            && Number.isSafeInteger(clip.sourceFrameCount)
            && (clip.sourceStartFrame ?? 0) + (clip.sourceFrameCount ?? 0) > asset.frameCount
          ) {
            push(`${clipPath}.sourceFrameCount`, 'audio source range must fit within the asset');
          }
          for (const field of ['fadeInFrames', 'fadeOutFrames'] as const) {
            if (!Number.isSafeInteger(clip[field]) || (clip[field] ?? -1) < 0) {
              push(`${clipPath}.${field}`, `${field} must be a non-negative safe integer`);
            }
          }
          if (
            Number.isSafeInteger(clip.fadeInFrames)
            && Number.isSafeInteger(clip.fadeOutFrames)
            && Number.isSafeInteger(clip.sourceFrameCount)
            && (clip.fadeInFrames ?? 0) + (clip.fadeOutFrames ?? 0) > (clip.sourceFrameCount ?? 0)
          ) {
            push(`${clipPath}.fadeOutFrames`, 'combined fades must not exceed sourceFrameCount');
          }
          if (clip.audioWarp !== undefined) {
            const warp = clip.audioWarp;
            const warpPath = `${clipPath}.audioWarp`;
            if (
              asset.mediaType !== 'audio/wav'
              || asset.sampleRate !== 48_000
              || (asset.channelCount !== 1 && asset.channelCount !== 2)
            ) {
              push(
                warpPath,
                'audioWarp requires canonical 48 kHz mono or stereo PCM16 WAV source metadata',
              );
            }
            if (clip.loop) {
              push(warpPath, 'audioWarp is only supported on non-looping Audio Clips');
            }
            if (warp.algorithm !== 'wsola-v1') {
              push(`${warpPath}.algorithm`, 'algorithm must be wsola-v1');
            }
            if (warp.markers.length < 2 || warp.markers.length > MAX_AUDIO_WARP_MARKERS) {
              push(
                `${warpPath}.markers`,
                `markers must contain between 2 and ${MAX_AUDIO_WARP_MARKERS} items`,
              );
            }
            if (warp.pitchRegions.length > MAX_AUDIO_PITCH_REGIONS) {
              push(
                `${warpPath}.pitchRegions`,
                `pitchRegions must contain at most ${MAX_AUDIO_PITCH_REGIONS} items`,
              );
            }
            if (
              Number.isSafeInteger(clip.sourceFrameCount)
              && (clip.sourceFrameCount ?? 0) / asset.sampleRate > MAX_AUDIO_WARP_SECONDS
            ) {
              push(
                `${clipPath}.sourceFrameCount`,
                `an edited source window must not exceed ${MAX_AUDIO_WARP_SECONDS} seconds`,
              );
            }
            let previousSource = Number.NEGATIVE_INFINITY;
            let previousBeat = Number.NEGATIVE_INFINITY;
            let timingMarkersCanPartition = warp.markers.length >= 2
              && warp.markers.length <= MAX_AUDIO_WARP_MARKERS;
            warp.markers.forEach((marker, markerIndex) => {
              const markerPath = `${warpPath}.markers[${markerIndex}]`;
              if (!Number.isSafeInteger(marker.sourceFrame)) {
                push(`${markerPath}.sourceFrame`, 'sourceFrame must be a safe integer');
                timingMarkersCanPartition = false;
              }
              if (!Number.isFinite(marker.targetBeatOffset)) {
                push(`${markerPath}.targetBeatOffset`, 'targetBeatOffset must be finite');
                timingMarkersCanPartition = false;
              }
              if (marker.sourceFrame <= previousSource) {
                push(`${markerPath}.sourceFrame`, 'marker source frames must be strictly increasing');
                timingMarkersCanPartition = false;
              }
              if (marker.targetBeatOffset <= previousBeat) {
                push(`${markerPath}.targetBeatOffset`, 'marker beat offsets must be strictly increasing');
                timingMarkersCanPartition = false;
              }
              previousSource = marker.sourceFrame;
              previousBeat = marker.targetBeatOffset;
            });
            if (
              timingMarkersCanPartition
              && musicalTimeIndex !== null
              && Number.isFinite(clip.startBeat)
              && Number.isFinite(asset.sampleRate)
              && asset.sampleRate > 0
            ) {
              const timingSegments = iterateAudioWarpTimingSegments(
                warp,
                clip.startBeat,
                project.tempoMap,
              );
              for (const segment of timingSegments) {
                const markerPath = `${warpPath}.markers[${segment.markerIndex}]`;
                const issues = audioWarpTimingSegmentIssues(segment, asset.sampleRate);
                if (issues.includes('source-segment-too-short')) {
                  push(
                    `${markerPath}.sourceFrame`,
                    `source timing intervals must be at least ${MIN_AUDIO_WARP_SEGMENT_SECONDS} seconds`,
                  );
                }
                if (issues.includes('target-segment-too-short')) {
                  push(
                    `${markerPath}.targetBeatOffset`,
                    `target timing intervals must be at least ${MIN_AUDIO_WARP_SEGMENT_SECONDS} seconds`,
                  );
                }
                if (issues.includes('stretch-out-of-range')) {
                  push(
                    `${markerPath}.targetBeatOffset`,
                    `local stretch must be between ${MIN_AUDIO_WARP_STRETCH}x and ${MAX_AUDIO_WARP_STRETCH}x`,
                  );
                }
                if (issues.length > 0) break;
              }
            }
            const expectedStart = clip.sourceStartFrame ?? Number.NaN;
            const expectedEnd = expectedStart + (clip.sourceFrameCount ?? Number.NaN);
            if (warp.markers[0]?.sourceFrame !== expectedStart) {
              push(`${warpPath}.markers[0].sourceFrame`, 'the first marker must start at the source window');
            }
            if (warp.markers[0]?.targetBeatOffset !== 0) {
              push(`${warpPath}.markers[0].targetBeatOffset`, 'the first marker beat offset must be zero');
            }
            const lastMarkerIndex = Math.max(0, warp.markers.length - 1);
            if (warp.markers[lastMarkerIndex]?.sourceFrame !== expectedEnd) {
              push(
                `${warpPath}.markers[${lastMarkerIndex}].sourceFrame`,
                'the last marker must end at the source window',
              );
            }
            if (warp.markers[lastMarkerIndex]?.targetBeatOffset !== clip.lengthBeats) {
              push(
                `${warpPath}.markers[${lastMarkerIndex}].targetBeatOffset`,
                'the last marker beat offset must equal clip lengthBeats',
              );
            }
            let previousRegionEnd = expectedStart;
            warp.pitchRegions.forEach((region, regionIndex) => {
              const regionPath = `${warpPath}.pitchRegions[${regionIndex}]`;
              if (!Number.isSafeInteger(region.sourceStartFrame)) {
                push(`${regionPath}.sourceStartFrame`, 'sourceStartFrame must be a safe integer');
              }
              if (!Number.isSafeInteger(region.sourceFrameCount) || region.sourceFrameCount <= 0) {
                push(`${regionPath}.sourceFrameCount`, 'sourceFrameCount must be a positive safe integer');
              }
              const regionEnd = region.sourceStartFrame + region.sourceFrameCount;
              if (
                region.sourceStartFrame < expectedStart
                || region.sourceStartFrame < previousRegionEnd
              ) {
                push(
                  `${regionPath}.sourceStartFrame`,
                  'pitch regions must be ordered, non-overlapping, and inside the source window',
                );
              }
              if (regionEnd > expectedEnd) {
                push(`${regionPath}.sourceFrameCount`, 'pitch region must end inside the source window');
              }
              if (
                !Number.isFinite(region.sourcePitchCents)
                || region.sourcePitchCents < 0
                || region.sourcePitchCents > 12_700
              ) {
                push(`${regionPath}.sourcePitchCents`, 'sourcePitchCents must be between 0 and 12700');
              }
              if (
                !Number.isFinite(region.targetPitchCents)
                || region.targetPitchCents < 0
                || region.targetPitchCents > 12_700
              ) {
                push(`${regionPath}.targetPitchCents`, 'targetPitchCents must be between 0 and 12700');
              }
              if (!inRange(region.correctionAmount, 0, 1)) {
                push(`${regionPath}.correctionAmount`, 'correctionAmount must be between 0 and 1');
              }
              const effectiveShift =
                (region.targetPitchCents - region.sourcePitchCents) * region.correctionAmount;
              if (!Number.isFinite(effectiveShift) || Math.abs(effectiveShift) > MAX_AUDIO_PITCH_SHIFT_CENTS) {
                push(
                  `${regionPath}.targetPitchCents`,
                  `effective pitch shift must be within plus or minus ${MAX_AUDIO_PITCH_SHIFT_CENTS} cents`,
                );
              }
              if (
                !Number.isSafeInteger(region.transitionFrames)
                || region.transitionFrames < 0
                || region.transitionFrames > Math.floor(region.sourceFrameCount / 2)
              ) {
                push(
                  `${regionPath}.transitionFrames`,
                  'transitionFrames must be a non-negative safe integer no greater than half the region',
                );
              }
              previousRegionEnd = Math.max(previousRegionEnd, regionEnd);
            });
          }
        } else if (asset?.availability === 'unresolved') {
          for (const field of [
            'sourceStartFrame',
            'sourceFrameCount',
            'fadeInFrames',
            'fadeOutFrames',
          ] as const) {
            if (clip[field] !== 0) {
              push(`${clipPath}.${field}`, 'unresolved audio clips must use a zero source range');
            }
          }
          if (clip.audioWarp !== undefined) {
            push(`${clipPath}.audioWarp`, 'audioWarp requires a ready audio asset');
          }
        }
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

      const stepsPerBar = clip.stepsPerBar ?? 16;
      const drumProjector = musicalTimeIndex !== null
        && Number.isFinite(clip.startBeat)
        && (clip.drumEvents?.length ?? 0) > 0
        ? compileDrumStepProjector(stepsPerBar, clip.startBeat, musicalTimeIndex)
        : null;
      clip.drumEvents?.forEach((drum, di) => {
        if (atErrorLimit()) return;
        const drumPath = `${clipPath}.drumEvents[${di}]`;
        markId(drum.id, `${drumPath}.id`);
        if (!inRange(drum.velocity, 1, 127) || !Number.isInteger(drum.velocity)) {
          push(`${drumPath}.velocity`, `velocity must be an integer 1..127 (got ${drum.velocity})`);
        }
        const validStepIndex = Number.isInteger(drum.stepIndex) && drum.stepIndex >= 0;
        if (!validStepIndex) {
          push(`${drumPath}.stepIndex`, `stepIndex must be a non-negative integer (got ${drum.stepIndex})`);
        }
        if (drum.probability !== undefined && !inRange(drum.probability, 0, 1)) {
          push(`${drumPath}.probability`, 'probability must be between 0 and 1');
        }
        const drumBeat = drumProjector !== null
          && validStepIndex
          ? projectDrumStep(drumProjector, drum.stepIndex).beat - clip.startBeat
          : drum.stepIndex * (beatsPerBar(project.timeSignature) / stepsPerBar);
        if (validStepIndex && (!Number.isFinite(drumBeat) || drumBeat >= clip.lengthBeats)) {
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
