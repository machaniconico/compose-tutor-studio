/**
 * CoachAdapter — AI コーチの DIインターフェース
 *
 * 実LLM接続は将来実装。今はMockCoachがDI差し替えで使われる。
 * 外部ネットワーク呼び出しはこのインターフェースでは禁止。
 */

import type { Project } from '@cts/project-model';

/** 改善提案1件 */
export type CoachSuggestion = {
  /** 提案タイトル (短く初心者向け日本語) */
  title: string;
  /** なぜその提案をするか (理由・音楽理論の根拠) */
  reason: string;
  /** 具体的な操作手順 */
  action: string;
  /** 対象トラック名。プロジェクト全体への提案は null */
  targetTrack: string | null;
};

/** フォーカスカテゴリ (将来の拡張用) */
export type CoachFocus = 'harmony' | 'melody' | 'rhythm' | 'arrangement' | 'all';

/**
 * CoachAdapter — AIコーチ実装が満たすべきインターフェース。
 *
 * - 実LLMアダプタを後から差し込めるようにDI設計。
 * - 今は MockCoach のみ。
 * - ネットワーク呼び出しはこのインターフェース実装に含まない。
 */
export interface CoachAdapter {
  /**
   * プロジェクトを受け取り、フォーカスに応じた改善提案を返す。
   *
   * @param project 現在のプロジェクト
   * @param focus   提案の重点カテゴリ (省略時は 'all')
   * @returns       2〜4件の CoachSuggestion (決定論的またはLLM生成)
   */
  suggestImprovements(project: Project, focus?: CoachFocus): Promise<CoachSuggestion[]>;

  /**
   * アダプタ名 (UI表示・ロギング用)。
   * 例: 'mock' | 'openai' | 'claude'
   */
  readonly name: string;
}
