import { expect, test, type Download, type Page } from '@playwright/test';
import { CURRENT_SCHEMA_VERSION, type Project } from '@cts/project-model';

const FIXTURE_TITLE = 'Drum Determinism E2E';
const ORIGINAL_GROOVE_SEED = 42_424;
const ALTERNATE_GROOVE_SEED = 42_425;

type PcmWav = Readonly<{
  bytes: Buffer;
  dataOffset: number;
  dataSize: number;
  nonZeroSamples: number;
}>;

function drumOnlyProject(grooveSeed: number): Project {
  return {
    id: 'project-drum-determinism',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: FIXTURE_TITLE,
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'tempo-drum-determinism', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'signature-drum-determinism',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    automationLanes: [],
    tracks: [
      {
        id: 'track-deterministic-drums',
        name: 'Deterministic Drums',
        type: 'drum',
        role: 'general',
        clips: [
          {
            id: 'clip-deterministic-drums',
            trackId: 'track-deterministic-drums',
            type: 'drum',
            startBeat: 0,
            lengthBeats: 4,
            loop: false,
            stepsPerBar: 16,
            // Keep the event plan fixed so changing this seed isolates the
            // deterministic per-voice noise offset rather than hit selection,
            // onset, or velocity changes.
            drumGroove: {
              swing: 0,
              probability: 1,
              humanizeVelocity: 0,
              seed: grooveSeed,
            },
            drumEvents: [
              { id: 'kick-0', lane: 'kick', stepIndex: 0, velocity: 96 },
              { id: 'closed-hat-2', lane: 'closedHat', stepIndex: 2, velocity: 72 },
              { id: 'snare-4', lane: 'snare', stepIndex: 4, velocity: 88 },
              { id: 'clap-6', lane: 'clap', stepIndex: 6, velocity: 76 },
              { id: 'open-hat-8', lane: 'openHat', stepIndex: 8, velocity: 70 },
              { id: 'closed-hat-10', lane: 'closedHat', stepIndex: 10, velocity: 68 },
              { id: 'kick-12', lane: 'kick', stepIndex: 12, velocity: 92 },
              { id: 'snare-14', lane: 'snare', stepIndex: 14, velocity: 84 },
            ],
          },
        ],
        volume: 0.6,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'drumkit', preset: 'basic' },
        effects: [],
      },
      {
        id: 'track-master',
        name: 'Master',
        type: 'master',
        role: 'general',
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
    name: 'drum-determinism-fixture.ctsproj.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'プロジェクト名', exact: true }))
    .toHaveValue(project.title);
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportWav(page: Page): Promise<PcmWav> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: '書き出し / 読み込み',
    exact: true,
  });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'WAVエクスポート', exact: true }).click();
  const bytes = await readDownload(await downloadPromise);
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  return inspectPcmWav(bytes);
}

function inspectPcmWav(bytes: Buffer): PcmWav {
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);

  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset: number | null = null;
  let dataSize: number | null = null;

  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const chunkId = bytes.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkSize > bytes.length) {
      throw new Error(`WAV chunk ${chunkId} exceeds the downloaded file`);
    }
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = bytes.readUInt16LE(payloadOffset);
      channels = bytes.readUInt16LE(payloadOffset + 2);
      sampleRate = bytes.readUInt32LE(payloadOffset + 4);
      bitsPerSample = bytes.readUInt16LE(payloadOffset + 14);
    } else if (chunkId === 'data') {
      dataOffset = payloadOffset;
      dataSize = chunkSize;
    }
    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    channels !== 2 ||
    sampleRate !== 44_100 ||
    bitsPerSample !== 16 ||
    dataOffset === null ||
    dataSize === null ||
    dataSize <= 0
  ) {
    throw new Error('Expected a complete stereo 44.1 kHz 16-bit PCM WAV');
  }

  let nonZeroSamples = 0;
  for (let offset = dataOffset; offset + 2 <= dataOffset + dataSize; offset += 2) {
    if (bytes.readInt16LE(offset) !== 0) nonZeroSamples += 1;
  }

  return { bytes, dataOffset, dataSize, nonZeroSamples };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
  await importProject(page, drumOnlyProject(ORIGINAL_GROOVE_SEED));
});

test('re-exports identical seeded drum PCM and changes it for a different seed', async ({
  page,
}) => {
  const first = await exportWav(page);
  const second = await exportWav(page);

  expect(first.nonZeroSamples).toBeGreaterThan(0);
  expect(second.nonZeroSamples).toBe(first.nonZeroSamples);
  expect(second.dataOffset).toBe(first.dataOffset);
  expect(second.dataSize).toBe(first.dataSize);
  expect(Buffer.compare(second.bytes, first.bytes)).toBe(0);

  await importProject(page, drumOnlyProject(ALTERNATE_GROOVE_SEED));
  const alternate = await exportWav(page);

  expect(alternate.nonZeroSamples).toBeGreaterThan(0);
  expect(alternate.dataOffset).toBe(first.dataOffset);
  expect(alternate.dataSize).toBe(first.dataSize);
  expect(Buffer.compare(alternate.bytes, first.bytes)).not.toBe(0);
  expect(
    Buffer.compare(
      alternate.bytes.subarray(
        alternate.dataOffset,
        alternate.dataOffset + alternate.dataSize,
      ),
      first.bytes.subarray(first.dataOffset, first.dataOffset + first.dataSize),
    ),
  ).not.toBe(0);
});
