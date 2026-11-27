import type { Project } from '@cts/project-model';

// Standard MIDI key signatures in order from seven flats to seven sharps.
const MAJOR = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MINOR = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
const MAJOR_ENHARMONICS: Readonly<Record<string, string>> = { 'D#': 'Eb', 'G#': 'Ab', 'A#': 'Bb' };
const MINOR_ENHARMONICS: Readonly<Record<string, string>> = { Db: 'C#', Gb: 'F#' };

export function keySignatureMeta({ key, scale }: Pick<Project, 'key' | 'scale'>): number[] | undefined {
  const minor = scale === 'naturalMinor' || scale === 'harmonicMinor' || scale === 'melodicMinor';
  if ((!minor && scale !== 'major') || typeof key !== 'string') return;

  const signatures = minor ? MINOR : MAJOR;
  const enharmonics = minor ? MINOR_ENHARMONICS : MAJOR_ENHARMONICS;
  const tonic = key.replaceAll('♯', '#').replaceAll('♭', 'b');
  const index = signatures.indexOf(enharmonics[tonic] ?? tonic);
  if (index === -1) return;
  return [0xff, 0x59, 0x02, (index - 7) & 0xff, Number(minor)];
}

export function readKeySignature(sfByte: number, mode: number): string | undefined {
  if (mode !== 0 && mode !== 1) return;
  const sf = sfByte < 128 ? sfByte : sfByte - 256;
  const tonic = (mode === 1 ? MINOR : MAJOR)[sf + 7];
  if (tonic !== undefined) return `${tonic} ${mode === 1 ? 'minor' : 'major'}`;
}
