# 前提・仮定ログ

- 作成日: 2026-06-11
- 仕様バージョン: 0.1.0
- 仮称: Compose Tutor Studio
- 目的: Cubase Pro、Logic Pro、Ableton Live、FL Studio、Bitwig Studio などの強みを「教育統合型の作曲アプリ」として再設計する。
- 最重要方針: 初学者が 1 曲を完成させることを最優先にする。商用DAWの完全互換や全面的なプラグインホスト化は初期MVPから外す。
- 法務方針: 既存DAWの名称・UI・素材・プリセット・サンプル・マニュアル文言をコピーしない。機能アイデアを抽象化し、独自UI・独自チュートリアル・独自教材に落とし込む。
- 技術方針: MVP は Tauri + React + TypeScript + Web Audio / AudioWorklet を中心にし、低遅延・プラグインホスティング・高度なオーディオ編集は後続フェーズで JUCE / Rust native engine を検証する。
- AI方針: AIは「代作」ではなく、コード理論・作曲判断・練習問題・改善提案を説明するコーチとして扱う。
- 主要対象OS: Windows と macOS。Linux は将来対応候補。
- 主要成果物: 仕様書、AIコーディング指示ファイル、API/データモデル、ロードマップ、テスト計画、リスクメモ。
