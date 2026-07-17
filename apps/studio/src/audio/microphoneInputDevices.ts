export type MicrophoneInputDevice = Readonly<{
  deviceId: string;
  label: string;
}>;

export const MAX_MICROPHONE_INPUT_DEVICES = 64;
export const MAX_MICROPHONE_INPUT_DEVICE_ID_LENGTH = 1_024;
export const MAX_MICROPHONE_INPUT_DEVICE_LABEL_CODE_POINTS = 256;

export type MicrophoneInputDeviceErrorCode =
  | 'unsupported'
  | 'enumeration-failed'
  | 'subscription-failed';

export class MicrophoneInputDeviceError extends Error {
  constructor(readonly code: MicrophoneInputDeviceErrorCode) {
    super(code);
    this.name = 'MicrophoneInputDeviceError';
  }
}

type InputDeviceMediaDevices = Pick<
  MediaDevices,
  'enumerateDevices' | 'addEventListener' | 'removeEventListener'
>;

/** Browser access seam. Tests and non-browser hosts can provide their own implementation. */
export type MicrophoneInputDevicePlatform = Readonly<{
  mediaDevices: InputDeviceMediaDevices | null;
}>;

function browserPlatform(): MicrophoneInputDevicePlatform {
  const mediaDevices = typeof navigator === 'undefined'
    ? null
    : navigator.mediaDevices ?? null;
  return { mediaDevices };
}

function enumerationMediaDevices(
  platform: MicrophoneInputDevicePlatform,
): InputDeviceMediaDevices {
  const mediaDevices = platform.mediaDevices;
  if (
    !mediaDevices ||
    typeof mediaDevices.enumerateDevices !== 'function'
  ) {
    throw new MicrophoneInputDeviceError('unsupported');
  }
  return mediaDevices;
}

function subscriptionMediaDevices(
  platform: MicrophoneInputDevicePlatform,
): InputDeviceMediaDevices {
  const mediaDevices = platform.mediaDevices;
  if (
    !mediaDevices
    || typeof mediaDevices.addEventListener !== 'function'
    || typeof mediaDevices.removeEventListener !== 'function'
  ) {
    throw new MicrophoneInputDeviceError('unsupported');
  }
  return mediaDevices;
}

/**
 * Lists the currently visible audio inputs without inventing a default device.
 * Device identifiers are opaque; the first occurrence wins if a host returns duplicates.
 */
export async function enumerateMicrophoneInputDevices(
  platform: MicrophoneInputDevicePlatform = browserPlatform(),
): Promise<readonly MicrophoneInputDevice[]> {
  const mediaDevices = enumerationMediaDevices(platform);
  let devices: readonly MediaDeviceInfo[];
  try {
    devices = await mediaDevices.enumerateDevices();
  } catch {
    throw new MicrophoneInputDeviceError('enumeration-failed');
  }

  const seenDeviceIds = new Set<string>();
  const inputs: MicrophoneInputDevice[] = [];
  for (const device of devices) {
    if (inputs.length >= MAX_MICROPHONE_INPUT_DEVICES) break;
    if (
      device.kind !== 'audioinput'
      || device.deviceId.length > MAX_MICROPHONE_INPUT_DEVICE_ID_LENGTH
      || seenDeviceIds.has(device.deviceId)
    ) continue;
    seenDeviceIds.add(device.deviceId);
    const fallbackIndex = inputs.length + 1;
    const label = Array.from(device.label.trim())
      .slice(0, MAX_MICROPHONE_INPUT_DEVICE_LABEL_CODE_POINTS)
      .join('');
    inputs.push({
      deviceId: device.deviceId,
      label: label.length > 0 ? label : `マイク ${fallbackIndex}`,
    });
  }
  return inputs;
}

/** Subscribes to host device-list changes. The caller decides how and when to re-enumerate. */
export function subscribeToMicrophoneInputDeviceChanges(
  onChange: () => void,
  platform: MicrophoneInputDevicePlatform = browserPlatform(),
): () => void {
  const mediaDevices = subscriptionMediaDevices(platform);
  const listener = (): void => onChange();
  try {
    mediaDevices.addEventListener('devicechange', listener);
  } catch {
    throw new MicrophoneInputDeviceError('subscription-failed');
  }

  let subscribed = true;
  return (): void => {
    if (!subscribed) return;
    subscribed = false;
    try {
      mediaDevices.removeEventListener('devicechange', listener);
    } catch {
      // The subscription is locally retired even if a host tears down during cleanup.
    }
  };
}
