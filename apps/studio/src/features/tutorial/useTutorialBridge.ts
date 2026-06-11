// React hook bridging components to the tutorial bridge's external store.

import { useSyncExternalStore } from 'react';
import { getBridgeSnapshot, subscribeBridge } from '../../state/tutorialBridge';

/** Subscribe a component to the live tutorial bridge snapshot. */
export function useTutorialBridge() {
  return useSyncExternalStore(subscribeBridge, getBridgeSnapshot, getBridgeSnapshot);
}
