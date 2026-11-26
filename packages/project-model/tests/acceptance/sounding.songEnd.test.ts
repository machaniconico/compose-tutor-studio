import { describe, expect, it } from 'vitest';
import { soundingEvents, songEndBeat } from '../../src/sounding';
import { beatsPerBar } from '../../src/index';
import { SEEDS, drumClip, generateProject, makeProject, makeTrack, midiClip, tickOf } from './helpers';

describe('sounding.songEnd (model)', () => {
  it('sounding.songEnd: songEndBeat は lengthBars × 1 小節の拍数', () => {
    expect(songEndBeat(makeProject([], { lengthBars: 8 }))).toBe(32);
    expect(songEndBeat(makeProject([], { lengthBars: 5, timeSignature: [3, 4] }))).toBe(15);
    expect(songEndBeat(makeProject([], { lengthBars: 4, timeSignature: [6, 8] }))).toBe(4 * beatsPerBar([6, 8]));
  });

  it('sounding.songEnd: 曲末以降に始まる音は 3 経路とも 0 件(モデル: soundingEvents)', () => {
    let beyond = 0;
    for (const seed of SEEDS) {
      const project = generateProject(seed);
      const endTick = tickOf(songEndBeat(project));
      for (const e of soundingEvents(project).events) expect(tickOf(e.startBeat)).toBeLessThan(endTick);
      beyond += project.tracks.flatMap((t) => t.clips).filter((c) => tickOf(c.startBeat + c.lengthBeats) > endTick).length;
    }
    expect(beyond).toBeGreaterThan(50); // the generator really does overrun the song end
  });

  it('sounding.songEnd: 曲末をまたぐノートは D3 のとおり曲末で切れる(モデル)', () => {
    const project = makeProject(
      [
        makeTrack('t', 'instrument', [midiClip('a', 't', 0, 16, [[3, 3, 60], [2, 1, 62], [4, 1, 64]])]),
        makeTrack('d', 'drum', [drumClip('b', 'd', 0, 16, [[16, 'kick'], [15, 'snare']])]),
      ],
      { lengthBars: 1 },
    );
    const { events } = soundingEvents(project);
    const note = (pitch: number) => events.find((e) => e.kind === 'note' && e.pitch === pitch);
    expect(tickOf((note(60) as { startBeat: number }).startBeat + (note(60) as { durationBeats: number }).durationBeats)).toBe(tickOf(4));
    expect(note(64)).toBeUndefined(); // starts at the song end
    expect(tickOf((note(62) as { startBeat: number }).startBeat + (note(62) as { durationBeats: number }).durationBeats)).toBe(tickOf(3));
    expect(events.filter((e) => e.kind === 'drum').map((e) => (e as { lane: string }).lane)).toEqual(['snare']);
  });
});
