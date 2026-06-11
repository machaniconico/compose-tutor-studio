import { describe, it, expect } from 'vitest';
import {
  createEmptyProject,
  addChordEvent,
  updateChordEvent,
  removeChordEvent,
  addNoteToClip,
  updateNote,
  removeNote,
  toggleDrumStep,
  setTrackVolume,
  setTrackPan,
  setTrackMute,
  setTrackSolo,
  addSection,
  updateSection,
} from '../src/index';
import type { Project } from '../src/index';

const t0 = () => new Date('2026-06-11T00:00:00.000Z');
const t1 = () => new Date('2026-06-11T01:00:00.000Z');

function base(): Project {
  return createEmptyProject({ clock: t0 });
}

describe('mutation immutability and updatedAt', () => {
  it('does not mutate the input and bumps updatedAt', () => {
    const project = base();
    const next = setTrackVolume(project, project.tracks[0]!.id, 0.5, t1);
    expect(next).not.toBe(project);
    expect(project.tracks[0]!.volume).toBe(1); // original untouched
    expect(next.tracks[0]!.volume).toBe(0.5);
    expect(next.updatedAt).toBe('2026-06-11T01:00:00.000Z');
    expect(project.updatedAt).toBe('2026-06-11T00:00:00.000Z');
  });
});

describe('chord mutations', () => {
  it('adds, updates, and removes chord events', () => {
    const project = base();
    const added = addChordEvent(
      project,
      { startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] },
      t1,
    );
    expect(added.chordTrack).toHaveLength(1);
    const id = added.chordTrack[0]!.id;
    expect(id).toBeTruthy();

    const updated = updateChordEvent(added, id, { symbol: 'Cmaj7', notes: [0, 4, 7, 11] }, t1);
    expect(updated.chordTrack[0]!.symbol).toBe('Cmaj7');
    expect(updated.chordTrack[0]!.notes).toEqual([0, 4, 7, 11]);

    const removed = removeChordEvent(updated, id, t1);
    expect(removed.chordTrack).toHaveLength(0);
  });
});

describe('note mutations', () => {
  it('adds, updates, and removes notes within a clip', () => {
    const project = base();
    const clipId = project.tracks[2]!.clips[0]!.id; // Melody clip
    const added = addNoteToClip(
      project,
      clipId,
      { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
      t1,
    );
    const clip = added.tracks[2]!.clips[0]!;
    expect(clip.notes).toHaveLength(1);
    const noteId = clip.notes![0]!.id;

    const updated = updateNote(added, clipId, noteId, { pitch: 62 }, t1);
    expect(updated.tracks[2]!.clips[0]!.notes![0]!.pitch).toBe(62);

    const removed = removeNote(updated, clipId, noteId, t1);
    expect(removed.tracks[2]!.clips[0]!.notes).toHaveLength(0);
  });
});

describe('toggleDrumStep', () => {
  it('toggles a drum step on and off', () => {
    const project = base();
    const drumClipId = project.tracks[3]!.clips[0]!.id;

    const on = toggleDrumStep(project, drumClipId, 'kick', 0, 110, t1);
    const events = on.tracks[3]!.clips[0]!.drumEvents!;
    expect(events).toHaveLength(1);
    expect(events[0]!.lane).toBe('kick');
    expect(events[0]!.stepIndex).toBe(0);
    expect(events[0]!.velocity).toBe(110);

    const off = toggleDrumStep(on, drumClipId, 'kick', 0, 110, t1);
    expect(off.tracks[3]!.clips[0]!.drumEvents).toHaveLength(0);
  });
});

describe('mixer mutations', () => {
  it('sets pan, mute, and solo', () => {
    const project = base();
    const id = project.tracks[1]!.id;
    expect(setTrackPan(project, id, -0.5, t1).tracks[1]!.pan).toBe(-0.5);
    expect(setTrackMute(project, id, true, t1).tracks[1]!.mute).toBe(true);
    expect(setTrackSolo(project, id, true, t1).tracks[1]!.solo).toBe(true);
  });
});

describe('section mutations', () => {
  it('adds and updates sections', () => {
    const project = base();
    const added = addSection(
      project,
      { name: 'Intro', type: 'intro', startBar: 0, lengthBars: 2 },
      t1,
    );
    expect(added.sections).toHaveLength(1);
    const id = added.sections[0]!.id;
    const updated = updateSection(added, id, { lengthBars: 4 }, t1);
    expect(updated.sections[0]!.lengthBars).toBe(4);
  });
});
