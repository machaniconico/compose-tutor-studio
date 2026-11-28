import { expect, it, vi } from 'vitest';
import { LivePreview, MAX_HELD_SECONDS, type PreviewTarget } from '../src/audio/livePreview';

function param() {
  return { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() };
}
const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

function setup() {
  const oscillators: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const ctx = {
    currentTime: 10,
    createOscillator: vi.fn(() => {
      const o = { ...node(), type: 'sine', frequency: param(), detune: param(), start: vi.fn(), stop: vi.fn(), onended: null };
      oscillators.push(o);
      return o;
    }),
    createGain: vi.fn(() => ({ ...node(), gain: param() })),
    createBiquadFilter: vi.fn(() => ({ ...node(), type: 'lowpass', frequency: param(), Q: param() })),
  };
  const preview = new LivePreview(async () => ({ context: ctx, master: node() }) as unknown as PreviewTarget);
  return { preview, oscillators };
}
const stopAt = (o: { stop: ReturnType<typeof vi.fn> }) => Math.min(...o.stop.mock.calls.map((c) => c[0] as number));

it('MIDI keys and a PC key on one pitch are held independently and never stick', async () => {
  const { preview, oscillators } = setup();
  await preview.hold('midi:a:0:60', undefined, 60, 100);
  const per = oscillators.length;
  await preview.hold('midi:b:0:60', undefined, 60, 40);
  await preview.hold('KeyA', undefined, 60);
  expect(oscillators.length).toBe(per * 3);
  const cap = 10 + MAX_HELD_SECONDS;
  expect(oscillators.every((o) => stopAt(o) <= cap)).toBe(true);
  preview.release('midi:a:0:60');
  const early = (i: number) => oscillators.slice(i * per, (i + 1) * per).every((o) => stopAt(o) < 10 + 2);
  expect(early(0)).toBe(true);
  expect(early(1)).toBe(false);
  expect(early(2)).toBe(false);
  preview.release('KeyA');
  expect(early(2)).toBe(true);
  expect(early(1)).toBe(false);
  // A repeated note-on of a held id is ignored; one note-off frees it.
  await preview.hold('midi:b:0:60', undefined, 60, 40);
  expect(oscillators.length).toBe(per * 3);
  preview.release('midi:b:0:60');
  expect(early(1)).toBe(true);
  preview.release('midi:b:0:60');
});

it('cancel (disconnect, blur, transport, project switch, recording, unmount) releases all held MIDI notes', async () => {
  const { preview, oscillators } = setup();
  await preview.hold('midi:a:0:60', undefined, 60, 100);
  await preview.hold('midi:a:0:64', undefined, 64, 100);
  preview.cancel();
  expect(oscillators.every((o) => stopAt(o) < 10 + 2)).toBe(true);
});

it('releaseMatching frees only ids with the prefix', async () => {
  const { preview, oscillators } = setup();
  await preview.hold('midi:a:0:60', undefined, 60, 100);
  const per = oscillators.length;
  await preview.hold('KeyA', undefined, 62);
  preview.releaseMatching('midi:');
  const early = (i: number) => oscillators.slice(i * per, (i + 1) * per).every((o) => stopAt(o) < 10 + 2);
  expect(early(0)).toBe(true);
  expect(early(1)).toBe(false);
});
