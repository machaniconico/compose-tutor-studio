# Compose Tutor Studio

教育統合型の作曲アプリ。初心者が「DAWの操作」と「作曲理論」を同時に学びながら、8〜16小節のオリジナル曲を完成させ、MIDI/WAVとして書き出せます。

## MVPでできること

- プロジェクト作成（テンポ・キー・拍子・小節数・テンプレート）
- Chord Track: コード進行タイムライン（度数・機能・次コード候補・初心者向け解説）
- Scale Assist 付きピアノロール（スケール内外の可視化、コードトーン強調）
- ドラムステップシーケンサー（16ステップ、テンプレート付き）
- Bass / Melody Assistant（生成候補に「なぜその音か」の説明付き）
- ベーシックミキサー（音量・パン・ミュート・ソロ）
- Web Audio 内蔵音源（シンセ・ドラム）
- 段階式チュートリアルと理論演習
- MIDI / WAV エクスポート、ブラウザ世代保存、デスクトップSQLite保存

## 技術構成

- React 19 + TypeScript (strict) + Vite — Web版とデスクトップ版で同じrendererを使用
- Tauri 2 + Rust — macOS / Windows / Linux向けの最小権限デスクトップシェル
- Web Audio API + lookahead scheduler
- pnpm workspaces モノレポ

```
apps/studio               共通アプリ本体 (React + Vite)
apps/desktop              Tauri 2デスクトップシェル / native WebView E2E
packages/theory-engine    音楽理論ロジック（純粋TS・単体テスト）
packages/project-model    Project スキーマ / バリデーション
packages/project-persistence 非同期保存契約 / 世代復旧 / 保存競合制御
packages/midi-io          MIDI エクスポート
packages/tutorial-engine  レッスンDSL / 達成判定
docs/                仕様書一式
```

## 開発

```bash
pnpm install
pnpm dev        # Web開発サーバー
pnpm dev:desktop # Tauriウィンドウ + Vite HMR
pnpm test       # 全パッケージのテスト
pnpm typecheck
pnpm build
pnpm --dir apps/studio exec playwright install chromium  # 初回のみ
pnpm e2e        # 初回曲→保存復元→MIDI/WAV/プロジェクト書き出し
pnpm verify     # typecheck + unit/integration + build + E2E
pnpm verify:desktop # Rust lint/test + 実WebView E2E + production build/size gate
```

Pull Request のCIはWebゲートに加え、Ubuntu / macOS / WindowsでRust検査、Tauri production build、実WebView E2Eを実行し、集約された `test` statusだけがauto-mergeを許可します。

### デスクトップ開発

Tauriの[公式prerequisites](https://v2.tauri.app/start/prerequisites/)に従い、Rust stableと対象OSのネイティブ開発環境を入れてください。Rustはリポジトリの `rust-toolchain.toml` で固定しています。

```bash
pnpm dev:desktop              # 開発版を起動
pnpm desktop:build:smoke      # production executable（bundleなし）
pnpm desktop:size:check       # OS/CPU別のexecutable上限を検査
pnpm desktop:e2e:native       # test専用binaryで実WebViewを検証
pnpm desktop:build:bundle     # 現在のOS向けbundleを生成
```

production rendererには汎用fs/dialog/shell権限やglobal Tauri APIを与えず、application-owned SQLite/file/close commandsだけを許可します。外部navigationと`window.open`もRust側で拒否します。native test用WebDriverは別feature・別target directory・incognito WebViewへ隔離され、通常buildには含まれません。最低runtimeはmacOS 12.4（Safari 15.5相当）とWebView2 105です。設計とrelease前条件は [`docs/12_desktop_shell.md`](docs/12_desktop_shell.md) を参照してください。

デスクトップ保存はRust/SQLite transaction、読込・書出しはpath非公開のnative picker commandを使用します。Apple notarization、Windows Authenticode署名、Linux AppImageを検証して3OSの候補artifactを組み立てるprotected release workflowは実装済みです。ただし署名identity・approval environmentを設定した実行はまだ行っていないため、署名済み商用installerが完成した状態ではありません。

## 保存と復旧

- プロジェクトJSONは `project-model` の単一codecで、サイズ・構造・schema version・値域を検証します。
- ブラウザ保存は最新データを直接1コピーだけ上書きせず、検証済みgenerationを先に書き、headを最後に切り替えます。
- 現在と証明済みのcommit祖先を優先して最低3世代を保持し、head/最新世代が破損した場合はpayload checksumまたは親commit tokenで検証できる世代から復元して画面上で通知します。
- `pagehide`ではWeb Locksを迂回してheadを書かず、独立recovery journalへ最新snapshotを同期退避します。
- 複数画面の異なる下書きは時計順で上書きせず、両方を保持して競合として表示します。保存一覧から各分岐を新しいコピーとして開けます。Web Locks非対応ブラウザでは安全でないcanonical更新を拒否します。
- 壊れたデータやfuture schemaは黙って削除せず、保存済み一覧に診断として残します。
- デスクトップ版では、全プロジェクト・復旧記録・学習進捗・WebView保存をまとめて消去できます。中断しても次回起動前に再開し、外部へ書き出したファイルには触れません。OSバックアップやSSD上の痕跡まで消すsecure eraseではありません。

保存プロトコルと故障時の不変条件は [`docs/11_persistence_protocol.md`](docs/11_persistence_protocol.md) を参照してください。

## Cloudflare Pages へのデプロイ

studio は web-first の SPA なので Cloudflare Pages にそのまま載せられます。

**ビルド設定（Pages プロジェクト作成時）:**

| 項目 | 値 |
|---|---|
| Framework preset | None (Vite) |
| Build command | `pnpm install && pnpm --dir apps/studio build` |
| Build output directory | `apps/studio/dist` |
| Root directory | （リポジトリルートのまま） |
| Node version | 20 以上（`NODE_VERSION=20` を環境変数に）|

**ローカルでの本番ビルド確認:**

```bash
pnpm --dir apps/studio build     # apps/studio/dist に出力
pnpm --dir apps/studio preview   # dist をローカル配信して確認
```

- SPA フォールバックは `apps/studio/public/_redirects`（`/* /index.html 200`）が担い、ビルド時に `dist/` 直下へコピーされます。
- 配信はルート（`/`）想定で `base: '/'`。サブパス配信が必要な場合のみ `vite.config.ts` の `base` を変更してください。
- 手動デプロイする場合は `wrangler pages deploy apps/studio/dist --project-name <name>`。

## 仕様書

`docs/` 配下に要件定義・機能仕様・チュートリアル仕様・UI/UX・アーキテクチャ・データモデル等の一次仕様（v0.1）を同梱しています。
