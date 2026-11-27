// Stem ZIP export: one WAV per audible Instrument/Drum/Audio Track, packed
// STORE-only into a deterministic ZIP.
//
// Decisions (see docs/02 and docs/05):
// - A stem exists for every Instrument/Drum/Audio Track that is audible in the
//   mix, using the mixer's own routing-aware mute/solo resolution
//   (`resolveAudioRoutingMix`): a soloed Bus keeps the sources feeding it, a
//   muted Bus silences sources that only feed it. Master and Bus Tracks are
//   never stems. No mix.wav is included; the Master WAV export covers that.
// - Every stem is rendered to the same length: the longest planned render
//   (tails included) over all stems. Each stem keeps its own tail naturally
//   instead of being padded with silence, so stems line up in another DAW.
//   P51 loudness normalize is deliberately NOT applied: stems keep their
//   relative levels.
// - Memory: one stem render at a time (one Float32 offline buffer alive at
//   once); only the encoded WAV bytes accumulate in the ZIP.
import { compileAudioRouting, type Project, type Track } from '@cts/project-model';
import {
  planSelectedTrackWavRender,
  renderSelectedTrackToWav,
  RENDER_CHANNELS,
  type WavFormatOptions,
} from '../../audio/wav';
import { audioRoutingEdgeKey, resolveAudioRoutingMix } from '../../audio/graph';
import { safeFileStem } from './download';
import { assertZipStoreFits, zipStore } from './zipStore';

/** Both runtimes refuse above this total (native IPC clones the body once). */
export const MAX_STEM_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_STEM_NAME_CODE_POINTS = 64;
/** Whole entry name (`NN_name.wav`) limit; Linux file names stop at 255 bytes. */
const MAX_ENTRY_NAME_BYTES = 200;
const utf8 = new TextEncoder();
const WAV_HEADER_BYTES = 44;

export class StemExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StemExportError';
  }
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Safe file-name part for one Track name. Never empty, no separators, no `..`. */
export function sanitizeStemName(name: string): string {
  const cleaned = Array.from(name.normalize('NFC'), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      /[\\/:*?"<>|]/.test(character) ||
      (/^\p{Cf}$/u.test(character) && codePoint !== 0x200d)
    )
      ? '_'
      : character;
  }).join('');
  const trimEnds = (value: string) => value.replace(/^[.\s]+/u, '').replace(/[.\s]+$/u, '');
  let base = trimEnds(cleaned.replace(/\s+/gu, ' '));
  base = trimEnds(Array.from(base).slice(0, MAX_STEM_NAME_CODE_POINTS).join(''));
  if (base === '') base = 'track';
  // Windows treats `CON.anything` as the device, so test the part before the first dot.
  return WINDOWS_RESERVED.test(base.split('.')[0]!.trimEnd()) ? `_${base}` : base;
}

/** `01_Melody.wav`, numbered by Track order; repeated names get ` (2)`, ` (3)`. */
export function stemFileNames(trackNames: readonly string[]): string[] {
  const width = Math.max(2, String(trackNames.length).length);
  const used = new Set<string>();
  return trackNames.map((trackName, index) => {
    const prefix = `${String(index + 1).padStart(width, '0')}_`;
    // Cap before de-duplication, on a code point boundary (never inside a surrogate pair).
    const budget = MAX_ENTRY_NAME_BYTES - utf8.encode(`${prefix}.wav`).length;
    let base = '';
    for (const character of sanitizeStemName(trackName)) {
      if (utf8.encode(base + character).length > budget) break;
      base += character;
    }
    base = base.replace(/[.\s]+$/u, '') || 'track';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    return `${prefix}${name}.wav`;
  });
}

export function stemZipFileName(projectName: string): string {
  return `${safeFileStem(projectName)} - stems.zip`;
}

/** Source Tracks that reach Master through an audible, unmuted path in the mix. */
export function stemTracks(project: Project): Track[] {
  const compiled = compileAudioRouting(project);
  if (!compiled.ok) {
    throw new StemExportError('ルーティングに問題があるため、ステムを書き出せません。');
  }
  const mix = resolveAudioRoutingMix(project, compiled.plan);
  const reachesMaster = (sourceId: string): boolean => {
    const pending = [sourceId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of compiled.plan.edges) {
        if (edge.sourceTrackId !== id || !mix.activeEdgeIds.has(audioRoutingEdgeKey(edge))) continue;
        if (edge.destination.type === 'master') return true;
        if (mix.audibleChannelIds.has(edge.destination.trackId)) pending.push(edge.destination.trackId);
      }
    }
    return false;
  };
  return project.tracks.filter(
    (track) =>
      (track.type === 'instrument' || track.type === 'drum' || track.type === 'audio') &&
      mix.audibleChannelIds.has(track.id) &&
      reachesMaster(track.id),
  );
}

/** Exact STORE archive size: local entries, central directory and end record. */
export function stemZipArchiveBytes(names: readonly string[], wavBytes: number): number {
  let size = 22;
  for (const name of names) {
    const nameBytes = utf8.encode(name).length;
    size += 30 + nameBytes + wavBytes + 46 + nameBytes;
  }
  return size;
}

export function assertStemZipFits(names: readonly string[], wavBytes: number): void {
  if (stemZipArchiveBytes(names, wavBytes) > MAX_STEM_ZIP_BYTES) {
    throw new StemExportError(
      'ステムZIPの合計サイズが上限（1GB）を超えます。トラック数を減らすか、曲を短くしてください。',
    );
  }
}

export function wavFileByteLength(frames: number, bitDepth: 16 | 24): number {
  return WAV_HEADER_BYTES + frames * RENDER_CHANNELS * (bitDepth / 8);
}

export type StemZipPlan = Readonly<{
  files: ReadonlyArray<Readonly<{ name: string; byteLength: number; trackId: string }>>;
  frames: number;
}>;

/** Size every stem and refuse oversized exports before any audio is rendered. */
export function planStemZip(project: Project, format: WavFormatOptions): StemZipPlan {
  const tracks = stemTracks(project);
  if (tracks.length === 0) {
    throw new StemExportError('書き出せるトラックがありません。ミュートやソロの設定を確認してください。');
  }
  const frames = Math.max(
    ...tracks.map((track) => planSelectedTrackWavRender(project, track.id, format).frames),
  );
  const names = stemFileNames(tracks.map((track) => track.name));
  const bitDepth = format.bitDepth ?? 16;
  const byteLength = wavFileByteLength(frames, bitDepth);
  const files = tracks.map((track, index) => ({
    name: names[index]!,
    byteLength,
    trackId: track.id,
  }));
  assertStemZipFits(names, byteLength);
  assertZipStoreFits(files);
  return { files, frames };
}

/** Render and pack stems sequentially; each lease is released before the next render. */
export async function buildStemZip(
  project: Project,
  format: WavFormatOptions,
  onProgress: (current: number, total: number) => void = () => undefined,
): Promise<Blob> {
  const { files, frames } = planStemZip(project, format);
  return zipStore(files, async (file, index) => {
    onProgress(index + 1, files.length);
    // Let the dialog paint before the next offline graph is built.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const lease = await renderSelectedTrackToWav(project, files[index]!.trackId, {
      ...format,
      minFrames: frames,
    });
    try {
      return await lease.blob.arrayBuffer();
    } finally {
      lease.release();
    }
  });
}
