import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeProjectJson } from '@cts/project-model';
import { buildScheduleEvents } from '../../src/audio/events';
import { checkGolden } from './golden-io';

const EXPECTED_DIR = join(import.meta.dirname, 'expected');

// studio の createDefaultProject は Date.now / Math.random で ID を作る。固定して決定論化する。
describe('golden: studio createDefaultProject', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('encoded bytes and schedule are pinned', async () => {
    const { createDefaultProject } = await import('../../src/state/defaultProject');
    const project = createDefaultProject();
    const encoded = encodeProjectJson(project);
    if (!encoded.ok) throw new Error(`encode failed: ${JSON.stringify(encoded.error)}`);
    expect(JSON.parse(encoded.json).schemaVersion).toBe(12);
    checkGolden(join(EXPECTED_DIR, 'studio-default-project.json'), `${encoded.json}\n`);
    const schedule = buildScheduleEvents(project)
      .map((e) => JSON.parse(JSON.stringify({ beat: e.beat, payload: e.payload })) as { beat: number })
      .sort((a, b) => a.beat - b.beat || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    checkGolden(join(EXPECTED_DIR, 'studio-default-project.schedule.json'), `${JSON.stringify(schedule, null, 1)}\n`);
  });
});
