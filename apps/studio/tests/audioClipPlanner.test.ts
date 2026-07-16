import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  type AudioClip,
  type Project,
  type ReadyAudioAsset,
  type Track,
} from '@cts/project-model';
import {
  AudioClipPlanLimitError,
  MAX_AUDIO_CLIP_PLANS_PER_WINDOW,
  MAX_AUDIO_CLIP_REGIONS,
  audioClipGainToLinear,
  createAudioClipPlaybackIndex,
  planAudioClipPlaybackWindow,
  planAudioClipTailSources,
} from '../src/audio/audioClipPlanner';
import { createProjectMusicalTime } from '../src/audio/musicalTime';

const asset: ReadyAudioAsset = {
  id: 'asset-1',
  availability: 'ready',
  checksumSha256: 'a'.repeat(64),
  originalName: 'fixture.wav',
  mediaType: 'audio/wav',
  byteLength: 192_044,
  sampleRate: 48_000,
  channelCount: 1,
  frameCount: 48_000 * 8,
};

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'clip-1',
    trackId: 'audio-track',
    type: 'audio',
    startBeat: 0,
    lengthBeats: 8,
    loop: false,
    audioAssetId: asset.id,
    sourceStartFrame: 48_000,
    sourceFrameCount: 48_000 * 3,
    fadeInFrames: 24_000,
    fadeOutFrames: 24_000,
    gainDb: -6,
    ...overrides,
  };
}

