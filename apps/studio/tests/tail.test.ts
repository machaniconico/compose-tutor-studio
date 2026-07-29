import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  type Clip,
  type DrumLane,
  type EffectConfig,
  type EffectType,
  type Project,
  type Track,
} from '@cts/project-model';
import {
  buildScheduleEvents,
  type DrumScheduleEvent,
  type NoteScheduleEvent,
} from '../src/audio/events';
import { resolveDrumOccurrence, type ScheduledEvent } from '../src/audio/scheduler';
import { resolveEqBiquadSettings } from '../src/audio/effects';
import { MASTER_LIMITER_LOOKAHEAD_SECONDS } from '../src/audio/masterBus';
import {
  AUDIO_TAIL_SILENCE_THRESHOLD,
  DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
  FINAL_TAIL_FADE_SECONDS,
  MAX_AUDIO_TAIL_SECONDS,
  MAX_BIQUAD_TAIL_SECONDS,
  estimateBiquadTailSeconds,
  estimateDelayTailSeconds,
  estimateEqTailSeconds,
  estimateFilterTailSeconds,
  estimateInsertChainTailSeconds,
  estimateReverbTailSeconds,
  planAudioTail,
} from '../src/audio/tail';
import {
  DRUM_SOURCE_STOP_SECONDS,
  REVERB_IMPULSE_PEAK_AMPLITUDE,
} from '../src/audio/voiceTiming';

function effect(
  type: EffectType,
  params: Record<string, number>,
  enabled = true,
): EffectConfig {
  return { id: `${type}-${JSON.stringify(params)}`, type, enabled, params };
}

function instrumentTrack(effects: EffectConfig[] = []): Track {
  return {
    id: 'instrument',
    name: 'Instrument',
    type: 'instrument',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'synth', preset: 'softPad' },
    effects,
  };
}

function drumTrack(effects: EffectConfig[] = []): Track {
  return {
    id: 'drums',
    name: 'Drums',
    type: 'drum',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    instrument: { type: 'drumkit', preset: 'basic' },
    effects,
  };
}

function audioTrack(effects: EffectConfig[] = []): Track {
  return {
    id: 'audio',
    name: 'Audio',
    type: 'audio',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects,
  };
}

function busTrack(
  id: string,
  effects: EffectConfig[] = [],
  mute = false,
): Track {
  return {
    id,
    name: id,
    type: 'bus',
    role: 'general',
    clips: [],
    volume: 1,
    pan: 0,
    mute,
    solo: false,
    effects,
  };
}

