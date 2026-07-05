# 15. Privacy And Network Policy

Compose Tutor Studio の通常機能は、ユーザーの明示操作なしに外部ネットワークへ通信しません。診断ログはローカルに保存され、自動送信しません。

## 1. 現在の方針

- プロジェクト保存、読み込み、MIDI/WAV 書き出し、チュートリアル判定はローカルで完結する。
- Tauri 権限は `core:default`、`dialog:default`、`fs:default` に限定する。
- HTTP、WebSocket、updater、telemetry、remote import は導入しない。
- AI Coach は明示的な adapter とユーザー設定が入るまで mock 実装に留める。
- サポート時に診断情報が必要な場合も、ユーザーがコピーした内容だけを受け取る。

## 2. 自動ゲート

```bash
pnpm check:privacy
pnpm check:secrets
pnpm check:assets
```

このコマンドは次を検査します。

- `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`sendBeacon` などのブラウザ通信 API
- `@tauri-apps/plugin-http`、updater、HTTP/WebSocket 系 Tauri 権限
- `axios`、`ky`、`node-fetch`、`undici` などの通信依存
- `reqwest`、`ureq`、`hyper`、`std::net` などの Rust 通信利用
- Tauri の `devUrl` が localhost のみであること

`pnpm check:secrets` は、署名鍵、証明書secret、private key ブロック、`.p12` / `.pfx` / `.key` などの秘密情報が repository や release 証跡に混入していないことを検証します。外部通信を追加しない場合でも、署名や updater の準備中に秘密情報を誤って残さないため、CI と release gate で維持します。

`pnpm check:assets` は、許可済みアプリアイコン以外の画像、音声、動画、archive、署名素材ファイルが source tree に混入していないことを検証します。サンプル音源や第三者素材を追加する場合は、権利確認、出典、用途、配布可否を明文化し、allowlist を更新してください。

## 3. 例外を追加する条件

外部通信を追加する場合は、実装前に次を満たす必要があります。

- ユーザーに通信目的、送信内容、送信先を plain language で説明する。
- 既定値を off または明示 opt-in にする。
- `docs/13_distribution_release_notes.md` と配布ページに通信の有無を書く。
- `docs/12_release_qa_log.md` に手動 QA 項目を追加する。
- `pnpm check:privacy` の検出ルールまたは明示 allowlist を更新し、レビューで理由を残す。
