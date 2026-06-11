# 00. プロジェクトブリーフ

## 1. ゴール

Compose Tutor Studio は、作曲初心者が「DAWの操作」と「作曲理論」を同時に学びながら、短い曲を完成できるデスクトップアプリです。

一般的なDAWは高機能ですが、初心者にとっては以下が障壁になります。

- 何から始めればよいか分からない
- コード進行、スケール、メロディ、ベース、ドラムの関係が見えにくい
- 機能名は分かっても、作曲上の使いどころが分からない
- チュートリアルが操作説明に偏り、音楽的な判断理由まで教えてくれない

このアプリは、作曲ワークフローの中に教材を埋め込みます。ユーザーがノートを置く、コードを選ぶ、セクションを増やす、ミックスするたびに「なぜそうするのか」を短く説明し、必要な演習へ誘導します。

## 2. 主要コンセプト

| コンセプト | 内容 | 実装上の意味 |
|---|---|---|
| Guided DAW | 初心者を曲完成まで案内するDAW | 画面上に次の行動、理由、練習課題を表示する |
| Theory-aware Editor | 音楽理論を理解するエディタ | キー、スケール、コード、機能和声、テンション、ボイスリーディングを内部モデル化 |
| Action-based Tutorial | 操作に連動する教材 | ユーザーの編集内容からチュートリアル進行を判定 |
| Idea-to-Song | 断片を曲にする支援 | ループ、コード、ドラム、ベース、メロディをセクション構造へ展開 |
| Explainable AI Coach | 代作ではなく説明するAI | 提案の根拠、別案、練習問題を返す |

## 3. 競合DAWから抽象化して取り込む強み

| 参照DAW | 参考にする方向性 | 本アプリでの再設計 |
|---|---|---|
| Cubase Pro | Chord Track、Chord Pads、Scale Assistant、MixConsole | コード進行を中心に、初心者向けの和声説明を重ねる |
| Logic Pro | Chord ID、Chord Track、Session Players、Stem Splitter、Mastering Assistant、Step Sequencer、Live Loops | AI/自動支援の結果だけでなく、理由と編集ポイントを表示する |
| Ableton Live | Session/Arrangement 的な発想、MIDI Generators/Transformations、Keys and Scales | ループの試作から曲構成へ移行できる二段階ワークフロー |
| FL Studio | Pattern/Channel Rack 的なビート制作、Piano Roll、Loop Starter、Chord detection | パターン単位で始め、セクションへ展開する初心者導線 |
| Bitwig Studio | Automation Clips、Clip Aliases、Project-wide Key Signature、modulation | 反復構造と変化を初心者にも見える形で編集する |
| Studio One / Fender Studio Pro | テンプレート、単一画面ワークフロー、マスタリング導線 | 作曲開始テンプレートと完成チェックリストを強化する |

## 4. 成功指標

| 指標 | MVP目標 | 測定方法 |
|---|---:|---|
| 初回曲完成率 | 60%以上 | 初回起動から7日以内に8小節以上の曲を保存/書き出し |
| チュートリアル完了率 | 50%以上 | 基礎コース完了ユーザー割合 |
| 離脱ポイント | 重大離脱画面を3箇所以内に特定 | イベントログ分析 |
| 学習効果 | 事前/事後テストで20%以上改善 | コード/スケール理解テスト |
| 安定性 | クラッシュ率 1%未満 | ローカル診断ログ、クラッシュレポート |

## 5. 非ゴール

- Cubase Pro / Logic Pro / Ableton Live / FL Studio / Bitwig Studio のクローンを作ること
- 初期段階でプロ向け録音・ミキシング・マスタリング機能をすべて実装すること
- 既存曲を模倣する生成AI機能を売りにすること
- 商用サンプルやプリセットを無断同梱すること

## 6. MVPの一文定義

初心者が、テンポ・キー・コード進行・ドラム・ベース・メロディの関係を学びながら、8〜16小節のオリジナル曲を作成し、MIDI/WAVとして書き出せるデスクトップアプリ。
