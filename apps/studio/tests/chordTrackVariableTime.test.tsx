import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  compileMusicalTime,
  type ChordEvent,
  type Project,
} from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';
import { installLocalStorage } from './localStorageStub';

let ChordLane: typeof import('../src/features/chordTrack/ChordLane')['ChordLane'];
let chordGridBarAtBeat: typeof import('../src/features/chordTrack/ChordLane')['chordGridBarAtBeat'];
let chordGridBarPlacement: typeof import('../src/features/chordTrack/ChordLane')['chordGridBarPlacement'];
let chordGridDragPreview: typeof import('../src/features/chordTrack/ChordLane')['chordGridDragPreview'];
let chordPopoverTiming: typeof import('../src/features/chordTrack/ChordPopover')['chordPopoverTiming'];
let moveChordToBarPatch: typeof import('../src/features/chordTrack/ChordPopover')['moveChordToBarPatch'];
let resizeChordToBarsPatch: typeof import('../src/features/chordTrack/ChordPopover')['resizeChordToBarsPatch'];
let useStore: typeof import('../src/state/store')['useStore'];

function chord(
  id: string,
  symbol: string,
  startBeat: number,
  durationBeats: number,
  degree: string,
  fn: ChordEvent['function'],
): ChordEvent {
  return {
    id,
    symbol,
    startBeat,
    durationBeats,
    root: symbol,
    quality: 'major',
    notes: [],
    degree,
    function: fn,
  };
}

function variableSignatureProject(): Project {
  const base = createDefaultProject('Variable chord grid');
  const lengthBeats = 16;
  return {
    ...base,
    timeSignature: [3, 4],
    lengthBars: 4,
    lengthBeats,
    tempoMap: [{ id: 'tempo-variable', beat: 0, bpm: base.bpm }],
    timeSignatureMap: [
      { id: 'signature-3-4', beat: 0, numerator: 3, denominator: 4 },
      { id: 'signature-5-4', beat: 6, numerator: 5, denominator: 4 },
    ],
    tracks: base.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({ ...clip, lengthBeats })),
    })),
    chordTrack: [
      chord('chord-c', 'C', 0, 3, 'I', 'T'),
      chord('chord-f', 'F', 3, 3, 'IV', 'SD'),
      chord('chord-g', 'G', 6, 5, 'V', 'D'),
      chord('chord-c-end', 'C', 11, 5, 'I', 'T'),
    ],
    sections: [{
      id: 'section-variable',
      name: 'Variable',
      type: 'verse',
      startBar: 0,
      lengthBars: 4,
    }],
  };
}

function activate(project: Project): void {
  const current = useStore.getState();
  const nextState = {
    project,
    editor: {
      ...current.editor,
      zoomX: 1,
      selectedChordId: null,
    },
  };
  useStore.setState(nextState);
  Object.assign(useStore.getInitialState(), nextState);
}

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({
    ChordLane,
    chordGridBarAtBeat,
    chordGridBarPlacement,
    chordGridDragPreview,
  } = await import('../src/features/chordTrack/ChordLane'));
  ({
    chordPopoverTiming,
    moveChordToBarPatch,
    resizeChordToBarsPatch,
  } = await import('../src/features/chordTrack/ChordPopover'));
});

beforeEach(() => {
  activate(variableSignatureProject());
});

