import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetIdCounter,
  makeId,
  createDefaultProject,
  createInstrumentTrack,
  createDrumTrack,
  createNoteEvent,
  createChordEvent,
  validateProject,
  assertValidProject,
} from '../src/index';
// createMidiClip/createDrumClip come from factories.ts (already on index.ts)
import { createMidiClip, createDrumClip } from '../src/factories';

// ---------------------------------------------------------------------------
// ids.ts
// ---------------------------------------------------------------------------
describe('makeId', () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it('returns a string with the given prefix', () => {
    const id = makeId('track');
    expect(id).toMatch(/^track-\d+$/);
  });

  it('defaults prefix to "id"', () => {
    const id = makeId();
    expect(id).toMatch(/^id-\d+$/);
  });

  it('produces unique ids on successive calls', () => {
    const ids = Array.from({ length: 10 }, () => makeId('x'));
    const unique = new Set(ids);
    expect(unique.size).toBe(10);
  });

  it('is deterministic after reset', () => {
    const a = makeId('p');
    _resetIdCounter();
    const b = makeId('p');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// factory.ts — createDefaultProject
// ---------------------------------------------------------------------------
describe('createDefaultProject', () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it('has sensible defaults', () => {
    const p = createDefaultProject();
    expect(p.title).toBe('Untitled');
    expect(p.bpm).toBe(100);
    expect(p.key).toBe('C');
    expect(p.scale).toBe('major');
    expect(p.timeSignature).toEqual([4, 4]);
    expect(p.lengthBars).toBe(8);
    expect(p.schemaVersion).toBe(1);
  });

  it('accepts overrides', () => {
    const p = createDefaultProject({ title: 'MySong', bpm: 140, key: 'G' });
    expect(p.title).toBe('MySong');
    expect(p.bpm).toBe(140);
    expect(p.key).toBe('G');
  });

  it('does not call Date.now (timestamp is fixed placeholder)', () => {
    const p = createDefaultProject();
    expect(p.createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(p.updatedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('includes a master track, one instrument track, one drum track', () => {
    const p = createDefaultProject();
    expect(p.tracks.length).toBe(3);
    const types = p.tracks.map((t) => t.type);
    expect(types).toContain('master');
    expect(types).toContain('instrument');
    expect(types).toContain('drum');
  });

  it('each track has sensible mixer defaults', () => {
    const p = createDefaultProject();
    for (const track of p.tracks) {
      expect(track.volume).toBe(1);
      expect(track.pan).toBe(0);
      expect(track.mute).toBe(false);
      expect(track.solo).toBe(false);
      expect(track.effects).toEqual([]);
    }
  });

  it('instrument and drum tracks each have one default clip', () => {
    const p = createDefaultProject();
    const instrTrack = p.tracks.find((t) => t.type === 'instrument')!;
    const drumTrack = p.tracks.find((t) => t.type === 'drum')!;
    expect(instrTrack.clips).toHaveLength(1);
    expect(drumTrack.clips).toHaveLength(1);
    expect(instrTrack.clips.at(0)!.type).toBe('midi');
    expect(drumTrack.clips.at(0)!.type).toBe('drum');
  });

  it('passes validateProject with no errors', () => {
    const p = createDefaultProject();
    const result = validateProject(p);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// factory.ts — individual helpers
// ---------------------------------------------------------------------------
describe('createInstrumentTrack', () => {
  beforeEach(() => { _resetIdCounter(); });

  it('creates a track with type instrument', () => {
    const t = createInstrumentTrack('Keys');
    expect(t.type).toBe('instrument');
    expect(t.name).toBe('Keys');
    expect(t.clips).toEqual([]);
    expect(t.effects).toEqual([]);
  });

  it('defaults name to "Instrument"', () => {
    const t = createInstrumentTrack();
    expect(t.name).toBe('Instrument');
  });
});

describe('createDrumTrack', () => {
  beforeEach(() => { _resetIdCounter(); });

  it('creates a track with type drum', () => {
    const t = createDrumTrack('Beats');
    expect(t.type).toBe('drum');
    expect(t.name).toBe('Beats');
  });

  it('defaults name to "Drums"', () => {
    const t = createDrumTrack();
    expect(t.name).toBe('Drums');
  });
});

describe('createNoteEvent', () => {
  beforeEach(() => { _resetIdCounter(); });

  it('creates a note event with correct fields', () => {
    const n = createNoteEvent(60, 0, 1, 100);
    expect(n.pitch).toBe(60);
    expect(n.startBeat).toBe(0);
    expect(n.durationBeats).toBe(1);
    expect(n.velocity).toBe(100);
    expect(typeof n.id).toBe('string');
    expect(n.id.length).toBeGreaterThan(0);
  });
});

describe('createChordEvent', () => {
  beforeEach(() => { _resetIdCounter(); });

  it('creates a chord event with correct fields', () => {
    const c = createChordEvent(0, 4, 'C', 'C', 'major', [60, 64, 67]);
    expect(c.startBeat).toBe(0);
    expect(c.durationBeats).toBe(4);
    expect(c.symbol).toBe('C');
    expect(c.root).toBe('C');
    expect(c.quality).toBe('major');
    expect(c.notes).toEqual([60, 64, 67]);
    expect(typeof c.id).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Factory helpers produce unique ids
// ---------------------------------------------------------------------------
describe('factory helper id uniqueness', () => {
  it('createNoteEvent produces unique ids', () => {
    _resetIdCounter();
    const ids = Array.from({ length: 5 }, () => createNoteEvent(60, 0, 1, 80).id);
    expect(new Set(ids).size).toBe(5);
  });

  it('createInstrumentTrack produces unique ids', () => {
    _resetIdCounter();
    const ids = Array.from({ length: 5 }, () => createInstrumentTrack().id);
    expect(new Set(ids).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// validation.ts — validateProject
// ---------------------------------------------------------------------------
describe('validateProject', () => {
  it('returns ok:true for a valid default project', () => {
    const p = createDefaultProject();
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('flags bpm below 20', () => {
    const p = createDefaultProject({ bpm: 10 });
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'bpm')).toBe(true);
  });

  it('flags bpm above 300', () => {
    const p = createDefaultProject({ bpm: 400 });
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'bpm')).toBe(true);
  });

  it('flags invalid time signature denominator', () => {
    const p = createDefaultProject({ timeSignature: [4, 3] });
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path === 'timeSignature[1]')).toBe(true);
  });

  it('flags note pitch out of range', () => {
    const p = createDefaultProject();
    const instrTrack = p.tracks.find((t) => t.type === 'instrument')!;
    instrTrack.clips[0]!.notes = [createNoteEvent(200, 0, 1, 100)];
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    const pitchError = r.errors.find((e) => e.path.endsWith('.pitch'));
    expect(pitchError).toBeDefined();
  });

  it('flags note velocity out of range (0 is below min 1)', () => {
    const p = createDefaultProject();
    const instrTrack = p.tracks.find((t) => t.type === 'instrument')!;
    instrTrack.clips[0]!.notes = [createNoteEvent(60, 0, 1, 0)];
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    const velError = r.errors.find((e) => e.path.endsWith('.velocity'));
    expect(velError).toBeDefined();
  });

  it('flags pan out of range', () => {
    const p = createDefaultProject();
    p.tracks[0]!.pan = 2.0;
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('pan'))).toBe(true);
  });

  it('flags volume out of range', () => {
    const p = createDefaultProject();
    p.tracks[0]!.volume = 3.0;
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('volume'))).toBe(true);
  });

  it('flags clip startBeat < 0', () => {
    const p = createDefaultProject();
    const instrTrack = p.tracks.find((t) => t.type === 'instrument')!;
    instrTrack.clips[0]!.startBeat = -1;
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('startBeat'))).toBe(true);
  });

  it('flags chord durationBeats <= 0', () => {
    const p = createDefaultProject();
    p.chordTrack.push(createChordEvent(0, 0, 'C', 'C', 'major', [60, 64, 67]));
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('durationBeats'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertValidProject
// ---------------------------------------------------------------------------
describe('assertValidProject', () => {
  it('returns the project unchanged when valid', () => {
    const p = createDefaultProject();
    const returned = assertValidProject(p);
    expect(returned).toBe(p);
  });

  it('throws when invalid', () => {
    const p = createDefaultProject({ bpm: 5 });
    expect(() => assertValidProject(p)).toThrow();
  });

  it('thrown message includes path info', () => {
    const p = createDefaultProject({ bpm: 5 });
    expect(() => assertValidProject(p)).toThrow(/bpm/);
  });
});

// ---------------------------------------------------------------------------
// Round-trip JSON serialization
// ---------------------------------------------------------------------------
describe('JSON round-trip', () => {
  it('JSON.parse(JSON.stringify(project)) still validates', () => {
    const p = createDefaultProject({ title: 'RoundTrip', bpm: 120 });
    const roundTripped = JSON.parse(JSON.stringify(p));
    const r = validateProject(roundTripped);
    expect(r.ok).toBe(true);
  });
});
