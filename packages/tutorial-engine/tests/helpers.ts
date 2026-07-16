// Test helpers — build minimal fake Project objects

import type {
  Clip,
  DrumEvent,
  DrumLane,
  NoteEvent,
  Project,
  Section,
  SectionType,
  Track,
} from '@cts/project-model';

function makeTrack(
  overrides: Partial<Track> & { name: string; type: Track['type'] },
): Track {
  const { name, type, role, clips, volume, ...rest } = overrides;
  return {
    id: name,
    name,
    type,
    role: role ?? 'general',
    clips: clips ?? [],
    volume: volume ?? 1.0,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    ...rest,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  const {
    lengthBeats,
    tempoMap,
    timeSignatureMap,
    audioAssets,
    automationLanes,
    ...rest
  } = overrides;
  return {
    id: 'test-project',
    schemaVersion: 3,
    title: 'Test',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    lengthBeats: lengthBeats ?? 32,
    tempoMap: tempoMap ?? [{ id: 'tempo-1', beat: 0, bpm: 120 }],
    timeSignatureMap: timeSignatureMap ?? [{
      id: 'signature-1',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: audioAssets ?? [],
    automationLanes: automationLanes ?? [],
    tracks: [],
    chordTrack: [],
    sections: [],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...rest,
  };
}

export function makeNoteClip(notes: NoteEvent[]): Clip {
  return {
    id: 'clip-1',
    trackId: 'melody',
    type: 'midi',
    startBeat: 0,
    lengthBeats: 16,
    loop: false,
    notes,
  };
}

export function makeDrumClip(drumEvents: DrumEvent[]): Clip {
  return {
    id: 'drum-clip-1',
    trackId: 'drums',
    type: 'drum',
    startBeat: 0,
    lengthBeats: 16,
    loop: false,
    drumEvents,
  };
}

export function makeNote(pitch: number, startBeat = 0): NoteEvent {
  return {
    id: `note-${pitch}-${startBeat}`,
    pitch,
    startBeat,
    durationBeats: 1,
    velocity: 80,
  };
}

export function makeDrumEvent(lane: DrumLane, stepIndex: number): DrumEvent {
  return {
    id: `drum-${lane}-${stepIndex}`,
    lane,
    stepIndex,
    velocity: 100,
  };
}

export function makeSection(type: SectionType, startBar = 0): Section {
  return {
    id: `section-${type}`,
    name: type,
    type,
    startBar,
    lengthBars: 4,
  };
}

export function makeMelodyTrack(notes: NoteEvent[]): Track {
  return makeTrack({
    name: 'Melody',
    type: 'instrument',
    clips: [makeNoteClip(notes)],
  });
}

export function makeBassTrack(notes: NoteEvent[]): Track {
  return makeTrack({
    name: 'Bass',
    type: 'instrument',
    clips: [makeNoteClip(notes)],
  });
}

export function makeDrumTrack(drumEvents: DrumEvent[]): Track {
  return makeTrack({
    name: 'Drums',
    type: 'drum',
    clips: [makeDrumClip(drumEvents)],
  });
}
