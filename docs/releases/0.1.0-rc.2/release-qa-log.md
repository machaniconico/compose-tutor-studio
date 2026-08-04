# Release QA Log Draft - Compose Tutor Studio 0.1.0 rc.1

Generated from `apps/studio/src-tauri/target/release/release/release-manifest.json` at 2026-07-06T21:43:24.767Z.

This is a prefilled QA draft. Artifact rows and machine-verifiable distribution decisions are filled from release evidence. Manual QA, publish-page checks, CI artifact confirmation, strict publish verifications, and final sign-off remain `Not run` until a tester runs the Windows installer checks and signs off. For `REL-MAN-001`, `REL-MAN-002`, `REL-MAN-003`, `REL-MAN-004`, `REL-MAN-005`, `REL-MAN-007`, `REL-MAN-008`, and `REL-MAN-009`, a `Pass` result must include the tested environment, command/log evidence, and observed result in Notes. `REL-MAN-001` and `REL-MAN-002` must reference `release-installer-smoke-plan.md` / `release-installer-smoke-plan.json` or the saved PowerShell / `msiexec` log.

## 1. Candidate Build

| Item | Record |
|---|---|
| Product | Compose Tutor Studio |
| Version | 0.1.0 |
| Release candidate | rc.1 |
| QA date | 2026-07-07 |
| Tester |  |
| OS / edition | Windows 11 / Windows 10 |
| Machine type | Physical / VM |
| Install state | Clean install / Upgrade |
| Platform | windows-x64 |
| Source branch or commit | wave5/desktop@0c179c2 (dirty: 12 change(s)) |
| Source full commit | 0c179c2848a52500b985e1ff435f5169d4fe798a |
| CI artifact | `cts-windows-release-candidate-<commit-sha>` |
| Release manifest generated at | 2026-07-06T21:43:04.051Z |
| Signing state | Unsigned limited distribution |

## 2. Source Review Plan

Use this table before final QA sign-off. Dirty source bundles must be reviewed, committed, or otherwise resolved before publishing. The strict publish verifier still requires a clean source manifest.

Source status report:

- `apps/studio/src-tauri/target/release/release/release-source-status-report.json`
- `apps/studio/src-tauri/target/release/release/release-source-status-report.md`

| Bundle | Entries | Categories | Review status | Notes |
|---|---:|---|---|---|
| Product and desktop runtime | 6 | Product source | Not run | Review user-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata as one app change set. |
| Validation coverage | 5 | Tests and QA | Not run | Review unit, integration, and E2E coverage against the product/runtime changes before trusting the candidate. |
| Release readiness | 1 | Release evidence | Not run | Review CI, release policy, generated evidence, archive contents, and distribution docs after product changes are settled. |

## 3. Distribution Artifacts

Run `pnpm release:gates:report`, `pnpm release:qa-log`, `pnpm release:qa-log:verify:draft`, and `pnpm release:notes` for the candidate build before copying this log to `docs/releases/`. After manual QA is complete, run `pnpm release:qa-log:verify -- --path <qa-log-path>` before publishing.

| Type | File | SHA-256 | Size | Result |
|---|---|---|---|---|
| Portable exe | `apps/studio/src-tauri/target/release/cts-studio.exe` | `379b7e502e27bafbf03d71f7c9f2abe989867234b3c17e1094893175c3bffeb1` | 14.06 MiB | Pass |
| MSI installer | `apps/studio/src-tauri/target/release/bundle/msi/Compose Tutor Studio_0.1.0_x64_en-US.msi` | `7eec0b9df45b811c862c11c651240511e14e0f585278e0dad433b8dd968cb8fa` | 3.16 MiB | Pass |
| NSIS installer | `apps/studio/src-tauri/target/release/bundle/nsis/Compose Tutor Studio_0.1.0_x64-setup.exe` | `ca0b9c4d9ccc4584b0434985feb1c97666f0c7027a1181aa28c694be50d998a5` | 2.11 MiB | Pass |

Manifest:

