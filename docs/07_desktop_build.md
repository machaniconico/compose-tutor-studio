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
pnpm --dir apps/studio dev:desktop
```

6. 配布用ビルドを作ります。

```bash
pnpm --dir apps/studio build:desktop
```

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

その後、Windows と同じように `pnpm install`、`pnpm --dir apps/studio dev:desktop`、`pnpm --dir apps/studio build:desktop` を実行します。

## この開発環境での制約

このリポジトリを編集している現在の WSL 環境には `cargo` が入っていません。そのため、この環境では Rust 側の `cargo check` や Tauri のコンパイル検証は実行しません。Rust ソースは Tauri 2 の公式テンプレートに沿った最小構成に保ち、実際の Rust コンパイル確認は Windows 側の環境で行ってください。

フロントエンド側は通常どおり次を実行して、既存の Web 版の挙動が壊れていないことを確認します。

```bash
pnpm --dir apps/studio typecheck
pnpm --dir apps/studio test
```
