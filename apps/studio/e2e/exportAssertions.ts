import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

function ascii(bytes: Uint8Array, offset: number, length = 4): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export async function expectValidMidiFile(path: string): Promise<void> {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  expect(bytes.byteLength).toBeGreaterThan(22);
  expect(ascii(bytes, 0)).toBe('MThd');
  expect(view.getUint32(4, false)).toBe(6);
  expect(view.getUint16(10, false)).toBeGreaterThan(0);
  expect(ascii(bytes, 14)).toBe('MTrk');
}

export async function expectValidWavFile(path: string, sampleRate?: number): Promise<void> {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  expect(bytes.byteLength).toBeGreaterThan(44);
  expect(ascii(bytes, 0)).toBe('RIFF');
  expect(ascii(bytes, 8)).toBe('WAVE');
  expect(ascii(bytes, 12)).toBe('fmt ');
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBeGreaterThan(0);
  expect(view.getUint32(24, true)).toBeGreaterThan(0);
  if (sampleRate !== undefined) expect(view.getUint32(24, true)).toBe(sampleRate);
  expect(ascii(bytes, 36)).toBe('data');
  expect(view.getUint32(4, true) + 8).toBe(bytes.byteLength);
  expect(view.getUint32(40, true)).toBeGreaterThan(0);
}
