import { resolveMuteSolo, type Track } from '@cts/project-model';
import {
  encodeWav, minimumStemFrames, planStemRender, renderWavAudio, wavRenderByteLength,
  type WavEncodingOptions, type WavRenderPlan,
} from '../../audio/wav';
import { safeFileStem } from './download';
import { assertZipStoreFits, zipStore } from './zipStore';

export function exportStemTracks(tracks: readonly Track[]): Track[] {
  const audible = resolveMuteSolo(tracks);
  return tracks.filter((track) => audible.has(track.id));
}

export function stemFileNames(tracks: readonly Track[]): string[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return tracks.map((track) => {
    const base = safeFileStem(track.name.replace(/(?!\u200d)\p{Cf}/gu, '_'));
    const key = base.toLowerCase().normalize('NFC');
    let name = base;
    let candidate = key;
    let suffix = nextSuffix.get(key) ?? 2;
    while (used.has(candidate)) {
      name = `${base}_${suffix}`;
      candidate = `${key}_${suffix}`;
      suffix += 1;
    }
    nextSuffix.set(key, suffix);
    used.add(candidate);
    return `${name}.wav`;
  });
}

export function prepareStemZip(mix: WavRenderPlan, options: WavEncodingOptions) {
  const tracks = exportStemTracks(mix.project.tracks);
  const names = stemFileNames(tracks);
  // Large projects can exceed ZIP32 even with every stem at its minimum length.
  const minimumSize = wavRenderByteLength(minimumStemFrames(mix), options.bitDepth);
  assertZipStoreFits(names.map((name) => ({ name, byteLength: minimumSize })));
  const files = tracks.map(({ id }, index) => {
    const plan = planStemRender(mix, id);
    return { name: names[index]!, byteLength: wavRenderByteLength(plan.frames, options.bitDepth), plan };
  });
  assertZipStoreFits(files);
  return (onProgress: (current: number, total: number) => void): Promise<Blob> => (
    zipStore(files, async (_file, index) => {
      onProgress(index + 1, files.length);
      // Give the dialog a chance to paint before building the next graph.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const audio = await renderWavAudio(files[index]!.plan);
      return encodeWav(audio, mix.sampleRate, options);
    })
  );
}
