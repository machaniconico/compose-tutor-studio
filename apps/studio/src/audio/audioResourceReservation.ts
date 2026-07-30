/** One process-level ceiling shared by import, live playback, and WAV export. */
export const MAX_HEAVY_AUDIO_RESOURCE_BYTES = 384 * 1024 * 1024;
/** A retained Elastic Audio result is a subset of the shared heavy-audio cap. */
export const MAX_DERIVED_AUDIO_RESOURCE_BYTES = 128 * 1024 * 1024;

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

/**
 * One atomically reserved phase envelope that can lend ownership to allocations
 * which may outlive the operation (for example a retained derived-PCM cache).
 *
 * Claims do not reserve the shared ledger again. While the budget is open,
 * released claim bytes return to its available capacity. Releasing the budget
 * shrinks the ledger reservation to the claims that still own real buffers.
 */
export type HeavyAudioResourceBudget = HeavyAudioResourceReservation & Readonly<{
  readonly availableBytes: number;
  claim: (bytes: number) => HeavyAudioResourceReservation;
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

export function reserveHeavyAudioResourceBudget(
  bytes: number,
): HeavyAudioResourceBudget {
  const backing = sharedHeavyAudioResourceLedger.reserve(bytes);
  let capacityBytes = bytes;
  let claimedBytes = 0;
  let isReleased = false;

  const assertClaimSize = (nextBytes: number): void => {
    if (!Number.isSafeInteger(nextBytes) || nextBytes < 0) {
      throw new AudioResourceReservationError('Heavy audio reservation is invalid.');
    }
  };

  const resizeReleasedBacking = (nextClaimedBytes: number): void => {
    if (nextClaimedBytes === 0) backing.release();
    else backing.resize(nextClaimedBytes);
  };

  return {
    get bytes() {
      return isReleased ? 0 : capacityBytes;
    },
    get released() {
      return isReleased;
    },
    get availableBytes() {
      return isReleased ? 0 : capacityBytes - claimedBytes;
    },
    claim: (bytesToClaim: number): HeavyAudioResourceReservation => {
      if (isReleased) {
        throw new AudioResourceReservationError('Released reservation cannot be claimed.');
      }
      assertClaimSize(bytesToClaim);
      const nextClaimedBytes = checkedHeavyAudioResourceTotal([
        claimedBytes,
        bytesToClaim,
      ]);
      if (nextClaimedBytes > capacityBytes) {
        throw new AudioResourceReservationError(
          'Heavy audio work exceeds its reserved phase budget.',
        );
      }
      claimedBytes = nextClaimedBytes;

      let heldBytes = bytesToClaim;
      let claimReleased = false;
      return {
        get bytes() {
          return heldBytes;
        },
        get released() {
          return claimReleased;
        },
        resize: (nextBytes: number): void => {
          if (claimReleased) {
            throw new AudioResourceReservationError(
              'Released reservation cannot be resized.',
            );
          }
          assertClaimSize(nextBytes);
          const otherClaims = claimedBytes - heldBytes;
          if (!Number.isSafeInteger(otherClaims) || otherClaims < 0) {
            throw new AudioResourceReservationError(
              'Heavy audio reservation budget is inconsistent.',
            );
          }
          const nextTotal = checkedHeavyAudioResourceTotal([otherClaims, nextBytes]);
          if (!isReleased && nextTotal > capacityBytes) {
            throw new AudioResourceReservationError(
              'Heavy audio work exceeds its reserved phase budget.',
            );
          }
          if (isReleased) resizeReleasedBacking(nextTotal);
          claimedBytes = nextTotal;
          heldBytes = nextBytes;
        },
        release: (): void => {
          if (claimReleased) return;
          claimReleased = true;
          const nextTotal = claimedBytes - heldBytes;
          if (!Number.isSafeInteger(nextTotal) || nextTotal < 0) {
            throw new AudioResourceReservationError(
              'Heavy audio reservation budget is inconsistent.',
            );
          }
          if (isReleased) resizeReleasedBacking(nextTotal);
          claimedBytes = nextTotal;
          heldBytes = 0;
        },
      };
    },
    resize: (nextBytes: number): void => {
      if (isReleased) {
        throw new AudioResourceReservationError('Released reservation cannot be resized.');
      }
      assertClaimSize(nextBytes);
      if (nextBytes < claimedBytes) {
        throw new AudioResourceReservationError(
          'Heavy audio budget cannot discard active allocation ownership.',
        );
      }
      backing.resize(nextBytes);
      capacityBytes = nextBytes;
    },
    release: (): void => {
      if (isReleased) return;
      isReleased = true;
      capacityBytes = 0;
      resizeReleasedBacking(claimedBytes);
    },
  };
}

/** Diagnostic/test visibility without exposing a reset that production can misuse. */
export function getReservedHeavyAudioResourceBytes(): number {
  return sharedHeavyAudioResourceLedger.reservedBytes;
}

/** Reserve a derived PCM allocation while enforcing its independent 128 MiB cap. */
export function reserveDerivedAudioResources(bytes: number): HeavyAudioResourceReservation {
  if (
    !Number.isSafeInteger(bytes)
    || bytes < 0
    || bytes > MAX_DERIVED_AUDIO_RESOURCE_BYTES
  ) {
    throw new AudioResourceReservationError(
      'Derived audio exceeds its 128 MiB memory limit.',
    );
  }
  return reserveHeavyAudioResources(bytes);
}
