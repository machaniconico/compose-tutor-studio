import { describe, expect, it } from 'vitest';
import { MAX_SONG_BARS, MIN_LOOP_PERIOD_BEATS } from '../../src/sounding';
import { deserializeProject, serializeProject, validateProject } from '../../src/index';
import type { Clip, Project } from '../../src/index';
import { drumClip, makeProject, makeTrack, midiClip } from './helpers';

const link = (id: string, trackId: string, start: number, to: string, extra: Partial<Clip> = {}): Clip => ({
  id, trackId, type: 'midi', startBeat: start, lengthBeats: 2, loop: false, aliasOf: to, ...extra,
});

const valid = (): Project =>
  makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0, 1, 60]]), link('l', 't', 4, 'a')])]);

const shortLoop = (): Project =>
  makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0, 0.01, 60]], { loop: true, contentLengthBeats: MIN_LOOP_PERIOD_BEATS / 2 })])]);

const chainDepth2 = (): Project =>
  makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 2, [[0, 1, 60]]), link('b', 't', 2, 'a'), link('c', 't', 4, 'b')])]);

const linkWithOwnContent = (): Project =>
  makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 2, [[0, 1, 60]]), link('b', 't', 2, 'a', { notes: [{ id: 'x', pitch: 61, startBeat: 0, durationBeats: 1, velocity: 90 }] })])]);

const linkOfOtherKind = (): Project =>
  makeProject([
    makeTrack('t', 'instrument', [midiClip('a', 't', 0, 2, [[0, 1, 60]])]),
    makeTrack('d', 'drum', [{ ...link('b', 'd', 0, 'a'), type: 'drum' }]),
  ]);

const overlap = (): Project =>
  makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0, 1, 60]]), midiClip('b', 't', 2, 4, [[0, 1, 62]])])]);

const tooLong = (): Project => makeProject([makeTrack('t', 'instrument', [])], { lengthBars: MAX_SONG_BARS + 1 });

const CASES: Array<[string, () => Project]> = [
  ['周期が下限未満のループ', shortLoop],
  ['深さ 2 のリンク鎖', chainDepth2],
  ['自前の中身を持つリンク', linkWithOwnContent],
  ['種別の違うクリップへのリンク', linkOfOtherKind],
  ['同一トラックの重なり', overlap],
  ['曲長上限を超える長さ', tooLong],
];

describe('validation.domain', () => {
  it('validation.domain: 領域内のプロジェクトは validateProject を通る', () => {
    expect(validateProject(valid()).ok).toBe(true);
  });

  it('validation.domain: 周期が下限未満・リンク鎖が深さ 2・自前の中身を持つリンク・同一トラックの重なりを validateProject が拒否する', () => {
    for (const [label, make] of CASES) {
      const result = validateProject(make());
      expect(result.ok, label).toBe(false);
      expect(result.errors.length, label).toBeGreaterThan(0);
    }
  });

  it('validation.domain: 周期ちょうど下限のループは通る', () => {
    const p = makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0, 0.01, 60]], { loop: true, contentLengthBeats: MIN_LOOP_PERIOD_BEATS })])]);
    expect(validateProject(p).ok).toBe(true);
  });

  it('validation.domain: 読込時は正規化して拒否しない(v3 の領域外ファイルも例外なく読め、結果は検証を通る)', () => {
    for (const [label, make] of CASES) {
      const json = serializeProject(make());
      let loaded: Project | undefined;
      expect(() => { loaded = deserializeProject(json); }, label).not.toThrow();
      expect(validateProject(loaded as Project).ok, label).toBe(true);
    }
  });

  it('validation.domain: 正規化でクリップのデータを失わない(ノート数が変わらない)', () => {
    for (const [label, make] of CASES) {
      const before = make();
      const after = deserializeProject(serializeProject(before));
      const count = (p: Project): number => p.tracks.reduce((n, t) => n + t.clips.reduce((m, c) => m + (c.notes?.length ?? 0) + (c.drumEvents?.length ?? 0), 0), 0);
      expect(count(after), label).toBeGreaterThanOrEqual(count(before));
    }
  });

  it('validation.domain: 領域内の v3 ファイルは読み込みで書き換えない', () => {
    const p = valid();
    expect(deserializeProject(serializeProject(p))).toEqual(p);
    const d = makeProject([makeTrack('d', 'drum', [drumClip('x', 'd', 0, 4, [[0, 'kick']], { loop: true, contentLengthBeats: 1 })])]);
    expect(deserializeProject(serializeProject(d))).toEqual(d);
  });
});
