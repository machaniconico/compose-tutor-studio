import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { findGlossaryEntry, segmentGlossaryText } from '../tutorial/glossary';

/** 語と説明の隙間(px)。CSS 側の `.term__tip::before` の当たり判定と揃える。 */
const TIP_GAP = 4;
/** 画面端から最低限空ける余白(px)。 */
const VIEWPORT_MARGIN = 8;

type Rect = { left: number; top: number; width: number; height: number };
export type TipPlacement = { left: number; top: number; above: boolean };

/**
 * 語の矩形と説明の大きさから、説明を画面内に収める位置を決める(純粋関数)。
 * 横は画面端で止め、下に入り切らず上に入るときだけ上へ反転する。
 */
export function placeTooltip(
  anchor: Rect,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): TipPlacement {
  const maxLeft = viewport.width - VIEWPORT_MARGIN - tip.width;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, maxLeft));
  const below = anchor.top + anchor.height + TIP_GAP;
  const fitsBelow = below + tip.height <= viewport.height - VIEWPORT_MARGIN;
  const aboveTop = anchor.top - TIP_GAP - tip.height;
  const fitsAbove = aboveTop >= VIEWPORT_MARGIN;
  if (!fitsBelow && fitsAbove) return { left, top: aboveTop, above: true };
  return { left, top: below, above: false };
}

/**
 * 本文中の用語。ホバーとキーボードフォーカスで、現在の難易度に合う説明を表示する。
 * 説明は body 直下に描画し(パネルの overflow で切れないように)、画面内に収まる位置へ置く。
 * Escape で閉じる(ホバーだけで開いたときも、どこにフォーカスがあっても閉じる)。
 * 用語集にない id のときは子要素をそのまま表示する。
 */
export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const tipId = useId();
  const difficulty = useStore((s) => s.editor.difficulty);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [placement, setPlacement] = useState<TipPlacement | null>(null);
  const termRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const entry = findGlossaryEntry(id);
  const open = entry !== undefined && (hover || focus);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = () => {
      const term = termRef.current;
      const tip = tipRef.current;
      if (!term || !tip) return;
      const a = term.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      setPlacement(
        placeTooltip(
          { left: a.left, top: a.top, width: a.width, height: a.height },
          { width: t.width, height: t.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, difficulty]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      setHover(false);
      setFocus(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!entry) return <>{children}</>;

  return (
    <span
      ref={termRef}
      className="term"
      tabIndex={0}
      aria-describedby={tipId}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
    >
      {children ?? entry.label}
      {open
        ? createPortal(
            <span
              ref={tipRef}
              role="tooltip"
              id={tipId}
              className={placement?.above ? 'term__tip term__tip--above' : 'term__tip'}
              style={
                placement
                  ? { left: placement.left, top: placement.top }
                  : { left: 0, top: 0, visibility: 'hidden' }
              }
            >
              <strong>{entry.label}</strong>
              {entry.description[difficulty]}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/** 地の文の中の用語を見つけて Term で包む。 */
export function TermText({ text }: { text: string }) {
  return (
    <>
      {segmentGlossaryText(text).map((segment, i) =>
        typeof segment === 'string' ? (
          segment
        ) : (
          <Term key={i} id={segment.id}>
            {segment.text}
          </Term>
        ),
      )}
    </>
  );
}
