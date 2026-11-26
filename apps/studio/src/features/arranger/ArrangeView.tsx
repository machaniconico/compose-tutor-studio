import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { beatsPerBar, moveClip, resizeClip, type Clip, type Project, type Track } from '@cts/project-model';
import { useStore, watchDragEnd } from '../../state/store';
import { findShortcut } from '../../state/keymap';
import {
  addEmptyClipAt,
  duplicateClipInSong,
  openClipInEditor,
  removeClipFromSong,
  splitClipAtBeat,
} from '../../state/editorActions';
import { isAnyDialogOpen } from '../common/dialogState';
import { pxPerBeat } from '../timeline';
import { Playhead, TimelineRuler } from '../transport/TimelineRuler';
import { MAX_LENGTH_BARS } from '../transport/TransportBar';
import {
  barStartAtX,
  canSplitAt,
  dropStartBeat,
  nextClipStart,
  resizedLengthBeats,
  withSongLength,
} from './arrangeMath';

const DRAG_START_PX = 4;

type ClipDrag = {
  kind: 'move' | 'resize';
  clipId: string;
  owner: EventTarget;
  pointerId: number;
  started: boolean;
  originX: number;
  originStart: number;
  originLength: number;
};

type ClipMenu = { clipId: string; x: number; y: number };

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function clipLabel(track: Track, clip: Clip, bpb: number): string {
  const startBar = Math.floor(clip.startBeat / bpb) + 1;
  const bars = Math.round((clip.lengthBeats / bpb) * 100) / 100;
  const link = clip.aliasOf ? '(リンク)' : '';
  return `${track.name}のクリップ${link}: ${startBar}小節目から${bars}小節`;
}

/**
 * Song overview: every track's clips on one bar grid. Drag a clip to move it,
 * drag its right edge to change its length, double-click it to edit it, and
 * double-click an empty spot for a new 1-bar clip. Split / duplicate / delete
 * act on the selected clip from the toolbar, the right-click menu or keys.
 */
