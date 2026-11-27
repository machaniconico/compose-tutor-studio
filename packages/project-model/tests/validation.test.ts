import { describe, it, expect } from 'vitest';
import { createEmptyProject, expandClip, MAX_SOUNDING_EVENTS, validateProject } from '../src/index';
import type { Project } from '../src/index';

const clock = () => new Date('2026-06-11T00:00:00.000Z');

function baseProject(): Project {
  return createEmptyProject({ clock });
}

describe('validateProject', () => {
  it('passes a fresh empty project', () => {
    const result = validateProject(baseProject());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports a Japanese validation error for non-string saved presets', () => {
    const project = baseProject();
    for (const preset of [{ toString: null }, ['bell'], null, 42, true]) {
      const instrument = { type: 'synth', preset } as unknown as NonNullable<Project['tracks'][number]['instrument']>;
      const result = validateProject({ ...project, tracks: [{ ...project.tracks[0]!, instrument }, ...project.tracks.slice(1)] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'tracks[0].instrument.preset',
        message: expect.stringContaining('音色名は文字列にしてください'),
      });
    }
  });

  it('flags eq and compressor params outside their ranges', () => {
    const project = baseProject();
    const track = project.tracks[0]!;
    const withEffects = (params: Record<string, number>, type: 'eq' | 'compressor'): Project => ({
      ...project,
      tracks: [
        { ...track, effects: [{ id: `fx-${type}`, type, enabled: true, params }] },
        ...project.tracks.slice(1),
      ],
    });
    const paths = (p: Project) => validateProject(p).errors.map((e) => e.path);
    expect(paths(withEffects({ highGainDb: 13 }, 'eq'))).toContain(
      'tracks[0].effects[0].params.highGainDb',
    );
    expect(paths(withEffects({ ratio: 0.5 }, 'compressor'))).toContain(
      'tracks[0].effects[0].params.ratio',
    );
    expect(paths(withEffects({ highGainDb: 12, lowGainDb: -12 }, 'eq'))).toEqual([]);
    expect(paths(withEffects({ thresholdDb: -24, ratio: 3 }, 'compressor'))).toEqual([]);
  });

  it('flags swing outside 0..60', () => {
    const paths = (swing: number) =>
      validateProject({ ...baseProject(), swing }).errors.map((e) => e.path);
    expect(paths(61)).toContain('swing');
    expect(paths(-1)).toContain('swing');
    expect(paths(0)).toEqual([]);
    expect(paths(60)).toEqual([]);
  });

  it('flags a loopRange that does not move forward', () => {
    const paths = (loopRange: Project['loopRange']) =>
      validateProject({ ...baseProject(), loopRange }).errors.map((e) => e.path);
    expect(paths({ startBeat: 4, endBeat: 4 })).toContain('loopRange');
    expect(paths({ startBeat: 8, endBeat: 4 })).toContain('loopRange');
    expect(paths({ startBeat: -4, endBeat: 4 })).toContain('loopRange');
    expect(paths({ startBeat: 4, endBeat: 8 })).toEqual([]);
  });

  it('reports a null loopRange from a hand-edited file instead of crashing', () => {
    const project = { ...baseProject(), loopRange: null } as unknown as Project;
    expect(validateProject(project).errors.map((e) => e.path)).toContain('loopRange');
  });

  it('flags contentLengthBeats that is not positive', () => {
    const project = baseProject();
    const clip = project.tracks[0]?.clips[0];
    if (!clip) throw new Error('expected a default clip');
    clip.contentLengthBeats = 0;
    expect(validateProject(project).errors.map((e) => e.path)).toContain(
      'tracks[0].clips[0].contentLengthBeats',
    );
    clip.contentLengthBeats = 4;
    expect(validateProject(project).errors).toEqual([]);
  });

  it('flags an unknown track role', () => {
    const project = baseProject();
    const track = project.tracks[0];
    if (!track) throw new Error('expected a default track');
    (track as { role?: string }).role = 'vocal';
    expect(validateProject(project).errors.map((e) => e.path)).toContain('tracks[0].role');
    track.role = 'bass';
    expect(validateProject(project).errors).toEqual([]);
  });

  it('flags bpm out of range', () => {
    const low = { ...baseProject(), bpm: 10 };
    const high = { ...baseProject(), bpm: 400 };
    expect(validateProject(low).errors.some((e) => e.path === 'bpm')).toBe(true);
    expect(validateProject(high).errors.some((e) => e.path === 'bpm')).toBe(true);
    expect(validateProject({ ...baseProject(), bpm: 20 }).valid).toBe(true);
    expect(validateProject({ ...baseProject(), bpm: 300 }).valid).toBe(true);
  });

  it('flags invalid time signature denominator', () => {
    const project: Project = { ...baseProject(), timeSignature: [4, 3] };
    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'timeSignature[1]')).toBe(true);
  });

  it('accepts allowed denominators', () => {
    for (const den of [2, 4, 8, 16] as const) {
      const project: Project = { ...baseProject(), timeSignature: [4, den] };
      expect(validateProject(project).valid).toBe(true);
    }
  });

  it('flags pitch and velocity out of range', () => {
    const project = baseProject();
    const track = project.tracks[0]!;
    const clip = track.clips[0]!;
    clip.notes = [
      { id: 'n1', pitch: 200, startBeat: 0, durationBeats: 1, velocity: 100 },
      { id: 'n2', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0 },
    ];
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path.endsWith('.pitch'))).toBe(true);
    expect(result.errors.some((e) => e.path.endsWith('.velocity'))).toBe(true);
  });

  it('flags pan and volume out of range', () => {
    const project = baseProject();
    project.tracks[0]!.pan = 2;
    project.tracks[1]!.volume = 5;
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path === 'tracks[0].pan')).toBe(true);
    expect(result.errors.some((e) => e.path === 'tracks[1].volume')).toBe(true);
  });

  it('flags non-positive chord duration', () => {
    const project = baseProject();
    project.chordTrack = [
      { id: 'c1', startBeat: 0, durationBeats: 0, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] },
    ];
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path === 'chordTrack[0].durationBeats')).toBe(true);
  });

  it('flags negative clip start', () => {
    const project = baseProject();
    project.tracks[0]!.clips[0]!.startBeat = -1;
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path.endsWith('.startBeat'))).toBe(true);
  });

  it('detects duplicate ids', () => {
    const project = baseProject();
    project.tracks[1]!.id = project.tracks[0]!.id;
    const result = validateProject(project);
    expect(result.errors.some((e) => e.message.includes('duplicate id'))).toBe(true);
  });

  it('detects clip.trackId mismatch', () => {
    const project = baseProject();
    project.tracks[0]!.clips[0]!.trackId = 'nonexistent';
    const result = validateProject(project);
    expect(result.errors.some((e) => e.path.endsWith('.trackId'))).toBe(true);
  });
});

