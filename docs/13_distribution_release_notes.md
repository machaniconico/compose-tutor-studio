# 13. 配布ページ・リリースノートテンプレート

このテンプレートは、Compose Tutor Studio を外部配布するときのユーザー向け文面です。`pnpm release:notes` を実行すると、`release-manifest.json` から SHA-256 を転記した `apps/studio/src-tauri/target/release/release/release-notes-draft.md` を生成できます。`pnpm release:source-status` と `pnpm release:source-status:verify` は `release-source-status-report.json` を生成・検証し、`sourceControl` の dirty state と分類が manifest と一致しているか確認するために使います。`pnpm release:signing` と `pnpm release:signing:verify` は `release-signing-report.json` を生成・検証し、未署名/署名済みの説明が実物と一致しているか確認するために使います。`pnpm release:notes:verify:draft` は草稿の構造と SHA-256 転記を検証します。公開前は `pnpm release:notes:verify -- --path <release-notes-path>` を実行し、草稿文や空の既知制限行が残っていないことを確認してください。候補ビルドごとに `docs/12_release_qa_log.md` の結果、`release-signing-report.json` の署名状態、`release-manifest.json` の SHA-256 と `sourceControl` の commit/dirty state を確認してから公開してください。署名済み配布または自動更新を有効化する場合は、`docs/14_signing_and_update_plan.md` の方針に沿って記載を更新してください。

## 1. タイトル

Compose Tutor Studio 0.1.0 for Windows

## 2. 概要

Compose Tutor Studio は、短いオリジナル曲を作りながらコード、スケール、曲構成を学ぶための作曲学習アプリです。このリリースでは Windows デスクトップ版のインストーラと、プロジェクト保存、MIDI/WAV 書き出し、サポート用のローカル診断ログを提供します。

## 3. ダウンロード

| 種別 | ファイル | 用途 | SHA-256 |
|---|---|---|---|
| NSIS installer | `Compose Tutor Studio_0.1.0_x64-setup.exe` | 通常はこちらを使います |  |
| MSI installer | `Compose Tutor Studio_0.1.0_x64_en-US.msi` | 管理・検証環境向け |  |
| Portable exe | `cts-studio.exe` | インストールせずに起動確認したい場合 |  |

SHA-256 は `apps/studio/src-tauri/target/release/release/SHA256SUMS.txt` と一致している必要があります。配布前に `pnpm release:verify` を実行し、`release-manifest.json`、`SHA256SUMS.txt`、実ファイルのサイズと SHA-256 が一致していることを確認してください。

## 4. 対応環境

- Windows 10 または Windows 11
- Microsoft Edge WebView2 Runtime
- 音声を確認できる出力デバイス

## 5. サードパーティNOTICE

サードパーティ依存の NOTICE は `THIRD_PARTY_NOTICES.md` として生成します。配布ページでは、ダウンロードファイルの近くに置くか、リンクしてください。公開前に `pnpm release:notices` と `pnpm release:notices:verify` を実行してください。

## 6. インストール時の注意

このビルドがコード署名されていない場合、Windows Defender SmartScreen やブラウザが警告を表示することがあります。未署名ビルドでは、配布ページに次の内容を必ず明記してください。

- 発行元が「不明な発行元」と表示される可能性があります。
- ダウンロードしたファイルの SHA-256 を、このページに記載した値と照合してください。
- SHA-256 が一致しないファイルは実行しないでください。

コード署名済みビルドを配布する場合は、この節を署名済みの発行元名、証明書情報、検証手順に差し替えてください。未署名ビルドを署名済みのように表現してはいけません。

署名状態の根拠は `release-signing-report.json` です。配布ページ公開前に `pnpm release:signing` と `pnpm release:signing:verify` を実行し、`release-signing-report.json` に記録された状態と、この節の説明が一致していることを確認してください。

## 7. 主な確認済み機能

- スタート画面からサンプル曲を再生できます。
- プロジェクトを保存し、再起動後に前回の続きから読み込めます。
- プロジェクトファイルを書き出し、読み込み直せます。
- MIDI ファイルを書き出せます。
- WAV ファイルを書き出せます。
- MIDI / WAV / プロジェクトの書き出しと読み込みで OS 標準ファイルダイアログを使います。
- 上部のサポート画面、または未処理エラー画面から、ローカル診断ログをコピーできます。どちらの画面でも、クリップボード拒否時は手動コピー用診断情報を確認できます。

