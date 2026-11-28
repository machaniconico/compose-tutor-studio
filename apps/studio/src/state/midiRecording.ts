import {
  beatsPerBar,
  beatToSecondsAt,
  collectProjectEntityIds,
  compileMusicalTime,
  MAX_EVENTS_PER_CLIP,
  MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
  PPQ,
  preflightScheduleEventBudget,
  secondsToBeatAt,
  timeSignatureAtBeat,
  validateProject,
  type MusicalTimeIndex,
  type NoteEvent,
  type Project,
} from '@cts/project-model';
import { exactTicks, roundedNoteTickSpan, tickSpansOverlap, withOwnerNotes } from './noteEditActions';

export type MidiRecordingOptions = Readonly<{
  clipId: string;
  mode: 'overdub' | 'replace';
  countInBars: 0 | 1;
  autoQuantize: number | null;
  loop: Readonly<{ startBeat: number; endBeat: number }> | null;
  startBeat: number;
}>;

export type MidiRecordingEvent = Readonly<{
  type: 'on' | 'off';
  pitch: number;
  velocity: number;
  timeSec: number;
}>;

export type DropReason = 'pitch-out-of-range' | 'zero-length' | 'outside-clip' | 'same-pitch-overlap' | 'invalid';
type Drops = Partial<Record<DropReason, number>>;

export type MidiRecordingStopped = Readonly<{
  ok: true;
  project: Project;
  changed: boolean;
  droppedCount: number;
  droppedByReason: Drops;
  recordedNoteIds: readonly string[];
  rangeStartTick: number;
  rangeEndTick: number;
}>;

const refusalMessages = {
  'clip-not-found': '録音するクリップが見つかりません。',
  'clip-not-midi': '楽器のクリップを選んでください。',
  'clip-is-link': 'リンク先には録音できません。元のクリップを選んでください。',
  'clip-start-off-tick': 'クリップの開始位置を目盛りに合わせてください。',
  'invalid-options': '録音の設定や位置を確認してください。',
  'loop-not-integer-tick': 'ループの両端を目盛りに合わせてください。',
  'loop-shorter-than-one-beat': 'ループの長さを１拍以上にしてください。',
  'start-outside-loop': '録音の開始位置をループの内側に置いてください。',
  'audio-recording-active': '音声の録音を止めてから、MIDI 録音を始めてください。',
  'midi-recording-active': 'MIDI 録音はすでに始まっています。',
  'project-busy': '曲の処理が終わってから、もう一度試してください。',
  'project-too-large': '録音を反映するとプロジェクトの保存上限を超えます。',
  'project-invalid': '現在のプロジェクトの内容を検証できないため、録音を反映できません。',
  'project-serialization-failed': '録音を反映したプロジェクトを保存形式に変換できません。',
};

export const DISCARD_MIDI_TAKE_LABEL = 'このテイクを捨てて録音を終える';

export type MidiRecordingRefusal = Readonly<{
  ok: false;
  code: keyof typeof refusalMessages;
  message: string;
}>;

export function refuseMidiRecording(code: MidiRecordingRefusal['code']): MidiRecordingRefusal {
  return { ok: false, code, message: refusalMessages[code] };
}

export type MidiRecordingStarted = Readonly<{ ok: true; session: MidiRecordingSession }>;

type HeldNote = Readonly<{ pitch: number; velocity: number; startTick: number; order: number }>;
type CapturedNote = HeldNote & Readonly<{ endTick: number }>;
type CaptureList = Readonly<{ note: CapturedNote; previous: CaptureList | null }>;
type LoopTiming = Readonly<{
  startTick: number;
  endTick: number;
  startSeconds: number;
  firstWrapSec: number;
  passDuration: number;
}>;

