# デスクトップ版ビルド手順

Compose Tutor Studio のデスクトップ版は Tauri 2 を使います。画面は `apps/studio` の Vite アプリをそのまま使い、デスクトップ用のシェルだけを `apps/studio/src-tauri` に置いています。

## Windows でネイティブビルドする

1. Rust を入れます。
   - <https://rustup.rs/> から `rustup-init.exe` をダウンロードして実行します。
   - インストール後、新しい PowerShell を開いて `rustc --version` を確認します。
2. Visual Studio Build Tools を入れます。
   - 「Desktop development with C++」ワークロードを選びます。
   - MSVC C++ build tools と Windows SDK が必要です。
3. WebView2 Runtime を入れます。
   - Windows 11 では入っていることが多いですが、起動できない場合は Microsoft の WebView2 Runtime を入れてください。
4. 依存パッケージを入れます。

```bash
pnpm install
```

5. 開発モードで起動します。

```bash
pnpm dev:desktop
```

6. 配布用ビルドを作ります。

```bash
pnpm build:desktop
```

Windows ではビルドが成功すると、少なくとも次の成果物が作られます。

- `apps/studio/src-tauri/target/release/cts-studio.exe`
- `apps/studio/src-tauri/target/release/bundle/msi/Compose Tutor Studio_0.1.0_x64_en-US.msi`
- `apps/studio/src-tauri/target/release/bundle/nsis/Compose Tutor Studio_0.1.0_x64-setup.exe`

デスクトップ版では、MIDI / WAV / プロジェクトファイルの書き出しと、MIDI / プロジェクトファイルの読み込みに OS 標準のファイルダイアログを使います。Web 版では従来どおりブラウザのダウンロードとファイル入力にフォールバックします。

クラッシュや未処理エラーが起きた場合は、アプリ内にローカル診断ログを保存し、エラー画面から診断情報をコピーできます。このログは自動送信されません。スタック内のローカルファイルパスは `[local-path]` に置き換えます。

## WSL / Linux でビルドする場合

WSL や Linux で Tauri をビルドする場合は、Rust に加えて WebKitGTK などのネイティブ依存が必要です。Ubuntu 系では次のパッケージを入れてください。

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

その後、Windows と同じように `pnpm install`、`pnpm dev:desktop`、`pnpm build:desktop` を実行します。

## 既知のビルド注意点

Tauri 2.11 系の依存で、yank 済みの `time 0.3.48` が `Cargo.lock` に残っていると Rust 1.96 系で `cookie` / `tauri-utils` の trait 実装衝突が起きることがあります。その場合は次を実行してから再ビルドしてください。

```bash
cd apps/studio/src-tauri
cargo update -p time --precise 0.3.47
```

Windows バンドルでは `apps/studio/src-tauri/icons/icon.ico` が必要です。`icon.png` だけだと `Couldn't find a .ico icon` でバンドルに失敗します。

MSI の `upgradeCode` は `apps/studio/src-tauri/tauri.conf.json` に固定しています。Tauri の既定値は product name から導出されるため、product name を変えると Windows が別アプリとして扱う可能性があります。意図した移行計画なしに `upgradeCode` を変更しないでください。

pnpm 10/11 は依存の build script を承認制にします。このプロジェクトでは Vite の依存である `esbuild` の postinstall だけが必要なので、`pnpm-workspace.yaml` の `allowBuilds` で `esbuild: true` を固定します。非対話環境で `pnpm install` や release コマンドが止まる場合は、`pnpm ignored-builds` が `None` になることを確認し、必要なら `pnpm rebuild` を実行してください。

## 検証

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

`pnpm test:e2e` は、初回起動からサンプル曲再生、保存、MIDI 書き出しまでの smoke と、新規プロジェクトの保存、リロード後の「前回の続き」、プロジェクトファイルの書き出し/読み込み round trip を検証します。

`pnpm check:size` は Web 版の JS / CSS バンドル予算を検査します。`pnpm check:size:desktop` は Web 版に加えて、Windows の `cts-studio.exe`、MSI、NSIS installer のサイズ予算も検査します。現時点の予算は、依存追加や大きなアセット混入を早く検知するための上限です。

`pnpm release:gates:report` は `pnpm check`、`pnpm check:privacy`、`pnpm check:secrets`、`pnpm check:assets`、`pnpm build`、`pnpm check:size`、`pnpm test:e2e`、`pnpm build:desktop`、`pnpm check:size:desktop`、`pnpm release:manifest`、`pnpm release:source-status`、`pnpm release:source-status:verify`、`pnpm release:verify`、`pnpm release:installers:verify`、`pnpm release:installers:smoke:plan`、`pnpm release:installers:smoke:verify`、`pnpm release:signing`、`pnpm release:signing:verify`、`pnpm release:notices`、`pnpm release:notices:verify` を順に実行し、`apps/studio/src-tauri/target/release/release/release-gates-report.json` と `release-gates-report.md` を生成します。開発中に短い検証だけを記録したい場合は `CTS_RELEASE_GATE_COMMANDS` に JSON 配列または改行区切りのコマンドを指定できます。

`pnpm check:privacy` は、隠れた通信 API、通信依存、HTTP/updater 系 Tauri 権限が入っていないことを検証します。詳細は `docs/15_privacy_network_policy.md` を参照してください。

