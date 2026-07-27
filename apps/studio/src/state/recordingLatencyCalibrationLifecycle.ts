import { subscribeToMicrophoneInputDeviceChanges } from '../audio/microphoneInputDevices';
import { useStore } from './store';

export type MicrophoneDeviceChangeSubscriber = (
  onChange: () => void,
) => () => void;

/**
 * Invalidates device-bound loopback evidence for the whole app lifetime.
 *
 * A current take owns an immutable latency policy, so clearing this runtime
 * profile affects future takes. If capture has not bound its clock yet, its
 * frozen policy no longer matches and the take fails closed.
 */
export function registerRecordingLatencyCalibrationInvalidation(
  subscribe: MicrophoneDeviceChangeSubscriber =
    subscribeToMicrophoneInputDeviceChanges,
): () => void {
  try {
    return subscribe(() => {
      useStore.getState().clearRecordingLatencyCalibration();
    });
  } catch {
    // Hosts without devicechange still support explicit input selection.
    // Output-route changes remain covered by the mandatory recalibration copy.
    return () => undefined;
  }
}
