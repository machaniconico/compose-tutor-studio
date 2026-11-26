// US-007a 事後レビューの回帰: 1 tick 未満のノートとトラック名の長さに比例する展開。
import { describe, expect, it, vi } from 'vitest';
import { PPQ, soundingEvents } from '../src/sounding';
import { makeProject, makeTrack, midiClip } from './acceptance/helpers';

describe('soundingEvents の終了 tick', () => {
  it('1 tick 未満のノートは開始 tick + 1 で終わる', () => {
    const project = makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0, 1 / 1920, 60]])])]);
    const [event] = soundingEvents(project).events;
    expect(event?.kind).toBe('note');
    if (event?.kind !== 'note') return;
    expect(Math.round((event.startBeat + event.durationBeats) * PPQ)).toBe(1);
  });

  it('1 tick 以上のノートの長さは変えない', () => {
    const project = makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0.5, 0.75, 60]])])]);
    const [event] = soundingEvents(project).events;
    expect(event?.kind === 'note' && event.durationBeats).toBe(0.75);
  });
});

/** Median of 3 runs after one warm-up, so a loaded machine does not flip the verdict. */
function medianMs(run: () => void): number {
  run();
  const times = [0, 1, 2].map(() => {
    const t0 = performance.now();
    run();
    return performance.now() - t0;
  });
  return times.sort((a, b) => a - b)[1]!;
}

function longNameInstrumentProject() {
  const name = ' '.repeat(8192);
  return makeProject(Array.from({ length: 50_000 }, (_, i) => ({
    ...makeTrack(`t${i}`, 'instrument', [midiClip(`c${i}`, `t${i}`, 0, 4, [[0, 1, 60]])]),
    name,
  })));
}

/**
 * One drum track named 65,536 spaces with 20,000 back-to-back 1-tick clips of
 * one note each. Notes do not sound on a drum track, so every clip reports a problem.
 */
function longNameDrumProject() {
  const clips = Array.from({ length: 20_000 }, (_, i) => midiClip(`d${i}`, 'd', i / PPQ, 1 / PPQ, [[0, 1 / PPQ, 60]]));
  return makeProject([{ ...makeTrack('d', 'drum', clips), name: ' '.repeat(65_536) }], { lengthBars: 64 });
}

describe('soundingEvents の性能', () => {
  it('50,000 トラック・各トラック名が空白 8,192 個でも中央値 100ms 未満', () => {
    const project = longNameInstrumentProject();
    expect(soundingEvents(project).events).toHaveLength(50_000);
    expect(medianMs(() => soundingEvents(project))).toBeLessThan(100);
  });

  it('名前が空白 65,536 個のドラムトラックに 1 tick のクリップ 20,000 個でも中央値 100ms 未満', () => {
    const project = longNameDrumProject();
    expect(soundingEvents(project).problems).toHaveLength(20_000);
    expect(medianMs(() => soundingEvents(project))).toBeLessThan(100);
  });

  it('トラック名の整形(trim)はトラック数以下', () => {
    for (const project of [longNameDrumProject(), longNameInstrumentProject()]) {
      const trim = vi.spyOn(String.prototype, 'trim');
      try {
        soundingEvents(project);
        expect(trim.mock.calls.length).toBeLessThanOrEqual(project.tracks.length);
      } finally {
        trim.mockRestore();
      }
    }
  });
});
