import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_LENGTH_BARS,
  addTimeSignatureMapEvent,
  addTempoMapEvent,
  createDefaultProject,
  encodeProjectJson,
  setProjectLengthBars,
  validateProject,
  type Project,
} from '@cts/project-model';
import { buildScheduleEvents } from '../src/audio/events';
import type { ScheduledEvent } from '../src/audio/scheduler';
import { createDefaultProject as createStudioStartingProject } from '../src/state/defaultProject';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/songLengthActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/songLengthActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  useStore.setState({ projectOperationBusy: false, audioRecordingOperationId: null });
  expect(await useStore.getState().createNewProject('曲の長さ')).toBe(true);
});

/** Empty 8-bar 4/4 project, so only the content a test adds can block. */
function emptyProject(): Project {
  const base = createDefaultProject({ lengthBars: 8 });
  return {
    ...base,
    tracks: base.tracks.map((track) => ({ ...track, clips: [] })),
    chordTrack: [],
    sections: [],
  };
}

function withMeterChange(project: Project, beat: number): Project {
  const result = addTimeSignatureMapEvent(project, { beat, numerator: 3, denominator: 4 });
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
}

describe('setProjectLengthBars (pure)', () => {
  it('grows by whole bars of the last meter and mirrors lengthBars', () => {
    const base = withMeterChange(emptyProject(), 20);
    expect(base.lengthBars).toBe(9);
    expect(base.lengthBeats).toBe(32);
    const result = setProjectLengthBars(base, 11);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.lengthBars).toBe(11);
    expect(result.project.lengthBeats).toBe(20 + 6 * 3);
    expect(validateProject(result.project).errors).toEqual([]);
  });

  it('shrinks an empty tail and keeps the time-signature map valid', () => {
    const result = setProjectLengthBars(emptyProject(), 3);
    expect(result.ok && result.project.lengthBeats).toBe(12);
  });

  it('returns the same project when the length does not change', () => {
    const base = emptyProject();
    const result = setProjectLengthBars(base, 8);
    expect(result.ok && result.changed).toBe(false);
    expect(result.project).toBe(base);
  });

  it.each<unknown>([0, -1, 1.5, Number.NaN, Infinity, MAX_PROJECT_LENGTH_BARS + 1, '4', null, undefined,
    { toString: null }, { valueOf: null }, [4]])(
    'refuses invalid length %j without throwing',
    (value) => {
      const base = emptyProject();
      const result = setProjectLengthBars(base, value);
      expect(result.ok).toBe(false);
      expect(result.project).toBe(base);
      if (!result.ok) expect(result.error.code).toBe('invalid-length');
    },
  );

  it('accepts the maximum and refuses one past it', () => {
    expect(setProjectLengthBars(emptyProject(), MAX_PROJECT_LENGTH_BARS).ok).toBe(true);
    expect(setProjectLengthBars(emptyProject(), MAX_PROJECT_LENGTH_BARS + 1).ok).toBe(false);
  });

  it('refuses to shorten past a clip, naming the track and bar', () => {
    const base = emptyProject();
    const track = base.tracks.find((t) => t.type === 'instrument')!;
    const clip = {
      id: 'c1', trackId: track.id, type: 'midi' as const, startBeat: 24, lengthBeats: 4, loop: false,
      notes: [{ id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 }],
    };
    const project = {
      ...base,
      tracks: base.tracks.map((t) => (t === track ? { ...t, clips: [clip] } : t)),
    };
    const result = setProjectLengthBars(project, 6);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('content-beyond-end');
    expect(result.error.blockers).toEqual([{ kind: 'note', name: track.name, bar: 7 }]);
    expect(result.project).toBe(project);
    expect(setProjectLengthBars(project, 7).ok).toBe(true);
  });

  it('refuses over automation points, tempo events and meter changes', () => {
    const base = emptyProject();
    const track = base.tracks.find((t) => t.type === 'instrument')!;
    const tempo = addTempoMapEvent(base, { beat: 22, bpm: 90 });
    if (!tempo.ok) throw new Error(tempo.error.message);
    const project: Project = {
      ...withMeterChange(tempo.project, 20),
      automationLanes: [{
        id: 'lane', bypassed: false, target: { type: 'track-volume', trackId: track.id },
        points: [{ id: 'p', beat: 30, value: 0.5, interpolation: 'linear' }],
      }],
      chordTrack: [{
        id: 'ch', startBeat: 28, durationBeats: 4, symbol: 'C', root: 'C', quality: 'maj', notes: [60, 64, 67],
      }],
      sections: [{ id: 's', name: 'サビ', type: 'chorus', startBar: 6, lengthBars: 2 }],
    };
    expect(validateProject(project).errors).toEqual([]);
    const result = setProjectLengthBars(project, 4);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const kinds = new Set(result.error.blockers!.map((b) => b.kind));
    expect(kinds).toEqual(new Set(['automation-point', 'tempo-event', 'time-signature-event']));
  });

  it('seeded fuzz: results validate, keep the schedule inside the song, and are content-safe', () => {
    let seed = 0x2f6e2b1;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    let accepted = 0;
    let trimmedTotal = 0;
    let refused = 0;
    for (let round = 0; round < 400; round += 1) {
      let project = emptyProject();
      if (rand() < 0.4) project = withMeterChange(project, rand() < 0.5 ? 8 : 20);
      const inst = instrumentOf(project);
      const drums = project.tracks.find((t) => t.type === 'drum')!;
      if (rand() < 0.8) {
        const notes: Array<[number, number]> = [];
        for (let i = int(1, 3); i > 0; i -= 1) notes.push([int(0, 6) / 2, int(1, 4) / 2]);
        const pattern = Math.max(...notes.map(([st, d]) => st + d));
        const loop = rand() < 0.4;
        const length = loop ? int(2, 40) : Math.ceil(pattern) + int(0, 24);
        const start = int(0, Math.max(0, Math.floor(project.lengthBeats - length)));
        project = withClip(project, inst.id, midiClip(inst.id, `m${round}`, start, length, loop, notes));
      }
      if (rand() < 0.5) {
        const bars = int(1, 6);
        const steps = Array.from({ length: int(0, 4) }, () => int(0, bars * 16 - 1));
        project = withClip(project, drums.id, {
          id: `d${round}`, trackId: drums.id, type: 'drum' as const, startBeat: 0,
          lengthBeats: bars * 4, loop: false, stepsPerBar: 16,
          drumEvents: steps.map((stepIndex, i) => ({
            id: `e${round}-${i}`, lane: 'kick' as const, stepIndex, velocity: 100,
          })),
        });
      }
      if (rand() < 0.7) {
        const chords = Array.from({ length: int(1, 5) }, (_, i) => ({
          id: `ch${round}-${i}`, startBeat: int(0, 15) * 2, durationBeats: int(1, 6),
          symbol: 'C', root: 'C', quality: 'major', notes: [60, 64, 67],
        })).filter((c) => c.startBeat + c.durationBeats <= project.lengthBeats);
        const startBar = int(0, 6);
        project = {
          ...project,
          chordTrack: chords,
          sections: [{ id: `sec${round}`, name: 'S', type: 'verse' as const, startBar, lengthBars: int(1, 8 - startBar) }],
        };
      }
      if (validateProject(project).errors.length > 0) continue;
      const before = JSON.stringify(project);
      const bars = int(-1, project.lengthBars + 3);
      const result = setProjectLengthBars(project, bars);
      expect(JSON.stringify(project)).toBe(before);
      if (!result.ok) {
        refused += 1;
        expect(result.project).toBe(project);
        continue;
      }
      accepted += 1;
      trimmedTotal += result.trimmedClips + result.removedClips;
      expect(validateProject(result.project).errors).toEqual([]);
      expect(result.project.lengthBars).toBe(bars);
      expect(Number.isFinite(result.project.lengthBeats)).toBe(true);
      for (const event of buildScheduleEvents(result.project)) {
        expect(event.beat).toBeGreaterThanOrEqual(0);
        expect(event.beat).toBeLessThan(result.project.lengthBeats);
        const payload = event.payload as { kind: string; durationBeats?: number };
        if (payload.kind === 'note') {
          expect(event.beat + (payload.durationBeats ?? 0)).toBeLessThanOrEqual(
            result.project.lengthBeats,
          );
        }
      }
      // Shrinking never changes what is heard.
      if (bars < project.lengthBars) {
        expect(normalizedSchedule(result.project)).toEqual(normalizedSchedule(project));
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(10);
    expect(trimmedTotal).toBeGreaterThan(10);
  });
});

function instrumentOf(project: Project) {
  return project.tracks.find((t) => t.type === 'instrument')!;
}

function withClip(project: Project, trackId: string, clip: Project['tracks'][number]['clips'][number]): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, clips: [...t.clips, clip] } : t)),
  };
}

