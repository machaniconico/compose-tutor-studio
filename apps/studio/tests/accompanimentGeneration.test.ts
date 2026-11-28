import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_TRACKS,
  CHORD_QUALITIES,
  PPQ,
  addTimeSignatureMapEvent,
  chordPitchClasses,
  encodeProjectJson,
  resolveDrumOccurrence,
  createEmptyProject,
  realizeChordPitches,
  type ChordEvent,
  type Project,
} from '@cts/project-model';
import { buildScheduleEvents } from '../src/audio/events';
import { installLocalStorage } from './localStorageStub';
import {
  ACCOMPANIMENT_MOODS,
  BASS_HIGH,
  BASS_LOW,
  accompanimentScheduleProblem,
  accompanimentSeed,
  generateAccompanimentInProject,
  type AccompanimentMood,
} from '../src/state/accompanimentGeneration';

let useStore: typeof import('../src/state/store')['useStore'];
let generateAccompanimentSet: typeof import('../src/state/accompanimentGeneration')['generateAccompanimentSet'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ generateAccompanimentSet } = await import('../src/state/accompanimentGeneration'));
});

const CHORDS: Record<string, { root: string; quality: string; notes: number[] }> = {
  C: { root: 'C', quality: 'major', notes: [0, 4, 7] },
  F: { root: 'F', quality: 'major', notes: [5, 9, 0] },
  G: { root: 'G', quality: 'major', notes: [7, 11, 2] },
  Am: { root: 'A', quality: 'minor', notes: [9, 0, 4] },
  Bb: { root: 'A#', quality: 'major', notes: [10, 2, 5] },
  B: { root: 'B', quality: 'major', notes: [11, 3, 6] },
};

function songWithChords(symbols: readonly string[], over: Parameters<typeof createEmptyProject>[0] = {}): Project {
  const base = createEmptyProject(over);
  const perBar = base.lengthBeats / base.lengthBars;
  const chordTrack: ChordEvent[] = symbols.map((symbol, bar) => ({
    id: `c${bar}`, startBeat: bar * perBar, durationBeats: perBar, symbol, ...CHORDS[symbol]!,
  }));
  return { ...base, chordTrack };
}

function ok(outcome: ReturnType<typeof generateAccompanimentInProject>) {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome;
}

function strip(project: Project, out: Extract<ReturnType<typeof generateAccompanimentInProject>, { ok: true }>) {
  const byId = (id: string) => project.tracks.find((track) => track.id === id)!;
  const clip = (id: string) => byId(id).clips[0]!;
  const c = clip(out.trackIds.chords);
  const b = clip(out.trackIds.bass);
  const d = clip(out.trackIds.drums);
  return {
    chords: (c.notes ?? []).map((n) => [n.startBeat, n.durationBeats, n.pitch, n.velocity]),
    bass: (b.notes ?? []).map((n) => [n.startBeat, n.durationBeats, n.pitch, n.velocity]),
    drums: (d.drumEvents ?? []).map((e) => [e.stepIndex, e.lane, e.velocity]),
    spans: [c, b, d].map((x) => [x.startBeat, x.lengthBeats]),
  };
}

const pcsOf = (pitches: readonly number[]) => [...new Set(pitches.map((pitch) => pitch % 12))];

