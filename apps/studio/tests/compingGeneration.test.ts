import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHORD_QUALITIES,
  MAX_PROJECT_TRACKS,
  PPQ,
  createEmptyProject,
  realizeChordPitches,
  type ChordEvent,
  type NoteEvent,
  type Project,
} from '@cts/project-model';
import { voicingCost } from '@cts/theory-engine';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { installLocalStorage } from './localStorageStub';
import {
  COMPING_PATTERN_OPTIONS,
  generateCompingInProject,
  projectBarCount,
  type CompingRequest,
} from '../src/state/compingGeneration';

let useStore: typeof import('../src/state/store')['useStore'];
let generateCompingClip: typeof import('../src/state/compingGeneration')['generateCompingClip'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ generateCompingClip } = await import('../src/state/compingGeneration'));
});

function chord(id: string, symbol: string, startBeat: number, durationBeats = 4): ChordEvent {
  return { id, startBeat, durationBeats, symbol, root: 'C', quality: 'major', notes: [0, 4, 7] };
}

function songWithChords(symbols: ReadonlyArray<string | null>, over: Parameters<typeof createEmptyProject>[0] = {}): Project {
  const base = createEmptyProject(over);
  const perBar = base.lengthBeats / base.lengthBars;
  const chordTrack = symbols.flatMap((symbol, bar) => (symbol === null ? [] : [chord(`c${bar}`, symbol, bar * perBar, perBar)]));
  return { ...base, chordTrack };
}

function request(project: Project, over: Partial<CompingRequest> = {}): CompingRequest {
  return {
    startBar: 1,
    endBar: 4,
    pattern: 'whole',
    register: 55,
    voiceLeading: true,
    ...over,
  };
}

function ok(outcome: ReturnType<typeof generateCompingInProject>) {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome;
}

function newClip(before: Project, after: Project) {
  const oldIds = new Set(before.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const clips = after.tracks.flatMap((track) => track.clips).filter((clip) => !oldIds.has(clip.id));
  expect(clips).toHaveLength(1);
  return clips[0]!;
}

function key(event: { beat: number; payload: unknown }): string {
  const payload = event.payload as SchedulePayload;
  return payload.kind === 'note'
    ? JSON.stringify([event.beat, 'note', payload.trackId, payload.preset, payload.pitch, payload.durationBeats, payload.velocity])
    : JSON.stringify([event.beat, payload]);
}

function multiset(project: Project): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of buildScheduleEvents(project)) counts.set(key(event), (counts.get(key(event)) ?? 0) + 1);
  return counts;
}

/** 独立した確認: 生成後の予定 = 生成前の予定 + 新しいクリップの音だけ、重なりなし。 */
function expectScheduleDelta(before: Project, after: Project) {
  const clip = newClip(before, after);
  const track = after.tracks.find((candidate) => candidate.id === clip.trackId)!;
  const expected = multiset(before);
  for (const note of clip.notes ?? []) {
    const k = JSON.stringify([clip.startBeat + note.startBeat, 'note', track.id, track.instrument?.preset ?? 'warmPad', note.pitch, note.durationBeats, note.velocity]);
    expected.set(k, (expected.get(k) ?? 0) + 1);
  }
  expect([...multiset(after)].sort()).toEqual([...expected].sort());
  const byPitch = new Map<number, Array<[number, number]>>();
  for (const note of clip.notes ?? []) {
    const start = Math.round((clip.startBeat + note.startBeat) * PPQ);
    const list = byPitch.get(note.pitch) ?? [];
    list.push([start, start + Math.round(note.durationBeats * PPQ)]);
    byPitch.set(note.pitch, list);
  }
  for (const list of byPitch.values()) {
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < list.length; i += 1) expect(list[i]![0]).toBeGreaterThanOrEqual(list[i - 1]![1]);
  }
}

function expectNotesSane(project: Project, notes: readonly NoteEvent[], clipStart: number, clipLength: number) {
  expect(clipStart + clipLength).toBeLessThanOrEqual(project.lengthBeats);
  for (const note of notes) {
    expect(Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127).toBe(true);
    expect(Number.isInteger(note.startBeat * PPQ)).toBe(true);
    expect(Number.isInteger(note.durationBeats * PPQ)).toBe(true);
    expect(note.startBeat).toBeGreaterThanOrEqual(0);
    expect(note.startBeat + note.durationBeats).toBeLessThanOrEqual(clipLength);
  }
}

