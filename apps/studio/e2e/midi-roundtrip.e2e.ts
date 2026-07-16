import { expect, test, type Page } from '@playwright/test';
import { CURRENT_SCHEMA_VERSION, type Project } from '@cts/project-model';
import {
  panToCc,
  parseMidiFile,
  projectToMidi,
  volumeToCc,
} from '@cts/midi-io';

const SOURCE_BPM = 90;
const TARGET_BPM = 120;
const SOURCE_TRACKS = [
  { name: '往復ドラム🥁', volume: 0.5, pan: -0.5 },
  { name: '主旋律α', volume: 1.25, pan: 0.25 },
  { name: '低音ベースβ', volume: 1.7, pan: 0.6 },
] as const;

type MidiReadGateWindow = Window & {
  __ctsMidiReadPending?: boolean;
  __ctsReleaseMidiRead?: () => void;
};

async function installMidiReadGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as MidiReadGateWindow;
    const readArrayBuffer = File.prototype.arrayBuffer;
    let delayed = false;

    File.prototype.arrayBuffer = async function gatedArrayBuffer(): Promise<ArrayBuffer> {
      if (delayed) return readArrayBuffer.call(this);
      delayed = true;
      state.__ctsMidiReadPending = true;
      await new Promise<void>((resolve) => {
        state.__ctsReleaseMidiRead = resolve;
      });
      state.__ctsMidiReadPending = false;
      delete state.__ctsReleaseMidiRead;
      return readArrayBuffer.call(this);
    };
  });
}

function displayedVolumeAfterMidiCc(volume: number): number {
  const importedVolume = (volumeToCc(volume) / 127) * 2;
  return Math.round(importedVolume * 100) / 100;
}

