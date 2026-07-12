import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

type TabKeyEvent = ReactKeyboardEvent<HTMLButtonElement>;

/**
 * Apply the WAI-ARIA automatic-activation keyboard pattern to a horizontal
 * tablist. The destination tab is selected before focus moves to its button.
 */
export function handleTabKeyDown<T extends string>(
  event: TabKeyEvent,
  tabs: readonly T[],
  currentTab: T,
  onSelect: (tab: T) => void,
  tabId: (tab: T) => string,
): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  const currentIndex = tabs.indexOf(currentTab);
  if (currentIndex < 0) return;

  let destinationIndex: number;
  switch (event.key) {
    case 'ArrowLeft':
      destinationIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      break;
    case 'ArrowRight':
      destinationIndex = (currentIndex + 1) % tabs.length;
      break;
    case 'Home':
      destinationIndex = 0;
      break;
    case 'End':
      destinationIndex = tabs.length - 1;
      break;
    default:
      return;
  }

  const destination = tabs[destinationIndex];
  if (destination === undefined) return;

  event.preventDefault();
  onSelect(destination);
  event.currentTarget.ownerDocument.getElementById(tabId(destination))?.focus();
}
