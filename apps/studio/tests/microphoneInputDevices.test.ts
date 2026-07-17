import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MICROPHONE_INPUT_DEVICES,
  MAX_MICROPHONE_INPUT_DEVICE_ID_LENGTH,
  MAX_MICROPHONE_INPUT_DEVICE_LABEL_CODE_POINTS,
  MicrophoneInputDeviceError,
  enumerateMicrophoneInputDevices,
  subscribeToMicrophoneInputDeviceChanges,
  type MicrophoneInputDevicePlatform,
} from '../src/audio/microphoneInputDevices';

function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label: string,
): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId: '',
    toJSON: () => ({ kind, deviceId, label, groupId: '' }),
  };
}

function createPlatform(devices: readonly MediaDeviceInfo[] = []) {
  const target = new EventTarget();
  const enumerateDevices = vi.fn(async () => [...devices]);
  const addEventListener = vi.spyOn(target, 'addEventListener');
  const removeEventListener = vi.spyOn(target, 'removeEventListener');
  const mediaDevices = {
    enumerateDevices,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as NonNullable<MicrophoneInputDevicePlatform['mediaDevices']>;
  const platform: MicrophoneInputDevicePlatform = { mediaDevices };
  return {
    platform,
    enumerateDevices,
    addEventListener,
    removeEventListener,
    emitDeviceChange: () => target.dispatchEvent(new Event('devicechange')),
  };
}

describe('microphone input device enumeration', () => {
  it('keeps unique audio inputs in host order and supplies blank-label fallbacks', async () => {
    const harness = createPlatform([
      device('videoinput', 'camera', 'Camera'),
      device('audioinput', 'default', '  Built-in Mic  '),
      device('audiooutput', 'speakers', 'Speakers'),
      device('audioinput', 'usb', '   '),
      device('audioinput', 'usb', 'Duplicate USB Mic'),
      device('audioinput', '', ''),
    ]);

    await expect(enumerateMicrophoneInputDevices(harness.platform)).resolves.toEqual([
      { deviceId: 'default', label: 'Built-in Mic' },
      { deviceId: 'usb', label: 'マイク 2' },
      { deviceId: '', label: 'マイク 3' },
    ]);
    expect(harness.enumerateDevices).toHaveBeenCalledTimes(1);
  });

  it('returns a fresh empty list when no audio inputs are visible', async () => {
    const harness = createPlatform([device('audiooutput', 'speaker', 'Speaker')]);

    await expect(enumerateMicrophoneInputDevices(harness.platform)).resolves.toEqual([]);
  });

  it('can enumerate when the host does not expose devicechange events', async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [device('audioinput', 'legacy-mic', 'Legacy Mic')]),
    } as unknown as NonNullable<MicrophoneInputDevicePlatform['mediaDevices']>;

    await expect(enumerateMicrophoneInputDevices({ mediaDevices })).resolves.toEqual([
      { deviceId: 'legacy-mic', label: 'Legacy Mic' },
    ]);
    expect(() => subscribeToMicrophoneInputDeviceChanges(vi.fn(), { mediaDevices }))
      .toThrow(new MicrophoneInputDeviceError('unsupported'));
  });

  it('bounds host-provided device identities, labels and list size', async () => {
    const devices = Array.from({ length: MAX_MICROPHONE_INPUT_DEVICES + 5 }, (_, index) =>
      device('audioinput', `microphone-${index}`, `M${'🎙️'.repeat(300)}`));
    devices.unshift(device(
      'audioinput',
      'x'.repeat(MAX_MICROPHONE_INPUT_DEVICE_ID_LENGTH + 1),
      'ignored',
    ));
    const harness = createPlatform(devices);
    const result = await enumerateMicrophoneInputDevices(harness.platform);

    expect(result).toHaveLength(MAX_MICROPHONE_INPUT_DEVICES);
    expect(result.some((entry) => entry.label === 'ignored')).toBe(false);
    expect(Array.from(result[0]?.label ?? '')).toHaveLength(
      MAX_MICROPHONE_INPUT_DEVICE_LABEL_CODE_POINTS,
    );
  });

  it('reports unsupported and enumeration failures with typed errors', async () => {
    await expect(enumerateMicrophoneInputDevices({ mediaDevices: null })).rejects.toEqual(
      new MicrophoneInputDeviceError('unsupported'),
    );

    const harness = createPlatform();
    harness.enumerateDevices.mockRejectedValueOnce(new Error('host details must not escape'));
    await expect(enumerateMicrophoneInputDevices(harness.platform)).rejects.toEqual(
      new MicrophoneInputDeviceError('enumeration-failed'),
    );
  });
});

describe('microphone input device change subscription', () => {
  it('notifies changes and removes the exact listener idempotently', () => {
    const harness = createPlatform();
    const onChange = vi.fn();
    const unsubscribe = subscribeToMicrophoneInputDeviceChanges(onChange, harness.platform);

    expect(harness.addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
    harness.emitDeviceChange();
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    expect(harness.removeEventListener).toHaveBeenCalledTimes(1);
    expect(harness.removeEventListener).toHaveBeenCalledWith(
      'devicechange',
      harness.addEventListener.mock.calls[0]?.[1],
    );
    harness.emitDeviceChange();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('rejects subscription when MediaDevices is unavailable', () => {
    expect(() => subscribeToMicrophoneInputDeviceChanges(vi.fn(), { mediaDevices: null }))
      .toThrow(new MicrophoneInputDeviceError('unsupported'));
  });

  it('maps a host listener failure without exposing the host error', () => {
    const harness = createPlatform();
    harness.addEventListener.mockImplementationOnce(() => {
      throw new Error('host details must not escape');
    });

    expect(() => subscribeToMicrophoneInputDeviceChanges(vi.fn(), harness.platform))
      .toThrow(new MicrophoneInputDeviceError('subscription-failed'));
  });
});
