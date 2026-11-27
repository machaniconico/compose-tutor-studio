import type { Clock } from './clock';
import { nowIso, systemClock } from './clock';
import { makeId } from './ids';
import { splitAudioClip } from './audio-clips';
import { PPQ, wholeBeatTick } from './ticks';
import {
  compileDrumStepProjector,
  compileMusicalTime,
  projectDrumStep,
  projectLengthBeats,
} from './time';
import type { Clip, DrumEvent, NoteEvent, Project } from './types';
import { MAX_CLIPS_PER_TRACK, MIN_EVENT_DURATION_BEATS } from './limits';
import {
  MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
  preflightScheduleEventBudget,
} from './schedule-budget';
import { validateProject } from './validation';
import {
  buildClipIndex,
  findClip,
  resolveClipContent,
  resolveClipSource,
} from './clip-resolution';
export {
  buildClipIndex,
  clipContentOwnerId,
  findClip,
  resolveClipContent,
  resolveClipSource,
  type ClipIndex,
  type LocatedClip,
} from './clip-resolution';

function cloneNotes(notes: readonly NoteEvent[] | undefined): NoteEvent[] | undefined {
  return notes?.map((note) => ({ ...note, id: makeId('note') }));
}

function cloneDrumEvents(
  events: readonly DrumEvent[] | undefined,
): DrumEvent[] | undefined {
  return events?.map((event) => ({ ...event, id: makeId('drum') }));
}

/** Create an independent persisted clip from an effective read projection. */
function independentClone(effective: Clip, id: string, startBeat: number): Clip {
  const clone: Clip = {
    id,
    trackId: effective.trackId,
    type: effective.type,
    startBeat,
    lengthBeats: effective.lengthBeats,
    loop: effective.loop,
    ...(effective.notes !== undefined ? { notes: cloneNotes(effective.notes) } : {}),
    ...(effective.drumEvents !== undefined
      ? { drumEvents: cloneDrumEvents(effective.drumEvents) }
      : {}),
    ...(effective.stepsPerBar !== undefined
      ? { stepsPerBar: effective.stepsPerBar }
      : {}),
    ...(effective.drumGroove !== undefined
      ? { drumGroove: { ...effective.drumGroove } }
      : {}),
    ...(effective.audioAssetId !== undefined
      ? { audioAssetId: effective.audioAssetId }
      : {}),
    ...(effective.sourceStartFrame !== undefined
      ? { sourceStartFrame: effective.sourceStartFrame }
      : {}),
    ...(effective.sourceFrameCount !== undefined
      ? { sourceFrameCount: effective.sourceFrameCount }
      : {}),
    ...(effective.fadeInFrames !== undefined
      ? { fadeInFrames: effective.fadeInFrames }
      : {}),
    ...(effective.fadeOutFrames !== undefined
      ? { fadeOutFrames: effective.fadeOutFrames }
      : {}),
    ...(effective.gainDb !== undefined ? { gainDb: effective.gainDb } : {}),
  };
  return clone;
}

export type DuplicateClipOptions = Readonly<{
  startBeat: number;
  linked: boolean;
  /** Optional deterministic id for selection handoff and tests. */
  id?: string;
}>;

export type ClipMutationFailure =
  | 'clip-not-found'
  | 'invalid-alias'
  | 'invalid-destination'
  | 'duplicate-id'
  | 'clip-limit'
  | 'event-limit'
  | 'unsupported-linked-type';

function projectHasEntityId(project: Project, id: string): boolean {
  return project.id === id
    || project.tempoMap.some((event) => event.id === id)
    || project.timeSignatureMap.some((event) => event.id === id)
    || project.audioAssets.some((asset) => asset.id === id)
    || project.automationLanes.some(
      (lane) => lane.id === id || lane.points.some((point) => point.id === id),
    )
    || project.tracks.some(
      (track) => track.id === id
        || track.effects.some((effect) => effect.id === id)
        || track.clips.some(
          (clip) => clip.id === id
            || clip.notes?.some((note) => note.id === id) === true
            || clip.drumEvents?.some((event) => event.id === id) === true,
        ),
    )
    || project.chordTrack.some((chord) => chord.id === id)
    || project.sections.some((section) => section.id === id)
    || project.audioRouting.sends.some((send) => send.id === id);
}

