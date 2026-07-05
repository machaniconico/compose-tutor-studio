# 11. リリース前ゲート

Compose Tutor Studio を外部配布する前に通すゲートです。自動ゲートは CI と同じコマンドで再現できること、手動 QA は Windows の実インストーラで確認することを前提にします。

候補ビルドごとの証跡は `docs/12_release_qa_log.md` をコピーして残します。ユーザー向けの配布ページまたはリリースノートは `docs/13_distribution_release_notes.md` を元に作成します。コード署名と更新配信は `docs/14_signing_and_update_plan.md` のフェーズに沿って導入します。配布判断は、QA ログに自動ゲート、手動 QA、既知の制限、sign-off がそろい、配布ページに SHA-256 とコード署名状態が明記されている状態で行います。

GitHub Actions の CI は、すべての自動ゲートが通った後に `cts-windows-release-candidate-${{ github.sha }}` という artifact 名で Windows 配布候補を保存します。保存対象は portable exe、MSI、NSIS installer、`apps/studio/src-tauri/target/release/release/` 配下の release 証跡です。`actions/upload-artifact@v7` で `if-no-files-found: error`、`retention-days: 30`、`compression-level: 0`、`include-hidden-files: false` を使い、不完全な候補や隠しファイルを保存しない設定にします。

## 1. 自動ゲート

次のコマンドを順番に実行し、すべて成功してから候補ビルドを配布します。`pnpm release:gates:report` は、ビルド・テスト・成果物検証の主要ゲートを順に実行し、`release-gates-report.json` と `release-gates-report.md` に結果を残します。その後に `pnpm release:qa-log` を実行すると、QA ログ草稿の自動ゲート結果へ反映されます。

```bash
pnpm release:gates:report
pnpm release:installers:verify
pnpm release:installers:smoke:plan
pnpm release:installers:smoke:verify
pnpm check:secrets
pnpm check:assets
pnpm release:signing
pnpm release:signing:verify
pnpm release:notices
pnpm release:notices:verify
pnpm release:qa-log
pnpm release:qa-log:verify:draft
pnpm release:notes
pnpm release:notes:verify:draft
pnpm check:release
```

各コマンドの役割:

