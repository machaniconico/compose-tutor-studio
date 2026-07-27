import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../src/state/store';
import {
  registerRecordingLatencyCalibrationInvalidation,
} from '../src/state/recordingLatencyCalibrationLifecycle';

describe('recording latency calibration lifecycle', () => {
  beforeEach(() => {
    useStore.setState({
      recordingLatencyCalibration: Object.freeze({
        inputDeviceId: 'usb-loopback',
        contextGeneration: 7,
        sampleRate: 48_000,
        latencyFrames: 2_400,
        confidence: 0.94,
      }),
      recordingLatencyCompensationMode: 'calibrated',
      preferredMicrophoneInputDeviceId: 'usb-loopback',
      audioRecordingOperationId: null,
    });
  });

  it('invalidates future takes without revoking an active take token', () => {
    useStore.setState({ audioRecordingOperationId: 91 });
    const subscription: { onDeviceChange?: () => void } = {};
    const cleanup = registerRecordingLatencyCalibrationInvalidation((listener) => {
      subscription.onDeviceChange = listener;
      return () => undefined;
    });

    const onDeviceChange = subscription.onDeviceChange;
    if (!onDeviceChange) throw new Error('devicechange listener missing');
    onDeviceChange();

    expect(useStore.getState().recordingLatencyCalibration).toBeNull();
    expect(useStore.getState().recordingLatencyCompensationMode).toBe('estimated');
    expect(useStore.getState().audioRecordingOperationId).toBe(91);
    useStore.setState({ audioRecordingOperationId: null });
    cleanup();
  });

  it('invalidates a profile while no recording dialog is mounted', () => {
    const subscription: { onDeviceChange?: () => void } = {};
    const unsubscribe = vi.fn();
    const cleanup = registerRecordingLatencyCalibrationInvalidation((listener) => {
      subscription.onDeviceChange = listener;
      return unsubscribe;
    });

    const onDeviceChange = subscription.onDeviceChange;
    if (!onDeviceChange) throw new Error('devicechange listener missing');
    onDeviceChange();

    expect(useStore.getState().recordingLatencyCalibration).toBeNull();
    expect(useStore.getState().recordingLatencyCompensationMode).toBe('estimated');
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('degrades safely when the host cannot subscribe', () => {
    const cleanup = registerRecordingLatencyCalibrationInvalidation(() => {
      throw new Error('unsupported');
    });

    expect(cleanup).not.toThrow();
  });
});
