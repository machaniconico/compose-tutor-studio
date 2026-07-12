import { expect, test, type Download, type Page } from '@playwright/test';
import type { Project } from '@cts/project-model';
import { planWavRender } from '../src/audio/wav';

const FIXTURE_TITLE = 'Master Mix E2E';
const EXPECTED_WAV_CHANNELS = 2;
const EXPECTED_WAV_SAMPLE_RATE = 44_100;
const WAV_BYTES_PER_SAMPLE = 2;

type PcmWavStats = Readonly<{
  channels: number;
  sampleRate: number;
  dataSize: number;
  nonZeroSamples: number;
  peak: number;
  rms: number;
}>;

function masterMixProject(
  options: { instrumentMuted?: boolean; lengthBars?: number } = {},
): Project {
  const lengthBars = options.lengthBars ?? 1;
  const lengthBeats = lengthBars * 4;
  return {
    id: 'project-master-mix-e2e',
    schemaVersion: 1,
    title: FIXTURE_TITLE,
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars,
    tracks: [
      {
        id: 'track-deterministic-tone',
        name: 'Deterministic Tone',
        type: 'instrument',
        clips: [
          {
            id: 'clip-deterministic-tone',
            trackId: 'track-deterministic-tone',
            type: 'midi',
            startBeat: 0,
            lengthBeats,
            loop: false,
            notes: [
              {
                id: 'note-deterministic-tone',
                pitch: 48,
                // Start at sample zero and sustain across the song. An initial
                // mute/solo ramp leak therefore cannot settle before the tone.
                startBeat: 0,
                durationBeats: lengthBeats,
                velocity: 64,
              },
            ],
          },
        ],
        // Keep the signal well below the limiter threshold so Master 0.5 is a
        // meaningful linear-gain comparison with Master 1.
        volume: 0.2,
        pan: 0,
        mute: options.instrumentMuted ?? false,
        solo: false,
        instrument: { type: 'synth', preset: 'warmBass' },
        effects: [],
      },
      {
        id: 'track-master',
        name: 'Master',
        type: 'master',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
    chordTrack: [],
    sections: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function dismissOnboarding(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function importProject(page: Page, project: Project): Promise<void> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  await dialog.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: 'master-mix-fixture.ctsproj.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'プロジェクト名', exact: true })).toHaveValue(
    FIXTURE_TITLE,
  );
}

async function setMasterVolume(page: Page, volume: number): Promise<void> {
  const value = String(volume);
  const mixer = page.getByRole('region', { name: 'ミキサー' });
  const trackList = page.getByRole('navigation', { name: 'トラック一覧' });
  await mixer.getByLabel('Master 音量').fill(value);
  await expect(mixer.getByLabel('Master 音量')).toHaveValue(value);
  await expect(trackList.getByLabel('Master 音量')).toHaveValue(value);
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportWav(page: Page): Promise<PcmWavStats> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'WAVエクスポート', exact: true }).click();
  const wav = await readDownload(await downloadPromise);
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  return inspectPcmWav(wav);
}

function inspectPcmWav(wav: Buffer): PcmWavStats {
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');

  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset: number | null = null;
  let dataSize: number | null = null;

  for (let offset = 12; offset + 8 <= wav.length; ) {
    const chunkId = wav.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = wav.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkSize > wav.length) {
      throw new Error(`WAV chunk ${chunkId} exceeds the downloaded file`);
    }
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = wav.readUInt16LE(payloadOffset);
      channels = wav.readUInt16LE(payloadOffset + 2);
      sampleRate = wav.readUInt32LE(payloadOffset + 4);
      bitsPerSample = wav.readUInt16LE(payloadOffset + 14);
    } else if (chunkId === 'data') {
      dataOffset = payloadOffset;
      dataSize = chunkSize;
    }
    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    channels === null ||
    sampleRate === null ||
    bitsPerSample !== 16 ||
    dataOffset === null ||
    dataSize === null
  ) {
    throw new Error('Expected a complete 16-bit PCM WAV');
  }

  let nonZeroSamples = 0;
  let peak = 0;
  let sumSquares = 0;
  let sampleCount = 0;
  for (let offset = dataOffset; offset + 2 <= dataOffset + dataSize; offset += 2) {
    const sample = wav.readInt16LE(offset);
    if (sample !== 0) nonZeroSamples += 1;
    peak = Math.max(peak, Math.abs(sample));
    sumSquares += sample * sample;
    sampleCount += 1;
  }

  return {
    channels,
    sampleRate,
    dataSize,
    nonZeroSamples,
    peak,
    rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
  };
}

function expectPlannedStereoWav(stats: PcmWavStats, project: Project): void {
  const plan = planWavRender(project);
  const frameSize = EXPECTED_WAV_CHANNELS * WAV_BYTES_PER_SAMPLE;
  expect(stats.channels).toBe(EXPECTED_WAV_CHANNELS);
  expect(stats.sampleRate).toBe(EXPECTED_WAV_SAMPLE_RATE);
  expect(stats.dataSize).toBeGreaterThan(0);
  expect(stats.dataSize % frameSize).toBe(0);
  expect(stats.dataSize).toBe(plan.frames * frameSize);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await importProject(page, masterMixProject());
});

