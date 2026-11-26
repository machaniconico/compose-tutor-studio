import { describe, expect, it } from 'vitest';
import {
  beatTick,
  soundingEvents,
  TRANSPOSE_FAILURE_MESSAGES,
  transposeProject,
  validateProject,
  type ChordEvent,
  type MusicalKey,
  type Project,
  type ScaleName,
} from '../src/index';
// Key names are read by theory-engine; project-model takes the reader as an argument (no package dependency).
import { keyShiftSemitones, transposeKeyName } from '../../theory-engine/src/index';
import { drumClip, generateProject, makeProject, makeTrack, midiClip, mulberry32 } from './acceptance/helpers';

const clock = () => new Date('2026-11-27T00:00:00.000Z');
const keyNames = { shift: keyShiftSemitones, name: transposeKeyName };

function song(): Project {
  return makeProject([
    makeTrack('inst', 'instrument', [
      midiClip('src', 'inst', 0, 4, [[0, 1, 60], [1, 1, 64], [2, 2, 67]]),
      // リンク(中身を持たない)とループ。リンクは参照先と一緒に 1 回だけ動く。
      { id: 'link', trackId: 'inst', type: 'midi', startBeat: 4, lengthBeats: 8, loop: true, contentLengthBeats: 4, aliasOf: 'src' },
    ]),
    { ...makeTrack('muted', 'instrument', [midiClip('m1', 'muted', 0, 4, [[0, 1, 48]])]), mute: true },
    makeTrack('drums', 'drum', [drumClip('d1', 'drums', 0, 4, [[0, 'kick'], [4, 'snare']])]),
  ]);
}

const notesOf = (p: Project, trackId: string) =>
  p.tracks.find((t) => t.id === trackId)!.clips.flatMap((c) => c.notes ?? []).map((n) => n.pitch);