describe('generateAccompanimentInProject', () => {
  it('adds three new tracks, touches nothing else, and covers the chord lane bars', () => {
    const project = songWithChords(['C', 'F', 'G', 'Am']);
    const out = ok(generateAccompanimentInProject(project, { mood: 'straight' }));
    expect(out.project.tracks).toHaveLength(project.tracks.length + 3);
    for (const old of project.tracks) {
      expect(out.project.tracks.find((track) => track.id === old.id)).toBe(old);
    }
    const names = Object.values(out.trackIds).map((id) => out.project.tracks.find((t) => t.id === id)!.name);
    expect(names).toEqual(['伴奏', 'ベース', 'ドラム']);
    expect([out.startBar, out.endBar]).toEqual([1, 4]);
    for (const id of Object.values(out.trackIds)) {
      const track = out.project.tracks.find((t) => t.id === id)!;
      expect(track.clips).toHaveLength(1);
      expect(track.clips[0]).toMatchObject({ startBeat: 0, lengthBeats: 16, loop: false });
      expect(out.project.audioRouting.outputs.some((o) => o.sourceTrackId === id)).toBe(true);
    }
    const drum = out.project.tracks.find((t) => t.id === out.trackIds.drums)!.clips[0]!;
    expect(drum.type).toBe('drum');
    expect(drum.stepsPerBar).toBe(16);
    expect(drum.drumGroove).toBeUndefined(); // 曲のスウィングを引き継ぐ
    expect(out.project.swing).toBe(project.swing);
    expect(out.project.hiHatChoke).toBe(project.hiHatChoke);
  });

  it('uses only the bars that carry chords and never exceeds the project length', () => {
    const base = songWithChords(['C', 'F', 'G', 'Am']);
    const project: Project = { ...base, chordTrack: base.chordTrack.slice(1, 3) };
    const out = ok(generateAccompanimentInProject(project, { mood: 'bouncy' }));
    expect([out.startBar, out.endBar]).toEqual([2, 3]);
    for (const id of Object.values(out.trackIds)) {
      const clip = out.project.tracks.find((t) => t.id === id)!.clips[0]!;
      expect([clip.startBeat, clip.lengthBeats]).toEqual([4, 8]);
      expect(clip.startBeat + clip.lengthBeats).toBeLessThanOrEqual(project.lengthBeats);
    }
    const tail: Project = { ...base, chordTrack: [{ ...base.chordTrack[3]!, startBeat: 28, durationBeats: 4 }] };
    const out2 = ok(generateAccompanimentInProject(tail, { mood: 'soft' }));
    const clip = out2.project.tracks.find((t) => t.id === out2.trackIds.bass)!.clips[0]!;
    expect(clip.startBeat + clip.lengthBeats).toBe(tail.lengthBeats);
  });

  it('is deterministic: same input gives the same notes, matching the golden', () => {
    const project = songWithChords(['C', 'F', 'G', 'Am']);
    const first = ok(generateAccompanimentInProject(project, { mood: 'straight' }));
    const second = ok(generateAccompanimentInProject(project, { mood: 'straight' }));
    expect(strip(second.project, second)).toEqual(strip(first.project, first));
    expect(accompanimentSeed(project, 'straight')).toBe(accompanimentSeed(songWithChords(['C', 'F', 'G', 'Am']), 'straight'));
    expect(accompanimentSeed(project, 'soft')).not.toBe(accompanimentSeed(project, 'straight'));
    const got = strip(first.project, first);
    expect({
      c: got.chords.map(([start, length, pitch]) => [start, length, pitch]),
      b: got.bass,
      d: got.drums,
    }).toEqual(GOLDEN);
  });

  it('keeps bass roots/fifths in E1-G3 on the downbeat and every part on chord tones', () => {
    for (const mood of Object.keys(ACCOMPANIMENT_MOODS) as AccompanimentMood[]) {
      const project = songWithChords(['C', 'F', 'G', 'Am', 'Bb', 'B', 'C', 'G']);
      const out = ok(generateAccompanimentInProject(project, { mood }));
      const bass = out.project.tracks.find((t) => t.id === out.trackIds.bass)!.clips[0]!.notes!;
      const comp = out.project.tracks.find((t) => t.id === out.trackIds.chords)!.clips[0]!.notes!;
      for (const chord of project.chordTrack) {
        const tones = realizeChordPitches(chord).map((pitch) => ((pitch % 12) + 12) % 12);
        const inChord = (n: { startBeat: number }) => n.startBeat >= chord.startBeat && n.startBeat < chord.startBeat + chord.durationBeats;
        const rootPc = tones[0]!;
        const b = bass.filter(inChord);
        expect(b.length).toBeGreaterThan(0);
        expect(b[0]!.startBeat).toBe(chord.startBeat); // ルートは小節の頭
        expect(b[0]!.pitch % 12).toBe(rootPc);
        for (const n of b) {
          expect(n.pitch).toBeGreaterThanOrEqual(BASS_LOW);
          expect(n.pitch).toBeLessThanOrEqual(BASS_HIGH);
          expect([rootPc, (rootPc + 7) % 12]).toContain(n.pitch % 12);
        }
        const c = comp.filter(inChord);
        expect(c.length).toBeGreaterThan(0);
        for (const n of c) {
          expect(tones).toContain(n.pitch % 12);
          expect(n.pitch).toBeGreaterThanOrEqual(55);
          expect(n.pitch).toBeLessThanOrEqual(79);
        }
        expect(pcsOf(c.map((n) => n.pitch)).length).toBe(new Set(tones).size);
      }
    }
  });

  it('keeps every part whole-tick, inside its clip, and the schedule adds exactly the new notes', () => {
    for (const mood of Object.keys(ACCOMPANIMENT_MOODS) as AccompanimentMood[]) {
      const project = songWithChords(['C', 'F', 'G', 'Am'], { timeSignature: [3, 4] });
      const before = buildScheduleEvents(project).length;
      const out = ok(generateAccompanimentInProject(project, { mood }));
      const parts = Object.values(out.trackIds).map((id) => out.project.tracks.find((t) => t.id === id)!.clips[0]!);
      const added = parts.reduce((sum, clip) => sum + (clip.notes?.length ?? clip.drumEvents?.length ?? 0), 0);
      const events = buildScheduleEvents(out.project);
      expect(events.length - before).toBe(added);
      for (const clip of parts) {
        expect(Number.isInteger(clip.startBeat * PPQ) && Number.isInteger(clip.lengthBeats * PPQ)).toBe(true);
        expect(clip.startBeat + clip.lengthBeats).toBeLessThanOrEqual(project.lengthBeats);
        for (const n of clip.notes ?? []) {
          expect(Number.isInteger(n.startBeat * PPQ) && Number.isInteger(n.durationBeats * PPQ)).toBe(true);
          expect(n.startBeat).toBeGreaterThanOrEqual(0);
          expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(clip.lengthBeats);
        }
      }
      expect(parts[2]!.stepsPerBar).toBe(12);
    }
  });

  it('refuses without chords, at the track limit, with a mood outside the list, and across a meter change', () => {
    const empty = { ...songWithChords([]) };
    const noChords = generateAccompanimentInProject(empty, { mood: 'straight' });
    expect(noChords.ok ? '' : noChords.reason).toContain('コードがない');
    const project = songWithChords(['C', 'F', 'G', 'Am']);
    const filler = project.tracks.filter((t) => t.type === 'instrument').slice(0, 1)[0]!;
    const crowded: Project = {
      ...project,
      tracks: [
        ...project.tracks,
        ...Array.from({ length: MAX_PROJECT_TRACKS - project.tracks.length - 2 }, (_, i) => ({ ...filler, id: `x${i}` })),
      ],
    };
    const full = generateAccompanimentInProject(crowded, { mood: 'straight' });
    expect(full.ok ? '' : full.reason).toContain('上限');
    for (const mood of ['nope', '__proto__', 'toString', null, undefined, { toString: null }]) {
      const out = generateAccompanimentInProject(project, { mood: mood as never });
      expect(out.ok).toBe(false);
    }
    expect(generateAccompanimentInProject(project, null as never).ok).toBe(false);
    const added = addTimeSignatureMapEvent(project, { beat: 8, numerator: 3, denominator: 4 });
    if (!added.ok) throw new Error('fixture');
    const changed = generateAccompanimentInProject(added.project, { mood: 'straight' });
    expect(changed.ok ? '' : changed.reason).toContain('拍子');
  });

  it('survives a seeded fuzz of chord lanes with a sane schedule and no throw', () => {
    let state = 20260528;
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const symbols = Object.keys(CHORDS);
    const moods = Object.keys(ACCOMPANIMENT_MOODS) as AccompanimentMood[];
    for (let round = 0; round < 60; round += 1) {
      const base = createEmptyProject({ lengthBars: 4 + Math.floor(rand() * 12) });
      const chordTrack: ChordEvent[] = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => {
        const symbol = symbols[Math.floor(rand() * symbols.length)]!;
        return {
          id: `f${i}`, symbol, ...CHORDS[symbol]!,
          startBeat: Math.floor(rand() * base.lengthBeats * 2) / 2,
          durationBeats: (1 + Math.floor(rand() * 16)) / 2,
        };
      });
      const project: Project = { ...base, chordTrack };
      const out = generateAccompanimentInProject(project, { mood: moods[Math.floor(rand() * moods.length)]! });
      if (!out.ok) {
        expect(out.reason.length).toBeGreaterThan(0);
        continue;
      }
      expect(buildScheduleEvents(out.project).length).toBeGreaterThan(0);
      for (const id of Object.values(out.trackIds)) {
        const clip = out.project.tracks.find((t) => t.id === id)!.clips[0]!;
        expect(clip.startBeat + clip.lengthBeats).toBeLessThanOrEqual(project.lengthBeats);
      }
    }
  });
});

