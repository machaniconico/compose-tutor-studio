import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';
import { projectToMidi } from '@cts/midi-io';
import { REVERB_IMPULSE_SECONDS } from '../src/audio/effects';
import { planStemRender, planWavRender } from '../src/audio/wav';
import { exportStemTracks, prepareStemZip, stemFileNames } from '../src/features/export/exportStems';
import { safeFileStem } from '../src/features/export/download';
import { fileTransferFailureMessage } from '../src/features/export/exportFailureMessages';
import {
  PROJECT_TEMPLATES,
  createEmptyProject,
  createTrack,
  deserializeProject,
  instantiateTemplate,
  serializeProject,
  validateProject,
  type TemplateId,
} from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';

let useStore: typeof import('../src/state/store')['useStore'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
});

beforeEach(() => {
  installLocalStorage();
  useStore.getState().createNewProject('テスト');
});

describe('MIDI export', () => {
  it('produces a non-empty buffer with a valid SMF (MThd) header', () => {
    const project = createDefaultProject();
    const bytes = projectToMidi(project);
    expect(bytes.length).toBeGreaterThan(0);

    // First four bytes spell "MThd".
    expect(bytes[0]).toBe(0x4d); // M
    expect(bytes[1]).toBe(0x54); // T
    expect(bytes[2]).toBe(0x68); // h
    expect(bytes[3]).toBe(0x64); // d

    // Wrapping in a Blob yields a non-empty audio/midi blob.
    const blob = new Blob([bytes.slice().buffer], { type: 'audio/midi' });
    expect(blob.size).toBe(bytes.length);
    expect(blob.type).toBe('audio/midi');
  });
});

describe('export filename helper', () => {
  it('keeps readable words while replacing filesystem separators', () => {
    expect(safeFileStem(' My / First: Song? ')).toBe('My_First_Song');
  });

  it('falls back for blank or dotted titles', () => {
    expect(safeFileStem('   ')).toBe('project');
    expect(safeFileStem(' ... ')).toBe('project');
    expect(safeFileStem('\u200d\u200d')).toBe('project');
    expect(safeFileStem('\u0301')).toBe('project');
    expect(safeFileStem('👨\u200d👩')).toBe('👨\u200d👩');
  });

  it('keeps Japanese titles readable', () => {
    expect(safeFileStem('  雨 の 曲  ')).toBe('雨_の_曲');
  });

  it('preserves emoji joiners and variation selectors', () => {
    expect(safeFileStem(' 👩‍🎤 / ✌️ ')).toBe('👩‍🎤_✌️');
  });

  it('avoids Windows reserved device names', () => {
    expect(safeFileStem('CON')).toBe('project_CON');
    expect(safeFileStem('com1.demo')).toBe('project_com1.demo');
  });

  it('removes invisible Unicode controls that can spoof filenames', () => {
    expect(safeFileStem('song\u202egnp')).toBe('song_gnp');
    expect(safeFileStem('intro\u200b hidden')).toBe('intro_hidden');
  });

  it('limits very long titles before adding an export extension', () => {
    const stem = safeFileStem('A'.repeat(120));
    expect(stem).toHaveLength(80);
    expect(stem).toBe('A'.repeat(80));
  });
});

describe('file transfer failure messages', () => {
  it('points generic read/write failures to actionable support diagnostics', () => {
    for (const kind of ['import-midi', 'project-import', 'project-export', 'export-midi', 'export-wav'] as const) {
      const message = fileTransferFailureMessage(kind);

      expect(message).toContain('失敗しました');
      expect(message).toContain('サポート');
      expect(message).toContain('診断情報');
    }
  });

  it('keeps the MIDI import message focused on standard MIDI files', () => {
    const message = fileTransferFailureMessage('import-midi');

    expect(message).toContain('Standard MIDI File');
    expect(message).toContain('.mid');
  });

  it('keeps the WAV message specific to render length and save destination', () => {
    const message = fileTransferFailureMessage('export-wav');

    expect(message).toContain('曲の長さ');
    expect(message).toContain('保存先');
  });
});

describe('project file round-trip into store', () => {
  it('serializes then deserializes + loads an equivalent project', () => {
    const original = createDefaultProject('丸ごと往復');
    useStore.getState().replaceProject(original);

    const json = serializeProject(useStore.getState().project);
    const loaded = deserializeProject(json);
    expect(validateProject(loaded).ok).toBe(true);

    // Replace into the store and confirm key fields survived the round trip.
    useStore.getState().replaceProject(loaded);
    const inStore = useStore.getState().project;
    expect(inStore.id).toBe(original.id);
    expect(inStore.title).toBe('丸ごと往復');
    expect(inStore.bpm).toBe(original.bpm);
    expect(inStore.tracks.length).toBe(original.tracks.length);
    expect(inStore.chordTrack.length).toBe(original.chordTrack.length);

    // Loading resets undo history + selection.
    expect(useStore.getState().past.length).toBe(0);
  });
});