- `apps/studio/src-tauri/target/release/release/release-manifest.json`
- `apps/studio/src-tauri/target/release/release/SHA256SUMS.txt`
- `apps/studio/src-tauri/target/release/release/release-gates-report.json`
- `apps/studio/src-tauri/target/release/release/release-source-status-report.json`
- `apps/studio/src-tauri/target/release/release/release-installer-metadata-report.json`
- `apps/studio/src-tauri/target/release/release/release-installer-smoke-plan.json`
- `apps/studio/src-tauri/target/release/release/release-signing-report.json`

Signing report:

- State: Unsigned limited distribution
- Guidance: Artifacts are unsigned. Limit distribution and show SmartScreen/SHA-256 guidance to users.

## 4. Automated Gate Results

| Command | Result | Notes |
|---|---|---|
| `pnpm check` | Pass | Finished 2026-07-06T21:41:59.732Z; 8.4s |
| `pnpm check:privacy` | Pass | Finished 2026-07-06T21:42:00.405Z; 673ms |
| `pnpm check:secrets` | Pass | Finished 2026-07-06T21:42:01.150Z; 745ms |
| `pnpm check:assets` | Pass | Finished 2026-07-06T21:42:01.740Z; 590ms |
| `pnpm build` | Pass | Finished 2026-07-06T21:42:06.914Z; 5.2s |
| `pnpm check:size` | Pass | Finished 2026-07-06T21:42:07.519Z; 605ms |
| `pnpm test:e2e` | Pass | Finished 2026-07-06T21:42:12.553Z; 5.0s |
| `pnpm build:desktop` | Pass | Finished 2026-07-06T21:43:02.885Z; 50s |
| `pnpm check:size:desktop` | Pass | Finished 2026-07-06T21:43:03.481Z; 596ms |
| `pnpm release:manifest` | Pass | Finished 2026-07-06T21:43:04.114Z; 633ms |
| `pnpm release:source-status` | Pass | Finished 2026-07-06T21:43:04.733Z; 619ms |
| `pnpm release:source-status:verify` | Pass | Finished 2026-07-06T21:43:05.323Z; 590ms |
| `pnpm release:verify` | Pass | Finished 2026-07-06T21:43:05.915Z; 592ms |
| `pnpm release:verify:publish` | Not run |  |
| `pnpm release:installers:verify` | Pass | Finished 2026-07-06T21:43:07.330Z; 1.4s |
| `pnpm release:installers:smoke:plan` | Pass | Finished 2026-07-06T21:43:07.911Z; 580ms |
| `pnpm release:installers:smoke:verify` | Pass | Finished 2026-07-06T21:43:08.508Z; 597ms |
| `pnpm release:signing` | Pass | Finished 2026-07-06T21:43:10.417Z; 1.9s |
| `pnpm release:signing:verify` | Pass | Finished 2026-07-06T21:43:11.007Z; 590ms |
| `pnpm release:notices` | Pass | Finished 2026-07-06T21:43:11.833Z; 826ms |
| `pnpm release:notices:verify` | Pass | Finished 2026-07-06T21:43:12.425Z; 592ms |
| `pnpm release:gates:report` | Pass | Generated `apps/studio/src-tauri/target/release/release/release-gates-report.json` at 2026-07-06T21:43:14.235Z |
| `pnpm release:qa-log` | Pass | Generated this draft |
| `pnpm release:qa-log:verify:draft` | Not run |  |
| `pnpm release:notes` | Pass | Finished 2026-07-06T21:43:13.028Z; 603ms |
| `pnpm release:notes:verify:draft` | Pass | Finished 2026-07-06T21:43:13.632Z; 604ms |
| `pnpm check:release` | Pass | Finished 2026-07-06T21:43:14.235Z; 603ms |

## 5. Windows Installer Manual QA

Record each result as `Pass`, `Fail`, `Blocked`, or `Not run`. For `Fail` or `Blocked`, include reproduction steps, expected result, actual result, and related logs. For manual `Pass` rows, include the tested environment, command or saved log, and observed result.