function midiClip(
  trackId: string, id: string, startBeat: number, lengthBeats: number, loop: boolean,
  notes: Array<[number, number]>,
) {
  return {
    id, trackId, type: 'midi' as const, startBeat, lengthBeats, loop,
    notes: notes.map(([start, dur], i) => ({
      id: `${id}-n${i}`, pitch: 60, startBeat: start, durationBeats: dur, velocity: 90,
    })),
  };
}

/** Schedule with trim-dependent fields removed, order-independent. */
function normalizedSchedule(project: Project): string[] {
  return buildScheduleEvents(project)
    .map((event: ScheduledEvent) => {
      const payload = { ...(event.payload as Record<string, unknown>) };
      delete payload.clipEndBeat;
      return JSON.stringify({ beat: event.beat, payload });
    })
    .sort();
}

describe('setProjectLengthBars content-safe truncate', () => {
  it('shortens the default 8-bar project to 4 bars by trimming its clips', () => {
    const base = createDefaultProject({ lengthBars: 8 });
    const result = setProjectLengthBars(base, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trimmedClips).toBe(2);
    expect(result.removedClips).toBe(0);
    for (const track of result.project.tracks) {
      for (const clip of track.clips) expect(clip.startBeat + clip.lengthBeats).toBe(16);
    }
    expect(validateProject(result.project).errors).toEqual([]);
    expect(normalizedSchedule(result.project)).toEqual(normalizedSchedule(base));
  });

  it('removes an empty clip that lies entirely past the new end', () => {
    const base = emptyProject();
    const track = instrumentOf(base);
    const project = withClip(base, track.id, midiClip(track.id, 'late', 24, 4, false, []));
    const result = setProjectLengthBars(project, 4);
    expect(result.ok && result.removedClips).toBe(1);
    if (result.ok) expect(instrumentOf(result.project).clips).toEqual([]);
  });

  it('refuses a clip past the end that has content, and a removal an alias still needs', () => {
    const base = emptyProject();
    const track = instrumentOf(base);
    const source = midiClip(track.id, 'src', 24, 4, false, []);
    const { notes: _omit, ...aliasBase } = midiClip(track.id, 'als', 0, 4, false, []);
    void _omit;
    const alias = { ...aliasBase, aliasOf: 'src' };
    const project = withClip(withClip(base, track.id, source), track.id, alias);
    expect(validateProject(project).errors).toEqual([]);
    const result = setProjectLengthBars(project, 6);
    expect(result.ok).toBe(false);
  });

  it('refuses when a note sounds past the new end and names bar, track and a fix', () => {
    const base = emptyProject();
    const track = instrumentOf(base);
    // Note starts in bar 4 (beat 12) and lasts 6 beats: sounds past beat 16.
    const project = withClip(base, track.id, midiClip(track.id, 'c', 0, 24, false, [[12, 6]]));
    const result = setProjectLengthBars(project, 4);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.blockers).toEqual([{ kind: 'note-overrun', name: track.name, bar: 4 }]);
    const message = actions.studioSongLengthErrorMessage(result.error.code as never, result.error.blockers);
    expect(message).toContain('4小節目');
    expect(message).toContain(track.name);
    expect(message).toContain('音符を短く');
    // A note that ends exactly at the new end is fine.
    const fits = withClip(base, track.id, midiClip(track.id, 'c', 0, 24, false, [[12, 4]]));
    expect(setProjectLengthBars(fits, 4).ok).toBe(true);
  });

  it('refuses a drum hit at or after the new end but trims a clip whose hits fit', () => {
    const base = emptyProject();
    const drums = base.tracks.find((t) => t.type === 'drum')!;
    const clip = (steps: number[]) => ({
      id: 'd', trackId: drums.id, type: 'drum' as const, startBeat: 0, lengthBeats: 32, loop: false,
      stepsPerBar: 16,
      drumEvents: steps.map((stepIndex, i) => ({
        id: `e${i}`, lane: 'kick' as const, stepIndex, velocity: 100,
      })),
    });
    expect(setProjectLengthBars(withClip(base, drums.id, clip([0, 63])), 4).ok).toBe(true);
    expect(setProjectLengthBars(withClip(base, drums.id, clip([0, 64])), 4).ok).toBe(false);
  });

  it('looped clip: refuses only when a repeat holds a note past the end', () => {
    const base = emptyProject();
    const track = instrumentOf(base);
    // Pattern period 2.5 beats (onsets 1, 2 | 3.5, 4.5 | 6, 7 | 8.5, 9.5 ...).
    const loopNotes: Array<[number, number]> = [[1, 1], [2, 0.5]];
    // Length 8.2: repeats at 1, 2, 3.5, 4.5, 6, 7 only; all end by 7.5, so the
    // clip can be trimmed to the new end (8 beats) with nothing lost.
    const safe = withClip(base, track.id, midiClip(track.id, 'l', 0, 8.2, true, loopNotes));
    const trimmed = setProjectLengthBars(safe, 2);
    expect(trimmed.ok && trimmed.trimmedClips).toBe(1);
    if (trimmed.ok) {
      expect(normalizedSchedule(trimmed.project)).toEqual(normalizedSchedule(safe));
    }
    // Length 9: the repeat at 8.5 holds a note past the new end.
    const crossing = withClip(base, track.id, midiClip(track.id, 'l', 0, 9, true, loopNotes));
    const refused = setProjectLengthBars(crossing, 2);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.blockers).toEqual([{ kind: 'note', name: track.name, bar: 3 }]);
    }
  });
});

