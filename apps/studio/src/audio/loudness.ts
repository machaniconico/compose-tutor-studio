type WavSampleRate = 44100 | 48000;

// Covers main's five-minute offline render and its tail at either sample rate.
const MAX_MEASUREMENT_FRAMES = 2 ** 24;

function validateChannels(channels: readonly Float32Array[]): void {
  if (channels.length > 2 || channels.some((channel) => channel.length > MAX_MEASUREMENT_FRAMES)) {
    throw new RangeError('Audio measurement is limited to two channels and 16,777,216 frames per channel.');
  }
}

type Biquad = readonly [b0: number, b1: number, b2: number, a1: number, a2: number];

// ITU-R BS.1770-4 Annex 1, Tables 1 and 2.
const SHELF_48: Biquad = [
  1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585,
];
const HIGH_PASS_48: Biquad = [1, -2, 1, -1.99004745483398, 0.99007225036621];

function kWeighting(rate: WavSampleRate): readonly [Biquad, Biquad] {
  if (rate === 48000) return [SHELF_48, HIGH_PASS_48];

  // Bilinear design with pre-warped corner frequencies, as in libebur128.
  const shelfK = Math.tan(Math.PI * 1681.974450955533 / rate);
  const shelfK2 = shelfK ** 2;
  const shelfDamping = shelfK / 0.7071752369554196;
  const shelfA0 = 1 + shelfDamping + shelfK2;
  const highGain = 10 ** (3.999843853973347 / 20);
  const middleGain = highGain ** 0.4996667741545416;
  const passK = Math.tan(Math.PI * 38.13547087602444 / rate);
  const passK2 = passK ** 2;
  const passDamping = passK / 0.5003270373238773;
  const passA0 = 1 + passDamping + passK2;
  return [
    [
      (highGain + middleGain * shelfDamping + shelfK2) / shelfA0,
      2 * (shelfK2 - highGain) / shelfA0,
      (highGain - middleGain * shelfDamping + shelfK2) / shelfA0,
      2 * (shelfK2 - 1) / shelfA0,
      (1 - shelfDamping + shelfK2) / shelfA0,
    ],
    [1, -2, 1, 2 * (passK2 - 1) / passA0, (1 - passDamping + passK2) / passA0],
  ];
}

function biquad([b0, b1, b2, a1, a2]: Biquad): (sample: number) => number {
  let z1 = 0;
  let z2 = 0;
  return (sample) => {
    const output = sample * b0 + z1;
    z1 = sample * b1 - output * a1 + z2;
    z2 = sample * b2 - output * a2;
    return output;
  };
}

const LOUDNESS_OFFSET = -0.691;
const ABSOLUTE_GATE_ENERGY = 10 ** ((-70 - LOUDNESS_OFFSET) / 10);

function gatedMean(energies: number[], threshold: number): number {
  let sum = 0;
  let count = 0;
  for (const energy of energies) {
    if (energy <= threshold) continue;
    sum += energy;
    count += 1;
  }
  return count ? sum / count : 0;
}

/** Integrated LKFS for mono or stereo PCM (both channel weights are 1). */
export function integratedLoudness(channels: readonly Float32Array[], rate: WavSampleRate): number {
  return finishSampleSteps(loudnessSteps(channels, rate));
}

function* loudnessSteps(
  channels: readonly Float32Array[],
  rate: WavSampleRate,
): Generator<number, number, void> {
  validateChannels(channels);
  if (rate !== 44100 && rate !== 48000) {
    throw new RangeError('Audio measurement supports 44,100 and 48,000 Hz.');
  }
  const frames = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  if (frames === 0) return -Infinity;
  const hop = Math.round(rate * 0.1);
  const block = 4 * hop;
  // For sub-400 ms clips use their available duration. For longer clips discard
  // the incomplete block at the end, per Annex 1.
  const blockSize = Math.min(block, frames);
  const blockCount = 1 + Math.floor((frames - blockSize) / hop);
  const measuredFrames = (blockCount - 1) * hop + blockSize;
  const hops = new Float64Array(Math.ceil(measuredFrames / hop));
  const [shelf, highPass] = kWeighting(rate);

  // Accumulate 100 ms energies once, then sum four neighboring hops per block.
  const totalFrames = measuredFrames * channels.length;
  let processedFrames = 0;
  for (const channel of channels) {
    const filterShelf = biquad(shelf);
    const filterPass = biquad(highPass);
    for (let start = 0, index = 0; start < measuredFrames; start += hop, index += 1) {
      let sum = 0;
      const end = Math.min(start + hop, measuredFrames);
      for (let frame = start; frame < end; frame += 1) {
        const sample = channel[frame] ?? 0;
        const weighted = filterPass(filterShelf(Number.isFinite(sample) ? sample : 0));
        sum += weighted * weighted;
      }
      hops[index] = hops[index]! + sum;
      processedFrames += end - start;
      yield processedFrames / totalFrames;
    }
  }
  const energies = Array.from({ length: blockCount }, (_, index) => (
    hops[index]! + (hops[index + 1] ?? 0) + (hops[index + 2] ?? 0) + (hops[index + 3] ?? 0)
  ) / blockSize);
  const absoluteMean = gatedMean(energies, ABSOLUTE_GATE_ENERGY);
  const mean = gatedMean(energies, Math.max(ABSOLUTE_GATE_ENERGY, absoluteMean / 10));
  return LOUDNESS_OFFSET + 10 * Math.log10(mean);
}