describe('variable-signature chord track UI', () => {
  it('renders map-aware lane width, bar guides, cursor, chip placement, and labels', () => {
    const html = renderToStaticMarkup(<ChordLane />);
    const guideLefts = [...html.matchAll(
      /class="chord-lane__bar" style="left:([^"]+)"/g,
    )].map((match) => match[1]);

    expect(html).toContain('class="chord-lane__grid" style="width:448px"');
    expect(html).toContain(
      'class="chord-lane__keyboard-cursor" style="left:0;width:84px"',
    );
    expect(guideLefts).toEqual(['0', '84px', '168px', '308px']);
    expect(html).toContain('style="left:168px;width:140px"');
    expect(html).toContain(
      'aria-label="G コードを編集。第3小節、長さ1小節、度数V、ドミナント"',
    );
  });

  it('uses each mapped bar for click/keyboard placement and drag geometry', () => {
    const project = variableSignatureProject();
    const musicalTime = compileMusicalTime(project);

    expect([0, 1, 2, 3].map((bar) => chordGridBarPlacement(musicalTime, bar)))
      .toEqual([
        { startBeat: 0, durationBeats: 3 },
        { startBeat: 3, durationBeats: 3 },
        { startBeat: 6, durationBeats: 5 },
        { startBeat: 11, durationBeats: 5 },
      ]);
    expect(chordGridBarPlacement(musicalTime, 2, 0.5)).toEqual({
      startBeat: 6,
      durationBeats: 2.5,
    });
    expect(chordGridBarAtBeat(musicalTime, 5.99, project.lengthBars)).toBe(1);
    expect(chordGridBarAtBeat(musicalTime, 6, project.lengthBars)).toBe(2);
    expect(chordGridBarAtBeat(musicalTime, 16, project.lengthBars)).toBe(3);

    expect(chordGridDragPreview(
      musicalTime,
      project.lengthBars,
      { id: 'drag', startBeat: 3, durationBeats: 3 },
      'move',
      2,
    )).toEqual({ chordId: 'drag', startBeat: 6, durationBeats: 5 });
    expect(chordGridDragPreview(
      musicalTime,
      project.lengthBars,
      { id: 'drag', startBeat: 3, durationBeats: 3 },
      'resize',
      3,
    )).toEqual({ chordId: 'drag', startBeat: 3, durationBeats: 8 });
  });

  it('moves, resizes, and clamps popover edits in mapped bars', () => {
    const project = variableSignatureProject();
    const musicalTime = compileMusicalTime(project);
    const oneBarChord = { startBeat: 3, durationBeats: 3 };

    expect(chordPopoverTiming(
      musicalTime,
      project.lengthBars,
      oneBarChord,
    )).toEqual({ startBar: 2, durationBars: 1, maxDurationBars: 3 });
    expect(moveChordToBarPatch(
      musicalTime,
      project.lengthBars,
      oneBarChord,
      3,
    )).toEqual({ startBeat: 6, durationBeats: 5 });
    expect(resizeChordToBarsPatch(
      musicalTime,
      project.lengthBars,
      oneBarChord,
      2,
    )).toEqual({ durationBeats: 8 });
    expect(resizeChordToBarsPatch(
      musicalTime,
      project.lengthBars,
      oneBarChord,
      99,
    )).toEqual({ durationBeats: 13 });

    const twoBarChord = { startBeat: 3, durationBeats: 8 };
    expect(moveChordToBarPatch(
      musicalTime,
      project.lengthBars,
      twoBarChord,
      4,
    )).toEqual({ startBeat: 11, durationBeats: 5 });
  });

  it('preserves fixed-4/4 placement and drag behavior', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 16,
      tempoMap: [{ id: 'tempo-fixed', beat: 0, bpm: 120 }],
      timeSignatureMap: [{
        id: 'signature-fixed',
        beat: 0,
        numerator: 4,
        denominator: 4,
      }],
    });
    const fixedChord = { startBeat: 4, durationBeats: 4 };

    expect(chordGridBarPlacement(musicalTime, 2)).toEqual({
      startBeat: 8,
      durationBeats: 4,
    });
    expect(moveChordToBarPatch(musicalTime, 4, fixedChord, 3)).toEqual({
      startBeat: 8,
      durationBeats: 4,
    });
    expect(resizeChordToBarsPatch(musicalTime, 4, fixedChord, 2)).toEqual({
      durationBeats: 8,
    });
    expect(chordGridDragPreview(
      musicalTime,
      4,
      { id: 'fixed', ...fixedChord },
      'move',
      2,
    )).toEqual({ chordId: 'fixed', startBeat: 8, durationBeats: 4 });
    expect(chordGridDragPreview(
      musicalTime,
      4,
      { id: 'fixed', ...fixedChord },
      'resize',
      2,
    )).toEqual({ chordId: 'fixed', startBeat: 4, durationBeats: 8 });
  });

  it('preserves partial-bar chord duration for zero-delta resize and popover moves', () => {
    const musicalTime = compileMusicalTime({
      lengthBeats: 16,
      tempoMap: [{ id: 'tempo-fixed-partial', beat: 0, bpm: 120 }],
      timeSignatureMap: [{
        id: 'signature-fixed-partial',
        beat: 0,
        numerator: 4,
        denominator: 4,
      }],
    });
    const partialChord = { id: 'partial', startBeat: 0, durationBeats: 2 };

    expect(chordGridDragPreview(
      musicalTime,
      4,
      partialChord,
      'resize',
      0,
    )).toEqual({ chordId: 'partial', startBeat: 0, durationBeats: 2 });
    expect(chordPopoverTiming(musicalTime, 4, partialChord)).toEqual({
      startBar: 1,
      durationBars: 0.5,
      maxDurationBars: 4,
    });
    expect(moveChordToBarPatch(musicalTime, 4, partialChord, 2)).toEqual({
      startBeat: 4,
      durationBeats: 2,
    });
    expect(resizeChordToBarsPatch(musicalTime, 4, partialChord, 0.5)).toEqual({
      durationBeats: 2,
    });
    expect(resizeChordToBarsPatch(musicalTime, 4, partialChord, 0)).toEqual({
      durationBeats: 2,
    });
  });

  it('maps a partial-bar chord duration proportionally into the target signature', () => {
    const project = variableSignatureProject();
    const musicalTime = compileMusicalTime(project);
    const halfFiveFourBar = { startBeat: 6, durationBeats: 2.5 };

    expect(chordPopoverTiming(musicalTime, project.lengthBars, halfFiveFourBar)).toEqual({
      startBar: 3,
      durationBars: 0.5,
      maxDurationBars: 2,
    });
    expect(moveChordToBarPatch(
      musicalTime,
      project.lengthBars,
      halfFiveFourBar,
      2,
    )).toEqual({ startBeat: 3, durationBeats: 1.5 });
  });
});
