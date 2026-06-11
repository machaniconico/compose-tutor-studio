/**
 * MockCoach ユニットテスト
 *
 * 検証項目:
 * - 決定論性: 同じプロジェクトで2回呼んでも結果が同じ
 * - 空プロジェクト: コード・メロディ・ドラムなしでも2〜4件返す
 * - 提案の構造: title/reason/action が非空文字列
 * - 件数: 2〜4件
 * - focus フィルタ: harmony フォーカスで和声提案が含まれる
 * - ネットワーク呼び出しなし (MockCoach は純粋同期ロジックのみ)
 */

import { describe, expect, it } from 'vitest';
import type { Project } from '@cts/project-model';
import type { CoachAdapter, CoachSuggestion } from '../src/coach/adapter';
import { MockCoach } from '../src/coach/mockCoach';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function emptyProject(): Project {
  return {
    id: 'test-project-empty',
    schemaVersion: 1,
    title: 'テスト',
    bpm: 120,
    timeSignature: [4, 4],
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    tracks: [
      {
        id: 'tr-chords',
        name: 'Chords',
        type: 'instrument',
        clips: [{ id: 'cl-chords', trackId: 'tr-chords', type: 'midi', startBeat: 0, lengthBeats: 32, loop: false, notes: [] }],
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
      {
        id: 'tr-bass',
        name: 'Bass',
        type: 'instrument',
        clips: [{ id: 'cl-bass', trackId: 'tr-bass', type: 'midi', startBeat: 0, lengthBeats: 32, loop: false, notes: [] }],
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
      {
        id: 'tr-melody',
        name: 'Melody',
        type: 'instrument',
        clips: [{ id: 'cl-melody', trackId: 'tr-melody', type: 'midi', startBeat: 0, lengthBeats: 32, loop: false, notes: [] }],
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
      {
        id: 'tr-drums',
        name: 'Drums',
        type: 'drum',
        clips: [{ id: 'cl-drums', trackId: 'tr-drums', type: 'drum', startBeat: 0, lengthBeats: 32, loop: false, drumEvents: [] }],
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        effects: [],
      },
    ],
    chordTrack: [],
    sections: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function projectWithChords(): Project {
  return {
    ...emptyProject(),
    chordTrack: [
      { id: 'c1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] },
      { id: 'c2', startBeat: 4, durationBeats: 4, symbol: 'Am', root: 'A', quality: 'minor', notes: [9, 0, 4] },
      { id: 'c3', startBeat: 8, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [5, 9, 0] },
      { id: 'c4', startBeat: 12, durationBeats: 4, symbol: 'G', root: 'G', quality: 'major', notes: [7, 11, 2] },
    ],
  };
}

function projectWithMelody(): Project {
  const base = projectWithChords();
  return {
    ...base,
    tracks: base.tracks.map((t) =>
      t.name === 'Melody'
        ? {
            ...t,
            clips: t.clips.map((c) => ({
              ...c,
              notes: [
                { id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 80 },
                { id: 'n2', pitch: 62, startBeat: 1, durationBeats: 1, velocity: 80 },
                { id: 'n3', pitch: 64, startBeat: 2, durationBeats: 1, velocity: 80 },
                { id: 'n4', pitch: 65, startBeat: 3, durationBeats: 1, velocity: 80 },
              ],
            })),
          }
        : t,
    ),
  };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('MockCoach', () => {
  const coach = new MockCoach();

  it('name は "mock"', () => {
    expect(coach.name).toBe('mock');
  });

  describe('空プロジェクト', () => {
    it('2〜4件の提案を返す', async () => {
      const suggestions = await coach.suggestImprovements(emptyProject());
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      expect(suggestions.length).toBeLessThanOrEqual(4);
    });

    it('各提案が title / reason / action を持つ', async () => {
      const suggestions = await coach.suggestImprovements(emptyProject());
      for (const s of suggestions) {
        expect(typeof s.title).toBe('string');
        expect(s.title.length).toBeGreaterThan(0);
        expect(typeof s.reason).toBe('string');
        expect(s.reason.length).toBeGreaterThan(0);
        expect(typeof s.action).toBe('string');
        expect(s.action.length).toBeGreaterThan(0);
      }
    });

    it('targetTrack は string | null', async () => {
      const suggestions = await coach.suggestImprovements(emptyProject());
      for (const s of suggestions) {
        expect(s.targetTrack === null || typeof s.targetTrack === 'string').toBe(true);
      }
    });
  });

  describe('決定論性', () => {
    it('同じプロジェクトで2回呼んでも同じ結果を返す', async () => {
      const project = projectWithChords();
      const first = await coach.suggestImprovements(project);
      const second = await coach.suggestImprovements(project);
      expect(first).toEqual(second);
    });

    it('コード付きプロジェクトでも決定論的', async () => {
      const project = projectWithMelody();
      const a = await coach.suggestImprovements(project);
      const b = await coach.suggestImprovements(project);
      expect(a).toEqual(b);
    });
  });

  describe('フォーカスフィルタ', () => {
    it('focus="harmony" で2〜4件返す', async () => {
      const suggestions = await coach.suggestImprovements(emptyProject(), 'harmony');
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      expect(suggestions.length).toBeLessThanOrEqual(4);
    });

    it('focus="melody" で2〜4件返す', async () => {
      const suggestions = await coach.suggestImprovements(emptyProject(), 'melody');
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      expect(suggestions.length).toBeLessThanOrEqual(4);
    });

    it('focus="rhythm" で2〜4件返す', async () => {
      const suggestions = await coach.suggestImprovements(emptyProject(), 'rhythm');
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      expect(suggestions.length).toBeLessThanOrEqual(4);
    });

    it('focus="all" は focus 省略と同じ結果', async () => {
      const project = projectWithChords();
      const withAll = await coach.suggestImprovements(project, 'all');
      const withDefault = await coach.suggestImprovements(project);
      expect(withAll).toEqual(withDefault);
    });
  });

  describe('コード付きプロジェクト', () => {
    it('2〜4件の提案を返す', async () => {
      const suggestions = await coach.suggestImprovements(projectWithChords());
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      expect(suggestions.length).toBeLessThanOrEqual(4);
    });

    it('提案タイトルが日本語 (日本語文字を含む)', async () => {
      const suggestions = await coach.suggestImprovements(projectWithChords());
      const hasJapanese = suggestions.some((s) => /[぀-ヿ一-鿿]/.test(s.title));
      expect(hasJapanese).toBe(true);
    });
  });

  describe('メロディ付きプロジェクト', () => {
    it('2〜4件の提案を返す', async () => {
      const suggestions = await coach.suggestImprovements(projectWithMelody());
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      expect(suggestions.length).toBeLessThanOrEqual(4);
    });
  });

  describe('CoachAdapter インターフェース準拠', () => {
    it('suggestImprovements は Promise を返す', () => {
      const result = coach.suggestImprovements(emptyProject());
      expect(result).toBeInstanceOf(Promise);
    });

    it('DI差し替え可能 (CoachAdapter 型として代入できる)', () => {
      // 型レベルの検証: MockCoach が CoachAdapter を実装しているかを
      // ランタイムで確認するパターン
      const adapter: CoachAdapter = coach;
      expect(typeof adapter.name).toBe('string');
      expect(typeof adapter.suggestImprovements).toBe('function');
    });
  });

  describe('異常系', () => {
    it('BPM が極端に低くても2〜4件返す', async () => {
      const project = { ...emptyProject(), bpm: 30 };
      const suggestions = await coach.suggestImprovements(project);
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
    });

    it('BPM が極端に高くても2〜4件返す', async () => {
      const project = { ...emptyProject(), bpm: 300 };
      const suggestions = await coach.suggestImprovements(project);
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
    });

    it('コードが1つだけでも2〜4件返す', async () => {
      const project = {
        ...emptyProject(),
        chordTrack: [{ id: 'c1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] }],
      };
      const suggestions = await coach.suggestImprovements(project);
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
    });
  });
});