## 8. 診断ログとプライバシー

診断ログはユーザーの端末内に保存され、自動送信されません。ユーザーは上部のサポート画面から診断情報をコピーできます。画面の再描画に失敗した場合は、未処理エラー画面から同じ診断情報をコピーできます。どちらの画面でも、クリップボード拒否時は手動コピー用診断情報が表示されるため、OS やブラウザ権限でコピーできない環境でも同じ内容を選択できます。エラー調査が必要な場合は、ユーザーが明示的にコピーした診断情報だけを受け取ってください。コピーされる診断レポートにはアプリバージョン、生成時刻、user agent、診断ID、エラー種別が含まれます。ローカルファイルパスは `[local-path]` に置き換えられます。通常機能には隠れたネットワーク通信や telemetry はありません。リリース前に `pnpm check:privacy` を実行してください。

署名鍵、証明書secret、private key は repository や release 証跡に含めません。公開前に `pnpm check:secrets` を実行してください。

サンプル音源や第三者素材を誤って含めないため、公開前に `pnpm check:assets` を実行してください。許可済みアプリアイコン以外の画像、音声、動画、archive、署名素材ファイルが source tree にある場合は失敗します。

## 9. 既知の制限

| 制限 | 影響 | 回避策または予定 |
|---|---|---|
| コード署名がない場合があります | Windows が警告を表示する可能性があります | SHA-256 を照合してください。署名導入後にこの記載を更新します |
|  |  |  |

## 10. アンインストール

通常の Windows アプリと同じように、設定アプリの「インストールされているアプリ」から Compose Tutor Studio をアンインストールできます。Portable exe を使った場合は、ダウンロードした exe を削除してください。

## 11. リリース担当者チェック

- `docs/12_release_qa_log.md` を元にした候補ビルド別 QA ログがある
- `pnpm release:notes` で生成した草稿を元に配布ページを作成している
- CI artifact `cts-windows-release-candidate-<commit-sha>` に installer と release 証跡が保存されている
- `pnpm release:archive` で候補ビルド別の証跡を `docs/releases/` に保存している
- `pnpm release:archive:verify` で保存済み証跡の SHA-256 整合性を確認している
- `pnpm release:source-status` が成功し、`release-source-status-report.json` の分類で clean 化の残作業を確認している
- `pnpm release:source-status:verify` が成功し、source status report が `release-manifest.json` と一致している
- `pnpm release:installers:verify` が成功し、`release-installer-metadata-report.json` が候補ビルド証跡に保存されている
- `pnpm release:installers:smoke:plan` と `pnpm release:installers:smoke:verify` が成功し、`release-installer-smoke-plan.md` をインストーラ手動QAで参照している
- `pnpm release:signing` と `pnpm release:signing:verify` が成功している
- `release-signing-report.json` の署名状態と配布ページの説明が一致している
- `pnpm release:qa-log:verify -- --path <qa-log-path>` が成功している
- `pnpm release:notes:verify -- --path <release-notes-path>` が成功している
- `pnpm release:notices` と `pnpm release:notices:verify` が成功している
- `THIRD_PARTY_NOTICES.md` を配布ページから参照できる
- `pnpm check:privacy` が成功している
- `pnpm check:secrets` が成功し、署名鍵や証明書secretが repository や release 証跡に含まれていない
- `pnpm check:assets` が成功し、許可済みアプリアイコン以外の画像、音声、動画、archive、署名素材ファイルが source tree に含まれていない
- `pnpm release:verify` が成功している
- `pnpm release:verify:publish` が成功し、`release-manifest.json` の `sourceControl` が clean である
- SHA-256 が `SHA256SUMS.txt` と一致している
- 未署名ビルドの場合、Windows 警告と SHA-256 照合方法を書いている
- 署名済みビルドの場合、発行元名と証明書の確認方法を書いている
- updater を有効化した場合、更新 channel と rollback 方針を書いている
- 既知の制限を空欄のまま公開していない