describe('validateProject: project sound limit', () => {
  function withLoop(lengthBeats: number, contentLengthBeats: number): Project {
    const project = baseProject();
    const ti = project.tracks.findIndex((t) => t.type !== 'drum' && t.clips.length > 0);
    const track = project.tracks[ti]!;
    const clip = {
      ...track.clips[0]!,
      lengthBeats,
      contentLengthBeats,
      loop: true,
      aliasOf: undefined,
      notes: [{ id: 'loop-note', pitch: 60, startBeat: 0, durationBeats: contentLengthBeats / 2, velocity: 100 }],
    };
    const tracks = project.tracks.map((t, i) => (i === ti ? { ...t, clips: [clip] } : t));
    return { ...project, tracks };
  }

  it('rejects a loop whose period is below the minimum', () => {
    const result = validateProject(withLoop(128, 1 / 1024));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.endsWith('.contentLengthBeats'))).toBe(true);
  });

  it('accepts a loop whose last repeat is cut by the clip end (length 4, period 3, 50,001 notes at beat 2)', () => {
    const project = withLoop(4, 3);
    const ti = project.tracks.findIndex((t) => t.clips[0]?.notes?.[0]?.id === 'loop-note');
    const clip = project.tracks[ti]!.clips[0]!;
    const notes = Array.from({ length: 50_001 }, (_, i) => ({
      id: `n${i}`,
      pitch: 60,
      startBeat: 2,
      durationBeats: 0.5,
      velocity: 100,
    }));
    const tracks = project.tracks.map((t, i) => (i === ti ? { ...t, clips: [{ ...clip, notes }] } : t));
    expect(validateProject({ ...project, tracks }).errors).toEqual([]);
  });

  it('rejects a one-period loop whose first period exceeds the sound limit', () => {
    const project = withLoop(4, 4);
    const clip = project.tracks.find((t) => t.clips[0]?.notes?.[0]?.id === 'loop-note')!.clips[0]!;
    const note = clip.notes![0]!;
    clip.notes = Array.from({ length: MAX_SOUNDING_EVENTS + 1 }, (_, i) => ({ ...note, id: `n${i}` }));
    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path === 'tracks')).toBe(true);
  });

  it('accepts a loop covering the song at the minimum period', () => {
    const project = withLoop(32, 1 / 64);
    expect(validateProject(project).errors).toEqual([]);
    const allClips = project.tracks.flatMap((t) => t.clips);
    const track = project.tracks.find((t) => t.clips[0]?.notes?.[0]?.id === 'loop-note')!;
    const result = expandClip(track.clips[0]!, allClips, 4, track.type);
    expect(result.notes).toHaveLength(2048);
    expect(result.problems).toEqual([]);
  });

  describe('instrument macros', () => {
    const withMacros = (macros: unknown): Project => {
      const project = baseProject();
      const index = project.tracks.findIndex((t) => t.instrument?.type === 'synth');
      const track = project.tracks[index]!;
      const tracks = [...project.tracks];
      tracks[index] = {
        ...track,
        instrument: { ...track.instrument!, macros: macros as NonNullable<typeof track.instrument>['macros'] },
      };
      return { ...project, tracks };
    };
    const ok = { brightness: 0, release: 1, width: 0.5, attack: 0.25 };

    it.each([[null], ['bright'], [0.5], [[0.5, 0.5, 0.5, 0.5]]])('reports macros = %j as an error instead of crashing', (macros) => {
      const result = validateProject(withMacros(macros));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path.endsWith('instrument.macros') && e.message.includes('0〜1'))).toBe(true);
    });

    it('accepts macros inside 0..1 (bounds included) and tracks without macros', () => {
      expect(validateProject(withMacros(ok)).valid).toBe(true);
      expect(validateProject(withMacros({ brightness: 1, release: 0, width: 0, attack: 1 })).valid).toBe(true);
      expect(validateProject(baseProject()).valid).toBe(true);
    });

    it.each([
      ['brightness', -0.01],
      ['release', 1.01],
      ['width', Number.NaN],
      ['attack', Number.POSITIVE_INFINITY],
      ['width', '0.5'],
      ['release', undefined],
    ])('flags %s = %s with a Japanese message', (key, value) => {
      const result = validateProject(withMacros({ ...ok, [key]: value }));
      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.path.endsWith(`instrument.macros.${key}`));
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/0〜1/);
    });

    it('reports a macro value whose toString is null without throwing', () => {
      const macros = { brightness: { toString: null }, release: 0.5, width: 0, attack: 0.5 };
      const result = validateProject(withMacros(macros));
      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.path.endsWith('instrument.macros.brightness'));
      expect(error!.message).toContain('(現在: object)');
    });

    it('reports macros whose toString is null without throwing', () => {
      const result = validateProject(withMacros(Object.assign([], { toString: null })));
      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.path.endsWith('instrument.macros'));
      expect(error!.message).toContain('(現在: object)');
    });

    it.each([
      [Number.NaN, 'NaN'],
      [2, '2'],
      [null, 'null'],
      ['0.5', 'string'],
      [undefined, 'undefined'],
    ])('describes a bad macro value %s as %s', (value, shown) => {
      const result = validateProject(withMacros({ ...ok, width: value }));
      const error = result.errors.find((e) => e.path.endsWith('instrument.macros.width'));
      expect(error!.message).toContain(`(現在: ${shown})`);
    });

    it('describes non-object macros by their type', () => {
      expect(validateProject(withMacros(null)).errors[0]!.message).toContain('(現在: null)');
      expect(validateProject(withMacros('bright')).errors[0]!.message).toContain('(現在: string)');
    });
  });
});