| ID | Check | Result | Notes |
|---|---|---|---|
| REL-MAN-001 | NSIS installer を起動してインストールする | Not run |  |
| REL-MAN-002 | MSI を別環境またはクリーン状態で実行する | Not run |  |
| REL-MAN-003 | 初回起動でスタート画面からサンプル曲を再生する | Not run | スタート画面、サンプル曲名、再生して音が出た結果を記録する |
| REL-MAN-004 | 新規プロジェクトを作成して保存し、アプリを閉じて再起動する | Not run | 新規プロジェクト名、保存先、再起動後に復元した内容を記録する |
| REL-MAN-005 | プロジェクトファイルを書き出し、別タイトルに変更してから読み込み直す | Not run | 書き出したプロジェクトファイル、別タイトル、読み込み後のタイトルを記録する |
| REL-MAN-006 | MIDI を書き出し、外部アプリまたはファイルサイズで確認する | Pass | `pnpm test:e2e` confirmed the downloaded MIDI file has MThd/MTrk headers and non-empty content. |
| REL-MAN-007 | WAV を書き出し、OS 標準プレイヤーで開く | Not run | `pnpm test:e2e` confirmed the downloaded WAV file has RIFF/WAVE headers and non-empty PCM data. OS player playback remains manual. |
| REL-MAN-008 | 書き出し/読み込みで OS 標準ファイルダイアログを使う | Not run | 書き出しと読み込みの OS 標準ファイルダイアログで選択した場所を記録する |
| REL-MAN-009 | 上部のサポート画面と、未処理エラー画面を開くテストビルドまたは一時的な例外で診断ログを確認する | Not run | サポート画面、未処理エラー画面、クリップボード拒否時の手動コピー用診断情報をそれぞれ確認する |
| REL-MAN-010 | オフライン状態で主要機能を使う | Pass | `pnpm check:privacy` found no hidden network capability, and `pnpm test:e2e` confirmed the offline core workflow made no external requests. |
| REL-MAN-011 | `SHA256SUMS.txt` の SHA-256 と配布予定ファイルを照合する | Pass | `pnpm release:verify` confirmed manifest, SHA256SUMS.txt, file sizes, and actual artifact hashes. |

## 6. Known Limitations

| Limitation | User impact | Release note entry | Planned follow-up |
|---|---|---|---|
|  |  | Not written |  |

## 7. Distribution Decision

| Item | Result |
|---|---|
| 自動ゲートがすべて成功している | Pass |
| 重大な手動QA項目が成功している | Not run |
| 既知の制限が release note に書かれている | Not run |
| `pnpm check:privacy` が成功している | Pass |
| `pnpm check:secrets` が成功している | Pass |
| `pnpm check:assets` が成功している | Pass |
| `pnpm release:installers:verify` が成功している | Pass |
| コード署名なしの警告を配布ページに明記している | Not run |
| `docs/13_distribution_release_notes.md` を元に配布ページを作成している | Not run |
| 配布ページに SHA-256 を記載している | Not run |
| `pnpm release:archive` で候補ビルド別の証跡を `docs/releases/` に保存している | Not run |
| `pnpm release:archive:verify` で保存済み証跡の SHA-256 整合性を確認している | Not run |
| CI artifact `cts-windows-release-candidate-<commit-sha>` に配布成果物と release 証跡が保存されている | Not run |
| `pnpm release:qa-log:verify -- --path <qa-log-path>` が成功している | Not run |
| `pnpm release:notes:verify -- --path <release-notes-path>` が成功している | Not run |
| `pnpm release:notices:verify` が成功している | Pass |
| `pnpm release:signing:verify` が成功している | Pass |
| 署名または updater を有効化した場合、`docs/14_signing_and_update_plan.md` の追加チェックを実施している | Pass |
| MSI `upgradeCode` が `a776024f-6b69-5d06-8534-15426c9c632a` のまま固定されている | Pass |
| 配布してよい | No |

Sign-off:

- QA:
- Engineering:
- Release owner:
