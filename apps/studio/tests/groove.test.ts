// US-018: 強さ付きクオンタイズ・ヒューマナイズ・スウィングの編集操作。保存データを書き換え、
// Undo 1 段。D2(1 周目に収める・発音数を減らさない・クリップ長を変えない)を、共有元と
// 全リンクの各周でスウィング込みの soundingEvents から確かめる。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clip, NoteEvent, Project } from '@cts/project-model';
import { humanize, placedNoteTicks, PPQ, quantizeClipNotes, resolveEditTarget, songEndBeat, soundingEvents, towardGrid } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';
import { FUZZ_SEEDS, FUZZ_SWINGS, grooveFuzzProject } from '../../../packages/project-model/tests/grooveFuzz';
import { mulberry32 } from '../../../packages/project-model/tests/acceptance/helpers';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');
let bridge: typeof import('../src/state/tutorialBridge');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
  bridge = await import('../src/state/tutorialBridge');
});

beforeEach(() => installLocalStorage());

function load(project: Project) {
  useStore.getState().createNewProject('テスト');
  useStore.setState({ project, past: [], future: [] });
}

function lastToast(): string | undefined {
  return bridge.getBridgeSnapshot().toasts.at(-1)?.message;
}

function expectRefused(before: Project, ok: boolean, toast?: string) {
  expect(ok).toBe(false);
  expect(useStore.getState().project).toBe(before);
  expect(useStore.getState().past).toHaveLength(0);
  if (toast) expect(lastToast()).toBe(toast);
}

function oneClipProject(clip: Clip, swing?: number): Project {
  return {
    id: 'g', schemaVersion: 3, title: 'g', bpm: 120, timeSignature: [4, 4], key: 'C', scale: 'major', lengthBars: 4,
    tracks: [{
      id: 'tr', name: 'メロディ', type: 'instrument', clips: [clip], volume: 0.8, pan: 0, mute: false, solo: false,
      effects: [], instrument: { type: 'synth', preset: 'warmPad' },
    }],
    chordTrack: [], sections: [], createdAt: 'now', updatedAt: 'now', ...(swing !== undefined ? { swing } : {}),
  };
}

const note = (id: string, startBeat: number, durationBeats = 0.1, velocity = 90): NoteEvent =>
  ({ id, pitch: 60, startBeat, durationBeats, velocity });

