import {
  DEFAULT_MIDI_PARSE_LIMITS,
  MidiImportError,
  parseMidiFile,
  type ImportedMidiInitialChannel,
  type ImportedMidiNote,
  type ImportedMidiTrack,
  type ParsedMidiFile,
} from '@cts/midi-io';
import {
  MAX_EVENTS_PER_CLIP,
  MAX_PROJECT_TIMELINE_BEATS,
  MAX_PROJECT_STRING_LENGTH,
  MAX_PROJECT_TRACKS,
  MIN_EVENT_DURATION_BEATS,
  barToBeatAt,
  beatToBarPosition,
  beatsPerBar as beatsPerBarForTimeSignature,
  compileDrumStepProjector,
  compileMusicalTime,
  projectDrumStep,
  type Clip,
  type DrumLane,
  type MusicalTimeIndex,
  type NoteEvent,
  type Project,
  type Track,
} from '@cts/project-model';
import { uid } from './ids';
import { useStore } from './store';

const IMPORT_TRACK_COLORS = ['#8b6dd8', '#4f8dd8', '#42a879', '#d28b45', '#bd628c'] as const;
const IMPORT_TRACK_PRESET = 'brightPluck';
const IMPORT_DRUM_PRESET = 'basic';
const MIN_CLIP_LENGTH_BEATS = 1;
const IMPORT_DRUM_STEPS_PER_BAR = 16;
const IMPORT_DRUM_DURATION_BEATS = 0.25;
const MIDI_DRUM_CHANNEL = 9;
const MIDI_DRUM_LANES: Readonly<Record<number, DrumLane>> = Object.freeze({
  36: 'kick',
  38: 'snare',
  42: 'closedHat',
  46: 'openHat',
  39: 'clap',
  37: 'perc',
});
export const MAX_MIDI_IMPORT_BYTES = DEFAULT_MIDI_PARSE_LIMITS.maxBytes;

export type ImportMidiIdFactory = (prefix: string) => string;

export type MidiImportMapping =
  | {
      ok: true;
      tracks: Track[];
      clips: Clip[];
      /** First imported item, retained for source compatibility with callers. */
      track: Track;
      clip: Clip;
      noteCount: number;
      lengthBeats: number;
      sourceTrackCount: number;
      importedTrackCount: number;
      warnings: string[];
    }
  | {
      ok: false;
      message: string;
    };

export type MidiImportResult =
  | {
      ok: true;
      trackId: string;
      clipId: string;
      trackName: string;
      trackIds: string[];
      clipIds: string[];
      trackCount: number;
      noteCount: number;
      warnings: string[];
    }
  | {
      ok: false;
      message: string;
    };

export type MidiImportStoreController = {
  project: Project;
  saveState: { activationId: string };
  projectOperationBusy: boolean;
  applyProjectChange: (change: (project: Project) => Project) => boolean;
  selectTrack: (trackId: string | null) => void;
  selectClip: (clipId: string | null) => void;
  selectNotes: (noteIds: string[]) => void;
  setActiveView: (view: 'pianoRoll' | 'drums') => void;
};

export type MidiImportStoreProvider = () => MidiImportStoreController;

type MidiImportStart = Readonly<{
  projectId: string;
  activationId: string;
}>;

type NormalizedNote = Omit<NoteEvent, 'id'> & { channel: number };

type MidiNoteGroup = Readonly<{
  sourceTrackIndex: number;
  sourceTrack: ImportedMidiTrack;
  channel: number;
  notes: NormalizedNote[];
  initialChannel?: ImportedMidiInitialChannel;
  sourceChannelCount: number;
}>;

export type MapParsedMidiOptions = {
  makeId: ImportMidiIdFactory;
  /** Used only when the source has no useful explicit track name. */
  trackName?: string;
  color?: string;
  preset?: string;
  reservedTrackNames?: readonly string[];
  targetBpm?: number;
  targetTimeSignature?: Project['timeSignature'];
  /** Compiled timeline of the Project receiving the import. */
  targetMusicalTime?: MusicalTimeIndex;
  targetKey?: Project['key'];
  targetScale?: Project['scale'];
  maxTracks?: number;
};

