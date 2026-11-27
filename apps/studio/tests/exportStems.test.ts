import { type Project } from '@cts/project-model';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/state/defaultProject';
import {
  assertStemZipFits,
  buildStemZip,
  MAX_STEM_ZIP_BYTES,
  stemZipArchiveBytes,
  planStemZip,
  sanitizeStemName,
  StemExportError,
  stemFileNames,
  stemTracks,
  stemZipFileName,
  wavFileByteLength,
} from '../src/features/export/exportStems';
import { planSelectedTrackWavRender } from '../src/audio/wav';
import { zipStore } from '../src/features/export/zipStore';

const base = createDefaultProject();
const withTracks = (patch: (track: Project['tracks'][number]) => Partial<Project['tracks'][number]>): Project => ({
  ...base,
  tracks: base.tracks.map((track) => ({ ...track, ...patch(track) })),
});

describe('stem file names', () => {
  it.each([
    ['../../etc/passwd', '.._.._etc_passwd'.replace(/^\.+/, '')],
    ['a/b\\c', 'a_b_c'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['LPT1', '_LPT1'],
    ['Lead. . ', 'Lead'],
    ['..', 'track'],
    ['   ', 'track'],
    ['', 'track'],
    ['a\u0000b\u0007c‮d', 'a_b_c_d'],
    ['lone\uD800x', 'lone_x'],
    ['q:w*e?r"t<y>u|i', 'q_w_e_r_t_y_u_i'],
  ])('sanitizes %j', (input, expected) => {
    const result = sanitizeStemName(input);
    expect(result).toBe(expected);
    expect(result).not.toMatch(/[\\/:*?"<>|\u0000-\u001f]/);
    expect(result).not.toBe('..');
    expect(result).not.toMatch(/[. ]$/);
  });

  it('keeps Japanese, emoji pairs and joiners, and limits the length', () => {
    expect(sanitizeStemName('メロディ🙂')).toBe('メロディ🙂');
    expect(sanitizeStemName('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    const long = sanitizeStemName('あ'.repeat(500));
    expect(Array.from(long)).toHaveLength(64);
  });

  it('numbers by order and de-duplicates case-insensitively', () => {
    expect(stemFileNames(['Melody', 'melody', 'MELODY', 'Bass'])).toEqual([
      '01_Melody.wav',
      '02_melody (2).wav',
      '03_MELODY (3).wav',
      '04_Bass.wav',
    ]);
    const many = stemFileNames(Array.from({ length: 100 }, () => 'x'));
    expect(many[0]).toBe('001_x.wav');
    expect(new Set(many.map((name) => name.toLowerCase())).size).toBe(100);
    expect(stemFileNames([])).toEqual([]);
  });

  it('names the archive from the project title', () => {
    expect(stemZipFileName('My/Song')).toBe('My_Song - stems.zip');
  });
});

describe('stem selection and planning', () => {
  it('skips master, bus, muted and non-soloed tracks', () => {
    const muted = withTracks((t) => (t.name === 'Bass' ? { mute: true } : {}));
    expect(stemTracks(muted).map((t) => t.name)).toEqual(['Chords', 'Melody', 'Drums']);
    const soloed = withTracks((t) => (t.name === 'Drums' ? { solo: true } : {}));
    expect(stemTracks(soloed).map((t) => t.name)).toEqual(['Drums']);
  });

  it('refuses when nothing is audible', () => {
    const project = withTracks((t) => ({ mute: t.type !== 'master' }));
    expect(() => planStemZip(project, {})).toThrow(StemExportError);
  });

  it('gives every stem the same exact length and matching byte size', () => {
    for (const format of [{}, { sampleRate: 48000, bitDepth: 24, dither: false }] as const) {
      const plan = planStemZip(base, format);
      expect(plan.files).toHaveLength(4);
      expect(new Set(plan.files.map((f) => f.byteLength)).size).toBe(1);
      expect(plan.files[0]!.byteLength).toBe(
        wavFileByteLength(plan.frames, format.bitDepth ?? 16),
      );
      expect(plan.files.map((f) => f.name.slice(0, 3))).toEqual(['01_', '02_', '03_', '04_']);
    }
  });

  it('pads a plan to minFrames without shrinking it', () => {
    const track = base.tracks[0]!;
    const plain = planSelectedTrackWavRender(base, track.id);
    expect(planSelectedTrackWavRender(base, track.id, {}, plain.frames + 1000).frames)
      .toBe(plain.frames + 1000);
    expect(planSelectedTrackWavRender(base, track.id, {}, 1).frames).toBe(plain.frames);
  });
});

describe('stem ZIP bytes', () => {
  it('is deterministic and uses STORE with UTF-8 names', async () => {
    const files = [
      { name: '01_メロディ.wav', byteLength: 8 },
      { name: '02_Bass.wav', byteLength: 8 },
    ];
    const make = async () => zipStore(files, async (_f, i) => new Uint8Array(8).fill(i + 1).buffer);
    const first = await (await make()).arrayBuffer();
    const second = await (await make()).arrayBuffer();
    expect(new Uint8Array(first)).toEqual(new Uint8Array(second));
    const view = new DataView(first);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & (1 << 11)).toBe(1 << 11);
    expect(view.getUint16(8, true)).toBe(0); // STORE
    expect(view.getUint16(12, true)).toBe(0x21); // fixed DOS date
  });
});

// Routing fixtures: Chords -> Bus -> Master, Bass -> Master, Melody -> Master + send to Return.
function routed(patch: Record<string, Partial<Project['tracks'][number]>> = {}): Project {
  const [chords, bass, melody, drums] = base.tracks;
  const master = base.tracks.find((t) => t.type === 'master')!;
  const mk = (id: string, name: string) => ({
    ...base.tracks[0]!, id, name, type: 'bus' as const, clips: [], mute: false, solo: false,
  });
  const bus = mk('bus', 'Bus');
  const ret = mk('ret', 'Return');
  const tracks = [chords!, bass!, melody!, drums!, bus, ret, master].map((t) => ({
    ...t, ...(patch[t.name] ?? {}),
  }));
  return {
    ...base,
    tracks,
    audioRouting: {
      outputs: [
        { sourceTrackId: chords!.id, destination: { type: 'bus', trackId: 'bus' } },
        { sourceTrackId: bass!.id, destination: { type: 'master' } },
        { sourceTrackId: melody!.id, destination: { type: 'master' } },
        { sourceTrackId: drums!.id, destination: { type: 'master' } },
        { sourceTrackId: 'bus', destination: { type: 'master' } },
        { sourceTrackId: 'ret', destination: { type: 'master' } },
      ],
      sends: [{
        id: 's1', sourceTrackId: melody!.id, targetBusId: 'ret',
        position: 'post-fader', gain: 1, enabled: true,
      }],
    },
  };
}
const names = (project: Project) => stemTracks(project).map((t) => t.name);

describe('stem audibility follows the mixer routing', () => {
  it('keeps every source when nothing is soloed or muted', () => {
    expect(names(routed())).toEqual(['Chords', 'Bass', 'Melody', 'Drums']);
  });
  it('a soloed Bus keeps the sources routed into it', () => {
    expect(names(routed({ Bus: { solo: true } }))).toEqual(['Chords']);
  });
  it('a track soloed inside a Bus leaves the Bus siblings out', () => {
    expect(names(routed({ Chords: { solo: true } }))).toEqual(['Chords']);
  });
  it('a muted Bus silences the sources that only feed it', () => {
    expect(names(routed({ Bus: { mute: true } }))).toEqual(['Bass', 'Melody', 'Drums']);
  });
  it('a soloed source keeps itself even when it also sends to a Return', () => {
    expect(names(routed({ Melody: { solo: true } }))).toEqual(['Melody']);
  });
  it('a soloed Return keeps the source that sends to it', () => {
    expect(names(routed({ Return: { solo: true } }))).toEqual(['Melody']);
  });
  it('a muted source is skipped', () => {
    expect(names(routed({ Bass: { mute: true } }))).toEqual(['Chords', 'Melody', 'Drums']);
  });
});

describe('exact archive size preflight', () => {
  const longNames = Array.from({ length: 63 }, (_, i) =>
    `${String(i + 1).padStart(2, '0')}_${'x'.repeat(64)}.wav`);
  it('counts local headers, names twice, central entries and the EOCD', () => {
    const nameBytes = (n: string) => new TextEncoder().encode(n).length;
    const wav = 1000;
    const expected = longNames.reduce((sum, n) => sum + 30 + nameBytes(n) + wav + 46 + nameBytes(n), 22);
    expect(stemZipArchiveBytes(longNames, wav)).toBe(expected);
  });
  it('accepts exactly the cap and refuses one byte more', () => {
    const overhead = stemZipArchiveBytes(longNames, 0);
    const wav = Math.floor((MAX_STEM_ZIP_BYTES - overhead) / longNames.length);
    const total = stemZipArchiveBytes(longNames, wav);
    expect(total).toBeLessThanOrEqual(MAX_STEM_ZIP_BYTES);
    expect(() => assertStemZipFits(longNames, wav)).not.toThrow();
    expect(() => assertStemZipFits(longNames, wav + 1)).toThrow(StemExportError);
    expect(() => assertStemZipFits(longNames, Math.floor(MAX_STEM_ZIP_BYTES / 63))).toThrow(StemExportError);
  });
});

describe('entry name byte cap', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  it('caps emoji names at 200 UTF-8 bytes on a code point boundary', () => {
    const [name] = stemFileNames(['🙂'.repeat(64)]);
    expect(bytes(name!)).toBeLessThanOrEqual(200);
    expect(name!.startsWith('01_')).toBe(true);
    expect(name!.endsWith('.wav')).toBe(true);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(name!))).not.toThrow();
    expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(name!))).toBe(name);
  });
  it('caps CJK names and keeps them distinct after de-duplication', () => {
    const out = stemFileNames(['あ'.repeat(64), 'あ'.repeat(64)]);
    for (const n of out) expect(bytes(n)).toBeLessThanOrEqual(200 + 4);
    expect(new Set(out).size).toBe(2);
    expect(bytes(out[0]!)).toBeLessThanOrEqual(200);
  });
});

