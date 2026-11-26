import { describe, expect, it } from 'vitest';
import { buildScheduleEvents } from '../src/audio/events';
import { renderScheduleEvents } from '../src/audio/wav';
import { createDefaultProject } from '../src/state/defaultProject';
import { parseProjectFileImport } from '../src/features/export/projectFileImport';

describe('project file import parsing', () => {
  it('accepts a valid exported project', () => {
    const project = createDefaultProject('読み込みOK');
    const result = parseProjectFileImport(JSON.stringify(project));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.title).toBe('読み込みOK');
    }
  });

  it('accepts a valid project file with a UTF-8 BOM', () => {
    const project = createDefaultProject('BOM付き');
    const result = parseProjectFileImport(`\uFEFF${JSON.stringify(project)}`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.title).toBe('BOM付き');
    }
  });

  it('upgrades an older project file to the current schema', () => {
    const project = { ...createDefaultProject('古いファイル'), schemaVersion: 1 };
    const result = parseProjectFileImport(JSON.stringify(project));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.schemaVersion).toBe(3);
    }
  });

  it.each([
    { lengthBeats: 4, durationBeats: 1 },
    { lengthBeats: 128, durationBeats: 1 / 1024, contentLengthBeats: 1 / 1024 },
    { lengthBeats: 2 ** -35, durationBeats: 2 ** -35 },
  ])('opens a saved v2 loop of $lengthBeats beats and plays its single note once', ({
    lengthBeats, durationBeats, contentLengthBeats,
  }) => {
    const mix = { volume: 1, pan: 0, mute: false, solo: false, effects: [] };
    const raw = JSON.stringify({
      id: 'legacy-loop', schemaVersion: 2, title: '古いループ', bpm: 120,
      key: 'C', scale: 'major', timeSignature: [4, 4], lengthBars: 32,
      tracks: [
        {
          ...mix, id: 'keys', name: 'Keys', type: 'instrument',
          instrument: { preset: 'warmPad' },
          clips: [{
            id: 'clip', trackId: 'keys', type: 'midi', startBeat: 0,
            lengthBeats, loop: true, contentLengthBeats,
            notes: [{ id: 'note', pitch: 60, startBeat: 0, durationBeats, velocity: 100 }],
          }],
        },
        { ...mix, id: 'master', name: 'Master', type: 'master', clips: [] },
      ],
      chordTrack: [], sections: [],
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    });
    const result = parseProjectFileImport(raw);
    expect(result).toMatchObject({ ok: true, project: { schemaVersion: 3 } });
    if (!result.ok) return;
    // A note shorter than one tick sounds for one tick (docs/06 §4).
    const expected = [{ beat: 0, payload: { kind: 'note', pitch: 60, durationBeats: Math.max(durationBeats, 1 / 480) } }];
    expect(buildScheduleEvents(result.project)).toMatchObject(expected);
    expect(renderScheduleEvents(result.project)).toMatchObject(expected);
  });

  it('rejects invalid JSON with a beginner-facing message', () => {
    const result = parseProjectFileImport('{not json');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-json');
      expect(result.userMessage).toContain('.ctsproj.json');
      expect(result.diagnosticMessage).toContain('Project file import rejected');
    }
  });

  it('rejects unsupported future schema versions', () => {
    const project = { ...createDefaultProject('未来'), schemaVersion: 999 };
    const result = parseProjectFileImport(JSON.stringify(project));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported-schema');
      expect(result.userMessage).toContain('アプリを更新');
    }
  });

  it('rejects invalid project contents without returning a project', () => {
    const project = { ...createDefaultProject('壊れた値'), bpm: 9999 };
    const result = parseProjectFileImport(JSON.stringify(project));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-project');
      expect(result.userMessage).toContain('現在の曲は変更していません');
      expect(result.diagnosticMessage).toContain('bpm');
    }
  });

  it('rejects oversized project files before parsing JSON', () => {
    const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
    const result = parseProjectFileImport(oversized);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('file-too-large');
      expect(result.userMessage).toContain('大きすぎます');
      expect(result.diagnosticMessage).toContain('limit=');
      expect(result.diagnosticMessage).not.toContain(oversized);
    }
  });
});
