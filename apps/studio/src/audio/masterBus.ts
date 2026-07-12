import { DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS } from './voiceTiming';

export type MasterBusGraph = Readonly<{
  master: GainNode;
  limiter: DynamicsCompressorNode;
}>;

export const MASTER_LIMITER = Object.freeze({
  threshold: -3,
  knee: 6,
  ratio: 12,
  attack: 0.002,
  release: 0.12,
});

/** Tail retained after the pre-limiter Master gain has reached silence. */
export const MASTER_LIMITER_LOOKAHEAD_SECONDS =
  DYNAMICS_COMPRESSOR_LOOKAHEAD_SECONDS;

/** Build the single shared live/offline master topology. */
export function buildMasterBus(
  context: BaseAudioContext,
  destination: AudioNode,
): MasterBusGraph {
  const master = context.createGain();
  let limiter: DynamicsCompressorNode | null = null;
  try {
    master.gain.value = 1;
    limiter = context.createDynamicsCompressor();
    limiter.threshold.value = MASTER_LIMITER.threshold;
    limiter.knee.value = MASTER_LIMITER.knee;
    limiter.ratio.value = MASTER_LIMITER.ratio;
    limiter.attack.value = MASTER_LIMITER.attack;
    limiter.release.value = MASTER_LIMITER.release;
    master.connect(limiter);
    limiter.connect(destination);
    return { master, limiter };
  } catch (error) {
    try {
      master.disconnect();
    } catch {
      // Graph construction never became externally visible.
    }
    try {
      limiter?.disconnect();
    } catch {
      // Graph construction never became externally visible.
    }
    throw error;
  }
}