export type MidiRecordingSession = Readonly<{
  clipId: string;
  mode: MidiRecordingOptions['mode'];
  autoQuantize: number | null;
  musicalTime: MusicalTimeIndex;
  originBeat: number;
  originSeconds: number;
  startTick: number;
  startSeconds: number;
  countInSeconds: number;
  loop: LoopTiming | null;
  pass: number;
  lastTimeSec: number;
  held: ReadonlyMap<number, HeldNote>;
  captured: CaptureList | null;
  ignoredReleases: ReadonlyMap<number, number>;
  nextOrder: number;
  drops: Readonly<Drops>;
}>;

function hasOwnFields(value: unknown, fields: readonly string[]): boolean {
  return typeof value === 'object' && value !== null
    && fields.every((field) => Object.hasOwn(value, field));
}

function findClip(project: Project, clipId: string) {
  return project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);
}

function secondsForBeatRange(index: MusicalTimeIndex, startBeat: number, endBeat: number): number {
  // Integrate just this interval to avoid subtracting rounded absolute times
  // at a loop boundary. The first tempo also covers negative count-in beats.
  return index.tempoSegments.reduce((seconds, segment, i) => {
    const start = i === 0 ? startBeat : Math.max(startBeat, segment.startBeat);
    const end = Math.min(endBeat, segment.endBeat);
    return seconds + Math.max(0, end - start) * (60 / segment.bpm);
  }, 0);
}

export function startMidiRecording(
  project: Project,
  opts: MidiRecordingOptions,
): MidiRecordingStarted | MidiRecordingRefusal {
  try {
    if (!hasOwnFields(opts, ['clipId', 'mode', 'countInBars', 'autoQuantize', 'loop', 'startBeat'])) {
      return refuseMidiRecording('invalid-options');
    }
    const { clipId, mode, countInBars, autoQuantize, loop, startBeat } = opts;
    const startTick = exactTicks(startBeat);
    if (
      typeof clipId !== 'string' || (mode !== 'overdub' && mode !== 'replace')
      || (countInBars !== 0 && countInBars !== 1)
      || (autoQuantize !== null && (!Number.isSafeInteger(autoQuantize) || autoQuantize <= 0))
      || startTick === null
    ) return refuseMidiRecording('invalid-options');

    const clip = findClip(project, clipId);
    if (!clip) return refuseMidiRecording('clip-not-found');
    if (clip.type !== 'midi') return refuseMidiRecording('clip-not-midi');
    if (Object.hasOwn(clip, 'aliasOf') && clip.aliasOf !== undefined) return refuseMidiRecording('clip-is-link');
    if (exactTicks(clip.startBeat) === null) return refuseMidiRecording('clip-start-off-tick');

    const musicalTime = compileMusicalTime(project);
    const startSeconds = beatToSecondsAt(musicalTime, startBeat);
    const originBeat = countInBars === 0
      ? startBeat
      : startBeat - beatsPerBar(timeSignatureAtBeat(musicalTime, startBeat));
    const originSeconds = beatToSecondsAt(musicalTime, originBeat);
    const countInSeconds = secondsForBeatRange(musicalTime, originBeat, startBeat);
    let loopTiming: LoopTiming | null = null;
    if (loop !== null) {
      if (!hasOwnFields(loop, ['startBeat', 'endBeat'])) return refuseMidiRecording('loop-not-integer-tick');
      const loopStartTick = exactTicks(loop.startBeat);
      const loopEndTick = exactTicks(loop.endBeat);
      if (loopStartTick === null || loopEndTick === null) return refuseMidiRecording('loop-not-integer-tick');
      if (loopEndTick - loopStartTick < PPQ) return refuseMidiRecording('loop-shorter-than-one-beat');
      if (startTick < loopStartTick || startTick >= loopEndTick) return refuseMidiRecording('start-outside-loop');
      const loopStartSeconds = beatToSecondsAt(musicalTime, loop.startBeat);
      loopTiming = {
        startTick: loopStartTick,
        endTick: loopEndTick,
        startSeconds: loopStartSeconds,
        firstWrapSec: secondsForBeatRange(musicalTime, originBeat, loop.endBeat),
        passDuration: secondsForBeatRange(musicalTime, loop.startBeat, loop.endBeat),
      };
      if (!(loopTiming.passDuration > 0) || !Number.isFinite(loopTiming.firstWrapSec)) {
        return refuseMidiRecording('invalid-options');
      }
    }
    if (!Number.isFinite(countInSeconds) || countInSeconds < 0) return refuseMidiRecording('invalid-options');
    return {
      ok: true,
      session: {
        clipId, mode, autoQuantize, musicalTime, originBeat, originSeconds, startTick, startSeconds, countInSeconds,
        loop: loopTiming, pass: 0, lastTimeSec: 0,
        held: new Map(), captured: null, ignoredReleases: new Map(), nextOrder: 0, drops: {},
      },
    };
  } catch {
    return refuseMidiRecording('invalid-options');
  }
}

