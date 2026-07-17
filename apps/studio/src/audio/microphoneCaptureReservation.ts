import { getAudioAssetPlaybackCache } from './audioAssetResolver';
import {
  checkedHeavyAudioResourceTotal,
  reserveHeavyAudioResources,
  type HeavyAudioResourceReservation,
} from './audioResourceReservation';
import { MICROPHONE_CAPTURE_RESERVATION_BYTES } from './microphoneCapture';

/**
 * Reserve the complete capture-phase peak, including decoded buffers that an
 * active playback lease still owns. Unleased cache entries are evicted first.
 */
export function reserveMicrophoneCaptureResources(): HeavyAudioResourceReservation {
  const cache = getAudioAssetPlaybackCache();
  cache.clearUnused();
  return reserveHeavyAudioResources(
    checkedHeavyAudioResourceTotal([
      MICROPHONE_CAPTURE_RESERVATION_BYTES,
      cache.retainedDecodedBytes,
    ]),
  );
}
