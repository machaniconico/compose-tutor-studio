// Immutable mutation helpers. Each returns a new Project (no in-place mutation)
// and bumps updatedAt via the injectable clock.

import type { Clock } from './clock';
import { systemClock, nowIso } from './clock';
import { drumHitRepeatCount, expandClip, resolveLinkSource } from './clipExpand';
import { createDrumClip, createMidiClip, createTrack } from './factories';
import { makeId } from './ids';
import { PPQ, beatTick, beatsPerBar, clipTickSpan, drumStepsPerBar, tickSpansOverlap } from './time';
import { clipEditSpan, MAX_SONG_BARS, MIN_LOOP_PERIOD_BEATS, songEndBeat, soundingEvents } from './sounding';
import type {
  ChordEvent,
  Clip,
  DrumEvent,
  DrumLane,
  NoteEvent,
  Project,
  Section,
  Track,
  TrackRole,
} from './types';

/** Stamp updatedAt on a (shallow-copied) project. */
function touch(project: Project, clock: Clock): Project {
  return { ...project, updatedAt: nowIso(clock) };
}

/** Map over tracks, replacing the one whose id matches. */
function mapTrack(project: Project, trackId: string, fn: (track: Track) => Track): Track[] {
  return project.tracks.map((track) => (track.id === trackId ? fn(track) : track));
}

/** Map over a clip wherever it lives, returning new track list. */
function mapClip(project: Project, clipId: string, fn: (clip: Clip) => Clip): Track[] {
  return project.tracks.map((track) => {
    if (!track.clips.some((c) => c.id === clipId)) return track;
    return { ...track, clips: track.clips.map((c) => (c.id === clipId ? fn(c) : c)) };
  });
}

// --- Chord track ---

export function addChordEvent(
  project: Project,
  chord: Omit<ChordEvent, 'id'> & { id?: string },
  clock: Clock = systemClock,
): Project {
  const event: ChordEvent = { ...chord, id: chord.id ?? makeId('chord') };
  return touch({ ...project, chordTrack: [...project.chordTrack, event] }, clock);
}

export function updateChordEvent(
  project: Project,
  chordId: string,
  patch: Partial<Omit<ChordEvent, 'id'>>,
  clock: Clock = systemClock,
): Project {
  const chordTrack = project.chordTrack.map((c) => (c.id === chordId ? { ...c, ...patch } : c));
  return touch({ ...project, chordTrack }, clock);
}

export function removeChordEvent(
  project: Project,
  chordId: string,
  clock: Clock = systemClock,
): Project {
  const chordTrack = project.chordTrack.filter((c) => c.id !== chordId);
  return touch({ ...project, chordTrack }, clock);
}

// --- Notes within a clip ---

export function addNoteToClip(
  project: Project,
  clipId: string,
  note: Omit<NoteEvent, 'id'> & { id?: string },
  clock: Clock = systemClock,
): Project {
  const event: NoteEvent = { ...note, id: note.id ?? makeId('note') };
  const tracks = mapClip(project, clipId, (clip) => ({
    ...clip,
    notes: [...(clip.notes ?? []), event],
  }));
  return touch({ ...project, tracks }, clock);
}

export function updateNote(
  project: Project,
  clipId: string,
  noteId: string,
  patch: Partial<Omit<NoteEvent, 'id'>>,
  clock: Clock = systemClock,
): Project {
  const tracks = mapClip(project, clipId, (clip) => ({
    ...clip,
    notes: (clip.notes ?? []).map((n) => (n.id === noteId ? { ...n, ...patch } : n)),
  }));
  return touch({ ...project, tracks }, clock);
}

export function removeNote(
  project: Project,
  clipId: string,
  noteId: string,
  clock: Clock = systemClock,
): Project {
  const tracks = mapClip(project, clipId, (clip) => ({
    ...clip,
    notes: (clip.notes ?? []).filter((n) => n.id !== noteId),
  }));
  return touch({ ...project, tracks }, clock);
}

// --- Drum steps ---

/**
 * Toggle a drum step at (lane, stepIndex) for a drum clip.
 * If a matching event exists it is removed; otherwise one is added with the
 * provided velocity (default 100).
 */
export function toggleDrumStep(
  project: Project,
  clipId: string,
  lane: DrumLane,
  stepIndex: number,
  velocity = 100,
  clock: Clock = systemClock,
): Project {
  const tracks = mapClip(project, clipId, (clip) => {
    const events = clip.drumEvents ?? [];
    const existing = events.find((e) => e.lane === lane && e.stepIndex === stepIndex);
    if (existing) {
      return { ...clip, drumEvents: events.filter((e) => e !== existing) };
    }
    const event: DrumEvent = { id: makeId('drum'), lane, stepIndex, velocity };
    return { ...clip, drumEvents: [...events, event] };
  });
  return touch({ ...project, tracks }, clock);
}

// --- Clips ---
//
// A clip's note `startBeat` and drum `stepIndex` are relative to the clip's own
// `startBeat`. A clip with `aliasOf` holds no content: it plays (and is edited
// through) the clip its link chain ends at, see resolveEditTarget.

const CLIP_EPSILON = 1e-9;

function locateClip(project: Project, clipId: string): { track: Track; clip: Clip } | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

/**
 * The clip whose notes / drum hits an edit of `clipId` should change: the clip
 * itself, or for a linked clip the clip its `aliasOf` chain ends at. Undefined
 * when the clip does not exist or its link is broken or circular.
 */
export function resolveEditTarget(project: Project, clipId: string): Clip | undefined {
  const all = project.tracks.flatMap((t) => t.clips);
  const clip = all.find((c) => c.id === clipId);
  if (!clip) return undefined;
  const source = resolveLinkSource(clip, all);
  return typeof source === 'string' ? undefined : source;
}

/**
 * Latest beat a clip may end at for move / duplicate / resize / split: the
 * longest song (4 * MAX_SONG_BARS bars, the legacyBarLimit ceiling) of the
 * longest bars (510 beats: a MIDI numerator is at most 255, the smallest
 * denominator 2). Keeps every clip edge a safe-integer tick.
 */
export const MAX_CLIP_END_BEATS = 4 * MAX_SONG_BARS * 510;

/**
 * Whether a clip is inside the domain clip operations work on: at least
 * MIN_LOOP_PERIOD_BEATS long (so never empty in ticks) and ending by
 * MAX_CLIP_END_BEATS. Saved files may hold other clips; the operations leave
 * a track with any of them unchanged.
 */
function inClipDomain(clip: Pick<Clip, 'startBeat' | 'lengthBeats'>): boolean {
  return clip.startBeat >= 0 && clip.lengthBeats >= MIN_LOOP_PERIOD_BEATS &&
    clip.startBeat + clip.lengthBeats <= MAX_CLIP_END_BEATS;
}