| コマンド | 目的 |
|---|---|
| `pnpm check` | 型チェックと unit/integration tests |
| `pnpm check:privacy` | 隠れた通信 API、通信依存、HTTP/updater 系 Tauri 権限がないことを検証 |
| `pnpm check:secrets` | 署名鍵、証明書秘密情報、private key ブロック、secret 実値が repository や release 証跡に混入していないことを検証 |
| `pnpm check:assets` | 許可済みアプリアイコン以外の画像、音声、動画、archive、署名素材ファイルが source tree に混入していないことを検証 |
| `pnpm build` | Web 版 production build |
| `pnpm check:size` | Web JS/CSS のサイズ予算 |
| `pnpm test:e2e` | 初回起動、保存、MIDI/WAV のダウンロードファイルのヘッダーとサイズ検証、プロジェクト export/import round trip、Windows 予約名を含むタイトルの安全な書き出しファイル名 |
| `pnpm build:desktop` | Tauri Windows exe / MSI / NSIS 生成 |
| `pnpm check:size:desktop` | exe / MSI / NSIS のサイズ予算 |
| `pnpm release:manifest` | exe / MSI / NSIS のサイズと SHA-256 を記録 |
| `pnpm release:source-status` | `sourceControl` の dirty entries を分類し、レビュー順序と clean 化の作業単位を `release-source-status-report.json/md` に保存 |
| `pnpm release:source-status:verify` | `release-source-status-report.json/md` が `release-manifest.json` の `sourceControl` と一致していることを検証 |
| `pnpm release:verify` | manifest、SHA256SUMS、実ファイルのサイズと SHA-256 を照合 |
| `pnpm release:verify:publish` | 公開前に `release:verify` に加えて manifest の `sourceControl` が clean であることを検証 |
| `pnpm release:installers:verify` | portable exe / MSI / NSIS の製品名、バージョン、MSI UpgradeCode などのインストーラメタデータを照合 |
| `pnpm release:installers:smoke:plan` | NSIS/MSI 手動QA用の候補ビルド別 PowerShell 手順と MSI ProductCode を `release-installer-smoke-plan.md/json` に保存 |
| `pnpm release:installers:smoke:verify` | 生成済み `release-installer-smoke-plan.md/json` が manifest、SHA-256、MSI ProductCode、必須手順と一致していることを検証 |
| `pnpm release:signing` | exe / MSI / NSIS の Authenticode 署名状態を `release-signing-report.md/json` に記録 |
| `pnpm release:signing:verify` | 署名レポートが manifest のファイルと一致し、署名状態が安全に説明できることを検証 |
| `pnpm release:notices` | npm runtime dependencies と Windows target Rust crates から `THIRD_PARTY_NOTICES.md/json` を生成 |
| `pnpm release:notices:verify` | NOTICE に未知・未レビュー・強い copyleft 系 license がないことを検証 |
| `pnpm release:gates:report` | `pnpm check` から資産・署名・NOTICE 検証までを実行し、自動ゲート結果を JSON/Markdown で保存 |
| `pnpm release:qa-log` | manifest から候補ビルド用 QA ログ草稿を生成 |
| `pnpm release:qa-log:verify:draft` | CI と候補作成時に、QA ログ草稿の構造、必須 ID、結果値が壊れていないことを検証 |
| `pnpm release:qa-log:verify -- --path <qa-log-path>` | 手動 QA 完了後に、全自動ゲート・全手動 QA・配布判定・sign-off が出荷可能な状態か検証 |
| `pnpm release:notes` | manifest から配布ページ・リリースノート草稿を生成 |
| `pnpm release:notes:verify:draft` | CI と候補作成時に、リリースノート草稿の構造、必須セクション、SHA-256 転記が壊れていないことを検証 |
| `pnpm release:notes:verify -- --path <release-notes-path>` | 公開前に、草稿文や空の既知制限行が残っていないことを検証 |
| `pnpm check:release` | version 整合、Tauri 設定、CI ゲート、リリース文書の preflight |

## 2. 生成物

Windows 配布候補として最低限確認するファイル:

- `apps/studio/src-tauri/target/release/cts-studio.exe`
- `apps/studio/src-tauri/target/release/bundle/msi/Compose Tutor Studio_0.1.0_x64_en-US.msi`
- `apps/studio/src-tauri/target/release/bundle/nsis/Compose Tutor Studio_0.1.0_x64-setup.exe`
- `apps/studio/src-tauri/target/release/release/release-manifest.json`
- `apps/studio/src-tauri/target/release/release/SHA256SUMS.txt`
- `apps/studio/src-tauri/target/release/release/release-source-status-report.json`
- `apps/studio/src-tauri/target/release/release/release-source-status-report.md`
- `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.json`
- `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.md`
- `apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.json`
- `apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.md`
- `apps/studio/src-tauri/target/release/release/release-signing-report.json`
- `apps/studio/src-tauri/target/release/release/release-signing-report.md`
- `apps/studio/src-tauri/target/release/release/THIRD_PARTY_NOTICES.json`
- `apps/studio/src-tauri/target/release/release/THIRD_PARTY_NOTICES.md`
- `apps/studio/src-tauri/target/release/release/release-gates-report.json`
- `apps/studio/src-tauri/target/release/release/release-gates-report.md`
- `apps/studio/src-tauri/target/release/release/release-qa-log-draft.md`
- `apps/studio/src-tauri/target/release/release/release-notes-draft.md`
- CI artifact `cts-windows-release-candidate-<commit-sha>`

