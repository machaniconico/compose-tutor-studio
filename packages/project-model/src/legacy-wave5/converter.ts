import { CURRENT_SCHEMA_VERSION } from '../factories';
import { MAX_CLIPS_PER_TRACK } from '../limits';
import { decodeProject } from '../project-codec';
import { assertScheduleEventBudget, MAX_RUNTIME_SCHEDULE_EVENTS, ScheduleEventLimitError } from '../schedule-budget';
import { countRealizedChordNotes } from '../chord-realization';
import { MAX_DRUM_STEPS_PER_BAR, MAX_PROJECT_TIMELINE_BEATS } from '../validation';
import { beatTick, clipTickSpan, PPQ } from '../ticks';
import type { AudioAsset, AudioRouting, Clip, InstrumentConfig, Project, Track } from '../types';
import { convertAutomation } from './automation';
import { convertClipContent, drumSteps, fittingBeats, loopPeriod, type ClipReport } from './clips';
import { convertEffects } from './effects';
import { copyOwnJson, detectOwnProjectFormat, OverLimit, type LegacyClip, type LegacyProject, type LegacyTrack } from './input';
import { normalizeClipDomain } from './normalize';
import { checkRawWorkLimits, MAX_LEGACY_EVENT_WORK } from './preflight';
import { reportTo, type Wave5ConvertErrorCode, type Wave5ConvertResult, type Wave5ReportItem } from './report';

const REASONS: Record<Wave5ConvertErrorCode, string> = {
  'not-wave5-v3': '以前の開発版の曲ファイルを選んでください。',
  'invalid-project': 'この曲の内容を確認できなかったため、変換できませんでした。',
  'over-limit': 'この曲はトラック、音符、ドラムの音のいずれかが多すぎるか、ドラムの目盛りが細かすぎるため、変換できませんでした。',
};

const fail = (code: Wave5ConvertErrorCode): Wave5ConvertResult => ({ ok: false, code, reason: REASONS[code] });

const LEARNING_ROLES = {
  chords: 'learning.chords', bass: 'learning.bass', melody: 'learning.melody',
} as const;

const MACROS = {
  brightness: 'macroBrightness', release: 'macroRelease', width: 'macroWidth', attack: 'macroAttack',
} as const;

function convertInstrument({ type, preset, params, macros }: NonNullable<LegacyTrack['instrument']>): InstrumentConfig {
  const macroParams = Object.entries(MACROS).flatMap(([oldKey, key]) =>
    macros && Object.hasOwn(macros, oldKey) ? [[key, macros[oldKey]!]] : []);
  return { type, preset, ...(params || macroParams.length ? { params: { ...params, ...Object.fromEntries(macroParams) } } : {}) };
}

function idAllocator(legacy: LegacyProject) {
  const trackAndClipIds = new Set<string>([legacy.id]);
  if (typeof legacy.id !== 'string' || !legacy.id.trim()) throw new TypeError('Invalid project ID');
  const originals = new Set<string>();
  for (const track of legacy.tracks) {
    for (const id of [track.id, ...track.clips.map((clip) => clip.id)]) {
      if (typeof id !== 'string' || !id.trim() || trackAndClipIds.has(id)) throw new TypeError('Ambiguous track or clip ID');
      trackAndClipIds.add(id);
    }
    for (const effect of track.effects) originals.add(effect.id);
    for (const clip of track.clips) {
      for (const note of clip.notes ?? []) originals.add(note.id);
      for (const hit of clip.drumEvents ?? []) originals.add(hit.id);
    }
  }
  for (const item of [...legacy.chordTrack, ...legacy.sections]) originals.add(item.id);
  const used = new Set(trackAndClipIds);
  const nextSuffix = new Map<string, number>();
  const make = (seed: string): string => {
    let suffix = nextSuffix.get(seed) ?? 1;
    let id = suffix === 1 ? seed : `${seed}-${suffix}`;
    while (used.has(id) || originals.has(id)) id = `${seed}-${++suffix}`;
    nextSuffix.set(seed, suffix + 1);
    used.add(id);
    return id;
  };
  return {
    make,
    claim(id: string): string {
      if (typeof id !== 'string' || !id.trim()) throw new TypeError('Invalid item ID');
      if (used.has(id)) return make(id);
      used.add(id);
      return id;
    },
  };
}