/** Played length in ticks of every (placement, pass, stored note id) that sounds, swing included. */
function soundingLengths(project: Project): Map<string, number> {
  const lengths = new Map<string, number>();
  const clips = new Map(project.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  for (const e of soundingEvents(project, { includeMuted: true }).events) {
    if (e.kind !== 'note') continue;
    const key = `${e.clipId}:${e.repeat}:${clips.get(e.sourceClipId)!.notes![e.sourceIndex]!.id}`;
    lengths.set(key, Math.round((e.startBeat + e.durationBeats) * 480) - Math.round(e.startBeat * 480));
  }
  return lengths;
}

describe('入力の守り', () => {
  it('strength・幅・seed・スウィングの不正な値では何もしない', () => {
    const project = oneClipProject({ id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes: [note('a', 0.3)] });
    load(project);
    for (const strength of [-1, 101, Number.NaN, Infinity]) expectRefused(project, actions.quantizeNotes('c', ['a'], 1, strength));
    for (const snap of [0, -0.5, Number.NaN]) expectRefused(project, actions.quantizeNotes('c', ['a'], snap, 50));
    for (const bad of [
      { timingBeats: -1, velocity: 0, seed: 1 },
      { timingBeats: Number.NaN, velocity: 0, seed: 1 },
      { timingBeats: 0.1, velocity: -1, seed: 1 },
      { timingBeats: 0.1, velocity: Infinity, seed: 1 },
      { timingBeats: 0.1, velocity: 1, seed: 0.5 },
      { timingBeats: 0.1, velocity: 1, seed: Number.MAX_SAFE_INTEGER + 1 },
    ]) expectRefused(project, actions.humanizeNotes('c', ['a'], bad));
    for (const swing of [-1, 61, Number.NaN, Infinity]) expectRefused(project, actions.setSwing(swing));
    expectRefused(project, actions.quantizeNotes('c', ['a'], 1, 0));
    expectRefused(project, actions.humanizeNotes('c', ['a'], { timingBeats: 0, velocity: 0, seed: 3 }));
  });
});

describe('スウィング', () => {
  it('0〜60% を保存し、0% はキーごと外して Undo で戻る', () => {
    const project = oneClipProject({ id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes: [note('a', 0.25)] });
    load(project);
    expect(actions.setSwing(60)).toBe(true);
    expect(useStore.getState().project.swing).toBe(60);
    expect(soundingEvents(useStore.getState().project).events[0]!.startBeat).toBeCloseTo(0.4, 12);
    expect(actions.setSwing(0)).toBe(true);
    expect('swing' in useStore.getState().project).toBe(false);
    expect(useStore.getState().past).toHaveLength(2);
    useStore.getState().undo();
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(project);
  });
});

describe('強さ付きクオンタイズ', () => {
  it('strength 100 は既存のクオンタイズ(quantizeClipNotes)と同じ位置、50 は中点', () => {
    const notes = [note('a', 0.1), note('b', 0.9), note('c', 3.95, 0.5)];
    const project = oneClipProject({ id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes });
    const existing = resolveEditTarget(quantizeClipNotes(project, 'c', ['a', 'b', 'c'], 1), 'c')!.notes!;
    load(project);
    expect(actions.quantizeNotes('c', ['a', 'b', 'c'], 1)).toBe(true);
    expect(resolveEditTarget(useStore.getState().project, 'c')!.notes).toEqual(existing);
    load(project);
    expect(actions.quantizeNotes('c', ['a', 'b', 'c'], 1, 50)).toBe(true);
    const half = resolveEditTarget(useStore.getState().project, 'c')!.notes!;
    half.forEach((n, i) => expect(n.startBeat).toBeCloseTo((notes[i]!.startBeat + existing[i]!.startBeat) / 2, 12));
    expect(useStore.getState().past).toHaveLength(1);
  });

  it.each([100, 50])('%i%% の正確な目標で 11 tick が 10 tick に縮む音だけなら、トーストを出して変更しない', (strength) => {
    const clip: Clip = { id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes: [note('a', 0.9005, 0.0215)] };
    const project = oneClipProject(clip, 0);
    const target = strength === 100 ? 1 : 0.95025;
    expect(soundingLengths(project).get('c:0:a')).toBe(11);
    expect(soundingLengths(oneClipProject({ ...clip, notes: [note('a', target, 0.0215)] }, 0)).get('c:0:a')).toBe(10);
    load(project);
    const toasts = bridge.getBridgeSnapshot().toasts.length;
    expectRefused(project, actions.quantizeNotes('c', ['a'], 1, strength), actions.NOTE_EDIT_MESSAGES.soundChanged);
    expect(bridge.getBridgeSnapshot().toasts).toHaveLength(toasts + 1);
  });

  it('短くなる音は元の位置に残し、残りの音は正確な目標へ Undo 1 段で動かす', () => {
    const notes = [note('a', 0.9005, 0.0215), note('b', 1.8)];
    const project = oneClipProject({ id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes }, 0);
    load(project);
    const toasts = bridge.getBridgeSnapshot().toasts.length;
    expect(actions.quantizeNotes('c', ['a', 'b'], 1, 50)).toBe(true);
    expect(resolveEditTarget(useStore.getState().project, 'c')!.notes).toEqual([notes[0], note('b', 1.9)]);
    expect(useStore.getState().past).toHaveLength(1);
    expect(bridge.getBridgeSnapshot().toasts).toHaveLength(toasts);
  });

  it('リンクの最後の周で短くなる音も、他の音の移動を妨げない', () => {
    const notes = [note('a', 0.32, 0.2), note('b', 0.1)];
    const source: Clip = { id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 2, loop: true, contentLengthBeats: 1, notes };
    const link: Clip = { ...source, id: 'l', startBeat: 8, lengthBeats: 1.55, aliasOf: 'c', notes: undefined };
    const project = oneClipProject(source);
    load({ ...project, tracks: [{ ...project.tracks[0]!, clips: [source, link] }] });
    const before = soundingLengths(useStore.getState().project);
    expect(actions.quantizeNotes('l', ['a', 'b'], 0.5, 50)).toBe(true);
    const after = useStore.getState().project;
    expect(resolveEditTarget(after, 'l')!.notes).toEqual([notes[0], note('b', 0.05)]);
    expect(soundingLengths(after).get('l:1:a')).toBe(before.get('l:1:a'));
  });
});

describe('D2: 結果は 1 周目に収め、再生上の長さを短くしない(Codex レビュー指摘 1)', () => {
  // 長さ 8 拍・ループ周期 4 拍・swing 0。開始 3.75 拍・長さ 1 拍の音は元から周期の終わりをまたぐ。
  const crossing = (): Clip => ({
    id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 8, loop: true, contentLengthBeats: 4, notes: [note('a', 3.75, 1)],
  });
  const endsInsideFirstPass = (p: Project) => {
    const n = resolveEditTarget(p, 'c')!.notes![0]!;
    const t = placedNoteTicks(p.tracks[0]!.clips[0]!, n, { swing: p.swing, songEnd: songEndBeat(p) });
    return t.naturalEndTick <= t.passEndTick;
  };

  it.each([75, 50, 25])('目標が周期末を超える %i%% では元の位置に残す', (strength) => {
    const project = oneClipProject(crossing());
    load(project);
    expectRefused(project, actions.quantizeNotes('c', ['a'], 1, strength), actions.NOTE_EDIT_MESSAGES.soundChanged);
  });

  it('100% の従来のグリッド位置 (3 拍) なら周期内に収まる', () => {
    load(oneClipProject(crossing()));
    expect(actions.quantizeNotes('c', ['a'], 1)).toBe(true);
    expect(resolveEditTarget(useStore.getState().project, 'c')!.notes).toEqual([note('a', 3, 1)]);
    expect(endsInsideFirstPass(useStore.getState().project)).toBe(true);
  });

  it('1 周目より長い音は収まらないので、クオンタイズしても元の位置のまま', () => {
    const project = oneClipProject({ ...crossing(), notes: [note('a', 1.3, 5)] });
    load(project);
    expectRefused(project, actions.quantizeNotes('c', ['a'], 1, 50));
  });

  it('ヒューマナイズは元から周期をまたぐ音も 1 周目に収め、幅を超えて戻せなければ元の位置のまま', () => {
    for (let seed = 0; seed < 20; seed++) {
      load(oneClipProject(crossing()));
      actions.humanizeNotes('c', ['a'], { timingBeats: 0.05, velocity: 5, seed });
      const n = resolveEditTarget(useStore.getState().project, 'c')!.notes![0]!;
      expect(n.startBeat, `seed ${seed}`).toBe(3.75);
    }
    for (let seed = 0; seed < 20; seed++) {
      load(oneClipProject(crossing()));
      actions.humanizeNotes('c', ['a'], { timingBeats: 1, velocity: 0, seed });
      const p = useStore.getState().project;
      const n = resolveEditTarget(p, 'c')!.notes![0]!;
      expect(n.startBeat === 3.75 || endsInsideFirstPass(p), `seed ${seed}`).toBe(true);
    }
  });
});

describe('2 回目のレビュー指摘', () => {
  it('短いリンクで編集前から切れている音は、強さ 50% で寄せても 3 拍のまま・拒否されない', () => {
    const source: Clip = { id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 8, loop: true, contentLengthBeats: 4, notes: [note('a', 3, 0.75)] };
    const link: Clip = { id: 'l', trackId: 'tr', type: 'midi', startBeat: 8, lengthBeats: 3.5, loop: false, aliasOf: 'c' };
    const project = oneClipProject(source);
    load({ ...project, tracks: [{ ...project.tracks[0]!, clips: [source, link] }] });
    const before = useStore.getState().project;
    const toasts = bridge.getBridgeSnapshot().toasts.length;
    actions.quantizeNotes('c', ['a'], 1, 50);
    expect(resolveEditTarget(useStore.getState().project, 'c')!.notes![0]!.startBeat).toBe(3);
    // Nothing to move (the 50% target is 3 itself): no refusal toast, no change.
    expect(bridge.getBridgeSnapshot().toasts.length).toBe(toasts);
    expect(useStore.getState().project).toBe(before);
  });

  it('ヒューマナイズは乱数の候補が周期の終わりを越えても、幅の中で収まる位置(3.96)へ寄せる', () => {
    const clip: Clip = { id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 8, loop: true, contentLengthBeats: 4, notes: [note('a', 3.99, 0.04)] };
    load(oneClipProject(clip));
    expect(actions.humanizeNotes('c', ['a'], { timingBeats: 0.06, velocity: 16, seed: 1 })).toBe(true);
    expect(resolveEditTarget(useStore.getState().project, 'c')!.notes![0]!.startBeat).toBeCloseTo(3.96, 12);
    expect(useStore.getState().past).toHaveLength(1);
  });
});

describe('ヒューマナイズ', () => {
  it('幅の下限で終了 tick が周期末と一致する音を動かす', () => {
    const clip: Clip = { id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 8, loop: true, contentLengthBeats: 4, notes: [note('a', 3.984375, 0.0475)] };
    const project = oneClipProject(clip, 0);
    load(project);
    expect(actions.humanizeNotes('c', ['a'], { timingBeats: 0.03125, velocity: 0, seed: 1 })).toBe(true);
    const moved = resolveEditTarget(useStore.getState().project, 'c')!.notes![0]!;
    expect(moved.startBeat).toBe(3.953125);
    const ticks = placedNoteTicks(clip, moved, { swing: 0, songEnd: songEndBeat(project) });
    expect(ticks.naturalEndTick).toBe(1920);
    expect(ticks.passEndTick).toBe(1920);
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('ループの途中で切れる周から音が消える結果は、何も変えずにトーストで知らせる', () => {
    // 1 拍ごとに繰り返し、1.5 拍で終わるクリップ。0.4 拍の音は 2 周目(1.4 拍)でも鳴る。
    const clip: Clip = { id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 1.5, loop: true, contentLengthBeats: 1, notes: [note('a', 0.4)] };
    const opts = { timingBeats: 0.2, velocity: 0, seed: 0 };
    // 0.1 拍以上遅らせる seed(2 周目が 1.5 拍を超える)を純粋関数で探す。
    while (humanize(clip.notes!, opts)[0]!.startBeat < 0.51) opts.seed++;
    const project = oneClipProject(clip, 50);
    load(project);
    expectRefused(project, actions.humanizeNotes('c', ['a'], opts), actions.NOTE_EDIT_MESSAGES.soundChanged);
  });

  it('同じ seed なら同じ結果になり、ピッチと長さは変えない', () => {
    const notes = Array.from({ length: 8 }, (_, i) => note(`n${i}`, i * 0.5 + 0.1, 0.2, 60 + i));
    const project = oneClipProject({ id: 'c', trackId: 'tr', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, notes });
    const run = () => {
      load(project);
      expect(actions.humanizeNotes('c', notes.map((n) => n.id), { timingBeats: 0.05, velocity: 12, seed: 99 })).toBe(true);
      return resolveEditTarget(useStore.getState().project, 'c')!.notes!;
    };
    const first = run();
    expect(run()).toEqual(first);
    first.forEach((n, i) => {
      expect(n.pitch).toBe(notes[i]!.pitch);
      expect(n.durationBeats).toBe(notes[i]!.durationBeats);
    });
  });
});

describe('シード固定ファズ(端数の拍・ループ・リンク・swing 0/30/50/60・3/4・6/8)', () => {
  /** D2 and the playback post-condition on the edited project, or the refused edit left nothing behind. */
  function expectD2(before: Project, ok: boolean, clipId: string, bound: (n: NoteEvent, old: NoteEvent) => void) {
    const after = useStore.getState().project;
    if (!ok) {
      expect(after).toBe(before);
      expect(useStore.getState().past).toHaveLength(0);
      return;
    }
    expect(useStore.getState().past).toHaveLength(1);
    const lengths = (p: Project) => p.tracks.flatMap((t) => t.clips.map((c) => [c.id, c.startBeat, c.lengthBeats, c.contentLengthBeats]));
    expect(lengths(after)).toEqual(lengths(before));
    const afterLengths = soundingLengths(after);
    for (const [key, ticks] of soundingLengths(before)) {
      expect(afterLengths.has(key), key).toBe(true);
      expect(afterLengths.get(key)!, key).toBeGreaterThanOrEqual(ticks);
    }
    const oldNotes = new Map(resolveEditTarget(before, clipId)!.notes!.map((n) => [n.id, n]));
    const placements = after.tracks.flatMap((t) => t.clips).filter((c) => resolveEditTarget(after, c.id)?.id === resolveEditTarget(after, clipId)!.id);
    for (const n of resolveEditTarget(after, clipId)!.notes!) {
      const old = oldNotes.get(n.id)!;
      expect(n.pitch).toBe(old.pitch);
      expect(n.durationBeats).toBe(old.durationBeats);
      bound(n, old);
      if (n.startBeat === old.startBeat) continue;
      const opts = { swing: after.swing, songEnd: songEndBeat(after) };
      for (const c of placements) {
        const now = placedNoteTicks(c, n, opts);
        expect(now.startTick, `${c.id} ${n.id}`).toBeLessThan(now.passEndTick);
        expect(now.naturalEndTick, `${c.id} ${n.id}`).toBeLessThanOrEqual(now.passEndTick);
      }
    }
  }

  it('強さ付きクオンタイズとヒューマナイズは D2 と発音の事後条件を守る', () => {
    const r = mulberry32(2018);
    let applied = 0;
    for (const seed of FUZZ_SEEDS) {
      for (const swing of FUZZ_SWINGS) {
        const project = grooveFuzzProject(seed, swing);
        for (const clip of project.tracks.flatMap((t) => t.clips)) {
          const target = resolveEditTarget(project, clip.id);
          if (!target?.notes?.length) continue;
          const ids = target.notes.filter(() => r() < 0.7).map((n) => n.id);
          const snap = [0.25, 0.5, 1 / 3, 1][Math.floor(r() * 4)]!;
          const strength = [100, 75, 50, 25][Math.floor(r() * 4)]!;
          const grid = new Map(resolveEditTarget(quantizeClipNotes(project, clip.id, ids, snap), clip.id)!.notes!.map((n) => [n.id, n.startBeat]));
          load(project);
          const quantized = actions.quantizeNotes(clip.id, ids, snap, strength);
          expectD2(project, quantized, clip.id, (n, old) => {
            const start = towardGrid(old.startBeat, grid.get(n.id)!, strength);
            expect([old.startBeat, start], n.id).toContain(n.startBeat);
          });
          const opts = { timingBeats: [0.01, 0.05, 0.3][Math.floor(r() * 3)]!, velocity: 10, seed: Math.floor(r() * 2 ** 31) };
          const placements = project.tracks.flatMap((t) => t.clips).filter((c) => resolveEditTarget(project, c.id)?.id === target.id);
          const ticksOptions = { swing, songEnd: songEndBeat(project) };
          load(project);
          const humanized = actions.humanizeNotes(clip.id, ids, opts);
          expectD2(project, humanized, clip.id, (n, old) => {
            expect(Math.abs(n.startBeat - old.startBeat)).toBeLessThanOrEqual(opts.timingBeats);
            expect(Math.abs(n.velocity - old.velocity)).toBeLessThanOrEqual(opts.velocity);
            if (!ids.includes(n.id) || n.startBeat !== old.startBeat) return;
            const lo = Math.max(0, old.startBeat - opts.timingBeats);
            const hi = old.startBeat + opts.timingBeats;
            const fits = (startBeat: number) =>
              startBeat !== old.startBeat && Math.abs(startBeat - old.startBeat) <= opts.timingBeats &&
              placements.every((c) => {
                const before = placedNoteTicks(c, old, ticksOptions);
                const after = placedNoteTicks(c, { ...old, startBeat }, ticksOptions);
                return after.startTick < after.passEndTick && after.naturalEndTick <= after.passEndTick &&
                  Math.max(1, after.endTick - after.startTick) >= Math.max(1, before.endTick - before.startTick);
              });
            expect(fits(lo) || fits(hi), `${project.id} ${clip.id} ${n.id}: 幅の端`).toBe(false);
            for (let tick = Math.ceil(lo * PPQ); tick <= Math.floor(hi * PPQ); tick++) {
              expect(fits(tick / PPQ), `${project.id} ${clip.id} ${n.id}: tick ${tick}`).toBe(false);
            }
          });
          applied += Number(quantized) + Number(humanized);
        }
      }
    }
    expect(applied).toBeGreaterThan(100);
  });
});

describe('docs/12 §8 の手動 QA(FEAT-MAN-004)', () => {
  it('§8 の表に FEAT-MAN-004 があり、16 分音符のハイハットで確かめる手順になっている', () => {
    const log = readFileSync(fileURLToPath(new URL('../../../docs/12_release_qa_log.md', import.meta.url)), 'utf8');
    const section = log.slice(log.indexOf('## 8. 機能追加の聴感・手動QA'));
    expect(section.startsWith('## 8.')).toBe(true);
    const row = section.split('\n').find((line) => line.startsWith('| FEAT-MAN-004 |'));
    expect(row).toBeDefined();
    expect(row).toContain('ハイハット');
    expect(row).toContain('16 分音符');
    expect(row).toContain('8 分音符のハイハットでは確認にならない');
    expect(row).toContain('50%');
  });
});
