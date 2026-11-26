// Live (events.ts), WAV (renderScheduleEvents) and MIDI (projectToMidi message list) must carry the
// same multiset of onsets and note ends, tick for tick. MIDI is compared as a decoded message list
// (a test-local SMF reader), not through parseMidi.
import { describe, expect, it } from 'vitest';
import { projectToMidi, PPQ as MIDI_PPQ } from '@cts/midi-io';
import { PPQ, songEndBeat, soundingEvents } from '../../../../packages/project-model/src/sounding';
import { SEEDS, fromMidiBytes, fromScheduled, fromSounding, generateProject, makeProject, makeTrack, midiClip, drumClip, tickOf } from '../../../../packages/project-model/tests/acceptance/helpers';
import { buildScheduleEvents } from '../../src/audio/events';
import { renderScheduleEvents, songSoundEndBeat } from '../../src/audio/wav';
import type { Project } from '@cts/project-model';

function paths(project: Project) {
  return {
    model: fromSounding(soundingEvents(project).events),
    live: fromScheduled(buildScheduleEvents(project)),
    wav: fromScheduled(renderScheduleEvents(project)),
    midi: fromMidiBytes(projectToMidi(project), project),
  };
}

describe('sounding.parity', () => {
  it('sounding.parity: live・WAV・MIDI のイベント多重集合が tick 単位で一致する', () => {
    expect(MIDI_PPQ).toBe(PPQ);
    let total = 0;
    for (const seed of SEEDS) {
      const project = generateProject(seed);
      const { model, live, wav, midi } = paths(project);
      total += model.ons.length;
      expect(live, `live seed ${seed}`).toEqual(model);
      expect(wav, `wav seed ${seed}`).toEqual(model);
      // MIDI drum hits have no stored end; compare onsets for everything, note ends for notes.
      expect(midi.ons, `midi onsets seed ${seed}`).toEqual(model.ons);
      expect(midi.offs, `midi note ends seed ${seed}`).toEqual(model.offs);
    }
    expect(total).toBeGreaterThan(3000);
  });

  it('sounding.songEnd: 曲末以降に始まる音は 3 経路とも 0 件', () => {
    let overrun = 0;
    for (const seed of SEEDS) {
      const project = generateProject(seed);
      const endTick = tickOf(songEndBeat(project));
      const { live, wav, midi } = paths(project);
      for (const [name, p] of Object.entries({ live, wav, midi })) {
        for (const key of p.ons) expect(Number(key.split('|')[2]), `${name} seed ${seed}: ${key}`).toBeLessThan(endTick);
      }
      overrun += project.tracks.flatMap((t) => t.clips).filter((c) => tickOf(c.startBeat + c.lengthBeats) > endTick).length;
    }
    expect(overrun).toBeGreaterThan(50);
  });

  it('sounding.songEnd: 曲末をまたぐノートは D3 のとおり 3 経路で同じ終了 tick', () => {
    const project = makeProject(
      [
        makeTrack('t', 'instrument', [midiClip('a', 't', 0, 16, [[3, 3, 60], [3.5, 0.25, 62], [0, 1, 64]])]),
        makeTrack('d', 'drum', [drumClip('b', 'd', 0, 16, [[15, 'snare'], [16, 'kick']])]),
      ],
      { lengthBars: 1 },
    );
    const { model, live, wav, midi } = paths(project);
    const end = tickOf(4);
    expect(model.offs).toContain(`t|${end}|60`); // cut at the song end
    expect(model.offs).toContain(`t|${tickOf(3.75)}|62`); // inside the song: untouched
    for (const p of [live, wav, midi]) {
      expect(p.offs).toEqual(model.offs);
      expect(p.ons).toEqual(model.ons);
    }
    expect(model.ons.filter((k) => k.startsWith('drum|'))).toHaveLength(1); // the step at the song end is dropped
  });

  it('sounding.songEnd: WAV の音の終わり(songSoundEndBeat)は曲末で、切れたノートが曲末を越えて延びない', () => {
    const project = makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 16, [[3, 3, 60]])])], { lengthBars: 1 });
    expect(songSoundEndBeat(project)).toBe(songEndBeat(project));
  });
});
