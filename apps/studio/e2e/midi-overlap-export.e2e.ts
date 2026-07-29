import { expect, test } from '@playwright/test';
import { CURRENT_SCHEMA_VERSION, validateProject, type Project } from '@cts/project-model';

function overlappingProject(): Project {
  const timestamp = '2026-07-12T00:00:00.000Z';
  return {
    id: 'midi-overlap-e2e',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: 'MIDI Overlap Safety',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    lengthBeats: 4,
    tempoMap: [{ id: 'tempo-overlap', beat: 0, bpm: 120 }],
    timeSignatureMap: [{
      id: 'signature-overlap',
      beat: 0,
      numerator: 4,
      denominator: 4,
    }],
    audioAssets: [],
    audioTakeFolders: [],
    automationLanes: [],
    audioRouting: {
      outputs: [{ sourceTrackId: 'lead', destination: { type: 'master' } }],
      sends: [],
    },
    tracks: [
      {
        id: 'lead',
        name: 'Lead',
        type: 'instrument',
        role: 'general',
        clips: [{
          id: 'lead-clip',
          trackId: 'lead',
          type: 'midi',
          startBeat: 0,
          lengthBeats: 4,
          loop: false,
          notes: [
            { id: 'outer', pitch: 60, startBeat: 0, durationBeats: 2, velocity: 100 },
            { id: 'inner', pitch: 60, startBeat: 1, durationBeats: 0.5, velocity: 70 },
          ],
        }],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'softKeys' },
        effects: [],
      },
      {
        id: 'master',
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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test('ambiguous same-pitch overlap fails before a browser MIDI file is published', async ({
  page,
}) => {
  const project = overlappingProject();
  expect(validateProject(project).ok).toBe(true);
  const pageErrors: string[] = [];
  let downloadCount = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('download', () => { downloadCount += 1; });

  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();

  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  await dialog.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: 'midi-overlap.ctsproj.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  await dialog.getByRole('button', { name: 'MIDIエクスポート', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText(
    '同じ音程のノートが重なっているためMIDIを書き出せません',
  );
  await expect(dialog.getByRole('button', { name: 'MIDIエクスポート', exact: true }))
    .toBeEnabled();
  expect(downloadCount).toBe(0);
  expect(pageErrors).toEqual([]);
});