function normalizeNote(note: ImportedMidiNote): NormalizedNote | null {
  if (note.durationBeat === 0) return null;
  return {
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeat,
    velocity: note.velocity,
    channel: note.channel,
  };
}

function inspectParsedNotes(parsed: ParsedMidiFile):
  | Readonly<{ ok: true; zeroDurationCount: number }>
  | Readonly<{ ok: false; message: string }> {
  let zeroDurationCount = 0;
  for (const track of parsed.tracks) {
    for (const note of track.notes) {
      if (note.durationBeat === 0) {
        zeroDurationCount += 1;
        continue;
      }
      if (
        !Number.isInteger(note.pitch) ||
        note.pitch < 0 ||
        note.pitch > 127 ||
        !Number.isInteger(note.velocity) ||
        note.velocity < 1 ||
        note.velocity > 127 ||
        !Number.isInteger(note.channel) ||
        note.channel < 0 ||
        note.channel > 15 ||
        !Number.isFinite(note.startBeat) ||
        note.startBeat < 0 ||
        !Number.isFinite(note.durationBeat) ||
        note.durationBeat < MIN_EVENT_DURATION_BEATS ||
        note.durationBeat > MAX_PROJECT_TIMELINE_BEATS ||
        note.startBeat + note.durationBeat > MAX_PROJECT_TIMELINE_BEATS
      ) {
        return {
          ok: false,
          message: 'このMIDIには現在の曲へ安全に追加できない範囲の音符があります。内容を短くしてもう一度お試しください。',
        };
      }
    }
  }
  return { ok: true, zeroDurationCount };
}

function compareNotes(a: NormalizedNote, b: NormalizedNote): number {
  return a.startBeat - b.startBeat || a.pitch - b.pitch || b.velocity - a.velocity;
}

function importedLengthBeats(notes: readonly NormalizedNote[]): number {
  const endBeat = notes.reduce(
    (max, note) => Math.max(max, note.startBeat + note.durationBeats),
    0,
  );
  return Math.max(MIN_CLIP_LENGTH_BEATS, endBeat);
}

function noteEvent(note: NormalizedNote, id: string): NoteEvent {
  return {
    id,
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
  };
}

function groupParsedMidi(parsed: ParsedMidiFile): MidiNoteGroup[] {
  const groups: MidiNoteGroup[] = [];
  parsed.tracks.forEach((sourceTrack, sourceTrackIndex) => {
    const byChannel = new Map<number, NormalizedNote[]>();
    for (const sourceNote of sourceTrack.notes) {
      const normalized = normalizeNote(sourceNote);
      if (!normalized) continue;
      const notes = byChannel.get(normalized.channel) ?? [];
      notes.push(normalized);
      byChannel.set(normalized.channel, notes);
    }
    const channels = [...byChannel.keys()].sort((a, b) => a - b);
    for (const channel of channels) {
      const notes = byChannel.get(channel);
      if (!notes || notes.length === 0) continue;
      notes.sort(compareNotes);
      groups.push({
        sourceTrackIndex,
        sourceTrack,
        channel,
        notes,
        initialChannel: sourceTrack.initialChannels?.find(
          (candidate) => candidate.channel === channel,
        ),
        sourceChannelCount: channels.length,
      });
    }
  });
  return groups;
}

function finiteCc(value: number | undefined): number | null {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= 127
    ? value
    : null;
}

function importedVolume(initial: ImportedMidiInitialChannel | undefined): number {
  const cc = finiteCc(initial?.volumeCc);
  return cc === null ? 1 : (cc / 127) * 2;
}

function importedPan(initial: ImportedMidiInitialChannel | undefined): number {
  const cc = finiteCc(initial?.panCc);
  if (cc === null || cc === 64) return 0;
  return (cc / 127) * 2 - 1;
}

function truncateProjectString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = maxLength;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function appendTrackNameSuffix(base: string, suffix: string): string {
  return `${truncateProjectString(base, MAX_PROJECT_STRING_LENGTH - suffix.length)}${suffix}`;
}

