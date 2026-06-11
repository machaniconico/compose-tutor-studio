# 10. 参考調査メモ

## 1. Claude Code 概要

- URL: https://code.claude.com/docs/ja/overview
- 仕様への反映: Claude Code はコードベース読解、ファイル編集、コマンド実行、開発ツール連携を行う agentic coding ツール。

## 2. Claude Code Memory / CLAUDE.md

- URL: https://code.claude.com/docs/ja/memory
- 仕様への反映: CLAUDE.md はプロジェクト等の永続指示として各セッション開始時に読まれる。

## 3. Codex AGENTS.md

- URL: https://developers.openai.com/codex/guides/agents-md
- 仕様への反映: Codex は作業前に AGENTS.md を読み、グローバル指示とプロジェクト固有指示を重ねられる。

## 4. Codex Best Practices

- URL: https://developers.openai.com/codex/learn/best-practices
- 仕様への反映: AGENTS.md が肥大化する場合は、タスク別 Markdown に分けることが推奨される。

## 5. Steinberg Cubase Pro 15 New Features

- URL: https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/new_features/new_features.html
- 仕様への反映: Chord Track、Chord Pads、Scale Assistant、Sample Editor、VariAudio、MixConsole 等を参考機能として確認。

## 6. Apple Logic Pro

- URL: https://www.apple.com/logic-pro/
- 仕様への反映: Stem Splitter、Mastering Assistant、Chord ID、Chord Track、Session Players、Step Sequencer、Live Loops 等を参考機能として確認。

## 7. Ableton Live 12 All New Features

- URL: https://www.ableton.com/en/live/all-new-features/
- 仕様への反映: Stem Separation、MIDI Transformations、MIDI Generators、Keys and Scales、Link Audio 等を参考機能として確認。

## 8. Ableton Live 12 MIDI Tools Manual

- URL: https://www.ableton.com/en/live-manual/12/midi-tools/
- 仕様への反映: MIDI Tools は Transform / Generate パネルから使用し、scale-aware な生成・変換ができる。

## 9. Image-Line FL Studio 2026 Beta What's New

- URL: https://www.image-line.com/fl-studio-learning/fl-studio-beta-online-manual/html/basics_new.htm
- 仕様への反映: Remix a song、Chord detection、Audio Logger、Playlist audio clip controls 等を参考機能として確認。

## 10. Image-Line FL Studio 2025.2 News

- URL: https://www.image-line.com/news/fl-studio-2025-2
- 仕様への反映: Loop Starter、Fruity Slicer 2、Lifetime Free Updates 等を参考機能として確認。

## 11. Bitwig Studio 6

- URL: https://www.bitwig.com/stories/on-another-level-bitwig-studio-6-is-out-now-416/
- 仕様への反映: Automation Clips、Clip Aliases、Project-wide Key Signature、Note FX follows key 等を参考機能として確認。

## 12. Tauri 2.0 Stable Release

- URL: https://v2.tauri.app/blog/tauri-20/
- 仕様への反映: Tauri は Windows/macOS/Linux/モバイル向けの小型・高速なバイナリを作るフレームワーク。

## 13. React Versions

- URL: https://react.dev/versions
- 仕様への反映: React docs は最新メジャーバージョンのドキュメントを提供し、最新バージョンとして 19.2 を示していた。

## 14. MDN Web Audio API

- URL: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- 仕様への反映: Web Audio API は音源、エフェクト、可視化、空間効果等を扱うシステムを提供する。

## 15. MDN AudioWorklet

- URL: https://developer.mozilla.org/ja/docs/Web/API/AudioWorklet
- 仕様への反映: AudioWorklet は別スレッドでカスタム音声処理を実行し、低遅延処理に使える。

## 16. JUCE

- URL: https://juce.com/
- 仕様への反映: JUCE はクロスプラットフォームのオーディオアプリ/プラグイン開発フレームワーク。
## 調査からの設計判断

- Claude Code には `CLAUDE.md` を、Codex には `AGENTS.md` を用意する。どちらも仕様・開発ルール・テスト方針を短く保ち、詳細は `docs/` に分割する。
- 既存DAWの強みは「機能カテゴリ」として抽象化し、UIや文言は独自設計にする。
- Cubase/Logic/Ableton/FL/Bitwig の近年の方向性として、コード/スケール支援、MIDI生成/変換、ステム分離、AI/アシスタント、オートメーションやクリップ再利用の高度化が目立つ。ただしMVPでは実装負荷が小さく教育価値が高いコード/スケール/チュートリアルを優先する。
- Tauri + React + TypeScript はAIコーディングで分割実装しやすい。音声品質・遅延に問題が出た場合は、AudioWorkletからRust/JUCE系への移行を検討する。
