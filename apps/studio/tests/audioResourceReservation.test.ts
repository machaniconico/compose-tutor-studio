import { describe, expect, it } from 'vitest';
import {
  AudioResourceReservationError,
  HeavyAudioResourceReservationLedger,
  MAX_DERIVED_AUDIO_RESOURCE_BYTES,
  checkedHeavyAudioResourceTotal,
  getReservedHeavyAudioResourceBytes,
  reserveDerivedAudioResources,
  reserveHeavyAudioResourceBudget,
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

  it('enforces the derived subset cap in the shared ledger', () => {
    expect(() => reserveDerivedAudioResources(MAX_DERIVED_AUDIO_RESOURCE_BYTES + 1))
      .toThrow(AudioResourceReservationError);
    const reservation = reserveDerivedAudioResources(16);
    expect(reservation.bytes).toBe(16);
    reservation.release();
  });

  it('lends one phase envelope without double-reserving child ownership', () => {
    const baseline = getReservedHeavyAudioResourceBytes();
    const budget = reserveHeavyAudioResourceBudget(100);
    const retained = budget.claim(60);

    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline + 100);
    expect(budget.availableBytes).toBe(40);
    retained.resize(30);
    expect(budget.availableBytes).toBe(70);
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline + 100);

    budget.release();
    expect(budget.released).toBe(true);
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline + 30);
    retained.release();
    retained.release();
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline);
  });

  it('rejects a claim one byte beyond the atomically reserved envelope', () => {
    const baseline = getReservedHeavyAudioResourceBytes();
    const budget = reserveHeavyAudioResourceBudget(100);
    const first = budget.claim(60);

    expect(() => budget.claim(41)).toThrow(AudioResourceReservationError);
    expect(budget.availableBytes).toBe(40);
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline + 100);
    first.release();
    budget.release();
    expect(getReservedHeavyAudioResourceBytes()).toBe(baseline);
  });
});