describe('chords and sections when shortening', () => {
  const chord = (id: string, startBeat: number, durationBeats: number) => ({
    id, startBeat, durationBeats, symbol: 'C', root: 'C', quality: 'major', notes: [60, 64, 67],
  });

  it('removes chords and sections at or after the new end and trims the ones that straddle it', () => {
    const base = emptyProject();
    const project: Project = {
      ...base,
      chordTrack: [chord('a', 0, 4), chord('b', 12, 8), chord('c', 16, 4), chord('d', 28, 4)],
      sections: [
        { id: 's1', name: 'A', type: 'verse', startBar: 0, lengthBars: 2 },
        { id: 's2', name: 'B', type: 'chorus', startBar: 3, lengthBars: 3 },
        { id: 's3', name: 'C', type: 'outro', startBar: 6, lengthBars: 2 },
      ],
    };
    expect(validateProject(project).errors).toEqual([]);
    const result = setProjectLengthBars(project, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.chordTrack.map((c) => [c.id, c.startBeat, c.durationBeats])).toEqual([
      ['a', 0, 4], ['b', 12, 4],
    ]);
    expect(result.project.sections.map((x) => [x.id, x.startBar, x.lengthBars])).toEqual([
      ['s1', 0, 2], ['s2', 3, 1],
    ]);
    expect(result).toMatchObject({
      removedChords: 2, trimmedChords: 1, removedSections: 1, trimmedSections: 1,
    });
    expect(validateProject(result.project).errors).toEqual([]);
  });

  it('removes a chord whose trimmed length would fall below the minimum', () => {
    const base = emptyProject();
    const tiny = 1 / 4096;
    const project = { ...base, chordTrack: [chord('t', 16 - tiny, 4)] };
    const result = setProjectLengthBars(project, 4);
    expect(result.ok && result.removedChords).toBe(1);
  });

  it('reports counts in Japanese for the panel', () => {
    const message = actions.studioSongLengthStatusMessage({
      ok: true, changed: true, lengthBars: 4, trimmedClips: 0, removedClips: 0,
      removedChords: 4, trimmedChords: 0, removedSections: 1, trimmedSections: 0,
      playbackStopped: false,
    });
    expect(message).toContain('コード 4 個・セクション 1 個を取り除きました(元に戻すで復元できます)');
  });
});

