// Map sounding events onto the shared Web Audio schedule.
import type { DrumLane, Project, SoundingEvent } from '@cts/project-model';
import { beatTick, DEFAULT_STEPS_PER_BAR, soundingEvents } from '@cts/project-model';
import { isValidLoop, loopPlacement, type LoopRegion, type ScheduledEvent } from './scheduler';

export { DEFAULT_STEPS_PER_BAR };

/** A note to be played on an instrument track. */
export type NoteScheduleEvent = {
  kind: 'note';
  trackId: string;
  preset: string;
  pitch: number;
  durationBeats: number;
  velocity: number;
  /** Set when the clip end cut the note short (the synth then releases at its end). */
  cut?: true;
};

/** A drum hit to be played on a drum track. */
export type DrumScheduleEvent = {
  kind: 'drum';
  trackId: string;
  lane: DrumLane;
  velocity: number;
  /** Set on an open hat that a later closed hat on its track chokes (soundingEvents): it stops this many beats in. */
  durationBeats?: number;
};

/** Discriminated payload carried by a ScheduledEvent. */
export type SchedulePayload = NoteScheduleEvent | DrumScheduleEvent;

/**
 * Convert a drum step index to an absolute beat.
 *
 * A drum clip divides each bar into `stepsPerBar` equal steps. Step `i` sits at
 * `i * (beatsPerBar / stepsPerBar)` beats from the clip start; the clip start is
 * `clipStartBeat` on the project timeline. Pure + unit tested.
 */
export function drumStepToBeat(
  stepIndex: number,
  stepsPerBar: number,
  beatsPerBar: number,
  clipStartBeat: number,
): number {
  const steps = stepsPerBar > 0 ? stepsPerBar : DEFAULT_STEPS_PER_BAR;
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const beatsPerStep = bpb / steps;
  return clipStartBeat + stepIndex * beatsPerStep;
}

/**
 * Re-apply the hi-hat choke on the timeline of loop playback. Two rules:
 * - Whether a hit plays in a pass: the scheduler's own `loopPlacement`, in
 *   unrounded beats. Closed hats that are never scheduled choke nothing.
 * - Which closed hat chokes: as on the song timeline (`applyHiHatChoke`), only a
 *   closed hat whose sounding tick is later than the open hat's; the same tick
 *   does not. A closed hat of a later pass counts one loop's ticks per pass.
 * The open hat stops at the first such closed hat, at the playhead beat the
 * scheduler plays it (same pass: its beat; next pass: its beat plus the loop
 * length). Song-timeline chokes of soundingEvents are replaced.
 */
function chokeForLoop(events: SoundingEvent[], loop: LoopRegion): SoundingEvent[] {
  if (!isValidLoop(loop)) return events;
  const length = loop.endBeat - loop.startBeat;
  const loopTicks = beatTick(length);
  type Closed = { beat: number; tick: number };
  const playedByTrack = new Map<string, Closed[]>();
  const regionByTrack = new Map<string, Closed[]>();
  for (const event of events) {
    if (event.kind !== 'drum' || event.lane !== 'closedHat') continue;
    const placement = loopPlacement(event.startBeat, loop);
    if (placement === 'never') continue;
    const closed = { beat: event.startBeat, tick: beatTick(event.startBeat) };
    playedByTrack.set(event.trackId, [...(playedByTrack.get(event.trackId) ?? []), closed]);
    if (placement === 'everyPass') regionByTrack.set(event.trackId, [...(regionByTrack.get(event.trackId) ?? []), closed]);
  }
  for (const list of [...playedByTrack.values(), ...regionByTrack.values()]) list.sort((a, b) => a.beat - b.beat);
  /** Index of the first closed hat whose tick (plus `extraTicks`) is after `tick`; ticks rise with beats. */
  const firstAfter = (list: readonly Closed[], tick: number, extraTicks: number) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.tick + extraTicks > tick) hi = mid;
      else lo = mid + 1;
    }
    return list[lo];
  };
  return events.map((event) => {
    if (event.kind !== 'drum' || event.lane !== 'openHat' || loopPlacement(event.startBeat, loop) === 'never') return event;
    const tick = beatTick(event.startBeat);
    // A closed hat later by tick is also later by beat, so it plays after the open hat in this pass.
    const sameRun = firstAfter(playedByTrack.get(event.trackId) ?? [], tick, 0);
    let chokeBeat = sameRun?.beat;
    const region = regionByTrack.get(event.trackId) ?? [];
    for (let pass = 1; chokeBeat === undefined && region.length > 0 && pass <= 2; pass++) {
      const next = firstAfter(region, tick, pass * loopTicks);
      if (next) chokeBeat = next.beat + pass * length;
    }
    const { durationBeats: _songChoke, ...rest } = event;
    return chokeBeat === undefined ? rest : { ...rest, durationBeats: chokeBeat - event.startBeat };
  });
}

/**
 * With `loop` (live loop playback), open hats are choked on the loop's timeline
 * (see {@link chokeForLoop}); WAV and MIDI never loop and pass none.
 *
 * With `identities`, each payload is mapped to what it sounds like: track,
 * start tick, pitch (or drum lane) and velocity. Live edits match voices on
 * this, so a note keeps its voice whatever clip or saved event it comes from.
 */
export function buildScheduleEvents(
  project: Project,
  identities?: WeakMap<object, string>,
  loop?: LoopRegion | null,
  window?: LoopRegion,
): ScheduledEvent[] {
  const presets = new Map(project.tracks.map((track) => [track.id, track.instrument?.preset ?? 'warmPad']));
  const sounding = soundingEvents(project, { window }).events;
  return (loop ? chokeForLoop(sounding, loop) : sounding).map((event): ScheduledEvent => {
    const { trackId, startBeat: beat, velocity } = event;
    const payload: SchedulePayload = event.kind === 'note'
      ? {
          kind: 'note', trackId, velocity, preset: presets.get(trackId) ?? 'warmPad',
          pitch: event.pitch, durationBeats: event.durationBeats, ...(event.cut ? { cut: event.cut } : {}),
        }
      : {
          kind: 'drum', trackId, velocity, lane: event.lane,
          ...(event.durationBeats !== undefined ? { durationBeats: event.durationBeats } : {}),
        };
    // A choked hit is a different sound: a live edit that moves its choke re-schedules it.
    const what = event.kind === 'note'
      ? `n${event.pitch}`
      : event.durationBeats === undefined ? event.lane : `${event.lane}~${beatTick(beat + event.durationBeats)}`;
    identities?.set(payload, [trackId, beatTick(beat), what, velocity].join('|'));
    return { beat, payload };
  });
}
