import { describe, expect, it } from 'vitest';
import { duplicateClip, type ChordEvent, type Project } from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';
import {
  analyzeProjectForCoaching,
  coachCategoryLabel,
  melodyNotesOnProjectTimeline,
  type CoachSuggestion,
} from '../src/state/coach';

/** Deep clone a project so fixtures never share mutable state. */
function clone(project: Project): Project {
  return structuredClone(project);
}

/** Build a bare ChordEvent for the fixtures. */
function chord(symbol: string, startBeat: number): ChordEvent {
  return {
    id: `c-${symbol}-${startBeat}`,
    startBeat,
    durationBeats: 4,
    symbol,
    root: symbol.replace(/m.*$/, '').replace(/[0-9].*$/, ''),
    quality: symbol.includes('m') ? 'minor' : 'major',
    notes: [],
  };
}

function ids(suggestions: CoachSuggestion[]): string[] {
  return suggestions.map((s) => s.id);
}

describe('analyzeProjectForCoaching', () => {
  it('returns well-formed suggestions for the default project', () => {
    const suggestions = analyzeProjectForCoaching(createDefaultProject());
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(s.id).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.detail).toBeTruthy();
      expect(['progression', 'melody', 'arrangement', 'mix']).toContain(s.category);
      expect(['good', 'tip', 'warn']).toContain(s.severity);
    }
  });

  it('is deterministic (same project => same suggestions)', () => {
    const project = createDefaultProject();
    const a = analyzeProjectForCoaching(project);
    const b = analyzeProjectForCoaching(clone(project));
    expect(ids(a)).toEqual(ids(b));
  });

  it('suggests starting a progression when the chord track is empty', () => {
    const project = clone(createDefaultProject());
    project.chordTrack = [];
    const suggestions = analyzeProjectForCoaching(project);
    expect(ids(suggestions)).toContain('prog-empty');
  });

  it('praises a progression that ends on the tonic', () => {
    const project = clone(createDefaultProject());
    project.key = 'C' as Project['key'];
    project.chordTrack = [chord('C', 0), chord('G', 4), chord('Am', 8), chord('C', 12)];
    const suggestions = analyzeProjectForCoaching(project);
    expect(ids(suggestions)).toContain('prog-cadence-good');
    expect(ids(suggestions)).not.toContain('prog-cadence');
  });

  it('nudges resolution when a long progression ends off the tonic', () => {
    const project = clone(createDefaultProject());
    project.key = 'C' as Project['key'];
    project.chordTrack = [chord('C', 0), chord('G', 4), chord('F', 8)];
    const suggestions = analyzeProjectForCoaching(project);
    expect(ids(suggestions)).toContain('prog-cadence');
  });

  it('suggests adding a melody when the melody track is empty', () => {
    const project = clone(createDefaultProject());
    for (const track of project.tracks) {
      if (track.name.toLowerCase() === 'melody') {
        track.clips = track.clips.map((c) => ({ ...c, notes: [] }));
      }
    }
    const suggestions = analyzeProjectForCoaching(project);
    expect(ids(suggestions)).toContain('melody-empty');
  });

  it('resolves linked melody instances at their absolute project beats', () => {
    const project = clone(createDefaultProject());
    const melodyTrack = project.tracks.find(
      (track) => track.name.toLowerCase() === 'melody',
    );
    const source = melodyTrack?.clips[0];
    expect(melodyTrack).toBeTruthy();
    expect(source).toBeTruthy();
    if (!melodyTrack || !source) return;

    source.startBeat = 4;
    source.lengthBeats = 4;
    source.notes = [
      {
        id: 'linked-melody-note',
        pitch: 71,
        startBeat: 0,
        durationBeats: 1,
        velocity: 100,
      },
    ];
    project.chordTrack = [chord('C', 0), chord('G', 4), chord('G', 8)];

    const linked = duplicateClip(project, source.id, {
      id: 'linked-melody-instance',
      startBeat: 8,
      linked: true,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    const linkedTrack = linked.project.tracks.find(
      (track) => track.id === melodyTrack.id,
    );

    expect(melodyNotesOnProjectTimeline(linked.project, linkedTrack)).toEqual([
      { pitch: 71, startBeat: 4, durationBeats: 1 },
      { pitch: 71, startBeat: 8, durationBeats: 1 },
    ]);
    const suggestionIds = ids(analyzeProjectForCoaching(linked.project));
    expect(suggestionIds).toContain('melody-good');
    expect(suggestionIds).not.toContain('melody-empty');
    expect(suggestionIds).not.toContain('melody-warn');
  });

  it('suggests adding drums when the drum track is truly empty', () => {
    const project = clone(createDefaultProject());
    const drumTrack = project.tracks.find((t) => t.type === 'drum');
    expect(drumTrack).toBeTruthy();
    if (drumTrack) {
      drumTrack.clips = drumTrack.clips.map((c) => ({ ...c, notes: [], drumEvents: [] }));
    }

    const suggestions = analyzeProjectForCoaching(project);
    expect(ids(suggestions)).toContain('arr-drums');
  });

  it('does not suggest empty drums when drum clips contain drumEvents', () => {
    const project = clone(createDefaultProject());
    const drumTrack = project.tracks.find((t) => t.type === 'drum');
    expect(drumTrack).toBeTruthy();
    if (drumTrack) {
      drumTrack.clips = drumTrack.clips.map((c, index) => ({
        ...c,
        notes: [],
        drumEvents:
          index === 0
            ? [{ id: 'kick-1', lane: 'kick', stepIndex: 0, velocity: 96 }]
            : [],
      }));
    }

    const suggestions = analyzeProjectForCoaching(project);
    expect(ids(suggestions)).not.toContain('arr-drums');
  });

  it('never throws on unknown chord symbols', () => {
    const project = clone(createDefaultProject());
    project.chordTrack = [chord('??', 0), chord('Xyz7', 4), chord('C', 8)];
    expect(() => analyzeProjectForCoaching(project)).not.toThrow();
  });

  it('exposes Japanese category labels', () => {
    expect(coachCategoryLabel('progression')).toBe('コード進行');
    expect(coachCategoryLabel('melody')).toBe('メロディ');
  });
});