describe('common stem length', () => {
  it('renders every stem to the longest planned length, tails included', async () => {
    const [chords, bass] = base.tracks;
    const tail = {
      id: 'fx', type: 'delay' as const, enabled: true,
      params: { delayTime: 1, feedback: 0.8, mix: 1 },
    };
    const project: Project = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === chords!.id
        ? { ...t, effects: [tail], clips: [{ id: 'c', trackId: t.id, type: 'midi' as const, startBeat: 0, lengthBeats: 4, loop: false,
          notes: [{ id: 'n', pitch: 60, startBeat: 3.5, durationBeats: 0.5, velocity: 100 }] }] }
        : t)),
    };
    const own = (id: string) => planSelectedTrackWavRender(project, id).frames;
    expect(own(chords!.id)).toBeGreaterThan(own(bass!.id));
    const plan = planStemZip(project, {});
    expect(plan.frames).toBe(Math.max(...stemTracks(project).map((t) => own(t.id))));
    const seen: Array<number | undefined> = [];
    vi.resetModules();
    vi.doMock('../src/audio/wav', async (orig) => ({
      ...(await orig<typeof import('../src/audio/wav')>()),
      renderSelectedTrackToWav: async (_p: Project, _id: string, o: { minFrames?: number }) => {
        seen.push(o.minFrames);
        const blob = new Blob([new Uint8Array(wavFileByteLength(plan.frames, 16))]);
        return { blob, released: false, release: () => undefined };
      },
    }));
    const mod = await import('../src/features/export/exportStems');
    await mod.buildStemZip(project, {});
    vi.doUnmock('../src/audio/wav');
    expect(seen).toEqual(stemTracks(project).map(() => plan.frames));
    expect(buildStemZip).toBeTypeOf('function');
  });
});