describe('schedule diff is authoritative (Codex round 1)', () => {
  async function load(project: Project): Promise<void> {
    expect(useStore.getState().applyProjectChange(() => ({
      ...project, id: useStore.getState().project.id,
    }))).toBe(true);
  }

  function drumClip(
    trackId: string, id: string, startBeat: number, lengthBeats: number, steps: number[],
    extra: Record<string, unknown> = {},
  ) {
    return {
      id, trackId, type: 'drum' as const, startBeat, lengthBeats, loop: false, stepsPerBar: 16,
      drumEvents: steps.map((stepIndex, i) => ({
        id: `${id}-e${i}`, lane: 'kick' as const, stepIndex, velocity: 100,
      })),
      ...extra,
    };
  }

  /** Resolved (live/WAV path) schedule, chords ignored, clip-end bookkeeping removed. */
  async function resolved(project: Project): Promise<string[]> {
    const { resolveDrumOccurrence } = await import('../src/audio/scheduler');
    return buildScheduleEvents({ ...project, chordTrack: [] }).flatMap((event) => {
      const r = resolveDrumOccurrence(event, event.beat);
      if (r === null) return [];
      const payload = { ...(r.payload as Record<string, unknown>) };
      delete payload.clipEndBeat;
      return [JSON.stringify({ beat: r.beat, payload })];
    }).sort();
  }

  it('refuses when a swung drum hit would disappear (raw 3.875 plays at 4)', async () => {
    const base = emptyProject();
    const drums = base.tracks.find((t) => t.type === 'drum')!;
    const project = withClip(base, drums.id, drumClip(drums.id, 'sw', 0.125, 8, [15], {
      drumGroove: { swing: 1, probability: 1, humanizeVelocity: 0, seed: 1 },
    }));
    expect(validateProject(project).errors).toEqual([]);
    await load(project);
    const before = useStore.getState();
    const result = actions.setStudioSongLengthBars(1);
    expect(result.ok).toBe(false);
    expect(useStore.getState().project).toBe(before.project);
  });

  it.each([0.5, 0.1, 0.25, 0])('refuses when a probability %s swung hit could be lost (potential events count)', async (probability) => {
    const base = emptyProject();
    const drums = base.tracks.find((t) => t.type === 'drum')!;
    const project = withClip(base, drums.id, drumClip(drums.id, 'pr', 0.125, 8, [15], {
      drumGroove: { swing: 1, probability, humanizeVelocity: 0, seed: 4 },
    }));
    expect(validateProject(project).errors).toEqual([]);
    await load(project);
    const before = useStore.getState();
    expect(actions.setStudioSongLengthBars(1).ok).toBe(false);
    expect(useStore.getState().project).toBe(before.project);
  });

  it('growth succeeds and stays valid when an alias onset already lies past the end', async () => {
    let project = createDefaultProject({ lengthBars: 4 });
    const added = addTimeSignatureMapEvent(project, { beat: 4, numerator: 6, denominator: 4 });
    if (!added.ok) throw new Error(added.error.message);
    const grown = setProjectLengthBars(added.project, 5);
    if (!grown.ok) throw new Error(grown.error.message);
    project = {
      ...grown.project,
      tracks: grown.project.tracks.map((t) => ({ ...t, clips: [] })),
      chordTrack: [], sections: [],
      // The groove resolver (default choke on) drops hits past a clip's end; the
      // legacy projection is what leaves a raw onset past the song end.
      hiHatChoke: false,
    };
    const drums = project.tracks.find((t) => t.type === 'drum')!;
    const alias = {
      id: 'als', trackId: drums.id, type: 'drum' as const, startBeat: 24, lengthBeats: 4,
      loop: false, aliasOf: 'src',
    };
    project = withClip(withClip(project, drums.id, drumClip(drums.id, 'src', 0, 4, [15])), drums.id, alias);
    expect(validateProject(project).errors).toEqual([]);
    // Pre-existing state: a raw onset at or past the song end.
    expect(buildScheduleEvents(project).some((e) => e.beat >= project.lengthBeats)).toBe(true);
    const result = setProjectLengthBars(project, project.lengthBars + 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateProject(result.project).errors).toEqual([]);
    await load(project);
    expect(actions.setStudioSongLengthBars(project.lengthBars + 2)).toMatchObject({ ok: true, changed: true });
    expect(validateProject(useStore.getState().project).errors).toEqual([]);
  });

  it('mixed meter alias: either refuses or leaves nothing past the new end and nothing lost', async () => {
    let project = createDefaultProject({ lengthBars: 4 });
    const added = addTimeSignatureMapEvent(project, { beat: 4, numerator: 6, denominator: 4 });
    if (!added.ok) throw new Error(added.error.message);
    const grown = setProjectLengthBars(added.project, 5);
    if (!grown.ok) throw new Error(grown.error.message);
    project = {
      ...grown.project,
      tracks: grown.project.tracks.map((t) => ({ ...t, clips: [] })),
      chordTrack: [], sections: [],
    };
    const drums = project.tracks.find((t) => t.type === 'drum')!;
    const alias = {
      id: 'als', trackId: drums.id, type: 'drum' as const, startBeat: 5, lengthBeats: 4,
      loop: false, aliasOf: 'src',
    };
    project = withClip(withClip(project, drums.id, drumClip(drums.id, 'src', 0, 4, [15])),
      drums.id, alias);
    expect(validateProject(project).errors).toEqual([]);
    await load(project);
    const original = await resolved(useStore.getState().project);
    const result = actions.setStudioSongLengthBars(2);
    if (!result.ok) return;
    const next = useStore.getState().project;
    expect(await resolved(next)).toEqual(original);
    for (const event of buildScheduleEvents(next)) {
      expect(event.beat).toBeLessThan(next.lengthBeats);
    }
    const { resolveDrumOccurrence } = await import('../src/audio/scheduler');
    for (const event of buildScheduleEvents(next)) {
      const r = resolveDrumOccurrence(event, event.beat);
      if (r !== null) expect(r.beat).toBeLessThan(next.lengthBeats);
    }
  });

  it('a length change commits an open gesture first; cancelling that gesture is then a no-op', async () => {
    const token = {};
    const before = useStore.getState();
    const lengthBefore = before.project.lengthBars;
    expect(before.beginProjectTransaction(token, 1)).toBe(true);
    const track = before.project.tracks.find((t) => t.type === 'instrument')!;
    expect(useStore.getState().applyProjectChange((p) => ({
      ...p, tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, volume: 0.4 } : t)),
    }))).toBe(true);
    const result = actions.setStudioSongLengthBars(lengthBefore + 1);
    expect(result.ok && result.changed).toBe(true);
    expect(useStore.getState().cancelProjectTransaction(token)).toBe(false);
    const after = useStore.getState();
    expect(after.project.lengthBars).toBe(lengthBefore + 1);
    expect(after.project.tracks.find((t) => t.id === track.id)!.volume).toBe(0.4);
    expect(after.past.length).toBe(before.past.length + 2);
    after.undo();
    expect(useStore.getState().project.lengthBars).toBe(lengthBefore);
    expect(useStore.getState().project.tracks.find((t) => t.id === track.id)!.volume).toBe(0.4);
    useStore.getState().undo();
    expect(useStore.getState().project.tracks.find((t) => t.id === track.id)!.volume).toBe(
      before.project.tracks.find((t) => t.id === track.id)!.volume,
    );
  });

  it('keeps playhead/loop/punch inside the song across shrink, undo and redo (derived from the project)', async () => {
    await load(emptyProject());
    const s0 = useStore.getState();
    expect(actions.setStudioSongLengthBars(4).ok).toBe(true);
    s0.undo();
    useStore.setState((s) => ({
      transport: { ...s.transport, positionBeat: 30, loopEnabled: true, loopStartBeat: 24, loopEndBeat: 32,
        punchEnabled: true, punchInBeat: 20, punchOutBeat: 30 },
    }));
    useStore.getState().redo();
    const t = useStore.getState().transport;
    expect(useStore.getState().project.lengthBeats).toBe(16);
    expect(t.positionBeat).toBeLessThanOrEqual(16);
    expect(t.loopEnabled).toBe(false);
    expect(t.loopEndBeat).toBeLessThanOrEqual(16);
    expect(t.punchEnabled).toBe(false);
    expect(t.punchOutBeat).toBeLessThanOrEqual(16);
  });
});

