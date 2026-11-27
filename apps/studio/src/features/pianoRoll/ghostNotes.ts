// ピアノロールのゴーストノート(表示専用)。ほかのクリップ・トラックのノートを
// 編集中クリップの座標(クリップ先頭からの拍)に直して返す。純粋関数で、store にも React にも依存しない。
// ループ・リンクは再生と同じ解決(resolveClipContent / visitMidiClipNoteOccurrences)を使う。
// 描画数は MAX_GHOST_NOTES で打ち切る(巨大な曲でもピアノロールが重くならない)。

import {
  buildClipIndex,
  resolveClipContent,
  midiClipNaturalPatternLength,
  type Project,
} from '@cts/project-model';

export const MAX_GHOST_NOTES = 2000;

export type GhostNote = Readonly<{
  key: string;
  pitch: number;
  /** 窓(編集中クリップ)の先頭からの拍。窓の内側に切ってある。 */
  startBeat: number;
  durationBeats: number;
}>;

export function collectGhostNotes(
  project: Project,
  viewedClipId: string,
  viewedStartBeat: number,
  viewedLengthBeats: number,
  lowMidi: number,
  highMidi: number,
  cap: number = MAX_GHOST_NOTES,
): GhostNote[] {
  const out: GhostNote[] = [];
  if (!(viewedLengthBeats > 0) || !Number.isFinite(viewedStartBeat)) return out;
  const clipIndex = buildClipIndex(project);
  for (const track of project.tracks) {
    if (track.type === 'master') continue;
    for (const clip of track.clips) {
      if (clip.id === viewedClipId || out.length >= cap) continue;
      const effective = resolveClipContent(project, clip, clipIndex);
      if (!effective || effective.type !== 'midi' || !effective.notes?.length) continue;
      const clipStart = effective.startBeat;
      // 編集窓をクリップ内の座標にして、窓に掛かる回だけを数える(全体を数える打ち切りは使わない)。
      const winStart = viewedStartBeat - clipStart;
      const winEnd = winStart + viewedLengthBeats;
      const period = effective.loop ? midiClipNaturalPatternLength(effective.notes) : 0;
      const emit = (id: string, repeat: number, pitch: number, localStart: number, duration: number) => {
        const from = Math.max(localStart, winStart);
        const to = Math.min(localStart + duration, winEnd);
        if (!(to > from)) return;
        out.push({
          key: `${clip.id}:${id}:${repeat}`,
          pitch,
          startBeat: from - winStart,
          durationBeats: to - from,
        });
      };
      for (const note of effective.notes) {
        if (out.length >= cap) break;
        if (note.pitch < lowMidi || note.pitch > highMidi) continue;
        if (!Number.isFinite(note.startBeat) || note.startBeat < 0) continue;
        if (!Number.isFinite(note.durationBeats) || note.durationBeats <= 0) continue;
        if (!(period > 0)) {
          emit(note.id, 0, note.pitch, note.startBeat, note.durationBeats);
          continue;
        }
        let repeat = Math.max(0, Math.floor((winStart - note.startBeat - note.durationBeats) / period));
        for (; out.length < cap; repeat += 1) {
          const localStart = note.startBeat + repeat * period;
          if (localStart >= winEnd || localStart >= effective.lengthBeats) break;
          emit(note.id, repeat, note.pitch, localStart, Math.min(note.durationBeats, effective.lengthBeats - localStart));
        }
      }
    }
  }
  return out;
}