const pcsOf = (pitches: readonly number[]) => [...new Set(pitches.map((pitch) => pitch % 12))].sort((x, y) => x - y);

/** 生成した新しいクリップの音(絶対拍の位置つき)。 */
function generatedNotes(before: Project, after: Project) {
  const clip = newClip(before, after);
  return (clip.notes ?? []).map((note) => ({ ...note, abs: clip.startBeat + note.startBeat }));
}

describe('generateCompingInProject', () => {
  it('always adds a new 伴奏 track with one clip covering the range and touches nothing else', () => {
    const project = songWithChords(['C', 'F', 'G', 'Am']);
    const out = ok(generateCompingInProject(project, request(project, { startBar: 2, endBar: 3 })));
    expect(out.project.tracks).toHaveLength(project.tracks.length + 1);
    const track = out.project.tracks.find((candidate) => candidate.id === out.trackId)!;
    expect(track.name).toBe('伴奏');
    expect(track.type).toBe('instrument');
    expect(track.instrument?.preset).toBe('p22:pianoLike');
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]).toMatchObject({ startBeat: 4, lengthBeats: 8, type: 'midi' });
    for (const old of project.tracks) {
      expect(out.project.tracks.find((candidate) => candidate.id === old.id)).toBe(old);
    }
    expect(out.project.audioRouting.outputs.some((output) => output.sourceTrackId === out.trackId)).toBe(true);
    expectScheduleDelta(project, out.project);
  });

  it('names further tracks 伴奏 2, 伴奏 3 and uses the chosen sound', () => {
    let project = songWithChords(['C', 'F', 'G', 'Am']);
    project = ok(generateCompingInProject(project, request(project))).project;
    const second = ok(generateCompingInProject(project, request(project, { preset: 'softPad' })));
    expect(second.project.tracks.find((track) => track.id === second.trackId)).toMatchObject({
      name: '伴奏 2',
      instrument: { preset: 'softPad' },
    });
    expect(generateCompingInProject(project, request(project, { preset: 'nope' })).ok).toBe(false);
  });

  it('refuses in Japanese when the track limit is reached', () => {
    const project = songWithChords(['C', 'F', 'G', 'Am']);
    const filler = project.tracks.find((track) => track.name === 'Bass')!;
    const tracks = [
      ...project.tracks,
      ...Array.from({ length: MAX_PROJECT_TRACKS - project.tracks.length }, (_, i) => ({ ...filler, id: `fill${i}`, name: `f${i}`, clips: [] })),
    ];
    const out = generateCompingInProject({ ...project, tracks }, request(project));
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.reason).toContain('上限');
  });

  it('voices the stored chord tones, not a re-parsed symbol (Cmaj stays C-E-G, Cmin7 stays C-Eb-G-Bb)', () => {
    const base = songWithChords([null, null]);
    const project: Project = {
      ...base,
      chordTrack: [
        { id: 'a', startBeat: 0, durationBeats: 4, symbol: 'Cmaj', root: 'C', quality: 'major', notes: [0, 4, 7] },
        { id: 'b', startBeat: 4, durationBeats: 4, symbol: 'Cmin7', root: 'C', quality: 'minor7', notes: [0, 3, 7, 10] },
      ],
    };
    const out = ok(generateCompingInProject(project, request(project, { endBar: 2 })));
    const notes = generatedNotes(project, out.project);
    expect(pcsOf(notes.filter((n) => n.abs < 4).map((n) => n.pitch))).toEqual([0, 4, 7]);
    expect(pcsOf(notes.filter((n) => n.abs >= 4).map((n) => n.pitch))).toEqual([0, 3, 7, 10]);
  });

  it('sounds exactly what the chord track sounds for every supported quality and root', () => {
    for (const quality of CHORD_QUALITIES) {
      for (const root of ['C', 'F#', 'Bb', 'E']) {
        const base = songWithChords([null]);
        const event: ChordEvent = { id: 'x', startBeat: 0, durationBeats: 4, symbol: `${root}?`, root, quality, notes: [] };
        const project: Project = { ...base, chordTrack: [event] };
        const out = ok(generateCompingInProject(project, request(project, { endBar: 1 })));
        const voiced = pcsOf(generatedNotes(project, out.project).map((n) => n.pitch));
        expect(voiced, `${root} ${quality}`).toEqual(pcsOf(realizeChordPitches(event)));
      }
    }
  });

  it('keeps every chord inside the register, including E then Eb in high mode with voice leading', () => {
    const base = songWithChords([null, null]);
    const project: Project = {
      ...base,
      chordTrack: [
        { id: 'a', startBeat: 0, durationBeats: 4, symbol: 'E', root: 'E', quality: 'major', notes: [4, 8, 11] },
        { id: 'b', startBeat: 4, durationBeats: 4, symbol: 'Eb', root: 'Eb', quality: 'major', notes: [3, 7, 10] },
      ],
    };
    const out = ok(generateCompingInProject(project, request(project, { endBar: 2, register: 64, voiceLeading: true })));
    for (const note of generatedNotes(project, out.project)) {
      expect(note.pitch).toBeGreaterThanOrEqual(64);
      expect(note.pitch).toBeLessThanOrEqual(88);
    }
  });

  it('keeps a seeded sweep of chord sequences within [register, register + 24]', () => {
    let seed = 77;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    for (let i = 0; i < 60; i += 1) {
      const base = songWithChords(Array.from({ length: 8 }, () => null));
      const chordTrack: ChordEvent[] = Array.from({ length: 8 }, (_, bar) => ({
        id: `c${bar}`, startBeat: bar * 4, durationBeats: 4, symbol: 'x',
        root: roots[Math.floor(rnd() * roots.length)]!, quality: CHORD_QUALITIES[Math.floor(rnd() * CHORD_QUALITIES.length)]!, notes: [],
      }));
      const project: Project = { ...base, chordTrack };
      const register = [48, 55, 64][Math.floor(rnd() * 3)]!;
      const out = ok(generateCompingInProject(project, request(project, { endBar: 8, register, voiceLeading: rnd() < 0.7, pattern: 'stab' })));
      for (const note of generatedNotes(project, out.project)) {
        expect(note.pitch).toBeGreaterThanOrEqual(register);
        expect(note.pitch).toBeLessThanOrEqual(register + 24);
      }
    }
  });

  it('voice leading takes the closest octave: B major then C major in Low mode moves 3 semitones', () => {
    const base = songWithChords([null, null]);
    const project: Project = {
      ...base,
      chordTrack: [
        { id: 'a', startBeat: 0, durationBeats: 4, symbol: 'B', root: 'B', quality: 'major', notes: [11, 3, 6] },
        { id: 'b', startBeat: 4, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] },
      ],
    };
    const out = ok(generateCompingInProject(project, request(project, { endBar: 2, register: 48, voiceLeading: true })));
    const notes = generatedNotes(project, out.project);
    expect(notes.filter((n) => n.abs < 4).map((n) => n.pitch)).toEqual([59, 63, 66]);
    expect(notes.filter((n) => n.abs >= 4).map((n) => n.pitch)).toEqual([60, 64, 67]);
  });

  it('seeded property: the chosen voicing moves no more than any other in-range candidate', () => {
    let seed = 4242;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    const move = (a: readonly number[], b: readonly number[]) => voicingCost(a, b);
    for (let i = 0; i < 80; i += 1) {
      const register = [48, 55, 64][Math.floor(rnd() * 3)]!;
      const base = songWithChords([null, null, null, null]);
      const chordTrack: ChordEvent[] = Array.from({ length: 4 }, (_, bar) => ({
        id: `c${bar}`, startBeat: bar * 4, durationBeats: 4, symbol: 'x',
        root: roots[Math.floor(rnd() * roots.length)]!, quality: CHORD_QUALITIES[Math.floor(rnd() * CHORD_QUALITIES.length)]!, notes: [],
      }));
      const project: Project = { ...base, chordTrack };
      const out = ok(generateCompingInProject(project, request(project, { endBar: 4, register, voiceLeading: true })));
      const notes = generatedNotes(project, out.project);
      const voiced = chordTrack.map((_, bar) => notes.filter((n) => n.abs === bar * 4).map((n) => n.pitch).sort((a, b) => a - b));
      for (let bar = 1; bar < 4; bar += 1) {
        const pcs = [...new Set(voiced[bar]!.map((pitch) => pitch % 12))];
        const chosen = move(voiced[bar - 1]!, voiced[bar]!);
        // 総当たり: 構成音の全転回形 × 範囲内の全オクターブ。
        for (let low = register; low <= register + 24; low += 1) {
          if (!pcs.includes(low % 12)) continue;
          const lowPc = low % 12;
          const above = pcs.filter((pc) => pc !== lowPc).sort((a, b) => ((a - lowPc + 12) % 12) - ((b - lowPc + 12) % 12));
          const candidate = [low];
          for (const pc of above) candidate.push(candidate[candidate.length - 1]! + (((pc - candidate[candidate.length - 1]! % 12) + 12) % 12 || 12));
          if (candidate[candidate.length - 1]! > register + 24) continue;
          expect(chosen, `bar ${bar} candidate ${candidate}`).toBeLessThanOrEqual(move(voiced[bar - 1]!, candidate));
        }
      }
    }
  });

  it('applies the pattern per bar: a 2-bar chord with Whole is two bar-bounded notes and bar 2 is not empty', () => {
    const base = songWithChords([null, null, null, null]);
    const project: Project = { ...base, chordTrack: [chord('c', 'C', 0, 8)] };
    const out = ok(generateCompingInProject(project, request(project, { endBar: 3 })));
    const notes = generatedNotes(project, out.project);
    expect(notes).toHaveLength(6);
    for (const note of notes) expect(note.durationBeats).toBe(4);
    expect([...new Set(notes.map((note) => note.abs))]).toEqual([0, 4]);
    expect(out.emptyBars).toEqual([3]);
  });

  it('follows the meter map: bars in 3/4 and 6/8 bound every note', () => {
    for (const [timeSignature, perBar] of [[[3, 4], 3], [[6, 8], 3]] as const) {
      const base = createEmptyProject({ timeSignature: [timeSignature[0], timeSignature[1]], lengthBars: 6 });
      const project: Project = { ...base, chordTrack: [chord('c', 'Am', 1, 2 * perBar + 1)] };
      for (const pattern of ['whole', 'eighths', 'arpUp', 'stab'] as const) {
        const out = ok(generateCompingInProject(project, request(project, { endBar: 5, pattern })));
        for (const note of generatedNotes(project, out.project)) {
          const bar = Math.floor(note.abs / perBar);
          expect(note.abs + note.durationBeats, `${timeSignature} ${pattern}`).toBeLessThanOrEqual((bar + 1) * perBar);
          expect(note.abs).toBeGreaterThanOrEqual(1);
          expect(note.abs + note.durationBeats).toBeLessThanOrEqual(2 * perBar + 2);
        }
        expect(out.emptyBars).toEqual([4, 5]);
      }
    }
  });

  it('counts a bar as empty only when no chord sounds anywhere in it', () => {
    const base = songWithChords([null, null, null, null]);
    const project: Project = { ...base, chordTrack: [chord('c', 'C', 2, 1), { ...chord('d', 'zzz', 8, 4), quality: 'bogus', notes: [] }] };
    const out = ok(generateCompingInProject(project, request(project)));
    expect(out.emptyBars).toEqual([2, 3, 4]);
  });

  it('leaves chordless bars empty and says so', () => {
    const project = songWithChords(['C', null, 'G', 'zzz']);
    const out = ok(generateCompingInProject(project, request(project)));
    expect(out.emptyBars).toEqual([2]);
    expect(out.message).toContain('2 小節目');
  });

  it('refuses when no chord is in the range', () => {
    const project = songWithChords([null, null, null, null]);
    expect(generateCompingInProject(project, request(project)).ok).toBe(false);
  });

  it('refuses bad ranges and bad inputs without throwing', () => {
    const project = songWithChords(['C', 'F', 'G', 'Am']);
    const bad: Array<Partial<CompingRequest>> = [
      { startBar: 0 },
      { startBar: 3, endBar: 2 },
      { startBar: 1.5 },
      { startBar: 99, endBar: 100 },
      { startBar: Number.NaN },
      { pattern: 'toString' as never },
      { pattern: { toString: null } as never },
      { preset: { toString: null } as never },
      { register: 128 },
      { register: -1 },
      { register: 60.5 },
      { register: 127 },
    ];
    for (const over of bad) expect(generateCompingInProject(project, request(project, over)).ok).toBe(false);
    expect(generateCompingInProject(project, null as never).ok).toBe(false);
  });

  it('clips the range to the song end', () => {
    const project = songWithChords(['C', 'F', 'G', 'Am', 'C', 'F', 'G', 'Am']);
    const out = ok(generateCompingInProject(project, request(project, { startBar: 7, endBar: 9 })));
    const clip = newClip(project, out.project);
    expect(clip.startBeat + clip.lengthBeats).toBe(project.lengthBeats);
  });

  it('refuses when the note count would exceed the caps', () => {
    const base = createEmptyProject({ timeSignature: [32, 4], lengthBars: 256 });
    const project: Project = {
      ...base,
      chordTrack: Array.from({ length: 256 }, (_, bar) => ({ ...chord(`c${bar}`, 'C', bar * 32, 32), quality: 'dominant7' })),
    };
    expect(generateCompingInProject(project, request(project, { startBar: 1, endBar: 256, pattern: 'eighths' })).ok).toBe(false);
  });

  it('counts bars with projectBarCount', () => {
    expect(projectBarCount(createEmptyProject({ lengthBars: 8 }))).toBe(8);
    expect(projectBarCount(createEmptyProject({ lengthBars: 5, timeSignature: [3, 4] }))).toBe(5);
  });
});

