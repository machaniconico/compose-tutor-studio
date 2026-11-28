import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PPQ,
  createEmptyProject,
  type Clip,
  type NoteEvent,
  type Project,
  type Track,
} from '@cts/project-model';
import { projectToMidiResult } from '@cts/midi-io';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { GRID_SNAP_OPTIONS, TRIPLET_EIGHTH_BEATS, TRIPLET_SIXTEENTH_BEATS, snapBeat } from '../src/features/pianoRoll/gridMath';
import { installLocalStorage } from './localStorageStub';
import type { NoteEditOutcome } from '../src/state/noteEditActions';
import {
  joinNotesInProject,
  legatoNotesInProject,
  nudgeNotesInProject,
  rampVelocityInProject,
  splitNotesInProject,
  staccatoNotesInProject,
} from '../src/state/noteToolActions';

let useStore: typeof import('../src/state/store')['useStore'];
let tools: typeof import('../src/state/noteToolActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  tools = await import('../src/state/noteToolActions');
});

type Spec = [pitch: number, startBeat: number, durationBeats?: number, velocity?: number];

function song(specs: readonly Spec[], over: { loop?: boolean; swing?: number; lengthBeats?: number } = {}): Project {
  const base = createEmptyProject({ key: 'C', scale: 'major' });
  const tracks = base.tracks.map((track): Track => {
    if (track.type === 'instrument' && track.role === 'learning.melody') {
      const clip: Clip = {
        id: 'mel', trackId: track.id, type: 'midi', startBeat: 0, lengthBeats: over.lengthBeats ?? 8, loop: over.loop ?? false,
        notes: specs.map(([pitch, startBeat, durationBeats = 1, velocity = 90], i) => ({ id: `n${i}`, pitch, startBeat, durationBeats, velocity })),
      };
      return { ...track, clips: [clip] };
    }
    return track.type === 'master' ? track : { ...track, clips: [] };
  });
  return { ...base, tracks, chordTrack: [], swing: over.swing ?? 0 };
}

function notesOf(project: Project): NoteEvent[] {
  return project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'mel')!.notes ?? [];
}
const byId = (project: Project, id: string) => notesOf(project).find((n) => n.id === id);

function ok(outcome: NoteEditOutcome): Extract<NoteEditOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome;
}
function refused(outcome: NoteEditOutcome): string {
  expect(outcome.ok).toBe(false);
  return outcome.ok ? '' : outcome.reason;
}

describe('レガート', () => {
  it('次に始まる選んだ音の始まりまで、高さに関わらず伸ばし、最後の音は変えない', () => {
    const p = song([[60, 0, 0.5], [64, 1, 0.25], [67, 1, 0.5], [72, 3, 0.5]]);
    const out = ok(legatoNotesInProject(p, 'mel', ['n0', 'n1', 'n2', 'n3']));
    expect(byId(out.project, 'n0')!.durationBeats).toBe(1);
    expect(byId(out.project, 'n1')!.durationBeats).toBe(2); // 和音は同じ始まり。次の始まり(3)まで
    expect(byId(out.project, 'n2')!.durationBeats).toBe(2);
    expect(byId(out.project, 'n3')!.durationBeats).toBe(0.5);
  });
  it('選んでいない音は次の音として数えない', () => {
    const p = song([[60, 0, 0.5], [62, 1, 0.5], [64, 2, 0.5]]);
    expect(byId(ok(legatoNotesInProject(p, 'mel', ['n0', 'n2'])).project, 'n0')!.durationBeats).toBe(2);
  });
  it('3 連符の位置でも整数 tick で伸びる', () => {
    const p = song([[60, 0, 0.1], [62, TRIPLET_EIGHTH_BEATS, 0.1], [64, 2 * TRIPLET_EIGHTH_BEATS, 0.1]]);
    const out = ok(legatoNotesInProject(p, 'mel', ['n0', 'n1', 'n2']));
    expect(byId(out.project, 'n0')!.durationBeats * PPQ).toBe(160);
    expect(byId(out.project, 'n1')!.durationBeats * PPQ).toBe(160);
  });
  it('すでに接している・音が 1 つだけなら何も変えない(Undo も積まない)', () => {
    const p = song([[60, 0, 1], [62, 1, 1]]);
    expect(ok(legatoNotesInProject(p, 'mel', ['n0', 'n1'])).changed).toBe(false);
    expect(ok(legatoNotesInProject(p, 'mel', ['n0'])).changed).toBe(false);
  });
  it('目盛りに乗らない始まりの音は断る', () => {
    const p = song([[60, 0.3001, 0.5], [62, 1, 0.5]]);
    expect(refused(legatoNotesInProject(p, 'mel', ['n0', 'n1']))).toMatch(/目盛り/);
  });
  it('伸ばした先に選んでいない同じ高さの音があって重なるなら断る', () => {
    const p = song([[60, 0, 0.5], [60, 1, 1], [62, 3, 0.5]]);
    // n0 は n2(3)まで伸びるが、途中の同じ高さの n1 と重なる
    expect(refused(legatoNotesInProject(p, 'mel', ['n0', 'n2']))).toMatch(/重なって/);
  });
  it('ループのクリップで周期が変わるなら断る(最後の音を伸ばす場合)', () => {
    const p = song([[60, 0, 1], [62, 2, 0.5], [64, 3, 0.5]], { loop: true });
    // n1 を n2 の始まりまで伸ばしても周期(3.5)は変わらない。最後の音を縮める staccato は周期が変わるので断る
    expect(ok(legatoNotesInProject(p, 'mel', ['n1', 'n2'])).changed).toBe(true);
    expect(refused(staccatoNotesInProject(p, 'mel', ['n2']))).toMatch(/ループ/);
  });
});

