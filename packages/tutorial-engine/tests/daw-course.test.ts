import { describe, expect, it } from 'vitest';
import { DAW_COURSE, DAW_LESSONS } from '../src/content/daw-course.js';
import { checkGoalOnEvent } from '../src/goals.js';
import { TutorialEngine } from '../src/engine.js';
import type { AppEvent, AppEventType } from '../src/types.js';
import { makeProject } from './helpers.js';

const project = makeProject();

const trackAdded = (trackType: string): AppEvent => (
  { type: 'track.added', payload: { trackId: 't1', trackName: 'Hook', trackType } }
);
const clipSplit: AppEvent = { type: 'clip.split', payload: { trackId: 't1', clipId: 'a', rightClipId: 'b' } };
const lengthChanged: AppEvent = { type: 'song.lengthChanged', payload: { lengthBars: 12 } };
const noteAdded: AppEvent = {
  type: 'note.added',
  payload: { pitch: 60, startBeat: 0, durationBeats: 1, trackId: 't1', trackName: 'Melody', inScale: true },
};
const quantized: AppEvent = { type: 'notes.quantized', payload: { clipId: 'a', noteCount: 1 } };
const played: AppEvent = { type: 'transport.played', payload: { positionBeats: 0 } };
const chordAdded: AppEvent = { type: 'chord.added', payload: { bar: 0, chordSymbol: 'C' } };
const accompaniment: AppEvent = { type: 'accompaniment.created', payload: { trackId: 't2', noteCount: 8 } };
const effectAdded = (effectType: string): AppEvent => (
  { type: 'effect.added', payload: { trackId: 't1', trackName: 'Hook', effectType } }
);
const volumeChanged: AppEvent = { type: 'track.volumeChanged', payload: { trackId: 't1', trackName: 'Hook', volume: 0.5 } };
const wav = (sampleRate: number, bitDepth: number): AppEvent => (
  { type: 'export.wav', payload: { format: 'wav', sampleRate, bitDepth } }
);

function play(lessonId: string, events: AppEvent[]): TutorialEngine {
  const lesson = DAW_LESSONS.find((l) => l.id === lessonId)!;
  const engine = new TutorialEngine();
  engine.loadLesson(lesson);
  for (const event of events) engine.handleEvent(event, project);
  return engine;
}

describe('DAW course structure', () => {
  it('has four lessons whose goals are all event-based (no hidden project state)', () => {
    expect(DAW_COURSE.lessonIds).toEqual([
      'daw-tracks-clips',
      'daw-edit-notes',
      'daw-accompaniment',
      'daw-mix-export',
    ]);
    for (const lesson of DAW_LESSONS) {
      expect(lesson.courseId).toBe(DAW_COURSE.id);
      for (const step of lesson.steps) expect(step.goal.kind, step.id).toBe('event');
    }
  });

  it('only uses events the app really publishes (no clip.created / section.* / loop.* / recording.*)', () => {
    const allowed = new Set<AppEventType>([
      'track.added', 'clip.split', 'song.lengthChanged', 'note.added', 'notes.quantized',
      'transport.played', 'chord.added', 'accompaniment.created', 'effect.added',
      'track.volumeChanged', 'export.wav',
    ]);
    for (const lesson of DAW_LESSONS) {
      for (const step of lesson.steps) {
        if (step.goal.kind !== 'event') continue;
        expect(allowed.has(step.goal.eventType), `${step.id}: ${step.goal.eventType}`).toBe(true);
      }
    }
  });

  it('does not name any commercial DAW', () => {
    const text = JSON.stringify(DAW_LESSONS);
    for (const name of ['Ableton', 'Logic', 'Cubase', 'FL Studio', 'GarageBand', 'Pro Tools', 'Reaper', 'Studio One']) {
      expect(text).not.toContain(name);
    }
  });
});