function project(
  clip: AudioClip,
  tempoMap: Project['tempoMap'] = [{ id: 'tempo-0', beat: 0, bpm: 120 }],
): Project {
  const track: Track = {
    id: 'audio-track',
    name: 'Audio',
    type: 'audio',
    role: 'general',
    clips: [clip],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
  return {
    id: 'audio-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Audio planner test',
    bpm: tempoMap[0]?.bpm ?? 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 4,
    lengthBeats: 16,
    tempoMap,
    timeSignatureMap: [{
      id: 'meter-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [asset],
    automationLanes: [],
    tracks: [track],
    chordTrack: [],
    sections: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
}

describe('audio clip playback planner', () => {
  it('uses the selected source range and stops at the earlier source end', () => {
    const fixture = project(audioClip());
    const plans = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: fixture.lengthBeats,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      startBeat: 0,
      endBeat: 6,
      sourceOffsetSeconds: 1,
      durationSeconds: 3,
      loopStartSeconds: null,
      loopEndSeconds: null,
    });
    expect(plans[0]?.gainPoints).toEqual([
      { offsetSeconds: 0, value: 0 },
      { offsetSeconds: 0.5, value: audioClipGainToLinear(-6) },
      { offsetSeconds: 2.5, value: audioClipGainToLinear(-6) },
      { offsetSeconds: 3, value: 0 },
    ]);
  });

  it('resumes a one-shot clip from the current source offset and fade value', () => {
    const fixture = project(audioClip());
    const [plan] = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 1,
      windowEndBeat: 1.2,
    });

    expect(plan?.startBeat).toBe(1);
    expect(plan?.endBeat).toBe(6);
    expect(plan?.sourceOffsetSeconds).toBeCloseTo(1.5, 10);
    expect(plan?.durationSeconds).toBeCloseTo(2.5, 10);
    expect(plan?.gainPoints[0]?.value).toBeCloseTo(audioClipGainToLinear(-6), 10);
  });

  it('returns a stable occurrence id across adjacent lookahead windows', () => {
    const fixture = project(audioClip());
    const first = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 0.2,
    });
    const second = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0.2,
      windowEndBeat: 0.4,
    });

    expect(first[0]?.occurrenceId).toBe(second[0]?.occurrenceId);
    expect(second[0]?.sourceOffsetSeconds).toBeCloseTo(1.1, 10);
  });

  it('uses native source-range looping and keeps fade on the clip outer edges', () => {
    const fixture = project(audioClip({
      lengthBeats: 10,
      loop: true,
      sourceStartFrame: 24_000,
      sourceFrameCount: 48_000,
      fadeInFrames: 4_800,
      fadeOutFrames: 9_600,
    }));
    const [plan] = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 5,
      windowEndBeat: 5.2,
    });

    expect(plan).toMatchObject({
      startBeat: 5,
      endBeat: 10,
      sourceOffsetSeconds: 1,
      durationSeconds: 2.5,
      loopStartSeconds: 0.5,
      loopEndSeconds: 1.5,
    });
    expect(plan?.gainPoints[0]?.value).toBeCloseTo(audioClipGainToLinear(-6), 10);
    expect(plan?.gainPoints.at(-1)).toEqual({ offsetSeconds: 2.5, value: 0 });
  });

  it('maps source seconds through tempo changes without time stretching', () => {
    const fixture = project(
      audioClip({
        startBeat: 1,
        lengthBeats: 8,
        sourceStartFrame: 0,
        sourceFrameCount: 48_000 * 3,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      }),
      [
        { id: 'tempo-0', beat: 0, bpm: 120 },
        { id: 'tempo-1', beat: 2, bpm: 60 },
      ],
    );
    const tempo = createProjectMusicalTime(fixture).tempo;
    const [plan] = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 2.5,
      windowEndBeat: 2.75,
      tempo,
    });

    // Clip starts at 0.5s; beat 2.5 is 1.5s, therefore source offset is 1s.
    expect(plan?.sourceOffsetSeconds).toBeCloseTo(1, 10);
    expect(plan?.durationSeconds).toBeCloseTo(2, 10);
    // Three source seconds from beat 1 finish at absolute 3.5s = beat 4.5.
    expect(plan?.endBeat).toBeCloseTo(4.5, 10);
  });

  it('splits at transport-loop boundaries and restarts each pass at wrapped phase', () => {
    const fixture = project(audioClip({
      startBeat: 0,
      lengthBeats: 8,
      sourceStartFrame: 0,
      sourceFrameCount: 48_000 * 4,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      gainDb: 0,
    }));
    const loop = { startBeat: 1, endBeat: 3 };
    const firstPass = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 2.9,
      windowEndBeat: 3.1,
      transportLoop: loop,
    });

    expect(firstPass).toHaveLength(2);
    expect(firstPass[0]).toMatchObject({
      startBeat: 2.9,
      endBeat: 3,
      sourceOffsetSeconds: 1.45,
    });
    expect(firstPass[1]).toMatchObject({
      startBeat: 3,
      endBeat: 5,
      sourceOffsetSeconds: 0.5,
      durationSeconds: 1,
    });
    expect(firstPass[0]?.occurrenceId).not.toBe(firstPass[1]?.occurrenceId);
  });

  it('returns no occurrence at the half-open clip end', () => {
    const fixture = project(audioClip());
    expect(planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 6,
      windowEndBeat: 6.2,
    })).toEqual([]);
  });

  it('fails closed before materializing an excessive number of transport cycles', () => {
    const fixture = project(audioClip({ loop: true }));

    expect(() => planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 1,
      windowEndBeat: 2,
      transportLoop: { startBeat: 1, endBeat: 1.001 },
      maxPlans: 4,
    })).toThrow(AudioClipPlanLimitError);
  });

  it('returns immediately for projects without Audio Clips even with a tiny loop', () => {
    const fixture = project(audioClip());
    fixture.tracks = [];

    expect(planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 1,
      windowEndBeat: 2,
      transportLoop: { startBeat: 1, endBeat: 1.000_000_000_001 },
      maxPlans: 1,
    })).toEqual([]);
  });

  it('budgets candidate regions across transport passes before nested planning', () => {
    const fixture = project(audioClip({ loop: true }));
    fixture.tracks[0]?.clips.push(audioClip({ id: 'clip-2', loop: true }));

    expect(() => planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 1,
      windowEndBeat: 4,
      transportLoop: { startBeat: 1, endBeat: 2 },
      maxPlans: 4,
    })).toThrow(AudioClipPlanLimitError);
  });

  it('stops compiling at region 10,001 even when every clip is outside the tick', () => {
    const fixture = project(audioClip());
    fixture.tracks[0]!.clips = Array.from(
      { length: MAX_AUDIO_CLIP_REGIONS + 1 },
      (_, index) => audioClip({
        id: `sparse-clip-${index}`,
        startBeat: 8,
        lengthBeats: 1,
      }),
    );

    expect(() => planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 0.1,
    })).toThrowError(expect.objectContaining({
      limit: MAX_AUDIO_CLIP_REGIONS,
      observed: MAX_AUDIO_CLIP_REGIONS + 1,
    }) as AudioClipPlanLimitError);
  });

  it('reuses one compiled interval index across scheduler ticks', () => {
    const fixture = project(audioClip());
    const index = createAudioClipPlaybackIndex(fixture);
    const track = fixture.tracks[0]!;
    Object.defineProperty(track, 'clips', {
      configurable: true,
      get: () => {
        throw new Error('playback tick must not collect clips again');
      },
    });

    const first = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0,
      windowEndBeat: 0.2,
      index,
    });
    const second = planAudioClipPlaybackWindow(fixture, {
      windowStartBeat: 0.2,
      windowEndBeat: 0.4,
      index,
    });

    expect(index.regionCount).toBe(1);
    expect(first[0]?.occurrenceId).toBe(second[0]?.occurrenceId);
  });

  it('aggregates natural-tail ends without the playback occurrence cap', () => {
    const fixture = project(audioClip());
    fixture.tracks[0]!.clips = Array.from(
      { length: MAX_AUDIO_CLIP_PLANS_PER_WINDOW + 1 },
      (_, index) => audioClip({ id: `clip-${index}` }),
    );

    expect(planAudioClipTailSources(fixture, {
      startBeat: 0,
      endBeat: fixture.lengthBeats,
    })).toEqual([{ trackId: 'audio-track', endSeconds: 3 }]);
  });
});