describe('スタッカート', () => {
  it('長さを半分にし、tick に四捨五入(0.5 は切り上げ)、最低 1 tick', () => {
    const p = song([[60, 0, 1], [62, 2, 5 / PPQ], [64, 4, 2 / PPQ]]);
    const out = ok(staccatoNotesInProject(p, 'mel', ['n0', 'n1', 'n2']));
    expect(byId(out.project, 'n0')!.durationBeats).toBe(0.5);
    expect(Math.round(byId(out.project, 'n1')!.durationBeats * PPQ)).toBe(3); // round(2.5)
    expect(Math.round(byId(out.project, 'n2')!.durationBeats * PPQ)).toBe(1);
  });
  it('1 tick の音が 1 つでもあれば全体を断る', () => {
    expect(refused(staccatoNotesInProject(song([[60, 0, 1 / PPQ]]), 'mel', ['n0']))).toMatch(/1 ティック/);
    expect(staccatoNotesInProject(song([[60, 0, 1], [62, 2, 1 / PPQ]]), 'mel', ['n0', 'n1']).ok).toBe(false);
  });
});

describe('連結', () => {
  it('同じ高さで接する・重なる音を、いちばん早い音の id と強さで 1 つにする', () => {
    const p = song([[60, 1, 1, 70], [60, 0, 1, 50], [60, 1.5, 1, 99], [62, 0, 1, 80]]);
    const out = ok(joinNotesInProject(p, 'mel', ['n0', 'n1', 'n2', 'n3']));
    expect(notesOf(out.project).map((n) => n.id)).toEqual(['n1', 'n3']);
    const merged = byId(out.project, 'n1')!;
    expect([merged.startBeat, merged.durationBeats, merged.velocity]).toEqual([0, 2.5, 50]);
    expect(out.noteIds).toEqual(['n1', 'n3']);
  });
  it('離れている・高さが違う音はつながない。つなげるものが無ければ断る', () => {
    const p = song([[60, 0, 1], [60, 2, 1], [62, 1, 1]]);
    expect(refused(joinNotesInProject(p, 'mel', ['n0', 'n1', 'n2']))).toMatch(/つなげられる音がありません/);
  });
  it('選んでいない音は残す', () => {
    const p = song([[60, 0, 1], [60, 1, 1], [60, 2, 1]]);
    const out = ok(joinNotesInProject(p, 'mel', ['n0', 'n1']));
    expect(notesOf(out.project).map((n) => n.id)).toEqual(['n0', 'n2']);
  });
});