describe('DAW course step progression', () => {
  it('daw-tracks-clips advances only on an instrument track, a split, and a length change', () => {
    const engine = play('daw-tracks-clips', [trackAdded('drum'), clipSplit, lengthChanged]);
    expect(engine.getState()).toMatchObject({ stepIndex: 0, status: 'inProgress' });

    engine.handleEvent(trackAdded('instrument'), project);
    expect(engine.getState().stepIndex).toBe(1);
    engine.handleEvent(lengthChanged, project);
    expect(engine.getState().stepIndex).toBe(1);
    engine.handleEvent(clipSplit, project);
    expect(engine.getState().stepIndex).toBe(2);
    const last = engine.handleEvent(lengthChanged, project);
    expect(last.completedLesson).toBe(true);
    expect(engine.getState().status).toBe('completed');
  });

  it('daw-edit-notes completes in order and ignores out-of-order events', () => {
    const engine = play('daw-edit-notes', [quantized, played]);
    expect(engine.getState().stepIndex).toBe(0);
    engine.handleEvent(noteAdded, project);
    engine.handleEvent(played, project);
    expect(engine.getState().stepIndex).toBe(1);
    engine.handleEvent(quantized, project);
    expect(engine.getState().stepIndex).toBe(2);
    engine.handleEvent(played, project);
    expect(engine.getState().status).toBe('completed');
  });

  it('daw-accompaniment needs chords, then the accompaniment, then playback', () => {
    const engine = play('daw-accompaniment', [accompaniment, played]);
    expect(engine.getState().stepIndex).toBe(0);
    engine.handleEvent(chordAdded, project);
    engine.handleEvent(accompaniment, project);
    engine.handleEvent(played, project);
    expect(engine.getState().status).toBe('completed');
  });

  it('daw-mix-export requires an equalizer and a 24 bit WAV (16 bit does not count)', () => {
    const engine = play('daw-mix-export', [effectAdded('reverb')]);
    expect(engine.getState().stepIndex).toBe(0);
    engine.handleEvent(effectAdded('eq'), project);
    engine.handleEvent(volumeChanged, project);
    expect(engine.getState().stepIndex).toBe(2);
    engine.handleEvent(wav(48000, 16), project);
    expect(engine.getState()).toMatchObject({ stepIndex: 2, status: 'inProgress' });
    engine.handleEvent({ type: 'export.wav', payload: { format: 'wav' } }, project);
    expect(engine.getState().status).toBe('inProgress');
    engine.handleEvent(wav(44100, 24), project);
    expect(engine.getState().status).toBe('completed');
  });

  it('is deterministic: the same events give the same state every time', () => {
    const events = [trackAdded('instrument'), clipSplit, lengthChanged];
    const a = play('daw-tracks-clips', events).getState();
    const b = play('daw-tracks-clips', events).getState();
    expect(a).toEqual(b);
  });
});

describe('event matching for new fields', () => {
  const goal = { kind: 'event', eventType: 'export.wav', match: { bitDepth: 24 } } as const;

  it('matches bitDepth and sampleRate exactly', () => {
    expect(checkGoalOnEvent(goal, wav(48000, 24), project, 0).satisfied).toBe(true);
    expect(checkGoalOnEvent(goal, wav(48000, 16), project, 0).satisfied).toBe(false);
    const rate = { kind: 'event', eventType: 'export.wav', match: { sampleRate: 48000 } } as const;
    expect(checkGoalOnEvent(rate, wav(48000, 16), project, 0).satisfied).toBe(true);
    expect(checkGoalOnEvent(rate, wav(44100, 16), project, 0).satisfied).toBe(false);
  });

  it('does not read inherited properties of the payload', () => {
    const inherited = Object.create({ bitDepth: 24, format: 'wav' }) as { format: 'wav'; bitDepth?: number };
    inherited.format = 'wav';
    const event = { type: 'export.wav', payload: inherited } as AppEvent;
    expect(checkGoalOnEvent(goal, event, project, 0).satisfied).toBe(false);
  });

  it('matches trackType only when the payload carries it', () => {
    const g = { kind: 'event', eventType: 'track.added', match: { trackType: 'instrument' } } as const;
    expect(checkGoalOnEvent(g, trackAdded('instrument'), project, 0).satisfied).toBe(true);
    expect(checkGoalOnEvent(g, trackAdded('drum'), project, 0).satisfied).toBe(false);
  });
});

