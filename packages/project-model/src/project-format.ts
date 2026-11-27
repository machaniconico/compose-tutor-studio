export const LEGACY_WAVE5_FORMAT_MESSAGE =
  'このファイルは開発中の別バージョンで保存されたため、このアプリではまだ開けません。元のファイルはそのまま残っています。';

const MAIN_V3_REQUIRED_KEYS = [
  'lengthBeats',
  'tempoMap',
  'timeSignatureMap',
  'audioAssets',
  'automationLanes',
] as const;

/** Distinguish the two v3 formats by their own required fields. */
export function detectProjectFormat(raw: unknown): 'main' | 'wave5-v3' | 'invalid-project' {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'main';
    if ((raw as Record<string, unknown>).schemaVersion !== 3) return 'main';

    const present = MAIN_V3_REQUIRED_KEYS.filter((key) => Object.hasOwn(raw, key)).length;
    if (present === MAIN_V3_REQUIRED_KEYS.length) return 'main';
    return present === 0 ? 'wave5-v3' : 'invalid-project';
  } catch {
    // Property access and own-key checks can run traps on untrusted objects.
    return 'invalid-project';
  }
}
