import { expect, test } from '@playwright/test';
import type { EffectConfig } from '@cts/project-model';
import { MASTER_LIMITER_LOOKAHEAD_SECONDS } from '../src/audio/masterBus';
import {
  AUDIO_TAIL_SILENCE_THRESHOLD,
  estimateFilterTailSeconds,
} from '../src/audio/tail';

const SAMPLE_RATE = 44_100;

test('the coefficient plan bounds real high-Q Web Audio filter ringing', async ({ page }) => {
  await page.goto('/');

  const measured = await page.evaluate(
    async ({ sampleRate, silenceThreshold }) => {
      const sourceStopSeconds = 0.1;
      const context = new OfflineAudioContext(1, sampleRate, sampleRate);
      const oscillator = context.createOscillator();
      const filter = context.createBiquadFilter();
      oscillator.type = 'sine';
      oscillator.frequency.value = 80;
      filter.type = 'lowpass';
      filter.frequency.value = 80;
      // Web Audio specifies low-pass Q in dB. This is the runtime maximum.
      filter.Q.value = 18;
      oscillator.connect(filter).connect(context.destination);
      oscillator.start(0);
      oscillator.stop(sourceStopSeconds);

      const rendered = await context.startRendering();
      const samples = rendered.getChannelData(0);
      const sourceStopFrame = Math.ceil(sourceStopSeconds * sampleRate);
      let lastAudibleFrame = -1;
      for (let frame = sourceStopFrame; frame < samples.length; frame += 1) {
        if (Math.abs(samples[frame] ?? 0) >= silenceThreshold) {
          lastAudibleFrame = frame;
        }
      }
      return {
        sourceStopFrame,
        lastAudibleFrame,
        tailSeconds:
          lastAudibleFrame < sourceStopFrame
            ? 0
            : (lastAudibleFrame - sourceStopFrame + 1) / sampleRate,
      };
    },
    { sampleRate: SAMPLE_RATE, silenceThreshold: AUDIO_TAIL_SILENCE_THRESHOLD },
  );

  const maxFilter: EffectConfig = {
    id: 'max-filter',
    type: 'filter',
    enabled: true,
    params: { cutoff: 0, resonance: 1 },
  };
  const planned = estimateFilterTailSeconds(maxFilter, SAMPLE_RATE);

  expect(measured.lastAudibleFrame).toBeGreaterThan(measured.sourceStopFrame);
  expect(measured.tailSeconds).toBeGreaterThan(0.1);
  expect(measured.tailSeconds).toBeLessThanOrEqual(planned);
  expect(planned).toBeLessThan(0.5);
});

test('Chromium compressor output observes the specified 6ms look-ahead', async ({ page }) => {
  await page.goto('/');

  const measured = await page.evaluate(async (sampleRate) => {
    const context = new OfflineAudioContext(1, Math.ceil(sampleRate * 0.03), sampleRate);
    const impulse = context.createBuffer(1, 1, sampleRate);
    impulse.getChannelData(0)[0] = 1;
    const source = context.createBufferSource();
    source.buffer = impulse;
    const compressor = context.createDynamicsCompressor();
    source.connect(compressor).connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const samples = rendered.getChannelData(0);
    let firstNonZeroFrame = -1;
    let lastNonZeroFrame = -1;
    for (let frame = 0; frame < samples.length; frame += 1) {
      if (Math.abs(samples[frame] ?? 0) > 1e-8) {
        if (firstNonZeroFrame < 0) firstNonZeroFrame = frame;
        lastNonZeroFrame = frame;
      }
    }
    return { firstNonZeroFrame, lastNonZeroFrame };
  }, SAMPLE_RATE);

  const expectedFrame = MASTER_LIMITER_LOOKAHEAD_SECONDS * SAMPLE_RATE;
  expect(measured.firstNonZeroFrame).toBeGreaterThanOrEqual(Math.floor(expectedFrame) - 1);
  expect(measured.firstNonZeroFrame).toBeLessThanOrEqual(Math.ceil(expectedFrame) + 1);
  expect(measured.lastNonZeroFrame).toBeLessThanOrEqual(Math.ceil(expectedFrame) + 2);
});
