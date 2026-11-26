// Section-level edits: duplicate a section, swap it with a neighbour, or
// delete it, together with the clips and chords in its bars. Each returns a new
// Project (no in-place mutation) or the unchanged Project with a reason.
//
// Clips that cross a section edge are first cut there with splitClip (so loops
// and links are refused as in D4) and chords are cut in two, so every clip and
// chord lies wholly inside or outside the section. Clips are copied with
// duplicateClip and removed with removeClip; moving content is a plain shift of
// startBeat (moveClip would push a clip that briefly overlaps another away).
// Drum clips are clips like any other. A section counts only up to the song end.

import type { Clock } from './clock';
import { nowIso, systemClock } from './clock';
import {
  duplicateClip,
  inClipDomain,
  removeClip,
  resolveEditTarget,
  splitClip,
  SPLIT_FAILURE_MESSAGES,
  trackIdAllocator,
} from './mutations';
import { maxSongBars, soundingEvents } from './sounding';
import { beatTick, beatsPerBar, clipTickSpan } from './time';
import type { ChordEvent, Clip, Project, Section } from './types';
import { validateProject } from './validation';

export type SectionEditFailure =
  | 'missingSection'
  | 'invalidSectionRange'
  | 'noNeighbor'
  | 'overlappingSections'
  | 'songTooLong'
  | 'loopingClip'
  | 'linkedClip'
  | 'cannotSplitClip'
  | 'outsideClipDomain'
  | 'clipBeforeSongStart'
  | 'invalidResult'
  | 'soundChanged';

const EDGE = 'セクションの境目をまたぐクリップがあるため、この操作はできません。';

/** Beginner-friendly Japanese text for each reason a section edit is refused. */
export const SECTION_EDIT_FAILURE_MESSAGES: Record<SectionEditFailure, string> = {
  missingSection: 'セクションが見つからないため、この操作はできません。',
  invalidSectionRange: 'セクションが曲の範囲の外にあるか、開始小節や長さが整数でないため、この操作はできません。',
  noNeighbor: 'その向きにはとなりのセクションがないため、入れ替えられません。',
  overlappingSections: 'となりのセクションと小節が重なっているため、入れ替えられません。',
  songTooLong: '曲が長くなりすぎるため、このセクションは複製できません。',
  loopingClip: `${EDGE}${SPLIT_FAILURE_MESSAGES.loopingClip}ループを外すか、クリップを境目の内側に収めてください。`,
  linkedClip: `${EDGE}${SPLIT_FAILURE_MESSAGES.linkedClip}リンクのクリップを境目の内側に収めてください。`,
  cannotSplitClip:
    `${EDGE}ドラムのマス目が境目とずれているか、境目のすぐそばで終わるため、境目で分けられません。クリップを境目に合わせてください。`,
  outsideClipDomain:
    'とても短いクリップか、曲のずっと後ろにあるクリップがトラックにあるため、この操作はできません。そのクリップを長くするか消してください。',
  clipBeforeSongStart:
    'セクションの境目のほんの少し手前から始まるループやリンクのクリップ(またはリンク元)が曲の頭より前に出てしまうため、この操作はできません。クリップを境目に合わせてください。',
  invalidResult: 'この操作をすると曲の決まり(音の数の上限など)を超えてしまうため、実行できません。',
  soundChanged: '細かい位置の音がずれたり消えたりするため、この操作はできません。',
};

export type SectionEditResult =
  | { ok: true; project: Project }
  | { ok: false; project: Project; code: SectionEditFailure; reason: string };

const fail = (project: Project, code: SectionEditFailure, detail = ''): SectionEditResult => ({
  ok: false,
  project,
  code,
  reason: SECTION_EDIT_FAILURE_MESSAGES[code] + detail,
});

/** `[fromTick, toTick, shiftTicks]`: onsets in [from, to) move by `shift` ticks. */
type Region = readonly [number, number, number];

type Sound = { key: string; start: number; end: number };

function soundingTicks(project: Project): Sound[] {
  return soundingEvents(project, { includeMuted: true }).events.map((event) => {
    const start = beatTick(event.startBeat);
    return {
      key: event.kind === 'note'
        ? `${event.trackId}|note|${event.pitch}|${event.velocity}`
        : `${event.trackId}|drum|${event.lane}|${event.velocity}`,
      start,
      end: event.kind === 'note' ? beatTick(event.startBeat + event.durationBeats) : start,
    };
  });
}