const trackInClipDomain = (track: Track) => track.clips.every(inClipDomain);

/**
 * The start closest to `requested` (never before 0) where a clip of `length`
 * beats overlaps none of `others` under validateProject's rule
 * (tickSpansOverlap) and ends by MAX_CLIP_END_BEATS.
 * A free `requested` is returned as is. Otherwise every candidate is a whole
 * tick `t`, returned as `t / PPQ`; distance is |t / PPQ - requested| in beats,
 * and ties go to the earlier start. Undefined when no start fits.
 *
 * Inside the clip domain (inClipDomain) a placed clip is never empty in ticks, so the free starts
 * are runs between the other clips and a finite set of candidates suffices.
 */
function nearestFreeStart(others: readonly Clip[], clip: Clip, requested: number): number | undefined {
  const length = clip.lengthBeats;
  const lastStart = MAX_CLIP_END_BEATS - length;
  if (Number.isNaN(requested) || lastStart < 0) return undefined;
  // Every candidate lies in [0, lastStart], so clamping the request keeps the
  // nearest one nearest and keeps far requests (1e300) from flattening distances.
  const target = Math.min(Math.max(0, requested), lastStart);
  const spans = others
    .map((o) => clipTickSpan(o.startBeat, o.lengthBeats))
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0]);
  const free = (start: number) =>
    start <= lastStart && spans.every((span) => !tickSpansOverlap(clipTickSpan(start, length), span));
  // A request clamped down to lastStart may sit between ticks: pick a tick candidate then.
  if (target === Math.max(0, requested) && free(target)) return target;

  let best: number | undefined;
  const consider = (tick: number) => {
    const start = tick / PPQ;
    if (tick < 0 || !free(start)) return;
    const distance = Math.abs(start - target);
    const bestDistance = best === undefined ? Infinity : Math.abs(best - target);
    if (distance < bestDistance || (distance === bestDistance && start < best!)) best = start;
  };
  // Both ends round separately, so each candidate tick is probed two ticks either way.
  const near = (tick: number) => {
    for (let d = -2; d <= 2; d += 1) consider(tick + d);
  };
  const lengthTick = beatTick(length);
  const targetTick = Math.floor(target * PPQ);
  const lastTick = Number.isFinite(lastStart) ? Math.floor(lastStart * PPQ) : Infinity;
  near(targetTick);
  near(targetTick + 1);
  if (Number.isFinite(lastTick)) near(lastTick);
  // Each gap between spans: its edges and its tick closest to the request.
  let gapStart = 0;
  for (let i = 0; i <= spans.length; i += 1) {
    const gapEnd = Math.min(i < spans.length ? spans[i]![0] - lengthTick : Infinity, lastTick);
    near(gapStart);
    if (Number.isFinite(gapEnd)) near(gapEnd);
    near(Math.min(Math.max(targetTick, gapStart), gapEnd));
    if (i < spans.length) gapStart = Math.max(gapStart, spans[i]![1]);
  }
  return best;
}

/** Add a clip to a track. Its content positions stay relative to `startBeat`. */
export function addClip(
  project: Project,
  trackId: string,
  clip: Omit<Clip, 'id' | 'trackId'> & { id?: string },
  clock: Clock = systemClock,
): Project {
  if (!project.tracks.some((t) => t.id === trackId)) return project;
  const allocateId = trackIdAllocator(project);
  const created: Clip = { ...clip, id: allocateId('clip', clip.id), trackId };
  if (clip.notes) created.notes = clip.notes.map((note) => ({ ...note, id: allocateId('note', note.id) }));
  if (clip.drumEvents) {
    created.drumEvents = clip.drumEvents.map((hit) => ({ ...hit, id: allocateId('drum', hit.id) }));
  }
  const tracks = mapTrack(project, trackId, (t) => ({ ...t, clips: [...t.clips, created] }));
  return touch({ ...project, tracks }, clock);
}

/**
 * Move a clip within its track. When `startBeat` would overlap another clip on
 * the track, the clip goes to the nearest start that does not.
 */
export function moveClip(
  project: Project,
  clipId: string,
  startBeat: number,
  clock: Clock = systemClock,
): Project {
  if (!Number.isFinite(startBeat)) return project;
  const found = locateClip(project, clipId);
  if (!found) return project;
  const { track, clip } = found;
  if (!trackInClipDomain(track)) return project;
  const others = track.clips.filter((c) => c.id !== clipId);
  const start = nearestFreeStart(others, clip, startBeat);
  if (start === undefined || start === clip.startBeat) return project;
  return touch({ ...project, tracks: mapClip(project, clipId, (c) => ({ ...c, startBeat: start })) }, clock);
}

/**
 * Change a clip's length. A looping clip keeps its repeat period: an unset
 * `contentLengthBeats` (meaning "the old length") is written out first.
 */
export function resizeClip(
  project: Project,
  clipId: string,
  lengthBeats: number,
  clock: Clock = systemClock,
): Project {
  if (!Number.isFinite(lengthBeats) || lengthBeats <= 0) return project;
  const found = locateClip(project, clipId);
  if (!found || lengthBeats === found.clip.lengthBeats) return project;
  if (!trackInClipDomain(found.track) || !inClipDomain({ startBeat: found.clip.startBeat, lengthBeats })) return project;
  const start = beatTick(found.clip.startBeat);
  const end = beatTick(found.clip.startBeat + lengthBeats);
  if (end > start && found.track.clips.some((other) => other.id !== clipId &&
    beatTick(other.startBeat) < end && beatTick(other.startBeat + other.lengthBeats) > start &&
    beatTick(other.startBeat + other.lengthBeats) > beatTick(other.startBeat))) return project;
  const tracks = mapClip(project, clipId, (clip) => {
    const next: Clip = { ...clip, lengthBeats };
    if (clip.loop && clip.contentLengthBeats === undefined) next.contentLengthBeats = clip.lengthBeats;
    return next;
  });
  return touch({ ...project, tracks }, clock);
}

/**
 * Quantize the starts of the given notes of a MIDI clip to a `snap`-beat grid
 * (D2). Each note rounds to the nearest grid line and stays inside the clip's
 * first pass (the loop period, or the clip up to the song end): one that would
 * end past it goes back to the last grid line where it still ends inside
 * (a note longer than the first pass is placed as if cut to it). The stored
 * length never changes and the clip never grows. A note whose move would sound
 * fewer times in any one placement (a partial repeat at the clip end, or a
 * link) keeps its place. Notes that do not sound in the first pass are left as
 * they are. A linked clip edits the clip its link resolves to.
 */