function chordAt(id: string, quality: string, root: string, startBeat: number, durationBeats: number): ChordEvent {
  return { id, startBeat, durationBeats, symbol: `${root}${quality}`, root, quality, notes: chordPitchClasses(root as never, quality) };
}
function withChords(chordTrack: ChordEvent[], over: Partial<Project> = {}): Project {
  return { ...createEmptyProject(), ...over, chordTrack };
}
const partClips = (out: Extract<ReturnType<typeof generateAccompanimentInProject>, { ok: true }>) => ({
  chords: out.project.tracks.find((t) => t.id === out.trackIds.chords)!.clips[0]!,
  bass: out.project.tracks.find((t) => t.id === out.trackIds.bass)!.clips[0]!,
  drums: out.project.tracks.find((t) => t.id === out.trackIds.drums)!.clips[0]!,
});

describe('review fixes (P3A Codex review)', () => {
  it('1: the bass fifth is the chord\'s actual fifth for every supported quality, root only without one', () => {
    for (const quality of CHORD_QUALITIES) {
      for (const root of ['C', 'B', 'F#']) {
        const project = withChords([chordAt('c0', quality, root, 0, 4)]);
        const chord = project.chordTrack[0]!;
        const rootPc = chord.notes[0]!;
        const fifthInterval = chord.notes.map((n) => (n - rootPc + 12) % 12).find((i) => i === 7) ?? chord.notes.map((n) => (n - rootPc + 12) % 12).find((i) => i === 6 || i === 8);
        const bass = partClips(ok(generateAccompanimentInProject(project, { mood: 'straight' }))).bass.notes!;
        expect(bass[0]!.pitch % 12).toBe(rootPc);
        expect(bass.length).toBe(2);
        expect(bass[1]!.pitch % 12).toBe((rootPc + fifthInterval!) % 12);
        expect(bass.every((n) => n.pitch >= BASS_LOW && n.pitch <= BASS_HIGH)).toBe(true);
      }
    }
    const noFifth: ChordEvent = { ...chordAt('c0', 'major', 'C', 0, 4), notes: [0, 4] };
    const bass = partClips(ok(generateAccompanimentInProject(withChords([noFifth]), { mood: 'straight' }))).bass.notes!;
    expect(bass.map((n) => n.pitch % 12)).toEqual([0]);
  });

  it('2: every bar downbeat inside a long chord plays the root and the pattern restarts at chord changes', () => {
    const bass = partClips(ok(generateAccompanimentInProject(withChords([chordAt('c0', 'major', 'C', 0, 8)]), { mood: 'straight' }))).bass.notes!;
    expect(bass.filter((n) => n.startBeat % 4 === 0).map((n) => [n.startBeat, n.pitch % 12])).toEqual([[0, 0], [4, 0]]);
    const mid = partClips(ok(generateAccompanimentInProject(withChords([
      chordAt('c0', 'major', 'C', 0, 3), chordAt('c1', 'major', 'F', 3, 5),
    ]), { mood: 'straight' }))).bass.notes!;
    expect(mid.find((n) => n.startBeat === 3)!.pitch % 12).toBe(5);
    expect(mid.find((n) => n.startBeat === 4)!.pitch % 12).toBe(5);
  });

  it('3: a chord ending a hair past a bar line keeps the whole next bar in the range', () => {
    const project = withChords([{ ...chordAt('c0', 'major', 'C', 0, 4 + 1 / 960) }]);
    const out = ok(generateAccompanimentInProject(project, { mood: 'straight' }));
    expect(out.endBar).toBe(2);
    expect(partClips(out).drums.lengthBeats).toBe(8);
  });

  it('4: a chord past the project end is refused first, with the exact explanation', () => {
    const base = createEmptyProject();
    const past = chordAt('c0', 'major', 'C', base.lengthBeats - 2, 4);
    for (const project of [withChords([past]), withChords([past], { swing: 50 })]) {
      const out = generateAccompanimentInProject(project, { mood: 'nope' as never });
      expect(out.ok ? '' : out.reason).toBe('曲の長さより後ろにコードがあります。曲の長さを延ばすか、コードを短くしてください。');
    }
  });

  it('5: a swung project with a mid-bar chord change is accepted and sounds as scheduled', () => {
    for (const swing of [0, 50, 60]) {
      const project = withChords([
        chordAt('c0', 'major', 'C', 0, 1.5), chordAt('c1', 'major', 'F', 1.5, 2.5), chordAt('c2', 'minor', 'A', 4, 4),
      ], { swing });
      const out = ok(generateAccompanimentInProject(project, { mood: 'driving' }));
      expect(accompanimentScheduleProblem(project, out.project, out.expected)).toBeNull();
    }
  });

  it('6: an interval with zero drum hits is valid', () => {
    const project = withChords([chordAt('c0', 'major', 'C', 0.1, 0.1)]);
    const out = ok(generateAccompanimentInProject(project, { mood: 'straight' }));
    expect(partClips(out).drums.drumEvents).toHaveLength(0);
  });

  it('7: the drum post-check rejects a wrong lane, tick or velocity', () => {
    const project = withChords([chordAt('c0', 'major', 'C', 0, 4)], { swing: 30 });
    const out = ok(generateAccompanimentInProject(project, { mood: 'straight' }));
    expect(accompanimentScheduleProblem(project, out.project, out.expected)).toBeNull();
    const tamper = (change: (e: NonNullable<ReturnType<typeof partClips>['drums']['drumEvents']>[number]) => void) => ({
      ...out.project,
      tracks: out.project.tracks.map((t) => t.id !== out.trackIds.drums ? t : {
        ...t,
        clips: t.clips.map((c) => ({ ...c, drumEvents: c.drumEvents!.map((e, i) => {
          const copy = { ...e };
          if (i === 0) change(copy);
          return copy;
        }) })),
      }),
    });
    expect(accompanimentScheduleProblem(project, tamper((e) => { e.lane = e.lane === 'kick' ? 'snare' : 'kick'; }), out.expected)).not.toBeNull();
    expect(accompanimentScheduleProblem(project, tamper((e) => { e.stepIndex += 1; }), out.expected)).not.toBeNull();
    expect(accompanimentScheduleProblem(project, tamper((e) => { e.velocity += 1; }), out.expected)).not.toBeNull();
  });

  it('8: identical projects give byte-identical JSON and an identical drum schedule, with unique ids', () => {
    const base = createEmptyProject();
    const make = () => ({ ...base, chordTrack: [chordAt('c0', 'major', 'C', 0, 4), chordAt('c1', 'minor', 'A', 4, 4)] });
    const a = ok(generateAccompanimentInProject(make(), { mood: 'bouncy' }));
    const b = ok(generateAccompanimentInProject(make(), { mood: 'bouncy' }));
    const ja = encodeProjectJson(a.project);
    const jb = encodeProjectJson(b.project);
    expect(ja.ok && jb.ok).toBe(true);
    expect(ja.ok ? ja.json : '').toBe(jb.ok ? jb.json : 'x');
    const render = (project: Project) => JSON.stringify(buildScheduleEvents(project).map((event) => resolveDrumOccurrence(event)));
    expect(render(a.project)).toBe(render(b.project));
    expect(render(a.project)).toContain('voiceSeed');
    // 既存の id とぶつかっても、重複せず決定的に別の id になる。
    const taken = partClips(a).bass.notes![0]!.id;
    const crowded = make();
    crowded.chordTrack[0] = { ...crowded.chordTrack[0]!, id: taken };
    const c = ok(generateAccompanimentInProject(crowded, { mood: 'bouncy' }));
    const ids: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          if (key === 'id' && typeof inner === 'string') ids.push(inner);
          else walk(inner);
        }
      }
    };
    walk(c.project);
    expect(new Set(ids).size).toBe(ids.length);
    const d = ok(generateAccompanimentInProject(crowded, { mood: 'bouncy' }));
    expect(JSON.stringify(encodeProjectJson(d.project))).toBe(JSON.stringify(encodeProjectJson(c.project)));
  });
});

