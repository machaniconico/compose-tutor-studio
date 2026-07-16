/** One process-level ceiling shared by import, live playback, and WAV export. */
export const MAX_HEAVY_AUDIO_RESOURCE_BYTES = 384 * 1024 * 1024;

export class AudioResourceReservationError extends Error {
  readonly code = 'resource-limit' as const;

  constructor(message = 'Heavy audio work exceeds the shared memory limit.') {
    super(message);
    this.name = 'AudioResourceReservationError';
  }
}

export type HeavyAudioResourceReservation = Readonly<{
  /** Current amount held by this operation. */
  readonly bytes: number;
  readonly released: boolean;
  /** Atomically replace this operation's amount without releasing its place. */
  resize: (nextBytes: number) => void;
  /** Idempotent. */
  release: () => void;
}>;

/** Checked arithmetic used before mutating the shared ledger. */
export function checkedHeavyAudioResourceTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (
      !Number.isSafeInteger(value)
      || value < 0
      || total > Number.MAX_SAFE_INTEGER - value
    ) {
      throw new AudioResourceReservationError('Heavy audio resource arithmetic overflowed.');
    }
    total += value;
  }
  return total;
}

/**
 * Synchronous reservation ledger. JavaScript run-to-completion makes each
 * reserve/resize operation atomic with respect to competing async workflows.
 */
export class HeavyAudioResourceReservationLedger {
  private reserved = 0;

  constructor(readonly limitBytes = MAX_HEAVY_AUDIO_RESOURCE_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new AudioResourceReservationError('Heavy audio limit is invalid.');
    }
  }

  get reservedBytes(): number {
    return this.reserved;
  }

  reserve(bytes: number): HeavyAudioResourceReservation {
    const nextTotal = checkedHeavyAudioResourceTotal([this.reserved, bytes]);
    if (nextTotal > this.limitBytes) throw new AudioResourceReservationError();
    this.reserved = nextTotal;

    let heldBytes = bytes;
    let isReleased = false;
    return {
      get bytes() {
        return heldBytes;
      },
      get released() {
        return isReleased;
      },
      resize: (nextBytes: number): void => {
        if (isReleased) {
          throw new AudioResourceReservationError('Released reservation cannot be resized.');
        }
        if (!Number.isSafeInteger(nextBytes) || nextBytes < 0) {
          throw new AudioResourceReservationError('Heavy audio reservation is invalid.');
        }
        const otherReservations = this.reserved - heldBytes;
        if (!Number.isSafeInteger(otherReservations) || otherReservations < 0) {
          throw new AudioResourceReservationError('Heavy audio reservation ledger is inconsistent.');
        }
        const resizedTotal = checkedHeavyAudioResourceTotal([
          otherReservations,
          nextBytes,
        ]);
        if (resizedTotal > this.limitBytes) throw new AudioResourceReservationError();
        this.reserved = resizedTotal;
        heldBytes = nextBytes;
      },
      release: (): void => {
        if (isReleased) return;
        isReleased = true;
        this.reserved -= heldBytes;
        heldBytes = 0;
        if (!Number.isSafeInteger(this.reserved) || this.reserved < 0) {
          // Fail closed for subsequent work even if an impossible invariant is
          // violated; never manufacture additional capacity.
          this.reserved = this.limitBytes;
        }
      },
    };
  }
}

const sharedHeavyAudioResourceLedger = new HeavyAudioResourceReservationLedger();

export function reserveHeavyAudioResources(bytes: number): HeavyAudioResourceReservation {
  return sharedHeavyAudioResourceLedger.reserve(bytes);
}

/** Diagnostic/test visibility without exposing a reset that production can misuse. */
export function getReservedHeavyAudioResourceBytes(): number {
  return sharedHeavyAudioResourceLedger.reservedBytes;
}