export function quantizeClipNotes(
  project: Project,
  requestedClipId: string,
  noteIds: readonly string[],
  snap: number,
  clock: Clock = systemClock,
): Project {
  if (!Number.isFinite(snap) || snap <= 0) return project;
  const clip = resolveEditTarget(project, requestedClipId);
  if (!clip?.notes) return project;
  const clipId = clip.id;
  const ids = new Set(noteIds);
  const { firstPassLength } = clipEditSpan(project, clip);
  const sounding = (candidate: Project) =>
    soundingEvents(candidate, { sourceClipId: clipId, includeMuted: true }).events;
  const before = sounding(project);
  const visible = new Set(before.filter((event) => event.clipId === clipId && event.kind === 'note' && event.repeat === 0)
    .map((event) => event.sourceIndex));
  const proposed = clip.notes.map((note, index) => {
    if (!ids.has(note.id) || !visible.has(index)) return note;
    // Only the placement uses the length cut to the first pass; the stored length stays.
    const placedLength = Math.min(note.durationBeats, firstPassLength);
    const lastStart = Math.floor((firstPassLength - placedLength) / snap + 1e-9) * snap;
    const startBeat = Math.max(0, Math.min(Math.max(0, Math.round(note.startBeat / snap) * snap), lastStart));
    if (startBeat === note.startBeat) return note;
    return { ...note, startBeat };
  });
  if (proposed.every((note, index) => note === clip.notes?.[index])) return project;

  // Count sounds per placement (clip) and note, so a gain in one placement (e.g. a
  // muted link) cannot hide a loss in another.
  const remaining = new Map<string, number>();
  const tally = (events: typeof before, delta: number) => {
    for (const event of events) {
      if (event.kind !== 'note') continue;
      const key = `${event.clipId}\u0000${event.sourceIndex}`;
      remaining.set(key, (remaining.get(key) ?? 0) + delta);
    }
  };
  tally(sounding({ ...project, tracks: mapClip(project, clipId, (c) => ({ ...c, notes: proposed })) }), 1);
  tally(before, -1);
  const losing = new Set<number>();
  for (const [key, count] of remaining) {
    if (count < 0) losing.add(Number(key.slice(key.lastIndexOf('\u0000') + 1)));
  }
  // Rounding a note forward can also hide its placement in a partial repeat.
  const notes = clip.notes.map((note, index) => losing.has(index) ? note : proposed[index]!);
  if (notes.every((note, index) => note === clip.notes?.[index])) return project;
  return touch({ ...project, tracks: mapClip(project, clipId, (c) => ({ ...c, notes })) }, clock);
}

/** Steps per bar a drum clip's hits are placed on (playback uses the link source's). */
function effectiveStepsPerBar(clip: Clip): number {
  return clip.stepsPerBar !== undefined && clip.stepsPerBar > 0 ? clip.stepsPerBar : DEFAULT_STEPS_PER_BAR;
}

/** Give `target` the step grid of `source`: its stepsPerBar, or none when the source has none. */
function withStepsPerBarOf(target: Clip, source: Clip): Clip {
  const next: Clip = { ...target };
  if (source.stepsPerBar !== undefined) next.stepsPerBar = source.stepsPerBar;
  else delete next.stepsPerBar;
  return next;
}

export type SplitClipFailure = 'missingClip' | 'invalidBoundary' | 'loopingClip' | 'linkedClip';

/** Beginner-friendly Japanese text for each reason a split is refused. */
export const SPLIT_FAILURE_MESSAGES: Record<SplitClipFailure, string> = {
  missingClip: 'クリップが見つからないため分けられません。',
  invalidBoundary: '再生ヘッドをクリップの内側(端ではない場所)に置くと分けられます。',
  loopingClip: 'ループを使っているクリップは分けられません。',
  linkedClip: 'ほかのクリップと中身を共有しているため分けられません。',
};

export type SplitClipResult =
  | { ok: true; project: Project }
  | { ok: false; project: Project; code: SplitClipFailure; reason: string };

/**
 * Split a clip at the absolute song beat `atBeat` into two clips; every note
 * and drum hit keeps sounding where it did. A note that crosses the boundary is
 * cut in two (the total note length is unchanged). A clip with drum hits is
 * split on the nearest step boundary, measured on the same step grid playback
 * uses.
 *
 * A source used by links keeps its stored content on the left, so those links
 * continue to sound as before. Loops and linked clips cannot be split.
 */