`release-manifest.json` と `SHA256SUMS.txt` は `pnpm release:manifest` で生成します。manifest の `sourceControl` には git commit、branch、dirty/clean state、`git status --short` が記録されます。`release-source-status-report.json/md` は `pnpm release:source-status` で生成し、dirty entries を Product source、Release automation、Release evidence などに分類し、Product/runtime、Validation、Release readiness のレビュー束も出力します。`pnpm release:source-status:verify` は、その分類レポートが manifest の `sourceControl` と同じ commit、branch、dirty entries、レビュー束、Markdown follow-up を持つことを検証します。`pnpm release:verify` は manifest、sourceControl、SHA256SUMS、実ファイルのサイズと SHA-256 が一致することを検証します。公開前は `pnpm release:verify:publish` を使い、同じ検証に加えて manifest の sourceControl が clean であることも確認します。`release-installer-metadata-report.md/json` は `pnpm release:installers:verify` で生成し、portable exe / MSI / NSIS の製品名、バージョン、MSI UpgradeCode が manifest と Tauri 設定に合っていることを検証します。`release-installer-smoke-plan.md/json` は `pnpm release:installers:smoke:plan` で生成し、クリーンな Windows QA 環境で NSIS/MSI のインストール、起動、アンインストールを確認するための候補ビルド別手順を保存します。このコマンド自体はインストールを実行しません。`pnpm release:installers:smoke:verify` は、生成済みの手順が manifest、SHA-256、MSI ProductCode、必須手順と一致していることを検証します。`release-signing-report.md/json` は `pnpm release:signing` で生成し、`pnpm release:signing:verify` で manifest と署名状態の整合性を検証します。`THIRD_PARTY_NOTICES.md/json` は `pnpm release:notices` で生成し、`pnpm release:notices:verify` で検証します。`release-gates-report.json` と `release-gates-report.md` は `pnpm release:gates:report` で生成します。`release-qa-log-draft.md` は `pnpm release:qa-log` で生成します。`release-notes-draft.md` は `pnpm release:notes` で生成します。配布ページや release note に SHA-256、署名状態、NOTICE、隠れた通信がないことを載せ、QA 済みの成果物とユーザーがダウンロードする成果物を照合できる状態にしてください。

候補ビルドの証跡を保存する時は `pnpm release:archive` を実行し、`docs/releases/<version>-<release-candidate>/` に manifest、SHA256SUMS、release-source-status-report、release-installer-metadata-report、release-installer-smoke-plan、release-signing-report、THIRD_PARTY_NOTICES、ゲートレポート、QA ログ、配布ノートを残します。保存後は `pnpm release:archive:verify` で archive 内の `release-source-status-report.json`、ファイル名、署名状態、インストーラ手動QA手順、SHA-256 の整合性を確認します。release archive は候補ビルドごとの人間向け証跡なので、CI の自動ゲートでは実行しません。

手動 QA を記入した後は、配布前に次を実行して QA ログが出荷可能な状態か確認します。草稿の `Not run` が残っている状態では失敗します。

```bash
pnpm release:qa-log:verify -- --path docs/releases/<version>-<release-candidate>/release-qa-log.md
pnpm release:notes:verify -- --path docs/releases/<version>-<release-candidate>/release-notes.md
```

MSI の `upgradeCode` は `a776024f-6b69-5d06-8534-15426c9c632a` に固定しています。product name 変更や installer 設定変更時も、既存ユーザーを別アプリ扱いにしないため、意図した移行計画なしに変更しないでください。

## 3. Windows インストーラ手動 QA

新しい Windows ユーザー環境、または既存インストールを削除した状態で確認します。
手動QAの実行証跡として、`REL-MAN-001`、`REL-MAN-002`、`REL-MAN-003`、`REL-MAN-004`、`REL-MAN-005`、`REL-MAN-007`、`REL-MAN-008`、`REL-MAN-009` を `Pass` にする場合は、QA ログのメモに確認環境、使った手順またはログ、観察した結果を残します。`REL-MAN-001` と `REL-MAN-002` は `release-installer-smoke-plan.md/json` の手順、または保存した PowerShell / `msiexec` 実行ログへの参照を必ず残してください。