test('applies Master 1 / 0.5 / 0 to deterministic WAV output', async ({ page }) => {
  const project = masterMixProject();
  await setMasterVolume(page, 1);
  const unity = await exportWav(page);

  await setMasterVolume(page, 0.5);
  const half = await exportWav(page);

  await setMasterVolume(page, 0);
  const silent = await exportWav(page);

  expectPlannedStereoWav(unity, project);
  expect(unity.nonZeroSamples).toBeGreaterThan(0);
  expect(unity.peak).toBeGreaterThan(0);
  expect(unity.rms).toBeGreaterThan(0);

  expectPlannedStereoWav(half, project);
  expect(half.nonZeroSamples).toBeGreaterThan(0);
  expect(half.peak).toBeGreaterThan(0);
  expect(half.peak).toBeLessThan(unity.peak * 0.7);
  const halfRmsRatio = half.rms / unity.rms;
  expect(halfRmsRatio).toBeGreaterThan(0.48);
  expect(halfRmsRatio).toBeLessThan(0.52);

  expectPlannedStereoWav(silent, project);
  expect(half.dataSize).toBe(unity.dataSize);
  expect(silent.dataSize).toBe(unity.dataSize);
  expect(silent.nonZeroSamples).toBe(0);
  expect(silent.peak).toBe(0);
  expect(silent.rms).toBe(0);
});

test('keeps live transport running while Master 0 silences the post-fader meter', async ({
  page,
}) => {
  // Keep natural project completion far outside this test's observation window.
  await importProject(page, masterMixProject({ lengthBars: 4 }));
  const mixer = page.getByRole('region', { name: 'ミキサー' });
  const meter = mixer.getByRole('meter', { name: /マスター レベル/ });
  const position = page.getByLabel('再生位置');

  // Prove the deterministic note is audible, then exercise the live project
  // subscription without rebuilding or restarting the playback session.
  await setMasterVolume(page, 1);
  const positionBeforePlay = await position.textContent();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect
    .poll(() => position.textContent(), { timeout: 3_000 })
    .not.toBe(positionBeforePlay);
  await expect(meter).not.toHaveAttribute('aria-label', /RMS -∞ dB \/ Peak -∞ dB/);

  const positionBeforeFade = await position.textContent();
  await setMasterVolume(page, 0);
  await expect.poll(() => position.textContent()).not.toBe(positionBeforeFade);
  await expect(meter).toHaveAttribute(
    'aria-label',
    'マスター レベル RMS -∞ dB / Peak -∞ dB',
  );
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
});

test('keeps live playback and metering active across a concurrent WAV export', async ({
  page,
}) => {
  const lengthBars = 4;
  const project = masterMixProject({ lengthBars });
  await importProject(page, project);
  await setMasterVolume(page, 1);

  const mixer = page.getByRole('region', { name: 'ミキサー' });
  const meter = mixer.getByRole('meter', { name: /マスター レベル/ });
  const position = page.getByLabel('再生位置');
  const positionBeforePlay = await position.textContent();

  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect
    .poll(() => position.textContent(), { timeout: 3_000 })
    .not.toBe(positionBeforePlay);
  await expect(meter).not.toHaveAttribute('aria-label', /RMS -∞ dB \/ Peak -∞ dB/);

  const positionBeforeExport = await position.textContent();
  const wav = await exportWav(page);
  expectPlannedStereoWav(wav, project);
  expect(wav.nonZeroSamples).toBeGreaterThan(0);

  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect.poll(() => position.textContent()).not.toBe(positionBeforeExport);
  const positionAfterExport = await position.textContent();
  await expect.poll(() => position.textContent()).not.toBe(positionAfterExport);
  await expect(meter).not.toHaveAttribute('aria-label', /RMS -∞ dB \/ Peak -∞ dB/);
});

test('keeps Master controls consistent and renders a muted sound track as PCM silence', async ({
  page,
}) => {
  const mixer = page.getByRole('region', { name: 'ミキサー' });
  const trackList = page.getByRole('navigation', { name: 'トラック一覧' });
  const masterRow = trackList.locator(
    '.track-row:has(button[aria-label="Master トラックを選択"])',
  );
  const mixerMaster = mixer.locator('.mix-ch.is-master');

  await expect(masterRow).toHaveCount(1);
  await expect(masterRow).toBeVisible();
  await expect(mixerMaster).toHaveCount(1);
  await expect(mixerMaster).toBeVisible();
  await expect(mixer.getByLabel('Master 音量')).toHaveAttribute('max', '2');
  await expect(trackList.getByLabel('Master 音量')).toHaveAttribute('max', '2');
  await expect(masterRow.locator('.track-row__controls button')).toHaveCount(0);
  await expect(
    mixerMaster.locator(
      '.mix-ch__buttons button, button[title="ミュート"], button[title="ソロ"]',
    ),
  ).toHaveCount(0);
  await expect(mixer.getByLabel('Master パン')).toHaveCount(0);
  await expect(trackList.getByLabel('Master パン')).toHaveCount(0);

  const mutedProject = masterMixProject({ instrumentMuted: true });
  await importProject(page, mutedProject);
  const muted = await exportWav(page);
  expectPlannedStereoWav(muted, mutedProject);
  const songFrames = Math.ceil(
    mutedProject.lengthBars * 4 * (60 / mutedProject.bpm) * EXPECTED_WAV_SAMPLE_RATE,
  );
  expect(muted.dataSize).toBe(
    songFrames * EXPECTED_WAV_CHANNELS * WAV_BYTES_PER_SAMPLE,
  );
  expect(muted.nonZeroSamples).toBe(0);
  expect(muted.peak).toBe(0);
  expect(muted.rms).toBe(0);
});
