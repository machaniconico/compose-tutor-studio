# 07. 開発計画とタスク分解

## 1. 開発フェーズ

| Phase | 目標 | 成果物 |
|---|---|---|
| P0: Prototype | 技術検証 | Tauri起動、音が鳴る、ノート表示 |
| P1: MVP Core | 曲作成の骨格 | Project、Chord Track、Piano Roll、Drum、保存 |
| P2: Learning MVP | 教材統合 | Lesson DSL、判定、Learn Panel |
| P3: Export MVP | 完成導線 | MIDI/WAV export、完成チェック |
| P4: Alpha | ユーザーテスト | 10名程度で初回曲完成率を計測 |
| P5: Beta | 安定化 | クラッシュ修正、UX改善、教材増加 |

## 2. 実装順序

### Milestone 0: リポジトリ作成

- Tauri + React + TypeScript scaffold
- pnpm workspace
- packages構成
- lint/typecheck/test
- CI設定
- CLAUDE.md / AGENTS.md配置

受け入れ条件:

- `pnpm install`
- `pnpm test`
- `pnpm dev`
- デスクトップ画面が起動する

### Milestone 1: Theory Engine

- note name parser
- scale builder
- chord parser
- chord degree analyzer
- chord suggestion MVP
- melody note relation analyzer

受け入れ条件:

- C major / A minor の基本テストが通る
- C, Dm, G7, Am, Fmaj7 の解析が通る
- I-V-vi-IV を度数表示できる

### Milestone 2: Project Model

- Project schema
- Track/Clip/Note/Chord types
- JSON validation
- SQLite migration
- save/load
- autosave queue

受け入れ条件:

- 保存→再起動→読み込みで同じプロジェクトになる
- schema migration testが通る

### Milestone 3: Timeline + Chord Track

- timeline grid
- chord event create/edit/delete
- chord palette
- theory inspector
- chord explanations

受け入れ条件:

- 4小節進行を作れる
- コード変更で度数/機能が更新される

### Milestone 4: Piano Roll

- grid rendering
- note create/move/resize/delete
- velocity lane
- scale highlight
- chord tone highlight
- quantize

受け入れ条件:

- 4小節メロディを入力できる
- scale snapが効く
- chord tone overlayが表示される

### Milestone 5: Audio Playback

- transport
- scheduler
- basic synth
- drum sampler
- metronome
- mixer volume/pan/mute/solo

受け入れ条件:

- コード、ベース、メロディ、ドラムを再生できる
- 再生位置カーソルが音と同期する

### Milestone 6: Tutorial Engine

- Lesson DSL
- event bus
- checker functions
- feedback renderer
- progress persistence
- Learn Panel

受け入れ条件:

- Course 0の8レッスンを完了できる
- 操作に応じてチェックが進む

### Milestone 7: Export

- MIDI writer
- WAV offline render
- export dialog
- export history

受け入れ条件:

- MIDIを他DAWで読み込める
- WAVを書き出して再生できる

### Wave 6: DAW ギャップ解消(US-001〜US-038)

`docs/16_daw_gap_analysis.md` の分析から切り出した story を、土台 → 編集 → 音と入力 → ミックスと出口 → 仕上げの順に実装した(正本は `.omc/prd.json`、候補との対応は docs/16 §9)。印の見方: [x] = 完了(受け入れ基準を満たし、レビュー済み)。聴感でしか確認できない項目(`docs/12_release_qa_log.md` §8 の FEAT-MAN-001〜016)は未実施で、完了の条件に含めない。

土台(P0):

- [x] US-000 DOM テスト基盤
- [x] US-001 スキーマ v2(クリップ長の意味変更・移行・バックアップ)
- [x] US-002 Track.role による役割解決
- [x] US-003 Undo トランザクションとキーマップの一元化
- [x] US-004 シークと再生ヘッド
- [x] US-005 拍子の統一と曲の長さ変更
- [x] US-006 ループ範囲とタップテンポ
- [x] US-007 クリップを尊重する再生経路(US-007a 発音の単一の正、US-007b 旧ファイルの移行)
- [x] US-008 試聴基盤と鍵盤クリック・音域拡大
- [x] US-009 コードを鳴らす・ノートにする
- [x] US-010 トラック管理と MIDI チャンネル上限
- [x] US-011 クリップ操作の純粋関数と相対拍(US-011a 純粋関数、US-011b UI)
- [x] US-012 曲全体ビュー(US-012b 再生中の編集の即時反映)

編集と入力(P1):

