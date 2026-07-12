import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CURRENT_SCHEMA_VERSION } from '@cts/project-model';

const COARSE_ROW_HEIGHT = 24;

async function dismissWelcome(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('dialog', { name: 'ようこそ' })
    .getByRole('button', { name: 'あとで', exact: true })
    .click();
}

type FixtureNote = Readonly<{
  id: string;
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
}>;

type VisualPosition = Readonly<{ left: number; top: number }>;

async function activeNotePosition(page: Page): Promise<VisualPosition | null> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active?.classList.contains('pr__note')) return null;
    return {
      left: Number.parseFloat(active.style.left),
      top: Number.parseFloat(active.style.top),
    };
  });
}

async function effectiveHitSize(target: Locator): Promise<{ width: number; height: number }> {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hitStyle = getComputedStyle(element, '::before');
    const hitWidth = Number.parseFloat(hitStyle.width);
    const hitHeight = Number.parseFloat(hitStyle.height);
    return {
      width: Math.max(rect.width, Number.isFinite(hitWidth) ? hitWidth : 0),
      height: Math.max(rect.height, Number.isFinite(hitHeight) ? hitHeight : 0),
    };
  });
}

async function importProjectFile(page: Page, path: string): Promise<void> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  await dialog.locator('input[type="file"][accept*=".json"]').setInputFiles(path);
  await expect(dialog).toBeHidden();
}

async function exportProjectFile(page: Page, outputPath: string): Promise<Record<string, unknown>> {
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '書き出し / 読み込み', exact: true });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'プロジェクト書き出し', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(outputPath);
  const project = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>;
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  return project;
}