export type DuplicateClipResult =
  | Readonly<{ ok: true; project: Project; clipId: string }>
  | Readonly<{ ok: false; reason: ClipMutationFailure }>;

/**
 * Duplicate one clip at an explicit timeline position.
 *
 * Independent copies receive fresh nested event ids. Linked copies contain no
 * payload and point directly to the canonical source, so editing either
 * instance can safely mutate one owner.
 */
export function duplicateClip(
  project: Project,
  clipId: string,
  options: DuplicateClipOptions,
  clock: Clock = systemClock,
): DuplicateClipResult {
  const located = findClip(project, clipId);
  if (!located) return { ok: false, reason: 'clip-not-found' };
  const index = buildClipIndex(project);
  const source = resolveClipSource(project, located.clip, index);
  const effective = resolveClipContent(project, located.clip, index);
  if (!source || !effective) return { ok: false, reason: 'invalid-alias' };
  if (located.track.clips.length >= MAX_CLIPS_PER_TRACK) {
    return { ok: false, reason: 'clip-limit' };
  }
  if (options.linked && source.type !== 'midi' && source.type !== 'drum') {
    return { ok: false, reason: 'unsupported-linked-type' };
  }

  const endBeat = options.startBeat + effective.lengthBeats;
  if (
    !Number.isFinite(options.startBeat) ||
    options.startBeat < 0 ||
    !Number.isFinite(endBeat) ||
    endBeat > projectLengthBeats(project)
  ) {
    return { ok: false, reason: 'invalid-destination' };
  }

  const newId = options.id ?? makeId('clip');
  if (projectHasEntityId(project, newId)) return { ok: false, reason: 'duplicate-id' };

  const duplicate: Clip = options.linked
    ? {
        id: newId,
        trackId: located.track.id,
        type: located.clip.type,
        startBeat: options.startBeat,
        lengthBeats: located.clip.lengthBeats,
        loop: located.clip.loop,
        aliasOf: source.id,
      }
    : independentClone(effective, newId, options.startBeat);

  const tracks = project.tracks.map((track) =>
    track.id === located.track.id
      ? { ...track, clips: [...track.clips, duplicate] }
      : track,
  );
  const candidate = { ...project, tracks, updatedAt: nowIso(clock) };
  const budget = preflightScheduleEventBudget(candidate, {
    limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
    projection: 'resolved-stored',
  });
  if (!budget.ok) return { ok: false, reason: 'event-limit' };
  return {
    ok: true,
    clipId: newId,
    project: candidate,
  };
}

export type UnlinkClipResult =
  | Readonly<{ ok: true; project: Project; clipId: string }>
  | Readonly<{ ok: false; reason: 'clip-not-found' | 'not-linked' | 'invalid-alias' }>;

/** Materialize a linked clip as an independent copy without moving it. */
export function unlinkClip(
  project: Project,
  clipId: string,
  clock: Clock = systemClock,
): UnlinkClipResult {
  const located = findClip(project, clipId);
  if (!located) return { ok: false, reason: 'clip-not-found' };
  if (located.clip.aliasOf === undefined) return { ok: false, reason: 'not-linked' };
  const effective = resolveClipContent(project, located.clip);
  if (!effective) return { ok: false, reason: 'invalid-alias' };

  const independent = independentClone(effective, located.clip.id, located.clip.startBeat);
  const tracks = project.tracks.map((track) =>
    track.id === located.track.id
      ? {
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === located.clip.id ? independent : clip,
          ),
        }
      : track,
  );
  return {
    ok: true,
    clipId: located.clip.id,
    project: { ...project, tracks, updatedAt: nowIso(clock) },
  };
}