function fittingLength(start: number, length: number, end: number): number {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(length) || length <= 0) {
    throw new TypeError('Invalid Wave5 timeline range');
  }
  return Math.min(length, end - start);
}

function convert(input: LegacyProject): Wave5ConvertResult {
  checkRawWorkLimits(input);
  const { project: legacy, linkProblems, overlapLayers, extraTracks } = normalizeClipDomain(input);
  const ids = idAllocator(legacy);
  const [numerator, denominator] = legacy.timeSignature;
  const beatsPerBar = numerator * (4 / denominator);
  const lengthBeats = legacy.lengthBars * beatsPerBar;
  const songEndTick = beatTick(lengthBeats);
  if (lengthBeats <= 0 || lengthBeats > MAX_PROJECT_TIMELINE_BEATS || lengthBeats !== songEndTick / PPQ) {
    return fail('invalid-project');
  }

  const projectItems: Wave5ReportItem[] = [];
  const trackItems: Wave5ReportItem[] = [];
  const projectReport = reportTo(projectItems);
  const report = reportTo(trackItems);
  if (Object.hasOwn(input, 'legacyBarLimit')) projectReport('legacy-bar-limit-dropped');
  if (Object.hasOwn(input, 'loopRange')) projectReport('loop-range-dropped');

  const { id, title, key, scale, bpm, timeSignature, lengthBars, createdAt, updatedAt } = legacy;
  const audioRouting: AudioRouting = { outputs: [], sends: [] };
  const audioAssets: AudioAsset[] = [];
  const assetsByReference = new Map<string, string>();
  const project: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION, swing: legacy.swing ?? 0, hiHatChoke: true,
    id, title, key, scale, bpm, timeSignature, lengthBars, lengthBeats, createdAt, updatedAt,
    tempoMap: [{ id: ids.make(`${id}-tempo`), beat: 0, bpm }],
    timeSignatureMap: [{ id: ids.make(`${id}-meter`), beat: 0, numerator, denominator }],
    audioAssets, audioTakeFolders: [], audioRouting, automationLanes: [],
    automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    tracks: [], chordTrack: [], sections: [],
  };
  const trimmed = { clips: 0, chords: 0, sections: 0 };
  const clips = new Map<string, {
    raw: LegacyClip; trackId: string; start: number; length: number; lengthBeats: number; period: number; type: Clip['type'];
  }>();
  for (const track of legacy.tracks) {
    for (const raw of track.clips) {
      if (!Number.isFinite(raw.startBeat) || raw.startBeat < 0 ||
          !Number.isFinite(raw.lengthBeats) || raw.lengthBeats <= 0) throw new TypeError('Invalid clip range');
      const [start, end] = clipTickSpan(raw.startBeat, raw.lengthBeats);
      const length = Math.max(0, Math.min(end, songEndTick) - start);
      if (raw.startBeat + raw.lengthBeats > lengthBeats) trimmed.clips++;
      clips.set(raw.id, {
        raw, trackId: track.id, start, length, period: loopPeriod(raw, end),
        lengthBeats: length > 0 ? fittingBeats(start / PPQ, length / PPQ, lengthBeats) : 0,
        type: raw.type,
      });
    }
  }
  for (const track of legacy.tracks) {
    for (const raw of track.clips) {
      const placement = clips.get(raw.id)!;
      if (placement.length <= 0) continue;
      const source = (raw.aliasOf === undefined ? undefined : clips.get(raw.aliasOf)?.raw) ?? raw;
      if (raw.type === 'drum' && track.type === 'instrument' && source.notes?.length) placement.type = 'midi';
      if (raw.type === 'midi' && track.type === 'drum' && source.drumEvents?.length) placement.type = 'drum';
    }
  }

  for (const chord of legacy.chordTrack) {
    const { id, symbol, root, quality, notes, degree, function: chordFunction, tags } = chord;
    const length = fittingLength(chord.startBeat, chord.durationBeats, lengthBeats);
    if (length !== chord.durationBeats) trimmed.chords++;
    if (length <= 0) continue;
    const [start, end] = clipTickSpan(chord.startBeat, chord.durationBeats);
    const startBeat = start / PPQ;
    const ticks = Math.min(end, songEndTick) - start;
    if (ticks <= 0) continue;
    const durationBeats = fittingBeats(startBeat, ticks / PPQ, lengthBeats);
    project.chordTrack.push({
      id: ids.claim(id), startBeat, durationBeats, symbol, root, quality, notes,
      ...(degree !== undefined ? { degree } : {}),
      ...(chordFunction !== undefined ? { function: chordFunction } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });
  }
  for (const section of legacy.sections) {
    const { id, name, type, startBar } = section;
    const length = fittingLength(startBar, section.lengthBars, lengthBars);
    if (length !== section.lengthBars) trimmed.sections++;
    if (length > 0) project.sections.push({ id: ids.claim(id), name, type, startBar, lengthBars: length });
  }
  if (Object.values(trimmed).some((count) => count > 0)) projectReport('song-end-trimmed', { detail: trimmed });

  let eventWork = 0;
  let ownedEvents = 0;
  const useEventWork = (count: number): void => {
    eventWork += count;
    if (eventWork > MAX_LEGACY_EVENT_WORK) throw new OverLimit();
  };
  const roles = new Set<Track['role']>();
  const buses = new Set(legacy.tracks.filter((track) => track.type === 'bus').map((track) => track.id));
  for (const rawTrack of legacy.tracks) {
    const { id: trackId, name, type, volume, pan, mute, solo, color, instrument, sends } = rawTrack;
    let role: Track['role'] = 'general';
    if (type === 'instrument' && !extraTracks.has(trackId) &&
        rawTrack.role && Object.hasOwn(LEARNING_ROLES, rawTrack.role)) {
      const learningRole = LEARNING_ROLES[rawTrack.role as keyof typeof LEARNING_ROLES];
      if (roles.has(learningRole)) report('duplicate-role-demoted', { trackId, detail: { role: rawTrack.role } });
      else {
        roles.add(learningRole);
        role = learningRole;
      }
    }
    const layers = overlapLayers.get(trackId);
    if (layers !== undefined) report('overlap-split', { trackId, detail: { layers } });
    const effects = convertEffects(rawTrack.effects, trackId, ids.claim, report);
    const track: Track = {
      id: trackId, name, type, role, volume, pan, mute, solo, effects, clips: [],
      ...(color !== undefined ? { color } : {}),
      ...(instrument !== undefined ? { instrument: convertInstrument(instrument) } : {}),
    };
    project.tracks.push(track);
    if (type !== 'master') audioRouting.outputs.push({ sourceTrackId: trackId, destination: { type: 'master' } });
    for (const [targetBusId, gain] of Object.entries(sends ?? {})) {
      if (gain === 0) continue;
      if (type === 'master' || type === 'bus' || !buses.has(targetBusId) ||
          typeof gain !== 'number' || !(gain > 0 && gain <= 1)) {
        report('send-dropped', { trackId, detail: { targetId: targetBusId } });
        continue;
      }
      audioRouting.sends.push({
        id: ids.make(`${trackId}-send-${targetBusId}`), sourceTrackId: trackId, targetBusId,
        position: 'post-fader', gain, enabled: true,
      });
    }
    project.automationLanes.push(...convertAutomation(rawTrack, lengthBeats, ids.make, report));

    for (const raw of rawTrack.clips) {
      const placement = clips.get(raw.id)!;
      if (placement.length <= 0) {
        if (placement.start < songEndTick && raw.notes?.length) {
          report('hidden-events-dropped', { trackId, detail: { count: raw.notes.length } });
        }
        continue;
      }
      const clip: Clip = {
        id: raw.id, trackId, type: placement.type, startBeat: placement.start / PPQ,
        lengthBeats: placement.lengthBeats, loop: false,
      };
      if (track.clips.length >= MAX_CLIPS_PER_TRACK) throw new OverLimit();
      track.clips.push(clip);
      const clipReport: ClipReport = (code, detail) =>
        report(code, { trackId, clipId: clip.id, ...(detail ? { detail } : {}) });

      if (clip.type !== raw.type) clipReport('clip-type-changed', { from: raw.type, to: clip.type });
      if (Object.hasOwn(raw, 'legacyClipSettings')) clipReport('legacy-clip-settings-dropped');
      const linkProblem = linkProblems.get(raw.id);
      if (linkProblem === 'cyclic') clipReport('link-cyclic');
      else if (linkProblem) clipReport('link-broken', { reason: linkProblem });

      const linked = raw.aliasOf === undefined ? undefined : clips.get(raw.aliasOf);
      const source = linked?.raw ?? raw;
      if (clip.type === 'drum' && drumSteps(source) > MAX_DRUM_STEPS_PER_BAR) throw new OverLimit();
      const { period } = placement;
      if (linked) {
        const reason = Number.isFinite(period) ? 'own-loop'
          : trackId !== linked.trackId ? 'cross-track'
          : clip.lengthBeats !== linked.lengthBeats ? 'length-mismatch'
          : Number.isFinite(linked.period) ? 'source-unrolled'
          : clip.type !== linked.type ? 'clip-type-changed'
          : Math.abs((raw.startBeat * PPQ - placement.start) -
              (source.startBeat * PPQ - linked.start)) > 1e-9 ? 'sub-tick-phase'
          : undefined;
        if (reason) clipReport('link-materialized', { reason });
        else if (clip.type === 'midi' || clip.type === 'drum') {
          clip.aliasOf = source.id;
          continue;
        }
      }

      if (clip.type === 'audio') {
        const ref = source.audioAssetId;
        const isReference = typeof ref === 'string' && ref.length > 0;
        let audioAssetId = isReference ? assetsByReference.get(ref) : undefined;
        if (audioAssetId === undefined) {
          audioAssetId = ids.make(`${clip.id}-asset`);
          audioAssets.push({ id: audioAssetId, availability: 'unresolved',
            ...(isReference ? { legacyAssetId: ref, reason: 'legacy-reference' } : { reason: 'missing-reference' }) });
          if (isReference) assetsByReference.set(ref, audioAssetId);
        }
        Object.assign(clip, { audioAssetId, sourceStartFrame: 0, sourceFrameCount: 0, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0 });
        clipReport('audio-clip-unresolved');
      }
      convertClipContent(clip, raw, source, period, type, beatsPerBar, project.swing, linked !== undefined,
        useEventWork, (eventId, pass) => linked || pass > 0 ? ids.make(`${clip.id}-${eventId}-${pass}`) : ids.claim(eventId),
        clipReport);
      ownedEvents += (clip.notes?.length ?? 0) + (clip.drumEvents?.length ?? 0);
      if (ownedEvents > MAX_RUNTIME_SCHEDULE_EVENTS) throw new OverLimit();
    }
  }

  const decoded = decodeProject(project);
  if (!decoded.ok) return fail('invalid-project');
  assertScheduleEventBudget(decoded.project);
  if (countRealizedChordNotes(decoded.project) > 0) projectReport('chord-track-audible');
  if (project.tracks.some((track) => track.effects.some((effect) => effect.enabled))) projectReport('effects-approximated');
  return { ok: true, project: decoded.project, report: [...projectItems, ...trackItems] };
}

/** Explicit, deterministic import of the alternate Wave5 v3 file format. */
export function convertWave5Project(json: unknown): Wave5ConvertResult {
  let input: LegacyProject;
  try {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return fail('not-wave5-v3');
    const format = detectOwnProjectFormat(json);
    if (format === 'main') return fail('not-wave5-v3');
    if (format === 'invalid-project') return fail('invalid-project');
    input = copyOwnJson(json) as LegacyProject;
  } catch {
    return fail('invalid-project');
  }
  try {
    return convert(input);
  } catch (error) {
    return fail(error instanceof OverLimit || error instanceof ScheduleEventLimitError ? 'over-limit' : 'invalid-project');
  }
}
