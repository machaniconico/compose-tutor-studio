# 08. QA・テスト計画

## 1. テスト方針

音楽アプリは、一般的なUIバグに加えて、音楽理論・タイミング・保存互換性・音声出力の検証が必要です。

| 領域 | テスト種別 | 目的 |
|---|---|---|
| theory-engine | unit | コード/スケール/度数判定の正確性 |
| tutorial-engine | unit/integration | レッスン判定の再現性 |
| project-model | unit/migration | 保存/読み込み/移行の安全性 |
| UI | component/e2e | 主要操作フロー |
| audio | integration/golden | 再生イベント、レンダー結果 |
| export | integration | MIDI/WAVの読み出し可能性 |

## 2. Theory Engine テスト例

```ts
describe('analyzeChord', () => {
  it('analyzes G7 in C major as V7 dominant', () => {
    const result = analyzeChord({ symbol: 'G7', key: 'C', scale: 'major' });
    expect(result.degree).toBe('V7');
    expect(result.function).toBe('D');
    expect(result.notes).toEqual(['G', 'B', 'D', 'F']);
  });
});
```

## 3. Tutorial Engine テスト例

```ts
it('completes I-V-vi-IV lesson when user places C-G-Am-F in C major', () => {
  const lesson = loadLesson('course2_lesson4');
  const engine = createTutorialEngine(lesson);
  engine.dispatch(chordAdded('C', 0));
  engine.dispatch(chordAdded('G', 4));
  engine.dispatch(chordAdded('Am', 8));
  engine.dispatch(chordAdded('F', 12));
  expect(engine.currentStep.status).toBe('completed');
});
```

## 4. E2Eシナリオ

### E2E-001: 最初の1曲

1. アプリ起動
2. テンプレート「8小節BGM」選択
3. 再生
4. コード進行追加
5. ドラムパターン追加
6. ベース生成
7. メロディ入力
8. 保存
9. 再起動
10. 読み込み
11. MIDI export
12. WAV export

期待結果:

- エラーなし
- 書き出しファイルが存在
- Windows 予約名や記号を含むプロジェクト名でも、書き出しファイル名が安全になる
- プロジェクトのノート/コード数が保存前後で一致

## 5. 音声テスト

| テスト | 内容 |
|---|---|
| scheduler drift | 120 BPMで小節境界が期待値からズレないか |
| note on/off | note duration通りにoffされるか |
| mute/solo | 期待トラックだけ鳴るか |
| clipping warning | Masterが0dBFS超過時に警告するか |
| offline render | 同じプロジェクトから同じ長さのWAVが出るか |

## 6. パフォーマンステスト

| 条件 | 目標 |
|---|---|
| 16 tracks / 64 clips | UI操作が実用範囲 |
| 10,000 MIDI notes | Piano Rollのズーム/スクロールが破綻しない |
| 30分プロジェクト | 保存/読み込みが実用範囲 |
| レッスン100件 | Learn Panel検索が実用範囲 |

## 7. 回帰テスト対象

- 既存プロジェクト読み込み
- Lesson DSL schema
- Chord parser
- MIDI export
- Autosave recovery
- AI Coach mock response parsing

## 8. 手動QAチェックリスト

配布前の Windows インストーラ確認は `docs/11_release_gate.md` を正とし、候補ビルドごとの結果は `docs/12_release_qa_log.md` をコピーして記録する。手動 QA 記入後は `pnpm release:qa-log:verify -- --path <qa-log-path>` で未記入や未承認のまま配布しないことを確認する。ユーザー向け配布ページまたはリリースノートは `docs/13_distribution_release_notes.md` を元に作成し、公開前に `pnpm release:notes:verify -- --path <release-notes-path>` で草稿文や空欄が残っていないことを確認する。インストーラメタデータは `pnpm release:installers:verify` で生成・検証し、製品名、バージョン、MSI UpgradeCode が候補ビルドと一致していることを確認する。インストーラ手動QAの実施時は `pnpm release:installers:smoke:plan` と `pnpm release:installers:smoke:verify` で生成・検証した `release-installer-smoke-plan.md` を使い、クリーンな Windows 環境で NSIS/MSI のインストール、起動、アンインストール結果を QA ログへ記録する。署名状態は `pnpm release:signing` と `pnpm release:signing:verify` で生成・検証し、`release-signing-report.json` と配布ページの説明を一致させる。サードパーティ NOTICE は `pnpm release:notices` と `pnpm release:notices:verify` で生成・検証する。隠れた通信や自動送信がないことは `docs/15_privacy_network_policy.md` と `pnpm check:privacy` で確認する。署名鍵や証明書secretの混入がないことは `pnpm check:secrets` で確認する。許可済みアプリアイコン以外の画像、音声、動画、archive、署名素材ファイルが source tree に混入していないことは `pnpm check:assets` で確認する。署名または updater を有効化したリリースでは `docs/14_signing_and_update_plan.md` の追加チェックも実施する。

- 初心者が説明なしでStart Screenから再生まで到達できる
- Learn Panelを閉じても作業できる
- スケール外音の警告が邪魔すぎない
- 既存DAWのUI模倣に見えない
- 音が鳴らない時の原因表示が分かりやすい
- 書き出し前チェックリストが役に立つ
- 上部のサポート画面から診断情報をコピーできる
- クリップボード拒否時も手動コピー用診断情報を確認できる
- コピーした診断レポートにアプリバージョン、生成時刻、user agent、診断IDが含まれる