export type ResizeClipOptions = Readonly<{
  startBeat?: number;
  lengthBeats?: number;
}>;

export type ResizeClipResult =
  | Readonly<{ ok: true; project: Project; clipId: string }>
  | Readonly<{
      ok: false;
      reason:
        | 'clip-not-found'
        | 'invalid-alias'
        | 'invalid-range'
        | 'linked-length-locked'
        | 'linked-dependents'
        | 'content-out-of-range'
        | 'unsupported-audio-clip';
    }>;

export type SetMidiClipLoopResult =
  | Readonly<{ ok: true; project: Project; clipId: string }>
  | Readonly<{
      ok: false;
      reason: 'clip-not-found' | 'invalid-alias' | 'unsupported-clip-type';
    }>;

/** Set loop projection on one MIDI timeline instance, never on its payload owner. */
export function setMidiClipLoop(
  project: Project,
  clipId: string,
  loop: boolean,
  clock: Clock = systemClock,
): SetMidiClipLoopResult {
  const located = findClip(project, clipId);
  if (!located) return { ok: false, reason: 'clip-not-found' };
  if (located.clip.type !== 'midi') {
    return { ok: false, reason: 'unsupported-clip-type' };
  }
  if (!resolveClipSource(project, located.clip)) {
    return { ok: false, reason: 'invalid-alias' };
  }
  if (located.clip.loop === loop) return { ok: true, project, clipId };

  const tracks = project.tracks.map((track) =>
    track.id === located.track.id
      ? {
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, loop } : clip,
          ),
        }
      : track,
  );
  return {
    ok: true,
    clipId,
    project: { ...project, tracks, updatedAt: nowIso(clock) },
  };
}

/** Move a clip instance and resize only an unlinked payload owner. */
export function resizeClip(
  project: Project,
  clipId: string,
  options: ResizeClipOptions,
  clock: Clock = systemClock,
): ResizeClipResult {
  const located = findClip(project, clipId);
  if (!located) return { ok: false, reason: 'clip-not-found' };
  if (located.clip.type === 'audio') {
    return { ok: false, reason: 'unsupported-audio-clip' };
  }
  const effective = resolveClipContent(project, located.clip);
  if (!effective) return { ok: false, reason: 'invalid-alias' };

  const startBeat = options.startBeat ?? located.clip.startBeat;
  const lengthBeats = options.lengthBeats ?? located.clip.lengthBeats;
  const changesLength = lengthBeats !== located.clip.lengthBeats;
  if (located.clip.aliasOf !== undefined && changesLength) {
    return { ok: false, reason: 'linked-length-locked' };
  }
  if (
    located.clip.aliasOf === undefined
    && changesLength
    && project.tracks.some((track) =>
      track.clips.some((clip) => clip.aliasOf === located.clip.id),
    )
  ) {
    return { ok: false, reason: 'linked-dependents' };
  }
  const endBeat = startBeat + lengthBeats;
  if (
    !Number.isFinite(startBeat)
    || startBeat < 0
    || !Number.isFinite(lengthBeats)
    || lengthBeats < MIN_EVENT_DURATION_BEATS
    || !Number.isFinite(endBeat)
    || endBeat > projectLengthBeats(project)
  ) {
    return { ok: false, reason: 'invalid-range' };
  }
  if (
    effective.notes?.some(
      (note) => note.startBeat + note.durationBeats > lengthBeats,
    )
  ) {
    return { ok: false, reason: 'content-out-of-range' };
  }
  const stepsPerBar = effective.stepsPerBar ?? 16;
  if ((effective.drumEvents?.length ?? 0) > 0) {
    const musicalTime = compileMusicalTime(project);
    const drumProjector = compileDrumStepProjector(
      stepsPerBar,
      startBeat,
      musicalTime,
    );
    if (
      effective.drumEvents?.some(
        (event) => projectDrumStep(drumProjector, event.stepIndex).beat - startBeat >= lengthBeats,
      )
    ) {
      return { ok: false, reason: 'content-out-of-range' };
    }
  }

  if (!changesLength && startBeat === located.clip.startBeat) {
    return { ok: true, project, clipId };
  }
  const tracks = project.tracks.map((track) =>
    track.id === located.track.id
      ? {
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === clipId ? { ...clip, startBeat, lengthBeats } : clip,
          ),
        }
      : track,
  );
  return {
    ok: true,
    clipId,
    project: { ...project, tracks, updatedAt: nowIso(clock) },
  };
}

