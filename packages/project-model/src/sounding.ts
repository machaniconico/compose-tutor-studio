import { clipSpan, drumSourceStep, MIN_LOOP_PERIOD_BEATS, renderClip, resolveLinkSource } from './clipExpand';
import type { ClipOnset } from './clipExpand';
import { beatTick, beatsPerBar, PPQ } from './time';
import type { Clip, Project, Track } from './types';

export { PPQ } from './time';
export { MIN_LOOP_PERIOD_BEATS } from './clipExpand';

export const MAX_SONG_BARS = 64;
export const MAX_SOUNDING_EVENTS = 100_000;

export function maxSongBars({ legacyBarLimit }: Pick<Project, 'legacyBarLimit'>): number {
  // v1 permits up to 64 bars and its largest supported denominator is 16 (4×).
  return legacyBarLimit !== undefined && Number.isInteger(legacyBarLimit) &&
    legacyBarLimit > MAX_SONG_BARS && legacyBarLimit <= 4 * MAX_SONG_BARS
    ? legacyBarLimit
    : MAX_SONG_BARS;
}

export type SoundingEvent = ClipOnset & { trackId: string; clipId: string; sourceClipId: string };

export function songEndBeat(project: Pick<Project, 'lengthBars' | 'timeSignature'>): number {
  const bpb = beatsPerBar(project.timeSignature);
  return Math.max(0, project.lengthBars) * (bpb > 0 ? bpb : 4);
}

export function computeAudibleTracks(tracks: readonly Track[]): Set<string> {
  const unmuted = tracks.filter((track) => track.type !== 'master' && !track.mute);
  const soloed = unmuted.filter((track) => track.solo);
  return new Set((soloed.length > 0 ? soloed : unmuted).map((track) => track.id));
}

type SoundingOptions = { includeMuted?: boolean; clipId?: string; sourceClipId?: string };

export function soundingEvents(
  project: Project,
  options: SoundingOptions = {},
): { events: SoundingEvent[]; problems: string[] } {
  const clips = new Map(project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
  const audible = options.includeMuted ? undefined : computeAudibleTracks(project.tracks);
  const events: SoundingEvent[] = [];
  const problems: string[] = [];
  const end = songEndBeat(project);
  const bpb = beatsPerBar(project.timeSignature);

  for (const track of project.tracks) {
    // Names only label problems. Trimming scales with name length, so it runs
    // at most once per track, and only when the track reports a problem.
    let name: string | undefined;
    const label = () =>
      (name ??= track.type === 'master' ? 'マスター' : track.name.trim() || '名前のないトラック');
    for (const clip of track.clips) {
      if (options.clipId !== undefined && clip.id !== options.clipId) continue;
      const source = resolveLinkSource(clip, clips);
      if (typeof source === 'string') {
        problems.push(`「${label()}」: ${source}`);
        continue;
      }
      if (options.sourceClipId !== undefined && source.id !== options.sourceClipId) continue;
      const emit = audible && !audible.has(track.id) ? undefined : (event: ClipOnset) => {
        if (event.kind === 'note') {
          // A note lasts at least one tick; the three outputs only map this end.
          const startTick = beatTick(event.startBeat);
          if (beatTick(event.startBeat + event.durationBeats) <= startTick) {
            event.durationBeats = (startTick + 1) / PPQ - event.startBeat;
          }
        }
        events.push(Object.assign(event, { trackId: track.id, clipId: clip.id, sourceClipId: source.id }));
      };
      const result = renderClip(clip, source, bpb, track.type, end, project.swing, emit);
      for (const problem of result.problems) problems.push(`「${label()}」: ${problem}`);
    }
  }
  return { events, problems };
}

/** Map an audible onset back to its saved event. Simultaneous events use stored order. */
export function storedEventAt(
  project: Project,
  clipId: string,
  localBeat: number,
): { sourceClipId: string; sourceIndex: number } | null {
  const clip = project.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === clipId);
  if (!clip || localBeat < 0) return null;
  const tick = beatTick(clip.startBeat + localBeat);
  if (tick >= beatTick(clipSpan(clip, songEndBeat(project)).end)) return null;
  const { events } = soundingEvents(project, { clipId });
  const event = events.find((candidate) => beatTick(candidate.startBeat) === tick);
  return event ? { sourceClipId: event.sourceClipId, sourceIndex: event.sourceIndex } : null;
}

/** Editable clip length and the length of its first pass, in clip-local beats. */
export function clipEditSpan(project: Project, clip: Clip) {
  const { end, firstEnd } = clipSpan(clip, songEndBeat(project));
  return {
    length: Math.max(0, end - clip.startBeat),
    firstPassLength: Math.max(0, firstEnd - clip.startBeat),
  };
}

export function editableDrumStepAt(project: Project, clip: Clip, localBeat: number, stepBeats: number): number | null {
  return drumSourceStep(clip, localBeat, stepBeats, songEndBeat(project), project.swing ?? 0);
}

/** An upper bound before swing and mixer state, so either can change safely. */
export function findProjectSoundingLimitProblem(project: Project): string | undefined {
  const end = songEndBeat(project);
  const bpb = beatsPerBar(project.timeSignature);
  const clips = new Map(project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
  let count = 0;
  // A populated track shares its input unit with its first clip. Moving
  // overlapping clips onto new tracks then leaves the budget unchanged.
  let inputs = 0;
  const inputProblem = '曲に入っているトラック、クリップや音が多すぎます。数を減らしてください。';
  for (const track of project.tracks) {
    inputs += Math.max(1, track.clips.length);
    if (inputs > MAX_SOUNDING_EVENTS) return inputProblem;
    for (const clip of track.clips) {
      const source = resolveLinkSource(clip, clips);
      const period = clip.contentLengthBeats ?? clip.lengthBeats;
      if (clip.loop && (!Number.isFinite(period) || period < MIN_LOOP_PERIOD_BEATS)) {
        return `ループの繰り返し間隔は ${MIN_LOOP_PERIOD_BEATS} 拍以上にしてください。`;
      }
      if (typeof source === 'string') continue;
      inputs += (source.notes?.length ?? 0) + (source.drumEvents?.length ?? 0);
      if (inputs > MAX_SOUNDING_EVENTS) return inputProblem;
      count += renderClip(clip, source, bpb, track.type, end).count;
      if (count > MAX_SOUNDING_EVENTS) {
        return `曲で鳴る音が上限の ${MAX_SOUNDING_EVENTS} 個を超えます。クリップを短くするか、音の数を減らしてください。`;
      }
    }
  }
  return undefined;
}

/** Map a grid position to the first pass for note placement. */
export function firstPassBeatAt(clip: Clip, localBeat: number): number {
  const { period } = clipSpan(clip);
  if (!Number.isFinite(period) || period <= 0) return localBeat;
  const local = localBeat % period;
  return beatTick(local) === beatTick(period) ? 0 : local;
}
