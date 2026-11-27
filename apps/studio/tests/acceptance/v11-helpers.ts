// P20 acceptance helpers (shared by the v11-*.test.ts files). Implementers must not edit.
import {
  createDrumClip,
  createEmptyProject,
  createTrack,
  type DrumEvent,
  type DrumLane,
  type NoteEvent,
  type Project,
  type Track,
} from '@cts/project-model';

export const clock = () => new Date('2026-01-01T00:00:00.000Z');

/** An empty v11 project (Chords/Bass/Melody/Drums/Master, 32 beats, 120 bpm) with explicit swing / choke. */
export function projectWith(swing: number, hiHatChoke: boolean): Project {
  return Object.assign(createEmptyProject({ clock }), { swing, hiHatChoke }) as Project;
}

export function trackNamed(project: Project, name: string): Track {
  const track = project.tracks.find((t) => t.name === name);
  if (!track) throw new Error(`no track ${name}`);
  return track;
}

/** Replace the Melody clip with one at [startBeat, startBeat + lengthBeats) holding `notes`. */
export function setMelodyClip(
  project: Project,
  startBeat: number,
  lengthBeats: number,
  notes: Array<Pick<NoteEvent, 'pitch' | 'startBeat' | 'durationBeats'> & { velocity?: number }>,
): void {
  const melody = trackNamed(project, 'Melody');
  const clip = melody.clips[0]!;
  clip.startBeat = startBeat;
  clip.lengthBeats = lengthBeats;
  clip.notes = notes.map((n, i) => ({ id: `n${i}`, velocity: 100, ...n }));
}

export type DrumSpec = { lane: DrumLane; stepIndex: number };

/** Replace the Drums clip (16 steps per bar) with one holding `hits`; optional clip swing (0..1). */
export function setDrumClip(
  project: Project,
  hits: DrumSpec[],
  options: { startBeat?: number; lengthBeats?: number; clipSwing?: number } = {},
): void {
  const drums = trackNamed(project, 'Drums');
  const clip = drums.clips[0]!;
  clip.startBeat = options.startBeat ?? 0;
  clip.lengthBeats = options.lengthBeats ?? 32;
  clip.drumEvents = hits.map((h, i): DrumEvent => ({ id: `d${i}`, velocity: 100, ...h }));
  if (options.clipSwing !== undefined) {
    clip.drumGroove = { swing: options.clipSwing, probability: 1, humanizeVelocity: 0, seed: 1 };
  }
}

/** Append another drum track with one clip holding `hits` (all probability 1). */
export function addDrumTrack(project: Project, name: string, hits: DrumSpec[], clipStart = 0): Track {
  const track = createTrack(name, 'drum', { type: 'drumkit', preset: 'acoustic' });
  const clip = createDrumClip(track.id, clipStart, 32 - clipStart);
  clip.drumEvents = hits.map((h, i): DrumEvent => ({ id: `${name}-d${i}`, velocity: 100, ...h }));
  track.clips.push(clip);
  const master = project.tracks.findIndex((t) => t.type === 'master');
  project.tracks.splice(master < 0 ? project.tracks.length : master, 0, track);
  return track;
}

type Payload = Record<string, unknown> & { kind: string; trackId: string };

export function payloadsOf(events: ReadonlyArray<{ beat: number; payload: unknown }>) {
  return events.map((e) => ({ beat: e.beat, p: e.payload as Payload }));
}

/** pitch -> beat for note events of one track (pitches must be unique per test). */
export function noteBeats(
  events: ReadonlyArray<{ beat: number; payload: unknown }>,
  trackId: string,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const { beat, p } of payloadsOf(events)) {
    if (p.kind === 'note' && p.trackId === trackId) out.set(p.pitch as number, beat);
  }
  return out;
}
