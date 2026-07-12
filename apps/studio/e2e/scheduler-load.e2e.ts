import { expect, test, type Page } from '@playwright/test';
import {
  CURRENT_SCHEMA_VERSION,
  MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
  MAX_RUNTIME_SCHEDULE_EVENTS,
  preflightScheduleEventBudget,
  RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
  validateProject,
  type Clip,
  type NoteEvent,
  type Project,
} from '@cts/project-model';

const STRESS_TITLE = 'Scheduler 20k Load';
const SOURCE_NOTE_COUNT = 200;
const INSTANCE_COUNT = 100;
const SOURCE_LENGTH_BEATS = 81.25;

function schedulerLoadProject(): Project {
  const timestamp = '2026-07-12T00:00:00.000Z';
  const trackId = 'scheduler-stress-track';
  const notes = Array.from({ length: SOURCE_NOTE_COUNT }, (_, index): NoteEvent => ({
    id: `scheduler-stress-note-${index}`,
    pitch: 60 + (index % 12),
    startBeat: index * (13 / 32),
    durationBeats: 1 / 32,
    velocity: 72,
  }));
  const source: Clip = {
    id: 'scheduler-stress-source',
    trackId,
    type: 'midi',
    startBeat: 0,
    lengthBeats: SOURCE_LENGTH_BEATS,
    loop: false,
    notes,
  };
  const aliases = Array.from({ length: INSTANCE_COUNT - 1 }, (_, index): Clip => ({
    id: `scheduler-stress-alias-${index + 1}`,
    trackId,
    type: 'midi',
    startBeat: (index + 1) * SOURCE_LENGTH_BEATS,
    lengthBeats: SOURCE_LENGTH_BEATS,
    loop: false,
    aliasOf: source.id,
  }));

  return {
    id: 'scheduler-stress-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: STRESS_TITLE,
    bpm: 300,
    timeSignature: [32, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 256,
    tracks: [
      // Keep the selected first track payload-free so this test isolates the
      // scheduler from rendering thousands of piano-roll DOM nodes.
      {
        id: 'scheduler-stress-master',
        name: 'Master',
        type: 'master',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
      {
        id: trackId,
        name: 'Scheduler Stress',
        type: 'instrument',
        clips: [source, ...aliases],
        volume: 0.1,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'softKeys' },
        effects: [],
      },
    ],
    chordTrack: [],
    sections: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function shortLoopDensityProject(noteCount: number): Project {
  const timestamp = '2026-07-12T00:00:00.000Z';
  const trackId = 'short-loop-track';
  return {
    id: `short-loop-${noteCount}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title: `Short Loop ${noteCount}`,
    bpm: 300,
    timeSignature: [1, 16],
    key: 'C',
    scale: 'major',
    lengthBars: 1,
    tracks: [
      {
        id: 'short-loop-master',
        name: 'Master',
        type: 'master',
        clips: [],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
      {
        id: trackId,
        name: 'Short Loop Notes',
        type: 'instrument',
        clips: [{
          id: 'short-loop-clip',
          trackId,
          type: 'midi',
          startBeat: 0,
          lengthBeats: 0.25,
          loop: false,
          notes: Array.from({ length: noteCount }, (_, index) => ({
            id: `short-loop-note-${index}`,
            pitch: 60 + (index % 12),
            startBeat: 0,
            durationBeats: 1 / 960,
            velocity: 72,
          })),
        }],
        volume: 0.1,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'softKeys' },
        effects: [],
      },
    ],
    chordTrack: [],
    sections: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function dismissOnboarding(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: 'ようこそ' });
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'あとで', exact: true }).click();
  }
}

async function importProject(page: Page, project: Project, fileName: string): Promise<void> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  await dialog.locator('input[type="file"][accept*=".json"]').setInputFiles({
    name: fileName,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(dialog).toBeHidden();
}

test('production Chromium stays responsive at the 20,000-event live ceiling', async ({
  page,
}) => {
  const project = schedulerLoadProject();
  expect(validateProject(project).ok).toBe(true);
  expect(preflightScheduleEventBudget(project, {
    limit: MAX_RUNTIME_SCHEDULE_EVENTS,
    projection: 'audible',
    density: {
      windowBeats: RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
      maxEventsPerWindow: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
    },
  })).toEqual({
    ok: true,
    eventCount: SOURCE_NOTE_COUNT * INSTANCE_COUNT,
    limit: MAX_RUNTIME_SCHEDULE_EVENTS,
  });

  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
  });

  await page.goto('/');
  await dismissOnboarding(page);
  await importProject(page, project, 'scheduler-20k-load.ctsproj.json');
  await expect(page.getByRole('textbox', { name: 'プロジェクト名', exact: true }))
    .toHaveValue(STRESS_TITLE);
  await expect(page.getByLabel('BPM', { exact: true })).toHaveValue('300');

  const position = page.getByLabel('再生位置');
  const observedPositions = new Set<string>();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const pause = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(pause).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#transport-playback-status')).toHaveText('再生中です。');
  await expect.poll(async () => {
    observedPositions.add((await position.textContent())?.trim() ?? '');
    return observedPositions.size;
  }, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);

  await pause.click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(page.locator('#transport-playback-status'))
    .toHaveText('再生は停止しています。');
  await expect(page.getByRole('alert').filter({ hasText: '再生イベントが多すぎます' }))
    .toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('short loops fail closed before recurrence can exceed live density', async ({ page }) => {
  const project = shortLoopDensityProject(86);
  expect(validateProject(project).ok).toBe(true);
  expect(preflightScheduleEventBudget(project, {
    limit: MAX_RUNTIME_SCHEDULE_EVENTS,
    projection: 'audible',
    density: {
      windowBeats: RUNTIME_SCHEDULE_DENSITY_WINDOW_BEATS,
      maxEventsPerWindow: MAX_RUNTIME_EVENTS_PER_DENSITY_WINDOW,
    },
  })).toEqual({
    ok: true,
    eventCount: 86,
    limit: MAX_RUNTIME_SCHEDULE_EVENTS,
  });

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await dismissOnboarding(page);
  await importProject(page, project, 'short-loop-density.ctsproj.json');

  const loop = page.getByRole('button', { name: 'ループ', exact: true });
  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '再生', exact: true }).click();

  await expect(page.getByRole('alert').filter({ hasText: '再生イベントが多すぎます' }))
    .toBeVisible();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await expect(page.locator('#transport-playback-status'))
    .toHaveText('再生は停止しています。');
  expect(pageErrors).toEqual([]);
});
