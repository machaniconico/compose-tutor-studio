# 12. リリースQAログテンプレート

このテンプレートは、外部配布する候補ビルドごとにコピーして使います。`pnpm release:gates:report` を実行すると、自動ゲート結果を `release-gates-report.json` に保存できます。`pnpm release:source-status` を実行すると、sourceControl の dirty entries を分類し、レビュー順序をまとめた `release-source-status-report.json` と `release-source-status-report.md` を保存できます。`pnpm release:source-status:verify` は、source status report が `release-manifest.json` の `sourceControl` と一致し、レビュー束も古くなっていないことを確認します。`pnpm release:installers:verify` を実行すると、portable exe / MSI / NSIS の製品名、バージョン、MSI UpgradeCode を `release-installer-metadata-report.json` に保存できます。`pnpm release:installers:smoke:plan` を実行すると、クリーンな Windows QA 環境で使う候補ビルド別のインストール/起動/アンインストール手順を `release-installer-smoke-plan.json` に保存できます。このコマンドは実インストールを行いません。`pnpm release:installers:smoke:verify` は、生成済みの手順が manifest、SHA-256、MSI ProductCode、必須手順と一致していることを確認します。`pnpm release:signing` と `pnpm release:signing:verify` を実行すると、署名状態を `release-signing-report.json` に保存し、manifest と一致していることを確認できます。`pnpm release:qa-log` を実行すると、`release-manifest.json` からサイズ、SHA-256、sourceControl の commit/dirty state を転記し、存在する `release-gates-report.json`、`release-source-status-report.json`、`release-installer-metadata-report.json`、`release-installer-smoke-plan.json`、`release-signing-report.json` の結果も反映した `apps/studio/src-tauri/target/release/release/release-qa-log-draft.md` を生成できます。成果物行、MIDIヘッダー検証、インストーラメタデータ、インストーラ手動QA手順、機械的に証明できる配布判定行は自動証跡から `Pass` になります。`pnpm check:assets` はサンプル音源や第三者素材の混入防止 gate として自動証跡に残ります。WAV は `pnpm test:e2e` で RIFF/WAVE ヘッダーとサイズを補助検証しますが、OS 標準プレイヤーでの再生確認は人間が確認するまで `Not run` のまま残します。手動 QA、配布ページ確認、CI artifact 確認、公開前の厳格 verify、最終 sign-off も人間が確認するまで `Not run` のまま残します。`pnpm release:qa-log:verify:draft` は草稿の構造を検証します。手動 QA を記入した後は `pnpm release:qa-log:verify -- --path <qa-log-path>` を実行し、`Not run` や未署名の sign-off が残っていないことを確認してください。公開直前は `pnpm release:verify:publish` を実行し、配布成果物の SHA-256 だけでなく sourceControl が clean であることも確認してください。`pnpm release:archive` を実行すると、草稿、manifest、source status report、インストーラメタデータ、インストーラ手動QA手順、署名レポート、ゲートレポートを `docs/releases/<version>-<release-candidate>/` に保存できます。保存後は `pnpm release:archive:verify` で archive 内のソース状態、署名状態、SHA-256 整合性を確認してください。完了済みのQAログは上書きせず、日付とバージョンが分かる場所で管理してください。

手動QAの実行証跡として、`REL-MAN-001`、`REL-MAN-002`、`REL-MAN-003`、`REL-MAN-004`、`REL-MAN-005`、`REL-MAN-007`、`REL-MAN-008`、`REL-MAN-009` を `Pass` にする場合は、メモに確認環境、使った手順またはログ、観察した結果を残します。特に `REL-MAN-001` と `REL-MAN-002` は `release-installer-smoke-plan.md` / `release-installer-smoke-plan.json` の手順、または保存した PowerShell / `msiexec` 実行ログへの参照を書いてください。公開前の `pnpm release:qa-log:verify -- --path <qa-log-path>` は、この証跡メモが空欄または草稿のままだと失敗します。

## 1. 候補ビルド