function positionAt(session: MidiRecordingSession, timeSec: number) {
  const { loop } = session;
  let seconds = session.startSeconds + (timeSec - session.countInSeconds);
  let tickOffset = 0;
  if (loop !== null) {
    const elapsedAfterFirstPass = timeSec - loop.firstWrapSec;
    // Locate the tempo-map interval to invert. The rounded unfolded tick
    // below decides which pass owns the event.
    const completeLoops = Math.floor(elapsedAfterFirstPass / loop.passDuration);
    if (completeLoops >= 0) {
      seconds = loop.startSeconds + (elapsedAfterFirstPass - completeLoops * loop.passDuration);
      tickOffset = (completeLoops + 1) * (loop.endTick - loop.startTick);
    }
  }
  const unfoldedTick = Math.round(secondsToBeatAt(session.musicalTime, seconds) * PPQ) + tickOffset;
  if (!Number.isSafeInteger(unfoldedTick)) throw new RangeError('Invalid take position');
  if (loop === null || unfoldedTick < loop.endTick) return { pass: 0, tick: unfoldedTick };
  const ticksAfterFirstPass = unfoldedTick - loop.endTick;
  const loopTicks = loop.endTick - loop.startTick;
  return {
    pass: 1 + Math.floor(ticksAfterFirstPass / loopTicks),
    tick: loop.startTick + ticksAfterFirstPass % loopTicks,
  };
}

function closeHeldNotes(
  held: ReadonlyMap<number, HeldNote>,
  captured: CaptureList | null,
  endTick: number,
): CaptureList | null {
  let result = captured;
  for (const note of held.values()) result = { note: { ...note, endTick }, previous: result };
  return result;
}

function consumeRelease(ignored: Map<number, number>, pitch: number): boolean {
  const count = ignored.get(pitch);
  if (count === undefined) return false;
  if (count === 1) ignored.delete(pitch);
  else ignored.set(pitch, count - 1);
  return true;
}

function countDrop(drops: Drops, reason: DropReason): void {
  drops[reason] = (drops[reason] ?? 0) + 1;
}

