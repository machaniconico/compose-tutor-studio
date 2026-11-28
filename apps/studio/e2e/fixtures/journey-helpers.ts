import { expect, type Download, type Page } from '@playwright/test';

/**
 * Wait for the app shell, dismiss the welcome dialog when it appears (bounded
 * wait: it is absent when onboarding was already completed), then start a
 * blank project.
 */
export async function startBlankProject(page: Page): Promise<void> {
  await page.goto('/');
  const projectMenu = page.getByRole('button', { name: '☰ プロジェクト', exact: true });
  await expect(projectMenu).toBeVisible();
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  const shown = await welcome.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false);
  if (shown) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
    await expect(welcome).toBeHidden();
  }
  await projectMenu.click();
  await page.getByRole('dialog', { name: 'プロジェクト', exact: true })
    .locator('button.template-card--blank').click();
  await expect(page.getByRole('textbox', { name: 'プロジェクト名', exact: true })).toHaveValue('新しい曲');
}

export async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  frames: number;
  /** Raw little-endian PCM payload. */
  data: Buffer;
}

/** Minimal RIFF/WAVE reader. Throws on a malformed header or chunk. */
export function parseWav(wav: Buffer): WavInfo {
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
  // RIFF chunk size covers everything after the 8-byte RIFF header.
  expect(wav.readUInt32LE(4), 'RIFF chunk size = file length - 8').toBe(wav.length - 8);
  let format: (Pick<WavInfo, 'sampleRate' | 'channels' | 'bitsPerSample'> & { blockAlign: number }) | null = null;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > wav.length) throw new Error('WAV chunk runs past the end of the file');
    if (id === 'fmt ') {
      format = {
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bitsPerSample: wav.readUInt16LE(body + 14),
        blockAlign: wav.readUInt16LE(body + 12),
      };
      expect(wav.readUInt32LE(body + 8), 'byte rate').toBe(wav.readUInt32LE(body + 4) * wav.readUInt16LE(body + 12));
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data chunk precedes fmt chunk');
      const frameBytes = format.channels * (format.bitsPerSample / 8);
      expect(format.blockAlign).toBe(frameBytes);
      // The data chunk is the last chunk: its declared size reaches the end of the file.
      expect(body + size + (size % 2), 'data chunk size matches the file').toBe(wav.length);
      expect(size % frameBytes, 'whole PCM frames').toBe(0);
      const { blockAlign: _blockAlign, ...fields } = format;
      return { ...fields, dataBytes: size, frames: size / frameBytes, data: wav.subarray(body, body + size) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV data chunk missing');
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Reads a stored (method 0) ZIP through the central directory and verifies each
 * entry's CRC-32 and sizes against its local header and payload.
 */
export function readStoredZip(zip: Buffer): ZipEntry[] {
  expect(zip.subarray(0, 2).toString('ascii')).toBe('PK');
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(endOffset + 10);
  let central = zip.readUInt32LE(endOffset + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(central)).toBe(0x02014b50);
    const method = zip.readUInt16LE(central + 10);
    const crc = zip.readUInt32LE(central + 16);
    const compressed = zip.readUInt32LE(central + 20);
    const size = zip.readUInt32LE(central + 24);
    const nameLength = zip.readUInt16LE(central + 28);
    const extraLength = zip.readUInt16LE(central + 30);
    const commentLength = zip.readUInt16LE(central + 32);
    const local = zip.readUInt32LE(central + 42);
    const name = zip.subarray(central + 46, central + 46 + nameLength).toString('utf8');
    expect(method, `${name} is stored`).toBe(0);
    expect(compressed).toBe(size);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    // The local header must agree with the central directory (no data descriptor).
    expect(zip.readUInt16LE(local + 6) & 0x08, `${name} has no data descriptor`).toBe(0);
    expect(zip.readUInt32LE(local + 14), `${name} local CRC-32`).toBe(crc);
    expect(zip.readUInt32LE(local + 18), `${name} local compressed size`).toBe(compressed);
    expect(zip.readUInt32LE(local + 22), `${name} local size`).toBe(size);
    expect(zip.subarray(local + 30, local + 30 + zip.readUInt16LE(local + 26)).toString('utf8'), 'local name').toBe(name);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataStart, dataStart + size);
    expect(data.length, `${name} payload is complete`).toBe(size);
    expect(crc32(data), `${name} CRC-32`).toBe(crc);
    entries.push({ name, data });
    central += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
