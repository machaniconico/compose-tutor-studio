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
- MIDI / WAV エクスポート、ローカル保存

## 技術構成

- React 19 + TypeScript (strict) + Vite — ブラウザで動作（将来 Tauri 2 でデスクトップ化可能な構成）
- Web Audio API + lookahead scheduler
- pnpm workspaces モノレポ

```
apps/studio          アプリ本体 (React + Vite)
packages/theory-engine    音楽理論ロジック（純粋TS・単体テスト）
packages/project-model    Project スキーマ / バリデーション
packages/midi-io          MIDI エクスポート
packages/tutorial-engine  レッスンDSL / 達成判定
docs/                仕様書一式
```

## 開発

```bash
pnpm install
pnpm dev        # 開発サーバー
pnpm test       # 全パッケージのテスト
pnpm typecheck
pnpm build
```

## Cloudflare Pages へのデプロイ

studio は web-first の SPA なので Cloudflare Pages にそのまま載せられます。

**ビルド設定（Pages プロジェクト作成時）:**

| 項目 | 値 |
|---|---|
| Framework preset | None (Vite) |
| Build command | `pnpm install && pnpm --filter @cts/studio build` |
| Build output directory | `apps/studio/dist` |
| Root directory | （リポジトリルートのまま） |
| Node version | 20 以上（`NODE_VERSION=20` を環境変数に）|

**ローカルでの本番ビルド確認:**

```bash
pnpm --filter @cts/studio build     # apps/studio/dist に出力
pnpm --filter @cts/studio preview   # dist をローカル配信して確認
```

- SPA フォールバックは `apps/studio/public/_redirects`（`/* /index.html 200`）が担い、ビルド時に `dist/` 直下へコピーされます。
- 配信はルート（`/`）想定で `base: '/'`。サブパス配信が必要な場合のみ `vite.config.ts` の `base` を変更してください。
- 手動デプロイする場合は `wrangler pages deploy apps/studio/dist --project-name <name>`。

## 仕様書

`docs/` 配下に要件定義・機能仕様・チュートリアル仕様・UI/UX・アーキテクチャ・データモデル等の一次仕様（v0.1）を同梱しています。