export const SPLIT_CLIP_MESSAGES = {
  'split-missing-clip': 'クリップが見つかりません。クリップを選び直してください。',
  'split-invalid-position': 'クリップの端を避け、内側の目盛りに分割位置を合わせてください。1拍は480目盛りです。',
  'split-off-grid-start': 'クリップの開始位置や開始から分割までの長さが目盛りに合っていません。1拍は480目盛りです。',
  'split-linked-clip': '素材を共有しているため分割できません。先にすべての連動コピーの連動を解除してください。',
  'split-looping-clip': '繰り返し中のクリップは分割できません。先に繰り返しをオフにしてください。',
  'split-crossing-note': '分割位置をまたぐ音が途中で鳴り直すため、分割できません。音の切れ目を選んでください。',
  'split-drum-grid': 'ドラムは打点を置ける目盛りで分割してください。',
  'split-audio-range': 'この位置では音声素材を分けられません。素材の内側で別の位置を選んでください。',
  'split-audio-edited': 'フェードや音声補正を保ったまま分割できません。別のクリップを選んでください。',
  'split-audio-unavailable': '音声素材を確認できません。素材の状態を確認してください。',
  'split-unsupported-type': 'この種類のクリップは分割できません。',
  'split-clip-limit': 'このトラックにはこれ以上クリップを追加できません。',
  'split-recording': '録音中は分割できません。録音を止めてから試してください。',
  'split-sound-changed': '分けると音の鳴り方が変わるため、分割できません。別の位置を選んでください。',
  'split-midi-changed': '分けるとMIDIの書き出し結果が変わるため、分割できません。別の位置を選んでください。',
  'split-project-unavailable': 'クリップを安全に分割できませんでした。編集中の操作を終えてから試してください。',
} as const;

export type SplitClipFailure = keyof typeof SPLIT_CLIP_MESSAGES;

export type SplitClipResult =
  | Readonly<{ ok: true; project: Project; trackId: string; clipId: string; rightClipId: string }>
  | Readonly<{ ok: false; project: Project; code: SplitClipFailure; reason: string }>;