function sourceTrackBaseName(group: MidiNoteGroup, fallback: string): string {
  const source = typeof group.sourceTrack.name === 'string' ? group.sourceTrack.name : '';
  const trimmedSource = source.trim();
  let explicitSource: string | null;
  if (group.sourceTrack.hasExplicitName === true) {
    explicitSource = trimmedSource ? source : null;
  } else if (group.sourceTrack.hasExplicitName === false) {
    explicitSource = null;
  } else {
    // Older typed fixtures do not carry name provenance. Preserve the previous
    // generic-name heuristic and trimming behavior for those callers.
    explicitSource = trimmedSource && !/^Track \d+$/i.test(trimmedSource)
      ? trimmedSource
      : null;
  }
  const base = explicitSource
    ?? `${fallback}${group.sourceTrackIndex > 0 ? ` ${group.sourceTrackIndex + 1}` : ''}`;
  if (group.sourceChannelCount <= 1) return truncateProjectString(base, MAX_PROJECT_STRING_LENGTH);
  const suffix = group.channel === MIDI_DRUM_CHANNEL
    ? ' · Drums'
    : ` · Ch ${group.channel + 1}`;
  return appendTrackNameSuffix(base, suffix);
}

function uniqueTrackName(base: string, used: Set<string>): string {
  const safeBase = truncateProjectString(base, MAX_PROJECT_STRING_LENGTH);
  let candidate = safeBase;
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = ` (${suffix})`;
    candidate = appendTrackNameSuffix(safeBase, suffixText);
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function exactDrumSteps(
  notes: readonly NormalizedNote[],
  musicalTime: MusicalTimeIndex,
  ppq: number,
): Array<{ lane: DrumLane; stepIndex: number; velocity: number }> | null {
  if (!Number.isFinite(ppq) || ppq <= 0) {
    return null;
  }
  const maxBeatError = 0.5 / ppq + Number.EPSILON;
  const events: Array<{ lane: DrumLane; stepIndex: number; velocity: number }> = [];
  const occupied = new Set<string>();
  const drumProjector = compileDrumStepProjector(
    IMPORT_DRUM_STEPS_PER_BAR,
    0,
    musicalTime,
  );
  for (const note of notes) {
    const lane = MIDI_DRUM_LANES[note.pitch];
    if (!lane) return null;
    if (Math.abs(note.durationBeats - IMPORT_DRUM_DURATION_BEATS) > maxBeatError) {
      return null;
    }

    let barPosition: ReturnType<typeof beatToBarPosition>;
    try {
      barPosition = beatToBarPosition(musicalTime, note.startBeat);
    } catch {
      return null;
    }
    const activeBeatsPerBar = beatsPerBarForTimeSignature(barPosition.timeSignature);
    if (!Number.isFinite(activeBeatsPerBar) || activeBeatsPerBar <= 0) return null;
    const beatPerStep = activeBeatsPerBar / IMPORT_DRUM_STEPS_PER_BAR;
    const stepInBar = Math.round(barPosition.beatInBar / beatPerStep);
    const stepIndex = barPosition.bar * IMPORT_DRUM_STEPS_PER_BAR + stepInBar;
    const representedBeat = projectDrumStep(drumProjector, stepIndex).beat;
    if (
      !Number.isSafeInteger(stepIndex) ||
      stepIndex < 0 ||
      !Number.isFinite(representedBeat) ||
      Math.abs(representedBeat - note.startBeat) > maxBeatError
    ) {
      return null;
    }
    const key = `${lane}:${stepIndex}`;
    if (occupied.has(key)) return null;
    occupied.add(key);
    events.push({ lane, stepIndex, velocity: note.velocity });
  }
  return events;
}

function fixedImportMusicalTime(
  timeSignature: Project['timeSignature'],
): MusicalTimeIndex {
  return compileMusicalTime({
    lengthBeats: MAX_PROJECT_TIMELINE_BEATS,
    tempoMap: [{ id: 'midi-import-tempo', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'midi-import-signature',
      beat: 0,
      numerator: timeSignature[0],
      denominator: timeSignature[1],
    }],
  });
}

function metadataWarnings(parsed: ParsedMidiFile, options: MapParsedMidiOptions): string[] {
  const warnings: string[] = [];
  const tempoEvents = parsed.tempoEvents ?? [];
  if (tempoEvents.length > 1 || tempoEvents.some((event) => event.tick > 0)) {
    warnings.push(`MIDIのテンポイベント${tempoEvents.length}件は追加せず、現在の曲のテンポで音符の拍位置を保持しました。`);
  } else if (
    tempoEvents.length === 1 &&
    options.targetBpm !== undefined &&
    Math.abs(tempoEvents[0]!.bpm - options.targetBpm) > 0.01
  ) {
    warnings.push(
      `MIDIは約${Math.round(tempoEvents[0]!.bpm)} BPMですが、現在の曲の${Math.round(options.targetBpm)} BPMを維持しました。`,
    );
  }

  const signatures = parsed.timeSignatures ?? [];
  const initialSignature = [...signatures].reverse().find((event) => event.tick === 0);
  const targetSignature = options.targetTimeSignature;
  if (signatures.some((event) => event.tick > 0) || signatures.length > 1) {
    warnings.push(`MIDIの拍子イベント${signatures.length}件は追加せず、現在の曲の拍子を維持しました。`);
  } else if (
    initialSignature &&
    targetSignature &&
    (initialSignature.numerator !== targetSignature[0] ||
      initialSignature.denominator !== targetSignature[1])
  ) {
    warnings.push(
      `MIDIは${initialSignature.numerator}/${initialSignature.denominator}拍子ですが、現在の曲の${targetSignature[0]}/${targetSignature[1]}拍子を維持しました。`,
    );
  }
  if ((parsed.markers?.length ?? 0) > 0) {
    warnings.push(`MIDIのマーカー${parsed.markers!.length}件は追加していません。コードや構成を正確に戻すにはプロジェクトファイルを使ってください。`);
  }
  const keySignatures = parsed.keySignatures ?? [];
  if (keySignatures.length > 0) {
    const initial = [...keySignatures].reverse().find((event) => event.tick === 0);
    const sourceKey = initial ? midiKeyName(initial.sharpsFlats, initial.minor) : null;
    const targetModeMatches = options.targetScale !== undefined && (
      initial?.minor
        ? ['naturalMinor', 'harmonicMinor', 'melodicMinor', 'minorPentatonic'].includes(
            options.targetScale,
          )
        : ['major', 'majorPentatonic'].includes(options.targetScale)
    );
    const initialMatches = Boolean(
      initial &&
      sourceKey &&
      options.targetKey === sourceKey &&
      targetModeMatches,
    );
    if (keySignatures.length > 1 || keySignatures.some((event) => event.tick > 0)) {
      warnings.push(`MIDIのキーイベント${keySignatures.length}件は追加せず、現在の曲のキーとスケールを維持しました。`);
    } else if (!initialMatches) {
      warnings.push('MIDIのキー指定は追加せず、現在の曲のキーとスケールを維持しました。');
    }
  }
  const automatedTrackCount = parsed.tracks.filter((track) => track.hasChannelAutomation).length;
  if (automatedTrackCount > 0) {
    warnings.push(`MIDI途中の音量・パン・音色変更を含む${automatedTrackCount}トラックは、先頭の設定だけを使いました。`);
  }
  if ((parsed.textEncodingFallbackCount ?? 0) > 0) {
    warnings.push(`MIDI文字情報${parsed.textEncodingFallbackCount}件がUTF-8ではなかったため、互換文字として読み込みました。`);
  }
  const noteIssues = parsed.noteIssues;
  if (noteIssues && (noteIssues.unmatchedNoteOns > 0 || noteIssues.orphanNoteOffs > 0)) {
    warnings.push(
      `対応が完結していないMIDIノートイベント（Note On ${noteIssues.unmatchedNoteOns}件、Note Off ${noteIssues.orphanNoteOffs}件）は追加しませんでした。`,
    );
  }
  return warnings;
}

function midiKeyName(sharpsFlats: number, minor: boolean): Project['key'] | null {
  const major = new Map<number, Project['key']>([
    [-6, 'Gb'], [-5, 'Db'], [-4, 'Ab'], [-3, 'Eb'], [-2, 'Bb'], [-1, 'F'],
    [0, 'C'], [1, 'G'], [2, 'D'], [3, 'A'], [4, 'E'], [5, 'B'], [6, 'F#'], [7, 'C#'],
  ]);
  const minorKeys = new Map<number, Project['key']>([
    [-7, 'Ab'], [-6, 'Eb'], [-5, 'Bb'], [-4, 'F'], [-3, 'C'], [-2, 'G'], [-1, 'D'],
    [0, 'A'], [1, 'E'], [2, 'B'], [3, 'F#'], [4, 'C#'], [5, 'G#'], [6, 'D#'], [7, 'A#'],
  ]);
  return (minor ? minorKeys : major).get(sharpsFlats) ?? null;
}

export function midiTrackName(fileName: string): string {
  const trimmed = fileName.trim();
  const stem = trimmed.replace(/\.(mid|midi)$/i, '').trim();
  return `MIDI: ${stem || '読み込みトラック'}`;
}

export function mapParsedMidiToTracks(
  parsed: ParsedMidiFile,
  options: MapParsedMidiOptions,
): MidiImportMapping {
  const inspected = inspectParsedNotes(parsed);
  if (!inspected.ok) return inspected;
  const groups = groupParsedMidi(parsed);
  if (groups.length === 0) {
    return {
      ok: false,
      message: 'このMIDIには読み込めるノートがありません。別の.midファイルを選んでください。',
    };
  }
  const maxTracks = Math.max(0, Math.min(MAX_PROJECT_TRACKS, options.maxTracks ?? MAX_PROJECT_TRACKS));
  if (groups.length > maxTracks) {
    return {
      ok: false,
      message: `このMIDIには追加できる上限を超えるトラックがあります（追加可能${maxTracks}トラック）。`,
    };
  }
  if (groups.some((group) => group.notes.length > MAX_EVENTS_PER_CLIP)) {
    return {
      ok: false,
      message: `MIDIの1トラックあたりのノート数が多すぎます（上限${MAX_EVENTS_PER_CLIP.toLocaleString('ja-JP')}音）。`,
    };
  }

  const fallbackName = options.trackName ?? 'MIDI: 読み込みトラック';
  const usedNames = new Set(options.reservedTrackNames ?? []);
  const timeSignature = options.targetTimeSignature ?? [4, 4];
  const targetMusicalTime = options.targetMusicalTime
    ?? fixedImportMusicalTime(timeSignature);
  const tracks: Track[] = [];
  const clips: Clip[] = [];
  const warnings = metadataWarnings(parsed, options);
  if (inspected.zeroDurationCount > 0) {
    warnings.push(`長さ0の音符${inspected.zeroDurationCount}件は再生できないため追加しませんでした。`);
  }
  let drumFallbackCount = 0;
  let unsupportedProgramCount = 0;
  let pianoRollHiddenCount = 0;

  groups.forEach((group, groupIndex) => {
    const trackId = options.makeId('track');
    const clipId = options.makeId('clip');
    const name = uniqueTrackName(sourceTrackBaseName(group, fallbackName), usedNames);
    const lengthBeats = importedLengthBeats(group.notes);
    const volume = importedVolume(group.initialChannel);
    const pan = importedPan(group.initialChannel);
    const color = options.color ?? IMPORT_TRACK_COLORS[groupIndex % IMPORT_TRACK_COLORS.length];
    const drumSteps = group.channel === MIDI_DRUM_CHANNEL
      ? exactDrumSteps(group.notes, targetMusicalTime, parsed.ppq)
      : null;

    if (
      group.initialChannel?.program !== undefined ||
      group.initialChannel?.bankMsb !== undefined ||
      group.initialChannel?.bankLsb !== undefined
    ) {
      unsupportedProgramCount += 1;
    }

    if (drumSteps) {
      const clip: Clip = {
        id: clipId,
        trackId,
        type: 'drum',
        startBeat: 0,
        lengthBeats,
        loop: false,
        stepsPerBar: IMPORT_DRUM_STEPS_PER_BAR,
        drumEvents: drumSteps.map((event) => ({
          id: options.makeId('drum'),
          ...event,
        })),
      };
      tracks.push({
        id: trackId,
        name,
        type: 'drum',
        role: 'general',
        color,
        clips: [clip],
        volume,
        pan,
        mute: false,
        solo: false,
        instrument: { type: 'drumkit', preset: IMPORT_DRUM_PRESET },
        effects: [],
      });
      clips.push(clip);
      return;
    }

    if (group.channel === MIDI_DRUM_CHANNEL) drumFallbackCount += 1;
    pianoRollHiddenCount += group.notes.filter((note) => note.pitch < 36 || note.pitch > 84).length;
    const clip: Clip = {
      id: clipId,
      trackId,
      type: 'midi',
      startBeat: 0,
      lengthBeats,
      loop: false,
      notes: group.notes.map((note) => noteEvent(note, options.makeId('note'))),
    };
    tracks.push({
      id: trackId,
      name,
      type: 'instrument',
      role: 'general',
      color,
      clips: [clip],
      volume,
      pan,
      mute: false,
      solo: false,
      instrument: { type: 'synth', preset: options.preset ?? IMPORT_TRACK_PRESET },
      effects: [],
    });
    clips.push(clip);
  });

  if (unsupportedProgramCount > 0) {
    warnings.push(`MIDIの音色・バンク指定を含む${unsupportedProgramCount}トラックは、読み込み用の基本音色を使いました。`);
  }
  if (drumFallbackCount > 0) {
    warnings.push(`Channel 10の${drumFallbackCount}トラックは6レーンのドラムグリッドで正確に表せないため、音程を保つMIDIトラックとして追加しました。`);
  }
  if (pianoRollHiddenCount > 0) {
    warnings.push(`編集表示範囲（C2〜C6）外の音符${pianoRollHiddenCount}件も保持しました。再書き出しには含まれます。`);
  }

  const lengthBeats = Math.max(...clips.map((clip) => clip.lengthBeats));
  const track = tracks[0]!;
  const clip = clips[0]!;

  return {
    ok: true,
    tracks,
    clips,
    track,
    clip,
    noteCount: groups.reduce((count, group) => count + group.notes.length, 0),
    lengthBeats,
    sourceTrackCount: parsed.tracks.length,
    importedTrackCount: tracks.length,
    warnings,
  };
}

/** @deprecated Use the plural mapper; retained for source-compatible imports/tests. */
export const mapParsedMidiToTrack = mapParsedMidiToTracks;

function insertBeforeMaster(tracks: readonly Track[], importedTracks: readonly Track[]): Track[] {
  const masterIndex = tracks.findIndex((track) => track.type === 'master');
  if (masterIndex < 0) return [...tracks, ...importedTracks];
  return [
    ...tracks.slice(0, masterIndex),
    ...importedTracks,
    ...tracks.slice(masterIndex),
  ];
}

export function appendImportedMidiTracks(project: Project, importedTracks: readonly Track[]): Project {
  if (importedTracks.length === 0) return project;
  const longestClipEnd = importedTracks.reduce(
    (trackMax, track) => Math.max(
      trackMax,
      track.clips.reduce(
        (clipMax, clip) => Math.max(clipMax, clip.startBeat + clip.lengthBeats),
        0,
      ),
    ),
    0,
  );
  const musicalTime = compileMusicalTime(project);
  const endPosition = beatToBarPosition(musicalTime, longestClipEnd);
  const requiredBars = Math.max(
    1,
    endPosition.bar + (endPosition.beatInBar > 1e-9 ? 1 : 0),
  );
  const requiredLengthBeats = barToBeatAt(musicalTime, requiredBars);
  return {
    ...project,
    lengthBars: Math.max(project.lengthBars, requiredBars),
    lengthBeats: Math.max(project.lengthBeats, requiredLengthBeats),
    tracks: insertBeforeMaster(project.tracks, importedTracks),
  };
}

export function appendImportedMidiTrack(project: Project, importedTrack: Track): Project {
  return appendImportedMidiTracks(project, [importedTrack]);
}

function captureImportStart(
  getStore: MidiImportStoreProvider,
): MidiImportStart | MidiImportResult {
  const started = getStore();
  if (started.projectOperationBusy) {
    return {
      ok: false,
      message: 'プロジェクトの処理中です。完了してからMIDIをもう一度選んでください。',
    };
  }
  return {
    projectId: started.project.id,
    activationId: started.saveState.activationId,
  };
}

function importMidiData(
  fileName: string,
  bytes: Uint8Array,
  start: MidiImportStart,
  getStore: MidiImportStoreProvider,
): MidiImportResult {
  if (bytes.byteLength === 0) {
    return { ok: false, message: 'ファイルが空です。.midファイルを選んでください。' };
  }
  if (bytes.byteLength > MAX_MIDI_IMPORT_BYTES) {
    return { ok: false, message: 'MIDIファイルが大きすぎます（上限8MB）。' };
  }

  let parsed: ParsedMidiFile;
  try {
    parsed = parseMidiFile(bytes);
  } catch (error) {
    if (error instanceof MidiImportError && error.code !== 'invalid-midi') {
      return {
        ok: false,
        message:
          error.code === 'input-too-large'
            ? 'MIDIファイルが大きすぎます（上限8MB）。'
            : 'MIDIのデータ量や同時発音数が多すぎます。内容を減らしてからもう一度お試しください。',
      };
    }
    return {
      ok: false,
      message: 'MIDIファイルを読み込めませんでした。壊れているか、対応していない形式かもしれません。',
    };
  }

  const store = getStore();
  if (
    store.projectOperationBusy ||
    store.project.id !== start.projectId ||
    store.saveState.activationId !== start.activationId
  ) {
    return {
      ok: false,
      message: 'MIDIの読み込み中にプロジェクトが切り替わったため、追加を中止しました。',
    };
  }
  const mapped = mapParsedMidiToTracks(parsed, {
    makeId: uid,
    trackName: midiTrackName(fileName),
    reservedTrackNames: store.project.tracks.map((track) => track.name),
    targetBpm: store.project.bpm,
    targetTimeSignature: store.project.timeSignature,
    targetMusicalTime: compileMusicalTime(store.project),
    targetKey: store.project.key,
    targetScale: store.project.scale,
    maxTracks: Math.max(0, MAX_PROJECT_TRACKS - store.project.tracks.length),
  });
  if (!mapped.ok) return mapped;

  const nextProject = appendImportedMidiTracks(store.project, mapped.tracks);
  if (!store.applyProjectChange(() => nextProject)) {
    return {
      ok: false,
      message: 'MIDIトラックを安全に保存できなかったため、読み込みを反映しませんでした。もう一度お試しください。',
    };
  }
  const firstTrack = mapped.tracks[0]!;
  const firstClip = mapped.clips[0]!;
  store.selectTrack(firstTrack.id);
  store.selectClip(firstClip.id);
  store.selectNotes([]);
  store.setActiveView(firstTrack.type === 'drum' ? 'drums' : 'pianoRoll');

  return {
    ok: true,
    trackId: firstTrack.id,
    clipId: firstClip.id,
    trackName: firstTrack.name,
    trackIds: mapped.tracks.map((track) => track.id),
    clipIds: mapped.clips.map((clip) => clip.id),
    trackCount: mapped.importedTrackCount,
    noteCount: mapped.noteCount,
    warnings: mapped.warnings,
  };
}

/** Imports already-read bytes, used by the native file gateway without a DOM File. */
export async function importMidiBytes(
  fileName: string,
  bytes: Uint8Array,
  getStore: MidiImportStoreProvider = () => useStore.getState(),
): Promise<MidiImportResult> {
  const start = captureImportStart(getStore);
  if ('ok' in start) return start;
  return importMidiData(fileName, bytes, start, getStore);
}

export async function importMidiFile(
  file: File,
  getStore: MidiImportStoreProvider = () => useStore.getState(),
): Promise<MidiImportResult> {
  if (file.size === 0) {
    return { ok: false, message: 'ファイルが空です。.midファイルを選んでください。' };
  }
  if (file.size > MAX_MIDI_IMPORT_BYTES) {
    return { ok: false, message: 'MIDIファイルが大きすぎます（上限8MB）。' };
  }
  const start = captureImportStart(getStore);
  if ('ok' in start) return start;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return importMidiData(file.name, bytes, start, getStore);
}