describe('transposeProject', () => {
  it('+2 で楽器トラックのノートがすべて +2 になり、ドラムトラックのイベントは変わらない', () => {
    const before = song();
    const result = transposeProject(before, 2, { key: 'D', keyNames }, clock);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(notesOf(result.project, 'inst')).toEqual([62, 66, 69]);
    // ミュート中のトラックも動かす(ミュートを外したときに元のキーで鳴らないように)。
    expect(notesOf(result.project, 'muted')).toEqual([50]);
    expect(result.project.tracks.find((t) => t.id === 'drums')).toEqual(before.tracks.find((t) => t.id === 'drums'));
    expect(result.project.key).toBe('D');
    expect(result.project.updatedAt).toBe('2026-11-27T00:00:00.000Z');
    // リンクとループの設定は変わらず、中身を持たないまま。
    const link = result.project.tracks[0]!.clips[1]!;
    expect(link).toEqual(before.tracks[0]!.clips[1]);
    // 入力は書き換えない。
    expect(notesOf(before, 'inst')).toEqual([60, 64, 67]);
  });

  it('リンククリップは参照先だけを 1 回動かすので、リンクの発音も +2(二重に動かない)', () => {
    const before = song();
    const result = transposeProject(before, 2, { key: 'D', keyNames }, clock);
    if (!result.ok) throw new Error(result.reason);
    const pitches = (p: Project) =>
      soundingEvents(p, { includeMuted: true }).events.filter((e) => e.clipId === 'link').map((e) => (e.kind === 'note' ? e.pitch : -1));
    expect(pitches(result.project)).toEqual(pitches(before).map((p) => p + 2));
  });

  it('127 を超えるノートが出る場合は全体を拒否し、project は同じオブジェクトのまま', () => {
    const before = makeProject([makeTrack('inst', 'instrument', [midiClip('c', 'inst', 0, 4, [[0, 1, 60], [1, 1, 126]])])]);
    const result = transposeProject(before, 2, { key: 'D', keyNames }, clock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.project).toBe(before);
    expect(result.reason).toBe(TRANSPOSE_FAILURE_MESSAGES.tooHigh);
    expect(before.tracks[0]!.clips[0]!.notes!.map((n) => n.pitch)).toEqual([60, 126]);
  });

  it('0 を下回るノートが出る場合も拒否する。ドラムトラックのノート番号は数えない', () => {
    const drumWithNotes = makeTrack('drums', 'drum', [midiClip('dn', 'drums', 0, 4, [[0, 1, 0]])]);
    const ok = transposeProject(makeProject([drumWithNotes, makeTrack('inst', 'instrument', [midiClip('c', 'inst', 0, 4, [[0, 1, 1]])])]), -1, { key: 'B', keyNames }, clock);
    expect(ok.ok).toBe(true);
    const before = makeProject([makeTrack('inst', 'instrument', [midiClip('c', 'inst', 0, 4, [[0, 1, 1]])])]);
    const result = transposeProject(before, -2, { key: 'Bb', keyNames }, clock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.project).toBe(before);
    expect(result.reason).toBe(TRANSPOSE_FAILURE_MESSAGES.tooLow);
  });

  it('移調量が整数でなければ拒否する(NaN・小数・Infinity)', () => {
    const before = song();
    for (const bad of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = transposeProject(before, bad, { keyNames }, clock);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.project).toBe(before);
      expect(result.reason).toBe(TRANSPOSE_FAILURE_MESSAGES.notInteger);
    }
  });

  it('キーは呼び出し側が決めた名前をそのまま入れる(Unicode の ♯ のキーでも例外にならない)', () => {
    const before = { ...song(), key: 'F♯' as MusicalKey };
    const result = transposeProject(before, 3, { key: 'A', keyNames }, clock);
    expect(result.ok && result.project.key).toBe('A');
  });

  it('移調量と合わないキーは拒否する(C の曲を +2 してキー C のままにはしない)', () => {
    const before = makeProject([makeTrack('inst', 'instrument', [midiClip('c', 'inst', 0, 4, [[0, 1, 60]])])]);
    const result = transposeProject(before, 2, { key: 'C', keyNames }, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.project).toBe(before);
      expect(result.reason).toBe(TRANSPOSE_FAILURE_MESSAGES.keyMismatch);
    }
    // 1 オクターブ以上の移調でも、半音差が mod 12 で一致すれば通す(60 + 14 = 74)。
    expect(transposeProject(before, 14, { key: 'D', keyNames }, clock).ok).toBe(true);
  });

  it('キーを省略するとスケールに合う綴りで自動的に決める(メジャーは Db、マイナーは C#、F♯ も読む)', () => {
    const major = transposeProject(song(), 1, { keyNames }, clock);
    const minor = transposeProject({ ...song(), scale: 'naturalMinor' }, 1, { keyNames }, clock);
    const unicode = transposeProject({ ...song(), key: 'F♯' as MusicalKey }, 6, { keyNames }, clock);
    expect(major.ok && major.project.key).toBe('Db');
    expect(minor.ok && minor.project.key).toBe('C#');
    expect(unicode.ok && unicode.project.key).toBe('C');
  });

  it('読み取れないキーは理由つきで拒否する', () => {
    const before = { ...song(), key: 'H' as MusicalKey };
    const result = transposeProject(before, 2, { keyNames }, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.project).toBe(before);
      expect(result.reason).toMatch(/キー「H」を読み取れない/);
    }
  });

  it('移調量は安全な整数に限る(2^53 は拒否、2^53-1 は範囲外の音で拒否)', () => {
    const before = song();
    const unsafe = transposeProject(before, 2 ** 53, { keyNames }, clock);
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.reason).toBe(TRANSPOSE_FAILURE_MESSAGES.notInteger);
    const huge = transposeProject(before, 2 ** 53 - 1, { keyNames }, clock);
    expect(huge.ok).toBe(false);
    if (!huge.ok) {
      expect(huge.project).toBe(before);
      expect(huge.reason).toBe(TRANSPOSE_FAILURE_MESSAGES.tooHigh);
    }
  });

  it('0 半音でキーも同じなら何も変えず、同じオブジェクトを返す', () => {
    const before = song();
    const result = transposeProject(before, 0, { key: 'C', keyNames }, clock);
    expect(result.ok && result.project).toBe(before);
  });

  it('コードは transposeChord の結果に置き換え、理由が返れば全体を拒否する', () => {
    const chord: ChordEvent = { id: 'ch', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] };
    const before = { ...song(), chordTrack: [chord] };
    const ok = transposeProject(before, 2, { key: 'D', keyNames, transposeChord: (c) => ({ ...c, symbol: 'D', root: 'D', notes: [2, 6, 9] }) }, clock);
    expect(ok.ok && ok.project.chordTrack[0]!.symbol).toBe('D');
    const refused = transposeProject(before, 2, { key: 'D', keyNames, transposeChord: () => '読めません' }, clock);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.project).toBe(before);
      expect(refused.reason).toBe('読めません');
    }
  });

  it('ドラムトラックのクリップとリンクした楽器のクリップがあると、発音が +n にならないので拒否する', () => {
    const before = makeProject([
      makeTrack('drums', 'drum', [midiClip('dn', 'drums', 0, 4, [[0, 1, 60]])]),
      makeTrack('inst', 'instrument', [{ id: 'l', trackId: 'inst', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false, aliasOf: 'dn' }]),
    ]);
    const result = transposeProject(before, 2, { key: 'D', keyNames }, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.project).toBe(before);
      expect(result.reason).toBe(TRANSPOSE_FAILURE_MESSAGES.soundChanged);
    }
  });
});

