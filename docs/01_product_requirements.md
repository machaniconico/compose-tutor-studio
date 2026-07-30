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
| US-014 | 作曲者として、マイク入力を新規または既存のAudio Trackへ録音したい | Must | Audio Trackを1件だけ録音待機にでき、システム既定または列挙された入力を選び、通常は現在playheadから1 Clip、明示loop時は2〜128回の固定passを連続録音して自動take folderとして採用できる。さらに明示Punch範囲ではpre/post-roll付きのbounded Auto Punchを行い、既存素材を旧takeとして残して新takeを採用する。いずれもasset-first・Undo 1回、途中停止・失敗・cancelはProject不変とする |
| US-015 | 作曲者として、同じ区間を複数回録った素材から良い部分をつないで仕上げたい | Must | 同一Audio Track・同一時間窓の既存Clipを非破壊take folderへまとめ、複数範囲を別takeへ切り替え、境界調整・未使用take削除・Undo/Redo・保存/再読込・live/WAVで同じcompを使える |
| US-016 | 作曲者として、音量やパンの変化を一時的に外して元のTrack設定と聴き比べたい | Must | non-Masterのvolume / panとeffective Masterの出力volumeをRead / Bypassで切り替え、Bypass中もpointを保持・編集できる。live再生とWAVはBypass時にTrack scalarを使い、Undo / Redo・保存 / 再読込後も同じ状態になる |
| US-017 | 作曲者として、再生しながらミキサー操作をオートメーションへ記録したい | Must | non-Master Trackの音量 / パンとeffective Masterの出力音量についてRead / Touch / Latch / Writeを選び、Touchは操作中だけ、Latchは最初の操作からパンチアウトまで、Writeは再生開始から対応targetを記録できる。Master Writeは音量だけを扱う。1 passをProject変更・Undo・保存revision各1回で確定し、Writeは警告確認後だけ有効化して確定後Touchへ戻る。modeと記録中状態はruntime-only、確定curveだけを保存する |

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
- Audio Take Comp: 同一Audio Track・同一時間窓の既存非loop Clipをschema v5のtake folderへまとめるほか、明示loop範囲を2〜128回だけ連続録音した各周をexact Audio Assetとして自動take folder化する。bounded Auto Punchでは空き範囲へexact Clipを置くか、範囲を覆う既存Clip / exact folderへ新takeを非破壊追加して全域採用する。生成全体を1 gesture = 1 Undoで保存する

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
- 0.5〜60秒の単一マイク入力録音。録音待機なしでは新規Audio Track、録音待機中の既存Audio Trackでは同Trackへ追加する。loop OFF / punch OFFは1 Clip、loop ONは2〜128固定pass、punch ONは録音待機中の既存Audio Trackへ明示`[in, out)`だけを録るbounded Auto Punchとする。Punchはloopと排他で、pre-rollから伴奏、future render frameのinでcapture、out＋正latency tailでcapture完了、post-roll自然完了の両方を確認してから採用する。60秒上限は正のlatency tailを含み、途中停止・cancel・unmount・失敗では全体を破棄する。録音待機、入力device、loop / punch locator、roll / pass指定はruntime-onlyでProjectへ保存しない
- WAV/MP3/M4A/AACのステレオ音源を使う、ローカル完結の中央定位ボーカル軽減
- stereo Bus、各non-Masterのmain output、pre/post-fader send / return。循環は候補Project採用前に拒否し、live再生とoffline WAVで同じrouting graphを使う
- non-Master Trackのvolume / panとeffective Masterのoutput volume Automation lane。pointのhold / linear curve編集、parameter-lane Read / Bypass、TrackまたはMaster / Global Readを保存・Undoできる。いずれかのRead gateが無効ならpointを破棄せず、live再生とoffline WAVの両方で対象Track scalarを使う
- 対応Track別のRead / Touch / Latch / Write。再生pass中はミキサー / Track Listの音量・パン操作を一時bufferへ記録し、停止、自然終了、seek、loop右端などのパンチアウトでcurveを1回だけ確定する。effective Masterは音量だけを記録する。mode、Armed / Writing、pointer / keyboard gesture所有権はruntime-onlyで、Project切替・再読込時はReadへ戻す

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
| Quick Punch / 長時間streaming / 複数入力 / MIDI・named comp | 単一入力の伴奏同期録音、物理loopback実測校正、既存Clipの手動take folder化、明示loopの固定pass cycle capture、pre/post-roll付きbounded Auto Punchと非破壊take採用までは持つ。disk streaming、既存再生を継続したまま任意時点でin/outするQuick Punch、自動input monitoring、複数入力、MIDI comp、複数の名前付きcomp / flattenは持たない | boundedなlocal captureを3OS実機で検証した後、長時間streaming、Quick Punch、複数I/Oを独立gateで追加する |
| 高度なAutomation target / mode | non-Master Trackのvolume / panとeffective Masterのoutput volumeに対するRead / Touch / Latch / Write、Global / TrackまたはMaster / lane Read gateまでは利用可能。Master pan、later Master、insert / send / tempo、MIDI CC / LFO、Trim / Relative / Cross-Over / Fill、parameter group単位のSuspend、複数loopへ連続記録するpass管理は持たない | 現行passのfailure atomicityと実機操作を固定した後、target追加と高度modeを別々のgateで追加 |

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
- 選択した楽器・ドラム・Audio Trackを、保存済みmute/soloを無視しつつ到達可能な下流Bus、send、effects、automation、Master音量込みの単一WAVとして書き出せる。Bus/Master stem、batch、range、bit depth、MP3/M4A、加算再構成は対象外とする
- 利用許諾のあるステレオ音源から、ローカル処理でカラオケ用WAVを作成できる
- instrument / drum / Audio / Bus Trackの管理と音色・routing変更が、Master保護、schema v4学習roleの改名時維持・削除保護、128 Track上限、Undo/Redo、自動保存、再読込、再生で一貫する
- Audio Trackへ取り込んだ音声を非破壊編集でき、live再生とWAVが同じsource range / gain / fade / loopを使う。欠落・変更されたbinaryは別素材へ黙って置換せず、Project metadataを保持して説明する
- システム既定または選択した単一マイクから、新規または録音待機中の既存Audio Trackへ録音できる。録音待機と入力deviceはProject保存・履歴を汚さず、採用したAsset / ClipだけをUndo 1回で戻せる
- 明示loop範囲を2〜128回の固定passで完走すると、各周exact Asset、最初のtake全体を使うcomp、take folderが1回のUndoで作られる。途中停止・cancel・unmount・失敗では部分takeを採用しない
- 既存Audio Clipを非破壊take folderへまとめ、2つ以上の範囲を別takeへ切り替え、境界・未使用takeを編集できる。Undo/Redo、保存・再読込、live/WAVが同じgapless compを使う
- Global / Track / laneのRead gateとRead / Touch / Latch / Writeをproduction UIから操作できる。記録中はProject / historyを変えず、パンチアウト時だけcurveをUndo 1回で採用し、保存・再読込後のlive / WAVが同じcurveを使う一方、runtime-only modeはReadへ戻る
- 主要ロジックにテストがある
- 既存DAWのUIコピーではなく、独自デザインである
