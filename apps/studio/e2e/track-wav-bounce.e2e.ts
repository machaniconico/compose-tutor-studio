import { expect, test, type Download, type Page } from '@playwright/test';
import { CURRENT_SCHEMA_VERSION, type Project } from '@cts/project-model';

const SELECTED_ID = 'track-selected';
const OTHER_ID = 'track-other';
const SELECTED_NAME = 'Lead:One';

function bounceProject(options: {
  normalizedReference?: boolean;
  sendGain?: number;
} = {}): Project {
  const normalized = options.normalizedReference ?? false;
  return {
    id: 'project-track-bounce-e2e',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'Track/Bounce E2E',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [
      { id: 'tempo-0', beat: 0, bpm: 120 },
      { id: 'tempo-1', beat: 2, bpm: 90 },
    ],
    timeSignatureMap: [{
      id: 'signature-0',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    audioTakeFolders: [],
    automationLanes: [
      {
        id: 'selected-volume',
        bypassed: false,
        target: { type: 'track-volume', trackId: SELECTED_ID },
        points: [
          { id: 'selected-volume-0', beat: 0, value: 0.55, interpolation: 'hold' },
          { id: 'selected-volume-1', beat: 2, value: 0.35, interpolation: 'linear' },
        ],
      },
      {
        id: 'wet-bus-pan',
        bypassed: false,
        target: { type: 'track-pan', trackId: 'bus-wet' },
        points: [
          { id: 'wet-pan-0', beat: 0, value: -0.4, interpolation: 'hold' },
          { id: 'wet-pan-1', beat: 2, value: 0.4, interpolation: 'linear' },
        ],
      },
    ],
    automationReadState: { globalEnabled: true, disabledTrackIds: [] },
    audioRouting: {
      outputs: [
        { sourceTrackId: SELECTED_ID, destination: { type: 'bus', trackId: 'bus-dry' } },
        { sourceTrackId: OTHER_ID, destination: { type: 'master' } },
        { sourceTrackId: 'bus-dry', destination: { type: 'master' } },
        { sourceTrackId: 'bus-wet', destination: { type: 'master' } },
      ],
      sends: [{
        id: 'selected-wet',
        sourceTrackId: SELECTED_ID,
        targetBusId: 'bus-wet',
        position: 'pre-fader',
        gain: options.sendGain ?? 0.35,
        enabled: true,
      }],
    },
    tracks: [
      {
        id: SELECTED_ID,
        name: SELECTED_NAME,
        type: 'instrument',
        role: 'general',
        clips: [{
          id: 'clip-selected',
          trackId: SELECTED_ID,
          type: 'midi',
          startBeat: 0,
          lengthBeats: 4,
          loop: false,
          notes: [{
            id: 'note-selected',
            pitch: 48,
            startBeat: 0,
            durationBeats: 3.5,
            velocity: 72,
          }],
        }],
        volume: 0.55,
        pan: -0.1,
        mute: !normalized,
        solo: normalized,
        instrument: { type: 'synth', preset: 'warmBass' },
        effects: [{
          id: 'selected-filter',
          type: 'filter',
          enabled: true,
          params: { cutoff: 2_400, resonance: 0.2 },
        }],
      },
      {
        id: OTHER_ID,
        name: 'Other Track',
        type: 'instrument',
        role: 'general',
        clips: normalized ? [] : [{
          id: 'clip-other',
          trackId: OTHER_ID,
          type: 'midi',
          startBeat: 0,
          lengthBeats: 4,
          loop: false,
          notes: [{
            id: 'note-other',
            pitch: 72,
            startBeat: 0,
            durationBeats: 3.5,
            velocity: 100,
          }],
        }],
        volume: 0.7,
        pan: 0.25,
        mute: false,
        solo: !normalized,
        instrument: { type: 'synth', preset: 'brightLead' },
        effects: [],
      },
      {
        id: 'bus-dry',
        name: 'Muted Dry Bus',
        type: 'bus',
        role: 'general',
        clips: [],
        volume: 0.8,
        pan: 0,
        mute: !normalized,
        solo: false,
        effects: [],
      },
      {
        id: 'bus-wet',
        name: 'Muted Wet Bus',
        type: 'bus',
        role: 'general',
        clips: [],
        volume: 0.65,
        pan: 0,
        mute: !normalized,
        solo: false,
        effects: [{
          id: 'wet-filter',
          type: 'filter',
          enabled: true,
          params: { cutoff: 1_600, resonance: 0.35 },
        }],
      },
      {
        id: 'track-master',
        name: 'Master',
        type: 'master',
        role: 'general',
        clips: [],
        volume: 0.7,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
    chordTrack: [],
    sections: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
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
  const dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  await dialog.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: 'track-bounce-fixture.ctsproj.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(dialog).toBeHidden();
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportFromDialog(
  page: Page,
  buttonName: 'WAVエクスポート' | '選択トラックをWAV' | 'プロジェクト書き出し',
): Promise<{ bytes: Buffer; suggestedFilename: string }> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: buttonName, exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readDownload(download);
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  return { bytes, suggestedFilename: download.suggestedFilename() };
}

function pcmSamples(wav: Buffer): Int16Array {
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const chunkId = wav.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = wav.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkSize > wav.length) throw new Error('Invalid WAV chunk length');
    if (chunkId === 'data') {
      const data = wav.subarray(payloadOffset, payloadOffset + chunkSize);
      return new Int16Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
    }
    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }
  throw new Error('WAV data chunk missing');
}

function expectPcmEqualWithinOneLsb(actual: Buffer, expected: Buffer): void {
  expect(actual.length).toBe(expected.length);
  expect(actual.subarray(0, 44)).toEqual(expected.subarray(0, 44));

  const actualSamples = pcmSamples(actual);
  const expectedSamples = pcmSamples(expected);
  expect(actualSamples.length).toBe(expectedSamples.length);

  let differingSamples = 0;
  let maxAbsoluteDelta = 0;
  for (let index = 0; index < actualSamples.length; index += 1) {
    const absoluteDelta = Math.abs(actualSamples[index]! - expectedSamples[index]!);
    if (absoluteDelta > 0) differingSamples += 1;
    maxAbsoluteDelta = Math.max(maxAbsoluteDelta, absoluteDelta);
  }

  // OfflineAudioContext summation can cross the PCM16 rounding boundary for
  // a sparse set of samples on different OS/CPU combinations. Keep at least
  // 99.95% bit-identical while requiring every remaining sample within 1 LSB.
  expect(differingSamples / Math.max(1, actualSamples.length))
    .toBeLessThanOrEqual(0.0005);
  expect(maxAbsoluteDelta).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await dismissOnboarding(page);
});

test('selected Track WAV bounce is offered with its scope explained', async ({ page }) => {
  await importProject(page, bounceProject());
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  await expect(page.getByText('選択トラックをWAV')).toBeVisible();
  await expect(page.getByText(/楽器・ドラム・オーディオに対応/)).toBeVisible();
  await expect(page.getByText(/保存済みのミュート／ソロは無視/)).toBeVisible();
  await expect(page.getByText(/加算しても元のミックス/)).toBeVisible();
});

test('downloads immutable routed PCM equal to a normalized solo reference', async ({ page }) => {
  const original = bounceProject();
  await importProject(page, original);
  const selectedControl = page.getByRole('button', {
    name: `${SELECTED_NAME} トラックを選択`,
    exact: true,
  });
  await selectedControl.click();
  await expect(selectedControl).toHaveAttribute('aria-pressed', 'true');

  const before = await exportFromDialog(page, 'プロジェクト書き出し');
  const fullMix = await exportFromDialog(page, 'WAVエクスポート');
  const selected = await exportFromDialog(page, '選択トラックをWAV');
  const after = await exportFromDialog(page, 'プロジェクト書き出し');

  expect(selected.suggestedFilename).toBe('Track_Bounce_E2E - Lead_One.wav');
  expect(after.bytes).toEqual(before.bytes);
  await expect(selectedControl).toHaveAttribute('aria-pressed', 'true');
  const selectedPcm = pcmSamples(selected.bytes);
  expect([...selectedPcm].some((sample) => sample !== 0)).toBe(true);
  expect(selected.bytes).not.toEqual(fullMix.bytes);

  await page.getByRole('button', {
    name: 'Other Track トラックを選択',
    exact: true,
  }).click();
  const other = await exportFromDialog(page, '選択トラックをWAV');
  expect(selected.bytes).not.toEqual(other.bytes);

  await importProject(page, bounceProject({ normalizedReference: true }));
  const normalized = await exportFromDialog(page, 'WAVエクスポート');
  expectPcmEqualWithinOneLsb(selected.bytes, normalized.bytes);

  await importProject(page, bounceProject({ sendGain: 1.5 }));
  const changedSend = await exportFromDialog(page, '選択トラックをWAV');
  expect(selected.bytes).not.toEqual(changedSend.bytes);
});
