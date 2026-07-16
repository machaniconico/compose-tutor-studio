import { describe, expect, it } from 'vitest';
import {
  AudioResourceReservationError,
  HeavyAudioResourceReservationLedger,
  checkedHeavyAudioResourceTotal,
} from '../src/audio/audioResourceReservation';

describe('heavy audio resource reservations', () => {
  it('reserves atomically and leaves the ledger unchanged after rejection', () => {
    const ledger = new HeavyAudioResourceReservationLedger(100);
    const first = ledger.reserve(60);

    expect(() => ledger.reserve(41)).toThrow(AudioResourceReservationError);
    expect(ledger.reservedBytes).toBe(60);
    expect(first.bytes).toBe(60);
    first.release();
    expect(ledger.reservedBytes).toBe(0);
  });

  it('atomically resizes and releases idempotently', () => {
    const ledger = new HeavyAudioResourceReservationLedger(100);
    const first = ledger.reserve(40);
    const second = ledger.reserve(30);

    expect(() => first.resize(71)).toThrow(AudioResourceReservationError);
    expect(ledger.reservedBytes).toBe(70);
    expect(first.bytes).toBe(40);
    second.release();
    first.resize(100);
    expect(ledger.reservedBytes).toBe(100);
    first.release();
    first.release();
    expect(ledger.reservedBytes).toBe(0);
  });

  it('fails invalid and overflowing arithmetic closed', () => {
    expect(() => checkedHeavyAudioResourceTotal([
      Number.MAX_SAFE_INTEGER,
      1,
    ])).toThrow(AudioResourceReservationError);
    expect(() => new HeavyAudioResourceReservationLedger(100).reserve(-1))
      .toThrow(AudioResourceReservationError);
  });
});
