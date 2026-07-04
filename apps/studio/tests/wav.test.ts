import { describe, expect, it } from 'vitest';
import type { Clip, DrumEvent, Project, Track } from '@cts/project-model';
import { buildScheduleEvents, type DrumScheduleEvent } from '../src/audio/events';
import {
  beatToTime,
  makeDrumGrooveStepKey,
  resolveDrumGrooveHit,
} from '../src/audio/scheduler';
import { buildWavScheduleEvents, encodeWav, floatToInt16 } from '../src/audio/wav';

type DrumGrooveSettings = {
  swing: number;
  probability: number;
  humanizeVelocity: number;
  seed: number;
};

type DrumEventWithGroove = DrumEvent & {
  probability?: number;
};

type DrumClipWithGroove = Clip & {
  drumGroove?: Partial<DrumGrooveSettings>;
  drumEvents?: DrumEventWithGroove[];
};

/** Read a 4-char ASCII tag from an ArrayBuffer at an offset. */
function ascii(buffer: ArrayBuffer, offset: number, length = 4): string {
  const bytes = new Uint8Array(buffer, offset, length);
  return String.fromCharCode(...bytes);
}

function drumTrack(clip: Clip): Track {
  return {
    id: 'drums',
    name: 'Drums',
    type: 'drum',
    clips: [clip],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'drumkit', preset: 'basic' },
    effects: [],
  };
}

function projectWithDrumClip(clip: Clip): Project {
  return {
    id: 'project',
    schemaVersion: 1,
    title: 'WAV test',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    tracks: [drumTrack(clip)],
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
}

describe('floatToInt16', () => {
  it('maps 0 to 0', () => {
    expect(floatToInt16(0)).toBe(0);
  });
  it('maps +1 to 0x7FFF and -1 to -0x8000', () => {
    expect(floatToInt16(1)).toBe(0x7fff);
    expect(floatToInt16(-1)).toBe(-0x8000);
  });
  it('clamps out-of-range samples', () => {
    expect(floatToInt16(2)).toBe(0x7fff);
    expect(floatToInt16(-2)).toBe(-0x8000);
  });
  it('scales mid values', () => {
    expect(floatToInt16(0.5)).toBe(Math.round(0.5 * 0x7fff));
    expect(floatToInt16(-0.5)).toBe(Math.round(-0.5 * 0x8000));
  });
});

describe('encodeWav header (stereo)', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -1, 1, 0]);
  const buffer = encodeWav([left, right], 44100);
  const view = new DataView(buffer);

  it('writes RIFF / WAVE / fmt  / data tags', () => {
    expect(ascii(buffer, 0)).toBe('RIFF');
    expect(ascii(buffer, 8)).toBe('WAVE');
    expect(ascii(buffer, 12)).toBe('fmt ');
    expect(ascii(buffer, 36)).toBe('data');
  });

  it('has correct fmt fields for 16-bit PCM stereo', () => {
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(32, true)).toBe(4); // block align = 2ch * 2 bytes
    expect(view.getUint32(28, true)).toBe(44100 * 4); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('computes chunk sizes from the frame count', () => {
    const numFrames = 4;
    const blockAlign = 4;
    const dataSize = numFrames * blockAlign; // 16 bytes
    expect(view.getUint32(40, true)).toBe(dataSize); // data chunk size
    expect(view.getUint32(4, true)).toBe(36 + dataSize); // RIFF chunk size
    expect(buffer.byteLength).toBe(44 + dataSize);
  });

  it('interleaves L/R samples and clamps them', () => {
    // frame 0: L=0, R=0
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0);
    // frame 1: L=0.5, R=-1
    expect(view.getInt16(48, true)).toBe(floatToInt16(0.5));
    expect(view.getInt16(50, true)).toBe(-0x8000);
    // frame 3: L=1 (clamps to 0x7FFF), R=0
    expect(view.getInt16(56, true)).toBe(0x7fff);
    expect(view.getInt16(58, true)).toBe(0);
  });
});

describe('encodeWav (mono)', () => {
  it('produces a single-channel header', () => {
    const mono = new Float32Array([0.25, -0.25]);
    const buffer = encodeWav([mono], 22050);
    const view = new DataView(buffer);
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint16(32, true)).toBe(2); // block align = 1ch * 2 bytes
    expect(view.getUint32(40, true)).toBe(2 * 2); // 2 frames * 2 bytes
  });
});

describe('buildWavScheduleEvents drum groove parity', () => {
  it('resolves swung drum onset beats to the same time as live drum groove playback', () => {
    const clip: DrumClipWithGroove = {
      id: 'drum-clip',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumGroove: { swing: 0.6, probability: 1, humanizeVelocity: 0, seed: 23 },
      drumEvents: [{ id: 'kick-1', lane: 'kick', stepIndex: 1, velocity: 100 }],
    };
    const beat = 0.25;
    const expected = resolveDrumGrooveHit({
      beat,
      lane: 'kick',
      velocity: 100,
      probability: 1,
      swing: 0.6,
      humanizeVelocity: 0,
      seed: 23,
      stepKey: makeDrumGrooveStepKey('kick', beat),
      stepsPerBar: 16,
      beatsPerBar: 4,
    });

    const events = buildWavScheduleEvents(projectWithDrumClip(clip));
    const exported = events[0];

    expect(expected).not.toBeNull();
    expect(exported?.beat).toBeCloseTo(expected?.beat ?? 0, 10);
    expect(beatToTime(exported?.beat ?? 0, 120, 0, 0)).toBeCloseTo(
      beatToTime(expected?.beat ?? 0, 120, 0, 0),
      10,
    );
  });

  it('drops probability-muted drum hits deterministically for the same seed', () => {
    let mutedSeed = 1;
    let foundMutedSeed = false;
    for (let seed = 1; seed <= 100; seed += 1) {
      const hit = resolveDrumGrooveHit({
        beat: 0,
        lane: 'kick',
        velocity: 100,
        probability: 0.5,
        seed,
        stepKey: makeDrumGrooveStepKey('kick', 0),
      });
      if (hit === null) {
        mutedSeed = seed;
        foundMutedSeed = true;
        break;
      }
    }
    expect(foundMutedSeed).toBe(true);
    const clip: DrumClipWithGroove = {
      id: 'drum-clip',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumGroove: { swing: 0, probability: 1, humanizeVelocity: 0, seed: mutedSeed },
      drumEvents: [{ id: 'kick-0', lane: 'kick', stepIndex: 0, velocity: 100, probability: 0.5 }],
    };
    const project = projectWithDrumClip(clip);

    expect(buildWavScheduleEvents(project)).toEqual([]);
    expect(buildWavScheduleEvents(project)).toEqual([]);
  });

  it('keeps default no-groove drum clips identical to the shared schedule', () => {
    const clip: Clip = {
      id: 'drum-clip',
      trackId: 'drums',
      type: 'drum',
      startBeat: 8,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumEvents: [
        { id: 'kick-0', lane: 'kick', stepIndex: 0, velocity: 110 },
        { id: 'snare-4', lane: 'snare', stepIndex: 4, velocity: 90 },
      ],
    };
    const project = projectWithDrumClip(clip);
    const wavEvents = buildWavScheduleEvents(project);
    const sharedEvents = buildScheduleEvents(project);

    expect(wavEvents).toEqual(sharedEvents);
    expect((wavEvents[0]?.payload as DrumScheduleEvent).velocity).toBe(110);
    expect((wavEvents[1]?.payload as DrumScheduleEvent).velocity).toBe(90);
  });
});