/** Build a split candidate. Studio compares playback and export before adoption. */
export function splitClip(
  project: Project,
  clipId: string,
  atBeat: unknown,
  clock: Clock = systemClock,
): SplitClipResult {
  const fail = (code: SplitClipFailure): SplitClipResult =>
    ({ ok: false, project, code, reason: SPLIT_CLIP_MESSAGES[code] });
  try {
    if (typeof clipId !== 'string' || project === null || typeof project !== 'object'
      || !Object.hasOwn(project, 'tracks')) {
      return fail('split-missing-clip');
    }
    const found = findClip(project, clipId);
    if (!found) return fail('split-missing-clip');
    const { clip, track } = found;
    const splitTick = typeof atBeat === 'number' ? wholeBeatTick(atBeat) : null;
    if (splitTick === null) return fail('split-invalid-position');
    const startTick = Object.hasOwn(clip, 'startBeat') ? wholeBeatTick(clip.startBeat) : null;
    if (startTick === null) return fail('split-off-grid-start');
    const endBeat = clip.startBeat + clip.lengthBeats;
    const projectEnd = projectLengthBeats(project);
    const endTick = wholeBeatTick(endBeat);
    const projectEndTick = wholeBeatTick(projectEnd);
    const splitBeat = splitTick / PPQ;
    const leftLength = (splitTick - startTick) / PPQ;
    // Imported clips can have an off-grid end. Preserve that edge.
    const rightLength = endTick === null ? endBeat - splitBeat : (endTick - splitTick) / PPQ;
    if (
      splitTick <= startTick
      || (endTick === null
        ? !Number.isFinite(rightLength) || rightLength < MIN_EVENT_DURATION_BEATS
        : splitTick >= endTick)
      || (endTick !== null && projectEndTick !== null ? endTick > projectEndTick : endBeat > projectEnd)
    ) return fail('split-invalid-position');
    if (
      (Object.hasOwn(clip, 'aliasOf') && clip.aliasOf !== undefined)
      || project.tracks.some((owner) => owner.clips.some((candidate) =>
        Object.hasOwn(candidate, 'aliasOf') && candidate.aliasOf === clipId,
      ))
    ) return fail('split-linked-clip');
    if (clip.loop) return fail('split-looping-clip');
    if (track.clips.length >= MAX_CLIPS_PER_TRACK) return fail('split-clip-limit');

    if (clip.type === 'audio') {
      if (clip.audioWarp !== undefined || clip.fadeInFrames !== 0 || clip.fadeOutFrames !== 0) {
        return fail('split-audio-edited');
      }
      const asset = project.audioAssets.find((entry) => entry.id === clip.audioAssetId);
      if (asset?.availability !== 'ready') return fail('split-audio-unavailable');
      const result = splitAudioClip(project, clipId, { splitBeat }, clock);
      if (!result.ok) return fail('split-audio-range');
      return { ...result, clipId, trackId: track.id };
    }

    if (clip.type !== 'midi' && clip.type !== 'drum') return fail('split-unsupported-type');
    const rightClipId = makeId('clip');
    if (projectHasEntityId(project, rightClipId)) return fail('split-project-unavailable');
    const left: Clip = { ...clip, lengthBeats: leftLength };
    const right: Clip = { ...clip, id: rightClipId, startBeat: splitBeat, lengthBeats: rightLength };
    if (clip.notes) {
      left.notes = [];
      right.notes = [];
      for (const note of clip.notes) {
        if (note.startBeat >= leftLength) {
          right.notes.push({ ...note, startBeat: note.startBeat - leftLength });
        } else if (note.startBeat + note.durationBeats <= leftLength) {
          left.notes.push(note);
        } else {
          return fail('split-crossing-note');
        }
      }
    }
    if (clip.type === 'drum') {
      const projector = compileDrumStepProjector(clip.stepsPerBar ?? 16, clip.startBeat, compileMusicalTime(project));
      const beatOf = (step: number): number => projectDrumStep(projector, step).beat;
      const tickPositionOf = (step: number): number => {
        const beat = beatOf(step);
        return wholeBeatTick(beat) ?? beat * PPQ;
      };
      let low = 0;
      let high = projector.stepsPerBar;
      while (high < Number.MAX_SAFE_INTEGER / 2 && tickPositionOf(high) < splitTick) high *= 2;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (tickPositionOf(middle) < splitTick) low = middle + 1;
        else high = middle;
      }
      if (wholeBeatTick(beatOf(low)) !== splitTick) return fail('split-drum-grid');
      if (clip.drumEvents) {
        left.drumEvents = clip.drumEvents.filter((hit) => hit.stepIndex < low);
        right.drumEvents = clip.drumEvents
          .filter((hit) => hit.stepIndex >= low)
          .map((hit) => ({ ...hit, stepIndex: hit.stepIndex - low }));
      }
    }
    const tracks = project.tracks.map((owner) => owner === track
      ? { ...owner, clips: owner.clips.flatMap((candidate) => candidate === clip ? [left, right] : [candidate]) }
      : owner);
    const candidate = { ...project, tracks, updatedAt: nowIso(clock) };
    if (!validateProject(candidate).ok) return fail('split-project-unavailable');
    return { ok: true, project: candidate, trackId: track.id, clipId, rightClipId };
  } catch {
    return fail('split-project-unavailable');
  }
}