export function splitClip(
  project: Project,
  clipId: string,
  atBeat: number,
  clock: Clock = systemClock,
): SplitClipResult {
  const fail = (code: SplitClipFailure): SplitClipResult =>
    ({ ok: false, project, code, reason: SPLIT_FAILURE_MESSAGES[code] });
  const found = locateClip(project, clipId);
  if (!found) return fail('missingClip');
  const { track, clip } = found;
  if (clip.loop) return fail('loopingClip');
  if (clip.aliasOf !== undefined) return fail('linkedClip');
  if (!trackInClipDomain(track)) return fail('invalidBoundary');
  // Both parts must also keep the minimum clip length (they get `offset` and `lengthBeats - offset`).
  const isInterior = (offset: number) =>
    beatTick(offset) > 0 && beatTick(clip.startBeat + offset) < beatTick(clip.startBeat + clip.lengthBeats) &&
    offset >= MIN_LOOP_PERIOD_BEATS && clip.lengthBeats - offset >= MIN_LOOP_PERIOD_BEATS;
  let offset = atBeat - clip.startBeat;
  if (!isInterior(offset)) return fail('invalidBoundary');

  const allClips = project.tracks.flatMap((t) => t.clips);
  const source = clip;
  const bpb = beatsPerBar(project.timeSignature);
  const beatsPerStep = bpb / effectiveStepsPerBar(source);

  let boundaryStep = 0;
  if (clip.type === 'drum' || (source.drumEvents?.length ?? 0) > 0) {
    boundaryStep = Math.round(offset / beatsPerStep);
    offset = boundaryStep * beatsPerStep;
    if (!isInterior(offset)) return fail('invalidBoundary');
  }

  const allocateId = trackIdAllocator(project);
  const shared = allClips.some((c) => c.aliasOf === clipId);
  let left: Clip;
  let right: Clip;
  if (shared) {
    left = { ...clip, lengthBeats: offset };
    const expanded = expandClip(clip, allClips, bpb);
    right = withStepsPerBarOf(
      {
        ...clip,
        id: allocateId('clip'),
        startBeat: clip.startBeat + offset,
        lengthBeats: clip.lengthBeats - offset,
        loop: false,
      },
      source,
    );
    delete right.aliasOf;
    delete right.contentLengthBeats;
    delete right.legacyClipSettings;
    delete right.notes;
    delete right.drumEvents;
    if (source.notes) {
      right.notes = [];
      for (const n of expanded.notes) {
        const start = n.startBeat - clip.startBeat;
        const end = start + n.durationBeats;
        if (end <= offset + CLIP_EPSILON) continue;
        const rightStart = Math.max(start, offset);
        right.notes.push({
          id: allocateId('note'),
          pitch: n.pitch,
          startBeat: rightStart - offset,
          durationBeats: end - rightStart,
          velocity: n.velocity,
        });
      }
    }
    if (source.drumEvents) {
      right.drumEvents = [];
      for (const hit of expanded.drumHits) {
        const start = hit.beat - clip.startBeat - offset;
        if (start < -CLIP_EPSILON) continue;
        const step = Math.max(0, start) / beatsPerStep;
        const stepIndex = Math.round(step);
        right.drumEvents.push({ id: allocateId('drum'), lane: hit.lane, stepIndex, velocity: hit.velocity });
      }
    }
  } else {
    left = { ...clip, lengthBeats: offset };
    right = {
      ...clip,
      id: allocateId('clip'),
      startBeat: clip.startBeat + offset,
      lengthBeats: clip.lengthBeats - offset,
    };
    if (clip.notes) {
      const leftNotes: NoteEvent[] = [];
      const rightNotes: NoteEvent[] = [];
      for (const n of clip.notes) {
        const end = n.startBeat + n.durationBeats;
        if (n.startBeat < offset - CLIP_EPSILON) {
          leftNotes.push(end > offset + CLIP_EPSILON ? { ...n, durationBeats: offset - n.startBeat } : n);
          if (end > offset + CLIP_EPSILON) {
            rightNotes.push({ ...n, id: allocateId('note'), startBeat: 0, durationBeats: end - offset });
          }
        } else {
          // A note within the tolerance before the cut starts the right part (never a negative beat).
          rightNotes.push({ ...n, startBeat: Math.max(0, n.startBeat - offset) });
        }
      }
      left.notes = leftNotes;
      right.notes = rightNotes;
    }
    if (clip.drumEvents) {
      left.drumEvents = clip.drumEvents.filter((e) => e.stepIndex < boundaryStep);
      right.drumEvents = clip.drumEvents
        .filter((e) => e.stepIndex >= boundaryStep)
        .map((e) => ({ ...e, stepIndex: e.stepIndex - boundaryStep }));
    }
  }
  const tracks = mapTrack(project, track.id, (t) => ({
    ...t,
    clips: t.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])),
  }));
  return { ok: true, project: touch({ ...project, tracks }, clock) };
}

/**
 * Duplicate a clip on its track, by default right after it (moved to the nearest
 * free spot). `copy` makes an independent clip with its own content; `link`
 * makes a clip with `aliasOf` set to the clip that owns the content and no
 * notes or drum hits of its own.
 */
export function duplicateClip(
  project: Project,
  clipId: string,
  opts: { mode: 'copy' | 'link'; startBeat?: number },
  clock: Clock = systemClock,
): Project {
  const found = locateClip(project, clipId);
  if (!found) return project;
  const { track, clip } = found;
  if (!trackInClipDomain(track)) return project;
  const requestedStart = opts.startBeat ?? clip.startBeat + clip.lengthBeats;
  if (!Number.isFinite(requestedStart)) return project;
  const source = resolveEditTarget(project, clipId);
  if (opts.mode === 'link' && !source) return project;
  const allocateId = trackIdAllocator(project);
  const startBeat = nearestFreeStart(track.clips, clip, requestedStart);
  if (startBeat === undefined) return project;
  const duplicate: Clip = { ...clip, id: allocateId('clip'), startBeat };
  delete duplicate.legacyClipSettings;
  if (opts.mode === 'link') {
    duplicate.aliasOf = source!.id;
    delete duplicate.notes;
    delete duplicate.drumEvents;
  } else {
    const content = source ?? clip;
    delete duplicate.aliasOf;
    delete duplicate.notes;
    delete duplicate.drumEvents;
    if (content.notes) duplicate.notes = content.notes.map((n) => ({ ...n, id: allocateId('note') }));
    if (content.drumEvents) duplicate.drumEvents = content.drumEvents.map((d) => ({ ...d, id: allocateId('drum') }));
  }
  const placed = opts.mode === 'copy' ? withStepsPerBarOf(duplicate, source ?? clip) : duplicate;
  const tracks = mapTrack(project, track.id, (t) => ({ ...t, clips: [...t.clips, placed] }));
  return touch({ ...project, tracks }, clock);
}

/**
 * Remove a clip. Clips linked to it keep sounding: they follow its own link
 * when it has one, otherwise each gets its own copy of the removed content.
 */
export function removeClip(project: Project, clipId: string, clock: Clock = systemClock): Project {
  const found = locateClip(project, clipId);
  if (!found) return project;
  const { clip } = found;
  const allocateId = trackIdAllocator(project);
  const tracks = project.tracks.map((t) => ({
    ...t,
    clips: t.clips
      .filter((c) => c.id !== clipId)
      .map((c): Clip => {
        if (c.aliasOf !== clipId) return c;
        if (clip.aliasOf !== undefined) return { ...c, aliasOf: clip.aliasOf };
        // The copy plays on the removed clip's step grid, as the link did.
        const own = withStepsPerBarOf(c, clip);
        delete own.aliasOf;
        delete own.notes;
        delete own.drumEvents;
        if (clip.notes) own.notes = clip.notes.map((n) => ({ ...n, id: allocateId('note') }));
        if (clip.drumEvents) own.drumEvents = clip.drumEvents.map((d) => ({ ...d, id: allocateId('drum') }));
        return own;
      }),
  }));
  return touch({ ...project, tracks }, clock);
}

// --- Mixer ---

export function setTrackVolume(
  project: Project,
  trackId: string,
  volume: number,
  clock: Clock = systemClock,
): Project {
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, volume })) }, clock);
}

export function setTrackPan(
  project: Project,
  trackId: string,
  pan: number,
  clock: Clock = systemClock,
): Project {
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, pan })) }, clock);
}

export function setTrackMute(
  project: Project,
  trackId: string,
  mute: boolean,
  clock: Clock = systemClock,
): Project {
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, mute })) }, clock);
}

export function setTrackSolo(
  project: Project,
  trackId: string,
  solo: boolean,
  clock: Clock = systemClock,
): Project {
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, solo })) }, clock);
}