describe('seeded fuzz', () => {
  it('keeps every invariant for random charts, patterns, ranges and registers', () => {
    let seed = 20261130;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
    const symbols = ['C', 'Dm7', 'G7', 'Am', 'Fmaj7', 'Bdim', 'C/E', 'Esus4', 'F#m7b5', 'Bb13', 'C/D', 'zzz', 'Cadd9'];
    const signatures: Array<[number, number]> = [[4, 4], [3, 4], [6, 8], [5, 4], [7, 8]];
    let created = 0;
    let refused = 0;
    for (let i = 0; i < 120; i += 1) {
      const lengthBars = 2 + Math.floor(rnd() * 8);
      const project = songWithChords(
        Array.from({ length: lengthBars }, () => (rnd() < 0.2 ? null : pick(symbols))),
        { lengthBars, timeSignature: pick(signatures) },
      );
      const startBar = 1 + Math.floor(rnd() * lengthBars);
      const out = generateCompingInProject(project, {
        startBar,
        endBar: startBar + Math.floor(rnd() * (lengthBars - startBar + 2)),
        pattern: pick(COMPING_PATTERN_OPTIONS).value,
        register: Math.floor(rnd() * 128),
        voiceLeading: rnd() < 0.5,
      });
      if (!out.ok) {
        refused += 1;
        expect(out.reason.length).toBeGreaterThan(0);
        continue;
      }
      created += 1;
      const clip = newClip(project, out.project);
      expectNotesSane(project, clip.notes!, clip.startBeat, clip.lengthBeats);
      expect(Number.isInteger(clip.startBeat * PPQ)).toBe(true);
      expectScheduleDelta(project, out.project);
    }
    expect(created).toBeGreaterThan(30);
    expect(created + refused).toBe(120);
  });
});