export function ArrangeView() {
  const project = useStore((s) => s.project);
  const zoomX = useStore((s) => s.editor.zoomX);
  const selectedClipId = useStore((s) => s.editor.selectedClipId);
  const positionBeat = useStore((s) => s.transport.positionBeat);
  const [menu, setMenu] = useState<ClipMenu | null>(null);
  const drag = useRef<ClipDrag | null>(null);

  const bpb = beatsPerBar(project.timeSignature);
  const ppb = pxPerBeat(zoomX);
  const barPx = bpb * ppb;
  const clipEnd = Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => c.startBeat + c.lengthBeats)));
  const laneWidth = Math.max(project.lengthBars * bpb, clipEnd) * ppb;
  const selected = project.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId) ?? null;
  const splitEnabled = canSplitAt(project, selected?.id ?? null, positionBeat);

  const select = (clip: Clip) => {
    const store = useStore.getState();
    store.selectTrack(clip.trackId);
    store.selectClip(clip.id);
  };

  // --- keyboard shortcuts (ignored while typing or with a dialog open) ---
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isAnyDialogOpen()) return;
      const action = findShortcut('arrange', e);
      if (!action || !selected) return;
      e.preventDefault();
      if (action === 'duplicateClip') duplicateClipInSong(selected.id, 'copy', MAX_LENGTH_BARS);
      else if (action === 'deleteClip') removeClipFromSong(selected.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // The right-click menu closes on Escape or a press anywhere outside it.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.arrange__menu')) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [menu]);

  const startDrag = (e: ReactPointerEvent<HTMLElement>, clip: Clip, kind: ClipDrag['kind']) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    select(clip);
    const owner = e.currentTarget;
    owner.setPointerCapture?.(e.pointerId);
    drag.current = {
      kind,
      clipId: clip.id,
      owner,
      pointerId: e.pointerId,
      started: false,
      originX: e.clientX,
      originStart: clip.startBeat,
      originLength: clip.lengthBeats,
    };
  };

  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.owner !== e.currentTarget || current.pointerId !== e.pointerId) return;
    const store = useStore.getState();
    const deltaX = e.clientX - current.originX;
    if (!current.started) {
      if (Math.abs(deltaX) <= DRAG_START_PX) return;
      store.beginTransaction(current.owner);
      watchDragEnd(current.owner, current.pointerId);
      current.started = true;
    } else if (!store.ownsTransaction(current.owner)) {
      drag.current = null;
      return;
    }
    const deltaBeats = deltaX / ppb;
    const track = store.project.tracks.find((t) => t.clips.some((c) => c.id === current.clipId));
    const clip = track?.clips.find((c) => c.id === current.clipId);
    if (!track || !clip) return;
    // The song grows with the clip during the drag (so it stays audible) and
    // shrinks back if the clip returns; a spot past the longest song is refused.
    const floorBars = store.transactionBase?.lengthBars ?? store.project.lengthBars;
    const apply = (next: Project, clipEndBeat: number) => {
      const fitted = withSongLength(next, clipEndBeat, MAX_LENGTH_BARS, floorBars);
      if (fitted) store.applyProjectChange(() => fitted);
    };
    if (current.kind === 'move') {
      const start = dropStartBeat(store.project, clip.id, current.originStart + deltaBeats, bpb);
      if (start !== clip.startBeat) apply(moveClip(store.project, clip.id, start), start + clip.lengthBeats);
    } else {
      const length = resizedLengthBeats(
        clip.startBeat,
        clip.startBeat + current.originLength + deltaBeats,
        nextClipStart(track.clips, clip),
      );
      if (length !== clip.lengthBeats) apply(resizeClip(store.project, clip.id, length), clip.startBeat + length);
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.owner !== e.currentTarget || current.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.type === 'lostpointercapture' && current.started) {
      useStore.getState().cancelTransaction(current.owner);
    }
  };

  const onLaneDoubleClick = (e: ReactMouseEvent<HTMLDivElement>, track: Track) => {
    if (e.target !== e.currentTarget) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    addEmptyClipAt(track.id, barStartAtX(x, ppb, bpb), MAX_LENGTH_BARS);
  };

  const runMenu = (action: 'copy' | 'link' | 'delete') => {
    if (!menu) return;
    if (action === 'delete') removeClipFromSong(menu.clipId);
    else duplicateClipInSong(menu.clipId, action, MAX_LENGTH_BARS);
    setMenu(null);
  };

  return (
    <div className="arrange">
      <div className="arrange__toolbar" role="toolbar" aria-label="クリップの操作">
        <strong>曲全体</strong>
        <button
          type="button"
          disabled={!splitEnabled}
          onClick={() => selected && splitClipAtBeat(selected.id, positionBeat)}
          title="選んだクリップを再生ヘッドの位置で 2 つに分けます"
        >
          分割
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && duplicateClipInSong(selected.id, 'copy', MAX_LENGTH_BARS)}
          title="中身ごと別のクリップとしてすぐ後ろに複製します。あとで片方だけ書き換えられます"
        >
          複製(コピー)
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && duplicateClipInSong(selected.id, 'link', MAX_LENGTH_BARS)}
          title={selected?.type === 'midi'
            ? '同じ中身を鳴らすクリップをすぐ後ろに置きます。編集するときは、複製したクリップをダブルクリックして「元のクリップを開く」を押します'
            : '同じ中身を鳴らすクリップをすぐ後ろに置きます。どちらかを書き換えると両方が変わります'}
        >
          複製(リンク)
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && removeClipFromSong(selected.id)}
          title="選んだクリップを消します"
        >
          削除
        </button>
      </div>

      <div className="arrange__scroll">
        <div className="arrange__ruler-row">
          <div className="arrange__corner" />
          <TimelineRuler />
        </div>
        <div className="arrange__rows">
          <div className="arrange__names">
            {project.tracks.map((track) => (
              <div key={track.id} className="arrange__name" title={track.name}>
                {track.name}
              </div>
            ))}
          </div>
          <div className="arrange__lanes" style={{ width: laneWidth }}>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className="arrange__lane"
                data-testid={`arrange-lane-${track.id}`}
                style={{ backgroundSize: `${barPx}px 100%` }}
                onDoubleClick={(e) => onLaneDoubleClick(e, track)}
              >
                {track.clips.map((clip) => (
                  <div
                    key={clip.id}
                    role="button"
                    tabIndex={0}
                    data-testid={`clip-${clip.id}`}
                    aria-label={clipLabel(track, clip, bpb)}
                    aria-pressed={clip.id === selectedClipId}
                    className={`arrange__clip is-${clip.type}${clip.id === selectedClipId ? ' is-selected' : ''}${
                      clip.aliasOf ? ' is-linked' : ''
                    }`}
                    style={{ left: clip.startBeat * ppb, width: clip.lengthBeats * ppb }}
                    onPointerDown={(e) => startDrag(e, clip, 'move')}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={endDrag}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      select(clip);
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      openClipInEditor(clip.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      select(clip);
                      setMenu({ clipId: clip.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="arrange__clip-name">{clip.aliasOf ? 'リンク' : track.name}</span>
                    <span
                      className="arrange__clip-resize"
                      aria-hidden="true"
                      onPointerDown={(e) => startDrag(e, clip, 'resize')}
                      onPointerMove={onDragMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      onLostPointerCapture={endDrag}
                    />
                  </div>
                ))}
              </div>
            ))}
            <Playhead ppb={ppb} />
          </div>
        </div>
      </div>

      <p className="empty-hint">
        クリップはドラッグで移動、右端のドラッグで長さを変えられます。ダブルクリックで中身を編集する画面が開き、空いている所をダブルクリックすると
        1 小節の空のクリップができます。右クリックで複製や削除もできます。
      </p>

      {menu ? (
        <div className="arrange__menu" role="menu" aria-label="クリップのメニュー" style={{ left: menu.x, top: menu.y }}>
          <button type="button" role="menuitem" onClick={() => runMenu('copy')}>
            複製(コピー)
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu('link')}>
            複製(リンク)
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu('delete')}>
            削除
          </button>
        </div>
      ) : null}
    </div>
  );
}