// --- Track management ---
//
// The master track cannot be removed, moved or duplicated: those calls return
// the project unchanged (same object) instead of throwing.

const DEFAULT_TRACK_NAME: Record<'instrument' | 'drum', string> = {
  instrument: '楽器',
  drum: 'ドラム',
};

/** "楽器 2" style name: one past the tracks of that type, skipping names in use. */
function nextTrackName(project: Project, type: 'instrument' | 'drum'): string {
  const used = new Set(project.tracks.map((t) => t.name));
  let n = project.tracks.filter((t) => t.type === type).length + 1;
  while (used.has(`${DEFAULT_TRACK_NAME[type]} ${n}`)) n += 1;
  return `${DEFAULT_TRACK_NAME[type]} ${n}`;
}

/** Allocate IDs against all saved entities and clip links, including dangling links. */
function trackIdAllocator(project: Project): (prefix: string, preferred?: string) => string {
  const ids = new Set([project.id]);
  for (const chord of project.chordTrack) ids.add(chord.id);
  for (const section of project.sections) ids.add(section.id);
  for (const track of project.tracks) {
    ids.add(track.id);
    for (const effect of track.effects) ids.add(effect.id);
    for (const clip of track.clips) {
      ids.add(clip.id);
      if (clip.aliasOf !== undefined) ids.add(clip.aliasOf);
      clip.notes?.forEach((n) => ids.add(n.id));
      clip.drumEvents?.forEach((d) => ids.add(d.id));
    }
  }
  let sequence = 0;
  return (prefix, preferred) => {
    let id = preferred;
    // Use a separate namespace from the IDs issued by makeId.
    while (!id || ids.has(id)) id = `${prefix}-track-edit-${++sequence}`;
    ids.add(id);
    return id;
  };
}

/** Insert a track after the last non-master track (the master keeps its slot). */
function insertBeforeTrailingMaster(tracks: Track[], track: Track, afterIndex?: number): Track[] {
  let index = afterIndex;
  if (index === undefined) {
    index = -1;
    tracks.forEach((t, i) => {
      if (t.type !== 'master') index = i;
    });
  }
  return [...tracks.slice(0, index + 1), track, ...tracks.slice(index + 1)];
}

/**
 * Add an instrument or drum track holding one empty clip over the whole song.
 * The name defaults to a numbered Japanese name; the role stays unset unless given.
 */
export function addTrack(
  project: Project,
  options: { type: 'instrument' | 'drum'; name?: string; role?: TrackRole; id?: string },
  clock: Clock = systemClock,
): Project {
  const { type } = options;
  const name = options.name?.trim() || nextTrackName(project, type);
  const instrument =
    type === 'drum' ? { type: 'drumkit' as const, preset: 'basic' } : { type: 'synth' as const, preset: 'leadSine' };
  const allocateId = trackIdAllocator(project);
  const trackId = allocateId('track', options.id);
  const track = createTrack(name, type, instrument, undefined, options.role, trackId);
  const lengthBeats = project.lengthBars * beatsPerBar(project.timeSignature);
  const clipId = allocateId('clip');
  const clip =
    type === 'drum'
      ? createDrumClip(trackId, 0, lengthBeats, drumStepsPerBar(project.timeSignature), clipId)
      : createMidiClip(trackId, 0, lengthBeats, clipId);
  return touch({ ...project, tracks: insertBeforeTrailingMaster(project.tracks, { ...track, clips: [clip] }) }, clock);
}

/** Remove a track and its clips. The master (or an unknown id) is left as is. */
export function removeTrack(project: Project, trackId: string, clock: Clock = systemClock): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.type === 'master') return project;
  return touch({ ...project, tracks: project.tracks.filter((t) => t.id !== trackId) }, clock);
}

/**
 * Copy a track right after itself. Every clip, note, drum event and effect gets
 * a new id; links between clips of the copied track point at the copies, and
 * links to clips elsewhere are kept.
 */
export function duplicateTrack(
  project: Project,
  trackId: string,
  clock: Clock = systemClock,
  id?: string,
): Project {
  const index = project.tracks.findIndex((t) => t.id === trackId);
  const track = project.tracks[index];
  if (!track || track.type === 'master') return project;
  const allocateId = trackIdAllocator(project);
  const newTrackId = allocateId('track', id);
  const clipIds = new Map(track.clips.map((c) => [c.id, allocateId('clip')] as const));
  const clips = track.clips.map((clip): Clip => {
    const copy: Clip = { ...clip, id: clipIds.get(clip.id)!, trackId: newTrackId };
    if (clip.aliasOf !== undefined) copy.aliasOf = clipIds.get(clip.aliasOf) ?? clip.aliasOf;
    if (clip.notes) copy.notes = clip.notes.map((n) => ({ ...n, id: allocateId('note') }));
    if (clip.drumEvents) copy.drumEvents = clip.drumEvents.map((d) => ({ ...d, id: allocateId('drum') }));
    return copy;
  });
  const copy: Track = {
    ...track,
    id: newTrackId,
    name: `${track.name} のコピー`,
    clips,
    effects: track.effects.map((e) => ({ ...e, id: allocateId('fx'), params: { ...e.params } })),
  };
  return touch({ ...project, tracks: insertBeforeTrailingMaster(project.tracks, copy, index) }, clock);
}

/** Rename a track. An empty (after trimming) or unchanged name leaves the project as is. */
export function renameTrack(
  project: Project,
  trackId: string,
  name: string,
  clock: Clock = systemClock,
): Project {
  const trimmed = name.trim();
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || trimmed === '' || trimmed === track.name) return project;
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, name: trimmed })) }, clock);
}

/**
 * Move a track to `toIndex` in the order of the non-master tracks (clamped).
 * The master stays where it is; moving the master or to the same place is a no-op.
 */
export function moveTrack(
  project: Project,
  trackId: string,
  toIndex: number,
  clock: Clock = systemClock,
): Project {
  const movable = project.tracks.filter((t) => t.type !== 'master');
  const from = movable.findIndex((t) => t.id === trackId);
  if (from < 0) return project;
  const to = Math.min(movable.length - 1, Math.max(0, Math.trunc(toIndex)));
  if (to === from) return project;
  const reordered = movable.filter((t) => t.id !== trackId);
  reordered.splice(to, 0, movable[from]!);
  let next = 0;
  const tracks = project.tracks.map((t) => (t.type === 'master' ? t : reordered[next++]!));
  return touch({ ...project, tracks }, clock);
}

/** Set a track's display color (a CSS color such as "#5bb0a8"). */
export function setTrackColor(
  project: Project,
  trackId: string,
  color: string,
  clock: Clock = systemClock,
): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.color === color) return project;
  return touch({ ...project, tracks: mapTrack(project, trackId, (t) => ({ ...t, color })) }, clock);
}