/** Count identical events so even overlapping notes with the same pitch keep their multiplicity. */
function addSound(counts: Map<string, number>, key: string, start: number, end: number): void {
  const id = `${key}|${start}|${end}`;
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

function matchesSounds(expected: Map<string, number>, actual: readonly Sound[]): boolean {
  for (const { key, start, end } of actual) {
    const id = `${key}|${start}|${end}`;
    const count = expected.get(id);
    if (count === undefined) return false;
    if (count === 1) expected.delete(id);
    else expected.set(id, count - 1);
  }
  return expected.size === 0;
}

/** Split each original note at the exact edge ticks it crosses. Drum hits are points. */
function splitKeptSound(original: readonly Sound[], split: readonly Sound[], edgeTicks: readonly number[]): boolean {
  const expected = new Map<string, number>();
  for (const sound of original) {
    let start = sound.start;
    for (const edge of edgeTicks) {
      if (start < edge && edge < sound.end) {
        addSound(expected, sound.key, start, edge);
        start = edge;
      }
    }
    addSound(expected, sound.key, start, sound.end);
  }
  return matchesSounds(expected, split);
}

/**
 * Shift both endpoints by the region's tick offset. A duplicated region is
 * listed twice; a deleted region is omitted.
 */
function soundOnlyMoved(before: readonly Sound[], after: readonly Sound[], regions: readonly Region[]): boolean {
  const expected = new Map<string, number>();
  for (const { key, start, end } of before) {
    for (const [from, to, shift] of regions) {
      if (from <= start && start < to) addSound(expected, key, start + shift, end + shift);
    }
  }
  return matchesSounds(expected, after);
}

/**
 * The edited project, or the original with a reason when the result leaves the
 * clip domain, would not pass validateProject, or the sound changed: cutting at
 * `edges` (beats) must keep `project`'s sound, and the result must sound like
 * `split` moved by `regions`.
 */
function checked(
  project: Project,
  split: Project,
  result: Project,
  trackIds: ReadonlySet<string>,
  edges: readonly number[],
  regions: readonly Region[],
): SectionEditResult {
  if (!allInDomain(result, trackIds)) return fail(project, 'outsideClipDomain');
  if (validateProject(result).errors.length > 0) return fail(project, 'invalidResult');
  const splitSounds = soundingTicks(split);
  if (split.tracks !== project.tracks && !splitKeptSound(soundingTicks(project), splitSounds, edges.map(beatTick))) {
    return fail(project, 'soundChanged');
  }
  if (!soundOnlyMoved(splitSounds, soundingTicks(result), regions)) return fail(project, 'soundChanged');
  return { ok: true, project: result };
}

/** A section's bars and ticks within the song. */
type SectionRange = { section: Section; endBar: number; bars: number; start: number; end: number };

/**
 * The section's bars, cut at the song end, with its beats and ticks. Fails for a
 * section with a non-integer or negative start or length (saved files hold only
 * whole bars) or one that starts at or after the song end.
 */
function sectionRange(project: Project, section: Section | undefined): SectionRange | SectionEditFailure {
  if (!section) return 'missingSection';
  const { startBar, lengthBars } = section;
  const wholeBars = Number.isInteger(startBar) && Number.isInteger(lengthBars) && startBar >= 0 && lengthBars >= 1;
  if (!wholeBars || startBar >= project.lengthBars) return 'invalidSectionRange';
  const bpb = beatsPerBar(project.timeSignature);
  const endBar = Math.min(startBar + lengthBars, project.lengthBars);
  return { section, endBar, bars: endBar - startBar, start: startBar * bpb, end: endBar * bpb };
}

/** Clips the edit touches: those that end after `fromTick` or start there or later, and start before `toTick`. */
function touches(clip: Clip, fromTick: number, toTick: number): boolean {
  const [s, e] = clipTickSpan(clip.startBeat, clip.lengthBeats);
  return (e > fromTick || s >= fromTick) && s < toTick;
}

/** Ids of the tracks the edit touches, or undefined when one of them holds a clip outside the clip domain. */
function touchedTracks(project: Project, fromTick: number, toTick: number): Set<string> | undefined {
  const ids = new Set<string>();
  for (const track of project.tracks) {
    if (!track.clips.some((c) => touches(c, fromTick, toTick))) continue;
    if (!track.clips.every(inClipDomain)) return undefined;
    ids.add(track.id);
  }
  return ids;
}

const allInDomain = (project: Project, trackIds: ReadonlySet<string>) =>
  project.tracks.every((t) => !trackIds.has(t.id) || t.clips.every(inClipDomain));

/**
 * Cut every clip and chord that crosses one of `beats` there. Clips are cut by
 * splitClip; a clip it refuses, or cuts elsewhere (a drum clip off the step
 * grid), makes the whole edit fail.
 */
function splitAt(project: Project, beats: readonly number[], clock: Clock): Project | SectionEditFailure {
  let next = project;
  for (const beat of beats) {
    const at = beatTick(beat);
    const crosses = (start: number, length: number) => {
      const [s, e] = clipTickSpan(start, length);
      return s < at && at < e;
    };
    for (;;) {
      const clip = next.tracks.flatMap((t) => t.clips).find((c) => crosses(c.startBeat, c.lengthBeats));
      if (!clip) break;
      // Splitting a link source keeps its whole content on the left for the links and copies the
      // right part, so stored notes would be doubled: refuse it like a link (D4).
      if (next.tracks.some((t) => t.clips.some((c) => c.aliasOf === clip.id))) return 'linkedClip';
      const result = splitClip(next, clip.id, beat, clock);
      if (!result.ok) return result.code === 'loopingClip' || result.code === 'linkedClip' ? result.code : 'cannotSplitClip';
      const left = result.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!;
      if (clipTickSpan(left.startBeat, left.lengthBeats)[1] !== at) return 'cannotSplitClip';
      next = result.project;
    }
    if (next.chordTrack.some((c) => crosses(c.startBeat, c.durationBeats))) {
      const nextId = trackIdAllocator(next);
      const chordTrack = next.chordTrack.flatMap((c): ChordEvent[] =>
        crosses(c.startBeat, c.durationBeats)
          ? [
            { ...c, durationBeats: beat - c.startBeat },
            { ...c, id: nextId('chord'), startBeat: beat, durationBeats: c.startBeat + c.durationBeats - beat },
          ]
          : [c],
      );
      next = { ...next, chordTrack };
    }
  }
  return next;
}

/**
 * Move every clip and chord by `shift(startTick)` beats. Only the region is
 * judged in ticks; positions move by the exact beat amount and are not rounded.
 * A start that would fall before 0 (it was within half a tick before an edge)
 * becomes 0 and keeps its end: a chord loses that sliver of length, and a clip
 * also moves its own notes back by it so every note keeps its tick. A link or a
 * link source cannot move its shared notes, and a looping clip would shift its
 * repeats, so those fail instead.
 */
function shiftContent(project: Project, shift: (startTick: number) => number): Project | SectionEditFailure {
  const sources = new Set(project.tracks.flatMap((t) => t.clips.flatMap((c) => (c.aliasOf === undefined ? [] : [c.aliasOf]))));
  let failed = false;
  const moveClip = (clip: Clip): Clip => {
    const by = shift(beatTick(clip.startBeat));
    if (by === 0) return clip;
    const startBeat = clip.startBeat + by;
    if (startBeat >= 0) return { ...clip, startBeat };
    if (clip.loop || clip.aliasOf !== undefined || sources.has(clip.id)) failed = true;
    const sliver = -startBeat;
    const notes = clip.notes?.map((n) =>
      n.startBeat >= sliver
        ? { ...n, startBeat: n.startBeat - sliver }
        : { ...n, startBeat: 0, durationBeats: n.durationBeats - (sliver - n.startBeat) },
    );
    return { ...clip, startBeat: 0, lengthBeats: clip.lengthBeats - sliver, ...(notes ? { notes } : {}) };
  };
  const moveChord = (chord: ChordEvent): ChordEvent => {
    const by = shift(beatTick(chord.startBeat));
    if (by === 0) return chord;
    const startBeat = chord.startBeat + by;
    return startBeat >= 0 ? { ...chord, startBeat } : { ...chord, startBeat: 0, durationBeats: chord.durationBeats + startBeat };
  };
  const tracks = project.tracks.map((t) => ({ ...t, clips: t.clips.map(moveClip) }));
  if (failed) return 'clipBeforeSongStart';
  return { ...project, tracks, chordTrack: project.chordTrack.map(moveChord) };
}

const inTicks = (beat: number, from: number, to: number) => beatTick(beat) >= beatTick(from) && beatTick(beat) < beatTick(to);

/**
 * Duplicate a section right after itself: the clips (a link stays a link to
 * the same source) and chords in its bars are copied there, everything after
 * it moves back by the section's length, and the song grows by that many bars.
 * A section that spans the insertion point grows with it. Refused when the song
 * would pass maxSongBars.
 */
export function duplicateSection(project: Project, sectionId: string, clock: Clock = systemClock): SectionEditResult {
  const range = sectionRange(project, project.sections.find((s) => s.id === sectionId));
  if (typeof range === 'string') return fail(project, range);
  const { section, endBar, bars, start, end } = range;
  const limit = maxSongBars(project);
  if (project.lengthBars + bars > limit) return fail(project, 'songTooLong', `曲は ${limit} 小節までです。`);
  const tracks = touchedTracks(project, beatTick(start), Infinity);
  if (!tracks) return fail(project, 'outsideClipDomain');
  const split = splitAt(project, [start, end], clock);
  if (typeof split === 'string') return fail(project, split);

  const length = end - start;
  const inside = split.tracks.flatMap((t) => t.clips).filter((c) => inTicks(c.startBeat, start, end));
  const shifted = shiftContent(split, (t) => (t >= beatTick(end) ? length : 0));
  if (typeof shifted === 'string') return fail(project, shifted);
  let next = shifted;
  for (const clip of inside) {
    const mode = clip.aliasOf !== undefined && resolveEditTarget(next, clip.id) ? 'link' : 'copy';
    const startBeat = clip.startBeat + length;
    const copied = duplicateClip(next, clip.id, { mode, startBeat }, clock);
    const track = copied.tracks.find((t) => t.id === clip.trackId);
    if (copied === next || track?.clips.at(-1)?.startBeat !== startBeat) return fail(project, 'outsideClipDomain');
    next = copied;
  }
  const nextId = trackIdAllocator(next);
  const chordTrack = next.chordTrack.flatMap((c) =>
    inTicks(c.startBeat, start, end) ? [c, { ...c, id: nextId('chord'), startBeat: c.startBeat + length }] : [c],
  );
  const sections = next.sections.flatMap((s): Section[] => {
    if (s.id === section.id) {
      return [{ ...s, lengthBars: bars }, { ...s, id: nextId('section'), startBar: endBar, lengthBars: bars }];
    }
    if (s.startBar >= endBar) return [{ ...s, startBar: s.startBar + bars }];
    if (s.startBar + s.lengthBars > endBar) return [{ ...s, lengthBars: s.lengthBars + bars }];
    return [s];
  });
  const result: Project = {
    ...next,
    chordTrack,
    sections,
    lengthBars: project.lengthBars + bars,
    updatedAt: nowIso(clock),
  };
  if (project.loopRange) {
    // A loop that ends where the section ends (such as the section's own loop) keeps its end.
    // When the start moves, the end moves with it.
    const { startBeat, endBeat } = project.loopRange;
    const moveStart = beatTick(startBeat) >= beatTick(end);
    result.loopRange = {
      startBeat: moveStart ? startBeat + length : startBeat,
      endBeat: moveStart || beatTick(endBeat) > beatTick(end) ? endBeat + length : endBeat,
    };
  }
  const [st, et, len] = [beatTick(start), beatTick(end), beatTick(end) - beatTick(start)];
  return checked(project, split, result, tracks, [start, end], [[0, st, 0], [st, et, 0], [st, et, len], [et, Infinity, len]]);
}

/**
 * Swap a section with the one before (`-1`) or after (`1`) it, in start-bar
 * order, together with their clips and chords. Bars between the two stay
 * between them, and the song length is kept. A loop over exactly one of the two
 * sections moves with it. Refused when there is no such section or the two
 * overlap.
 */
export function moveSection(
  project: Project,
  sectionId: string,
  direction: -1 | 1,
  clock: Clock = systemClock,
): SectionEditResult {
  const ordered = [...project.sections].sort((x, y) => x.startBar - y.startBar);
  const index = ordered.findIndex((s) => s.id === sectionId);
  const self = sectionRange(project, ordered[index]);
  if (typeof self === 'string') return fail(project, self);
  const neighborSection = ordered[index + direction];
  if (!neighborSection) return fail(project, 'noNeighbor');
  const neighbor = sectionRange(project, neighborSection);
  if (typeof neighbor === 'string') return fail(project, neighbor);
  const [first, second] = direction < 0 ? [neighbor, self] : [self, neighbor];
  if (first.endBar > second.section.startBar) return fail(project, 'overlappingSections');

  const [a0, a1, b0, b1] = [first.start, first.end, second.start, second.end] as const;
  const tracks = touchedTracks(project, beatTick(a0), beatTick(b1));
  if (!tracks) return fail(project, 'outsideClipDomain');
  const split = splitAt(project, [a0, a1, b0, b1], clock);
  if (typeof split === 'string') return fail(project, split);
  const gapShift = b1 - b0 - (a1 - a0);
  const moved = shiftContent(split, (t) => {
    if (t < beatTick(a0) || t >= beatTick(b1)) return 0;
    if (t < beatTick(a1)) return b1 - a1;
    if (t < beatTick(b0)) return gapShift;
    return a0 - b0;
  });
  if (typeof moved === 'string') return fail(project, moved);
  const sections = moved.sections.map((s): Section => {
    if (s.id === first.section.id) return { ...s, startBar: second.endBar - first.bars, lengthBars: first.bars };
    if (s.id === second.section.id) return { ...s, startBar: first.section.startBar, lengthBars: second.bars };
    if (s.startBar >= first.endBar && s.startBar < second.section.startBar) {
      return { ...s, startBar: s.startBar + second.bars - first.bars };
    }
    return s;
  });
  const result: Project = { ...moved, sections, updatedAt: nowIso(clock) };
  const loop = project.loopRange;
  const loops = (from: number, to: number) =>
    loop !== undefined && beatTick(loop.startBeat) === beatTick(from) && beatTick(loop.endBeat) === beatTick(to);
  if (loops(a0, a1)) result.loopRange = { startBeat: b1 - (a1 - a0), endBeat: b1 };
  else if (loops(b0, b1)) result.loopRange = { startBeat: a0, endBeat: a0 + (b1 - b0) };
  const [t0, t1, t2, t3] = [beatTick(a0), beatTick(a1), beatTick(b0), beatTick(b1)];
  return checked(project, split, result, tracks, [a0, a1, b0, b1], [
    [0, t0, 0], [t0, t1, t3 - t1], [t1, t2, t3 - t2 - (t1 - t0)], [t2, t3, t0 - t2], [t3, Infinity, 0],
  ]);
}

/**
 * Delete a section with the clips and chords in its bars; everything after it
 * moves forward to close the gap and the song shrinks by the removed bars
 * (never below 1 bar, in which case later content stays past the new end).
 * Clips linked to a removed clip keep sounding (see removeClip). Other sections
 * and the loop range lose the removed bars; one left with none is dropped.
 */
export function deleteSection(project: Project, sectionId: string, clock: Clock = systemClock): SectionEditResult {
  const range = sectionRange(project, project.sections.find((s) => s.id === sectionId));
  if (typeof range === 'string') return fail(project, range);
  const { section, endBar, bars, start, end } = range;
  const tracks = touchedTracks(project, beatTick(start), Infinity);
  if (!tracks) return fail(project, 'outsideClipDomain');
  const split = splitAt(project, [start, end], clock);
  if (typeof split === 'string') return fail(project, split);

  const lengthBars = Math.max(1, project.lengthBars - bars);
  const barShift = lengthBars - project.lengthBars;
  const beatShift = barShift * beatsPerBar(project.timeSignature);
  let next = split;
  for (const clip of split.tracks.flatMap((t) => t.clips)) {
    if (inTicks(clip.startBeat, start, end)) next = removeClip(next, clip.id, clock);
  }
  next = { ...next, chordTrack: next.chordTrack.filter((c) => !inTicks(c.startBeat, start, end)) };
  const shifted = shiftContent(next, (t) => (t >= beatTick(end) ? beatShift : 0));
  if (typeof shifted === 'string') return fail(project, shifted);
  next = shifted;

  const mapBar = (bar: number) => (bar <= section.startBar ? bar : bar >= endBar ? bar + barShift : section.startBar);
  const sections = next.sections.flatMap((s): Section[] => {
    if (s.id === section.id) return [];
    const startBar = mapBar(s.startBar);
    const length = mapBar(s.startBar + s.lengthBars) - startBar;
    return length > 0 ? [{ ...s, startBar, lengthBars: length }] : [];
  });
  const result: Project = { ...next, sections, lengthBars, updatedAt: nowIso(clock) };
  if (project.loopRange) {
    const mapBeat = (beat: number) =>
      beatTick(beat) <= beatTick(start) ? beat : beatTick(beat) >= beatTick(end) ? Math.max(0, beat + beatShift) : start;
    const loopStart = mapBeat(project.loopRange.startBeat);
    const loopEnd = mapBeat(project.loopRange.endBeat);
    // Both ends move by the same amount; a range kept apart in beats is kept even within one tick.
    if (loopEnd > loopStart) result.loopRange = { startBeat: loopStart, endBeat: loopEnd };
    else delete result.loopRange;
  }
  return checked(project, split, result, tracks, [start, end], [[0, beatTick(start), 0], [beatTick(end), Infinity, beatTick(beatShift)]]);
}