function project(track: Track): Project {
  return {
    id: 'tail-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Tail test',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'tail-tempo-0', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'tail-meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    audioTakeFolders: [],
    automationLanes: [],
    audioRouting: {
      outputs: [{ sourceTrackId: track.id, destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [track],
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
}

function note(beat: number, durationBeats: number, preset = 'softPad'): ScheduledEvent {
  return {
    beat,
    payload: {
      kind: 'note',
      trackId: 'instrument',
      preset,
      pitch: 60,
      durationBeats,
      velocity: 100,
    } satisfies NoteScheduleEvent,
  };
}

function drum(beat: number, lane: DrumLane): ScheduledEvent {
  return {
    beat,
    payload: {
      kind: 'drum',
      trackId: 'drums',
      clipId: 'clip',
      eventId: `${lane}-${beat}`,
      lane,
      velocity: 100,
      sourceStepIndex: 0,
      clipEndBeat: 4,
      stepsPerBar: 16,
      beatsPerBar: 4,
      probability: 1,
      swing: 0,
      humanizeVelocity: 0,
      seed: 1,
    } satisfies DrumScheduleEvent,
  };
}

describe('effect tail estimates', () => {
  it('keeps max delay echoes through the last sample at or above -60 dB', () => {
    const maximum = effect('delay', { delayTime: 1, feedback: 1, mix: 1 });

    expect(estimateDelayTailSeconds(maximum)).toBe(32.25);
    expect(0.85 ** 42).toBeGreaterThanOrEqual(AUDIO_TAIL_SILENCE_THRESHOLD);
    expect(0.85 ** 43).toBeLessThan(AUDIO_TAIL_SILENCE_THRESHOLD);
    expect(
      estimateDelayTailSeconds(effect('delay', { delayTime: 1, feedback: 0, mix: 1 })),
    ).toBe(0.75);
    expect(
      estimateDelayTailSeconds(effect('delay', { delayTime: 1, feedback: 1, mix: 0 })),
    ).toBe(0);
    expect(
      estimateDelayTailSeconds(
        effect('delay', { delayTime: 1, feedback: 1, mix: 1 }, false),
      ),
    ).toBe(0);
  });

  it('includes an echo exactly at -60 dB despite the logarithmic FP boundary', () => {
    const feedback = 0.85;
    const exactBoundaryMix = AUDIO_TAIL_SILENCE_THRESHOLD / feedback ** 15;
    const justBelowBoundaryMix =
      (AUDIO_TAIL_SILENCE_THRESHOLD * (1 - 1e-10)) / feedback ** 15;

    expect(
      Math.log(AUDIO_TAIL_SILENCE_THRESHOLD / exactBoundaryMix) /
        Math.log(feedback),
    ).toBeLessThan(15);
    expect(
      estimateDelayTailSeconds(
        effect('delay', { delayTime: 1, feedback: 1, mix: exactBoundaryMix }),
      ),
    ).toBe(16 * 0.75);
    expect(
      estimateDelayTailSeconds(
        effect('delay', { delayTime: 1, feedback: 1, mix: justBelowBoundaryMix }),
      ),
    ).toBe(15 * 0.75);
  });

  it('uses wet gain and the squared max-reverb envelope', () => {
    const maximum = effect('reverb', { wet: 1, decay: 1 });
    const expected =
      3 *
      (1 -
        Math.sqrt(
          AUDIO_TAIL_SILENCE_THRESHOLD / REVERB_IMPULSE_PEAK_AMPLITUDE,
        ));

    expect(estimateReverbTailSeconds(maximum)).toBeCloseTo(expected, 10);
    expect(estimateReverbTailSeconds(effect('reverb', { wet: 0, decay: 1 }))).toBe(0);
    expect(
      estimateReverbTailSeconds(effect('reverb', { wet: 1, decay: 1 }, false)),
    ).toBe(0);
  });

  it('bounds the coefficient-dependent low-pass IIR tail and grows with Q', () => {
    const lowQ = estimateFilterTailSeconds(
      effect('filter', { cutoff: 0, resonance: 0 }),
      DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
    );
    const highQ = estimateFilterTailSeconds(
      effect('filter', { cutoff: 0, resonance: 1 }),
      DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
    );

    expect(highQ).toBeGreaterThan(lowQ);
    expect(highQ).toBeGreaterThan(0.3);
    expect(highQ).toBeLessThan(MAX_BIQUAD_TAIL_SECONDS);
    expect(
      estimateFilterTailSeconds(effect('filter', { cutoff: 0, resonance: 1 }), 48_000),
    ).toBeCloseTo(highQ, 4);
    expect(
      estimateFilterTailSeconds(
        effect('filter', { cutoff: Number.NaN, resonance: Number.POSITIVE_INFINITY }),
        Number.NaN,
      ),
    ).toBeGreaterThan(0);
    expect(
      estimateFilterTailSeconds(
        effect('filter', { cutoff: Number.NaN, resonance: Number.POSITIVE_INFINITY }),
        Number.NaN,
      ),
    ).toBeLessThanOrEqual(MAX_BIQUAD_TAIL_SECONDS);
    expect(
      estimateFilterTailSeconds(
        effect('filter', { cutoff: 0, resonance: 1 }, false),
      ),
    ).toBe(0);
  });

  it('adds all three runtime EQ biquads and each compressor look-ahead serially', () => {
    const eq = effect('eq', { lowGain: 1, midGain: 1, highGain: 1 });
    const eqStages = resolveEqBiquadSettings(eq);
    const expectedEq = eqStages.reduce(
      (tail, stage) =>
        tail + estimateBiquadTailSeconds(stage, DEFAULT_AUDIO_TAIL_SAMPLE_RATE),
      0,
    );
    const compressor = effect('compressor', {});

    expect(eqStages).toHaveLength(3);
    expect(estimateEqTailSeconds(eq)).toBeCloseTo(expectedEq, 12);
    expect(expectedEq).toBeGreaterThan(0);
    expect(
      estimateEqTailSeconds(
        effect('eq', { lowGain: 0.5, midGain: 0.5, highGain: 0.5 }),
      ),
    ).toBe(0);
    expect(
      estimateInsertChainTailSeconds([
        compressor,
        { ...compressor, id: 'compressor-2' },
      ]),
    ).toBe(2 * MASTER_LIMITER_LOOKAHEAD_SECONDS);
  });
});

describe('planAudioTail', () => {
  it.each(
    [
      ['kick', 0.35],
      ['snare', 0.25],
      ['closedHat', 0.095],
      ['openHat', 0.37],
      ['clap', 0.144],
      ['perc', 0.28],
    ] satisfies Array<[DrumLane, number]>,
  )('mirrors the %s source stop at %ss', (lane, stop) => {
    expect(DRUM_SOURCE_STOP_SECONDS[lane]).toBe(stop);
  });

  it('adds no tail or fade when the resolved one-shot schedule has no events', () => {
    const track = instrumentTrack([
      effect('delay', { delayTime: 1, feedback: 1, mix: 1 }),
      effect('reverb', { wet: 1, decay: 1 }),
    ]);

    expect(planAudioTail(project(track), [], 0, 4)).toEqual({
      uncappedTailSeconds: 0,
      tailSeconds: 0,
      totalSeconds: 2,
      postLimiterTailSeconds: 0,
      fadeStartSeconds: null,
      fadeEndSeconds: null,
      capped: false,
    });
  });

  it('includes an audio clip source end in the same insert-tail model', () => {
    const delay = effect('delay', { delayTime: 1, feedback: 0, mix: 1 });
    const plan = planAudioTail(
      project(audioTrack([delay])),
      [],
      0,
      4,
      DEFAULT_AUDIO_TAIL_SAMPLE_RATE,
      [{ trackId: 'audio', endSeconds: 2 }],
    );

    expect(plan.uncappedTailSeconds).toBeCloseTo(
      0.75 + MASTER_LIMITER_LOOKAHEAD_SECONDS,
      10,
    );
  });

  it('includes Soft Pad attack/decay, release, and oscillator stop padding', () => {
    const plan = planAudioTail(project(instrumentTrack()), [note(3.9, 0.1)], 0, 4);

    // onset 1.95 + max(note 0.05, attack+decay 0.70) + release 0.80 + pad 0.02
    expect(plan.uncappedTailSeconds).toBeCloseTo(1.476, 10);
    expect(plan.tailSeconds).toBeCloseTo(1.476, 10);
    expect(plan.totalSeconds).toBeCloseTo(3.476, 10);
    expect(plan.postLimiterTailSeconds).toBe(MASTER_LIMITER_LOOKAHEAD_SECONDS);
    expect(plan.fadeStartSeconds).toBeCloseTo(3.42, 10);
    expect(plan.fadeEndSeconds).toBeCloseTo(3.47, 10);
  });

  it('uses the actual latest source stop for an open hat', () => {
    const plan = planAudioTail(project(drumTrack()), [drum(3.75, 'openHat')], 0, 4);

    expect(DRUM_SOURCE_STOP_SECONDS.openHat).toBe(0.37);
    expect(plan.uncappedTailSeconds).toBeCloseTo(0.251, 10);
    expect(plan.totalSeconds).toBeCloseTo(2.251, 10);
    expect(plan.fadeEndSeconds).toBeCloseTo(2.245, 10);
  });

  it('adds insert stages serially but the Master limiter look-ahead only once', () => {
    const compressor = effect('compressor', {});
    const filter = effect('filter', { cutoff: 0, resonance: 1 });
    const filterTail = estimateFilterTailSeconds(filter);
    const plan = planAudioTail(
      project(drumTrack([
        filter,
        compressor,
        { ...compressor, id: 'compressor-2' },
      ])),
      [drum(3.75, 'openHat')],
      0,
      4,
    );

    expect(plan.uncappedTailSeconds).toBeCloseTo(
      0.245 +
        filterTail +
        2 * MASTER_LIMITER_LOOKAHEAD_SECONDS +
        MASTER_LIMITER_LOOKAHEAD_SECONDS,
      10,
    );
    expect(plan.postLimiterTailSeconds).toBe(MASTER_LIMITER_LOOKAHEAD_SECONDS);
  });

  it('propagates nested Bus insert tails once per channel in DAG order', () => {
    const compressor = effect('compressor', {});
    const source = instrumentTrack([compressor]);
    const firstBus = busTrack('bus-a', [{ ...compressor, id: 'bus-a-compressor' }]);
    const secondBus = busTrack('bus-b', [{ ...compressor, id: 'bus-b-compressor' }]);
    const routedProject: Project = {
      ...project(source),
      tracks: [source, firstBus, secondBus],
      audioRouting: {
        outputs: [
          { sourceTrackId: source.id, destination: { type: 'bus', trackId: firstBus.id } },
          { sourceTrackId: firstBus.id, destination: { type: 'bus', trackId: secondBus.id } },
          { sourceTrackId: secondBus.id, destination: { type: 'master' } },
        ],
        sends: [],
      },
    };
    const dry = planAudioTail(project(instrumentTrack()), [note(3.9, 0.1)], 0, 4);
    const nested = planAudioTail(routedProject, [note(3.9, 0.1)], 0, 4);

    expect(nested.uncappedTailSeconds).toBeCloseTo(
      dry.uncappedTailSeconds + 3 * MASTER_LIMITER_LOOKAHEAD_SECONDS,
      10,
    );
    expect(nested.postLimiterTailSeconds).toBe(MASTER_LIMITER_LOOKAHEAD_SECONDS);
  });

  it('takes pre-fader Bus sends before source inserts and post-fader sends after them', () => {
    const compressor = effect('compressor', {});
    const source = instrumentTrack([compressor]);
    const mutedDryBus = busTrack('dry-bus', [], true);
    const wetBus = busTrack('wet-bus', [{ ...compressor, id: 'wet-compressor' }]);
    const routedProject: Project = {
      ...project(source),
      tracks: [source, mutedDryBus, wetBus],
      audioRouting: {
        outputs: [
          { sourceTrackId: source.id, destination: { type: 'bus', trackId: mutedDryBus.id } },
          { sourceTrackId: mutedDryBus.id, destination: { type: 'master' } },
          { sourceTrackId: wetBus.id, destination: { type: 'master' } },
        ],
        sends: [{
          id: 'wet-send',
          sourceTrackId: source.id,
          targetBusId: wetBus.id,
          position: 'pre-fader',
          gain: 1,
          enabled: true,
        }],
      },
    };
    const pre = planAudioTail(routedProject, [note(3.9, 0.1)], 0, 4);
    const post = planAudioTail({
      ...routedProject,
      audioRouting: {
        ...routedProject.audioRouting,
        sends: [{ ...routedProject.audioRouting.sends[0]!, position: 'post-fader' }],
      },
    }, [note(3.9, 0.1)], 0, 4);

    expect(post.uncappedTailSeconds - pre.uncappedTailSeconds).toBeCloseTo(
      MASTER_LIMITER_LOOKAHEAD_SECONDS,
      10,
    );
  });

  it('preserves a full post-song fade before the limiter cleanup window', () => {
    // kick pre-master end = 1.651s onset + 0.35s source = song end + 1ms
    const plan = planAudioTail(project(drumTrack()), [drum(3.302, 'kick')], 0, 4);

    expect(plan.uncappedTailSeconds).toBeCloseTo(0.007, 10);
    expect(plan.tailSeconds).toBeCloseTo(
      FINAL_TAIL_FADE_SECONDS + MASTER_LIMITER_LOOKAHEAD_SECONDS,
      10,
    );
    expect(plan.fadeStartSeconds).toBeCloseTo(2, 10);
    expect(plan.fadeEndSeconds).toBeCloseTo(2.05, 10);
    expect(plan.totalSeconds).toBeCloseTo(2.056, 10);
  });

  it('allocates no limiter tail or fade when every audible event ends inside the body', () => {
    const plan = planAudioTail(project(drumTrack()), [drum(0, 'openHat')], 0, 4);

    expect(plan.tailSeconds).toBe(0);
    expect(plan.postLimiterTailSeconds).toBe(0);
    expect(plan.fadeStartSeconds).toBeNull();
    expect(plan.fadeEndSeconds).toBeNull();
    expect(plan.totalSeconds).toBe(2);
  });

  it('filters resolved onsets against the requested playback range', () => {
    const clip: Clip = {
      id: 'swung-clip',
      trackId: 'drums',
      type: 'drum',
      startBeat: 0,
      lengthBeats: 4,
      loop: false,
      stepsPerBar: 16,
      drumGroove: { swing: 1, probability: 1, humanizeVelocity: 0, seed: 1 },
      drumEvents: [{ id: 'swung-kick', lane: 'kick', stepIndex: 1, velocity: 100 }],
    };
    const track = drumTrack();
    track.clips = [clip];
    const tailProject = project(track);
    const raw = buildScheduleEvents(tailProject)[0];
    const resolved = raw ? resolveDrumOccurrence(raw, raw.beat) : null;

    expect(raw?.beat).toBe(0.25);
    expect(resolved?.beat).toBe(0.375);
    const plan = planAudioTail(tailProject, resolved ? [resolved] : [], 0.3, 0.5);

    expect(plan.totalSeconds).toBeCloseTo(0.3935, 10);
    expect(plan.uncappedTailSeconds).toBeCloseTo(0.2935, 10);
  });

  it('excludes sources silenced by the WAV mute/solo snapshot', () => {
    const muted = instrumentTrack();
    muted.mute = true;
    const mutedPlan = planAudioTail(project(muted), [note(3.9, 0.1)], 0, 4);
    expect(mutedPlan.tailSeconds).toBe(0);
    expect(mutedPlan.postLimiterTailSeconds).toBe(0);
    expect(mutedPlan.fadeStartSeconds).toBeNull();
    expect(mutedPlan.fadeEndSeconds).toBeNull();

    const nonSolo = instrumentTrack();
    const solo = drumTrack();
    solo.solo = true;
    const soloProject = project(nonSolo);
    soloProject.tracks = [nonSolo, solo];
    soloProject.audioRouting.outputs.push({
      sourceTrackId: solo.id,
      destination: { type: 'master' },
    });
    const nonSoloPlan = planAudioTail(soloProject, [note(3.9, 0.1)], 0, 4);
    expect(nonSoloPlan.tailSeconds).toBe(0);
    expect(nonSoloPlan.postLimiterTailSeconds).toBe(0);
  });

  it('conservatively adds sequential reverb insert tails after the source', () => {
    const reverb = effect('reverb', { wet: 1, decay: 1 });
    const reverbTail = estimateReverbTailSeconds(reverb);
    const plan = planAudioTail(
      project(drumTrack([reverb, { ...reverb, id: 'reverb-2' }])),
      [drum(3.75, 'openHat')],
      0,
      4,
    );

    expect(plan.uncappedTailSeconds).toBeCloseTo(
      0.245 + reverbTail * 2 + MASTER_LIMITER_LOOKAHEAD_SECONDS,
      10,
    );
  });

  it('fits one max delay and reverb after the worst built-in source without capping', () => {
    const delay = effect('delay', { delayTime: 1, feedback: 1, mix: 1 });
    const reverb = effect('reverb', { wet: 1, decay: 1 });
    const plan = planAudioTail(
      project(instrumentTrack([delay, reverb])),
      [note(3.9, 0.1)],
      0,
      4,
    );

    expect(plan.uncappedTailSeconds).toBeCloseTo(
      1.47 +
        estimateDelayTailSeconds(delay) +
        estimateReverbTailSeconds(reverb) +
        MASTER_LIMITER_LOOKAHEAD_SECONDS,
      10,
    );
    expect(plan.capped).toBe(false);
    expect(plan.tailSeconds).toBeLessThan(MAX_AUDIO_TAIL_SECONDS);
  });

  it('caps recursive multi-insert tails at 40 seconds and reserves the final 50ms fade', () => {
    const delay = effect('delay', { delayTime: 1, feedback: 1, mix: 1 });
    const plan = planAudioTail(
      project(instrumentTrack([delay, { ...delay, id: 'delay-2' }])),
      [note(3.9, 0.1)],
      0,
      4,
    );

    expect(plan.uncappedTailSeconds).toBeGreaterThan(MAX_AUDIO_TAIL_SECONDS);
    expect(plan.tailSeconds).toBe(MAX_AUDIO_TAIL_SECONDS);
    expect(plan.totalSeconds).toBe(42);
    expect(plan.fadeEndSeconds).toBe(42 - MASTER_LIMITER_LOOKAHEAD_SECONDS);
    expect(plan.fadeStartSeconds).toBe(
      42 - MASTER_LIMITER_LOOKAHEAD_SECONDS - FINAL_TAIL_FADE_SECONDS,
    );
    expect(plan.capped).toBe(true);
  });
});