describe('generateAccompanimentSet (store)', () => {
  beforeEach(() => {
    useStore.setState({
      project: { ...songWithChords(['C', 'F', 'G', 'Am']), id: useStore.getState().project.id },
      past: [],
      future: [],
      audioRecordingOperationId: null,
      projectOperationBusy: false,
    });
  });

  it('applies all three tracks as one undo step and redoes them', () => {
    const before = useStore.getState().project;
    const pastBefore = useStore.getState().past.length;
    const result = generateAccompanimentSet({ mood: 'driving' });
    expect(result.ok).toBe(true);
    expect(useStore.getState().project.tracks).toHaveLength(before.tracks.length + 3);
    expect(useStore.getState().past.length).toBe(pastBefore + 1);
    useStore.getState().undo();
    expect(useStore.getState().project.tracks).toHaveLength(before.tracks.length);
    useStore.getState().redo();
    expect(useStore.getState().project.tracks).toHaveLength(before.tracks.length + 3);
  });

  it('refuses while recording, while busy, or in a transaction, leaving the project untouched', () => {
    const before = useStore.getState().project;
    useStore.setState({ audioRecordingOperationId: 1 });
    const recording = generateAccompanimentSet({ mood: 'straight' });
    expect(recording.ok ? '' : recording.reason).toContain('録音中');
    useStore.setState({ audioRecordingOperationId: null, projectOperationBusy: true });
    expect(generateAccompanimentSet({ mood: 'straight' }).ok).toBe(false);
    useStore.setState({ projectOperationBusy: false });
    const token = {};
    expect(useStore.getState().beginProjectTransaction(token)).toBe(true);
    expect(generateAccompanimentSet({ mood: 'straight' }).ok).toBe(false);
    useStore.getState().cancelProjectTransaction(token);
    expect(useStore.getState().project).toBe(before);
  });
});