describe('分割', () => {
  it('またぐ音だけを 2 つにする。始まり・終わりちょうどは分けない', () => {
    const p = song([[60, 0, 2], [62, 1, 1], [64, 1.5, 1]]);
    const out = ok(splitNotesInProject(p, 'mel', ['n0', 'n1', 'n2'], PPQ, () => 'x'));
    expect(notesOf(out.project).map((n) => [n.id, n.startBeat, n.durationBeats])).toEqual([
      ['n0', 0, 1], ['x', 1, 1], ['n1', 1, 1], ['n2', 1.5, 1],
    ]);
    expect(out.noteIds).toEqual(['n0', 'x', 'n1', 'n2']);
  });
  it('どの音もまたがない・位置が不正なら断る', () => {
    const p = song([[60, 0, 1]]);
    expect(refused(splitNotesInProject(p, 'mel', ['n0'], PPQ))).toMatch(/再生ヘッド/);
    for (const at of [0, -1, 1.5, NaN, Infinity]) expect(splitNotesInProject(p, 'mel', ['n0'], at).ok).toBe(false);
  });
  it('3 連符の途中でも両方 1 tick 以上の整数 tick', () => {
    const p = song([[60, 0, 2 / PPQ]]);
    const out = ok(splitNotesInProject(p, 'mel', ['n0'], 1, () => 'x'));
    expect(notesOf(out.project).map((n) => n.durationBeats * PPQ)).toEqual([1, 1]);
  });
});

describe('グリッド移動', () => {
  it('グリッド幅(3 連符を含む)ぶん、整数 tick で動かす', () => {
    const p = song([[60, 1, 0.5]]);
    const out = ok(nudgeNotesInProject(p, 'mel', ['n0'], 160));
    expect(byId(out.project, 'n0')!.startBeat * PPQ).toBe(640);
    const back = ok(nudgeNotesInProject(out.project, 'mel', ['n0'], -160));
    expect(byId(back.project, 'n0')!.startBeat).toBe(1);
  });
  it('クリップの外へ出る・先頭より前なら、切り詰めず全体を断る', () => {
    const p = song([[60, 0, 1], [62, 7, 1]]);
    expect(refused(nudgeNotesInProject(p, 'mel', ['n0', 'n1'], PPQ))).toMatch(/クリップの終わり/);
    expect(refused(nudgeNotesInProject(p, 'mel', ['n0', 'n1'], -PPQ))).toMatch(/先頭/);
  });
  it('同じ高さの音と重なるなら断る', () => {
    const p = song([[60, 0, 1], [60, 1.5, 1]]);
    expect(refused(nudgeNotesInProject(p, 'mel', ['n0'], 960))).toMatch(/重なって/);
  });
  it('0・小数・NaN は断る', () => {
    const p = song([[60, 0, 1]]);
    for (const d of [0, 0.5, NaN, Infinity, '1' as unknown as number]) expect(nudgeNotesInProject(p, 'mel', ['n0'], d).ok).toBe(false);
  });
});

describe('ベロシティランプ', () => {
  it('最初の音から最後の音へ、拍位置に比例して四捨五入。同じ位置の音は同じ強さ', () => {
    const p = song([[60, 0], [64, 0], [62, 1], [65, 3]]);
    const out = ok(rampVelocityInProject(p, 'mel', ['n3', 'n0', 'n1', 'n2'], 20, 100));
    expect(notesOf(out.project).map((n) => n.velocity)).toEqual([20, 20, 47, 100]);
  });
  it('音が 1 つ(または同じ位置だけ)なら from', () => {
    expect(byId(ok(rampVelocityInProject(song([[60, 1]]), 'mel', ['n0'], 33, 99)).project, 'n0')!.velocity).toBe(33);
  });
  it('1〜127 の整数以外は断り、結果は 1〜127 に収まる', () => {
    const p = song([[60, 0], [62, 1]]);
    for (const [a, b] of [[0, 10], [10, 128], [1.5, 10], [NaN, 3]] as const) expect(rampVelocityInProject(p, 'mel', ['n0', 'n1'], a, b).ok).toBe(false);
    const out = ok(rampVelocityInProject(p, 'mel', ['n0', 'n1'], 1, 127));
    expect(notesOf(out.project).map((n) => n.velocity)).toEqual([1, 127]);
  });
});

