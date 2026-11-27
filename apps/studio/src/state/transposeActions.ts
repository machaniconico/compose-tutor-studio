import { findChordTrack, beatToBarPosition, compileMusicalTime, pitchClassNumber, realizeChordTrack, type ChordEvent, type MusicalKey, type Project, type ScaleName, type Track } from '@cts/project-model';
import { midiToNoteName, noteNameToPitchClass, transposeChordSymbol } from '@cts/theory-engine';
import { KEY_OPTIONS } from '../features/transport/keyOptions';
import { respellChordSymbol, scaleIsMinor } from './keySpelling';
import { buildScheduleEvents, type SchedulePayload } from '../audio/events';
import { useStore } from './store';

/** 移調できる範囲(半音)。 */
export const TRANSPOSE_MIN_SEMITONES = -12;
export const TRANSPOSE_MAX_SEMITONES = 12;

export const TRANSPOSE_AUDIO_NOTE =
  '録音した音声(オーディオクリップ)の高さは変わりません。ドラムも動きません。';

export type TransposeSongResult =
  | Readonly<{ ok: true; changed: boolean; project: Project; key: MusicalKey }>
  | Readonly<{ ok: false; reason: string }>;

function refuse(reason: string): TransposeSongResult {
  return { ok: false, reason };
}

/** ドラム以外の音程トラックだけが移調の対象。ドラムは型と楽器から導く。 */
function isPitchedTrack(track: Track): boolean {
  return track.type === 'instrument' && track.instrument?.type !== 'drumkit';
}

function safeText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '(不明)';
  }
}

function errorText(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string' && error.message !== '') {
      return error.message;
    }
  } catch {
    // fall through to the generic reason
  }
  return 'コードを読み取れないため、移調できません。';
}

/**
 * The key name after moving `semitones`, chosen from the keys the selector
 * offers. An octave move keeps the key as it is. Null when no offered key has
 * the target tonic.
 */
export function transposedKeyName(project: Project, semitones: number): MusicalKey | null {
  if (semitones % 12 === 0) return project.key;
  try {
    const pc = (((noteNameToPitchClass(safeText(project.key)) + semitones) % 12) + 12) % 12;
    return KEY_OPTIONS.find((k) => noteNameToPitchClass(k) === pc) ?? null;
  } catch {
    return null;
  }
}

function chordBar(project: Project, chord: ChordEvent): number {
  try {
    return beatToBarPosition(compileMusicalTime(project), chord.startBeat).bar + 1;
  } catch {
    return 1;
  }
}

