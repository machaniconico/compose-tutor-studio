import { describe, it, expect } from 'vitest';
import {
  PROJECT_TEMPLATES,
  instantiateTemplate,
  validateProject,
  projectLengthBeats,
  beatToSeconds,
  type TemplateId,
} from '../src/index';

const clock = () => new Date('2026-06-11T00:00:00.000Z');

const ALL_IDS: TemplateId[] = [
  '8bar-pop',
  '16bar-pop',
  'bgm-loop',
  'jingle-15s',
  'jingle-30s',
  'jingle-60s',
  'lofi-chill',
  'game-loop',
];

describe('PROJECT_TEMPLATES', () => {
  it('defines all expected templates with Japanese metadata', () => {
    for (const id of ALL_IDS) {
      const template = PROJECT_TEMPLATES[id];
      expect(template).toBeDefined();
      expect(template.id).toBe(id);
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      // Contains at least one Japanese (kana/kanji) character.
      expect(/[぀-ヿ一-龯]/.test(template.name)).toBe(true);
    }
  });
});

describe('instantiateTemplate', () => {
  it('produces a valid project for every template', () => {
    for (const id of ALL_IDS) {
      const project = instantiateTemplate(id, clock);
      const result = validateProject(project);
      expect(result.errors, `template ${id} should be valid`).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it('carries the template tempo/key/length onto the project', () => {
    const project = instantiateTemplate('lofi-chill', clock);
    expect(project.bpm).toBe(82);
    expect(project.lengthBars).toBe(8);
    expect(project.title).toBe('Lo-fiチル');
  });

  it('fills the chord track across the full length', () => {
    const project = instantiateTemplate('8bar-pop', clock);
    expect(project.chordTrack.length).toBeGreaterThan(0);
    // chords are contiguous starting at 0, covering the whole project
    const last = project.chordTrack[project.chordTrack.length - 1]!;
    const covered = last.startBeat + last.durationBeats;
    expect(covered).toBe(projectLengthBeats(project));
    // first chord of an I-V-vi-IV pop template is C major (pitch classes 0,4,7)
    expect(project.chordTrack[0]!.symbol).toBe('C');
    expect(project.chordTrack[0]!.notes).toEqual([0, 4, 7]);
  });

  it('computes dominant7 chord notes as MIDI pitch classes', () => {
    const project = instantiateTemplate('jingle-15s', clock);
    const g7 = project.chordTrack.find((c) => c.symbol === 'G7');
    expect(g7).toBeDefined();
    // G dominant7 = G B D F = pitch classes 7,11,2,5
    expect(g7!.notes).toEqual([7, 11, 2, 5]);
  });

  it('adds a drum pattern to the drum track', () => {
    const project = instantiateTemplate('game-loop', clock);
    const drumTrack = project.tracks.find((t) => t.type === 'drum')!;
    const drumClip = drumTrack.clips[0]!;
    expect(drumClip.drumEvents!.length).toBeGreaterThan(0);
    // pattern repeats every bar, so events scale with lengthBars
    const lanes = new Set(drumClip.drumEvents!.map((e) => e.lane));
    expect(lanes.has('kick')).toBe(true);
    expect(lanes.has('snare')).toBe(true);
  });

  it('builds the 60-second jingle as 32 bars lasting about 60 seconds', () => {
    const template = PROJECT_TEMPLATES['jingle-60s'];
    expect(template.lengthBars).toBe(32);

    const project = instantiateTemplate('jingle-60s', clock);
    expect(project.lengthBars).toBe(32);

    // Duration in seconds = total quarter-note beats * seconds per beat.
    const seconds = projectLengthBeats(project) * beatToSeconds(project.bpm);
    // 32 bars of 4/4 at 128 BPM = 128 beats * (60 / 128) s = exactly 60 s.
    expect(seconds).toBeGreaterThanOrEqual(55);
    expect(seconds).toBeLessThanOrEqual(65);
    expect(seconds).toBeCloseTo(60, 5);

    // Chord track and drums cover the whole 60 seconds.
    const last = project.chordTrack[project.chordTrack.length - 1]!;
    expect(last.startBeat + last.durationBeats).toBe(projectLengthBeats(project));
  });

  it('throws for unknown template ids', () => {
    // @ts-expect-error testing runtime guard
    expect(() => instantiateTemplate('nope')).toThrow();
  });
});