- [x] US-013 セクション単位の操作とセクションループ
- [x] US-014 ノート編集(クリップボード・移調・スケール適合)
- [x] US-015 ノート加工と 3 連符グリッド
- [x] US-016 曲全体の移調
- [x] US-017 ゴーストノートと色分け
- [x] US-018 グルーヴ(スウィング・強さ付きクオンタイズ・ヒューマナイズ)
- [x] US-019 ハイハットのチョークと 12/16 ステップ切替
- [x] US-020 音色プリセットとかんたんマクロ
- [x] US-021 伴奏パターン
- [x] US-022 コード検出
- [x] US-023 PC キーボード演奏とスケールロック
- [x] US-024 Web MIDI 入力(任意)
- [x] US-025 MIDI 録音
- [x] US-026 EQ・コンプレッサー・テンポ同期ディレイ・マスターフェーダー
- [x] US-027 オートメーション(音量)
- [x] US-028 書き出し強化(48kHz・ループ範囲・プログラムチェンジ・調号)

降格して実装した機能(P2):

- [x] US-029 用語集とツールチップ
- [x] US-030 新機能のレッスン
- [x] US-031 伴奏おまかせ
- [x] US-032 スペクトラム表示とチャンネルプリセット
- [x] US-033 オートメーション(パン・フィルター)
- [x] US-034 センド/リターン
- [x] US-035 書き出し強化(24bit・ディザ・ステム ZIP・ラウドネス・ノーマライズ)
- [x] US-036 ステップ入力と「今の演奏を拾う」

仕上げ:

- [x] US-037 E2E と手動 QA 表の整備
- [x] US-038 文書の最終同期(docs/02 機能表・docs/07・docs/16)

受け入れ条件:

- 全 story の受け入れ基準を満たし、`pnpm typecheck` と `pnpm test` が緑
- docs/02 の機能一覧が実装状態と一致している
- 残る既知の制限は、各 story の節(docs/02)と `.omc/handoffs/ralph4-followups.md` に記録されている

## 3. タスクID体系

- `ARCH-xxx`: アーキテクチャ
- `THEORY-xxx`: 音楽理論
- `PROJECT-xxx`: 保存/モデル
- `UI-xxx`: UI
- `AUDIO-xxx`: 音声
- `LEARN-xxx`: 教材
- `EXPORT-xxx`: 書き出し
- `QA-xxx`: テスト
- `LEGAL-xxx`: 法務/ライセンス

## 4. 初回タスク例

| ID | タイトル | 依存 | 完了条件 |
|---|---|---|---|
| ARCH-001 | pnpm workspace作成 | none | apps/packages構成ができる |
| ARCH-002 | Tauri desktop scaffold | ARCH-001 | 画面起動 |
| THEORY-001 | pitch/note utility | ARCH-001 | note parser tests pass |
| THEORY-002 | scale builder | THEORY-001 | major/minor scale tests pass |
| THEORY-003 | chord parser | THEORY-001 | triad/seventh tests pass |
| PROJECT-001 | project schema | ARCH-001 | zod or equivalent validation tests pass |
| UI-001 | main layout | ARCH-002 | top/left/center/right layout |
| AUDIO-001 | transport store | ARCH-002 | play/stop state works |

## 5. Claude Code / Codex 分担案

| 作業 | 向くツール | 理由 |
|---|---|---|
| 仕様からコード骨格生成 | Claude Code / Codex | 大きな文脈を使った初期設計 |
| 小さな関数のTDD | Codex | テスト生成と修正ループ |
| 複数ファイルのリファクタ | Claude Code | コードベース全体の把握 |
| UI実装の差分レビュー | Codex | AGENTS.mdで規約を固定しやすい |
| ドキュメント更新 | Claude Code | CLAUDE.mdと仕様の整合確認 |

## 6. 開発ルール

- 変更前に必ず関連テストを確認
- theory-engine はTDD優先
- UIは状態と描画を分離
- 音声処理はリアルタイムスレッドに重い処理を入れない
- LLM接続はインターフェースを抽象化し、モックでテストできるようにする
- 生成AIに一度に巨大実装を依頼しない。1タスク1成果物に分ける

## 7. 最初の10プロンプト

1. `prompts/01_scaffold_repo.md`
2. `prompts/02_theory_engine.md`
3. `prompts/03_project_model.md`
4. `prompts/04_main_layout.md`
5. `prompts/05_chord_track.md`
6. `prompts/06_piano_roll.md`
7. `prompts/07_audio_mvp.md`
8. `prompts/08_tutorial_engine.md`
9. `prompts/09_export_midi_wav.md`
10. `prompts/10_test_and_refactor.md`
