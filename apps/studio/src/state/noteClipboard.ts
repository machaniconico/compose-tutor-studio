// ピアノロールのノート用クリップボード(アプリ内だけ)。
//
// OS のクリップボードは権限が要るので使わない。中身は音の高さ・強さと、
// いちばん早い音からの相対位置(整数 tick)だけで、プロジェクトやクリップ、
// ノートの ID は持たない。だから別の曲を開いても、そのまま貼り付けられる。

import { useSyncExternalStore } from 'react';

export type ClipboardNote = Readonly<{
  pitch: number;
  /** いちばん早い音の開始からの位置(整数 tick、PPQ 480)。 */
  offsetTicks: number;
  durationTicks: number;
  velocity: number;
}>;

export type NoteClipboard = Readonly<{
  /** コピーした時の、いちばん早い音のクリップ内位置(整数 tick)。 */
  originTicks: number;
  notes: readonly ClipboardNote[];
}>;

let current: NoteClipboard | null = null;
const listeners = new Set<() => void>();

export function getNoteClipboard(): NoteClipboard | null {
  return current;
}

export function setNoteClipboard(next: NoteClipboard | null): void {
  current = next === null
    ? null
    : Object.freeze({
      originTicks: next.originTicks,
      notes: Object.freeze(next.notes.map((note) => Object.freeze({ ...note }))),
    });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React から読むときのフック。 */
export function useNoteClipboard(): NoteClipboard | null {
  return useSyncExternalStore(subscribe, getNoteClipboard, getNoteClipboard);
}