// --- Sections ---

export function addSection(
  project: Project,
  section: Omit<Section, 'id'> & { id?: string },
  clock: Clock = systemClock,
): Project {
  const event: Section = { ...section, id: section.id ?? makeId('section') };
  return touch({ ...project, sections: [...project.sections, event] }, clock);
}

export function updateSection(
  project: Project,
  sectionId: string,
  patch: Partial<Omit<Section, 'id'>>,
  clock: Clock = systemClock,
): Project {
  const sections = project.sections.map((s) => (s.id === sectionId ? { ...s, ...patch } : s));
  return touch({ ...project, sections }, clock);
}

// --- Loop range ---

/**
 * Set the beat range repeated while looping, or clear it with null. Throws
 * unless 0 <= startBeat < endBeat.
 */
export function setLoopRange(
  project: Project,
  range: { startBeat: number; endBeat: number } | null,
  clock: Clock = systemClock,
): Project {
  if (range === null) {
    const { loopRange: _cleared, ...rest } = project;
    return touch(rest, clock);
  }
  const { startBeat, endBeat } = range;
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || startBeat < 0 || endBeat <= startBeat) {
    throw new Error(`loop range must satisfy 0 <= start < end (got ${startBeat} to ${endBeat})`);
  }
  return touch({ ...project, loopRange: { startBeat, endBeat } }, clock);
}

// --- Time signature / song length ---

/** Default steps per bar for a drum clip when not specified. */
const DEFAULT_STEPS_PER_BAR = 16;
const BEAT_EPSILON = 1e-9;

export type TimeSignatureChange = {
  project: Project;
  /** Beginner-facing notes (Japanese) about content that could not be kept exactly. */
  warnings: string[];
  /**
   * Source drum hits removed by a collision or losing one or more audible
   * occurrences at a clip, loop or song boundary. Callers should confirm
   * before applying a change with a nonzero count.
   */
  droppedHits: number;
};

type RegriddedHit = {
  event: DrumEvent;
  stepIndex: number;
  /** The old beat position lies exactly on the new grid. */
  exact: boolean;
  beat: number;
};

/**
 * Which of two hits that collide on one step survives: the one that was on the
 * grid already, then the louder one, then the earlier one. Independent of the
 * order the events are stored in.
 */
function outranks(candidate: RegriddedHit, current: RegriddedHit): boolean {
  if (candidate.exact !== current.exact) return candidate.exact;
  if (candidate.event.velocity !== current.event.velocity) {
    return candidate.event.velocity > current.event.velocity;
  }
  return candidate.beat < current.beat;
}

/** Nearest integer, treating values within BEAT_EPSILON of an integer as exact. */
function isWholeNumber(value: number): boolean {
  return Math.abs(value - Math.round(value)) < BEAT_EPSILON;
}

/** Beat position of a drum step, relative to its clip start. */
function drumStepBeat(stepIndex: number, stepsPerBar: number, bpb: number): number {
  return stepIndex * (bpb / stepsPerBar);
}

/**
 * Change the time signature. Note and chord positions are kept in beats, so no
 * content is lost: `lengthBars` is rounded up to cover the old total beats.
 * Sections are converted by beat and snapped to the nearest bar; drum clips are
 * regridded to `beatsPerBar * 4` steps with every hit at its old beat position.
 * Clips that ended with the song grow to the new (rounded-up) song end.
 * Anything that did not land exactly is reported in `warnings`.
 */