function validateRecordedNotes(
  project: Project,
  clipId: string,
  original: NoteEvent[],
  kept: NoteEvent[],
  recorded: NoteEvent[],
  drops: Drops,
): { project: Project; recorded: NoteEvent[]; changed: boolean } | null {
  while (true) {
    const changed = recorded.length > 0 || kept.length !== original.length;
    const candidate = changed ? withOwnerNotes(project, clipId, [...kept, ...recorded]) : project;
    const validation = validateProject(candidate);
    if (validation.ok) return { project: candidate, recorded, changed };

    const trackIndex = project.tracks.findIndex((track) => track.clips.some((clip) => clip.id === clipId));
    const clipIndex = project.tracks[trackIndex]?.clips.findIndex((clip) => clip.id === clipId);
    const notesPath = `tracks[${trackIndex}].clips[${clipIndex}].notes`;
    const invalid = new Set<number>();
    for (const { path } of validation.errors) {
      if (!path.startsWith(`${notesPath}[`)) continue;
      const match = /^\[(\d+)\]/.exec(path.slice(notesPath.length));
      if (match) invalid.add(Number(match[1]) - kept.length);
    }
    let remaining = recorded.filter((_, index) => !invalid.has(index));
    if (validation.errors.some(({ path }) => path === notesPath)) {
      remaining = remaining.slice(0, Math.max(0, MAX_EVENTS_PER_CLIP - kept.length));
    }
    if (remaining.length === recorded.length && validation.errors.some(({ path }) => path === 'tracks')) {
      const budget = preflightScheduleEventBudget(withOwnerNotes(project, clipId, kept), {
        limit: MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS,
        projection: 'resolved-stored',
      });
      if (budget.ok) {
        // Every new note occupies one event in the source and each linked placement.
        const placements = project.tracks[trackIndex]!.clips.filter(
          (clip) => clip.id === clipId || clip.aliasOf === clipId,
        ).length;
        remaining = remaining.slice(0, Math.floor((budget.limit - budget.eventCount) / placements));
      }
    }
    // Keep the take available for retry if the project itself has a problem.
    if (remaining.length === recorded.length) return null;
    drops.invalid = (drops.invalid ?? 0) + recorded.length - remaining.length;
    recorded = remaining;
  }
}

export function feedMidiRecordingEvent(
  session: MidiRecordingSession,
  event: MidiRecordingEvent,
): MidiRecordingSession {
  try {
    if (!hasOwnFields(event, ['type', 'pitch', 'velocity', 'timeSec'])) return { ...session };
    const { type, pitch, velocity, timeSec } = event;
    if (
      (type !== 'on' && type !== 'off')
      || !Number.isFinite(timeSec) || timeSec < session.lastTimeSec
    ) return { ...session };
    const next = { ...session, lastTimeSec: timeSec };
    const validPitch = Number.isInteger(pitch) && pitch >= 0 && pitch <= 127;
    const ignoredReleases = new Map(session.ignoredReleases);
    if (timeSec < session.countInSeconds) {
      if (validPitch && type === 'on') ignoredReleases.set(pitch, (ignoredReleases.get(pitch) ?? 0) + 1);
      if (type === 'off') consumeRelease(ignoredReleases, pitch);
      return { ...next, ignoredReleases };
    }

    const { pass, tick } = positionAt(session, timeSec);
    const held = new Map(session.held);
    let captured = session.captured;
    const drops = { ...session.drops };
    if (pass > session.pass && session.loop !== null) {
      captured = closeHeldNotes(held, captured, session.loop.endTick);
      for (const pitch of held.keys()) ignoredReleases.set(pitch, (ignoredReleases.get(pitch) ?? 0) + 1);
      held.clear();
    }

    if (type === 'on') {
      if (!validPitch) countDrop(drops, 'pitch-out-of-range');
      else if (held.has(pitch)) countDrop(drops, 'same-pitch-overlap');
      else if (typeof velocity === 'number' && !Number.isNaN(velocity)) {
        const clamped = Math.min(127, Math.max(1, Math.round(velocity)));
        held.set(pitch, { pitch, velocity: clamped, startTick: tick, order: next.nextOrder });
        next.nextOrder += 1;
      }
    } else if (!consumeRelease(ignoredReleases, pitch)) {
      const note = held.get(pitch);
      if (note) {
        captured = { note: { ...note, endTick: tick }, previous: captured };
        held.delete(pitch);
      }
    }
    return { ...next, pass, held, captured, ignoredReleases, drops };
  } catch {
    return session;
  }
}