describe('template instantiation', () => {
  it('every template instantiates into a valid project', () => {
    const ids = Object.keys(PROJECT_TEMPLATES) as TemplateId[];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const project = instantiateTemplate(id);
      const result = validateProject(project);
      expect(result.ok, `${id}: ${JSON.stringify(result.errors)}`).toBe(true);
      expect(project.chordTrack.length).toBeGreaterThan(0);
    }
  });

  it('loads a template into the store via replaceProject', () => {
    const project = instantiateTemplate('8bar-pop');
    useStore.getState().replaceProject(project);
    const inStore = useStore.getState().project;
    expect(inStore.title).toBe(PROJECT_TEMPLATES['8bar-pop'].name);
    expect(validateProject(inStore).ok).toBe(true);
  });
});

describe('stem export', () => {
  const keys = createTrack('鍵盤', 'instrument', undefined, undefined, undefined, 'keys');
  const bass = createTrack('ベース', 'instrument', undefined, undefined, undefined, 'bass');
  const room = createTrack('部屋', 'bus', undefined, undefined, undefined, 'room');
  const master = createTrack('マスター', 'master', undefined, undefined, undefined, 'master');

  it('excludes muted tracks and the master and lists unmuted returns separately', () => {
    expect(exportStemTracks([keys, { ...bass, mute: true }, room, master]).map(({ id }) => id))
      .toEqual(['keys', 'room']);
  });

  it('includes only soloed sources and their unmuted returns in solo mode', () => {
    const soloKeys = { ...keys, solo: true, sends: { room: 0.5 } };
    const unused = { ...room, id: 'unused' };
    expect(exportStemTracks([soloKeys, bass, room, unused, master]).map(({ id }) => id))
      .toEqual(['keys', 'room']);
    expect(exportStemTracks([soloKeys, bass, { ...room, mute: true }]).map(({ id }) => id))
      .toEqual(['keys']);
    expect(exportStemTracks([soloKeys, { ...bass, mute: true, solo: true }, room]).map(({ id }) => id))
      .toEqual(['keys', 'room']);
  });

  it('uses safe, case-insensitively unique filenames, including suffix collisions', () => {
    const names = ['../鍵盤\\\u0000', '鍵盤', '鍵盤_2', 'CON', 'Room', 'room'];
    expect(stemFileNames(names.map((name) => ({ ...keys, name })))).toEqual([
      '鍵盤.wav', '鍵盤_2.wav', '鍵盤_2_2.wav', 'project_CON.wav', 'Room.wav', 'room_2.wav',
    ]);
  });

  it('preserves emoji in stem names while replacing other format characters', () => {
    expect(stemFileNames([{ ...keys, name: '👩‍🎤\u200b✌️\u00ad曲' }])).toEqual(['👩‍🎤_✌️_曲.wav']);
  });

  it('refuses an oversized stem ZIP before creating any offline audio context', () => {
    const tracks = Array.from({ length: 250 }, (_, index) => ({ ...keys, id: `keys-${index}` }));
    const project = { ...createEmptyProject({ bpm: 120, lengthBars: 64 }), tracks };
    const mix = planWavRender(project, { sampleRate: 48000 });
    expect(() => prepareStemZip(mix, { bitDepth: 24 })).toThrow(/約 4 GB/);
  });

  it('plans the dry stem independently and uses the US-034 effect tail for the return', () => {
    const source = { ...keys, solo: true, sends: { room: 0.7 } };
    source.clips = [{
      id: 'keys-clip', trackId: 'keys', type: 'midi', startBeat: 0, lengthBeats: 4, loop: false,
      notes: [{ id: 'note', pitch: 60, startBeat: 2.75, durationBeats: 1, velocity: 100 }],
    }];
    const wetReturn = {
      ...room,
      effects: [{ id: 'verb', type: 'reverb' as const, enabled: true, params: { mix: 1 } }],
    };
    const project = { ...createEmptyProject({ bpm: 120, lengthBars: 1 }), loopRange: { startBeat: 2, endBeat: 3 },
      tracks: [source, bass, wetReturn, master] };
    const mix = planWavRender(project, { range: 'loop', sampleRate: 48000 });
    const dry = planStemRender(mix, 'keys');
    const wet = planStemRender(mix, 'room');
    expect(dry.outputTrackId).toBe('keys');
    expect(dry.project.tracks.map(({ id }) => id)).toEqual(['keys', 'master']);
    expect(wet.outputTrackId).toBe('room');
    expect(wet.project.tracks.map(({ id }) => id)).toEqual(['keys', 'room', 'master']);
    expect(wet.events).toEqual(dry.events);
    expect(wet.events).toMatchObject([{ time: 0.375, payload: { durationBeats: 0.25, cut: true } }]);
    expect(wet.frames - dry.frames).toBe(REVERB_IMPULSE_SECONDS * 48000);
    expect(source.solo).toBe(true);
  });
});
