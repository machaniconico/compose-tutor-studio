# 01. 製品要件定義 PRD

## 1. ペルソナ

### P1: 完全初心者

- DTMソフトを開いたことはあるが、何から始めるか分からない
- コード理論は断片的に知っている
- 目標は、SNSやYouTubeで使える短いBGMを作ること

必要な支援:

- 最短で音が出るテンプレート
- 次に何をすればよいかの表示
- 専門用語のインライン解説
- 「良い/悪い」ではなく「狙いに合っている/合っていない」という説明

### P2: ゲーム配信者・動画制作者

- 自分の動画・配信用にBGMやジングルを作りたい
- 既存BGMの権利問題を避けたい
- 完成までの速度を重視する

必要な支援:

- 15秒/30秒/60秒テンプレート
- ループ可能な構成
- 雰囲気プリセット: 明るい、緊張、チル、疾走感、レトロゲーム風など
- MIDI/WAV書き出し

### P3: 中級に進みたい学習者

- コード進行を使った作曲を学びたい
- メロディとコードの関係を理解したい
- 自分の作風を作りたい

必要な支援:

- 機能和声、借用和音、セカンダリードミナント等の段階的解説
- 自作進行の分析
- 代替コード提案
- メロディ添削

## 2. ユーザーストーリー

| ID | ユーザーストーリー | 優先度 | 受け入れ条件 |
|---|---|---:|---|
| US-001 | 初心者として、テンプレートから曲作りを始めたい | Must | 3クリック以内に音が鳴るプロジェクトを作れる |
| US-002 | 初心者として、コード進行を選ぶ理由を知りたい | Must | コード選択時に機能、響き、次の候補が表示される |
| US-003 | 初心者として、スケール外の音を避けたい | Must | ピアノロールでスケール内/外が視覚的に区別される |
| US-004 | 作曲者として、コードに合うベースを作りたい | Must | ルート/5度/経過音の候補を生成・説明できる |
| US-005 | 作曲者として、ドラムパターンを素早く作りたい | Must | 4/4基本パターンをステップシーケンサーで作れる |
| US-006 | 学習者として、課題を解く形で理論を覚えたい | Must | レッスン、演習、判定、解説、進捗保存ができる |
| US-007 | 動画制作者として、ループBGMを書き出したい | Must | MIDIとWAVをエクスポートできる |
| US-008 | 中級者として、借用和音を試したい | Should | モーダルインターチェンジ候補を提示できる |
| US-009 | ユーザーとして、AIに改善案を聞きたい | Should | プロジェクトのコード/メロディ情報から説明付き提案を返す |
| US-010 | 上級者として、外部VSTを使いたい | Could/Future | VST3 SDK/ライセンス確認後に実装判断 |
| US-011 | 動画制作者・学習者として、利用許諾のある既存曲からカラオケ練習用音源を作りたい | Should | 対応するステレオ音源を端末内で中央定位軽減し、A/B試聴後にWAVを書き出せる |
| US-012 | 作曲者として、曲に楽器・ドラム・音源・Busを足して音色と経路を整えたい | Must | production UIから安全に追加・複製・並べ替え・一般Track削除を行い、内蔵音色、main output、pre/post-fader sendを選んで保存・Undo・再生・WAVへ反映できる。schema v4では学習role Trackも改名できてroleを保持し、削除だけを保護する |
| US-013 | 作曲者として、手元の音声を曲へ置いて非破壊編集したい | Must | WAV / MP3 / M4A / AACをAudio Trackへ読み込み、移動、左右trim、gain、fade、loop、split、独立複製、削除をUndo/Redoでき、live再生・WAV・再読込で同じ範囲を使う |
| US-014 | 作曲者として、マイク入力を新規または既存のAudio Trackへ録音したい | Must | Audio Trackを1件だけ録音待機にでき、システム既定または列挙された入力を選び、最大60秒のdry録音を現在playheadから新しいClipとしてasset-firstで採用できる。成功はUndo 1回、失敗・cancelはProject不変とする |

## 3. MVP機能範囲

### 3.1 Project

- 新規作成
- テンポ、キー、拍子、長さ
- ローカル保存/読み込み
- 自動保存
- プロジェクトテンプレート

### 3.2 Composition

- Chord Track: 小節単位のコードイベント
- Piano Roll: ノート入力、移動、長さ変更、ベロシティ
- Drum Step Sequencer: キック、スネア、ハイハット、クラップ等
- Bass Assistant: コードルート、5度、オクターブ、経過音候補
- Melody Assistant: コードトーン、アプローチノート、モチーフ反復の可視化
- Pattern/Clip: 1〜4小節単位の素材を組み合わせる
- Track管理（部分実装）: instrument / drum / stereo Bus追加、音源fileからのAudio Track追加、non-master複製・並べ替え、一般non-master削除、内蔵synth 4音色の選択。schema v4の`Track.role`を学習上の正本にし、学習role Trackも名前を変更できる。学習roleの削除は保護し、一般TrackはChords / Bass / Melodyという名前でもroleを推測しない。Folder / Stackは後続とする
- Audio Clip: app-ownedな48 kHz mono/stereo PCM 16-bit WAVへ正規化し、移動、trim、gain、fade、loop、split、独立複製、削除を非破壊に行う。loop中は位相fieldがまだないためleft trimとsplitを無効にする

### 3.3 Learning