| 項目 | 記録 |
|---|---|
| Product | Compose Tutor Studio |
| Version | 0.1.0 |
| Release candidate | rc.1 |
| QA date | YYYY-MM-DD |
| Tester |  |
| OS / edition | Windows 11 / Windows 10 |
| Machine type | Physical / VM |
| Install state | Clean install / Upgrade |
| Source branch or commit |  |
| CI artifact | `cts-windows-release-candidate-<commit-sha>` |
| Signing state | Not run |

## 2. ソースレビュー計画

公開前に `release-source-status-report.md` のレビュー束を確認し、dirty source を commit/stash/破棄などで解消してから `pnpm release:manifest` と `pnpm release:verify:publish` を再実行します。

Source status report:

- `apps/studio/src-tauri/target/release/release/release-source-status-report.json`
- `apps/studio/src-tauri/target/release/release/release-source-status-report.md`

| 束 | 件数 | カテゴリ | レビュー状態 | メモ |
|---|---:|---|---|---|
| Source status report | Not run |  | Not run | `pnpm release:source-status` と `pnpm release:source-status:verify` を実行する |

## 3. 配布成果物

`pnpm release:manifest`、`pnpm release:source-status`、`pnpm release:source-status:verify`、`pnpm release:verify`、`pnpm release:verify:publish`、`pnpm release:installers:verify`、`pnpm release:installers:smoke:plan`、`pnpm release:installers:smoke:verify`、`pnpm release:signing`、`pnpm release:signing:verify`、`pnpm release:gates:report`、`pnpm release:qa-log`、`pnpm release:qa-log:verify:draft` を実行し、生成された値を記録します。

| 種別 | ファイル | SHA-256 | サイズ | 結果 |
|---|---|---|---|---|
| Portable exe | `apps/studio/src-tauri/target/release/cts-studio.exe` |  |  | Not run |
| MSI installer | `apps/studio/src-tauri/target/release/bundle/msi/Compose Tutor Studio_0.1.0_x64_en-US.msi` |  |  | Not run |
| NSIS installer | `apps/studio/src-tauri/target/release/bundle/nsis/Compose Tutor Studio_0.1.0_x64-setup.exe` |  |  | Not run |

Manifest:

- `apps/studio/src-tauri/target/release/release/release-manifest.json`
- `apps/studio/src-tauri/target/release/release/SHA256SUMS.txt`
- `apps/studio/src-tauri/target/release/release/release-source-status-report.json`
- `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.json`
- `apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.json`
- `apps/studio/src-tauri/target/release/release/release-signing-report.json`

## 4. 自動ゲート結果

| コマンド | 結果 | メモ |
|---|---|---|
| `pnpm check` | Not run |  |
| `pnpm check:privacy` | Not run |  |
| `pnpm check:secrets` | Not run |  |
| `pnpm check:assets` | Not run |  |
| `pnpm build` | Not run |  |
| `pnpm check:size` | Not run |  |
| `pnpm test:e2e` | Not run |  |
| `pnpm build:desktop` | Not run |  |
| `pnpm check:size:desktop` | Not run |  |
| `pnpm release:manifest` | Not run |  |
| `pnpm release:source-status` | Not run |  |
| `pnpm release:source-status:verify` | Not run |  |
| `pnpm release:verify` | Not run |  |
| `pnpm release:installers:verify` | Not run |  |
| `pnpm release:installers:smoke:plan` | Not run |  |
| `pnpm release:installers:smoke:verify` | Not run |  |
| `pnpm release:signing` | Not run |  |
| `pnpm release:signing:verify` | Not run |  |
| `pnpm release:notices` | Not run |  |
| `pnpm release:notices:verify` | Not run |  |
| `pnpm release:gates:report` | Not run |  |
| `pnpm release:qa-log` | Not run |  |
| `pnpm release:qa-log:verify:draft` | Not run |  |
| `pnpm release:notes` | Not run |  |
| `pnpm release:notes:verify:draft` | Not run |  |
| `pnpm check:release` | Not run |  |

## 5. Windows インストーラ手動QA

結果は `Pass`、`Fail`、`Blocked`、`Not run` のいずれかで記録します。`Fail` または `Blocked` の場合は、再現手順、期待結果、実際の結果、関連ログをメモに残してください。手動確認が必要な項目を `Pass` にする場合も、確認環境、使った手順またはログ、観察した結果をメモに残してください。

