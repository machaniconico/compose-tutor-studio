export const SUPPORT_OPEN_EVENT = 'cts:support-open';

type SupportEventTarget = Pick<EventTarget, 'addEventListener' | 'dispatchEvent' | 'removeEventListener'>;

function defaultTarget(): SupportEventTarget | null {
  if (typeof window === 'undefined') return null;
  return window;
}

export function requestSupportMenuOpen(target: SupportEventTarget | null = defaultTarget()): boolean {
  if (!target || typeof Event === 'undefined') return false;
  return target.dispatchEvent(new Event(SUPPORT_OPEN_EVENT));
}

export function listenForSupportMenuOpen(
  listener: () => void,
  target: SupportEventTarget | null = defaultTarget(),
): () => void {
  if (!target) return () => {};
  const handleOpen = (): void => listener();
  target.addEventListener(SUPPORT_OPEN_EVENT, handleOpen);
  return () => target.removeEventListener(SUPPORT_OPEN_EVENT, handleOpen);
}