- 初回オンボーディング
- 基礎コース: 音名、半音/全音、メジャースケール、ダイアトニックコード
- 作曲コース: 8小節のコード進行、ドラム、ベース、メロディ、構成
- インライン解説
- 演習判定
- 復習キュー

### 3.4 Audio

- 内蔵シンプルシンセ
- 内蔵ドラム音源
- 音量、パン、ミュート、ソロ
- 簡易エフェクト: EQ/Filter、Delay、Reverb、Compressorの最小版
- WAVレンダリング
- app-owned Audio Assetのlive再生とoffline WAV取り込み。Project単体JSONには音声binaryを同梱せず、欠落・変更・storage不可を音声素材ごとに表示する
- 最大60秒の単一マイク入力録音。録音待機なしでは新規Audio Track、録音待機中の既存Audio Trackでは同Trackへ新しいAudio Clipを追加する。録音待機と入力device選択はruntime-onlyでProjectへ保存しない
- WAV/MP3/M4A/AACのステレオ音源を使う、ローカル完結の中央定位ボーカル軽減
- stereo Bus、各non-Masterのmain output、pre/post-fader send / return。循環は候補Project採用前に拒否し、live再生とoffline WAVで同じrouting graphを使う

### 3.5 Export

- MIDI書き出し
- WAV書き出し
- ボーカル軽減後のカラオケ用PCM 16-bit WAV書き出し
- プロジェクトJSON/SQLite保存

## 4. MVPから外す範囲

| 項目 | 理由 | 後続判断 |
|---|---|---|
| VST/AUホスト | SDK、ライセンス、安定性、クラッシュ分離が重い | v1.5以降で検証 |
| ASIO正式対応 | Windowsドライバ、SDK、ユーザー環境依存が大きい | 低遅延が必要になった段階で検証 |
| Stem separation 本実装 | MLモデル、処理速度、権利、品質評価が重い | 外部API/ローカルモデル比較後 |
| 自動マスタリング本実装 | 音質評価・責任範囲が大きい | まずはラウドネス/ピーク診断に限定 |
| 楽譜エディタ | 実装量が大きい | MIDI編集が安定後 |
| クラウド同期 | 個人情報・音源データ扱いが増える | ローカル完結後 |
| VCA / side-chain / hardware I/O routing | stereo Busとpre/post-fader sendまでは利用可能だが、制御グループ、side-chain入力、外部入出力は対象外 | 基本routingとautomation UIが安定してから独立Batchで追加 |
| punch / cycle take / comp / 実測latency校正 | 単一入力の伴奏同期録音と推定＋手動位置補正までは持つが、再生中の任意punch、長時間streaming、loopback実測、take laneはまだ持たない | 3OS実機で共有clockと推定補正を検証し、loopback校正、cycle take、非破壊compの順で進む |

## 5. 非機能要件

| 分類 | 要件 | MVP基準 |
|---|---|---|
| 性能 | 再生開始レスポンス | 100ms以内を目標。要実測 |
| 性能 | UI操作 | ノート移動/ズーム/スクロールで目視カクつきが少ない |
| 安定性 | 自動保存 | 編集後30秒以内。デスクトップ版は編集受付後1秒未満を目標にクラッシュ保護ACKを表示し、ACK済み内容をOS強制終了後に復元 |
| 安定性 | 音声開始/中断 | 開始完了前は再生中と表示せず、失敗・出力中断後も編集を保持して再試行できる |
| 安定性 | Audio Asset | 1 object 128 MiB以下、canonical 48 kHz / 1〜2 channel PCM16 WAV、SHA-256と実byte lengthを保存・読込・再生前に照合する。decode済みcacheは256 MiB以下 |
| 互換性 | OS | Windows/macOS 優先 |
| アクセシビリティ | キーボード操作 | 主要操作はショートカット対応。単一文字キーは対応コントロールへのフォーカス中だけ有効にする |
| プライバシー | ローカル保存 | デフォルトではプロジェクトを外部送信しない |
| プライバシー | カラオケ作成 | 読み込んだ音源と生成音源を外部送信せず、Projectへ保存しない |
| 検証性 | テスト | theory engine は単体テスト必須、UIは主要フローE2E |

## 6. 完了の定義

- 初回ユーザーがテンプレートから曲を作り、保存し、再起動後に読み込める
- 8小節のコード進行に対して、ドラム、ベース、メロディを作成できる
- レッスンの開始、判定、完了、進捗保存ができる
- MIDI/WAVを書き出せる
- 利用許諾のあるステレオ音源から、ローカル処理でカラオケ用WAVを作成できる
- instrument / drum / Audio / Bus Trackの管理と音色・routing変更が、Master保護、schema v4学習roleの改名時維持・削除保護、128 Track上限、Undo/Redo、自動保存、再読込、再生で一貫する
- Audio Trackへ取り込んだ音声を非破壊編集でき、live再生とWAVが同じsource range / gain / fade / loopを使う。欠落・変更されたbinaryは別素材へ黙って置換せず、Project metadataを保持して説明する
- システム既定または選択した単一マイクから、新規または録音待機中の既存Audio Trackへ録音できる。録音待機と入力deviceはProject保存・履歴を汚さず、採用したAsset / ClipだけをUndo 1回で戻せる
- 主要ロジックにテストがある
- 既存DAWのUIコピーではなく、独自デザインである
