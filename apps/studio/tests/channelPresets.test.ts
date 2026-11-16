import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateProject } from '@cts/project-model';
import { filterSettings, findEffect } from '../src/audio/effects';
import { CHANNEL_PRESETS } from '../src/features/mixer/channelPresets';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let actions: typeof import('../src/state/editorActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  actions = await import('../src/state/editorActions');
});

beforeEach(() => {
  installLocalStorage();
  useStore.getState().createNewProject('テスト');
});

// Product / brand names that must never appear in preset names (docs/16 rule).
const FORBIDDEN_WORDS = [
  'ableton',
  'logic',
  'cubase',
  'fl studio',
  'pro tools',
  'studio one',
  'garageband',
  'reaper',
  'bitwig',
  'waves',
  'fabfilter',
  'izotope',
  'ozone',
  'neutron',
  'ssl',
  'neve',
  'pultec',
  'la-2a',
  '1176',
];

function bassTrackId(): string {
  const track = actions.findTrackByName(useStore.getState().project, 'Bass');
  return track?.id ?? '';
}

describe('CHANNEL_PRESETS', () => {
  it('offers at least 5 presets with unique ids and Japanese text', () => {
    expect(CHANNEL_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(CHANNEL_PRESETS.map((p) => p.id)).size).toBe(CHANNEL_PRESETS.length);
    const names = CHANNEL_PRESETS.map((p) => p.name);
    for (const name of [
      'ベースを太く',
      'ボーカル風リードを前へ',
      'パッドを奥へ',
      'ドラムをはっきり',
      '全体をやわらかく',
    ]) {
      expect(names).toContain(name);
    }
    for (const preset of CHANNEL_PRESETS) {
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('never uses product names in preset names or descriptions', () => {
    for (const preset of CHANNEL_PRESETS) {
      const text = `${preset.name} ${preset.description}`.toLowerCase();
      for (const word of FORBIDDEN_WORDS) {
        expect(text).not.toContain(word);
      }
    }
  });

  it('keeps every value inside the validated ranges after applying', () => {
    for (const preset of CHANNEL_PRESETS) {
      useStore.getState().createNewProject('テスト');
      actions.applyChannelPreset(bassTrackId(), preset.id);
      const project = useStore.getState().project;
      expect(validateProject(project).errors).toEqual([]);
      const track = project.tracks.find((t) => t.id === bassTrackId());
      const filter = findEffect(track?.effects, 'filter');
      if (preset.effects.filter && filter) {
        // Filter has no schema range; the audio clamp must leave values as-is.
        const settings = filterSettings(filter);
        expect(settings.cutoffHz).toBe(preset.effects.filter.cutoffHz);
        expect(settings.resonance).toBe(preset.effects.filter.resonance);
      }
    }
  });
});

describe('applyChannelPreset', () => {
  it('turns on and sets the preset effects in one undo step', () => {
    const preset = CHANNEL_PRESETS.find((p) => p.name === 'ベースを太く');
    expect(preset).toBeDefined();
    const before = useStore.getState().past.length;
    actions.applyChannelPreset(bassTrackId(), preset?.id ?? '');
    expect(useStore.getState().past.length).toBe(before + 1);

    const track = useStore.getState().project.tracks.find((t) => t.id === bassTrackId());
    const eq = findEffect(track?.effects, 'eq');
    expect(eq?.enabled).toBe(true);
    expect(eq?.params).toMatchObject(preset?.effects.eq ?? {});

    useStore.getState().undo();
    const restored = useStore.getState().project.tracks.find((t) => t.id === bassTrackId());
    expect(findEffect(restored?.effects, 'eq')?.enabled ?? false).toBe(false);
  });

  it('is its own undo step when applied during an open tap tempo transaction', () => {
    const tapOwner = {};
    const before = useStore.getState().past.length;
    useStore.getState().beginTransaction(tapOwner);
    useStore.getState().setBpm(130);
    actions.applyChannelPreset(bassTrackId(), 'bass-thick');
    // The tap run may still try to close its own transaction later.
    useStore.getState().commitTransaction(tapOwner);
    expect(useStore.getState().past.length).toBe(before + 2);

    useStore.getState().undo();
    const project = useStore.getState().project;
    expect(project.bpm).toBe(130);
    const track = project.tracks.find((t) => t.id === bassTrackId());
    expect(findEffect(track?.effects, 'eq')?.enabled ?? false).toBe(false);

    useStore.getState().undo();
    expect(useStore.getState().project.bpm).toBe(120);
  });

  it('ignores unknown presets and tracks without touching history', () => {
    const before = useStore.getState().past.length;
    actions.applyChannelPreset(bassTrackId(), 'no-such-preset');
    actions.applyChannelPreset('no-such-track', CHANNEL_PRESETS[0]?.id ?? '');
    expect(useStore.getState().past.length).toBe(before);
  });
});
