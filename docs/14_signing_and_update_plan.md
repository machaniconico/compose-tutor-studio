# 14. コード署名・更新配信計画

この文書は、Compose Tutor Studio の Windows 版を未署名配布から署名済み配布、さらに自動更新対応へ進めるための運用計画です。証明書、秘密鍵、配布先が確定するまでは、`tauri.conf.json` に updater を有効化しません。

## 1. 現在の状態

| 項目 | 状態 | 方針 |
|---|---|---|
| Windows code signing | 未導入 | 配布ページで未署名ビルドと SmartScreen 警告を明記する |
| Tauri updater | 未導入 | 署名鍵と update endpoint が確定するまで有効化しない |
| MSI upgradeCode | 固定済み | `a776024f-6b69-5d06-8534-15426c9c632a` を維持する |
| Release manifest | 導入済み | `pnpm release:manifest` と `pnpm release:verify` を release gate に含める |
| Release signing report | 導入済み | `pnpm release:signing` と `pnpm release:signing:verify` で Authenticode 状態を記録・検証する |
| User-facing notice | 導入済み | `docs/13_distribution_release_notes.md` を候補ビルドごとに更新する |

## 2. 公式仕様からの制約

- Windows で SmartScreen 警告を避ける、または Microsoft Store へ掲載するには code signing が必要です。
- 未署名でも実行自体は可能ですが、ユーザーが SmartScreen 警告を理解して進める必要があります。
- Tauri updater は update artifact の署名検証を必須とし、無効化できません。
- Tauri updater の秘密鍵を失うと、既存ユーザーへ同じ更新鍵で新しい update を配布できなくなります。
- `TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` は CI secret として扱い、`.env` や repository に保存しません。
- Windows signing で `signtool.exe` の場所が必要な場合は `TAURI_WINDOWS_SIGNTOOL_PATH` を使います。
- Windows MSI の `upgradeCode` は、product name 変更などで accidental に変わらないよう固定値を設定する必要があります。Compose Tutor Studio では `a776024f-6b69-5d06-8534-15426c9c632a` を固定値として使います。

References:

- Tauri Windows code signing: <https://v2.tauri.app/distribute/sign/windows/>
- Tauri updater signing: <https://v2.tauri.app/plugin/updater/>
- Tauri environment variables: <https://v2.tauri.app/reference/environment-variables/>
- Tauri configuration reference: <https://v2.tauri.app/reference/config/>

## 3. 導入フェーズ

### Phase 0: 未署名配布を安全に扱う

完了条件:

- `pnpm release:manifest` と `pnpm release:verify` が成功している
- `pnpm check:secrets` が成功し、署名鍵や証明書secretが repository と release 証跡に含まれていない
- `pnpm release:signing` と `pnpm release:signing:verify` が成功し、`release-signing-report.json` が `unsigned-limited` である
- `docs/12_release_qa_log.md` に QA 結果が残っている
- `docs/13_distribution_release_notes.md` に未署名ビルド、SmartScreen、SHA-256 照合方法が書かれている
- ユーザーに署名済みであると誤解させる表現がない

このフェーズでは updater を有効化しません。

### Phase 1: Windows code signing を導入する

準備するもの:

- Code signing certificate
- 証明書の発行元名
- Timestamp server
- CI から署名できる秘密情報の保管先
- 署名後 artifact の SHA-256 再生成手順

実装作業:

- `tauri.conf.json` の Windows bundle signing 設定を追加する
- 必要に応じて `TAURI_WINDOWS_SIGNTOOL_PATH` を CI に設定する
- 署名済み exe / MSI / NSIS で `pnpm release:manifest` を再実行する
- 署名済み exe / MSI / NSIS で `CTS_RELEASE_REQUIRE_SIGNED=1 pnpm release:signing:verify` を実行する
- `docs/13_distribution_release_notes.md` の未署名注意を署名済み確認手順へ差し替える

完了条件:

