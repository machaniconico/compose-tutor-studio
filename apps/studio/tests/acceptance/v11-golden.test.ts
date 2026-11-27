// P20 acceptance tests (v10 goldens must not change). Written BEFORE the implementation; do not edit.
//
// Contract: the P04 goldens (packages/project-model/tests/golden/fixtures, apps/studio/tests/golden/expected)
// pin the v10 sound. After the v10 -> v11 migration (swing 0, hiHatChoke false) every case still produces
// exactly the pinned `schedule` (buildScheduleEvents) and `timing` (resolved WAV notes and drums) snapshot.
// Newly created projects default to hiHatChoke true, so for them the golden is compared with the choke
// switched off (swing 0 and hiHatChoke false is the v10-compatible configuration).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => '00000000-0000-4000-8000-000000000000',
    configurable: true,
  });
});

import type { Project } from '@cts/project-model';
import { buildCase, goldenCases } from '../../../../packages/project-model/tests/golden/cases';
import { buildScheduleEvents } from '../../src/audio/events';
import { createProjectMusicalTime, beatDurationSeconds } from '../../src/audio/musicalTime';
import { beatToTime } from '../../src/audio/scheduler';
import { buildWavScheduleEvents } from '../../src/audio/wav';

const EXPECTED_DIR = join(import.meta.dirname, '..', 'golden', 'expected');

// Same projections as tests/golden/schedule.golden.test.ts (copied so this file stays independent).
function schedulePlain(project: Project): unknown {
  const events = buildScheduleEvents(project).map(
    (event) => JSON.parse(JSON.stringify({ beat: event.beat, payload: event.payload })) as { beat: number },
  );
  return events
    .map((event) => ({ key: JSON.stringify(event), event }))
    .sort((a, b) => a.event.beat - b.event.beat || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.event);
}

function timingPlain(project: Project): unknown {
  const { tempo, index } = createProjectMusicalTime(project);
  const wav = buildWavScheduleEvents(project);
  const notes = wav.flatMap((event) => {
    const payload = event.payload as { kind: string; trackId: string; pitch?: number; durationBeats?: number };
    if (payload.kind !== 'note') return [];
    return [{
      trackId: payload.trackId,
      pitch: payload.pitch,
      startBeat: event.beat,
      endBeat: event.beat + (payload.durationBeats ?? 0),
      startSeconds: tempo.beatToSeconds(event.beat),
      endSeconds: tempo.beatToSeconds(event.beat + (payload.durationBeats ?? 0)),
      noteOnTime: beatToTime(event.beat, tempo, 0, 0),
      noteOnDuration: beatDurationSeconds(index, event.beat, payload.durationBeats ?? 0),
    }];
  });
  const drums = wav.flatMap((event) => {
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind !== 'drum') return [];
    return [{
      trackId: payload.trackId,
      clipId: payload.clipId,
      eventId: payload.eventId,
      lane: payload.lane,
      velocity: payload.velocity,
      voiceSeed: payload.voiceSeed,
      beat: event.beat,
      seconds: tempo.beatToSeconds(event.beat),
    }];
  });
  const byKey = (a: unknown, b: unknown) => {
    const x = a as { startBeat?: number; beat?: number };
    const y = b as { startBeat?: number; beat?: number };
    const d = (x.startBeat ?? x.beat ?? 0) - (y.startBeat ?? y.beat ?? 0);
    return d || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  };
  return { notes: notes.sort(byKey), resolvedDrums: drums.sort(byKey) };
}

function pinned(name: string): { schedule: unknown; timing: unknown } {
  return JSON.parse(readFileSync(join(EXPECTED_DIR, `${name}.schedule.json`), 'utf8')) as {
    schedule: unknown;
    timing: unknown;
  };
}

const cases = goldenCases();
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe('P20 v11 goldens', () => {
  it('schedule_chokeFalse_matchesV10Golden', () => {
    expect(cases.length).toBeGreaterThanOrEqual(14);
    for (const c of cases) {
      const project = buildCase(c);
      expect(project.schemaVersion, c.name).toBe(11);
      project.swing = 0;
      project.hiHatChoke = false;
      const expected = pinned(c.name);
      expect(roundTrip(schedulePlain(project)), `${c.name} schedule`).toEqual(expected.schedule);
      expect(roundTrip(timingPlain(project)), `${c.name} timing`).toEqual(expected.timing);
    }
  });

  it('migrate_v1ThroughV10Goldens_scheduleEventsUnchanged', () => {
    const migrated = cases.filter((c) => c.name.startsWith('migrated-') || c.name.startsWith('fixture-v10-'));
    expect(migrated.map((c) => c.name)).toEqual(expect.arrayContaining([
      'migrated-v1-legacy',
      'migrated-v2-legacy',
      'fixture-v10-automation-routing',
      'fixture-v10-drum-loop-alias',
      'fixture-v10-tempo-meter-map',
    ]));
    for (const c of migrated) {
      const project = buildCase(c); // decoded WITHOUT touching swing / hiHatChoke: the migration defaults apply
      expect(project.schemaVersion, c.name).toBe(11);
      expect(project.swing, `${c.name} swing`).toBe(0);
      expect(project.hiHatChoke, `${c.name} hiHatChoke`).toBe(false);
      const expected = pinned(c.name);
      expect(roundTrip(schedulePlain(project)), `${c.name} schedule`).toEqual(expected.schedule);
      expect(roundTrip(timingPlain(project)), `${c.name} timing`).toEqual(expected.timing);
    }
  });
});