| ID | 確認内容 | 期待結果 |
|---|---|---|
| REL-MAN-001 | NSIS installer を起動してインストールする | インストールが完了し、スタートメニューまたはインストール先から起動できる |
| REL-MAN-002 | MSI を別環境またはクリーン状態で実行する | インストールが完了し、アプリが起動できる |
| REL-MAN-003 | 初回起動でスタート画面からサンプル曲を再生する | 音が鳴り、画面が固まらない |
| REL-MAN-004 | 新規プロジェクトを作成して保存し、アプリを閉じて再起動する | スタート画面の「前回の続き」から同じプロジェクトを読み込みできる |
| REL-MAN-005 | プロジェクトファイルを書き出し、別タイトルに変更してから読み込み直す | 書き出し前のタイトルと内容に戻る |
| REL-MAN-006 | MIDI を書き出し、外部アプリまたはファイルサイズで確認する | `.mid` ファイルが生成され、空ファイルではない。`pnpm test:e2e` は MThd/MTrk ヘッダーとサイズを補助検証する |
| REL-MAN-007 | WAV を書き出し、OS 標準プレイヤーで開く | `.wav` ファイルが生成され、再生できる。`pnpm test:e2e` は RIFF/WAVE ヘッダー、PCM 形式、data サイズを補助検証する |
| REL-MAN-008 | 書き出し/読み込みで OS 標準ファイルダイアログを使う | 保存先や読み込み元をユーザーが選択できる |
| REL-MAN-009 | 上部のサポート画面と、未処理エラー画面を開くテストビルドまたは一時的な例外で診断ログを確認する | どちらからも診断情報をコピーでき、クリップボード拒否時は手動コピー用診断情報が表示される。レポートにアプリバージョン、user agent、診断IDが含まれ、ローカルパスは `[local-path]` になる |
| REL-MAN-010 | オフライン状態で主要機能を使う | 隠れたネットワーク要求なしで、作成・保存・書き出しができる。`pnpm check:privacy` と `pnpm test:e2e` の実行時通信監視で補助検証する |
| REL-MAN-011 | `SHA256SUMS.txt` の SHA-256 と配布予定ファイルを照合する | manifest に記録された hash と配布ファイルの hash が一致する |

## 4. リリース判定

配布してよい条件:

- 自動ゲートがすべて成功している
- Windows インストーラ手動 QA の重大項目が成功している
- 手動QAの実行証跡が QA ログのメモに残っている
- 既知の制限が release note に書かれている
- コード署名が無いビルドでは、Windows 警告が出る可能性を配布ページに明記している
- `docs/12_release_qa_log.md` を元にした候補ビルド別 QA ログが残っている
- `docs/13_distribution_release_notes.md` を元にした配布ページまたは release note が残っている
- `pnpm release:archive` で候補ビルド別の証跡を `docs/releases/` に保存している
- `pnpm release:archive:verify` で保存済み証跡の SHA-256 整合性を確認している
- CI artifact `cts-windows-release-candidate-<commit-sha>` に配布成果物と release 証跡が保存されている
- `pnpm release:installers:verify` が成功し、配布予定インストーラの製品名、バージョン、MSI UpgradeCode が一致している
- `release-installer-smoke-plan.md` を使って、クリーンな Windows QA 環境で NSIS/MSI のインストール、起動、アンインストールを確認している
- `pnpm release:qa-log:verify -- --path <qa-log-path>` が成功している
- `pnpm release:notes:verify -- --path <release-notes-path>` が成功している
- `pnpm check:secrets` が成功し、署名鍵や証明書secretが repository と release 証跡に混入していない
- `pnpm check:assets` が成功し、サンプル音源や第三者素材が source tree に混入していない
- `pnpm release:signing:verify` が成功し、`release-signing-report.json` の署名状態と配布ページの説明が一致している
- `pnpm release:notices:verify` が成功し、`THIRD_PARTY_NOTICES.md` を配布ページから参照できる
- 署名または updater を有効化した場合は、`docs/14_signing_and_update_plan.md` の追加チェックが通っている
- MSI `upgradeCode` が `a776024f-6b69-5d06-8534-15426c9c632a` のまま固定されている

配布を止める条件:

- 保存、読み込み、MIDI/WAV 書き出しのいずれかでデータ損失または空ファイルが起きる
- 起動時に真っ白画面になり、診断情報も取れない
- 意図しない外部通信が見つかる
- 署名鍵、証明書secret、private key が repository、CIログ、release 証跡に混入している
- サイズ予算を超えた理由を説明できない