export function setTimeSignature(
  project: Project,
  timeSignature: [number, number],
  clock: Clock = systemClock,
): TimeSignatureChange {
  const oldBpb = beatsPerBar(project.timeSignature);
  const newBpb = beatsPerBar(timeSignature);
  const warnings: string[] = [];

  const totalBeats = project.lengthBars * oldBpb;
  const lengthBars = Math.max(1, Math.ceil(totalBeats / newBpb - BEAT_EPSILON));

  const snapped = project.sections.map((section) => {
    const startBar = (section.startBar * oldBpb) / newBpb;
    const endBar = ((section.startBar + section.lengthBars) * oldBpb) / newBpb;
    const snappedStart = Math.round(startBar);
    const snappedSection: Section = {
      ...section,
      startBar: snappedStart,
      lengthBars: Math.max(1, Math.round(endBar) - snappedStart),
    };
    return { section: snappedSection, offGrid: !isWholeNumber(startBar) || !isWholeNumber(endBar) };
  });
  // Snapping can push a section that started in the last partial bar onto the
  // new end. Such a section is merged into the latest section that still fits
  // (which then runs to the end); with none, the first one is kept on the last
  // bar and any further ones merge into it.
  const fitting = snapped.filter(({ section }) => section.startBar < lengthBars);
  let mergeTarget = fitting.reduce<Section | undefined>(
    (latest, { section }) => (latest === undefined || section.startBar >= latest.startBar ? section : latest),
    undefined,
  );
  let extendMergeTarget = false;
  const sections: Section[] = [];
  for (const { section, offGrid } of snapped) {
    if (section.startBar < lengthBars) {
      if (offGrid) {
        warnings.push(
          `セクション「${section.name}」の区切りが新しい拍子の小節に合わないため、いちばん近い小節に合わせました。`,
        );
      }
      sections.push({ ...section, lengthBars: Math.min(section.lengthBars, lengthBars - section.startBar) });
    } else if (mergeTarget !== undefined) {
      warnings.push(
        `セクション「${section.name}」は新しい拍子では曲の終わりより後ろになるため、前のセクション「${mergeTarget.name}」にまとめました。`,
      );
      extendMergeTarget = true;
    } else {
      warnings.push(
        `セクション「${section.name}」は新しい拍子では曲の終わりより後ろになるため、最後の小節に収めました。`,
      );
      mergeTarget = { ...section, startBar: lengthBars - 1, lengthBars: 1 };
      sections.push(mergeTarget);
    }
  }
  if (extendMergeTarget && mergeTarget !== undefined) {
    const index = sections.findIndex((s) => s.id === mergeTarget.id);
    const target = sections[index];
    if (target !== undefined) sections[index] = { ...target, lengthBars: lengthBars - target.startBar };
  }

  // Clips that ended with the song keep ending with it (as in `setLengthBars`),
  // so the rounded-up bars stay editable and a later lengthening still grows them.
  const newEndBeat = lengthBars * newBpb;
  const followSongEnd = (clip: Clip): Clip =>
    Math.abs(clip.startBeat + clip.lengthBeats - totalBeats) < BEAT_EPSILON
      ? { ...clip, lengthBeats: newEndBeat - clip.startBeat }
      : clip;

  const newStepsPerBar = drumStepsPerBar(timeSignature);
  let shiftedHits = 0;
  const collidedHits = new Set<string>();
  const pastEndHits = new Set<string>();
  const allClips = project.tracks.flatMap((track) => track.clips);
  const drumUses = new Map<string, Clip[]>();
  for (const track of project.tracks) {
    if (track.type !== 'drum') continue;
    for (const clip of track.clips) {
      const source = resolveLinkSource(clip, allClips);
      if (typeof source === 'string') continue;
      const uses = drumUses.get(source.id);
      if (uses) uses.push(clip);
      else drumUses.set(source.id, [clip]);
    }
  }
  const tracks = project.tracks.map((track) => {
    const clips = track.clips.map((oldClip) => {
      const clip = followSongEnd(oldClip);
      const uses = drumUses.get(clip.id);
      if (track.type !== 'drum' && uses === undefined) return clip;
      const oldStepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      const clipUses = (uses ?? [oldClip]).map((use) => ({ old: use, next: followSongEnd(use) }));
      // One hit per lane and step: when the new grid is coarser, hits can collide
      // and only one can be kept (see `outranks`). Nothing is dropped silently.
      const survivors = new Map<string, RegriddedHit>();
      for (const event of clip.drumEvents ?? []) {
        const beat = drumStepBeat(event.stepIndex, oldStepsPerBar, oldBpb);
        const exactStep = beat * (newStepsPerBar / newBpb);
        const candidate: RegriddedHit = {
          event,
          stepIndex: Math.round(exactStep),
          exact: isWholeNumber(exactStep),
          beat,
        };
        // Rounding up can put a hit that sounded before the end exactly on (or
        // past) the end of a linked clip, a loop pass, or the song.
        const newBeat = drumStepBeat(candidate.stepIndex, newStepsPerBar, newBpb);
        const nextCount = (use: Clip): number => drumHitRepeatCount(use, newBeat, newEndBeat - use.startBeat);
        if (clipUses.some((use) => drumHitRepeatCount(use.old, beat, totalBeats - use.old.startBeat) > nextCount(use.next))) {
          pastEndHits.add(event.id);
          // Keep the hit if it can still sound in any pass of the pattern.
          if (!clipUses.some((use) => nextCount(use.next) > 0)) continue;
        }
        const key = `${event.lane}:${candidate.stepIndex}`;
        const current = survivors.get(key);
        if (current === undefined) {
          survivors.set(key, candidate);
          continue;
        }
        if (outranks(candidate, current)) {
          collidedHits.add(current.event.id);
          survivors.set(key, candidate);
        } else {
          collidedHits.add(event.id);
        }
      }
      const drumEvents: DrumEvent[] = [];
      for (const hit of survivors.values()) {
        if (!hit.exact) shiftedHits += 1;
        drumEvents.push({ ...hit.event, stepIndex: hit.stepIndex });
      }
      return { ...clip, stepsPerBar: newStepsPerBar, drumEvents };
    });
    return { ...track, clips };
  });
  if (shiftedHits > 0) {
    warnings.push(
      `ドラムの ${shiftedHits} 個の音が新しいグリッドに乗らないため、いちばん近いステップに動かしました。`,
    );
  }
  if (collidedHits.size > 0) {
    warnings.push(
      `ドラムの ${collidedHits.size} 個の音が新しいグリッドで別の音と同じステップに重なるため、拍に合っていた音(同じなら強い音)を残して削除しました。`,
    );
  }
  if (pastEndHits.size > 0) {
    warnings.push(
      `ドラムの ${pastEndHits.size} 個の音が新しいグリッドで曲の終わり、クリップの終わり、またはループの区切りに重なり、鳴らなくなる場所がありました。`,
    );
  }

  return {
    project: touch({ ...project, timeSignature, lengthBars, sections, tracks }, clock),
    warnings,
    droppedHits: new Set([...collidedHits, ...pastEndHits]).size,
  };
}

export type ContentBeyondBars = {
  /** Notes that start at or after the new end (removed). */
  notes: number;
  /** Chords that start at or after the new end (removed). */
  chords: number;
  drumHits: number;
  sections: number;
  /** Notes that start before the new end but ring past it (cut at the end). */
  truncatedNotes: number;
  /** Chords that start before the new end but last past it (cut at the end). */
  truncatedChords: number;
  /** Audible changes within the kept bars caused by trimming shared content. */
  linkedLosses?: { notes: number; drumHits: number; truncatedNotes: number };
};

/**
 * Count the content affected by shortening the song to `lengthBars`: notes,
 * chords, drum hits and sections that start at or after the new end, plus the
 * notes and chords that start before it and run past it.
 */
