// 書き出し前チェックリスト (US-305) の純粋評価関数のテスト。
// 各チェック項目について ok / warning の両ケースを決定的に検証する。

import { describe, expect, it } from 'vitest';
import type { Clip, EffectConfig, Project, Section, Track } from '@cts/project-model';
import {
  EXPORT_CHECKLIST_ITEM_IDS,
  LOUD_TRACK_COUNT_FOR_WARNING,
  REVERB_MIX_WARNING_THRESHOLD,
  VOLUME_NEAR_MAX_THRESHOLD,
  evaluateExportChecklist,
  hasExportChecklistWarnings,
  type ExportChecklistItem,
  type ExportChecklistItemId,
} from '../src/features/export/exportChecklist';

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(seq += 1)}`;

function makeNoteClip(trackId: string): Clip {
  return {
    id: nextId('clip'),
    trackId,
    type: 'midi',
    startBeat: 0,
    lengthBeats: 16,
    loop: false,
    notes: [
      { id: nextId('note'), pitch: 60, startBeat: 0, durationBeats: 1, velocity: 100 },
    ],
  };
}

function makeEmptyClip(trackId: string): Clip {
  return {
    id: nextId('clip'),
    trackId,
    type: 'midi',
    startBeat: 0,
    lengthBeats: 16,
    loop: false,
    notes: [],
  };
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  const id = overrides.id ?? nextId('track');
  const base: Track = {
    id,
    name: 'ピアノ',
    type: 'instrument',
    clips: [makeNoteClip(id)],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
  };
  return { ...base, ...overrides, id };
}

function makeMaster(volume = 1): Track {
  return makeTrack({ name: 'Master', type: 'master', clips: [], volume });
}

function makeSection(name = 'Aメロ'): Section {
  return { id: nextId('sec'), name, type: 'verse', startBar: 0, lengthBars: 4 };
}

function reverbFx(mix: number, enabled = true): EffectConfig {
  return { id: nextId('fx'), type: 'reverb', enabled, params: { mix } };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: nextId('project'),
    schemaVersion: 1,
    title: 'テスト曲',
    bpm: 100,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    tracks: [makeMaster(), makeTrack()],
    chordTrack: [],
    sections: [makeSection()],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function itemOf(project: Project, id: ExportChecklistItemId): ExportChecklistItem {
  const item = evaluateExportChecklist(project).find((entry) => entry.id === id);
  if (!item) throw new Error(`checklist item not found: ${id}`);
  return item;
}

describe('evaluateExportChecklist: 全体', () => {
  it('整ったプロジェクトでは全項目が ok になり、1クリック書き出し可能と判定できる', () => {
    const project = makeProject();
    const items = evaluateExportChecklist(project);

    expect(items.map((item) => item.id)).toEqual([...EXPORT_CHECKLIST_ITEM_IDS]);
    for (const item of items) {
      expect(item.level, `${item.id} should be ok`).toBe('ok');
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.advice.length).toBeGreaterThan(0);
    }
    expect(hasExportChecklistWarnings(items)).toBe(false);
  });

  it('warning が1つでもあれば hasExportChecklistWarnings が true になる', () => {
    const project = makeProject({ sections: [] });
    const items = evaluateExportChecklist(project);
    expect(items.some((item) => item.level === 'warning')).toBe(true);
    expect(hasExportChecklistWarnings(items)).toBe(true);
  });

  it('純粋関数: 入力プロジェクトを変更せず、同じ入力には同じ結果を返す', () => {
    const project = makeProject({
      tracks: [makeMaster(2), makeTrack({ mute: true }), makeTrack({ clips: [] })],
      sections: [],
    });
    const snapshot = JSON.stringify(project);

    const first = evaluateExportChecklist(project);
    const second = evaluateExportChecklist(project);

    expect(JSON.stringify(project)).toBe(snapshot);
    expect(second).toEqual(first);
  });
});

describe('リバーブ過多のチェック', () => {
  it('しきい値を超える reverb mix のトラックがあると warning になり、理由を説明する', () => {
    const project = makeProject({
      tracks: [
        makeMaster(),
        makeTrack({
          name: 'シンセ',
          effects: [reverbFx(REVERB_MIX_WARNING_THRESHOLD + 0.1)],
        }),
      ],
    });

    const item = itemOf(project, 'reverb');
    expect(item.level).toBe('warning');
    expect(item.title).toBe('リバーブ過多');
    expect(item.advice).toContain('リバーブが深すぎると音がぼやけます');
    expect(item.advice).toContain('シンセ');
  });

  it('reverb mix がしきい値ちょうど以下なら ok', () => {
    const project = makeProject({
      tracks: [
        makeMaster(),
        makeTrack({ effects: [reverbFx(REVERB_MIX_WARNING_THRESHOLD)] }),
      ],
    });
    expect(itemOf(project, 'reverb').level).toBe('ok');
  });

  it('無効化された reverb は深くても ok のまま', () => {
    const project = makeProject({
      tracks: [makeMaster(), makeTrack({ effects: [reverbFx(0.95, false)] })],
    });
    expect(itemOf(project, 'reverb').level).toBe('ok');
  });
});

describe('音量バランスのチェック', () => {
  it('マスター音量が上限付近だと warning になり、クリッピングを説明する', () => {
    const project = makeProject({
      tracks: [makeMaster(VOLUME_NEAR_MAX_THRESHOLD), makeTrack()],
    });

    const item = itemOf(project, 'volume');
    expect(item.level).toBe('warning');
    expect(item.advice).toContain('クリッピング');
  });

  it('複数トラックが上限付近だと warning になる', () => {
    const loudTracks = Array.from({ length: LOUD_TRACK_COUNT_FOR_WARNING }, (_, i) =>
      makeTrack({ name: `トラック${i + 1}`, volume: VOLUME_NEAR_MAX_THRESHOLD }),
    );
    const project = makeProject({ tracks: [makeMaster(), ...loudTracks] });
    expect(itemOf(project, 'volume').level).toBe('warning');
  });

  it('上限付近のトラックが1本だけ(マスターは余裕あり)なら ok', () => {
    const project = makeProject({
      tracks: [makeMaster(), makeTrack({ volume: VOLUME_NEAR_MAX_THRESHOLD }), makeTrack()],
    });
    expect(itemOf(project, 'volume').level).toBe('ok');
  });
});

describe('ミュートされたままのトラックのチェック', () => {
  it('音が入っているのにミュート中のトラックがあると warning になる', () => {
    const project = makeProject({
      tracks: [makeMaster(), makeTrack({ name: 'ベース', mute: true })],
    });

    const item = itemOf(project, 'mutedTracks');
    expect(item.level).toBe('warning');
    expect(item.advice).toContain('ベース');
    expect(item.advice).toContain('ミュート');
  });

  it('ミュート中でも空のトラックなら mutedTracks は ok (空トラック側で扱う)', () => {
    const project = makeProject({
      tracks: [makeMaster(), makeTrack(), makeTrack({ mute: true, clips: [] })],
    });
    expect(itemOf(project, 'mutedTracks').level).toBe('ok');
    expect(itemOf(project, 'emptyTracks').level).toBe('warning');
  });
});

describe('セクションのチェック', () => {
  it('セクション未設定だと warning になり、曲の構成について説明する', () => {
    const project = makeProject({ sections: [] });

    const item = itemOf(project, 'sections');
    expect(item.level).toBe('warning');
    expect(item.advice).toContain('構成');
  });

  it('名前が空のセクションがあると warning になる', () => {
    const project = makeProject({ sections: [makeSection('   ')] });
    expect(itemOf(project, 'sections').level).toBe('warning');
  });

  it('名前付きセクションがあれば ok', () => {
    const project = makeProject({ sections: [makeSection('サビ')] });
    expect(itemOf(project, 'sections').level).toBe('ok');
  });
});

describe('空のトラックのチェック', () => {
  it('クリップのないトラックがあると warning になり、トラック名を挙げる', () => {
    const project = makeProject({
      tracks: [makeMaster(), makeTrack(), makeTrack({ name: 'ドラム', clips: [] })],
    });

    const item = itemOf(project, 'emptyTracks');
    expect(item.level).toBe('warning');
    expect(item.advice).toContain('ドラム');
  });

  it('ノートが1つもないクリップだけのトラックも warning になる', () => {
    const id = nextId('track');
    const project = makeProject({
      tracks: [makeMaster(), makeTrack({ id, clips: [makeEmptyClip(id)] })],
    });
    expect(itemOf(project, 'emptyTracks').level).toBe('warning');
  });

  it('エイリアスクリップやドラムイベントは中身ありとして ok になる', () => {
    const aliasTrackId = nextId('track');
    const aliasClip: Clip = {
      ...makeEmptyClip(aliasTrackId),
      aliasOf: 'clip-source',
    };
    const drumTrackId = nextId('track');
    const drumClip: Clip = {
      id: nextId('clip'),
      trackId: drumTrackId,
      type: 'drum',
      startBeat: 0,
      lengthBeats: 16,
      loop: true,
      drumEvents: [{ id: nextId('hit'), lane: 'kick', stepIndex: 0, velocity: 100 }],
    };
    const project = makeProject({
      tracks: [
        makeMaster(),
        makeTrack({ id: aliasTrackId, clips: [aliasClip] }),
        makeTrack({ id: drumTrackId, name: 'ドラム', type: 'drum', clips: [drumClip] }),
      ],
    });
    expect(itemOf(project, 'emptyTracks').level).toBe('ok');
  });
});