// BS.1770-4 Annex 2's four FIR phases, in units of 1/8192.
// The last two phases are reversals of the first two.
const PHASE_0 = [14, 90, -161, 272, -487, 1125, 7964, -838, 390, -218, 122, -68];
const PHASE_1 = [-239, 240, -424, 730, -1364, 3810, 6388, -1641, 832, -477, 271, -155];
const TRUE_PEAK_PHASES = [PHASE_0, PHASE_1, [...PHASE_1].reverse(), [...PHASE_0].reverse()]
  .map((phase) => phase.map((coefficient) => coefficient / 8192));

/** Estimate the inter-sample peak in dBTP with 4× FIR oversampling. */
export function truePeak(channels: readonly Float32Array[]): number {
  return finishSampleSteps(truePeakSteps(channels));
}

const PEAK_CHUNK_FRAMES = 4096;
const FIR_TAPS = PHASE_0.length;

function* truePeakSteps(channels: readonly Float32Array[]): Generator<number, number, void> {
  validateChannels(channels);
  const totalFrames = channels.reduce((sum, channel) => sum + channel.length + FIR_TAPS - 1, 0);
  let processedFrames = 0;
  let peak = 0;
  for (const channel of channels) {
    const history = new Float64Array(FIR_TAPS);
    // Flush the FIR with zeroes so delayed peaks at the end are included.
    const frames = channel.length + history.length - 1;
    for (let start = 0; start < frames; start += PEAK_CHUNK_FRAMES) {
      const end = Math.min(start + PEAK_CHUNK_FRAMES, frames);
      for (let frame = start; frame < end; frame += 1) {
        const sample = channel[frame] ?? 0;
        const value = Number.isFinite(sample) ? sample : 0;
        history.copyWithin(1, 0, -1);
        history[0] = value;
        peak = Math.max(peak, Math.abs(value));
        for (const phase of TRUE_PEAK_PHASES) {
          let interpolated = 0;
          for (let tap = 0; tap < phase.length; tap += 1) {
            interpolated += history[tap]! * phase[tap]!;
          }
          peak = Math.max(peak, Math.abs(interpolated));
        }
      }
      processedFrames += end - start;
      yield processedFrames / totalFrames;
    }
  }
  return 20 * Math.log10(peak);
}

type MeasurementPhase = 'loudness' | 'peak';
type MeasurementOptions = {
  signal?: AbortSignal;
  onProgress?: (phase: MeasurementPhase, fraction: number) => void;
};

/** Measure on the main thread while leaving time for paint and cancellation. */
export async function measureAudioLevels(
  channels: readonly Float32Array[],
  rate: WavSampleRate,
  { signal, onProgress }: MeasurementOptions = {},
): Promise<{ loudness: number; peak: number }> {
  const loudness = await runSampleSteps(loudnessSteps(channels, rate), {
    signal, onProgress: (fraction) => onProgress?.('loudness', fraction),
  });
  const peak = await runSampleSteps(truePeakSteps(channels), {
    signal, onProgress: (fraction) => onProgress?.('peak', fraction),
  });
  return { loudness, peak };
}

type SampleSteps<T> = Generator<number, T, void>;

type SampleStepOptions = {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
};

function finishSampleSteps<T>(steps: SampleSteps<T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

const SAMPLE_WORK_BUDGET_MS = 40;
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function runSampleSteps<T>(
  steps: SampleSteps<T>,
  { signal, onProgress }: SampleStepOptions,
): Promise<T> {
  signal?.throwIfAborted();
  onProgress?.(0);
  // Let the browser show the new phase before its first slice.
  await yieldToEventLoop();
  signal?.throwIfAborted();
  let sliceStart = performance.now();
  let step = steps.next();
  while (!step.done) {
    if (performance.now() - sliceStart >= SAMPLE_WORK_BUDGET_MS) {
      onProgress?.(step.value);
      await yieldToEventLoop();
      signal?.throwIfAborted();
      sliceStart = performance.now();
    }
    step = steps.next();
  }
  return step.value;
}