export function contentBeyondBars(project: Project, lengthBars: number): ContentBeyondBars {
  const bpb = beatsPerBar(project.timeSignature);
  const endBeat = lengthBars * bpb;
  const beyond = (beat: number): boolean => beat >= endBeat - BEAT_EPSILON;
  const crosses = (start: number, duration: number): boolean =>
    !beyond(start) && start + duration > endBeat + BEAT_EPSILON;

  let notes = 0;
  let truncatedNotes = 0;
  let drumHits = 0;
  const linkedLosses = { notes: 0, drumHits: 0, truncatedNotes: 0 };
  const allClips = project.tracks.flatMap((track) => track.clips);
  const shortening = lengthBars < project.lengthBars;
  const resizedClips = shortening && allClips.some((clip) => clip.aliasOf !== undefined)
    ? resizeClipTracks(project, lengthBars).flatMap((track) => track.clips)
    : [];
  const resizedById = new Map(resizedClips.map((clip) => [clip.id, clip]));
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      for (const note of clip.notes ?? []) {
        const start = clip.startBeat + note.startBeat;
        if (beyond(start)) notes += 1;
        else if (crosses(start, note.durationBeats)) truncatedNotes += 1;
      }
      const stepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      for (const hit of clip.drumEvents ?? []) {
        if (beyond(clip.startBeat + drumStepBeat(hit.stepIndex, stepsPerBar, bpb))) drumHits += 1;
      }
      if (!shortening || (!clip.loop && clip.aliasOf === undefined)) continue;

      // Raw content is counted above. Add linked sounds and the later passes of
      // loops, which have no separate stored event to count.
      const expanded = soundingEvents(project, { clipId: clip.id, includeMuted: true }).events;
      for (const event of expanded) {
        if (clip.aliasOf === undefined && event.repeat === 0) continue;
        if (event.kind === 'drum') drumHits += Number(beyond(event.startBeat));
        else if (beyond(event.startBeat)) notes += 1;
        else if (crosses(event.startBeat, event.durationBeats)) truncatedNotes += 1;
      }

      const resized = resizedById.get(clip.id);
      if (clip.aliasOf === undefined || resized === undefined) continue;
      const after = expandClip(resized, resizedClips, bpb, track.type);
      linkedLosses.drumHits += Math.max(0, expanded.filter((event) => event.kind === 'drum' && !beyond(event.startBeat)).length - after.drumHits.length);

      // Source trimming keeps event order and removes all notes at a removed
      // onset. Group by onset so overlapping notes at the same beat count too.
      const remainingAtBeat = new Map<number, number[]>();
      for (const note of after.notes) {
        const durations = remainingAtBeat.get(note.startBeat);
        if (durations) durations.push(note.durationBeats);
        else remainingAtBeat.set(note.startBeat, [note.durationBeats]);
      }
      for (let i = expanded.length - 1; i >= 0; i--) {
        const note = expanded[i]!;
        if (note.kind !== 'note' || beyond(note.startBeat)) continue;
        const remaining = remainingAtBeat.get(note.startBeat)?.pop();
        if (remaining === undefined) linkedLosses.notes += 1;
        else if (Math.min(note.durationBeats, endBeat - note.startBeat) > remaining + BEAT_EPSILON) {
          linkedLosses.truncatedNotes += 1;
        }
      }
    }
  }
  const chords = project.chordTrack.filter((c) => beyond(c.startBeat)).length;
  const truncatedChords = project.chordTrack.filter((c) => crosses(c.startBeat, c.durationBeats)).length;
  const sections = project.sections.filter((s) => s.startBar >= lengthBars).length;
  const hasLinkedLosses = linkedLosses.notes + linkedLosses.drumHits + linkedLosses.truncatedNotes > 0;
  return {
    notes, chords, drumHits, sections, truncatedNotes, truncatedChords,
    ...(hasLinkedLosses ? { linkedLosses } : {}),
  };
}

function cutAtSongEnd<T extends { durationBeats: number }>(item: T, start: number, end: number): T {
  return start + item.durationBeats > end + BEAT_EPSILON
    ? { ...item, durationBeats: end - start }
    : item;
}

/**
 * Repair links using the original clip list before trimming. If the entire
 * source is going away, give each affected link its own copy of the pattern.
 */
function resizeClipTracks(project: Project, lengthBars: number): Track[] {
  const oldEndBeat = songEndBeat(project);
  const bpb = beatsPerBar(project.timeSignature);
  const endBeat = lengthBars * bpb;
  const beyond = (beat: number): boolean => beat >= endBeat - BEAT_EPSILON;
  const allClips = project.tracks.flatMap((track) => track.clips);
  const keptClips = allClips.filter((clip) => !beyond(clip.startBeat));
  const keptIds = new Set(keptClips.map((clip) => clip.id));
  let ids: Set<string> | undefined;
  const copyEvent = <T extends { id: string }>(event: T, clipId: string): T => {
    ids ??= new Set([
      project.id,
      ...project.tracks.map((track) => track.id),
      ...project.chordTrack.map((chord) => chord.id),
      ...project.sections.map((section) => section.id),
      ...allClips.flatMap((clip) => [
        clip.id,
        ...(clip.notes ?? []).map((note) => note.id),
        ...(clip.drumEvents ?? []).map((hit) => hit.id),
      ]),
    ]);
    const base = `${clipId}-${event.id}`;
    let id = base;
    for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`;
    ids.add(id);
    return { ...event, id };
  };

  return project.tracks.map((track) => {
    const clips: Clip[] = [];
    for (const original of track.clips) {
      if (!keptIds.has(original.id)) continue;
      let clip = original;
      if (clip.aliasOf !== undefined && typeof resolveLinkSource(clip, keptClips) === 'string') {
        const source = resolveLinkSource(clip, allClips);
        if (typeof source !== 'string') {
          clip = keptIds.has(source.id)
            ? { ...clip, aliasOf: source.id }
            : {
                ...clip,
                aliasOf: undefined,
                notes: source.notes?.map((note) => copyEvent(note, clip.id)),
                drumEvents: source.drumEvents?.map((hit) => copyEvent(hit, clip.id)),
                stepsPerBar: source.stepsPerBar,
              };
        }
      }
      const clipEnd = clip.startBeat + clip.lengthBeats;
      const endsWithSong = Math.abs(clipEnd - oldEndBeat) < BEAT_EPSILON;
      const lengthBeats = clipEnd > endBeat || endsWithSong ? endBeat - clip.startBeat : clip.lengthBeats;
      const stepsPerBar = clip.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
      const next: Clip = { ...clip, lengthBeats };
      if (clip.notes) {
        next.notes = clip.notes
          .filter((n) => !beyond(clip.startBeat + n.startBeat))
          .map((n) => cutAtSongEnd(n, clip.startBeat + n.startBeat, endBeat));
      }
      if (clip.drumEvents) {
        next.drumEvents = clip.drumEvents.filter(
          (hit) => !beyond(clip.startBeat + drumStepBeat(hit.stepIndex, stepsPerBar, bpb)),
        );
      }
      clips.push(next);
    }
    return { ...track, clips };
  });
}

/**
 * Set the song length in bars. Content beyond the new end is removed and
 * crossing notes, chords and sections are cut. Clips ending with the song
 * follow its end (see `contentBeyondBars` to warn first).
 */
export function setLengthBars(
  project: Project,
  lengthBars: number,
  clock: Clock = systemClock,
): Project {
  const endBeat = lengthBars * beatsPerBar(project.timeSignature);
  const beyond = (beat: number): boolean => beat >= endBeat - BEAT_EPSILON;
  const tracks = resizeClipTracks(project, lengthBars);
  const chordTrack = project.chordTrack
    .filter((c) => !beyond(c.startBeat))
    .map((c) => cutAtSongEnd(c, c.startBeat, endBeat));
  const sections = project.sections
    .filter((s) => s.startBar < lengthBars)
    .map((s) => ({ ...s, lengthBars: Math.min(s.lengthBars, lengthBars - s.startBar) }));

  // The loop range is cut at the new end, or dropped when it starts at or after
  // it, so loop playback never repeats beats past the song.
  const { loopRange, ...rest } = project;
  const keptLoop =
    loopRange === undefined || beyond(loopRange.startBeat)
      ? {}
      : { loopRange: { startBeat: loopRange.startBeat, endBeat: Math.min(loopRange.endBeat, endBeat) } };

  return touch({ ...rest, ...keptLoop, lengthBars, tracks, chordTrack, sections }, clock);
}