describe('悪意のある値でも投げない', () => {
  it('全操作が理由つきで断るだけ', () => {
    const hostile = { toString: null } as unknown as string;
    const p = song([[60, 0, 1]]);
    const calls = [
      () => legatoNotesInProject(p, hostile, [hostile]),
      () => staccatoNotesInProject(p, hostile, [hostile]),
      () => joinNotesInProject(p, hostile, hostile as unknown as string[]),
      () => splitNotesInProject(p, hostile, [hostile], hostile as unknown as number),
      () => nudgeNotesInProject(p, hostile, [hostile], hostile as unknown as number),
      () => rampVelocityInProject(p, hostile, [hostile], hostile as unknown as number, 1),
      () => legatoNotesInProject(p, 'mel', [hostile]),
      () => rampVelocityInProject(p, 'mel', ['n0'], { valueOf: null } as unknown as number, 1),
    ];
    for (const call of calls) {
      expect(call).not.toThrow();
      expect(call().ok).toBe(false);
    }
  });
});

describe('3 連符グリッド', () => {
  it('1/8 三連 = 160 tick、1/16 三連 = 80 tick で、どの位置も整数 tick', () => {
    expect(TRIPLET_EIGHTH_BEATS * PPQ).toBe(160);
    expect(TRIPLET_SIXTEENTH_BEATS * PPQ).toBe(80);
    expect(GRID_SNAP_OPTIONS).toContain(TRIPLET_EIGHTH_BEATS);
    expect(GRID_SNAP_OPTIONS).toContain(TRIPLET_SIXTEENTH_BEATS);
    for (const snap of [TRIPLET_EIGHTH_BEATS, TRIPLET_SIXTEENTH_BEATS]) {
      for (let k = 0; k < 200; k += 1) {
        const beat = snapBeat(k * snap + 0.01, snap);
        expect(Math.round(beat * PPQ) / PPQ).toBe(beat);
      }
    }
  });
  it('スウィングは 3 連符の位置を動かさない(60% でも)', () => {
    for (const grid of [TRIPLET_EIGHTH_BEATS, TRIPLET_SIXTEENTH_BEATS]) {
      const specs: Spec[] = Array.from({ length: 12 }, (_, k): Spec => [60 + (k % 5), k * grid, grid / 2]);
      const straight = buildScheduleEvents(song(specs, { swing: 0 })).map((e) => e.beat);
      const swung = buildScheduleEvents(song(specs, { swing: 60 })).map((e) => e.beat);
      for (const [k, beat] of straight.entries()) {
        const onOddSixteenth = Math.round(beat * PPQ) % 240 === 120;
        if (!onOddSixteenth) expect(swung[k]).toBe(beat);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 店(store)を通した動作
// ---------------------------------------------------------------------------

describe('store integration (one undo step each)', () => {
  beforeEach(() => {
    useStore.setState({
      project: { ...song([[60, 0, 0.5], [62, 1, 0.5], [64, 2, 2]]), id: useStore.getState().project.id },
      past: [],
      future: [],
      audioRecordingOperationId: null,
      midiRecordingActive: false,
      projectOperationBusy: false,
    });
  });

  it('レガートは Undo 1 段で、結果の音を選び直す', () => {
    const result = tools.legatoSelectedNotes('mel', ['n0', 'n1', 'n2']);
    expect(result.ok && result.changed).toBe(true);
    expect(useStore.getState().past.length).toBe(1);
    expect(useStore.getState().editor.selectedNoteIds).toEqual(['n0', 'n1', 'n2']);
    useStore.getState().undo();
    expect(byId(useStore.getState().project, 'n0')!.durationBeats).toBe(0.5);
  });

  it('何も変わらない操作は履歴を積まない', () => {
    tools.legatoSelectedNotes('mel', ['n0', 'n1', 'n2']);
    useStore.setState({ past: [] });
    expect(tools.legatoSelectedNotes('mel', ['n0', 'n1', 'n2']).ok).toBe(true);
    expect(useStore.getState().past.length).toBe(0);
  });

  it('録音中・MIDI テイク中・プロジェクト操作中は日本語の理由で断る', () => {
    for (const patch of [{ audioRecordingOperationId: 1 }, { midiRecordingActive: true }, { projectOperationBusy: true }]) {
      useStore.setState({ ...patch, past: [] });
      const before = useStore.getState().project;
      for (const result of [
        tools.legatoSelectedNotes('mel', ['n0', 'n1']),
        tools.staccatoSelectedNotes('mel', ['n0']),
        tools.joinSelectedNotes('mel', ['n0']),
        tools.splitSelectedNotesAtPlayhead('mel', ['n2']),
        tools.nudgeSelectedNotes('mel', ['n0'], 1, 0.25),
        tools.rampSelectedVelocity('mel', ['n0', 'n1'], 10, 20),
      ]) {
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.reason).toMatch(/できません/);
      }
      expect(useStore.getState().project).toBe(before);
      expect(useStore.getState().past.length).toBe(0);
      useStore.setState({ audioRecordingOperationId: null, midiRecordingActive: false, projectOperationBusy: false });
    }
  });

  it('分割は再生ヘッドの位置で行い、クリップの外・音の外なら断る', () => {
    useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: 3 } }));
    const result = tools.splitSelectedNotesAtPlayhead('mel', ['n2']);
    expect(result.ok && result.changed).toBe(true);
    expect(notesOf(useStore.getState().project).map((n) => [n.startBeat, n.durationBeats])).toEqual([[0, 0.5], [1, 0.5], [2, 1], [3, 1]]);
    expect(useStore.getState().past.length).toBe(1);
    for (const position of [-1, 100, NaN, 0.75]) {
      useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: position } }));
      const before = useStore.getState().project;
      expect(tools.splitSelectedNotesAtPlayhead('mel', ['n0', 'n1']).ok).toBe(false);
      expect(useStore.getState().project).toBe(before);
    }
  });

  it('グリッド移動は 1 段のグリッド幅で動かし、不正な段数・グリッドは断る', () => {
    expect(tools.nudgeSelectedNotes('mel', ['n0'], 1, TRIPLET_EIGHTH_BEATS).ok).toBe(true);
    expect(byId(useStore.getState().project, 'n0')!.startBeat * PPQ).toBe(160);
    for (const [steps, snap] of [[0, 1], [1.5, 1], [1000, 1], [1, 0], [1, NaN], [1, 1 / 7]] as const) {
      expect(tools.nudgeSelectedNotes('mel', ['n0'], steps, snap).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 種つきファズ: スウィング・ループ・3 連符・選択を乱数で振り、
// 受け入れた操作は「選んだ音以外の鳴り方が変わらない」ことを独立に確かめる。
// ---------------------------------------------------------------------------

describe('seeded fuzz (300 rounds)', () => {
  function counts(project: Project): Map<string, number> {
    const map = new Map<string, number>();
    for (const event of buildScheduleEvents(project)) {
      const p = event.payload as SchedulePayload;
      const key = p.kind === 'note'
        ? JSON.stringify([event.beat, p.trackId, p.pitch, p.durationBeats, p.velocity])
        : JSON.stringify([event.beat, p]);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }
  /** 対象の音を取り除き、周期を保つ番兵を足したプロジェクト(選んでいない音の鳴り方だけが残る)。 */
  function control(project: Project, drop: ReadonlySet<string>, periodBeats: number): Project {
    return {
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip): Clip => clip.id !== 'mel'
          ? clip
          : {
            ...clip,
            notes: [
              ...(clip.notes ?? []).filter((n) => !drop.has(n.id)),
              { id: 'sentinel', pitch: 1, startBeat: periodBeats - 1 / PPQ, durationBeats: 1 / PPQ, velocity: 1 },
            ],
          }),
      })),
    };
  }

  it('受け入れた操作は選んだ音だけを変え、断った操作は曲も履歴も変えない', () => {
    let seed = 20261128;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const int = (n: number) => Math.floor(rnd() * n);
    let accepted = 0;
    let refusedCount = 0;
    const acceptedByOp = new Map<number, number>();
    for (let round = 0; round < 300; round += 1) {
      const grid = [0.25, TRIPLET_EIGHTH_BEATS, TRIPLET_SIXTEENTH_BEATS, 0.5][int(4)]!;
      const specs: Spec[] = [];
      for (let i = 0, count = 1 + int(7); i < count; i += 1) {
        const previous = specs[specs.length - 1];
        const duration = Math.max(1, Math.round(grid * PPQ * (1 + int(3)) * (rnd() < 0.2 ? 0.5 : 1))) / PPQ;
        if (previous && rnd() < 0.4) {
          // 同じ高さで接する(または少し重なる)音。連結の対象になる。
          const start = (Math.round(previous[1] * PPQ) + Math.round((previous[2] ?? 1) * PPQ) - (rnd() < 0.3 ? 1 : 0)) / PPQ;
          specs.push([previous[0], start, duration, 20 + int(100)]);
        } else {
          const start = Math.round((int(Math.floor(8 / grid) - 1) * grid) * PPQ) / PPQ;
          specs.push([58 + int(5), start, duration, 20 + int(100)]);
        }
      }
      const project: Project = {
        ...song(specs, { loop: rnd() < 0.4, swing: [0, 33, 60][int(3)]! }),
        id: useStore.getState().project.id,
      };
      if (!projectToMidiResult(project).ok) continue;
      useStore.setState({ project, past: [], future: [], audioRecordingOperationId: null, midiRecordingActive: false, projectOperationBusy: false });
      const before = useStore.getState().project;
      const beforeNotes = notesOf(before);
      const selected = beforeNotes.filter(() => rnd() < 0.6).map((n) => n.id);
      const op = int(6);
      let result: { ok: boolean; changed?: boolean };
      if (op === 0) result = tools.legatoSelectedNotes('mel', selected);
      else if (op === 1) result = tools.staccatoSelectedNotes('mel', selected);
      else if (op === 2) result = tools.joinSelectedNotes('mel', selected);
      else if (op === 3) {
        const inside = beforeNotes.find((n) => selected.includes(n.id) && n.durationBeats * PPQ > 1);
        const position = inside && rnd() < 0.7
          ? inside.startBeat + (1 + int(Math.max(1, Math.round(inside.durationBeats * PPQ) - 1))) / PPQ
          : Math.round(rnd() * 8 * PPQ) / PPQ;
        useStore.setState((s) => ({ transport: { ...s.transport, positionBeat: position } }));
        result = tools.splitSelectedNotesAtPlayhead('mel', selected);
      } else if (op === 4) result = tools.nudgeSelectedNotes('mel', selected, rnd() < 0.5 ? 1 : -1, grid);
      else result = tools.rampSelectedVelocity('mel', selected, 1 + int(127), 1 + int(127));
      const after = useStore.getState().project;
      if (!result.ok || !result.changed) {
        refusedCount += 1;
        expect(after).toBe(before);
        expect(useStore.getState().past.length).toBe(0);
        continue;
      }
      accepted += 1;
      acceptedByOp.set(op, (acceptedByOp.get(op) ?? 0) + 1);
      expect(useStore.getState().past.length).toBe(1);
      expect(projectToMidiResult(after).ok).toBe(true);
      const afterNotes = notesOf(after);
      // 位置・長さは整数 tick、高さと強さは範囲内
      for (const n of afterNotes) {
        expect(Math.round(n.startBeat * PPQ) / PPQ).toBe(n.startBeat);
        expect(n.durationBeats * PPQ).toBeGreaterThanOrEqual(1);
        expect(n.velocity).toBeGreaterThanOrEqual(1);
        expect(n.velocity).toBeLessThanOrEqual(127);
        expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(8 + 1e-9);
      }
      // 選んでいない音は 1 つも変わっていない
      const unselected = beforeNotes.filter((n) => !selected.includes(n.id));
      for (const n of unselected) expect(afterNotes.find((a) => a.id === n.id)).toEqual(n);
      // 選んでいない音の鳴り方(スウィング・ループ込み)は、番兵つきの対照と完全に一致する
      const drop = new Set([...selected, ...afterNotes.map((n) => n.id).filter((id) => !beforeNotes.some((b) => b.id === id))]);
      const period = Math.max(...beforeNotes.map((n) => n.startBeat + n.durationBeats));
      expect(counts(control(after, drop, period))).toEqual(counts(control(before, drop, period)));
      // 周期は変わらない(ループのとき)
      const newPeriod = Math.max(...afterNotes.map((n) => n.startBeat + n.durationBeats));
      if (notesOf(before).length > 0 && project.tracks.some((t) => t.clips.some((c) => c.id === 'mel' && c.loop))) {
        expect(Math.round(newPeriod * PPQ)).toBe(Math.round(period * PPQ));
      }
    }
    for (let op = 0; op < 6; op += 1) expect(acceptedByOp.get(op) ?? 0).toBeGreaterThan(3);
    expect(accepted).toBeGreaterThan(50);
    expect(refusedCount).toBeGreaterThan(20);
  });
});