// --- seed 固定のファズ ---
const KEYS: MusicalKey[] = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
const SCALES: ScaleName[] = ['major', 'naturalMinor', 'harmonicMinor', 'melodicMinor', 'majorPentatonic', 'minorPentatonic', 'blues'];

/** ランダムな曲: MIDI 0/127 付近の音、リンク、ループ、ドラム、ミュート、全キーとスケール。 */
function randomSong(seed: number): Project {
  const r = mulberry32(seed * 7 + 3);
  const base = generateProject(seed, { allowOverrunSongEnd: false });
  const extremes = [0, 1, 2, 5, 120, 122, 125, 126, 127];
  return {
    ...base,
    key: KEYS[Math.floor(r() * KEYS.length)]!,
    scale: SCALES[Math.floor(r() * SCALES.length)]!,
    tracks: base.tracks.map((t) => ({
      ...t,
      mute: r() < 0.3,
      clips: t.clips.map((c) =>
        c.notes ? { ...c, notes: c.notes.map((n) => (r() < 0.15 ? { ...n, pitch: extremes[Math.floor(r() * extremes.length)]! } : n)) } : c,
      ),
    })),
  };
}

type Snapshot = { kind: string; trackId: string; clipId: string; start: number; end: number; pitch: number; lane: string; velocity: number };
function sounds(p: Project): Snapshot[] {
  return soundingEvents(p, { includeMuted: true }).events.map((e) => ({
    kind: e.kind,
    trackId: e.trackId,
    clipId: e.clipId,
    start: beatTick(e.startBeat),
    end: e.kind === 'note' ? beatTick(e.startBeat + e.durationBeats) : -1,
    pitch: e.kind === 'note' ? e.pitch : -1,
    lane: e.kind === 'drum' ? e.lane : '',
    velocity: e.velocity,
  }));
}

describe('transposeProject ファズ(seed 固定)', () => {
  it('成功時は楽器トラックの発音が音高だけ +n、開始・終了 tick は一致、ドラムは不変。拒否時は同じオブジェクト', () => {
    let accepted = 0;
    let refused = 0;
    for (let seed = 0; seed < 400; seed += 1) {
      const before = randomSong(seed);
      expect(validateProject(before).ok).toBe(true);
      const r = mulberry32(seed + 99);
      const n = r() < 0.05 ? [2 ** 53 - 1, -(2 ** 40)][seed % 2]! : Math.floor(r() * 25) - 12;
      const result = transposeProject(before, n, { keyNames }, clock);
      if (!result.ok) {
        refused += 1;
        expect(result.project).toBe(before);
        expect(result.reason.length).toBeGreaterThan(0);
        continue;
      }
      accepted += 1;
      expect(validateProject(result.project).ok).toBe(true);
      const instruments = new Set(before.tracks.filter((t) => t.type === 'instrument').map((t) => t.id));
      const a = sounds(before);
      const b = sounds(result.project);
      expect(b.length).toBe(a.length);
      a.forEach((s, i) => {
        const shift = s.kind === 'note' && instruments.has(s.trackId) ? n : 0;
        expect(b[i]).toEqual({ ...s, pitch: s.kind === 'note' ? s.pitch + shift : -1 });
      });
      // ドラムトラックはまるごと同じ。
      before.tracks.forEach((t, ti) => {
        if (t.type === 'drum') expect(result.project.tracks[ti]).toBe(t);
      });
      // +n して -n で元に戻る(キーは元の綴りを指定)。
      const back = transposeProject(result.project, -n, { key: before.key, keyNames }, clock);
      expect(back.ok).toBe(true);
      if (back.ok) expect({ ...back.project, updatedAt: before.updatedAt }).toEqual(before);
    }
    // 成功と拒否の両方を通っていること。
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(10);
  });

  it('移調量が NaN・小数・Infinity なら必ず拒否し、同じオブジェクトを返す', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const before = randomSong(seed);
      const r = mulberry32(seed);
      const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Math.floor(r() * 25) - 12 + 0.25, 2 ** 53, -(2 ** 60)][seed % 6]!;
      const result = transposeProject(before, bad, { keyNames }, clock);
      expect(result.ok).toBe(false);
      expect(result.project).toBe(before);
    }
  });
});
