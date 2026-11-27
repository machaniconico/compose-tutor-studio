// P20 regression: a drum hit's random decisions (sounds?, velocity, voiceSeed) do not depend on
// the mode. Legacy (swing 0, choke off) and resolved mode (choke on and/or project swing) draw
// them from the same pre-swing (authored) occurrence beat; only the onset may differ.
import { createEmptyProject, type DrumLane, type Project } from '@cts/project-model';
import { describe, expect, it } from 'vitest';
import { buildScheduleEvents } from '../src/audio/events';
import { resolveDrumOccurrence } from '../src/audio/scheduler';

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANES: DrumLane[] = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'perc'];

function corpusProject(seed: number, swing: number, hiHatChoke: boolean): Project {
  const rnd = prng(seed);
  const project = Object.assign(
    createEmptyProject({ clock: () => new Date('2026-01-01T00:00:00.000Z') }),
    { swing, hiHatChoke },
  ) as Project;
  const clip = project.tracks.find((track) => track.type === 'drum')!.clips[0]!;
  clip.startBeat = [0, 0.25, 2.5, 4][Math.floor(rnd() * 4)]!;
  clip.lengthBeats = 16; // every step below sits well inside the clip: no timing drop
  clip.drumEvents = Array.from({ length: 8 + Math.floor(rnd() * 32) }, (_, i) => ({
    id: `d${i}`,
    lane: LANES[Math.floor(rnd() * LANES.length)]!,
    stepIndex: Math.floor(rnd() * 48),
    velocity: 1 + Math.floor(rnd() * 127),
    ...(rnd() < 0.4 ? { probability: rnd() } : {}),
  }));
  clip.drumGroove = {
    swing: [0, 0.3, 0.6, 1][Math.floor(rnd() * 4)]!,
    probability: rnd() < 0.5 ? 1 : rnd(),
    humanizeVelocity: Math.floor(rnd() * 30),
    seed: 1 + Math.floor(rnd() * 1000),
  };
  return project;
}

type Decision = { sounds: boolean; velocity?: number; voiceSeed?: number; lane: string; tick: number };

function decisions(project: Project): Map<string, Decision> {
  const out = new Map<string, Decision>();
  for (const event of buildScheduleEvents(project)) {
    const payload = event.payload as { kind: string; eventId: string; lane: string };
    if (payload.kind !== 'drum') continue;
    const resolved = resolveDrumOccurrence(event, event.beat);
    const voice = resolved?.payload as { velocity: number; voiceSeed: number } | undefined;
    out.set(payload.eventId, {
      sounds: resolved !== null,
      velocity: voice?.velocity,
      voiceSeed: voice?.voiceSeed,
      lane: payload.lane,
      tick: Math.round(event.beat * 480),
    });
  }
  return out;
}

describe('P20 drum randomness is stable across modes', () => {
  it('resolvedAndLegacy_drawIdenticalProbabilityVelocityAndVoiceSeed_perOccurrence', () => {
    let compared = 0;
    let swungClips = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      // One project (same track / clip ids, which also salt the draws), switched between modes.
      const base = corpusProject(seed, 0, false);
      const withMode = (swing: number, hiHatChoke: boolean) =>
        Object.assign(structuredClone(base), { swing, hiHatChoke }) as Project;
      const legacy = decisions(base);
      if ((base.tracks.find((t) => t.type === 'drum')!.clips[0]!.drumGroove?.swing ?? 0) > 0) {
        swungClips += 1;
      }
      for (const [swing, choke] of [[0, true], [30, false], [60, true]] as const) {
        const resolved = decisions(withMode(swing, choke));
        for (const [eventId, decision] of resolved) {
          const { sounds, velocity, voiceSeed } = legacy.get(eventId)!;
          expect({ seed, swing, choke, eventId, sounds, velocity, voiceSeed }).toEqual({
            seed, swing, choke, eventId,
            sounds: decision.sounds, velocity: decision.velocity, voiceSeed: decision.voiceSeed,
          });
          compared += 1;
        }
        // Only same-lane same-tick de-duplication may remove an occurrence in resolved mode.
        for (const eventId of legacy.keys()) {
          if (resolved.has(eventId)) continue;
          const removed = base.tracks
            .find((t) => t.type === 'drum')!.clips[0]!.drumEvents!.find((d) => d.id === eventId)!;
          expect([...resolved.values()].some((kept) => kept.lane === removed.lane)).toBe(true);
        }
      }
    }
    expect(swungClips).toBeGreaterThan(50);
    expect(compared).toBeGreaterThan(5000);
  });
});