- 署名済み成果物の publisher が期待した発行元名で表示される
- SmartScreen / browser warning の挙動を QA ログに記録している
- `SHA256SUMS.txt` は署名後 artifact の hash を記録している
- `release-signing-report.json` の `signingState` が `signed` である
- release note に証明書の確認方法を書いている

### Phase 2: Tauri updater の鍵を作成する

準備するもの:

- updater public key
- updater private key
- private key password
- key owner
- recovery owner
- offline backup location
- rotation policy

実装作業:

- Tauri CLI の signer で update signing key を生成する
- public key だけを `tauri.conf.json` に設定する
- private key と password は repository に保存せず CI secret に入れる
- `TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` を release workflow だけに渡す

完了条件:

- private key が repository、logs、release artifacts に含まれていない
- key owner と recovery owner が `docs/12_release_qa_log.md` または release runbook に記録されている
- key loss 時の対応が明記されている

### Phase 3: 更新配信を有効化する

準備するもの:

- update endpoint
- channel policy
- rollback policy
- staged rollout policy
- forced update の判断基準
- update failure support path

実装作業:

- `@tauri-apps/plugin-updater` と Rust plugin を導入する
- `tauri.conf.json` に public key と endpoint を設定する
- `bundle.createUpdaterArtifacts` を有効化する
- CI で updater artifacts と signatures を生成する
- 更新前後の互換性テストを E2E または手動 QA に追加する

完了条件:

- 旧バージョンから新バージョンへ更新できる
- 不正な signature の update を拒否できる
- update 失敗時にユーザーが手動ダウンロードへ戻れる
- release note に update channel と rollback 方針が書かれている

## 4. Secret 管理

Repository に保存してはいけないもの:

- Code signing certificate private material
- Updater private key
- Updater private key password
- CI secret values
- Certificate export password

CI secret 候補:

| Secret | 用途 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | updater artifact の署名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater private key の password |
| `TAURI_WINDOWS_SIGNTOOL_PATH` | Windows signing tool の明示パスが必要な場合 |
| `WINDOWS_SIGNING_CERTIFICATE` | 採用する署名方式に応じて定義 |
| `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` | 採用する署名方式に応じて定義 |

## 5. リリース時の追加チェック

署名導入後は、通常の release gate に加えて次を確認します。

| ID | 確認内容 | 期待結果 |
|---|---|---|
| SIGN-001 | exe / MSI / NSIS の署名情報を確認する | Publisher が期待した発行元名である |
| SIGN-002 | 署名後に `pnpm release:manifest` を再実行する | SHA-256 が署名済み artifact を指している |
| SIGN-003 | `pnpm release:verify` を実行する | manifest、SHA256SUMS、実ファイルが一致する |
| SIGN-004 | 配布ページの署名状態を確認する | 未署名/署名済みの説明が実物と一致する |
| SIGN-005 | MSI `upgradeCode` を確認する | `a776024f-6b69-5d06-8534-15426c9c632a` から変わっていない |
| SECRETS-001 | `pnpm check:secrets` を実行する | 署名鍵、証明書secret、private key が repository や release 証跡に含まれない |
| UPD-001 | updater artifact と signature を生成する | signature file が release artifact に含まれる |
| UPD-002 | 旧バージョンから更新する | データを失わず新バージョンが起動する |
| UPD-003 | 不正な signature の update を試す | update が拒否される |
| UPD-004 | update endpoint が落ちている状態で起動する | アプリ本体の作成・保存・書き出しは使える |

## 6. 配布判断

未署名配布で許容する条件:

- 初期テスター、限定配布、または社内検証である
- SHA-256 と SmartScreen 警告を明記している
- QA ログに未署名であることを記録している

一般ユーザー向け配布へ進める条件:

- Windows code signing が導入されている
- 署名済み artifact で QA が完了している
- 配布ページに publisher と SHA-256 が書かれている
- updater を有効化する場合は、署名鍵と rollback path が確認済みである

配布を止める条件:

- 署名状態と配布ページの説明が一致しない
- private key や certificate secret が repository、logs、artifact に漏れている
- updater key を失った、または key owner が不明
- 署名後 artifact に対して manifest を再生成していない
