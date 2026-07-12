import type { Track } from '@cts/project-model';

export const MIX_RAMP_SECONDS = 0.01;

export type MixUpdateMode = 'immediate' | 'smoothed';

export type MasterMix = Readonly<{
  trackId: string | null;
  gain: number;
}>;

export type ResolvedTrackMix = Readonly<{
  gain: number;
  pan: number;
}>;

/** Clamp a linear gain into the project-model range, failing silent on corruption. */
export function clampVolume(volume: unknown): number {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return 0;
  return Math.min(2, Math.max(0, volume));
}

/** Clamp a stereo pan into the project-model range, centring corrupt values. */
export function clampPan(pan: unknown): number {
  if (typeof pan !== 'number' || !Number.isFinite(pan)) return 0;
  return Math.min(1, Math.max(-1, pan));
}

/**
 * Resolve the one supported master control. Master mute/solo/pan remain
 * reserved and intentionally do not change legacy projects' sound.
 */
export function resolveMasterMix(tracks: readonly Track[]): MasterMix {
  const master = tracks.find((track) => track.type === 'master');
  return master
    ? { trackId: master.id, gain: clampVolume(master.volume) }
    : { trackId: null, gain: 1 };
}

export function resolveTrackMix(track: Track, audible: boolean): ResolvedTrackMix {
  return {
    gain: audible ? clampVolume(track.volume) : 0,
    pan: clampPan(track.pan),
  };
}

/**
 * Apply a mix value immediately during graph construction/offline rendering,
 * or with a short ramp for an already-audible live graph.
 */
export function applyAudioParam(
  param: AudioParam,
  value: number,
  when: number,
  mode: MixUpdateMode,
): void {
  const safeWhen = Number.isFinite(when) && when >= 0 ? when : 0;
  const candidate = param as AudioParam & {
    cancelAndHoldAtTime?: (cancelTime: number) => AudioParam;
    cancelScheduledValues?: (cancelTime: number) => AudioParam;
    setTargetAtTime?: (target: number, startTime: number, timeConstant: number) => AudioParam;
    setValueAtTime?: (value: number, startTime: number) => AudioParam;
  };

  if (mode === 'smoothed' && typeof candidate.setTargetAtTime === 'function') {
    try {
      if (typeof candidate.cancelAndHoldAtTime === 'function') {
        candidate.cancelAndHoldAtTime(safeWhen);
      } else {
        candidate.cancelScheduledValues?.(safeWhen);
      }
    } catch {
      // Some WebViews reject cancellation at a stale clock edge. A new target
      // is still safer than dropping the user's mixer update.
    }
    candidate.setTargetAtTime(value, safeWhen, MIX_RAMP_SECONDS);
    return;
  }

  try {
    candidate.cancelScheduledValues?.(safeWhen);
  } catch {
    // The immediate assignment below remains authoritative for new graphs.
  }
  if (typeof candidate.setValueAtTime === 'function') {
    candidate.setValueAtTime(value, safeWhen);
  } else {
    param.value = value;
  }
}

export function applyMasterMix(
  master: GainNode,
  tracks: readonly Track[],
  when: number,
  mode: MixUpdateMode,
): MasterMix {
  const mix = resolveMasterMix(tracks);
  applyAudioParam(master.gain, mix.gain, when, mode);
  return mix;
}
