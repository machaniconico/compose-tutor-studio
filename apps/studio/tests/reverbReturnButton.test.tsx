// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let MixerStrip: typeof import('../src/features/mixer/MixerStrip')['MixerStrip'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ MixerStrip } = await import('../src/features/mixer/MixerStrip'));
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(await useStore.getState().createNewProject('リターンUI検証')).toBe(true);
});

describe('reverb return button', () => {
  it('explains what a return is and adds a reverb return in one undo step', () => {
    render(<MixerStrip />);
    const before = useStore.getState();
    const track = before.project.tracks.find((t) => t.type !== 'master' && t.type !== 'bus')!;

    expect(screen.getAllByText(/リターンは、いくつものトラックの音/).length).toBeGreaterThan(0);
    const button = screen.getByRole('button', { name: `${track.name} リバーブ用リターンを追加` });
    fireEvent.click(button);

    const after = useStore.getState();
    expect(after.past).toHaveLength(before.past.length + 1);
    const send = after.project.audioRouting.sends.find((s) => s.sourceTrackId === track.id)!;
    expect(send.position).toBe('post-fader');
    const bus = after.project.tracks.find((t) => t.id === send.targetBusId)!;
    expect(bus.type).toBe('bus');
    expect(bus.effects.map((fx) => fx.type)).toEqual(['reverb']);

    // Pressing again reuses the return and changes nothing.
    fireEvent.click(screen.getByRole('button', { name: `${track.name} リバーブ用リターンを追加` }));
    expect(useStore.getState().past).toHaveLength(after.past.length);
    expect(useStore.getState().project.tracks).toHaveLength(after.project.tracks.length);

    // The return itself is a bus strip and does not offer the button.
    expect(screen.queryByRole('button', { name: `${bus.name} リバーブ用リターンを追加` })).toBeNull();
  });
});
