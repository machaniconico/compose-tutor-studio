import { describe, expect, it, vi } from 'vitest';
import {
  compileAudioRouting,
  validateProject,
  type Project,
} from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';
import {
  MAX_WAV_SCHEDULE_EVENTS,
  buildWavAudioClipPlans,
  buildWavScheduleEvents,
  planWavRender,
  renderSelectedTrackToWav,
  resolveSelectedTrackRoutingMix,
  resolveWavRenderProject,
} from '../src/audio/wav';
import { getReservedHeavyAudioResourceBytes } from '../src/audio/audioResourceReservation';

describe('WAV render scope', () => {
  it('preserves the exact Project identity for a full mix', () => {
    const project = createDefaultProject();
    expect(resolveWavRenderProject(project, { kind: 'mix' })).toBe(project);
  });

  it.each([
    [null, 'no-selection'],
    ['missing', 'missing-track'],
  ] as const)('rejects %s before resolver, reservation, or OfflineAudioContext', async (
    trackId,
    reason,
  ) => {
    const project = createDefaultProject();
    const before = structuredClone(project);
    const resolve = vi.fn();
    const offline = vi.fn();
    vi.stubGlobal('OfflineAudioContext', offline);

    await expect(renderSelectedTrackToWav(project, trackId, {
      audioAssetResolver: { resolve },
    })).rejects.toMatchObject({ reason });
    expect(resolve).not.toHaveBeenCalled();
    expect(offline).not.toHaveBeenCalled();
    expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    expect(project).toEqual(before);
    vi.unstubAllGlobals();
  });

  it.each(['master', 'bus'] as const)(
    'rejects a selected %s before external work',
    async (kind) => {
      const base = createDefaultProject();
      const master = base.tracks.find((track) => track.type === 'master');
      if (!master) throw new Error('fixture Master missing');
      const project: Project = kind === 'master'
        ? base
        : {
            ...base,
            tracks: base.tracks.map((track) =>
              track.id === master.id ? { ...track, type: 'bus' as const } : track),
          };
      const id = master.id;
      const resolve = vi.fn();
      await expect(renderSelectedTrackToWav(project, id, {
        audioAssetResolver: { resolve },
      })).rejects.toMatchObject({
        reason: 'unsupported-track',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(getReservedHeavyAudioResourceBytes()).toBe(0);
    },
  );

  it('keeps a valid unresolved legacy placeholder from blocking an Instrument bounce', () => {
    const base = createDefaultProject();
    const selected = base.tracks.find((track) => track.type === 'instrument');
    if (!selected) throw new Error('fixture Instrument Track missing');
    const project: Project = {
      ...base,
      audioAssets: [{
        id: 'legacy-placeholder-asset',
        availability: 'unresolved',
        legacyAssetId: 'old-audio-reference',
        reason: 'legacy-reference',
      }],
      tracks: base.tracks.map((track) =>
        track.id === selected.id
          ? {
              ...track,
              clips: [
                ...track.clips,
                {
                  id: 'legacy-placeholder-clip',
                  trackId: selected.id,
                  type: 'audio' as const,
                  startBeat: 0,
                  lengthBeats: 1,
                  loop: false,
                  audioAssetId: 'legacy-placeholder-asset',
                  sourceStartFrame: 0,
                  sourceFrameCount: 0,
                  fadeInFrames: 0,
                  fadeOutFrames: 0,
                  gainDb: 0,
                },
              ],
            }
          : track),
    };
    expect(validateProject(project)).toMatchObject({ ok: true });

    const scoped = resolveWavRenderProject(project, {
      kind: 'selected-track',
      trackId: selected.id,
    });

    expect(buildWavScheduleEvents(scoped).length).toBeGreaterThan(0);
    expect(scoped.tracks.find((track) => track.id === selected.id)?.clips)
      .toHaveLength(selected.clips.length + 1);
  });

  it.each([
    ['clip', true, 'asset-unavailable'],
    ['clip', false, 'asset-missing'],
    ['take-folder', true, 'asset-unavailable'],
  ] as const)(
    'rejects a selected Audio %s with unavailable metadata before external work',
    async (sourceKind, includeUnresolvedMetadata, code) => {
      const base = createDefaultProject();
      const selected = base.tracks.find((track) => track.type === 'instrument');
      if (!selected) throw new Error('fixture Instrument Track missing');
      const unresolvedAssets = [
        {
          id: 'unresolved-a',
          availability: 'unresolved' as const,
          reason: 'missing-reference' as const,
        },
        {
          id: 'unresolved-b',
          availability: 'unresolved' as const,
          reason: 'missing-reference' as const,
        },
      ];
      const project: Project = {
        ...base,
        audioAssets: includeUnresolvedMetadata ? unresolvedAssets : [],
        tracks: base.tracks.map((track) =>
          track.id === selected.id
            ? {
                ...track,
                type: 'audio' as const,
                role: 'general' as const,
                clips: sourceKind === 'clip'
                  ? [{
                      id: 'unresolved-clip',
                      trackId: selected.id,
                      type: 'audio' as const,
                      startBeat: 0,
                      lengthBeats: 1,
                      loop: false,
                      audioAssetId: 'unresolved-a',
                      sourceStartFrame: 0,
                      sourceFrameCount: 0,
                      fadeInFrames: 0,
                      fadeOutFrames: 0,
                      gainDb: 0,
                    }]
                  : [],
              }
            : track),
        audioTakeFolders: sourceKind === 'take-folder'
          ? [{
              id: 'unresolved-folder',
              trackId: selected.id,
              startBeat: 0,
              lengthBeats: 1,
              crossfadeMs: 20,
              takes: [
                {
                  id: 'take-a',
                  audioAssetId: 'unresolved-a',
                  offsetBeats: 0,
                  lengthBeats: 1,
                  sourceStartFrame: 0,
                  sourceFrameCount: 48_000,
                  fadeInFrames: 0,
                  fadeOutFrames: 0,
                  gainDb: 0,
                },
                {
                  id: 'take-b',
                  audioAssetId: 'unresolved-b',
                  offsetBeats: 0,
                  lengthBeats: 1,
                  sourceStartFrame: 0,
                  sourceFrameCount: 48_000,
                  fadeInFrames: 0,
                  fadeOutFrames: 0,
                  gainDb: 0,
                },
              ],
              compSegments: [{
                id: 'segment-a',
                takeId: 'take-a',
                offsetBeats: 0,
                lengthBeats: 1,
              }],
            }]
          : [],
      };
      const before = structuredClone(project);
      const resolve = vi.fn();
      const offline = vi.fn();
      vi.stubGlobal('OfflineAudioContext', offline);
      if (sourceKind === 'clip' && includeUnresolvedMetadata) {
        expect(validateProject(project)).toMatchObject({ ok: true });
      }

      await expect(renderSelectedTrackToWav(project, selected.id, {
        audioAssetResolver: { resolve },
      })).rejects.toMatchObject({
        code,
        assetId: 'unresolved-a',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(offline).not.toHaveBeenCalled();
      expect(getReservedHeavyAudioResourceBytes()).toBe(0);
      expect(project).toEqual(before);
      vi.unstubAllGlobals();
    },
  );

  it('projects only the selected sources and retains its whole take folder', () => {
    const base = createDefaultProject();
    const selected = base.tracks[1]!;
    const other = base.tracks[0]!;
    const folder = {
      id: 'selected-folder',
      trackId: selected.id,
      startBeat: 0,
      lengthBeats: 4,
      crossfadeMs: 20,
      takes: [
        { id: 'take-a', audioAssetId: 'a', offsetBeats: 0, lengthBeats: 4, sourceStartFrame: 0, sourceFrameCount: 100, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0 },
        { id: 'take-b', audioAssetId: 'b', offsetBeats: 0, lengthBeats: 4, sourceStartFrame: 0, sourceFrameCount: 100, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0 },
      ],
      compSegments: [
        { id: 'segment-a', takeId: 'take-a', offsetBeats: 0, lengthBeats: 2 },
        { id: 'segment-b', takeId: 'take-b', offsetBeats: 2, lengthBeats: 2 },
      ],
    };
    const project = {
      ...base,
      audioAssets: ['a', 'b'].map((id) => ({
        id,
        availability: 'ready' as const,
        checksumSha256: id.repeat(64),
        originalName: `${id}.wav`,
        mediaType: 'audio/wav' as const,
        byteLength: 200,
        sampleRate: 48_000,
        channelCount: 1,
        frameCount: 100,
      })),
      audioTakeFolders: [
        folder,
        { ...folder, id: 'other-folder', trackId: other.id },
      ],
    };
    const scoped = resolveWavRenderProject(project, {
      kind: 'selected-track',
      trackId: selected.id,
    });

    expect(scoped.tracks).toHaveLength(project.tracks.length);
    expect(scoped.tracks.find((track) => track.id === selected.id)?.clips)
      .toBe(selected.clips);
    expect(scoped.tracks
      .filter((track) => track.id !== selected.id)
      .every((track) => track.clips.length === 0)).toBe(true);
    expect(scoped.tracks.find((track) => track.id === other.id)?.role).toBe('general');
    expect(scoped.audioTakeFolders).toEqual([folder]);
    expect(scoped.audioTakeFolders[0]?.takes).toHaveLength(2);
    expect(scoped.audioTakeFolders[0]?.compSegments).toEqual(folder.compSegments);
    expect(project.audioTakeFolders).toHaveLength(2);
  });

  it('projects MIDI, Drum, Audio, linked sources, and resource limits by selected Track only', () => {
    const base = createDefaultProject();
    const instrument = base.tracks.find((track) => track.type === 'instrument' && track.role !== 'learning.chords')!;
    const drums = base.tracks.find((track) => track.type === 'drum')!;
    const canonical = {
      ...instrument.clips[0]!,
      id: 'canonical-midi',
      notes: [{
        id: 'selected-note',
        pitch: 60,
        startBeat: 0,
        durationBeats: 1,
        velocity: 100,
      }],
    };
    const linked = {
      ...canonical,
      id: 'linked-midi',
      startBeat: 4,
      aliasOf: canonical.id,
      notes: undefined,
    };
    const midiProject: Project = {
      ...base,
      tracks: base.tracks.map((track) =>
        track.id === instrument.id
          ? { ...track, clips: [linked, canonical] }
          : track),
    };
    const midiSource = resolveWavRenderProject(midiProject, {
      kind: 'selected-track',
      trackId: instrument.id,
    });
    const midiEvents = buildWavScheduleEvents(midiSource);
    expect(midiEvents).toHaveLength(2);
    expect(midiEvents.every((event) =>
      (event.payload as { trackId?: string }).trackId === instrument.id)).toBe(true);
    expect(midiSource.tracks.find((track) => track.role === 'learning.chords')?.role)
      .toBeUndefined();

    const drumProject: Project = {
      ...base,
      tracks: base.tracks.map((track) =>
        track.id === drums.id
          ? {
              ...track,
              clips: [{
                ...track.clips[0]!,
                drumEvents: [{
                  id: 'selected-kick',
                  lane: 'kick' as const,
                  stepIndex: 0,
                  velocity: 100,
                }],
              }],
            }
          : track),
    };
    const drumSource = resolveWavRenderProject(drumProject, {
      kind: 'selected-track',
      trackId: drums.id,
    });
    expect(buildWavScheduleEvents(drumSource)).toHaveLength(1);

    const audioTrack = {
      ...instrument,
      id: 'selected-audio',
      name: 'Selected Audio',
      type: 'audio' as const,
      role: 'general' as const,
      instrument: undefined,
      clips: [{
        id: 'selected-audio-clip',
        trackId: 'selected-audio',
        type: 'audio' as const,
        startBeat: 0,
        lengthBeats: 1,
        loop: false,
        audioAssetId: 'selected-audio-asset',
        sourceStartFrame: 0,
        sourceFrameCount: 48_000,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        gainDb: 0,
      }],
    };
    const audioProject: Project = {
      ...base,
      audioAssets: [{
        id: 'selected-audio-asset',
        availability: 'ready',
        checksumSha256: 'a'.repeat(64),
        originalName: 'selected.wav',
        mediaType: 'audio/wav',
        byteLength: 96_044,
        sampleRate: 48_000,
        channelCount: 1,
        frameCount: 48_000,
      }],
      tracks: [...base.tracks, audioTrack],
      audioRouting: {
        ...base.audioRouting,
        outputs: [
          ...base.audioRouting.outputs,
          { sourceTrackId: audioTrack.id, destination: { type: 'master' } },
        ],
      },
    };
    const audioSource = resolveWavRenderProject(audioProject, {
      kind: 'selected-track',
      trackId: audioTrack.id,
    });
    expect(buildWavAudioClipPlans(audioSource)).toEqual([
      expect.objectContaining({
        trackId: audioTrack.id,
        assetId: 'selected-audio-asset',
      }),
    ]);

    const excessiveNotes = Array.from(
      { length: MAX_WAV_SCHEDULE_EVENTS + 1 },
      (_, index) => ({
        id: `unrelated-note-${index}`,
        pitch: 64,
        startBeat: 0,
        durationBeats: 1,
        velocity: 64,
      }),
    );
    const overBudgetProject: Project = {
      ...midiProject,
      tracks: midiProject.tracks.map((track) =>
        track.id === base.tracks[2]?.id
          ? {
              ...track,
              clips: [{ ...track.clips[0]!, notes: excessiveNotes }],
            }
          : track),
    };
    expect(() => buildWavScheduleEvents(resolveWavRenderProject(overBudgetProject, {
      kind: 'selected-track',
      trackId: instrument.id,
    }))).not.toThrow();
    expect(() => buildWavScheduleEvents(resolveWavRenderProject({
      ...overBudgetProject,
      tracks: overBudgetProject.tracks.map((track) =>
        track.id === instrument.id
          ? { ...track, clips: [{ ...canonical, notes: excessiveNotes }] }
          : track),
    }, {
      kind: 'selected-track',
      trackId: instrument.id,
    }))).toThrow();
  });

  it('opens a muted selected source and muted nested downstream Bus closure only', () => {
    const base = createDefaultProject();
    const selected = { ...base.tracks[0]!, mute: true };
    const unrelated = { ...base.tracks[1]!, solo: true };
    const master = base.tracks.find((track) => track.type === 'master')!;
    const bus = { ...base.tracks[2]!, id: 'bus', type: 'bus' as const, mute: true, clips: [] };
    const nested = { ...base.tracks[3]!, id: 'nested', type: 'bus' as const, clips: [] };
    const project: Project = {
      ...base,
      tracks: [selected, unrelated, bus, nested, master],
      audioRouting: {
        outputs: [
          { sourceTrackId: selected.id, destination: { type: 'bus', trackId: bus.id } },
          { sourceTrackId: unrelated.id, destination: { type: 'master' } },
          { sourceTrackId: bus.id, destination: { type: 'bus', trackId: nested.id } },
          { sourceTrackId: nested.id, destination: { type: 'master' } },
        ],
        sends: [{
          id: 'selected-send',
          sourceTrackId: selected.id,
          targetBusId: nested.id,
          position: 'pre-fader',
          gain: 1.5,
          enabled: true,
        }],
      },
    };
    const compiled = compileAudioRouting(project);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const mix = resolveSelectedTrackRoutingMix(project, selected.id, compiled.plan);

    expect([...mix.audibleChannelIds]).toEqual([selected.id, bus.id, nested.id]);
    expect(mix.edgeGains.get(`output:${selected.id}`)).toBe(1);
    expect(mix.edgeGains.get('send:selected-send')).toBe(1.5);
    expect(mix.edgeGains.get(`output:${unrelated.id}`)).toBe(0);
    expect(bus.mute).toBe(true);
    expect(project.tracks.find((track) => track.id === bus.id)?.mute).toBe(true);
  });

  it('uses the selected closure for nested effect tails and excludes zero-gain sends', () => {
    const base = createDefaultProject();
    const sourceBase = base.tracks.find((track) => track.type === 'instrument');
    const master = base.tracks.find((track) => track.type === 'master');
    if (!sourceBase || !master) throw new Error('fixture Tracks missing');
    const source = {
      ...sourceBase,
      id: 'tail-source',
      role: 'general' as const,
      clips: [{
        id: 'tail-source-clip',
        trackId: 'tail-source',
        type: 'midi' as const,
        startBeat: 0,
        lengthBeats: 4,
        loop: false,
        notes: [{
          id: 'tail-source-note',
          pitch: 60,
          startBeat: 3.9,
          durationBeats: 0.1,
          velocity: 100,
        }],
      }],
      effects: [{
        id: 'source-compressor',
        type: 'compressor' as const,
        enabled: true,
        params: {},
      }],
    };
    const wetBus = {
      id: 'wet-tail-bus',
      name: 'Wet tail Bus',
      type: 'bus' as const,
      role: 'general' as const,
      clips: [],
      volume: 1,
      pan: 0,
      mute: true,
      solo: false,
      effects: [{
        id: 'wet-delay',
        type: 'delay' as const,
        enabled: true,
        params: { delayTime: 0.5, feedback: 0.5, mix: 1 },
      }],
    };
    const excludedBus = {
      ...wetBus,
      id: 'excluded-tail-bus',
      name: 'Excluded tail Bus',
      effects: [{
        id: 'excluded-delay',
        type: 'delay' as const,
        enabled: true,
        params: { delayTime: 1, feedback: 1, mix: 1 },
      }],
    };
    const projectFor = (position: 'pre-fader' | 'post-fader'): Project => ({
      ...base,
      lengthBars: 1,
      lengthBeats: 4,
      chordTrack: [],
      tracks: [source, wetBus, excludedBus, master],
      audioRouting: {
        outputs: [
          { sourceTrackId: source.id, destination: { type: 'master' } },
          { sourceTrackId: wetBus.id, destination: { type: 'master' } },
          { sourceTrackId: excludedBus.id, destination: { type: 'master' } },
        ],
        sends: [
          {
            id: 'wet-tail-send',
            sourceTrackId: source.id,
            targetBusId: wetBus.id,
            position,
            gain: 1,
            enabled: true,
          },
          {
            id: 'zero-tail-send',
            sourceTrackId: source.id,
            targetBusId: excludedBus.id,
            position: 'post-fader',
            gain: 0,
            enabled: true,
          },
        ],
      },
    });
    const renderPlan = (project: Project) => {
      const compiled = compileAudioRouting(project);
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
      const mix = resolveSelectedTrackRoutingMix(project, source.id, compiled.plan);
      const sourceProject = resolveWavRenderProject(project, {
        kind: 'selected-track',
        trackId: source.id,
      });
      return {
        mix,
        plan: planWavRender(
          project,
          buildWavScheduleEvents(sourceProject),
          [],
          {
            plan: compiled.plan,
            audibleChannelIds: mix.audibleChannelIds,
            activeEdgeIds: mix.activeEdgeIds,
          },
        ),
      };
    };

    const pre = renderPlan(projectFor('pre-fader'));
    const post = renderPlan(projectFor('post-fader'));

    expect(post.mix.audibleChannelIds).toContain(wetBus.id);
    expect(post.mix.audibleChannelIds).not.toContain(excludedBus.id);
    expect(post.mix.activeEdgeIds).not.toContain('send:zero-tail-send');
    expect(post.plan.uncappedTailSeconds).toBeGreaterThan(pre.plan.uncappedTailSeconds);
    expect(post.plan.frames).toBeGreaterThan(pre.plan.frames);
  });
});