describe('setStudioSongLengthBars (store)', () => {
  function emptyTheStoreProject(): void {
    const project = useStore.getState().project;
    expect(useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, clips: [] })),
      chordTrack: [],
      sections: [],
    }))).toBe(true);
    expect(useStore.getState().project).not.toBe(project);
  }

  it('is exactly one Undo step and Undo restores the old length', () => {
    emptyTheStoreProject();
    const before = useStore.getState();
    const pastBefore = before.past.length;
    const result = actions.setStudioSongLengthBars(before.project.lengthBars + 2);
    expect(result.ok && result.changed).toBe(true);
    const after = useStore.getState();
    expect(after.past.length).toBe(pastBefore + 1);
    expect(after.project.lengthBars).toBe(before.project.lengthBars + 2);
    after.undo();
    expect(useStore.getState().project.lengthBars).toBe(before.project.lengthBars);
    expect(useStore.getState().project.lengthBeats).toBe(before.project.lengthBeats);
  });

  it('undo after shortening the default project from 8 to 4 bars is byte-identical', () => {
    expect(useStore.getState().applyProjectChange(() => ({
      ...createDefaultProject({ lengthBars: 8 }),
      id: useStore.getState().project.id,
    }))).toBe(true);
    const before = useStore.getState();
    const bytes = encodeProjectJson(before.project);
    expect(bytes.ok).toBe(true);
    const pastBefore = before.past.length;
    const result = actions.setStudioSongLengthBars(4);
    expect(result).toMatchObject({ ok: true, changed: true, trimmedClips: 2 });
    expect(useStore.getState().past.length).toBe(pastBefore + 1);
    expect(useStore.getState().project.lengthBars).toBe(4);
    useStore.getState().undo();
    // Main's undo re-stamps updatedAt; everything else must be byte-identical.
    const after = useStore.getState().project;
    expect(after.updatedAt >= before.project.updatedAt).toBe(true);
    const restored = encodeProjectJson({ ...after, updatedAt: before.project.updatedAt });
    expect(restored.ok && bytes.ok && restored.json).toBe(bytes.ok && bytes.json);
  });

  it("the app's real starting project goes from 8 to 4 bars and Undo restores it exactly", () => {
    const start = { ...createStudioStartingProject(), id: useStore.getState().project.id };
    expect(start.lengthBars).toBe(8);
    expect(start.chordTrack.length).toBeGreaterThan(0);
    expect(useStore.getState().applyProjectChange(() => start)).toBe(true);
    const before = useStore.getState();
    const bytes = JSON.stringify({ ...before.project, updatedAt: '' });
    const result = actions.setStudioSongLengthBars(4);
    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) return;
    expect(result.removedChords).toBe(start.chordTrack.filter((c) => c.startBeat >= 16).length);
    expect(result.removedChords).toBeGreaterThan(0);
    expect(actions.studioSongLengthStatusMessage(result)).toContain('を取り除きました(元に戻すで復元できます)');
    expect(useStore.getState().project.lengthBars).toBe(4);
    expect(validateProject(useStore.getState().project).errors).toEqual([]);
    expect(useStore.getState().past.length).toBe(before.past.length + 1);
    useStore.getState().undo();
    expect(JSON.stringify({ ...useStore.getState().project, updatedAt: '' })).toBe(bytes);
  });

  it('seeded fuzz: every accepted change is one Undo step and undo restores the exact project', () => {
    let seed = 0x51ed;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 25; round += 1) {
      const base = createDefaultProject({ lengthBars: 8 });
      const inst = instrumentOf(base);
      const note: [number, number] = [Math.floor(rand() * 12) / 2, 1];
      const project = withClip(
        { ...base, id: useStore.getState().project.id,
          tracks: base.tracks.map((t) => (t.id === inst.id ? { ...t, clips: [] } : t)) },
        inst.id, midiClip(inst.id, `f${round}`, Math.floor(rand() * 20), 8, rand() < 0.3, [note]),
      );
      if (validateProject(project).errors.length > 0) continue;
      expect(useStore.getState().applyProjectChange(() => project)).toBe(true);
      const settled = useStore.getState();
      const bytes = JSON.stringify({ ...settled.project, updatedAt: '' });
      const bars = 1 + Math.floor(rand() * 9);
      const result = actions.setStudioSongLengthBars(bars);
      if (result.ok && result.changed) {
        expect(useStore.getState().past.length).toBe(settled.past.length + 1);
        useStore.getState().undo();
      } else {
        expect(useStore.getState().past.length).toBe(settled.past.length);
      }
      expect(JSON.stringify({ ...useStore.getState().project, updatedAt: '' })).toBe(bytes);
    }
  });

  it('refuses shortening over content without changing state, with a Japanese reason', () => {
    const clipTrack = useStore.getState().project.tracks.find((t) => t.type === 'instrument')!;
    expect(useStore.getState().applyProjectChange((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === clipTrack.id
        ? { ...t, clips: [{
            id: 'held', trackId: t.id, type: 'midi' as const, startBeat: 0, lengthBeats: 32, loop: false,
            notes: [{ id: 'hn', pitch: 60, startBeat: 10, durationBeats: 1, velocity: 90 }],
          }] }
        : t)),
    }))).toBe(true);
    const before = useStore.getState();
    const result = actions.setStudioSongLengthBars(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('content-beyond-end');
    const message = actions.studioSongLengthErrorMessage(result.code, result.blockers);
    expect(message).toContain('音符');
    expect(message).toContain('変更しませんでした');
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);
  });

  it('refuses while recording and does not touch the project', () => {
    emptyTheStoreProject();
    useStore.setState({ audioRecordingOperationId: 7 });
    const before = useStore.getState();
    const result = actions.setStudioSongLengthBars(2);
    expect(result).toMatchObject({ ok: false, code: 'recording' });
    expect(useStore.getState().project).toBe(before.project);
    useStore.setState({ audioRecordingOperationId: null });
  });

  it('clamps the playhead and drops a loop that no longer fits after shortening', () => {
    emptyTheStoreProject();
    useStore.setState((s) => ({
      transport: { ...s.transport, positionBeat: 30, loopEnabled: true, loopStartBeat: 24, loopEndBeat: 32 },
    }));
    expect(actions.setStudioSongLengthBars(4).ok).toBe(true);
    const { transport, project } = useStore.getState();
    expect(project.lengthBeats).toBe(16);
    expect(transport.positionBeat).toBe(16);
    expect(transport.loopEnabled).toBe(false);
    expect(buildScheduleEvents(project)).toEqual(expect.any(Array));
  });
});