| ID | 確認内容 | 結果 | メモ |
|---|---|---|---|
| REL-MAN-001 | NSIS installer を起動してインストールする | Not run |  |
| REL-MAN-002 | MSI を別環境またはクリーン状態で実行する | Not run |  |
| REL-MAN-003 | 初回起動でスタート画面からサンプル曲を再生する | Not run | スタート画面、サンプル曲名、再生して音が出た結果を記録する |
| REL-MAN-004 | 新規プロジェクトを作成して保存し、アプリを閉じて再起動する | Not run | 新規プロジェクト名、保存先、再起動後に復元した内容を記録する |
| REL-MAN-005 | プロジェクトファイルを書き出し、別タイトルに変更してから読み込み直す | Not run | 書き出したプロジェクトファイル、別タイトル、読み込み後のタイトルを記録する |
| REL-MAN-006 | MIDI を書き出し、外部アプリまたはファイルサイズで確認する | Not run | `pnpm test:e2e` が通る候補ビルドでは、MIDIヘッダーとサイズ検証により自動で Pass になる |
| REL-MAN-007 | WAV を書き出し、OS 標準プレイヤーで開く | Not run | `pnpm test:e2e` は RIFF/WAVE ヘッダーとサイズを補助検証する。OS 標準プレイヤーでの再生確認は手動で行う |
| REL-MAN-008 | 書き出し/読み込みで OS 標準ファイルダイアログを使う | Not run | 書き出しと読み込みの OS 標準ファイルダイアログで選択した場所を記録する |
| REL-MAN-009 | 上部のサポート画面と、未処理エラー画面を開くテストビルドまたは一時的な例外で診断ログを確認する | Not run | サポート画面、未処理エラー画面、クリップボード拒否時の手動コピー用診断情報をそれぞれ確認する |
| REL-MAN-010 | オフライン状態で主要機能を使う | Not run | `pnpm check:privacy` と `pnpm test:e2e` が通る候補ビルドでは自動で Pass になる |
| REL-MAN-011 | `SHA256SUMS.txt` の SHA-256 と配布予定ファイルを照合する | Not run | `pnpm release:verify` が通る候補ビルドでは自動で Pass になる |

## 6. 既知の制限

| 制限 | ユーザー影響 | Release note 記載 | 対応予定 |
|---|---|---|---|
|  |  | Not written |  |

## 7. 配布判定

| 項目 | 結果 |
|---|---|
| 自動ゲートがすべて成功している | Not run |
| 重大な手動QA項目が成功している | Not run |
| 既知の制限が release note に書かれている | Not run |
| `pnpm check:privacy` が成功している | Not run |
| `pnpm check:secrets` が成功している | Not run |
| `pnpm check:assets` が成功している | Not run |
| `pnpm release:installers:verify` が成功している | Not run |
| コード署名なしの警告を配布ページに明記している | Not run |
| `docs/13_distribution_release_notes.md` を元に配布ページを作成している | Not run |
| 配布ページに SHA-256 を記載している | Not run |
| `pnpm release:archive` で候補ビルド別の証跡を `docs/releases/` に保存している | Not run |
| `pnpm release:archive:verify` で保存済み証跡の SHA-256 整合性を確認している | Not run |
| CI artifact `cts-windows-release-candidate-<commit-sha>` に配布成果物と release 証跡が保存されている | Not run |
| `pnpm release:qa-log:verify -- --path <qa-log-path>` が成功している | Not run |
| `pnpm release:notes:verify -- --path <release-notes-path>` が成功している | Not run |
| `pnpm release:notices:verify` が成功している | Not run |
| `THIRD_PARTY_NOTICES.md` を配布ページから参照できる | Not run |
| `pnpm release:signing:verify` が成功している | Not run |
| `release-signing-report.json` の署名状態と配布ページの説明が一致している | Not run |
| 署名または updater を有効化した場合、`docs/14_signing_and_update_plan.md` の追加チェックを実施している | Not run |
| MSI `upgradeCode` が `a776024f-6b69-5d06-8534-15426c9c632a` のまま固定されている | Not run |
| 配布してよい | No |

Sign-off:

- QA:
- Engineering:
- Release owner:
