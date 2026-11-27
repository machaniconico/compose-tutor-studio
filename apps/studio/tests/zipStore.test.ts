import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertZipStoreFits, crc32, zipStore } from '../src/features/export/zipStore';

const utf8 = new TextEncoder();

/** Read stored files via the central directory and independently verify their local entries. */
function readZip(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const word = (offset: number) => view.getUint16(offset, true);
  const dword = (offset: number) => view.getUint32(offset, true);
  const bytes = (offset: number, size: number) => new Uint8Array(buffer, offset, size);
  const decode = (offset: number, size: number) => new TextDecoder('utf-8', { fatal: true }).decode(bytes(offset, size));
  const end = buffer.byteLength - 22;
  expect(dword(end)).toBe(0x06054b50);
  expect(word(end + 4)).toBe(0);
  expect(word(end + 6)).toBe(0);
  expect(word(end + 20)).toBe(0);
  const count = word(end + 10);
  expect(word(end + 8)).toBe(count);
  const centralSize = dword(end + 12);
  let central = dword(end + 16);
  expect(central + centralSize).toBe(end);

  const files = new Map<string, Uint8Array>();
  let expectedLocal = 0;
  for (let index = 0; index < count; index += 1) {
    expect(dword(central)).toBe(0x02014b50);
    expect(bytes(central + 4, 2)).toEqual(Uint8Array.of(0x14, 0x03)); // Unix ZIP 2.0
    expect(word(central + 8)).toBe(1 << 11);
    expect(word(central + 10)).toBe(0);
    expect(bytes(central + 38, 4)).toEqual(Uint8Array.of(0, 0, 0xa4, 0x81)); // Mode 0100644
    const nameSize = word(central + 28);
    const name = decode(central + 46, nameSize);
    const size = dword(central + 20);
    const crc = dword(central + 16);
    expect(dword(central + 24)).toBe(size);
    const local = dword(central + 42);
    expect(local).toBe(expectedLocal);
    expect(dword(local)).toBe(0x04034b50);
    expect(word(local + 6)).toBe(1 << 11);
    expect(word(local + 8)).toBe(0);
    expect(dword(local + 14)).toBe(crc);
    expect(dword(local + 18)).toBe(size);
    expect(dword(local + 22)).toBe(size);
    expect(word(local + 26)).toBe(nameSize);
    expect(decode(local + 30, nameSize)).toBe(name);
    const start = local + 30 + nameSize + word(local + 28);
    const data = bytes(start, size);
    // Bit-by-bit CRC oracle. The writer uses a lookup table.
    let state = 0xffffffff;
    for (const byte of data) {
      state ^= byte;
      for (let bit = 0; bit < 8; bit += 1) state = (state >>> 1) ^ (state & 1 ? 0xedb88320 : 0);
    }
    expect((~state) >>> 0).toBe(crc);

    files.set(name, data);
    expectedLocal = start + size;
    central += 46 + nameSize + word(central + 30) + word(central + 32);
  }
  expect(expectedLocal).toBe(dword(end + 16));
  expect(central).toBe(end);
  return files;
}

describe('stored ZIP', () => {
  it('matches the CRC32 check value for abc', () => {
    expect(crc32(utf8.encode('abc'))).toBe(0x352441c2);
  });

  it('round-trips two files through both headers with UTF-8 names and matching CRCs', async () => {
    const entries = [
      { name: '鍵盤.wav', data: utf8.encode('abc') },
      { name: 'room.wav', data: Uint8Array.of(0, 1, 5, 255, 7) },
    ];
    const files = entries.map(({ name, data }) => ({ name, byteLength: data.length }));
    const zip = await zipStore(files, async (_file, index) => entries[index]!.data.buffer);
    expect(zip.type).toBe('application/zip');
    expect(readZip(await zip.arrayBuffer())).toEqual(new Map(entries.map(({ name, data }) => [name, data])));
  });

  const unzipError = spawnSync('unzip', ['-v']).error;
  const unzipMissing = unzipError && 'code' in unzipError && unzipError.code === 'ENOENT';
  const unzipTestName = 'lists 鍵盤.wav correctly with unzip -l';
  it(unzipMissing ? `${unzipTestName} (skipped: unzip is missing from PATH)` : unzipTestName, async ({ skip }) => {
    if (unzipMissing) skip();

    const directory = await mkdtemp(join(tmpdir(), 'cts-zip-'));
    try {
      const data = utf8.encode('abc');
      const archive = await zipStore([{ name: '鍵盤.wav', byteLength: data.length }], async () => data.buffer);
      const path = join(directory, 'stems.zip');
      await writeFile(path, new Uint8Array(await archive.arrayBuffer()));
      const output = execFileSync('unzip', ['-l', path], { encoding: 'utf8' });
      expect(output).toMatch(/鍵盤\.wav\s*$/m);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects oversized archives before requesting any file content', async () => {
    const files = [
      { name: '鍵盤.wav', byteLength: 0x80000000 },
      { name: 'ベース.wav', byteLength: 0x7ffffffe },
    ];
    expect(() => assertZipStoreFits(files)).toThrow(/約 4 GB/);
    await expect(zipStore(files, async () => { throw new Error('unexpected render'); })).rejects.toThrow(/約 4 GB/);
  });
});
