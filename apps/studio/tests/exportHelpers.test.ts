import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './localStorageStub';
import { projectToMidi } from '@cts/midi-io';
import {
  PROJECT_TEMPLATES,
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

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('テスト')).toBe(true);
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

describe('project file round-trip into store', () => {
  it('serializes then deserializes + loads an equivalent project', async () => {
    const original = createDefaultProject('丸ごと往復');
    await useStore.getState().replaceProject(original);

    const json = serializeProject(useStore.getState().project);
    const loaded = deserializeProject(json);
    expect(validateProject(loaded).ok).toBe(true);

    // Replace into the store and confirm key fields survived the round trip.
    await useStore.getState().replaceProject(loaded);
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

  it('loads a template into the store via replaceProject', async () => {
    const project = instantiateTemplate('8bar-pop');
    await useStore.getState().replaceProject(project);
    const inStore = useStore.getState().project;
    expect(inStore.title).toBe(PROJECT_TEMPLATES['8bar-pop'].name);
    expect(validateProject(inStore).ok).toBe(true);
  });
});