const GOLDEN = {"c":[[0,0.25,60],[0,0.25,64],[0,0.25,67],[1,0.25,60],[1,0.25,64],[1,0.25,67],[2,0.25,60],[2,0.25,64],[2,0.25,67],[3,0.25,60],[3,0.25,64],[3,0.25,67],[4,0.25,60],[4,0.25,65],[4,0.25,69],[5,0.25,60],[5,0.25,65],[5,0.25,69],[6,0.25,60],[6,0.25,65],[6,0.25,69],[7,0.25,60],[7,0.25,65],[7,0.25,69],[8,0.25,59],[8,0.25,62],[8,0.25,67],[9,0.25,59],[9,0.25,62],[9,0.25,67],[10,0.25,59],[10,0.25,62],[10,0.25,67],[11,0.25,59],[11,0.25,62],[11,0.25,67],[12,0.25,60],[12,0.25,64],[12,0.25,69],[13,0.25,60],[13,0.25,64],[13,0.25,69],[14,0.25,60],[14,0.25,64],[14,0.25,69],[15,0.25,60],[15,0.25,64],[15,0.25,69]],"b":[[0,2,36,92],[2,2,43,80],[4,2,41,92],[6,2,48,80],[8,2,43,92],[10,2,50,80],[12,2,45,92],[14,2,52,80]],"d":[[0,"kick",86],[0,"closedHat",84],[2,"closedHat",80],[4,"snare",82],[4,"closedHat",84],[6,"closedHat",76],[8,"kick",80],[8,"closedHat",82],[10,"closedHat",82],[12,"snare",84],[12,"closedHat",84],[14,"closedHat",80],[16,"kick",82],[16,"closedHat",78],[18,"closedHat",82],[20,"snare",82],[20,"closedHat",76],[22,"closedHat",82],[24,"kick",82],[24,"closedHat",84],[26,"closedHat",82],[28,"snare",84],[28,"closedHat",82],[30,"closedHat",76],[32,"kick",86],[32,"closedHat",76],[34,"closedHat",82],[36,"snare",78],[36,"closedHat",80],[38,"closedHat",78],[40,"kick",84],[40,"closedHat",86],[42,"closedHat",80],[44,"snare",80],[44,"closedHat",76],[46,"closedHat",86],[48,"kick",80],[48,"closedHat",84],[50,"closedHat",76],[52,"snare",82],[52,"closedHat",86],[54,"closedHat",86],[56,"kick",80],[56,"closedHat",86],[58,"closedHat",78],[60,"snare",76],[60,"closedHat",84],[62,"closedHat",78]]};