describe('generateCompingClip (store)', () => {
  beforeEach(() => {
    const project = songWithChords(['C', 'F', 'G', 'Am']);
    useStore.setState({
      project: { ...project, id: useStore.getState().project.id },
      past: [],
      future: [],
      audioRecordingOperationId: null,
      projectOperationBusy: false,
    });
  });

  it('is exactly one undo step', () => {
    const before = useStore.getState().project;
    const result = generateCompingClip(request(before, { pattern: 'eighths' }));
    expect(result.ok ? '' : result.reason).toBe('');
    expect(useStore.getState().past.length).toBe(1);
    expect(useStore.getState().project.tracks).toHaveLength(before.tracks.length + 1);
    useStore.getState().undo();
    expect(useStore.getState().project.tracks).toEqual(before.tracks);
  });

  it('is refused while a fader transaction is open, and the undo history stays clean', () => {
    const token = {};
    const store = useStore.getState();
    expect(store.beginProjectTransaction(token, 1)).toBe(true);
    const bass = useStore.getState().project.tracks.find((t) => t.name === 'Bass')!;
    useStore.getState().applyProjectChange((project) => ({
      ...project,
      tracks: project.tracks.map((track) => (track.id === bass.id ? { ...track, volume: 0.5 } : track)),
    }));
    const during = useStore.getState().project;
    const result = generateCompingClip(request(during));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toBe('ほかの操作が終わってから試してください。');
    expect(useStore.getState().project).toBe(during);
    expect(useStore.getState().commitProjectTransaction(token)).toBe(true);
    expect(useStore.getState().past.length).toBe(1);
  });

  it('is refused while recording, without touching the song or history', () => {
    const before = useStore.getState().project;
    useStore.setState({ audioRecordingOperationId: 7 });
    const result = generateCompingClip(request(before));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('録音中');
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past.length).toBe(0);
  });

  it('a refusal changes nothing', () => {
    const before = useStore.getState().project;
    const result = generateCompingClip(request(before, { startBar: 9, endBar: 9 }));
    expect(result.ok).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past.length).toBe(0);
  });
});
