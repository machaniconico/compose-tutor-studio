import { describe, expect, it } from 'vitest';
import type { ImportedMidiNote, ParsedMidiFile } from '@cts/midi-io';
import { validateProject } from '@cts/project-model';
import { buildScheduleEvents } from '../src/audio/events';
import { createDefaultProject } from '../src/state/defaultProject';
import {
  appendImportedMidiTrack,
  mapParsedMidiToTrack,
  midiTrackName,
  type ImportMidiIdFactory,
} from '../src/state/importMidi';

function makeIdFactory(): ImportMidiIdFactory {
  const counts = new Map<string, number>();
  return (prefix) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function note(partial: Partial<ImportedMidiNote>): ImportedMidiNote {
  return {
    pitch: 60,
    startTick: 0,
    durationTick: 480,
    velocity: 90,
    channel: 0,
    startBeat: 0,
    durationBeat: 1,
    startSeconds: 0,
    durationSeconds: 0.5,
    ...partial,
  };
}

function parsedMidi(notes: ImportedMidiNote[]): ParsedMidiFile {
  return {
    ppq: 480,
    tempoBpm: 120,
    tracks: [
      { name: 'Lead', notes: [notes[1] ?? note({})] },
      { name: 'Bass', notes: [notes[0] ?? note({ pitch: 48 })] },
    ],
  };
}

function hasTrackId(payload: unknown, trackId: string): boolean {
  return (
    typeof payload === 'object'
    && payload !== null
    && 'trackId' in payload
    && (payload as { trackId: unknown }).trackId === trackId
  );
}

describe('MIDI import mapping', () => {
  it('maps parsed MIDI notes into one playable project-model instrument track', () => {
    const parsed = parsedMidi([
      note({ pitch: 48, startBeat: 0, durationBeat: 2, velocity: 80 }),
      note({ pitch: 64, startBeat: 1.5, durationBeat: 0.5, velocity: 100 }),
    ]);

    const mapped = mapParsedMidiToTrack(parsed, {
      makeId: makeIdFactory(),
      trackName: midiTrackName('lesson.mid'),
    });

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    expect(mapped.track.name).toBe('MIDI: lesson');
    expect(mapped.track.type).toBe('instrument');
    expect(mapped.track.instrument?.preset).toBe('brightPluck');
    expect(mapped.clip.type).toBe('midi');
    expect(mapped.clip.trackId).toBe(mapped.track.id);
    expect(mapped.clip.notes).toEqual([
      {
        id: 'note_1',
        pitch: 48,
        startBeat: 0,
        durationBeats: 2,
        velocity: 80,
      },
      {
        id: 'note_2',
        pitch: 64,
        startBeat: 1.5,
        durationBeats: 0.5,
        velocity: 100,
      },
    ]);
    expect(mapped.lengthBeats).toBe(2);
  });

  it('rejects MIDI that contains no usable notes with a beginner-friendly message', () => {
    const mapped = mapParsedMidiToTrack(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [{ name: 'Empty', notes: [note({ durationBeat: 0 })] }],
      },
      { makeId: makeIdFactory(), trackName: 'MIDI: empty' },
    );

    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.message).toContain('読み込めるノート');
  });

  it('appends the imported track before master and makes notes part of playback scheduling', () => {
    const mapped = mapParsedMidiToTrack(
      {
        ppq: 480,
        tempoBpm: 120,
        tracks: [{ name: 'Long', notes: [note({ startBeat: 7, durationBeat: 2 })] }],
      },
      { makeId: makeIdFactory(), trackName: 'MIDI: long' },
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    const project = { ...createDefaultProject('読み込みテスト'), lengthBars: 1 };
    const next = appendImportedMidiTrack(project, mapped.track);
    const masterIndex = next.tracks.findIndex((track) => track.type === 'master');
    const importedIndex = next.tracks.findIndex((track) => track.id === mapped.track.id);

    expect(importedIndex).toBe(masterIndex - 1);
    expect(next.lengthBars).toBe(3);
    expect(validateProject(next).ok).toBe(true);
    expect(
      buildScheduleEvents(next).some(
        (event) => event.beat === 7 && hasTrackId(event.payload, mapped.track.id),
      ),
    ).toBe(true);
  });
});
