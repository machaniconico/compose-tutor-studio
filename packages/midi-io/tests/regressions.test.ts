// US-007a 事後レビューの回帰: 同 tick の順序と長いテキスト。
import { describe, expect, it } from 'vitest';
import { buildTrackChunk } from '../src/smf.js';
import { exportNotesToMidi, projectToMidi } from '../src/export.js';
import { decodeSmfMessages, drumClip, makeProject, makeTrack, midiClip } from '../../project-model/tests/acceptance/helpers';

/** Status bytes of channel messages at `tick`, in file order. */
function statusesAt(bytes: Uint8Array, trackIndex: number, tick: number): string[] {
  let pos = 14;
  for (let t = 0; t <= trackIndex; t++) {
    const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(pos + 4);
    if (t < trackIndex) {
      pos += 8 + len;
      continue;
    }
    const out: string[] = [];
    let p = pos + 8;
    const end = p + len;
    let now = 0;
    while (p < end) {
      let delta = 0;
      let b: number;
      do {
        b = bytes[p++]!;
        delta = (delta << 7) | (b & 0x7f);
      } while (b & 0x80);
      now += delta;
      const status = bytes[p]!;
      if (status === 0xff) {
        let l = 0;
        p += 2;
        do {
          b = bytes[p++]!;
          l = (l << 7) | (b & 0x7f);
        } while (b & 0x80);
        p += l;
        continue;
      }
      if (now === tick) out.push(`${(status & 0xf0) === 0x80 ? 'off' : (status & 0xf0) === 0x90 ? 'on' : 'cc'}${bytes[p + 1]}`);
      p += 3;
    }
    return out;
  }
  return [];
}

describe('MIDI の同 tick 順序', () => {
  it('同じ tick では note-off を note-on より先に書く(保存順が逆のノート)', () => {
    const project = makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[1, 1, 60], [0, 1, 60]])])]);
    expect(statusesAt(projectToMidi(project), 1, 480)).toEqual(['off60', 'on60']);
  });

  it('ドラムも同じ tick では note-off が先', () => {
    const project = makeProject([makeTrack('d', 'drum', [drumClip('k', 'd', 0, 4, [[1, 'kick'], [0, 'kick']])])]);
    expect(statusesAt(projectToMidi(project), 1, 120)).toEqual(['off36', 'on36']);
  });

  it('buildTrackChunk は同 tick の note-off を前へ出し、他の順序は保つ', () => {
    const chunk = buildTrackChunk([
      { tick: 0, bytes: [0xb0, 7, 100] },
      { tick: 0, bytes: [0x90, 60, 100] },
      { tick: 10, bytes: [0x90, 62, 100] },
      { tick: 10, bytes: [0x80, 60, 0] },
    ]);
    expect(Array.from(chunk.slice(8))).toEqual([
      0, 0xb0, 7, 100,
      0, 0x90, 60, 100,
      10, 0x80, 60, 0,
      0, 0x90, 62, 100,
      0, 0xff, 0x2f, 0x00,
    ]);
  });
});

describe('MIDI 書き出しの長いテキスト', () => {
  it('タイトル 20 万文字でも例外を出さず、名前をそのまま書く', () => {
    const project = makeProject([], { title: 'a'.repeat(200_000) });
    const bytes = projectToMidi(project);
    expect(bytes.length).toBeGreaterThan(200_000);
  });

  it('トラック名 20 万文字でも例外を出さない', () => {
    const track = { ...makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0, 1, 60]])]), name: 'b'.repeat(200_000) };
    expect(projectToMidi(makeProject([track])).length).toBeGreaterThan(200_000);
  });
});

/** [on tick, off tick] of each note in one decoded track. */
function noteSpans(track: Array<{ tick: number; data: number[] }>): Array<[number, number]> {
  const open: number[] = [];
  const spans: Array<[number, number]> = [];
  for (const m of track) {
    const kind = (m.data[0] ?? 0) & 0xf0;
    if (kind === 0x90 && m.data[2] !== 0) open.push(m.tick);
    else if (kind === 0x80 || kind === 0x90) {
      const on = open.shift();
      if (on !== undefined) spans.push([on, m.tick]);
    }
  }
  expect(open).toEqual([]);
  return spans;
}

describe('MIDI の短いノート(書き出し ppq で 1 tick 未満)', () => {
  const project = makeProject([makeTrack('t', 'instrument', [midiClip('a', 't', 0, 4, [[0, 1 / 1920, 60]])])]);
  it.each([96, 480])('projectToMidi ppq %i で note-off は note-on の 1 tick 後', (ppq) => {
    expect(noteSpans(decodeSmfMessages(projectToMidi(project, { ppq }))[1] ?? [])).toEqual([[0, 1]]);
  });
  it.each([96, 480])('exportNotesToMidi ppq %i で長さ 0.0001 拍の note-off は note-on の 1 tick 後', (ppq) => {
    const bytes = exportNotesToMidi([{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 0.0001, velocity: 100 }], 120, { ppq });
    expect(noteSpans(decodeSmfMessages(bytes)[0] ?? [])).toEqual([[0, 1]]);
  });
});

describe('MIDI の曲末(書き出し ppq の丸めで曲末に乗るノート)', () => {
  // 4/4・8 小節 = 32 拍。曲末の 1/480 拍前に始まるノートは ppq 96 だと開始が曲末の tick に丸まる。
  const project = makeProject(
    [makeTrack('t', 'instrument', [midiClip('a', 't', 0, 32, [[32 - 1 / 480, 1, 60], [31, 2, 62]])])],
    { lengthBars: 8 },
  );
  it.each([96, 480])('ppq %i で曲末より後の tick に note-off を書かず、曲末に始まる音を書かない', (ppq) => {
    const end = 32 * ppq;
    const spans = noteSpans(decodeSmfMessages(projectToMidi(project, { ppq }))[1] ?? []);
    for (const [on, off] of spans) {
      expect(on).toBeLessThan(end);
      expect(off).toBeLessThanOrEqual(end);
    }
    // 31 拍から始まる音は曲末で切れる(D3)。
    expect(spans).toContainEqual([31 * ppq, end]);
  });
});
