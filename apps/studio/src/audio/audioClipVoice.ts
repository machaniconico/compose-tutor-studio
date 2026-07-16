import type { AudioClipPlaybackPlan } from './audioClipPlanner';

type ActiveAudioClipVoice = {
  occurrenceId: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  disposed: boolean;
};

/**
 * Owns every AudioBufferSourceNode feeding one audio TrackGraph input.
 * Shared output nodes are never disconnected by this manager.
 */
export class AudioClipVoiceManager {
  private readonly voices = new Map<string, ActiveAudioClipVoice>();
  private disposed = false;

  constructor(
    private readonly context: BaseAudioContext,
    private readonly output: AudioNode,
  ) {}

  /** Schedule one logical occurrence. Duplicate lookahead plans are ignored. */
  schedule(
    plan: AudioClipPlaybackPlan,
    buffer: AudioBuffer,
    when: number,
  ): boolean {
    if (this.disposed || this.voices.has(plan.occurrenceId)) return false;
    if (
      !Number.isFinite(when) ||
      !Number.isFinite(plan.sourceOffsetSeconds) ||
      !Number.isFinite(plan.durationSeconds) ||
      plan.sourceOffsetSeconds < 0 ||
      plan.durationSeconds <= 0
    ) {
      return false;
    }

    let source: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    let voice: ActiveAudioClipVoice | null = null;
    try {
      source = this.context.createBufferSource();
      source.buffer = buffer;
      gain = this.context.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.output);

      const loop = validLoopBounds(plan, buffer.duration);
      if (loop) {
        source.loop = true;
        source.loopStart = loop.start;
        source.loopEnd = loop.end;
      }

      const offset = clampSourceOffset(plan.sourceOffsetSeconds, buffer.duration, loop);
      const duration = loop
        ? plan.durationSeconds
        : Math.min(plan.durationSeconds, Math.max(0, buffer.duration - offset));
      if (!(duration > 0)) throw new RangeError('Audio clip source duration is empty.');
      scheduleClipGain(gain.gain, plan, when, duration);

      voice = {
        occurrenceId: plan.occurrenceId,
        source,
        gain,
        disposed: false,
      };
      this.voices.set(plan.occurrenceId, voice);
      const activeVoice = voice;
      source.onended = () => this.disposeVoice(activeVoice, false);
      source.start(when, offset, duration);
      return true;
    } catch (error) {
      if (voice) {
        this.disposeVoice(voice, true);
      } else {
        stopBestEffort(source, this.context.currentTime);
        disconnectBestEffort(source);
        disconnectBestEffort(gain);
      }
      throw error;
    }
  }

  /** Hard-stop and synchronously release every future/active occurrence. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of [...this.voices.values()]) {
      this.disposeVoice(voice, true);
    }
    this.voices.clear();
  }

  private disposeVoice(voice: ActiveAudioClipVoice, stop: boolean): void {
    if (voice.disposed) return;
    voice.disposed = true;
    if (this.voices.get(voice.occurrenceId) === voice) {
      this.voices.delete(voice.occurrenceId);
    }
    voice.source.onended = null;
    if (stop) stopBestEffort(voice.source, this.context.currentTime);
    disconnectBestEffort(voice.source);
    disconnectBestEffort(voice.gain);
  }
}

function scheduleClipGain(
  param: AudioParam,
  plan: AudioClipPlaybackPlan,
  when: number,
  duration: number,
): void {
  param.cancelScheduledValues(when);
  const points = plan.gainPoints.length > 0
    ? plan.gainPoints
    : [{ offsetSeconds: 0, value: 1 }];
  const first = points[0];
  param.setValueAtTime(finiteGain(first?.value ?? 1), when);
  for (const point of points.slice(1)) {
    const offset = Math.min(duration, Math.max(0, point.offsetSeconds));
    param.linearRampToValueAtTime(finiteGain(point.value), when + offset);
  }
}

function validLoopBounds(
  plan: AudioClipPlaybackPlan,
  bufferDuration: number,
): Readonly<{ start: number; end: number }> | null {
  const start = plan.loopStartSeconds;
  const end = plan.loopEndSeconds;
  if (
    start === null ||
    end === null ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    start >= bufferDuration
  ) {
    return null;
  }
  return { start, end: Math.min(end, bufferDuration) };
}

function clampSourceOffset(
  offset: number,
  bufferDuration: number,
  loop: Readonly<{ start: number; end: number }> | null,
): number {
  if (loop) {
    if (offset >= loop.start && offset < loop.end) return offset;
    const loopDuration = loop.end - loop.start;
    if (!(loopDuration > 0)) return loop.start;
    const phase = (offset - loop.start) % loopDuration;
    return loop.start + (phase < 0 ? phase + loopDuration : phase);
  }
  return Math.min(Math.max(0, offset), Math.max(0, bufferDuration));
}

function finiteGain(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function stopBestEffort(source: AudioBufferSourceNode | null, when: number): void {
  if (!source) return;
  try {
    source.stop(Number.isFinite(when) ? when : 0);
  } catch {
    // An unstarted/already-ended browser source may reject stop().
  }
}

function disconnectBestEffort(node: AudioNode | null): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // Node may already be disconnected by a browser after context shutdown.
  }
}