`pnpm check:secrets` は、署名鍵、証明書secret、private key ブロック、`.p12` / `.pfx` / `.key` などの秘密情報が repository や release 証跡に混入していないことを検証します。実際の署名証明書や updater private key は CI secret またはオフライン保管に置き、repository や release archive へ置かないでください。

`pnpm check:assets` は、許可済みアプリアイコン以外の画像、音声、動画、archive、署名素材ファイルが source tree に混入していないことを検証します。サンプル音源や第三者素材を追加しないための gate です。

`pnpm release:manifest` は `apps/studio/src-tauri/target/release/release/release-manifest.json` と `SHA256SUMS.txt` を生成します。manifest には `sourceControl` として git commit、branch、dirty/clean state、`git status --short` の行も記録します。`pnpm release:source-status` は同じ source 状態を分類した `release-source-status-report.json` と `release-source-status-report.md` を生成し、Product source、Release automation、Release evidence などの片付け単位に分けます。`pnpm release:source-status:verify` は source status report が manifest の `sourceControl` と同じ commit、branch、dirty entries、分類、Markdown follow-up を持つことを検証します。`pnpm release:verify` は manifest、sourceControl、SHA256SUMS、実際の exe / MSI / NSIS のサイズと SHA-256 を照合します。公開前は `pnpm release:verify:publish` を使い、manifest の sourceControl が clean であることも検証します。`pnpm release:installers:verify` は `release-installer-metadata-report.json` と `release-installer-metadata-report.md` を生成し、portable exe / MSI / NSIS の製品名、バージョン、MSI UpgradeCode を検証します。`pnpm release:installers:smoke:plan` は `release-installer-smoke-plan.json` と `release-installer-smoke-plan.md` を生成し、クリーンな Windows QA 環境で実施する NSIS/MSI のインストール、起動、アンインストール手順を候補ビルドに固定します。このコマンドはインストールを実行しません。`pnpm release:installers:smoke:verify` は生成済みスモーク計画が manifest、SHA-256、MSI ProductCode、必須手順と一致していることを検証します。`pnpm release:signing` は `release-signing-report.json` と `release-signing-report.md` を生成し、exe / MSI / NSIS の Authenticode 署名状態を記録します。`pnpm release:signing:verify` は署名レポートが manifest のファイルと一致し、署名状態が `Valid` または `NotSigned` として安全に説明できることを検証します。署名済み配布を必須にする段階では `CTS_RELEASE_REQUIRE_SIGNED=1` を付けて実行してください。`pnpm release:notices` は `THIRD_PARTY_NOTICES.md/json` を生成し、`pnpm release:notices:verify` は未知・未レビュー・強い copyleft 系 license がないことを検証します。`pnpm release:qa-log` は `release-qa-log-draft.md` を生成し、候補ビルドの QA ログ草稿にファイル名、サイズ、SHA-256、ソース状態、インストーラメタデータ、インストーラ手動QA手順、署名状態、自動ゲート結果を転記します。`pnpm release:qa-log:verify:draft` は QA ログ草稿の構造と必須 ID を検証します。`pnpm release:notes` は `release-notes-draft.md` を生成し、配布ページ向けのダウンロード表に SHA-256 と署名状態の根拠を転記します。`pnpm release:notes:verify:draft` はリリースノート草稿の構造と SHA-256 転記を検証します。配布前に、この SHA-256 と実際に公開する exe / MSI / NSIS が一致していることを確認してください。

候補ビルドを保存する段階では、`pnpm release:archive` を実行します。`docs/releases/<version>-<release-candidate>/` に manifest、SHA256SUMS、release-source-status-report、release-installer-metadata-report、release-installer-smoke-plan、release-signing-report、THIRD_PARTY_NOTICES、ゲートレポート、QA ログ草稿、配布ノート草稿をコピーします。archive の `README.md` には `Source Status Summary`、`Source Status`、公開前の `pnpm release:verify:publish` follow-up も記録されます。保存後は `pnpm release:archive:verify` を実行し、archive 内の manifest、SHA256SUMS、`release-source-status-report.json`、インストーラメタデータ、インストーラ手動QA手順、署名レポート、QA ログ、配布ノート、NOTICE に同じファイル名と SHA-256 や必要な参照が載っていることを確認してください。既存の archive を置き換える場合だけ `CTS_RELEASE_ARCHIVE_OVERWRITE=1` を設定してください。

CI では、すべての検証が通った後に `actions/upload-artifact@v7` で `cts-windows-release-candidate-${{ github.sha }}` を保存します。対象は portable exe、MSI、NSIS installer、`apps/studio/src-tauri/target/release/release/**` の release 証跡です。`if-no-files-found: error` で欠落を失敗扱いにし、`include-hidden-files: false` で隠しファイルを含めず、`retention-days: 30` と `compression-level: 0` を使います。

手動 QA をすべて記入した後は、配布前に `pnpm release:qa-log:verify -- --path docs/releases/<version>-<release-candidate>/release-qa-log.md` を実行します。この厳格チェックは、全自動ゲート、全手動 QA、配布判定、sign-off が出荷可能な状態でなければ失敗します。

公開用リリースノートを仕上げた後は、`pnpm release:notes:verify -- --path docs/releases/<version>-<release-candidate>/release-notes.md` を実行します。この厳格チェックは、草稿文や空の既知制限行が残っている場合に失敗します。

外部配布前は `docs/11_release_gate.md` の自動ゲートと Windows インストーラ手動 QA を通してください。