function moveChord(
  project: Project,
  chord: ChordEvent,
  semitones: number,
  key: MusicalKey,
  scale: ScaleName,
): ChordEvent | string {
  try {
    const octave = semitones % 12 === 0;
    const absolute = chord.notes.some((n) => n > 11);
    let notes: number[];
    if (absolute) {
      notes = chord.notes.map((n) => n + semitones);
      if (notes.some((n) => !Number.isInteger(n) || n < 0 || n > 127)) {
        return 'コードの構成音が MIDI 0〜127 の範囲を外れてしまうため、移調できません。';
      }
      if (!notes.some((n) => n > 11)) {
        return `${chordBar(project, chord)}小節目のコード「${safeText(chord.symbol)}」は低すぎて音の高さが保てません(移調すると構成音がすべて 0〜11 になり、音名だけの記録として読まれて音域が変わります)。下げる幅を小さくしてください。`;
      }
    } else {
      const shift = ((semitones % 12) + 12) % 12;
      notes = chord.notes.map((n) => (n + shift) % 12);
    }
    // An octave move leaves the symbol exactly as written; root is always read from the symbol.
    if (octave) {
      const root = /^[A-G][#b]?/.exec(chord.symbol.trim())?.[0];
      if (root === undefined) return `「${safeText(chord.symbol)}」はコード名として読み取れません。`;
      return { ...chord, root, notes };
    }
    const spelled = respellChordSymbol(
      transposeChordSymbol(chord.symbol, semitones, `${key} ${scaleIsMinor(scale) ? 'minor' : 'major'}`),
      key,
      scale,
    );
    // degree / function / tags are key-relative labels: they stay as they are.
    return { ...chord, symbol: spelled.symbol, root: spelled.root, notes };
  } catch (error) {
    return errorText(error);
  }
}

/**
 * After the edit the schedule may differ from before only by pitch, exactly:
 * authored notes on pitched tracks move by `semitones`, absolute chord notes
 * by `semitones`, pitch-class chord backing keeps main's voicing (root pitch
 * class + 48, so it moves by the wrapped root shift), everything else stays.
 */
function schedulePostConditionHolds(before: Project, after: Project, semitones: number): boolean {
  try {
    const pitched = new Set(before.tracks.filter(isPitchedTrack).map((t) => t.id));
    const a = buildScheduleEvents(before);
    const b = buildScheduleEvents(after);
    if (a.length !== b.length) return false;
    const realized = realizeChordTrack(before);
    const chordTrackId = realized?.track.id ?? null;
    const chordsById = new Map(before.chordTrack.map((c) => [c.id, c]));
    const shift = ((semitones % 12) + 12) % 12;
    let chordIndex = 0;
    return a.every((x, i) => {
      const y = b[i]!;
      const px = x.payload as SchedulePayload;
      const py = y.payload as SchedulePayload;
      if (x.beat !== y.beat || px.kind !== py.kind) return false;
      if (px.kind === 'drum' || py.kind === 'drum') return JSON.stringify(px) === JSON.stringify(py);
      const delta = py.pitch - px.pitch;
      let expected = pitched.has(px.trackId) ? semitones : 0;
      if (px.trackId === chordTrackId && realized !== null) {
        const chord = chordsById.get(realized.notes[chordIndex]?.chordId ?? '');
        chordIndex += 1;
        if (!chord) return false;
        if (chord.notes.some((n) => n > 11)) {
          expected = semitones;
        } else {
          const root = pitchClassNumber(chord.root);
          expected = ((root + shift) % 12) - root;
        }
      }
      return (
        px.trackId === py.trackId
        && px.durationBeats === py.durationBeats
        && px.velocity === py.velocity
        && py.pitch >= 0
        && py.pitch <= 127
        && delta === expected
      );
    });
  } catch {
    return false;
  }
}

/**
 * Move every pitched note and chord symbol by `semitones` and the key with them.
 * Pure. Drum tracks, drum clips and audio clips are returned untouched. The
 * whole move is refused (same project, Japanese reason) when any note would
 * leave MIDI 0..127; nothing is ever applied partially.
 */
export function transposeProjectBySemitones(project: Project, semitones: number): TransposeSongResult {
  if (
    typeof semitones !== 'number'
    || !Number.isInteger(semitones)
    || semitones < TRANSPOSE_MIN_SEMITONES
    || semitones > TRANSPOSE_MAX_SEMITONES
  ) {
    return refuse('移調できるのは、半音で -12 から +12 までの整数です。');
  }
  if (semitones === 0) return { ok: true, changed: false, project, key: project.key };

  const key = transposedKeyName(project, semitones);
  if (key === null) {
    return refuse(
      `キー「${safeText(project.key)}」を${semitones}半音動かしたキーは、キー選択に用意されていないため移調できません。`,
    );
  }
  const chordTrackSource = findChordTrack(project);
  if (project.chordTrack.length > 0 && chordTrackSource?.instrument?.type === 'drumkit') {
    return refuse('コードを鳴らすトラックがドラムの音になっています。先にそのトラックを楽器の音色に切り替えてから移調してください。');
  }

  const offending: { lowest: number | null; highest: number | null } = { lowest: null, highest: null };
  const tracks = project.tracks.map((track) => {
    if (!isPitchedTrack(track)) return track;
    return {
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.aliasOf !== undefined || clip.type !== 'midi' || !clip.notes) return clip;
        return {
          ...clip,
          notes: clip.notes.map((note) => {
            const pitch = note.pitch + semitones;
            if (pitch < 0 && (offending.lowest === null || note.pitch < offending.lowest)) offending.lowest = note.pitch;
            if (pitch > 127 && (offending.highest === null || note.pitch > offending.highest)) offending.highest = note.pitch;
            return { ...note, pitch };
          }),
        };
      }),
    };
  });
  if (offending.highest !== null) {
    return refuse(
      `いちばん高い音(${midiToNoteName(offending.highest)})を ${semitones} 半音上げると MIDI 127 を超えるため、この高さには移調できません。上げる幅を小さくしてください。`,
    );
  }
  if (offending.lowest !== null) {
    return refuse(
      `いちばん低い音(${midiToNoteName(offending.lowest)})を ${-semitones} 半音下げると MIDI 0 より下がるため、この高さには移調できません。下げる幅を小さくしてください。`,
    );
  }

  const chordTrack: ChordEvent[] = [];
  for (const chord of project.chordTrack) {
    const moved = moveChord(project, chord, semitones, key, project.scale);
    if (typeof moved === 'string') return refuse(moved);
    chordTrack.push(moved);
  }

  const next: Project = { ...project, key, tracks, chordTrack };
  if (!schedulePostConditionHolds(project, next, semitones)) {
    return refuse('移調すると音の高さ以外(鳴る位置や長さ、ドラムの音)まで変わってしまうため、移調を取りやめました。');
  }
  return { ok: true, changed: true, project: next, key };
}

/** Transpose the open song as exactly one undo step. */
export function transposeSong(semitones: number): TransposeSongResult {
  const state = useStore.getState();
  if (state.audioRecordingOperationId !== null) {
    return refuse('録音中は移調できません。録音を止めてから移調してください。');
  }
  if (state.projectOperationBusy) {
    return refuse('プロジェクトを開いている途中のため、今は移調できません。');
  }
  const snapshot = state.project;
  const result = transposeProjectBySemitones(snapshot, semitones);
  if (!result.ok || !result.changed) return result;
  const applied = state.applyProjectChange((current) => (current === snapshot ? result.project : current));
  if (!applied || useStore.getState().project === snapshot) {
    return refuse('今は移調を反映できませんでした。曲はそのままです。もう一度お試しください。');
  }
  return result;
}
