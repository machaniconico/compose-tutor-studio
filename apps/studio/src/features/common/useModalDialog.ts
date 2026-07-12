import { useEffect, useRef } from 'react';
import { registerDialog } from './dialogState';

const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type ModalDialogOptions = Readonly<{
  /** Controlled overlays can keep the hook mounted while rendering nothing. */
  open?: boolean;
  /** Called for Escape while the dialog is active. */
  onEscape?: () => void;
  /** Locks Escape during an atomic operation. */
  escapeDisabled?: boolean;
  /** Common dialogs restore their trigger; custom handoffs can manage focus themselves. */
  restoreFocus?: boolean;
}>;

type InertLease = {
  count: number;
  originallyInert: boolean;
};

const inertLeases = new WeakMap<HTMLElement, InertLease>();

function acquireInert(element: HTMLElement): void {
  const lease = inertLeases.get(element);
  if (lease) {
    lease.count += 1;
    return;
  }
  inertLeases.set(element, {
    count: 1,
    originallyInert: element.hasAttribute('inert'),
  });
  element.setAttribute('inert', '');
}

function releaseInert(element: HTMLElement): void {
  const lease = inertLeases.get(element);
  if (!lease) return;
  lease.count -= 1;
  if (lease.count > 0) return;
  inertLeases.delete(element);
  if (!lease.originallyInert) element.removeAttribute('inert');
}

function isVisible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    element.getClientRects().length > 0
  );
}

function tabbableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && isVisible(element),
  );
}

function focusInitialElement(dialog: HTMLElement): void {
  const requested = dialog.querySelector<HTMLElement>('[data-modal-initial-focus]');
  if (requested && requested.tabIndex >= 0 && isVisible(requested)) {
    requested.focus({ preventScroll: true });
    return;
  }
  const first = tabbableElements(dialog)[0];
  (first ?? dialog).focus({ preventScroll: true });
}

/**
 * Make every sibling branch outside the modal inert, even when the modal is
 * rendered deep inside a toolbar instead of through a portal.
 */
function makeBackgroundInert(dialog: HTMLElement): () => void {
  const changed = new Set<HTMLElement>();
  const appRoot = dialog.closest<HTMLElement>('.app-shell');
  const isolateCurrentSiblings = (): void => {
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (
          !(sibling instanceof HTMLElement) ||
          sibling === branch ||
          changed.has(sibling) ||
          sibling.matches('[data-modal-layer]') ||
          sibling.querySelector('[data-modal-layer]')
        ) {
          continue;
        }
        changed.add(sibling);
        acquireInert(sibling);
      }
      if (parent === appRoot || parent === document.body) break;
      branch = parent;
    }
  };

  isolateCurrentSiblings();
  const observer =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => isolateCurrentSiblings());
  observer?.observe(appRoot ?? document.body, { childList: true, subtree: true });

  return () => {
    observer?.disconnect();
    for (const element of changed) releaseInert(element);
  };
}

/** Shared modal focus lifecycle for the common Dialog and onboarding overlay. */
export function useModalDialog(options: ModalDialogOptions = {}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onEscapeRef = useRef(options.onEscape);
  const escapeDisabledRef = useRef(options.escapeDisabled ?? false);
  onEscapeRef.current = options.onEscape;
  escapeDisabledRef.current = options.escapeDisabled ?? false;

  const open = options.open ?? true;
  const restoreFocus = options.restoreFocus ?? true;

  useEffect(() => {
    if (!open || typeof document === 'undefined' || typeof window === 'undefined') return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const registration = registerDialog();
    const restoreBackground = makeBackgroundInert(dialog);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!registration.isTopmost()) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (!escapeDisabledRef.current) onEscapeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const tabbable = tabbableElements(dialog);
      if (tabbable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1];
      const active = document.activeElement;
      const activeIsTabbable = active instanceof HTMLElement && tabbable.includes(active);
      if (event.shiftKey && (active === first || !activeIsTabbable)) {
        event.preventDefault();
        last?.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !activeIsTabbable)) {
        event.preventDefault();
        first?.focus({ preventScroll: true });
      }
    };

    const onFocusIn = (event: FocusEvent): void => {
      if (!registration.isTopmost()) return;
      if (!dialog.isConnected || dialog.contains(event.target as Node)) return;
      focusInitialElement(dialog);
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    focusInitialElement(dialog);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      restoreBackground();
      registration.unregister();
      if (restoreFocus && previousFocus?.isConnected && !previousFocus.closest('[inert]')) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open, restoreFocus]);

  return dialogRef;
}