function pianoRollProject(
  id: string,
  title: string,
  notes: readonly FixtureNote[],
): Record<string, unknown> {
  const timestamp = '2026-07-11T00:00:00.000Z';
  const melodyTrackId = `${id}-melody-track`;
  return {
    id,
    schemaVersion: 1,
    title,
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    tracks: [
      {
        id: melodyTrackId,
        name: 'Melody',
        type: 'instrument',
        color: '#6f9bd8',
        clips: [
          {
            id: `${id}-melody-clip`,
            trackId: melodyTrackId,
            type: 'midi',
            startBeat: 0,
            lengthBeats: 32,
            loop: false,
            notes: notes.map((note) => ({ ...note })),
          },
        ],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        instrument: { type: 'synth', preset: 'lead' },
        effects: [],
      },
      {
        id: `${id}-master-track`,
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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function outOfVisibleRangeProject(): Record<string, unknown> {
  const project = pianoRollProject('project-outside-visible-range', 'Out of visible range', [
    {
      id: 'note-below-visible-range',
      pitch: 0,
      startBeat: 0,
      durationBeats: 1,
      velocity: 90,
    },
    {
      id: 'note-above-visible-range',
      pitch: 127,
      startBeat: 2,
      durationBeats: 1,
      velocity: 100,
    },
  ]);
  const tracks = project.tracks as Array<{
    clips: Array<Record<string, unknown>>;
  }>;
  // In schema v1 this marker was inert, so migration must drop only the marker
  // while retaining the clip's own note payload.
  tracks[0]!.clips[0]!.aliasOf = 'legacy-inert-alias';
  return project;
}

function manyVisibleNotesProject(): Record<string, unknown> {
  const beats = [...Array.from({ length: 21 }, (_, index) => index), 31];
  // Keep storage order different from musical order so Home/End cannot pass
  // by following DOM insertion order.
  const insertionOrder = [
    ...beats.filter((beat) => beat % 2 === 1).reverse(),
    ...beats.filter((beat) => beat % 2 === 0),
  ];
  return pianoRollProject(
    'project-many-visible-notes',
    'Many visible notes',
    insertionOrder.map((beat) => ({
      id: `note-at-beat-${beat}`,
      pitch: 60 + (beat % 6),
      startBeat: beat,
      durationBeats: 1,
      velocity: 80 + (beat % 40),
    })),
  );
}

function coarsePointerProject(): Record<string, unknown> {
  return pianoRollProject('project-coarse-pointer', 'Coarse pointer notes', [
    {
      id: 'coarse-note-c6',
      pitch: 84,
      startBeat: 0,
      durationBeats: 0.25,
      velocity: 20,
    },
    {
      id: 'coarse-note-b5',
      pitch: 83,
      startBeat: 0,
      durationBeats: 0.25,
      velocity: 100,
    },
  ]);
}

test('22 notes keep one roving tab stop and deterministic keyboard focus navigation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 700, height: 650 });
  const fixturePath = testInfo.outputPath('many-visible-notes.ctsproj.json');
  await writeFile(fixturePath, JSON.stringify(manyVisibleNotesProject()), 'utf8');
  await dismissWelcome(page);
  await importProjectFile(page, fixturePath);
  await page.getByRole('button', { name: 'Melody トラックを選択', exact: true }).click();

  const scroller = page.locator('.pr__scroll');
  const grid = page.locator('.pr__grid');
  const notes = grid.locator('.pr__note');
  await expect(grid).toBeVisible();
  await expect(notes).toHaveCount(22);

  const semantics = await notes.evaluateAll((elements) =>
    elements.map((element) => ({
      tagName: element.tagName,
      pressed: element.getAttribute('aria-pressed'),
      name: element.getAttribute('aria-label')?.trim() ?? '',
      shortcuts: element.getAttribute('aria-keyshortcuts')?.trim() ?? '',
    })),
  );
  for (const contract of semantics) {
    expect(contract.tagName).toBe('BUTTON');
    expect(['true', 'false']).toContain(contract.pressed);
    expect(contract.name).not.toBe('');
    expect(contract.shortcuts).toContain('ArrowLeft');
    expect(contract.shortcuts).toContain('Control+A');
  }

  const ordered = await notes.evaluateAll((elements) =>
    elements
      .map((element) => {
        const style = (element as HTMLElement).style;
        return {
          left: Number.parseFloat(style.left),
          top: Number.parseFloat(style.top),
        };
      })
      .sort((left, right) => left.left - right.left || right.top - left.top),
  );
  const first = ordered[0];
  const previousToLast = ordered[ordered.length - 2];
  const last = ordered[ordered.length - 1];
  expect(first).toBeDefined();
  expect(previousToLast).toBeDefined();
  expect(last).toBeDefined();

  const active = grid.locator('.pr__note[tabindex="0"]');
  await expect(active).toHaveCount(1);
  await notes.first().focus();
  await notes.first().press('Home');
  await expect.poll(() => activeNotePosition(page)).toEqual(first);
  await expect(active).toBeFocused();
  await expect(active).toBeInViewport();
  await expect(grid.getByRole('button', { name: /開始 32 拍目/ })).not.toBeInViewport();

  await active.press('End');
  await expect.poll(() => activeNotePosition(page)).toEqual(last);
  await expect(active).toBeFocused();
  await expect(active).toBeInViewport();
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  await active.press('Shift+PageUp');
  await expect.poll(() => activeNotePosition(page)).toEqual(previousToLast);
  await expect(active).toBeInViewport();
  await active.press('Shift+PageDown');
  await expect.poll(() => activeNotePosition(page)).toEqual(last);
  await expect(active).toBeInViewport();

  await active.evaluate((element) => element.setAttribute('data-edge-focus-anchor', 'true'));
  const focusAnchor = grid.locator('[data-edge-focus-anchor="true"]');
  const beforeMove = await activeNotePosition(page);
  await focusAnchor.press('ArrowLeft');
  await expect(focusAnchor).toBeFocused();
  await expect(focusAnchor).toHaveAttribute('tabindex', '0');
  await expect
    .poll(async () => (await activeNotePosition(page))?.left)
    .toBeLessThan(beforeMove?.left ?? Number.NEGATIVE_INFINITY);
  await expect
    .poll(() => notes.evaluateAll((elements) => elements.filter((element) => element.tabIndex === 0).length))
    .toBe(1);

  await focusAnchor.press('Home');
  await expect.poll(() => activeNotePosition(page)).toEqual(first);
  await expect(active).toBeFocused();
  await expect(active).toBeInViewport();
});

test('valid off-screen MIDI notes leave the grid as the only tab stop and are not command-selected', async ({
  page,
}, testInfo) => {
  const fixturePath = testInfo.outputPath('out-of-visible-range.ctsproj.json');
  await writeFile(fixturePath, JSON.stringify(outOfVisibleRangeProject()), 'utf8');
  await dismissWelcome(page);
  await importProjectFile(page, fixturePath);
  await page.getByRole('button', { name: 'Melody トラックを選択', exact: true }).click();

  const grid = page.locator('.pr__grid');
  const notes = grid.locator('.pr__note');
  const quantize = page.getByRole('button', {
    name: '選択ノートをクオンタイズ',
    exact: true,
  });
  await expect(grid).toBeVisible();
  await expect(notes).toHaveCount(0);
  await expect(page.locator('.pr__velbar')).toHaveCount(0);
  await expect.soft(grid).toHaveAttribute('tabindex', '0');
  await expect
    .soft
    .poll(() =>
      grid.evaluate((element) =>
        [element, ...element.querySelectorAll('.pr__note')].filter(
          (candidate) => (candidate as HTMLElement).tabIndex === 0,
        ).length,
      ),
    )
    .toBe(1);

  await grid.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Meta+a');
  await expect(quantize).toBeDisabled();

  // Import adopts and persists the migrated schema-v2 project. A cold UI
  // restart must restore that canonical form before we export it again.
  await page.reload();
  await expect(page.getByLabel('プロジェクト名')).toHaveValue(
    'Out of visible range',
  );

  const exported = await exportProjectFile(
    page,
    testInfo.outputPath('out-of-visible-range-after-shortcuts.ctsproj.json'),
  );
  expect(exported.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  const tracks = exported.tracks as Array<{
    name: string;
    clips: Array<{
      aliasOf?: string;
      notes?: Array<{ pitch: number; startBeat: number }>;
    }>;
  }>;
  const melodyClips = tracks.find((track) => track.name === 'Melody')?.clips ?? [];
  expect(melodyClips[0]).not.toHaveProperty('aliasOf');
  const pitches = melodyClips
    .flatMap((clip) => clip.notes ?? [])
    .map((note) => note.pitch);
  expect(pitches).toEqual([0, 127]);
});

test('coarse pointer keeps notes inside a row and preserves selection plus focus indicators', async ({
  browser,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('Playwright baseURL is required');
  const fixturePath = testInfo.outputPath('coarse-pointer-notes.ctsproj.json');
  await writeFile(fixturePath, JSON.stringify(coarsePointerProject()), 'utf8');
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    viewport: { width: 900, height: 650 },
  });
  const page = await context.newPage();
  try {
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
    await dismissWelcome(page);
    await importProjectFile(page, fixturePath);
    await page.getByRole('button', { name: 'Melody トラックを選択', exact: true }).click();

    const grid = page.locator('.pr__grid');
    const notes = grid.locator('.pr__note');
    await expect(notes).toHaveCount(2);

    const first = grid.getByRole('button', { name: /^C6。開始 1 拍目/ });
    const second = grid.getByRole('button', { name: /^B5。開始 1 拍目/ });
    await first.scrollIntoViewIfNeeded();
    const firstBox = await first.boundingBox();
    if (!firstBox) throw new Error('先頭のcoarse pointer対象ノートが表示されていません');
    expect(firstBox.width).toBeLessThan(24);

    await page.touchscreen.tap(
      firstBox.x + firstBox.width / 2,
      firstBox.y + firstBox.height / 2,
    );
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(first).toBeFocused();
    await second.scrollIntoViewIfNeeded();
    const secondBox = await second.boundingBox();
    if (!secondBox) throw new Error('次のcoarse pointer対象ノートが表示されていません');
    expect(secondBox.width).toBeLessThan(24);
    await page.touchscreen.tap(
      secondBox.x + secondBox.width / 2,
      secondBox.y + secondBox.height / 2,
    );
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(second).toBeFocused();

    const firstHitSize = await effectiveHitSize(first);
    const secondHitSize = await effectiveHitSize(second);
    for (const hitSize of [firstHitSize, secondHitSize]) {
      expect.soft(hitSize.width).toBeGreaterThanOrEqual(24);
      expect.soft(hitSize.height).toBeGreaterThanOrEqual(24);
    }
    await expect(first).toHaveCSS('touch-action', 'none');
    await expect(second).toHaveCSS('touch-action', 'none');
    expect.soft(await grid.evaluate((element) => getComputedStyle(element).touchAction)).not.toBe(
      'none',
    );

    const quantize = page.getByRole('button', {
      name: '選択ノートをクオンタイズ',
      exact: true,
    });
    await quantize.focus();
    await page.keyboard.press('Tab');
    await expect(second).toBeFocused();
    expect(await second.evaluate((element) => element.matches(':focus-visible'))).toBe(true);

    const geometries = await notes.evaluateAll((elements) =>
      elements.map((element) => {
        const html = element as HTMLElement;
        const style = getComputedStyle(html);
        return {
          height: html.getBoundingClientRect().height,
          top: Number.parseFloat(html.style.top),
          boxShadow: style.boxShadow,
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          outlineOffset: Number.parseFloat(style.outlineOffset),
        };
      }),
    );
    for (const geometry of geometries) {
      expect((geometry.top % COARSE_ROW_HEIGHT) + geometry.height).toBeLessThanOrEqual(
        COARSE_ROW_HEIGHT,
      );
    }
    const focusedGeometry = await second.evaluate((element) => {
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      return {
        boxShadow: style.boxShadow,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        outlineOffset: Number.parseFloat(style.outlineOffset),
      };
    });
    const unselectedBoxShadow = await first.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    );
    expect(focusedGeometry.outlineStyle).not.toBe('none');
    expect(focusedGeometry.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(focusedGeometry.outlineOffset).toBeGreaterThanOrEqual(0);
    expect(focusedGeometry.boxShadow).toContain('inset');
    expect(focusedGeometry.boxShadow).not.toBe(unselectedBoxShadow);

    const velocityBar = page.locator('.pr__velbar').first();
    await expect(velocityBar).toBeVisible();
    const velocityHitTarget = await velocityBar.evaluate((element) => {
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      const hitStyle = getComputedStyle(html, '::before');
      return {
        visualHeight: html.getBoundingClientRect().height,
        visualWidth: html.getBoundingClientRect().width,
        minHeight: style.minHeight,
        hitWidth: Number.parseFloat(hitStyle.width),
        hitHeight: Number.parseFloat(hitStyle.height),
      };
    });
    expect(velocityHitTarget.visualHeight).toBeLessThan(44);
    expect(velocityHitTarget.visualWidth).toBe(6);
    expect(velocityHitTarget.minHeight).toBe('0px');
    expect(velocityHitTarget.hitWidth).toBeGreaterThanOrEqual(44);
    expect(velocityHitTarget.hitHeight).toBeGreaterThanOrEqual(44);
  } finally {
    await context.close();
  }
});
