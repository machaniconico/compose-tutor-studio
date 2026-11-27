import { projectToMidiResult } from '@cts/midi-io';
import {
  canReachAnyScheduleWindow,
  findClip,
  isDrumPayload,
  isSelfContainedDrumPayload,
  type Project,
  type SplitClipResult,
} from '@cts/project-model';
import { buildScheduleEvents } from './events';

/** Exact multiset of scheduled sounds, including the inputs to every drum pass. */
export function splitScheduleSignature(project: Project): string[] {
  return buildScheduleEvents(project).flatMap((event) => {
    const { beat, payload } = event;
    if (isDrumPayload(payload) && isSelfContainedDrumPayload(payload)) {
      if (payload.probability === 0 || !canReachAnyScheduleWindow(event)) return [];
      // Clip end only gates audibility. All random, timing and voice inputs
      // stay in the key because a matching first pass proves nothing about later passes.
      const { clipEndBeat: _clipEndBeat, ...sounding } = payload;
      return [JSON.stringify([beat, sounding])];
    }
    return [JSON.stringify([beat, payload])];
  }).sort();
}

type SplitClipIds = Pick<Extract<SplitClipResult, { ok: true }>, 'clipId' | 'rightClipId'>;

function hasAudioSplitParity(before: Project, after: Project, { clipId, rightClipId }: SplitClipIds): boolean {
  const original = findClip(before, clipId)?.clip;
  if (original?.type !== 'audio') return true;
  const left = findClip(after, clipId)?.clip;
  const right = findClip(after, rightClipId)?.clip;
  const asset = before.audioAssets.find((entry) => entry.id === original.audioAssetId);
  if (left?.type !== 'audio' || right?.type !== 'audio' || asset?.availability !== 'ready') return false;

  const sourceStart = original.sourceStartFrame;
  const sourceCount = original.sourceFrameCount;
  const leftFrames = left.sourceFrameCount;
  const rightFrames = right.sourceFrameCount;
  if (sourceStart === undefined || leftFrames === undefined || rightFrames === undefined) return false;

  // The shared audio splitter rounds the seam once in source frames.
  // The two clips must then cover the original source range exactly.
  return Number.isSafeInteger(leftFrames) && leftFrames > 0
    && Number.isSafeInteger(rightFrames) && rightFrames > 0
    && leftFrames + rightFrames === sourceCount
    && left.sourceStartFrame === sourceStart
    && right.sourceStartFrame === left.sourceStartFrame + leftFrames
    && left.audioAssetId === asset.id && right.audioAssetId === asset.id
    && left.gainDb === original.gainDb && right.gainDb === original.gainDb
    && !left.loop && !right.loop && left.audioWarp === undefined && right.audioWarp === undefined
    && left.fadeInFrames === 0 && left.fadeOutFrames === 0
    && right.fadeInFrames === 0 && right.fadeOutFrames === 0;
}

export function checkSplitParity(before: Project, after: Project, split: SplitClipIds):
  'split-sound-changed' | 'split-midi-changed' | 'split-audio-range' | null {
  if (!hasAudioSplitParity(before, after, split)) return 'split-audio-range';
  try {
    const previous = splitScheduleSignature(before);
    const next = splitScheduleSignature(after);
    if (previous.length !== next.length || previous.some((event, index) => event !== next[index])) {
      return 'split-sound-changed';
    }
  } catch {
    return 'split-sound-changed';
  }
  const previous = projectToMidiResult(before);
  const next = projectToMidiResult(after);
  if (!previous.ok || !next.ok
    || previous.bytes.length !== next.bytes.length
    || previous.bytes.some((byte, index) => byte !== next.bytes[index])
  ) return 'split-midi-changed';
  return null;
}
