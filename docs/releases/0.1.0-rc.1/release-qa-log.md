# Release QA Log Draft - Compose Tutor Studio 0.1.0 rc.1

Generated from `apps/studio/src-tauri/target/release/release/release-manifest.json` at 2026-06-30T18:56:51.188Z.

This is a prefilled QA draft. Artifact rows and machine-verifiable distribution decisions are filled from release evidence. Manual QA, publish-page checks, CI artifact confirmation, strict publish verifications, and final sign-off remain `Not run` until a tester runs the Windows installer checks and signs off. For `REL-MAN-001`, `REL-MAN-002`, `REL-MAN-003`, `REL-MAN-004`, `REL-MAN-005`, `REL-MAN-007`, `REL-MAN-008`, and `REL-MAN-009`, a `Pass` result must include the tested environment, command/log evidence, and observed result in Notes. `REL-MAN-001` and `REL-MAN-002` must reference `release-installer-smoke-plan.md` / `release-installer-smoke-plan.json` or the saved PowerShell / `msiexec` log.

## 1. Candidate Build

| Item | Record |
|---|---|
| Product | Compose Tutor Studio |
| Version | 0.1.0 |
| Release candidate | rc.1 |
| QA date | 2026-07-01 |
| Tester |  |
| OS / edition | Windows 11 / Windows 10 |
| Machine type | Physical / VM |
| Install state | Clean install / Upgrade |
| Platform | windows-x64 |
| Source branch or commit | wave5/desktop@5e9096d (dirty: 62 change(s)) |
| Source full commit | 5e9096d8a1557f930acf34fa47df4b426db57811 |
| CI artifact | `cts-windows-release-candidate-<commit-sha>` |
| Release manifest generated at | 2026-06-30T18:56:28.032Z |
| Signing state | Unsigned limited distribution |

## 2. Source Review Plan

Use this table before final QA sign-off. Dirty source bundles must be reviewed, committed, or otherwise resolved before publishing. The strict publish verifier still requires a clean source manifest.

Source status report:

- `apps/studio/src-tauri/target/release/release/release-source-status-report.json`
- `apps/studio/src-tauri/target/release/release/release-source-status-report.md`

| Bundle | Entries | Categories | Review status | Notes |
|---|---:|---|---|---|
| Product and desktop runtime | 32 | Product source, Desktop runtime, Packages, Workspace config | Not run | Review user-visible behavior, desktop runtime configuration, shared package metadata, and workspace metadata as one app change set. |
| Validation coverage | 20 | Tests and QA | Not run | Review unit, integration, and E2E coverage against the product/runtime changes before trusting the candidate. |
| Release readiness | 10 | CI, Release automation, Release evidence | Not run | Review CI, release policy, generated evidence, archive contents, and distribution docs after product changes are settled. |

## 3. Distribution Artifacts

Run `pnpm release:gates:report`, `pnpm release:qa-log`, `pnpm release:qa-log:verify:draft`, and `pnpm release:notes` for the candidate build before copying this log to `docs/releases/`. After manual QA is complete, run `pnpm release:qa-log:verify -- --path <qa-log-path>` before publishing.

| Type | File | SHA-256 | Size | Result |
|---|---|---|---|---|
| Portable exe | `apps/studio/src-tauri/target/release/cts-studio.exe` | `a98e6ae81d9d0dd7fec9996a5c1b3bfb9f00f6276b63611741904917413c4941` | 14.05 MiB | Pass |
| MSI installer | `apps/studio/src-tauri/target/release/bundle/msi/Compose Tutor Studio_0.1.0_x64_en-US.msi` | `0fdaf46073d5ddb05742a35ab600f245ceb54f1d10c80211dfaca02e5be652e8` | 3.16 MiB | Pass |
| NSIS installer | `apps/studio/src-tauri/target/release/bundle/nsis/Compose Tutor Studio_0.1.0_x64-setup.exe` | `7922bf279320a055c9d193f936765de51319b6dbfcd3848cb227aacd3e0d96f9` | 2.11 MiB | Pass |

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
| `pnpm check` | Pass | Finished 2026-06-30T18:55:25.844Z; 7.9s |
| `pnpm check:privacy` | Pass | Finished 2026-06-30T18:55:26.471Z; 627ms |
| `pnpm check:secrets` | Pass | Finished 2026-06-30T18:55:27.170Z; 699ms |
| `pnpm check:assets` | Pass | Finished 2026-06-30T18:55:27.743Z; 572ms |
| `pnpm build` | Pass | Finished 2026-06-30T18:55:32.673Z; 4.9s |
| `pnpm check:size` | Pass | Finished 2026-06-30T18:55:33.273Z; 599ms |
| `pnpm test:e2e` | Pass | Finished 2026-06-30T18:55:38.023Z; 4.8s |
| `pnpm build:desktop` | Pass | Finished 2026-06-30T18:56:26.839Z; 49s |
| `pnpm check:size:desktop` | Pass | Finished 2026-06-30T18:56:27.463Z; 624ms |
| `pnpm release:manifest` | Pass | Finished 2026-06-30T18:56:28.096Z; 633ms |
| `pnpm release:source-status` | Pass | Finished 2026-06-30T18:56:28.740Z; 644ms |
| `pnpm release:source-status:verify` | Pass | Finished 2026-06-30T18:56:29.342Z; 601ms |
| `pnpm release:verify` | Pass | Finished 2026-06-30T18:56:29.935Z; 593ms |
| `pnpm release:verify:publish` | Not run |  |
| `pnpm release:installers:verify` | Pass | Finished 2026-06-30T18:56:31.335Z; 1.4s |
| `pnpm release:installers:smoke:plan` | Pass | Finished 2026-06-30T18:56:31.920Z; 585ms |
| `pnpm release:installers:smoke:verify` | Pass | Finished 2026-06-30T18:56:32.519Z; 599ms |
| `pnpm release:signing` | Pass | Finished 2026-06-30T18:56:34.429Z; 1.9s |
| `pnpm release:signing:verify` | Pass | Finished 2026-06-30T18:56:35.000Z; 571ms |
| `pnpm release:notices` | Pass | Finished 2026-06-30T18:56:35.796Z; 796ms |
| `pnpm release:notices:verify` | Pass | Finished 2026-06-30T18:56:36.369Z; 573ms |
| `pnpm release:gates:report` | Pass | Generated `apps/studio/src-tauri/target/release/release/release-gates-report.json` at 2026-06-30T18:56:38.197Z |
| `pnpm release:qa-log` | Pass | Generated this draft |
| `pnpm release:qa-log:verify:draft` | Not run |  |
| `pnpm release:notes` | Pass | Finished 2026-06-30T18:56:36.954Z; 585ms |
| `pnpm release:notes:verify:draft` | Pass | Finished 2026-06-30T18:56:37.565Z; 611ms |
| `pnpm check:release` | Pass | Finished 2026-06-30T18:56:38.197Z; 631ms |

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
