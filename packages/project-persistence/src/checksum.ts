const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** Fast corruption detector for local persistence envelopes (not a security MAC). */
export function crc32(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = (CRC32_TABLE[(checksum ^ byte) & 0xff] ?? 0) ^ (checksum >>> 8);
  }
  return `crc32:${((checksum ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`;
}
