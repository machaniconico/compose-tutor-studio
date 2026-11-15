// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';
import { pxPerBeat } from '../src/features/timeline';

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];
let DrumGrid: typeof import('../src/features/drums/DrumGrid')['DrumGrid'];
let Arranger: typeof import('../src/features/arranger/Arranger')['Arranger'];
let ChordLane: typeof import('../src/features/chordTrack/ChordLane')['ChordLane'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
  ({ DrumGrid } = await import('../src/features/drums/DrumGrid'));
  ({ Arranger } = await import('../src/features/arranger/Arranger'));
  ({ ChordLane } = await import('../src/features/chordTrack/ChordLane'));
});

function leftOf(el: HTMLElement): number {
  return parseFloat(el.style.left);
}

function selectFirstClip(type: 'midi' | 'drum'): void {
  const { project } = useStore.getState();
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.type === type);
    if (clip) {
      act(() => useStore.getState().selectClip(clip.id));
      return;
    }
  }
}

/** Move the first clip of `type` to `startBeat` and select it. */
function placeFirstClip(type: 'midi' | 'drum', startBeat: number): void {
  act(() => {
    const store = useStore.getState();
    store.createNewProject('テスト');
    useStore.setState((s) => ({
      project: {
        ...s.project,
        lengthBars: 8,
        tracks: s.project.tracks.map((track) => {
          const first = track.clips.find((c) => c.type === type);
          return {
            ...track,
            clips: track.clips.map((c) => (c === first ? { ...c, startBeat } : c)),
          };
        }),
      },
    }));
  });
  selectFirstClip(type);
}

const DRUM_LABEL_PX = 67; // lane label + gap, before the first step cell
const DRUM_PX_PER_BEAT = 100; // 25px per 16th step, the click-target floor

describe('playhead', () => {
  it.each([
    ['PianoRoll', 'midi'],
    ['DrumGrid', 'drum'],
    ['Arranger', null],
    ['ChordLane', null],
  ] as const)('%s draws a playhead that follows positionBeat', (name, clipType) => {
    act(() => {
      useStore.getState().createNewProject('テスト');
      useStore.getState().setPosition(0);
    });
    if (clipType) selectFirstClip(clipType);
    const Comp = { PianoRoll, DrumGrid, Arranger, ChordLane }[name];
    render(<Comp />);

    const head = screen.getByTestId('playhead');
    const before = leftOf(head);
    act(() => useStore.getState().setPosition(2));
    const after = leftOf(screen.getByTestId('playhead'));
    expect(after - before).toBeGreaterThan(0);

    if (name === 'DrumGrid') {
      expect(after).toBeCloseTo(DRUM_LABEL_PX + 2 * DRUM_PX_PER_BEAT, 5);
    } else {
      const zoomX = useStore.getState().editor.zoomX;
      expect(after).toBeCloseTo(2 * pxPerBeat(zoomX), 5);
    }
  });

  it('places the drum playhead relative to the clip start', () => {
    placeFirstClip('drum', 8);
    act(() => useStore.getState().setPosition(8));
    render(<DrumGrid />);

    const head = screen.getByTestId('playhead');
    expect(head.classList.contains('is-hidden')).toBe(false);
    expect(leftOf(head)).toBeCloseTo(DRUM_LABEL_PX, 5);

    act(() => useStore.getState().setPosition(9));
    expect(leftOf(screen.getByTestId('playhead'))).toBeCloseTo(
      DRUM_LABEL_PX + DRUM_PX_PER_BEAT,
      5,
    );

    act(() => useStore.getState().setPosition(7));
    expect(screen.getByTestId('playhead').classList.contains('is-hidden')).toBe(true);
  });

  it('scales the drum grid with zoom once the shared scale clears the floor', () => {
    placeFirstClip('drum', 0);
    act(() => {
      useStore.getState().setZoomX(4);
      useStore.getState().setPosition(1);
    });
    const { container } = render(<DrumGrid />);

    expect(leftOf(screen.getByTestId('playhead'))).toBeCloseTo(DRUM_LABEL_PX + pxPerBeat(4), 5);
    const grid = container.querySelector<HTMLElement>('.drum-grid');
    expect(grid?.style.getPropertyValue('--step-px')).toBe('25px');
    act(() => useStore.getState().setZoomX(1));
  });

  it('keeps the piano roll playhead on the sounding note of a later clip', () => {
    placeFirstClip('midi', 8);
    act(() => useStore.getState().setPosition(10));
    render(<PianoRoll />);

    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const head = screen.getByTestId('playhead');
    expect(head.classList.contains('is-hidden')).toBe(false);
    expect(leftOf(head)).toBeCloseTo(2 * ppb, 5);

    act(() => useStore.getState().setPosition(7));
    expect(screen.getByTestId('playhead').classList.contains('is-hidden')).toBe(true);
  });

  it('labels and seeks the piano roll ruler in song position', () => {
    placeFirstClip('midi', 8);
    render(<PianoRoll />);

    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const ruler = screen.getByTestId('timeline-ruler');
    expect(ruler.querySelector('.timeline-ruler__bar')?.textContent).toBe('3');

    fireEvent.click(ruler, { clientX: 4 * ppb + 1 });
    expect(useStore.getState().transport.positionBeat).toBe(12);
  });

  it('ends the piano roll ruler at the song end for a later clip', () => {
    placeFirstClip('midi', 8);
    render(<PianoRoll />);

    const ppb = pxPerBeat(useStore.getState().editor.zoomX);
    const ruler = screen.getByTestId('timeline-ruler');
    expect(parseFloat(ruler.style.width)).toBeCloseTo(24 * ppb, 5);
    const labels = [...ruler.querySelectorAll('.timeline-ruler__bar')].map((el) => el.textContent);
    expect(labels).toEqual(['3', '4', '5', '6', '7', '8']);

    fireEvent.click(ruler, { clientX: 23 * ppb });
    expect(useStore.getState().transport.positionBeat).toBe(28);
  });

  it('keeps the ruler width non-negative for a clip past the song end', () => {
    placeFirstClip('midi', 40);
    render(<PianoRoll />);
    expect(parseFloat(screen.getByTestId('timeline-ruler').style.width)).toBe(0);
  });
});