export function stopMidiRecording(
  project: Project,
  session: MidiRecordingSession,
  stop: Readonly<{ timeSec: number }>,
): MidiRecordingStopped | MidiRecordingRefusal {
  try {
    if (!hasOwnFields(stop, ['timeSec']) || !Number.isFinite(stop.timeSec) || stop.timeSec < session.lastTimeSec) {
      return refuseMidiRecording('invalid-options');
    }
    const clip = findClip(project, session.clipId);
    if (!clip) return refuseMidiRecording('clip-not-found');
    if (clip.type !== 'midi') return refuseMidiRecording('clip-not-midi');
    if (Object.hasOwn(clip, 'aliasOf') && clip.aliasOf !== undefined) return refuseMidiRecording('clip-is-link');
    const clipStart = exactTicks(clip.startBeat);
    if (clipStart === null) return refuseMidiRecording('clip-start-off-tick');

    const { pass, tick } = positionAt(session, Math.max(stop.timeSec, session.countInSeconds));
    const loop = pass > 0 ? session.loop : null;
    const rangeStartTick = loop?.startTick ?? session.startTick;
    const rangeEndTick = loop?.endTick ?? tick;
    const heldEnd = pass > session.pass && loop !== null ? loop.endTick : tick;
    const captured: CapturedNote[] = [];
    for (let entry = closeHeldNotes(session.held, session.captured, heldEnd); entry !== null; entry = entry.previous) {
      captured.push(entry.note);
    }
    const original = clip.notes ?? [];
    const kept = session.mode === 'overdub' ? original : original.filter((note) => {
      const start = clipStart + Math.round(note.startBeat * PPQ);
      return start < rangeStartTick || start >= rangeEndTick;
    });
    const spansByPitch = new Map<number, Array<readonly [number, number]>>();
    const addSpan = (pitch: number, span: readonly [number, number]) => {
      const spans = spansByPitch.get(pitch);
      if (spans) spans.push(span);
      else spansByPitch.set(pitch, [span]);
    };
    for (const note of kept) {
      addSpan(note.pitch, roundedNoteTickSpan(clip.startBeat + note.startBeat, note.durationBeats));
    }
    const droppedByReason = { ...session.drops };
    const accepted: Array<Omit<NoteEvent, 'id'>> = [];
    for (const note of captured.sort((a, b) => a.order - b.order)) {
      const grid = session.autoQuantize;
      const start = grid === null ? note.startTick : Math.round(note.startTick / grid) * grid;
      const startBeat = (start - clipStart) / PPQ;
      const remainingBeats = clip.lengthBeats - startBeat;
      let durationBeats = Math.min((note.endTick - note.startTick) / PPQ, remainingBeats);
      // Subtract before adding back to the start, allowing for rounding at clip end.
      if (startBeat + durationBeats > clip.lengthBeats) {
        durationBeats -= Number.EPSILON * clip.lengthBeats;
      }
      const span = [start, start + Math.round(durationBeats * PPQ)] as const;
      if (startBeat < 0 || remainingBeats <= 0) countDrop(droppedByReason, 'outside-clip');
      else if (durationBeats <= 0) countDrop(droppedByReason, 'zero-length');
      else if (spansByPitch.get(note.pitch)?.some((other) => tickSpansOverlap(span, other))) {
        countDrop(droppedByReason, 'same-pitch-overlap');
      } else {
        accepted.push({ pitch: note.pitch, velocity: note.velocity, startBeat, durationBeats });
        addSpan(note.pitch, span);
      }
    }
    const ids = collectProjectEntityIds(project);
    let nextId = 1;
    const recorded = accepted.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch).map((note): NoteEvent => {
      let id = `midi-recording-${nextId++}`;
      while (ids.has(id)) id = `midi-recording-${nextId++}`;
      return { id, ...note };
    });
    const validated = validateRecordedNotes(project, clip.id, original, kept, recorded, droppedByReason);
    if (!validated) return refuseMidiRecording('project-invalid');
    return {
      ok: true,
      project: validated.project,
      changed: validated.changed,
      droppedCount: Object.values(droppedByReason).reduce((total, count) => total + count, 0),
      droppedByReason,
      recordedNoteIds: validated.recorded.map((note) => note.id),
      rangeStartTick,
      rangeEndTick,
    };
  } catch {
    return refuseMidiRecording('invalid-options');
  }
}