function sourceProject(): Project {
  return {
    id: 'midi-roundtrip-source',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: '往復テスト🎼',
    bpm: SOURCE_BPM,
    timeSignature: [3, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 3,
    tempoMap: [{ id: 'tempo-midi-roundtrip', beat: 0, bpm: SOURCE_BPM }],
    timeSignatureMap: [{
      id: 'signature-midi-roundtrip',
      beat: 0,
      numerator: 3,
      denominator: 4,
    }],
    audioAssets: [],
    automationLanes: [],
    audioRouting: {
      outputs: [
        { sourceTrackId: 'source-drums', destination: { type: 'master' } },
        { sourceTrackId: 'source-lead', destination: { type: 'master' } },
        { sourceTrackId: 'source-bass', destination: { type: 'master' } },
      ],
      sends: [],
    },
    tracks: [
      {
        id: 'source-drums',
        name: SOURCE_TRACKS[0].name,
        type: 'drum',
        role: 'general',
        clips: [
          {
            id: 'source-drum-clip',
            trackId: 'source-drums',
            type: 'drum',
            startBeat: 0,
            lengthBeats: 3,
            loop: false,
            stepsPerBar: 16,
            drumEvents: [
              { id: 'source-kick', lane: 'kick', stepIndex: 0, velocity: 100 },
              { id: 'source-snare', lane: 'snare', stepIndex: 4, velocity: 90 },
            ],
          },
        ],
        volume: SOURCE_TRACKS[0].volume,
        pan: SOURCE_TRACKS[0].pan,
        mute: false,
        solo: false,
        instrument: { type: 'drumkit', preset: 'standard' },
        effects: [],
      },
      {
        id: 'source-lead',
        name: SOURCE_TRACKS[1].name,
        type: 'instrument',
        role: 'general',
        clips: [
          {
            id: 'source-lead-clip',
            trackId: 'source-lead',
            type: 'midi',
            startBeat: 0,
            lengthBeats: 3,
            loop: false,
            notes: [
              {
                id: 'source-lead-note',
                pitch: 60,
                startBeat: 0,
                durationBeats: 1,
                velocity: 88,
              },
            ],
          },
        ],
        volume: SOURCE_TRACKS[1].volume,
        pan: SOURCE_TRACKS[1].pan,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'softKeys' },
        effects: [],
      },
      {
        id: 'source-bass',
        name: SOURCE_TRACKS[2].name,
        type: 'instrument',
        role: 'general',
        clips: [
          {
            id: 'source-bass-clip',
            trackId: 'source-bass',
            type: 'midi',
            startBeat: 0,
            lengthBeats: 3,
            loop: false,
            notes: [
              {
                id: 'source-bass-note',
                pitch: 48,
                startBeat: 1.5,
                durationBeats: 0.5,
                velocity: 76,
              },
            ],
          },
        ],
        volume: SOURCE_TRACKS[2].volume,
        pan: SOURCE_TRACKS[2].pan,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'warmBass' },
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

test('round-trips a multi-track MIDI into the current song without replacing its tempo', async ({
  page,
}) => {
  const source = sourceProject();
  expect(source.tracks.map((track) => track.name)).toEqual(
    SOURCE_TRACKS.map((track) => track.name),
  );
  expect(source.chordTrack).toEqual([]);

  const midi = projectToMidi(source);
  const parsed = parseMidiFile(midi);
  const noteTracks = parsed.tracks.filter((track) => track.notes.length > 0);

  expect(parsed.format).toBe(1);
  expect(parsed.tempoBpm).toBeCloseTo(SOURCE_BPM, 3);
  expect(parsed.timeSignatures).toEqual([
    { tick: 0, numerator: 3, denominator: 4 },
  ]);
  expect(parsed.markers).toEqual([]);
  expect(noteTracks.map((track) => track.name)).toEqual(
    SOURCE_TRACKS.map((track) => track.name),
  );
  expect(noteTracks.reduce((total, track) => total + track.notes.length, 0)).toBe(4);
  expect(noteTracks[0]?.notes).toEqual([
    expect.objectContaining({ channel: 9, pitch: 36, durationBeat: 0.25 }),
    expect.objectContaining({ channel: 9, pitch: 38, durationBeat: 0.25 }),
  ]);

  noteTracks.forEach((track, index) => {
    const sourceTrack = SOURCE_TRACKS[index]!;
    expect(track.initialChannels).toEqual([
      expect.objectContaining({
        volumeCc: volumeToCc(sourceTrack.volume),
        panCc: panToCc(sourceTrack.pan),
      }),
    ]);
  });

  await installMidiReadGate(page);
  await page.goto('/');
  await dismissOnboarding(page);
  await expect(page.getByLabel('BPM', { exact: true })).toHaveValue(String(TARGET_BPM));

  await page.getByRole('button', { name: '☰ プロジェクト', exact: true }).click();
  const projectDialog = page.getByRole('dialog', { name: 'プロジェクト', exact: true });
  await expect(projectDialog).toBeVisible();
  await expect(projectDialog.getByText(
    '.midファイルのパートとチャンネルを新しいトラックとして追加します。現在の曲のテンポと拍子は変更しません。',
    { exact: true },
  )).toBeVisible();
  await expect(projectDialog.getByText(
    'アプリの曲を正確に移す場合は、プロジェクトファイル（.ctsproj.json）を使ってください。',
    { exact: true },
  )).toBeVisible();

  await projectDialog.locator('input[type="file"][accept*=".mid"]').setInputFiles({
    name: 'unicode-roundtrip.mid',
    mimeType: 'audio/midi',
    buffer: Buffer.from(midi),
  });

  await expect.poll(() => page.evaluate(
    () => Boolean((window as MidiReadGateWindow).__ctsMidiReadPending),
  )).toBe(true);
  const closeButton = projectDialog.getByRole('button', { name: '閉じる', exact: true });
  await expect(closeButton).toBeDisabled();
  await expect(projectDialog).toHaveAttribute('aria-busy', 'true');
  await expect(projectDialog.getByLabel('プロジェクト名を変更', { exact: true })).toBeDisabled();
  await expect(projectDialog.getByRole('tab', { name: '新規プロジェクト', exact: true }))
    .toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(projectDialog).toBeVisible();
  await page.locator('.dialog-backdrop').filter({ has: projectDialog }).click({
    position: { x: 2, y: 2 },
  });
  await expect(projectDialog).toBeVisible();

  await page.evaluate(() => {
    (window as MidiReadGateWindow).__ctsReleaseMidiRead?.();
  });

  const notices = page.getByLabel('お知らせ', { exact: true });
  await expect(notices.getByText(
    'MIDIを読み込みました。3トラック・4音を追加しました。',
    { exact: true },
  )).toBeVisible();
  await expect(notices.getByText(
    'MIDIは約90 BPMですが、現在の曲の120 BPMを維持しました。（ほか1件）',
    { exact: true },
  )).toBeVisible();

  const importResult = projectDialog.locator('.project-menu__import-result');
  await expect(importResult).toBeVisible();
  await expect(closeButton).toBeEnabled();
  await expect(projectDialog).not.toHaveAttribute('aria-busy', 'true');
  await expect(projectDialog.getByLabel('プロジェクト名を変更', { exact: true })).toBeEnabled();
  await expect(projectDialog.getByRole('tab', { name: '新規プロジェクト', exact: true }))
    .toBeEnabled();
  await expect(importResult.getByText('3トラック・4音を追加しました。', { exact: true }))
    .toBeVisible();
  await expect(importResult.getByRole('listitem')).toHaveText([
    'MIDIは約90 BPMですが、現在の曲の120 BPMを維持しました。',
    'MIDIは3/4拍子ですが、現在の曲の4/4拍子を維持しました。',
  ]);
  await importResult.getByRole('button', { name: '閉じて編集を続ける', exact: true }).click();
  await expect(projectDialog).toBeHidden();

  const trackList = page.getByRole('navigation', { name: 'トラック一覧', exact: true });
  for (const sourceTrack of SOURCE_TRACKS) {
    await expect(trackList.getByRole('button', {
      name: `${sourceTrack.name} トラックを選択`,
      exact: true,
    })).toBeVisible();
    await expect.poll(async () => Number(
      await trackList.getByLabel(`${sourceTrack.name} 音量`, { exact: true }).inputValue(),
    )).toBeCloseTo(displayedVolumeAfterMidiCc(sourceTrack.volume), 6);
  }

  const selectedDrumRow = trackList
    .getByRole('button', {
      name: `${SOURCE_TRACKS[0].name} トラックを選択`,
      exact: true,
    })
    .locator('..');
  await expect(selectedDrumRow).toHaveClass(/is-selected/);
  await expect(page.getByRole('button', {
    name: '小節 1、キック ステップ 1 強さ 100 確率 100%',
    exact: true,
  })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', {
    name: '小節 1、スネア ステップ 4 強さ 90 確率 100%',
    exact: true,
  })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('BPM', { exact: true })).toHaveValue(String(TARGET_BPM));
});
