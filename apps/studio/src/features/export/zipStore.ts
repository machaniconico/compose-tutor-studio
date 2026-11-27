// ZIP32 store mode. File data stays in separate Blob parts to avoid
// allocating a second contiguous buffer the size of the entire archive.
const MAX_ZIP32 = 0xffffffff;
const MAX_ZIP_FIELD = 0xffff;
const UTF8_FLAG = 1 << 11;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_HEADER = 22;
const DOS_DATE = 0x21; // 1980-01-01
const utf8 = new TextEncoder();

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc;
});

function updateCrc(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]!) & 0xff]!;
  }
  return crc;
}

export function crc32(data: Uint8Array): number {
  return (updateCrc(0xffffffff, data) ^ 0xffffffff) >>> 0;
}

const CRC_CHUNK_BYTES = 4 * 1024 * 1024;

async function checksum(data: Blob): Promise<number> {
  let crc = 0xffffffff;
  for (let offset = 0; offset < data.size; offset += CRC_CHUNK_BYTES) {
    if (offset > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const chunk = await data.slice(offset, offset + CRC_CHUNK_BYTES).arrayBuffer();
    crc = updateCrc(crc, new Uint8Array(chunk));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class ZipStoreLimitError extends RangeError {
  constructor() {
    super('ステム ZIP の上限（約 4 GB、最大 65,534 ファイル）を超えます。書き出す範囲やトラック数を減らしてください。');
  }
}

type ZipFile = { name: string; byteLength: number };

/** Check ZIP32 field widths and the complete archive size before rendering. */
export function assertZipStoreFits(files: readonly ZipFile[]): void {
  if (files.length >= MAX_ZIP_FIELD) throw new ZipStoreLimitError();
  let size = END_HEADER;
  for (const { name, byteLength } of files) {
    // UTF-8 uses at least as many bytes as UTF-16 code units.
    if (typeof name !== 'string' || name.length > MAX_ZIP_FIELD ||
        !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength >= MAX_ZIP32) {
      throw new ZipStoreLimitError();
    }
    const nameLength = utf8.encode(name).length;
    if (nameLength > MAX_ZIP_FIELD) throw new ZipStoreLimitError();
    size += LOCAL_HEADER + CENTRAL_HEADER + 2 * nameLength + byteLength;
    if (size >= MAX_ZIP32) throw new ZipStoreLimitError();
  }
}

export async function zipStore(
  files: readonly ZipFile[],
  readFile: (file: ZipFile, index: number) => Promise<ArrayBuffer>,
): Promise<Blob> {
  assertZipStoreFits(files);
  const entries = files.map(({ name, byteLength }) => ({ name, byteLength }));
  const parts: BlobPart[] = [];
  const central: ArrayBuffer[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const [index, { name: fileName, byteLength }] of entries.entries()) {
    const data = await readFile({ name: fileName, byteLength }, index);
    if (data.byteLength !== byteLength) throw new RangeError('WAV のサイズが予定と一致しません。');
    const name = utf8.encode(fileName);
    const contents = new Blob([data]);
    // Hash the archived bytes even if the caller reuses the buffer during a yield.
    const crc = byteLength <= CRC_CHUNK_BYTES ? crc32(new Uint8Array(data)) : await checksum(contents);

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER + name.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, byteLength, true);
    local.setUint32(22, byteLength, true);
    local.setUint16(26, name.length, true);
    new Uint8Array(local.buffer).set(name, LOCAL_HEADER);
    parts.push(local.buffer, contents);

    const entry = new DataView(new ArrayBuffer(CENTRAL_HEADER + name.length));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 0x0314, true); // Unix creator, ZIP 2.0. Keeps UTF-8 names in Info-ZIP.
    entry.setUint16(6, 20, true);
    entry.setUint16(8, UTF8_FLAG, true);
    entry.setUint16(14, DOS_DATE, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, byteLength, true);
    entry.setUint32(24, byteLength, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(38, 0o100644 << 16, true); // Unix regular file, rw-r--r--.
    entry.setUint32(42, offset, true);
    new Uint8Array(entry.buffer).set(name, CENTRAL_HEADER);
    central.push(entry.buffer);
    centralSize += entry.byteLength;
    offset += local.byteLength + byteLength;
  }

  const end = new DataView(new ArrayBuffer(END_HEADER));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
