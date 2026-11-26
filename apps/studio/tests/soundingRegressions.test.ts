// US-007a 事後レビューの回帰: 1 tick 未満のノートと極短ループ範囲。
import { describe, expect, it, vi } from 'vitest';
import { projectToMidi } from '@cts/midi-io';
import { MIN_LOOP_PERIOD_BEATS, PPQ, soundingEvents } from '@cts/project-model';
import { decodeSmfMessages, makeProject, makeTrack, midiClip } from '../../../packages/project-model/tests/acceptance/helpers';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { renderScheduleEvents } from '../src/audio/wav';
import { isValidLoop, Scheduler } from '../src/audio/scheduler';

const endTickOf = (beat: number, payload: unknown): number =>
  Math.round((beat + (payload as Extract<SchedulePayload, { kind: 'note' }>).durationBeats) * PPQ);

describe('1 tick 未満のノート', () => {
  const project = makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0, 1 / 1920, 60]])])]);

  it('発音の正・ライブ・WAV・MIDI の終了 tick がすべて 1 になる', () => {
    const [event] = soundingEvents(project).events;
    expect(event && Math.round((event.startBeat + (event.kind === 'note' ? event.durationBeats : 0)) * PPQ)).toBe(1);
    const [live] = buildScheduleEvents(project);
    expect(live && endTickOf(live.beat, live.payload)).toBe(1);
    const [wav] = renderScheduleEvents(project);
    expect(wav && endTickOf(wav.beat, wav.payload)).toBe(1);
    const off = decodeSmfMessages(projectToMidi(project))[1]?.find((m) => (m.data[0]! & 0xf0) === 0x80);
    expect(off?.tick).toBe(1);
  });
});

describe('極短ループ範囲', () => {
  it('最短周期未満のループ範囲はループとして扱わない', () => {
    expect(isValidLoop({ startBeat: 0, endBeat: 1e-20 })).toBe(false);
    expect(isValidLoop({ startBeat: 0, endBeat: MIN_LOOP_PERIOD_BEATS / 2 })).toBe(false);
    expect(isValidLoop({ startBeat: 0, endBeat: MIN_LOOP_PERIOD_BEATS })).toBe(true);
  });

  it('ループ 0〜1e-20 拍・BPM120 でも先読み 1 回の列挙件数は元のイベント数以下', () => {
    const fire = vi.fn();
    const scheduler = new Scheduler({ clock: () => 0, fire, tickMs: 25, lookaheadS: 0.1 });
    scheduler.start([{ beat: 0, payload: 'a' }], 120, 0, { startBeat: 0, endBeat: 1e-20 }, 32);
    scheduler.stop();
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