describe('quantize step names the real off-grid action', () => {
  it('tells the learner to Shift-drag a selected note, then press クオンタイズ', () => {
    const step = DAW_LESSONS.find((l) => l.id === 'daw-edit-notes')!.steps.find((s) => s.id === 'daw-edit-notes-s2')!;
    expect(step.instruction).toContain('Shift');
    expect(step.instruction).toContain('ドラッグ');
    expect(step.instruction).toContain('「クオンタイズ」');
    expect(step.hints.join('\n')).toContain('吸い付く');
  });
});

describe('hostile event payloads never throw and never match', () => {
  const goals = [
    { kind: 'event', eventType: 'track.added', match: { trackType: 'instrument' } },
    { kind: 'event', eventType: 'export.wav', match: { format: 'wav', bitDepth: 24, sampleRate: 48000 } },
    { kind: 'event', eventType: 'drum.grooveChanged', match: { swingAtLeast: 0.1 } },
    { kind: 'event', eventType: 'chord.added', match: { chordSymbol: 'C' } },
  ] as const;

  const throwing = (): Record<string, unknown> => Object.defineProperties({}, {
    trackType: { enumerable: true, get() { throw new Error('boom'); } },
    format: { enumerable: true, get() { throw new Error('boom'); } },
    swing: { enumerable: true, get() { throw new Error('boom'); } },
    chordSymbol: { enumerable: true, get() { throw new Error('boom'); } },
  });
  const proxy = (): unknown => new Proxy({}, {
    get() { throw new Error('boom'); },
    has() { throw new Error('boom'); },
    getOwnPropertyDescriptor() { throw new Error('boom'); },
  });
  const revoked = (): unknown => {
    const r = Proxy.revocable({}, {});
    r.revoke();
    return r.proxy;
  };
  const payloads: unknown[] = [
    null, undefined, 0, 1, 'text', true, Symbol('x'), 10n, () => 1, [], [1, 2], ['instrument'],
    throwing(), proxy(), revoked(), Object.create(null), { trackType: { toString: null } },
    Object.create({ trackType: 'instrument', bitDepth: 24, format: 'wav', sampleRate: 48000 }),
  ];

  it('treats every non-object, array, throwing getter, and Proxy payload as a non-match', () => {
    for (const goal of goals) {
      for (const payload of payloads) {
        const event = { type: goal.eventType, payload } as unknown as AppEvent;
        expect(() => checkGoalOnEvent(goal, event, project, 0)).not.toThrow();
        expect(checkGoalOnEvent(goal, event, project, 0).satisfied).toBe(false);
      }
    }
  });

  it('survives hostile events themselves and a seeded random mix of values', () => {
    const hostileEvent = new Proxy({}, { get() { throw new Error('boom'); } }) as unknown as AppEvent;
    for (const event of [null as unknown as AppEvent, hostileEvent, {} as AppEvent]) {
      for (const goal of goals) {
        expect(() => checkGoalOnEvent(goal, event, project, 0)).not.toThrow();
        expect(checkGoalOnEvent(goal, event, project, 0).satisfied).toBe(false);
      }
    }
    let seed = 0x60d4;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000;
    const values = [null, undefined, NaN, -1, 24, 48000, 'instrument', 'wav', {}, [], throwing(), proxy()];
    for (let i = 0; i < 300; i += 1) {
      const payload: Record<string, unknown> = {};
      for (const key of ['trackType', 'format', 'bitDepth', 'sampleRate', 'swing', 'chordSymbol']) {
        if (next() < 0.7) payload[key] = values[Math.floor(next() * values.length)];
      }
      for (const goal of goals) {
        const event = { type: goal.eventType, payload } as unknown as AppEvent;
        expect(() => checkGoalOnEvent(goal, event, project, 0)).not.toThrow();
      }
    }
  });

  it('still matches a well-formed payload after a hostile one', () => {
    const goal = goals[0];
    expect(checkGoalOnEvent(goal, trackAdded('instrument'), project, 0).satisfied).toBe(true);
  });
});
