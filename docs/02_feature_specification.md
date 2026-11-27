# 02. 機能仕様

## 1. 機能一覧

| モジュール | 機能 | MVP | 説明 |
|---|---|---:|---|
| Project | 新規作成/保存/読み込み | Yes | WebはlocalStorage repository、Tauriはapplication-owned SQLiteへ自動保存。`.ctsproj.json`はProject metadataのexact交換、`.ctsbundle` v1はcanonical Projectとready Audio Assetを含む持ち運び用コピー |
| Template | 作曲テンプレート | Yes | 8小節、16小節、BGM、ジングル等 |
| Chord Track | コードタイムライン | Yes | 小節単位でコードを置く。機能と候補を表示 |
| Chord Palette | コード候補 | Yes | ダイアトニック、代理、借用、セカンダリ候補 |
| Scale Assist | スケールガイド | Yes | スケール内外を可視化。スナップ可能 |
| Piano Roll | MIDI編集 | Yes | ノート作成、移動、複製、量子化、ベロシティ、コピー・貼り付け、選択音の移調・スケール合わせ |
| Drum Sequencer | ステップ入力 | Yes | 16ステップ基本。後続で確率/スウィング |
| Clip Launcher | ループ試作 | Partial | MVPは簡易クリップ一覧。v1で非線形再生 |
| Arranger | セクション配置 | Yes | Intro/A/B/Chorus/Bridge/Outro ラベル |
| Mixer | 音量/パン/ミュート/ソロ/routing | Yes | 各トラックの基本操作、stereo Bus、main output、pre/post-fader sendを扱う。ルーティング欄の「リバーブ用リターンを追加」で、リバーブ入りのBus(リターン)の作成とpost-fader send(送り量0.3)の追加を1回のUndoで行う。有効なリバーブを含むBusが既にあれば再利用し、同じトラックからのセンドが既にあれば(無効にしてあっても)何も変えない |
| Automation | Track音量/パンとMaster出力音量の時間変化 | Yes | non-Master Trackの音量 / パンとeffective Masterの出力音量について、beat snap付きlane editor、hold / linear、lane Bypass、Global / TrackまたはMaster Readを保存し、再生中はRead / Touch / Latch / Writeで対応操作を記録する。mode自体はruntime-only |
| Effects | 基本エフェクト | Partial | Filter/Delay/Reverbを最小実装 |
| Tutorial | 操作・状態連動チュートリアル | Yes | 確定操作イベントと採用済みProject/UI状態を再照合して進行 |
| Glossary | 用語集 | Yes | チュートリアルタブの「用語集をひらく」で、ひらがな・カタカナ・英字から検索できる。レッスンの「なぜ？」と、ミキサーのセンドの見出しの用語にカーソルかフォーカスを置くと説明が出る(Escで閉じる)。説明は全て初心者向けの1種類 |
| Exercise | 理論演習 | Yes | コード判定、スケール判定、メロディ添削 |
| AI Coach | 説明付き改善提案 | Optional | APIキー設定時のみ。MVPではモック可 |
| Export | MIDI/WAV | Yes | MIDIはFormat 1の正規化projection、WAVは簡易レンダー |
| Export | ステムZIP | Yes | 鳴るInstrument / Drum / Audio Trackごとに1つのWAVを書き出し、STOREのZIP 1つにまとめる。mixerのmute / solo / Bus経路で鳴らないTrack(soloされたBusの入力源は含み、muteされたBusだけに流れるTrackは除く)とMaster / Busは含めず、mix.wavも含めない。全ステムは同じ長さ(最長のtail込みrenderにそろえ、各ステムが自分のtailを含む)で、WAV形式(サンプルレート・ビット数・ディザ)は書き出しダイアログの選択に従い、ノーマライズはしない(ステム間の音量差を保つ)。合計1 GiB超は書き出す前に拒否する。ファイル名は`01_Melody.wav`の形式 |
| Import | MIDI import | Yes | `.mid` / `.midi`を検証し、MTrkとchannelに応じた複数トラックを現在の曲へ追加する |
| Vocal Cut | カラオケ作成 | Yes | ステレオ中央定位をローカル軽減し、A/B試聴後にPCM 16-bit WAVへ書き出す。ML stem分離ではない |
| Track Management | Track追加・整理・音色 | Partial | production UIはinstrument / drum / stereo Busと音源fileからのAudio Trackを追加し、non-masterの複製・並べ替え、一般Trackの削除・改名、内蔵シンセ14音色と4つの音色調整を扱う。schema v4では学習role Trackも改名可能でroleを保持し、削除だけを保護する。Folder / Stackは未実装 |
| Audio Track | Audio file配置 / マイク録音 | Yes | fileまたは0.5〜60秒の単一マイク入力をapp-owned 48 kHz mono/stereo PCM16 WAVへ正規化する。loop / punch OFFは1 Clip、明示loop ONは2〜128固定pass、punch ONは既存の録音待機Trackへpre/post-roll付きbounded Auto Punchを行う。content-addressed保存、非破壊編集、live/WAV再生、欠落・変更診断を行い、Project JSON単体にはbinaryを同梱しない |
| Audio Take Comp | 既存Audio Clip、固定pass録音、Auto Punchからテイク編集 | Yes | 同一Track・同一時間窓のClipを手動でまとめるか、明示loopを完走した各passから自動take folderを作る。Auto Punchは範囲を覆う旧素材を残して新takeを全域採用し、範囲ごとの採用takeをlive/WAVへ反映する。再生中の任意Quick Punch / MIDI compingは未実装 |
| Elastic Audio | Audio Clipのタイミング / 単音pitch補正 | Partial | 60秒以内のready・非loop Clipでmanual timing point、単音pitch region、補正量、`formantMode: off / preserve`を非破壊編集し、解析波形 / pitch trace、A/B、Undo / Redo、保存、live / full / selected WAVへ接続する。manual formant / vibrato編集、polyphonic、極端なrate / shift品質、take folder / loop-cycle、phase-coherent multitrack、自動クオンタイズ / grooveは未実装 |
| Stem Separation | パート分離 | Future | 外部API/ローカルモデル検証後 |
| Plugin Host | VST3/AU | Future | ライセンス/安定性確認後 |

## 2. Chord Track

### 2.1 目的

曲全体の和声設計を可視化し、初心者がコード進行を理解しながら編集できるようにする。

### 2.2 UI要素

- タイムライン上部にコードレーンを固定表示
- 各コードイベントは `小節範囲 / コード名 / 機能 / 色` を持つ
- クリック時に右パネルで以下を表示:
  - コード構成音
  - キー内での度数
  - 機能: Tonic / Subdominant / Dominant / Other
  - 次に進みやすい候補
  - 初心者向け説明

### 2.3 入力仕様

- コード名直接入力: `C`, `Am`, `Fmaj7`, `G7`, `Dm7/G` など
- パレット選択: I, ii, iii, IV, V, vi, viiø
- 候補生成: 現在キーと直前コードから候補表示
- 進行テンプレート: I-V-vi-IV、vi-IV-I-V、ii-V-I など
- コードグリッドは `←` / `→` / `Home` / `End` で小節を選び、`Enter` / `Space` でその小節に追加できる
- コードイベントはクリック・タップまたは `Enter` / `Space` / `F2` で編集できる
- 編集ポップオーバーで開始小節と長さを数値入力でき、ドラッグ・リサイズのキーボード代替とする
- `Escape` または外側操作で閉じられ、適用・閉じる後は起点のコードへフォーカスを戻す
- コード削除後は次、前、グリッドの優先順で論理的なフォーカス先を選ぶ

### 2.4 判定仕様

- コードの構成音をノート番号で管理
- キーに対する度数を算出
- ダイアトニック内/外を判定
- 借用和音・セカンダリードミナントはタグ付け
- 初心者モードでは複雑なタグを折りたたむ

### 2.5 受け入れ条件

- Cメジャーで `C - G - Am - F` を置いたとき、I - V - vi - IV と表示される
- `E7 -> Am` を置いたとき、Amに対するセカンダリードミナント候補として説明できる
- コード変更時、ベース/メロディガイドが更新される
- 8小節の各コードにポインターとキーボードの両方で到達でき、横ズーム時も選択小節が表示範囲に入る
- 不正なコード名は保存せず、入力と関連付けた回復可能なエラーとして読み上げる

## 3. Piano Roll

### 3.1 目的

MIDIノート編集と同時に、スケール・コード・メロディ作法を学べる画面にする。

### 3.2 表示

- 縦軸: ピッチ
- 固定編集音域: C2〜C6。importされた音域外ノートはprojectとexportに保持するが、Piano Rollのノート表示・選択・Velocity Lane編集の対象外とする
- 横軸: 拍/小節
- ノート: 長方形
- コードトーン: 強調表示
- スケール内音: 通常表示
- スケール外音: 薄色/警告表示
- 解決先候補: ホバー時に表示
- ゴーストノート: 編集中以外のクリップ・Trackのノート(ループ/リンク展開後)を薄く重ねて参照用に表示する。既定はオン。表示専用で、選択・編集・クリックは受けず、projectにもexportにも影響しない。描画は編集音域内かつクリップ範囲内に限り、最大2,000件で打ち切る
- 音の役割の色分け: 「音の役割で色分け」をオンにすると、ノートをコードの音(●)・スケールの音(○)・スケールの外の音(◇)で色と記号の両方で区別する。既定はオフ。スケール外は誤りではなく経過音などに使える彩りの音として、中立の色・文言で示す。どちらの切替もUI状態のみで、保存しない

### 3.3 操作

- ダブルクリックでノート追加
- ドラッグで移動
- 端をドラッグで長さ変更
- Alt/Option + ドラッグで複製
- 「選択ノートをクオンタイズ」ボタンにフォーカス中のQで量子化
- 「スケールスナップ」ボタンにフォーカス中のSで切替
- 「コードトーン」ボタンにフォーカス中のCでChord Tone Highlight切替
- ツールバーの「ゆらぎ…」から、選択ノートに強さ(0〜100%、整数)つきクオンタイズと、シード付きの決定的ヒューマナイズ(タイミング±0〜240ティック、強さ±0〜40)をかける。どちらも480 PPQの整数ティックで開始位置を決め、1操作 = Undo 1回、全部通るか全部拒否される。録音中、開始位置が整数ティックでないクリップ、同じ高さのノートの重なり(P33と同じ規則: 全クリップ・エイリアス・ループの全回を、MIDI書き出しと同じ丸めの絶対ティックで比較し、端が接するだけなら認める。編集後の予定イベントが想定と完全一致しなければ取りやめる)、クリップ外への突き出し、ベロシティの1〜127外、くり返しクリップの周期変更は、やさしい日本語の理由つきで拒否する。シードは保存せず、ヒューマナイズを押すたびに新しく作る(テストでは同じシードで同じ結果)
- ノート移動・長さ・ベロシティのドラッグ中はローカルプレビューだけを表示し、主ポインターの`pointerup`で最終値を1回だけ確定する。1ジェスチャーはUndo 1回で全体を戻せる
- ドラッグ中のEscapeと`pointercancel`はプレビューを捨て、ドラッグ前のまま何も確定しない。ミキサー / Track Listの音量・パンのドラッグもStoreのgesture transactionで1ドラッグをUndo 1回にし、途中値はhistoryにも自動保存にも入れない（`docs/05_technical_architecture.md` 5.1.2）
- クリップ右端への追加はノート全体が収まる最後の開始位置へ置き、量子化の最近傍グリッドが終端を越える場合は最後の有効グリッドへ戻す
- `pointercancel`または予期しないpointer capture喪失では、プレビューを破棄し、project・履歴・revision・保存・教材イベントを変更しない
- 複数ノート移動は掴んだノートを基準に共通デルタを使い、クリップ・音域境界でも相対タイミングを維持する
- Scale Snap有効時も、上下方向に次のスケール音がC2〜C6内にない操作と、時間方向だけを要求した移動・複製がclip境界でbeat delta 0になる操作はno-opにする。直交方向の音高補正だけを確定しない
- Alt/Option複製は3px以上移動し、最終位置または音高が変わった`pointerup`で初めてIDを生成する。未確定コピーは実ノートとは別のゴースト表示にする
- 固定編集音域内のノートはトグルボタンとして音名・開始・長さ・強さ・スケール内外・選択状態を読み上げ、そのうち1音だけをTab順に入れる。Home/EndとShift+PageUp/PageDownで前後の音へフォーカス移動する
- coarse pointerではノートのpointer hit targetを最低24×24 CSS pxにする。Velocity Laneは固定編集音域内のノートだけを描画し、値比例の可視高を保ったまま透明な44px以上のhit領域を持つ
- ノート上の矢印キーは選択群を移動し、Shift+左右矢印は長さ、PageUp/PageDownは強さを変更する。非repeatの1 keydownを1 batchとして確定し、Undo 1回で戻す
- Enterは単独選択、Spaceは選択切替、Cmd/Ctrl+Aは現在clipの固定編集音域C2〜C6全体（水平viewport外を含む）を選択し、importされた音域外ノートは対象外とする。Cmd/Ctrl+Dは1グリッド先へ複製してコピーへフォーカスし、Delete/Backspaceは削除して次・前・空グリッドへフォーカスを戻す
- 固定編集音域内にノートがない空グリッドでは、グリッド自体をTab順に入れ、矢印/Home/Endで入力位置を動かし、Enter/Spaceでノートを追加してその音へフォーカスする。coarse pointerの空グリッドはbrowser/WebViewのnative pan・scroll gestureを妨げない

### 3.3.1 選んだ音のコピー・移調・スケール合わせ

- ツールバーの「コピー」「切り取り」「貼り付け」「元の位置に貼り付け」と、Cmd/Ctrl+C・X・V、Cmd/Ctrl+Shift+V(元の位置に貼り付け)。キーはPiano Rollを表示中だけ効き、文字入力欄・IME変換中・ダイアログ表示中は効かない。ページの文字を選んでいるときのコピー・切り取りはブラウザに任せる
- クリップボードはアプリ内だけで、OSのクリップボードは使わない。中身は高さ・強さと、いちばん早い音の開始からの相対位置・長さ(整数tick、PPQ 480)、コピーした時のクリップ内位置だけで、プロジェクト・クリップ・ノートのIDを持たない。そのため別の曲を開いても貼り付けられる。位置か長さが1/480拍の目盛りに乗っていない音を含む選択は、クオンタイズを案内してコピーを拒否する
- 「貼り付け」(Cmd/Ctrl+V)は、再生ヘッドが対象クリップの中ならいちばん早い音を再生ヘッドの位置に置き、外ならコピーした時と同じクリップ内位置に置く。同じクリップ内でコピーしてから再生ヘッドを動かして貼れば、そこへ置ける。「元の位置に貼り付け」(Cmd/Ctrl+Shift+V)は再生ヘッドにかかわらず、いつもコピーした時と同じクリップ内位置に置く。新しい音には新しいIDを付けて選択する
- 貼り付けは、1音でもクリップの終わりか曲の終わりを超える、同じトラックの同じ高さの音と重なる(下記)、1クリップの上限(20,000音)を超える場合に全体を拒否し、一部だけ貼ることはない。クリップの長さは変えない。リンククリップへの貼り付けは元のクリップへ書き、元を鳴らすすべての配置で上の条件を確かめる
- 「切り取り」はコピーしてから消す。消せた時だけクリップボードを書き換える
- 「半音↑」「半音↓」は半音、「オクターブ↑」「オクターブ↓」は12半音動かす(上限は±12半音)。「スケール↑」「スケール↓」は、隣の段数選択(1〜7段)の数だけ曲のキーとスケールの音をたどる(上限は±7段)。どのボタンも、動かす量にかかわらず1回押すとUndo 1段になる。スケール外の音は、動かす向きでいちばん近いスケール音までを1段と数え、残りをスケールに沿って動かす(C majorでC#4を1段上げるとD4、1段下げるとC4)
- 「スケールに合わせる(選んだ音だけ)」は、選んだ音のうちスケール外の音だけをいちばん近いスケール音へ寄せる(上下が同じ距離なら下)。スケール外の音は間違いではない(経過音・ブルーノートなど)ので自動では行わず、画面にその旨を説明する。選んだ音がすべてスケール内なら何も変えずに伝える
- 移調・スケール合わせは、1音でもMIDI 0〜127を外れる、または同じトラックの同じ高さの音と重なる(下記)場合に全体を拒否する
- 対象クリップ(元のクリップとそのリンクのすべての配置)の開始位置が1/480拍の目盛りに乗っていない時は、貼り付け・切り取り・移調・スケール合わせを理由を示して拒否する。ループする配置がある時、貼り付け・切り取りはループの長さ(最後の音の終わり)が変わらない場合だけ行い、変わるなら「ループしているクリップでは、ループの長さが変わる貼り付け・切り取りはできません。」と示して拒否する。移調・スケール合わせはループの長さを変えない
- 同じ高さの重なりは、編集後の`buildScheduleEvents`(全クリップ・リンク・ループの全回)をMIDI書き出しと同じ丸め(開始と終わりを別々にtickへ丸め、長さは最低1tick)で絶対tickに直して、同じトラック・同じ高さで区間が交わるかで判定する。端が接するだけなら可(MIDI書き出しと同じ)
- どの編集もUndo 1回で戻り、録音中・プロジェクト操作中は拒否する。適用前に、編集後の`buildScheduleEvents`全体が「編集前 − 消した音(移調では動かす前の音)の全配置・全回 + 足した音(移調では動かした後の音)の全配置・全回」と多重集合として完全に一致することを確かめ、他の音(コードの伴奏など)が少しでも変わるなら取りやめる
- 結果と拒否の理由は、ツールバーの下に重ねて出す1行と読み上げで初心者向けの日本語で伝える

### 3.3.2 コードを調べる(コード検出)

- コードレーンのヘッダーの「コード検出」ボタン(読み上げ名は「コードを調べる…」)で小さなポップオーバー(Piano Rollのツールバーには足さない)を開く(Escapeで閉じる)。選んだ音があればその音だけ、なければ範囲の中のすべての音から、合いそうなコード名を最大3つ、初心者向けの理由つきで出す。範囲は「小節 ○ から ○ まで」(1始まり、終わりを含む)で、開いた時は選んだ音が入る小節(選択なしはクリップ全体)になる
- 音を選んでいない時は、範囲で**実際に鳴る音**(再生と同じ`buildScheduleEvents`の、ドラム以外の全トラック・全クリップ・ループの繰り返し・リンクしたクリップ・スウィング込みの結果のうち、鳴っている間が範囲にかかるもの)から調べる。音を選んでいる時は、選んだ音だけを絶対位置で調べる。いちばん低い音は、前者は範囲で鳴る最低音、後者は選んだ最低音
- 音は音名(0〜11)だけで見て、オクターブは使わない。いちばん低い音だけは転回形・分数コードの判定に使う。音の長さによる重みづけはしない。判定は`theory-engine`の`detectChords`(範囲全体を1区間として扱う)
- 候補は目安で、「かもしれません」と書く。1位は「いちばん近い候補」、以降は「ほかの可能性」。理由には、入っている音(例「C・E・G が入っているので C(ドミソ)」)、足りない構成音、ほかに鳴っている飾りの音を書き、転回形は「第1転回形」、構成音の外の低音は「○を低音にした形」と分けて書く
- 音が1種類だけ、音がない、コードとして読めない時は、名前を決めずに「はっきりしたコードになっていません(経過音かもしれません)」などのやさしい説明を出す
- コードトラックのコードは低音(分数コードのベース)を持てないため、分数コード・転回形の候補を足す時は、再生とラベルがずれないよう元のコード(例 C/D は C)として足し、「低音(D)はコードトラックでは鳴らせないので、C として追加します」と伝える
- 「足す」は、その小節の範囲いっぱい(整数tick、曲の長さまでに切り詰め)の1つのコードをコードトラックに足す。Undo 1回で戻る。録音中・プロジェクト操作中、範囲が不正(開始が終わり以降、小数・負・曲の外)、またはその範囲に既存のコードが少しでも重なる時は、曲を変えずに日本語の理由を出して拒否する(コードレーンの「空き小節にだけ足す」規則と同じく、置き換えはしない)

### 3.4 学習連動

- スケール外音を置いた場合:
  - 初心者モード: 「これはキー外の音です。緊張感として使うか、近いスケール内音に移動できます。」と表示
  - 中級モード: アプローチノート、ブルーノート、クロマチック等の可能性を表示
- コードトーンに着地した場合:
  - 「安定した着地」として説明
- 連続跳躍が多い場合:
  - 「歌いやすさ」観点のアドバイスを表示

## 4. Drum Step Sequencer

### 4.1 目的

初学者がリズムの土台を早く作れるようにする。

### 4.2 MVP仕様

- 4/4、16ステップ
- レーン: Kick, Snare, Closed Hat, Open Hat, Clap, Perc
- ベロシティ: 3段階または0〜127
- Swing: 0〜100%（永続値0〜1）
- 全体probability: 0〜100%。DrumEventに個別probabilityがある場合はclip全体値より優先する
- velocity humanize: 0〜127。正のseedとevent identityから決定的に解決する
- Pattern length: 1/2/4小節
- clipが小節途中で終わる場合も`ceil(lengthBeats / beatsPerBar)`小節を表示する。最終partial barではstep開始beatがclip終端より前のcellだけを編集可能にし、終端以降はdisabledにする。clip長やeventを表示都合でpaddingしない
- Projectから作る再生用raw scheduleは、各hitにTrack / Clip / DrumEvent identity、元の`stepIndex`、clip終端、`stepsPerBar`、拍子由来の`beatsPerBar`、velocity、実効probability、swing、humanize、seedを自己完結して持つ。この値は再生開始時のProject snapshotから導出し、選択中clip、Drum Editorの表示有無、以前開いたprojectのUI状態へ依存しない
- ライブ再生とWAV書き出しは同じ純粋なoccurrence resolverを使う。swing対象はproject絶対beatではなくclip内の元step parityで決め、乱数saltはTrack / Clip / DrumEvent identityとunwrapped occurrence beatから作る。同じProject・seed・再生開始位置・loop regionなら、hitの採否、onset、velocityのevent planを再現できる
- resolverは、version tag、保存済みseed、Track / Clip / DrumEvent identity、lane、元step、1e-6 beatへ丸めたunwrapped raw occurrenceから32-bit `voiceSeed`を導出する。`voiceSeed`は再生用resolved payloadだけに持つ一時値で、Project / SQLite / project exportへ永続化しない
- swing後のonsetが、そのoccurrenceへ平行移動したclip終端以上ならhitを鳴らさない。no-loop schedulerはswing最大遅延分だけraw event探索を手前へ広げ、隣接するhalf-open window間で遅延hitを欠落・重複させない

### 4.3 テンプレート

- Four on the floor
- 8-beat pop
- Hip-hop basic
- Game loop basic
- Lo-fi basic

### 4.4 学習連動

- キック: 拍の重心
- スネア/クラップ: 2拍目/4拍目のバックビート
- ハイハット: 細かい時間感覚
- スウィング: 偶数ステップの遅れ
- 曲全体のスウィング(0〜60%、1%刻み)とハイハットのチョークは、インスペクターの「ノリ(スウィング・チョーク)」で`Project.swing` / `Project.hiHatChoke`を編集する。スライダーのドラッグ中は表示だけが動き、曲は離した時に1回(Undo 1回)だけ変わる。Escape・フォーカス喪失・タブが隠れる・取り外しでは何も書かずに元へ戻る。矢印キーは1ステップごとに確定する。スウィングを0より大きくするかチョークをオンにすると、再生・WAV・MIDIは480 PPQの整数ティックで音の出だしを決める方式になり、音の出だしが1ティック未満動くことがある(画面にはやさしい説明だけを出し、内部の方式名は出さない)。数値でない値は拒否し、範囲外は0〜60に丸める
- ドラッグエディタの「1小節のステップ数」で12 / 16を切り替える。各打点は新しいグリッドの最も近いステップへ移り(`resampleDrumSteps`)、同じレーン・同じステップに重なったものは1つにまとまる。移した数とまとめた数を表示し、1操作 = Undo 1回。まとめた分以外で鳴らなくなる打点(クリップの外へ出るなど)がある場合と録音中は拒否する。強さ0%のクオンタイズとゆれ幅0のヒューマナイズは「変更はありません」で、Undoも作らない

### 4.5 Loop / determinism境界

- drum `Clip.loop`はProjectへ保存されるが、現行のライブ再生、WAV、drum MIDI projectionではpatternを反復展開しない。反復が必要なdrum clipは、現時点では必要範囲のDrumEventを明示的に持つ
- transportの「ループ」を初めて有効にした時、0..0など無効なboundsは`0..songEnd`の全曲loopへ正規化する。`songEnd`は拍子分母を含むquarter-note beat長で計算し、現在位置は曲内へclampする。停止中のtoggleは再生を開始せず、starting / playing中のtoggleはrequest generationを更新して旧sessionを破棄し、新しいloop設定で同じ位置から開始し直す。Project / historyは変更しない
- 内蔵drum voiceは`Math.random`を使わない。versioned固定seedから同じsample rateのnoise bufferを生成し、`voiceSeed`とkick / snare / hat / clap burst別saltから整数sample-frameの再生offsetを決める。1つのAudioContext内ではnoise bufferを遅延生成して全drum Trackで共有する
- 同じapp build・同じWeb Audio engine/version・同じsample rateによる同一ProjectのWAV再書き出しは、pinned Chromium E2EでWAV全bytesの一致を必須とする。ライブAudioContextとoffline WAV、異なるbrowser / OS / WebView / sample rate間のPCM bit identityは保証しない

## 5. Bass Assistant

### 5.1 目的

コード進行からベースラインを作る導線を提供する。

### 5.2 生成ルール MVP

| モード | 内容 |
|---|---|
| Root Only | 各コードのルートを拍頭に配置 |
| Root + Fifth | 1拍目ルート、3拍目5度 |
| Walking Simple | ルート、コードトーン、次コードへの経過音 |
| Octave Pulse | ルートとオクターブ反復 |

### 5.3 説明

生成結果には「なぜその音を置いたか」をノート単位で表示する。

例:

- Cコードの拍頭にC: ルート音なので安定する
- Gへ向かう直前にF#を置く: 半音上行でGへ強く進む経過音

### 5.4 伴奏パターン（Comping、移植 P38）

アシスタントパネルの「伴奏パターン」から、コードトラックを元に、新しい楽器トラック「伴奏」（使われていれば「伴奏 2」…）を作り、選んだ小節範囲を覆うMIDIクリップ1つに伴奏の音を入れる。パターンは全音符・8分刻み・アルペジオ（上行・往復）・スタブの5種。音色（既定はピアノ風）、音域（低め・ふつう・高め）、「前のコードから近い音でつなぐ」を選べる。

- 既存のトラック・クリップ・音には触れない。生成先は常に新しいトラックなので、クリップが重なることはない。トラック数が上限（128本）なら理由を出して作らない。
- 音はコードイベントの保存された構成音から作る。保存値がなければコードトラックの再生と同じ`chordTones`を使い、コード名は読み直さない（`Cmaj`の保存値がC・E・Gなら、そのとおりに鳴る）。スラッシュのベースは使えない（mainのコードイベントにbass欄がない）。
- 音域は、選んだ最低音以上・最低音+24半音以下（上限127）に必ず収める。ボイスリーディングも、この範囲の転回形・オクターブの候補から移動量が最小のものを選ぶ。
- パターンは小節ごとに適用する。どの音も小節線とコードの区間を越えない（拍子は拍子マップに従う。3/4・6/8も同じ）。小節が「空」と報告されるのは、その小節のどこにもコードが鳴らないときだけ。範囲にコードがなければ作らない。
- 位置・長さは整数tick（PPQ 480）。クリップは曲の長さを超えず、範囲が曲の終わりを超えるときは曲の終わりで切る。音の高さはMIDI 0〜127の整数。音数は1クリップ20,000個、曲全体の再生予定は20,000件まで。
- 生成後に`buildScheduleEvents`を事後確認する。「生成前の予定 + 生成した音だけ」と多重集合で完全に一致し、同じ高さの重なりがなければ採用し、トラック追加・クリップ・音を含めて1回のUndoで元に戻せる。録音中、プロジェクトを開いている途中、フェーダーなどの操作が開いている間は「ほかの操作が終わってから試してください」などの理由で作れない。
- パターンに乱数はなく、同じ入力なら同じ音になる。

## 6. Melody Assistant

### 6.1 目的

コードに合うメロディを作るためのガイドを出す。

### 6.2 MVP仕様

- コードトーン着地ガイド
- スケール内ランダム生成
- 反復モチーフ作成
- コール&レスポンスのテンプレート
- 音域チェック

### 6.3 評価ロジック

| 観点 | 判定例 |
|---|---|
| コード適合 | 強拍にコードトーンがあるか |
| 歌いやすさ | 跳躍が多すぎないか |
| 反復 | 似たリズム/音型があるか |
| 変化 | 完全反復だけで単調になっていないか |
| 解決 | 緊張音が次に解決しているか |

## 7. Arranger

### 7.1 目的

ループを曲構造へ展開する。

### 7.2 セクション

- Intro
- A / Verse
- B / Pre-Chorus
- Chorus
- Bridge
- Outro

### 7.3 操作

- セクションテンプレート追加
- クリップの複製/エイリアス
- セクションごとの密度調整
- ミュート/アンミュートによる展開作成

独立複製はClipと全Note / DrumEventへ新しいIDを発行し、その後の編集を分離する。連動複製はMIDI / Drumだけを対象に、同じTrack・type・長さの正本Clipを`aliasOf`で直接参照する。素材payloadは正本だけが所有し、連動Clipは配置、長さ、loop、参照IDだけを持つ。自己参照、別Track / type、dangling、alias chain、payload重複は拒否する。連動Clipを編集した場合も1回のcommitで正本を書き換え、全配置の表示・ライブ再生・WAV・MIDIへ同じ内容を反映する。連動解除は現在の素材を新しいevent IDでatomicに複製し、Clip IDと配置を保ったまま独立化する。

ArrangerはTrack lane上のClipを選択し、開始位置と長さ、右隣への独立/連動複製、連動解除を操作できる。MIDI Clipには「素材をクリップ末尾まで繰り返す」checkboxを表示し、正本/aliasを問わず選択したtimeline instanceの`loop`だけを変更する。素材は正本と共有してもloop設定は各配置へ帰属し、Undo/Redoで往復できる。初期実装では連動Clipの長さは正本と一致し、正本に連動先がある間の単独resizeを拒否する。配置範囲はProject内のhalf-open区間に収め、重なりは既存の加算再生を維持する。

- **D2（クオンタイズ）** ループする配置が素材を使う場合、素材の1周目に収まる最後のグリッドまでにそろえる。mainでは最後に終わる音が周期を決める。その音の終点や繰り返し回数が変わる移動は見送り、クリップ長と周期を保つ。
- **D4（分割）** 小節位置を曲の先頭からの拍に変換し、1拍480 tickの目盛りで検証する。分割点はクリップの内側に置き、クリップの開始と開始点から分割点までの距離も整数tickにそろえる。ドラムの分割点は現在の拍子マップで打点を置ける位置に限る。
- wave5では分割点をまたぐ音を左右のノートに分ける。mainでは後半を鳴らし直すと発音イベントが変わるため、またぐ音がある位置での分割は拒否する。成功時はすべてのノートの長さを保ち、両方のクリップに正の長さを持たせる。
- 録音中、ループ中、連動コピーとその元クリップの分割は理由付きで拒否する。分割の前後で全トラックのライブ・WAVの発音イベント（反復ごとのドラムの鳴り方を含む）とMIDI書き出しの全バイトが一致したときだけ、Undo 1回で反映する。変更でドラムの鳴り方が変わる位置は拒否する。

Audio ClipはMIDI / Drumの`aliasOf`を使わず、同じimmutable AudioAsset bytesを参照する独立Clipとして扱う。移動、左右trim、clip gain、frame単位fade、loop、split、独立複製、削除を操作でき、各確定はUndo 1回にする。非loopのtrimはtempo map上の経過秒を48 kHz source frameへ変換してrate 1.0のsource rangeとtimeline windowを同期する。loopのright trimは外側の反復窓だけを変える。loop phaseを永続化するfieldがない間は、loop中のleft trimとsplitを型付きに拒否する。補正やフェードのない音声クリップは、分割点に最も近い素材のフレーム境界で分割する。丸めによるずれは素材の半フレーム以内とし、左右は元の素材範囲を隙間や重複なく参照する。素材とWAV出力のサンプルレートが異なる場合も同じ方法で分割する。

複製後に解決される保存済みNote / DrumEvent payloadが200,000件を越える場合、操作はProject / history / selectionを変えず拒否し、ノート・ドラム・コピーを減らす案内を表示する。この永続予算ではMIDI Clip loopの派生音を増やさない。ライブはMIDI Clip loopの展開後Noteと派生Chord noteを含む実効scheduleを20,000件以下、WAVは全曲を一括scheduleするため10,000件以下に制限する。両者とも展開後onsetの0.75拍rolling window内を256件以下に検査する。transport loopは反復後のsteady-state密度も同じ上限で再検査し、超過時はper-track Web Audio graph / event nodeを作らず型付きに拒否する。WAV超過時はOfflineAudioContextと部分fileを作らない。

### 7.4 学習連動

- Intro: 要素を少なく始める
- A: メロディ/モチーフを提示
- Chorus: 音域、密度、コード変化で盛り上げる
- Outro: 要素を減らして終える

### 7.5 Track管理、stereo Bus、内蔵音色（schema v4、部分実装）

- productionの追加UIは`instrument` / `drum` / `bus`に加え、音源fileを選んだ時だけ`audio`を作成する。instrument / drumの新規Trackには0拍から曲末までを覆う空のMIDI / Drum Clipを1つ作り、Audio Trackには正規化済みasset全rangeを参照するAudio Clipを1つ作る。BusはClipとinstrumentを持たない空のstereo returnとして作る。配列先頭のMasterがあればその直前、Masterがないlegacy Projectでは末尾へ挿入し、新規non-Masterのmain outputはMasterとする。instrumentは`softPad`を既定音色、drumは内蔵drum kitを既定とし、作成後は新しいTrack / Clipを選択する
- Mixerの「経路」は各non-Masterにexact 1件のmain output（Masterまたは既存Bus）と、sourceごと最大16件のsendを表示する。16件到達後は追加controlを閉じて上限を説明する。sendは既存Busだけをtargetにし、`pre-fader`はsource音量・insert前、`post-fader`はsource音量・insert・pan後をtapする。gainはlinear 0..2、enabledはliveで10ms平滑更新し、main output / target / position / add / removeはgraph再構築のためactive playbackを停止する
- outputとsendを合わせたgraphは無効・gain 0のsendも含めて常に非循環でなければならない。同じsource→Busの重複send、main outputと同じBusへのsend、自分自身、Master発のedgeを候補採用前に拒否する。循環拒否時はProject / history / revision / autosave / playbackを変更しない
- 複製・並べ替えの対象はnon-master Track、削除の対象は後述の学習Trackを除く一般non-master Trackとする。Masterは改名、複製、並べ替え、削除、音色選択の全対象から外し、legacy Projectに複数のMasterがあってもUIのTrack管理操作でそのidentityや相対順を変えない
- Track複製ではTrack、全Clip、全Note / DrumEvent、全Effectへfresh IDを発行する。複製元Track内の`aliasOf`は旧Clip ID→新Clip IDの対応で複製先内へ張り替え、元Track参照やdangling参照を残さない。main outputと複製元がsourceであるsendも値として複製し、send IDをProject全体でfreshにするが、複製元Busへのincoming output / sendは複製しない。音量、pan、mute / solo、instrument、effect parameter、配置と素材内容は値として複製し、複製先roleは`general`にする
- Track削除では自身のmain outputとsource / targetいずれかが自身であるsendを同じtransactionで除去する。Bus削除ではそのBusへmain outputを向けていた生存TrackだけをMasterへ戻し、途中のdangling routeをProject / historyへ公開しない
- 楽器トラックの追加画面とインスペクターの「内蔵音色」から14種を選べる。やわらかいパッド、明るいプラック、あたたかいベース、明るいリード、ピアノ風、ベル、オルガン風、弦楽器の合奏風、金管楽器風、はじく弦の音、深い低音、やさしい鍵盤、ピコピコした主旋律、すきとおるパッド。既存の別名は対応する内蔵音色として表示し、選択するまで保存値を保持する。追加した10種のIDには`p22:`を付け、旧ファイルにある接頭辞なしの未登録名は従来どおり既定の音色で鳴る。音色の変更は1回のUndoで戻せる。ドラムキットの選択は対象外。
- インスペクターの「かんたん音色調整」では、4つのスライダーで好みの響きに近づけられる。音色を切り替えても調整値は引き継ぎ、「音色調整をリセット」で4つをまとめて初期値に戻せる。調整の変更は再生位置を保持したまま再生を停止し、次の再生とWAV書き出しに反映する。
  - **明るさ**（`macroBrightness`）はローパスフィルターのカットオフ周波数。右に動かすと音がくっきりする。初期値50%、40〜16,000 Hz。
  - **余韻**（`macroRelease`）は音が消えるまでの長さ。初期値50%、0.01〜4秒。
  - **広がり**（`macroWidth`）は重ねた発音層のピッチ差。初期値0%、最大で各重ね音のずれを24セント広げる（合計±100セント以内）。既存の発音層を使って音に厚みを出す。左右の定位はミキサーのパンで調整する。
  - **立ち上がり**（`macroAttack`）は音が鳴り始めて最大の強さになるまでの長さ。右に動かすとゆっくり立ち上がる。初期値50%、0.002〜2秒。
- 明るさ、余韻、立ち上がりは元の音色の設定を50%で保ち、0〜100%で原則0.25〜4倍に調整する。値は既存の`InstrumentConfig.params`へ保存し、使用時にだけ0〜1に収める。未設定時は初期値で鳴る。WAVの長さは曲末の短い音でも立ち上がり、減衰、余韻が収まるよう決める。
- schema v4では`Track.role`が教材と伴奏支援の正本であり、runtimeで名前から推測しない。学習role Trackもlocal draftから改名でき、確定後もroleを保持する。一般Trackが`Chords` / `Bass` / `Melody`を名乗っても学習roleにはならない。学習role Trackの削除はdomain境界で保護し、trim後の有効名を明示確定した時だけ1回のProject changeとしてcommitする
- instrument TrackのInspectorでは`general` / Chords / Bass / Melody roleを選べる。同じ学習roleを別Trackへ割り当てた場合は旧ownerを`general`へ戻し、候補Project全体を1 commandとして検証・採用する
- 各commandは候補Project全体をcanonical codec / validationへ1回通し、128 Track上限、Clip / event予算、文字列上限などに違反する場合はProject、history、revision、autosave queue、選択、再生sessionを変えずatomicに拒否する。no-opも履歴や保存を進めない
- 採用された追加・複製・並べ替え・削除、role変更またはpreset変更は、再生開始時snapshotとの不一致を避けるためactive playbackを停止する。ただしplayhead beatは保持し、次の再生が採用済みProjectからschedule / graphを再構築する。改名だけでは再生を停止しない
- 採用されたcommandはUndo 1回ぶんの履歴、revision 1回、自動保存1回として扱う。追加・複製は新しいTrack / Clip、並べ替えは同じID、削除は生存する隣接Trackとその先頭Clip（なければselection null）へ選択をreconcileし、Undo/Redoと再読込後も存在しないIDを選択へ残さない

### 7.6 Audio Track import / Asset / playback

- 入力はWAV / MP3 / M4A / AACをlocalで構造検査し、最大128 MiB、decode後1〜2 channel、decode PCM推定256 MiB以下を`decodeAudioData`前に要求する。hostが要求した48 kHzを採用しない場合は実AudioContext sample rateで再計算する
- import全体は384 MiBのphase peak上限を持つ。descriptor未確定のWeb入力はBlob全読込inspect前に`2 × source + retained decoded cache`を予約し、descriptor取得後にdecode plannerへ原子的にresizeする。decodeを`2 × source + decoded Float32`、canonicalizeを`source + decoded Float32 + 必要時の48 kHz resample Float32 + PCM16 WAV`、保存を`source + decoded Float32 + 8 × PCM16 WAV`としてsafe integerで事前合算し、いずれかのphaseが超える入力はdecode前に拒否する。保存の8倍係数はWeb dedupeの明示5copyとnative IPC body clone / read-backを上回る保守的envelopeである。app-wide leaseはcancel後も実decode / resample jobがsettleするまで残し、2件目のimportをbusy拒否する
- import、Audio Asset付きlive開始、WAV書き出しは同じprocess-wide 384 MiB予約台帳を使う。各reserve / resize / releaseはJavaScriptの同期run-to-completion内で原子的に行い、既存予約とのchecked合計が上限を越える後発処理はresolver / decode / `OfflineAudioContext`前に拒否する。native Audio Track pickerはIPC response size確定前に`2 × 最大envelope + retained decoded cache`を保守的に予約し、Blob生成後はextra response envelopeだけを保持した同じJavaScript turnでdescriptor付きimportを開始する。importはplanner peakとcacheを別予約で引き継ぎ、picker cancel / gateway失敗 / unmount / import settlementの全経路でselection予約を冪等解放する。import本体は実decode rateで予約を拡縮し、cancel後の実job settleまで保持する。live開始はdecoded cache lease取得まで保持する。WAVはencode成功時に予約をBlob leaseへ移譲し、Webではobject URLをrevokeするdownload handoff、nativeでは`Blob.arrayBuffer()`とfile gateway IPCのsaved / cancelled / error settlementまで保持して、全経路の`finally`で冪等解放する
- decode結果はduration / frame / sample rateを再検証し、48,000 Hz、元の1〜2 channel、PCM 16-bit WAVへ正規化する。canonical objectは128 MiB以下とし、lowercase SHA-256と実byte lengthをidentityにする。同一bytesは保存objectをdeduplicateしても、Project上のAudioAsset / Track / Clip identityとUndo履歴は独立させる
- Webは専用IndexedDB object store、Tauriはapp data内`audio-assets-v1/sha256/<checksum>`を使う。Tauriは`.staging/<checksum>.tmp`へprivate write・fsync・再読込検証後にrenameし、起動時にvalid stagingをroll forward、破損stagingを削除する。Project save / crash draftは全`ready` assetの実byte lengthとSHA-256をSQLite transaction前に再検証する
- importはsource検査・decode・canonicalize・asset保存をProject外で行い、開始時Project snapshotがまだcurrentの場合だけAudioAsset metadata、Audio Track、Audio Clipを1回のcompare-and-swap history changeとして採用する。cancel、decode / storage失敗、stale Project、codec拒否ではProject / history / revision / selectionを変えない。binary保存後の拒否で生じたorphanは安全であり、native起動時GCが全retained generation / branch / crash draftから到達可能なchecksumを集めて回収する。future / corrupt payloadが1件でもあれば削除を中止する
- Audio Clipの新規作成、移動、右端trim、複製でclip終端が現在の曲末を越える場合は、その位置で有効な拍子mapを使って次の小節境界まで`Project.lengthBeats`を自動延長し、互換mirrorも同じcommand内で更新する。256小節または8,192拍を越える場合はProject、history、selection、再生sessionを変えずatomicに拒否する
- liveとoffline WAVは共通のAudio Clip window plannerを使い、seek途中、transport loop、Clip loop、variable tempo、source frame range、gain、fadeを同じhalf-open windowへ解決する。Audio Trackはsynth voiceを作らず、decoded AudioBufferをTrack graphへrate 1.0で接続する。再生前に対象assetを全件preflightし、途中までgraph / WAVを作った状態で欠落を発見しない
- raw objectのchecksum / length検証とdecode cacheを共有し、raw preflightとdecoded PCMは各256 MiB以下に制限する。missing / changed / unavailable / decode / resource超過は型付きに分類し、Track / Clip単位の説明と再読み込み手段を表示する。metadataを自動的に`unresolved`へ書き換えたり、同名の別fileへ黙って置換したりしない
- liveは実AudioContext sample rate確定後、resolver I/OとTrack graph生成前に未使用decoded LRUを解放し、active / in-flight cacheだけを保持量へ数える。resolve/hash phaseは`raw合計 + 2 × 最大raw + retained decoded`、decode phaseは`raw合計 + 最大raw decode copy + target-rate decoded合計 + retained decoded`をchecked加算し、大きい方が384 MiBを越えるProjectを型付きで拒否する
- `.ctsproj.json`はcurrent schema v12 metadata、Audio Clipの`audioWarp`（保存済み`formantMode`を含む）、automation bypass、Global / TrackまたはMaster Read、確定済みautomation curve、audio take folder、audio routingのexact交換形式だが、Elastic Audioの解析結果 / 派生PCM / A/B状態、Read / Touch / Latch / Writeの選択、Armed / Writing、gesture所有権とAudioAsset binaryを同梱しない。単体JSONを別端末・別profileで開く場合は、対応binaryが既に同じcontent-addressed repositoryに存在する時だけreadyとして採用し、それ以外は既存Projectを変更せず非同梱を説明する。音声素材を含めて持ち運ぶ場合は、下記の`.ctsbundle` v1を別操作で使う

### 7.7 Audio Track録音 / Record Arm

- Track ListとInspectorの`R`は既存Audio Trackだけを対象にし、同時に1件だけを録音待機にする。同じTrackの再操作で解除し、別Audio Trackの操作で録音先を切り替える。録音待機IDはruntime-onlyでProject / history / revision / autosave / SQLite / `.ctsproj.json`へ保存しない。Project切替では解除し、Track削除やUndo / Redoで対象が存在しなくなった時も解除する
- transportの録音buttonは録音先を表示する。録音待機がなければ新規Audio Track、待機中ならその既存Audio Trackへ新しいAudio Clipを追加する。開始操作でProject snapshot、現在playhead、録音先を同じ所有handleへ固定し、既存の再生があれば停止する。3秒countdown後、app-wide AudioContext上の同じ将来render frameをWorkletへarmしてから、そのplayheadをanchorに伴奏再生とcaptureを同時開始する。現在再生中の流れを保ったまま途中でpunch-inする方式ではない
- dialogは`システム既定`に加え、`enumerateDevices()`で得た`audioinput`を選択肢にする。空labelには順番付きの代替名を表示し、同一device IDは1件にまとめる。選択IDはrenderer sessionのruntime-only preferenceでありProjectへ保存しない。明示選択時は`getUserMedia`へ`deviceId: { exact: id }`を渡し、未選択時はhost既定を使う
- `devicechange`では待機中の一覧を再列挙する。権限前のprivacy制約でも一覧へ現れない場合があるため、選択済みdeviceを確認できない時は警告しつつ開始操作は残し、凍結したIDをexact指定する。実際に取得できなければtyped errorでProjectを変えず、別入力またはシステム既定を案内する。1 takeの入力IDは開始時に固定し、録音中のhot switchは行わない
- captureは3秒countdown、最大60秒、1〜2 channel、dry録音、monitor初期OFFと明示opt-inを維持する。capture開始前に共有384 MiB予約とrecording tokenを同期取得し、asset上限、既存TrackのClip上限または新規Track上限を検査する。Workletはabsolute context frameとsequenceをchunkへ付け、arm frame途中のrender quantumも正確にsliceし、欠落・重複・世代変更をfail closedにする。借用したapp AudioContextはcapture側でcloseしない
- transport loopがOFFなら従来のone-shot録音、ONなら開始前に曲内の明示`[loopStartBeat, loopEndBeat)`と2〜128の固定pass数を凍結する。cycleはloop左端から1本の連続local captureを行い、同じ将来frameから有限の伴奏再生を開始し、Nth右境界で伴奏だけを止める。正の録音latency tailまで含めたeffective captureは0.5〜60秒とし、各passを累積丸めしたexact frame境界で同じ長さのAssetへ分割する
- 録音位置補正はruntime-onlyの`自動（推定） / 実測校正 / 自動なし`と整数-500〜+500 msの手動offsetを持つ。正値は早め、負値は遅らせる。推定値はinput track、`baseLatency`、`outputLatency`、Master limiter look-aheadの申告値・既知値を合算する。`実測校正`は選択中のexact input ID、現在のAudioContext generation / sample rateに一致する成功profileだけを使い、その`latencyFrames`でhost推定、base / output / input latency、limiter look-aheadの合計を置き換えてから手動offsetだけを加算する。profile不一致時に推定値へ黙ってfallbackしない。capture first frameを可変tempo mapでbeatへ変換し、曲頭より前になる時はstartBeatを0にclampしてcanonical assetの`sourceStartFrame / sourceFrameCount`を非破壊trimする
- 実測校正は通常の録音wizardとは分け、オーディオinterfaceの出力を選択入力へケーブル接続する外部I/O校正として案内する。スピーカーからマイクへの空中loopbackは禁止し、app monitorに加えてinterface / driver mixerのDirect Monitor・hardware Loopback・同一outputへのreturnもOFFにするよう開始前に明示する。開始時はtransport表示がstoppedでも保持中のnatural drain session graphを同期disposeしてからprobeを準備する。probe振幅は固定の低levelとし、排他中だけapp-wide AudioContextのengine output/calibration gainを既知unityへ正規化してfinallyで元値へ戻す。固定PRBSをengine output / limiter経由で複数burst送出し、同じ将来render frameから選択入力をcaptureする。各burstは最大500 msの整数sample lagを正規化相関し、silence、clipping、同率または近接peakによる曖昧さ、低confidence、context generation / sample rate変化をfail closedにする
- 実測校正はopaqueなIDを固定できる明示選択済み入力だけで開始でき、`システム既定`では開始させない。校正成功時だけ`inputDeviceId / contextGeneration / sampleRate / latencyFrames / confidence`のprofileをrenderer runtimeへ置き換える。Project / history / revision / asset / autosave / SQLite / `.ctsproj.json`には保存しない。app lifetimeの`devicechange`購読はdialog表示や録音phaseにかかわらずfuture profileを破棄する。入力選択または校正中の`devicechange`では進行中校正も中止し、以前の入力へ戻しても自動再利用しない。通常takeは開始時policyをimmutableに所有し、bind前のprofile破棄はfail closed、bind後の変更は現在takeを変えず次回以降だけ無効化する。一般録音は引き続き`システム既定`を利用できる。Web Audioから安定した出力identityを取得できないため、出力deviceまたはdriver / buffer設定変更後は再校正するよう明示する。通常のcancelまたは解析失敗は直前のprofileを上書きしない
- raw PCMを48 kHz PCM16 WAVへ正規化し、bytesとchecksum receiptをrepositoryへ確定してからだけProjectへ採用する。既存TrackではそのTrackのvolume / pan / effects / routingを保ったままAsset metadataと補正済みsource rangeのClipを追記し、新規TrackではTrack / routing / Clipを作る。どちらも開始時snapshotへのexact CAS、Undo 1回、revision 1回として扱う
- cycle完走時は各周のReady Audio Assetを全件保存した後だけ、1 take folder、pass順のtake、最初のtake全体を採用する1 comp segmentをstrict CASで追加し、folder / Track / Comp Editorを選択する。新規Track生成を含む全体が1 Project change / 1 Undoである。manual stop / cancel / unmount / permission / device loss / context世代変更 / clock不連続 / arm失敗 / canonicalize / store失敗 / stale snapshot / target消失 / revoked tokenでは全passを破棄し、Project / history / selectionを変更しない。入力hot switch、長時間disk streaming、既存再生へ途中参加するQuick Punch、複数入力は未実装である
- `パンチ`はloop locatorと別のruntime-only locatorを持ち、同時には有効化しない。一方を有効にしても双方の範囲値は保持する。既存Audio Trackを`R`で録音待機にした場合だけ開始でき、0〜16整数拍のpre/post-rollを曲端でclampする。3秒countdown後にpre-rollを開始し、可変tempo mapから累積丸めしたfuture AudioContext frameのpunch-inでcaptureをarmする。対象Trackだけを半開区間`[punchInBeat, punchOutBeat)`でsample-accurateにgateし、他Trackと前後の対象素材は再生する
- Editor上部の定規はクリックで再生位置を1拍単位に移動し(停止中のみ。0〜曲末にclamp)、左右ドラッグでruntime-onlyのloop範囲を選ぶ。loop範囲は整数拍(=整数tick)の境界で、長さ1拍以上かつ曲内に収め(曲末が整数拍でなければfloor(曲末)が上限)、1拍未満のドラッグは1拍へ広げ、1拍の整数拍loopが入らない曲は理由つきで拒否する。Undo / Redo・読込・切替・曲長変更などProjectが変わるたびにruntimeのloop / punch範囲を曲長で再検査し、曲外へ出たものは無効化(0へ戻す)する。録音中とオートメーション記録パス(Write / Touch / Latch)の最中は、パスを終えず点も確定せずに理由つきで拒否し、移動・loop範囲変更はProject・Undo履歴に入れない。トップバーの「タップ」は拍に合わせて2回以上たたくとBPM(20〜300)を決め、2秒の間が空いた時点で先頭tempoへ1回だけ書き込む(Undo 1回)。たたき始めたProjectに紐づき、Projectの切替やボタンの消滅(unmount)ではその回を破棄し書き込まない
- Auto Punchの出力は0.5〜60秒のexact windowである。正latencyは必要な末尾だけ追加captureして先頭をtrimし、負latencyは先頭silenceを加える。capture完了と同じrequestの自然post-roll完了を別々に証明し、両方が揃った時だけ保存へ進む。manual stop / cancel / unmount / device / context / clock変化 / post-roll interruption / canonicalize / store / stale CASではProject / history / selectionを変えない
- 対象範囲が空ならexact Audio Clipを追加する。ready・non-loopのClip 1件が範囲全体を覆う場合は外側を保持し、旧中央をTake 1、新録音をTake 2としてfolder化してTake 2を全域採用する。同一窓のfolder 1件なら新takeを追加して全域採用する。部分重複、複数重複、loop、unavailable source、異なるfolder窓、source不足はpermission前に拒否する。Asset receipt後のdomain replay完全一致だけをstrict CASで1 Project change / 1 Undoとして採用する
- これは開始時に既存再生を止めてpre-rollから新しい有限sessionを始める**bounded Auto Punch**である。既存再生へ途中参加するQuick Punch、自動input monitoring、cycleとの併用、長時間disk streaming、任意重複の自動修復、複数入力は未実装として区別する

### 7.8 Tempo / 拍子map Editor

- Editorの「テンポ / 拍子」tabは既存schema v4の`tempoMap`と`timeSignatureMap`を同じmusical timeline上で編集する。tempoは20〜300 BPM、拍子は分子1〜32・分母2 / 4 / 8 / 16で、beat 0の先頭eventは位置固定かつ削除不可だが値は編集できる
- tempo eventは曲末未満の任意beat、拍子eventは曲末未満かつ直前segmentから見た小節境界だけへ新規追加・移動できる。同じmapの同beat重複、範囲外、後続拍子eventまたは曲末を小節途中にする候補をatomicに拒否する。canonical schema v4で既に`beat === lengthBeats`にある終端eventは互換入力として、位置を据え置いた値編集 / no-op、曲内への移動、削除だけを許し、新規追加または曲内eventの終端への移動は許さない
- mapはbeat昇順とProject全体のglobal ID一意性を保つ。先頭tempo / 拍子の編集時は`bpm` / `timeSignature` mirrorを同じcommandで更新し、拍子map変更時は`lengthBeats`を正本として`lengthBars` mirrorを再計算する。schema versionは増やさない

### 7.8.2 曲の長さ(小節数)の変更

- 「テンポ / 拍子」tabの「曲の長さ」で、曲末に1小節追加・曲末の1小節削除・小節数の直接指定ができ、現在の長さを小節数と拍数で表示する。長さは現在の拍子mapでの整数小節で、1〜256小節。増やす時は最後の拍子で小節を足し、`lengthBeats`を正本として`lengthBars` mirrorも同じcommandで更新する。schema versionは増やさない
- 短くする時は内容を失わない範囲でだけ自動整理する(content-safe truncate)。新しい曲末をまたぐ、または越えるclipは、鳴る内容が何も失われない場合に限り、曲末までに短縮する(完全に曲末以降にある空のclipは削除)。判定は再生と同じ配置(ループ・alias clipを含む)で行い、全ての音符・ドラムの音がhalf-openな曲末より前に始まり、音符は曲末までに鳴り終わることを条件とする。Audio clipは可聴範囲がclip窓全体なので、曲末をまたぐ・越える場合は短縮せず拒否する。削除対象のclipを残るalias clipが参照している場合も拒否する
- 受け入れの正本は再生スケジュールの差分で行う。短縮候補と元のProjectから`buildScheduleEvents`(コードを除く)を作り、ライブ / WAVと同じ`resolveDrumOccurrence`でswingとclip終端を解決したあと(確率は1、velocity humanizeは0として扱い、鳴りうる全てのhitを内容と見なす。loopの周回はruntime状態なので対象外)、{beat, payload}の多重集合が完全一致し、かつ候補に曲末以降のeventが無い場合だけ受け入れる(clip終端はtrimで動くので比較から除く)。違いがあれば最初の欠落または余分なeventの小節とトラック名を挙げて拒否する。事前の個別判定は高速な経路に過ぎない。長さを増やす変更は内容では拒否せず、既に曲末を越えているalias onsetなど既存の状態は変更しない
- 長さ変更は、開いているドラッグ操作(Undo transaction)があれば先にそれを1段としてcommitし、その後に独立した1段として適用する。以後、古い操作のcancelは何も戻さない。再生位置とloop / punch範囲の曲内への補正は、Projectの変化から導出する(store共通のsubscribe)ので、Undo / Redoでも同じ結果になる
- 曲末以降に始まるコードとセクションは、同じUndo 1段の中で取り除く。曲末をまたぐコードは曲末までに短縮し(残りが`MIN_EVENT_DURATION_BEATS`未満なら取り除く)、またぐセクションは曲末までの整数小節に短縮する。パネルは「コード N 個・セクション M 個を取り除きました(元に戻すで復元できます)」のように件数を日本語で知らせ、短縮した分も別に件数を示す
- 次の場合は何も変更せず、小節位置とトラック名・項目名を挙げる日本語の理由で拒否する(最大50件を保持、表示は5件+件数): 曲末以降で始まる音符・ドラムの音(内容を持つclip)、曲末より前に始まり曲末を越えて鳴る音符(音符を短くするよう案内する)、曲末を越える録音take folder、曲末を越えるオートメーションの点(ちょうど曲末の点は許可)、曲末以降のテンポ / 拍子event
- 1回の長さ変更はUndo 1段。録音中、プロジェクト処理中は変更しない。変更後は再生を止め、再生位置を新しい曲末へclampし、収まらなくなったloop / punch範囲は無効にする(いずれもProject履歴には入らない)

- add / update / move / deleteはsourceとcandidateのcanonical codecを通過した時だけ開始時Project参照へcompare-and-swapする。採用された1操作はProject変更・Undo・save revision各1回、no-op / stale / busy / invalid候補はProject、history、selection、transportを変えない
- active playback中の採用はsession snapshotを停止して有限なplayheadを保持する。次の再生、metronome、live / WAV / MIDI、Arranger / Piano Roll / Drum / Chord timelineは保存済みmapを既存の共通musical-time compilerから読む
- 320px幅ではdocument全体を横overflowさせず時間軸だけを内部scrollする。eventはnative controlで選択・keyboard操作でき、anchor保護、入力error、成功、再生停止を日本語のalert / statusで伝える。連続tempo ramp、audio follow / Smart Tempo、tempo automationはこのincrementに含めない

### 7.8.1 曲全体の移調

- トランスポートバーの「±」ボタン（「曲全体を移調」）から、半音数（整数、-12〜+12）を指定して全曲を移調する。ダイアログは移調後のキーを先に表示する
- 移調するのは、ドラム以外のinstrument Trackの全MIDIノート（ミュート中のTrackを含む）、Chord Trackの全コード名、`Project.key`。ドラムはTrack type `drum`またはinstrument type `drumkit`から導き、ドラムTrack・ドラムClip・drumkit楽器のノートは動かさない。Audio Clipも動かさず、ダイアログに「録音した音声の高さは変わりません」と表示する
- pitch class、MIDIノート番号、スケール度数を混同しない。コードの`degree` / `function` / `tags`は新しいキーに対する値として変えず、`symbol` / `root` / `notes`だけを動かす。読み取れないコード名があれば全体を拒否する
- 新しいキー名はキー選択（C / G / D / A / E / B / F / Bb / Eb / Ab / Db / F#）に用意されたものから、移調後の主音に合う綴りを選ぶ。該当がなければ全体を拒否する。±12（オクターブ）ではキー名とすべてのコード名を一切変えず、ノートだけが動く
- コード名の綴りは移調後のキーと実際のスケールに従い、度数ごとの文字を使う（例: Eb minorではCb、F# majorではE#、harmonic / melodic minorの上げた6度・7度はその度数の文字のまま。A harmonic minorの`E7/G#`を+5するとD harmonic minorの`A7/C#`）。pentatonic / bluesなど7音でないスケールは、親のmajor / minorの調号どおりに綴る。スラッシュのベースも同じ規則で綴り、`root`は常にコード名のルートの綴りと一致し、±12でも全コードのrootをコード名から読み直す（例: `Db`と入力されたコードのrootが`C#`で保存されていても`Db`になる）。コードを鳴らすトラック（Chordsトラック）がdrumkit楽器の場合は、先に楽器の音色へ切り替えるよう案内して全体を拒否する
- コードの`notes`は、全値が0〜11ならpitch class（12で割った余りで移調）、11を超える値があれば絶対MIDIノート（移調量どおりに動かし、0〜127を外れるなら全体を拒否）として扱う。pitch classのコードの伴奏音域はmainのボイシング（ルートのpitch class + 48）が決めるため、オクターブ移調では伴奏の音域は変わらない。絶対MIDIノートが移調で全値0〜11になる場合は、pitch classとして読み直されて音域が跳ぶため、該当コードの小節と名前を示して全体を拒否する（「低すぎて音の高さが保てません」）
- 1つでもノートがMIDI 0〜127を外れるなら全体を拒否し、最も低い（または高い）該当ノートの音名を日本語の理由に含める。部分適用はしない。録音中・プロジェクト操作中も拒否する
- 適用は`buildScheduleEvents`の前後比較（拍位置・長さ・強さ・ドラムが不変、音程は移調ノートと絶対コード音が移調量ちょうど、pitch classコードの伴奏がボイシング規則どおり）を通った場合に限り、Undo 1回で戻る


### 7.9 Audio Take / Comp Editor

- 同じAudio Trackにあり、`startBeat / lengthBeats`が一致する非loop Audio Clipを2件以上選べる時、Audio Clip Editorから「テイクにまとめる」を実行する。選択Clipと同じ時間窓の候補を自動検出し、ready asset、source coverage、上限を満たすものだけをschema v5のAudio Take Folderへ変換する
- group後は元ClipをArrangerに重ねて表示せず、1つのtake folder objectとして表示・選択する。初期の「仕上がり」は先頭take全rangeで、後から一致Clipを追加しても現在の仕上がりは変えない
- Editorの6つ目の「テイク編集」tabは「仕上がり」rowとtake laneを同一時間軸へ表示する。laneの範囲を選ぶと、そのtakeを採用するpreviewをcomponent内だけで示し、pointerupで1 Project change / Undo 1回へ確定する。Escape / pointer cancelはProjectとhistoryを変えない
- keyboard / precise操作として、選択take、開始beat、終了beatをlabel付きnative controlで入力して範囲採用できる。comp境界は数値入力で移動でき、隣接rangeの最小長とfolder exact coverを維持する
- compで使っていないtakeだけを削除でき、最低2 takeを残す。削除後は存在するtakeへfocusを戻す。assetがmissing / changed / unavailableのfolder、録音 / 保存operation中、stale selectionではcontrolをdisabledにして理由を表示する
- accepted grouping / take追加 / range paint / boundary移動 / 未使用take削除はactive playbackを停止し、有限なplayheadを保持する。次のlive再生とoffline WAVは同じpure plannerを使い、選択takeだけと0〜50 msの中心crossfadeを鳴らす
- 保存・再読込・Undo / Redoはfolder / take / comp segment ID、immutable source window、fade / gain、crossfade、gapless compを保持する。MIDIへAudioを出力しないが、壊れたtake参照を黙って無視せずMIDI export自体を`invalid-project`で拒否する
- 320px幅ではdocument全体を横overflowさせず、take timelineだけを内部横scrollする。操作対象はnative button / inputと明確なfocus indicatorを持ち、44px相当のpointer targetを維持する
- 固定pass Audio cycle recordingとbounded Auto Punchは録音transactionから自動生成したfolderとして同じEditorを使う。再生中の任意Quick Punch、MIDI take / comp、複数入力、名前付きの複数comp、flatten / bounceは対応済みと表示しない

### 7.10 Audio Clipのタイミング / 単音pitch補正（schema v10、部分実装）

- ready・非loop・canonical 48 kHz mono/stereo PCM16 WAVを参照する60秒以内の直接Audio Clipだけを採用対象にする。loop / cycle、missing / changed / unavailable asset、録音中、保存処理中、Project切替中はcontrolを無効にして同じpanelで理由を表示する。linked Clip / take folderや60秒超などdomain対象外の候補は解析または確定前に説明付きで拒否する
- Audio Clip Editorの「音声を整える」disclosure内に「タイミング」と「単音ピッチ」の2 tabを置く。未編集Clipはsource windowの始点 / 終点だけを持つlinearな初期状態から始め、始点 / 終点は移動・削除できない
- タイミングpointはsource frameとClip先頭からのtarget beat offsetを対応付ける。pointer、左右キー、label付き数値inputで移動し、追加・削除・resetを行う。source / targetの隣接区間は40 ms以上、local stretchは0.5〜2倍、全体で2〜128 pointとし、順序逆転や上限超過を候補だけ拒否する
- 「音程を解析」は元のcanonical Clip windowを端末内で解析し、bounded waveform、pitch trace、半音guide、最大128件の単音候補を表示する。解析候補の削除はProjectを変えず、pitch / 補正量の変更、split / merge、確定で初めて`pitchRegions`を1 gesture = 1 Undoとして保存する
- pitch regionは重ならないsource frame範囲、source / target pitch（MIDI cents）、0〜100%の補正量、境界transitionを持つ。実効shiftは±300 cent以内に制限し、scaleへ寄せる操作も最終的には同じregion metadataへ確定する
- 「音程を変えても音色を保つ」checkboxはnative accessible nameそのままで、保存済み`formantMode`を`off`と`preserve`の間で切り替える。候補がない時とbusy時はdisabledにし、accepted切替は各1 Undo / save revisionとしてlive、全体WAV、選択Track WAVの共通request / cache keyへ反映する。A/Bはこのmodeを変更しない
- accepted editはactive playbackを止めて有限なplayheadを保持する。次のlive再生、全体WAV、選択Track WAVは同じversioned WSOLA派生PCMを使い、source range / gain / fade / routing / automationは従来経路を維持する
- 「ピッチ補正前 / 補正後」のA/Bは選択Clipの`pitchEnabled`だけをlive用immutable snapshotで一時的に外す。タイミング補正は両方で維持し、現在位置から通常のlive playback requestを再開する。Project / history / revision / autosave / SQLite / `.ctsproj.json`とWAV出力は変更しない
- trim / splitではsource frameを基準にmarker / regionをcrop・rebaseして残す。audioWarp付きClipのloop化、take folder化、Auto Punch対象化は対応済みと見せず、domain境界で拒否する
- manual formant editing、vibrato編集、polyphonic pitch、take folder / loop-cycleへのwarp、phase-coherent multitrack stretch、audio quantize / groove抽出、audio follow / Smart Tempoは未実装である。off / preserveは合成fixtureでのみ品質gate済みで、実声のライセンス済みブラインドA/BまたはMUSHRA、unsupported rate / extreme shiftの品質保証は未達である

## 8. Mixer

### 8.1 MVP仕様

- Track volume
- Pan
- Mute/Solo
- Meter
- Master volume（MVPで有効なMaster操作はこれだけ。0.0〜2.0）
- Basic effects slot
- non-Masterのmain output（Master / Bus）
- stereo Busとpre/post-fader send / return（有効、送り量、送り先、削除）

Masterの`pan` / `mute` / `solo`は将来互換用の予約フィールドであり、MVPでは音声へ適用せずUIにも表示しない。Master trackを持たないlegacy projectはunity gain（1.0）として再生・WAV書き出しし、Master volumeが非有限値なら音声境界でfail-silent（gain 0）にする。

ライブのTrack出力とWAV PCMは同じstable routing DAGとProject Master gainをlimiter直前で一度だけ適用する。ライブは`session output → session Master fader → engine output/calibration gain → limiter`とし、Project scalar / automation / gestureはsession Masterだけを所有してengine gainをunityに保つ。Bus soloは関係する上流・下流edgeだけを開き、上流sourceの無関係なMaster直通edgeを漏らさない。ライブ専用のメトロノームもMaster faderを通し、ライブのMaster meterはpost-fader信号を表示する。WAVにはメトロノームclickとUI meter / analyserを含めない。Trackのmute / solo、各Track volume、Master volumeは、再生開始時およびoffline renderではsample 0から確定値を使い、再生中に値を変更した場合だけ10msで平滑化する。

schema v3で導入したAutomationLaneはnon-Master Trackのvolume / panを対象とし、schema v8ではcanonical Track順の最初のeffective Masterだけにoutput volume targetを追加する。Master panとlater Master targetは拒否する。Track scalarを最初のpointまでのbase valueとしてhold / linear補間をライブとWAVへ同じbeat→time変換で適用する。schema v6の必須`bypassed`とschema v7の必須`automationReadState`を共通resolverへ入力し、effective Readを`globalEnabled && !disabledTrackIds.includes(trackId) && !lane.bypassed`で決める。falseならpointを保持したままcommandを生成せず、そのtargetのTrack scalarを曲本体からrelease / effect tailまで使う。各pointの`interpolation`はそのpointから次のpointまでの出力方向の意味を持ち、`hold`は現在値を保ち、`linear`は次の値までbeat上で直線変化する。

楽器トラックの「明るさ(フィルター)」は音色を時間に合わせて変える。0は元の音色、プラスは明るく、マイナスはやわらかくなる。schema v12は各楽器トラックに1本まで保存でき、値は±log2(10)オクターブ差（両端を含む）とする。点の編集はレーン上で行い、再生とWAVは同じRead設定を使う。

Editorの「オートメーション」tabは選択中の対応Trackへ結び付き、Global Read、選択TrackのTrackまたはMaster Read、Track別のRead / Touch / Latch / Write、対応target、beat snapをnative controlで操作できる。non-Masterは音量 / パン、instrument Trackは加えて「明るさ(フィルター)」、effective Masterは「Master出力音量」だけを表示し、later Masterには未対応を明示する。Global / TrackまたはMaster Readはlane Bypassと独立し、current schema v12へ保存する。laneがあればRead / Bypassを切り替え、Bypass中もcurveとpointを消さず編集できる。lane上または現在の再生位置へのpoint追加、選択pointのbeat / value / 次のpointまでの変化方法、1件削除、確認後のlane全消去を行える。Inspectorは実際に変更したfieldだけをpatchし、beat snapはbeat自体を確定した時だけ適用するため、無編集blurと値だけの編集ではimport済みoff-grid beatの精度を変えない。音量は0〜2、パンは-1〜1、beatは0〜曲末で、同じlaneの同beat重複を採用しない。laneがなければ最初の追加時にRead状態で作り、最後のpoint削除または全消去ではlane自体を除去する。追加・確定編集・削除・全消去・各Read gate切替はそれぞれ1 gestureをProject変更1回、Undo 1回、自動保存revision 1回として採用し、no-opまたは拒否では履歴を増やさない。保存・再読込後も独立laneとpoint ID、beat、value、interpolation、bypassed、Global / TrackまたはMaster Readを保つ。

AutomationLaneは再生session snapshotであり、lane編集またはRead / Bypass切替はactive playbackを停止して有限なplayheadを保持し、natural drainも破棄して次のplayで再構築する。laneが1件以上ある状態でのmixer / effect編集も原則同じ扱いだが、active write pass中に開始時Readだった別Trackのvolume / pan scalarだけを変える場合はpassをexact rebaseする。対象にeffective Read laneがなければAudioParamだけを更新して再生を維持し、laneがあれば最初のpoint前や次loopでscalarが可聴になるため、古い予約値を残さず再生を停止して次回再構築する。改名・ノート編集などmixerに無関係なProject変更では、予約済みAudioParam automationをcancelしない。transport loopと可変tempoでも既存の共通resolverを使うため、ライブ再生とoffline WAVは同じRead / Bypass結果になる。

再生開始時に対応Trackごとのmodeを凍結し、Read以外が1件でもあればruntime-onlyの1 passを開始する。記録pass中は全Trackの音量 / パンのpointer dragを拒否し、理由を通知する。Touchはミキサー / Track Listの対応controlをキーボードで操作している範囲だけを書き、releaseから100 msで開始前curveへ戻す。Latchは最初の接触からパンチアウトまで最後の操作値を保持する。Writeは確認dialogを通過した時だけ有効になり、接触がなくてもpass開始からnon-Masterの音量 / パン、effective Masterの出力音量だけを開始時scalarで所有して既存curveを置き換え、パンチアウト後はTouchへ戻す。記録は既存laneの`bypassed`とGlobal / TrackまたはMaster Readを暗黙変更しないため、Read gateが無効なまま確定したcurveは再有効化するまで可聴化されない。Track ListとMixerの両Master faderは再生中のRead曲線を表示し、Write所有中はscalar、Touch/Latchのgesture中は操作値を優先する。

pass中のsampleはProject / history / revisionを変えず、停止、自然終了、seek、transport loop右端、mode / Read / Bypass変更、Undo / Redo、Project切替、native close、pagehideの境界で半開区間をパンチアウトする。確定候補は開始時Project参照とcanonical fingerprintへのCAS、point / lane上限、全Project codecを通過した時だけProject変更・Undo・save revision各1回として採用し、失敗時は部分curveを公開しない。pagehideで確定できない場合はProject no-opでpassを破棄する。確定curveはcurrent schema v12の通常laneとしてlive / full WAV / selected Track WAVの共通resolverへ渡るため、記録時のmode名はoffline bounceへ影響しない。

Read / Touch / Latch / Writeの選択、Armed / Writing、gestureと再生passの所有権はrenderer runtime-onlyで、Project / history / SQLite / `.ctsproj.json` / OpenAPIへ保存しない。Project activationと再読込では全TrackをReadへ戻す。Master pan、later Master、insert / send / tempo parameter、MIDI CC / LFO modulation、Trim / Relative / Cross-Over / Fill、parameter group単位のSuspend、複数loopへ連続記録するpass管理は未実装であり、対応済みと表示しない。

### 8.2 学習連動

- クリッピング時に警告
- ベースとキックの重なり説明
- リバーブ過多の警告
- 書き出し前チェックリスト

### 8.3 再生終端と自然テール

- 停止中に再生を要求した時、現在位置が有限かつ`0 <= positionBeat < songEnd`ならその位置を保つ。負値、非有限値、曲末と同じ位置、曲末より後では、拍子分母を含むquarter-note beat長から求めた`0`へ同じstate更新内で巻き戻してから再生を開始する。この補正はloop bounds、Project、Undo/Redo history、save stateを変更しない
- transport loopなしで曲末へ達した時は、transportをただちに停止して位置を0へ戻し、メトロノームと位置更新も止める。一方、最後の音、Filter / EQのIIR state、Delay / Reverb、Compressorのlook-aheadは、controllerが所有する1つだけのdraining sessionで自然に減衰させる。drain中もpost-fader Master meterは残響を表示する
- 最終50ms fadeはMaster limiterより前で完了し、その後もWeb Audio規格の固定6ms look-ahead分だけgraph / offline renderを保持する。40秒hard capはこの6msを含む出力全体へ適用し、短いtailでもfadeを曲本体へ食い込ませない
- 新しい再生、手動停止、Project切替、AudioContextの`suspended / interrupted / closed`は残っているdrainを即時に破棄する。破棄時はsession outputとsession Masterを一度だけ切断し、app-wide engine output/calibration gainへfadeやProject scalarを残さない。transport loopのwrapではdrainを開始しない
- 自然テールは`Clip.loop`の反復仕様とは別のone-shot終端契約であり、現行のdrum `Clip.loop`未展開を変更しない

## 9. AI Coach

### 9.1 目的

作曲・理論・操作の質問に答え、プロジェクトに即した改善案を返す。

### 9.2 MVP仕様

- API接続なしでも動くルールベース助言を先に実装
- LLM接続はオプション設定
- 送信内容をユーザーに明示
- 音声ファイル送信はデフォルトOFF

### 9.3 禁止/制限

- 既存アーティストや特定曲の模倣を目的にした生成を主要導線にしない
- 著作権のある音源を学習/分離/再利用する機能は注意喚起を表示
- ユーザーのプロジェクトデータを無断送信しない

## 10. Export

### 10.1 MIDI

- Standard MIDI File Format 1で出力する。先頭の単一conductor MTrkに曲名、Projectの全tempo / time signature map event、各コード開始tickのchord markerを置く。各mapの先頭eventはtick 0になる
- export対象のinstrument / drum Trackごとに独立したpart MTrkを作る。各part MTrkの先頭eventはtick 0のFF 21 MIDI Portとし、その後にtick 0のtrack name、CC7 volume、CC10 panを置く。ProjectのTrack上限は128であり、128音楽トラックでもこの対応を変えない
- 0-based melodic index `i`には`port = floor(i / 15)`とchannel `[0..8, 10..15][i % 15]`、0-based drum index `j`には`port = j`とchannel 9（MIDI Channel 10）を割り当てる。Project上限まで全partの`port / channel` pairを一意にし、channel再利用時もCC7 / CC10を別destinationとして分離する
- 曲名・track name・markerはUTF-8の実byte列で各4,096 bytes以下とする。4,097 bytes以上は途中までのfileを返さずexport全体を拒否する
- authored note / realized chord / drumのpitchとvelocity、Track volume / pan、drum laneをSMF data byteへ変換する前に検証する。整数範囲外、非有限値、不明laneをclampや不正byteへ変換せず、部分fileを返さずexport全体を失敗にする
- MIDI Clipの`loop=true`はライブ/WAVと同じ共通projectionでbakeする。自然周期`P = max(note.startBeat + note.durationBeats)`を使い、`note.startBeat + kP < clip.lengthBeats`の各開始だけを出力する。最終partial noteはclip終端で短縮し、量子化後に正の1 tickをclip内へ収められない断片は越境させず省略する。aliasは正本notesとinstance側のstart / length / loopを組み合わせる
- 各part MTrkは量子化後の全authored / linked / loop-expanded / realized / drum noteを同一channel・pitchごとに検査する。前のNote Offより早い同pitch Note OnはMIDI上で終了対象を識別できないため、無警告で音価を変換せず`overlapping-note`として全体を拒否する。同じtickのNote Off→Note Onという隣接は許可し、UIは同じ音程の重なりを短くするか統合する案内を出す
- P54: 書き出しオプション`includeProgramAndKey`(既定true)がtrueのとき、各instrument Trackのtick 0(CC10の直後、どのnoteより前)にGM Program Changeを1件、conductor Trackのtick 0に調号(Key Signature、FF 59)を1件書く。drum Trackはchannel 10のままProgram Changeを書かない。falseのときはP54より前のbytesと完全に一致する(legacy。固定goldenとv10→v11 parityの検証はfalseで行う)
- Program Changeはpresetから引く(`packages/midi-io/src/gm-program.ts`に1か所だけの対応表。基本4音色・P22の10音色・旧名のエイリアス)。未知のpreset、`instrument`なしはWarm Pad(GM 89)にする。番号は0〜127、channelは0〜15のまま
- 調号は`sf`(-7〜7)と`mi`を次の規則で決める。長調は主音の#/bの数、`mi=0`。短調系は平行長調の`sf`、`mi=1`。`naturalMinor` / `harmonicMinor` / `melodicMinor` / `minorPentatonic` / `blues`は短調、`major` / `majorPentatonic`は長調とみなし、固有の調号を持たないスケールは**親の長調 / 短調の調号を使い、省略しない**。異名同音は#/bの少ないほう(C#長調は7#でなく5bのDb)。6個で並ぶF# / Gb長調とD# / Eb短調だけはprojectの`key`の綴りに従う。Projectの`key` / `scale`は1組だけなので、調号は1件のみ(key changeは扱わない)
- P54: import時、次をすべて満たすchannelだけProgram Changeをpresetへ戻す。(1) そのMTrkのchannelにProgram Changeがちょうど1件(同じ値の繰り返しも複数扱い)、(2) tick 0で最初のNote Onより前、(3) Bank Select(CC0 / CC32)がどこにも無い、(4) channel 10ではない。さらにプログラム番号が正規preset(エイリアス除く)へ1対1で戻る場合は、そのpresetを適用して警告しない。それ以外は従来どおり対応せず、従来の「音色・バンク指定」または「途中の音量・パン・音色変更」警告を出す。調号は従来どおり現在の曲のkey / scaleと一致するときだけ警告しない
- MIDIはpitch / start / duration / velocity、先頭volume / pan、tempo / meter event、chord symbol markerを相互運用向けに正規化する形式である。audio / automation、map event ID、clip境界、loop / alias、音源preset、effects、mute / solo、groove、section、chordの機能・構成音などProject固有の意味をexactには復元しない
- drum MIDIはライブ/WAVのoccurrence resolverを通さず、保存されたstep位置とvelocityをnormalized projectionとして1回出力する。swing、probability、humanize、seed、mute / soloを演奏結果としてbakeせず、drum `Clip.loop`も展開しない。実際に聞こえる演奏を共有する場合はWAVを使う

### 10.2 WAV

- 既定は44.1kHz stereo・PCM 16-bit・ディザOFF。この既定の出力はP50以前のmainとバイト単位で同一(固定した旧encoderとの一致テストで守る)
- 書き出しオプション: サンプルレート44.1 / 48 kHz、ビット深度16 / 24 bit、ディザON / OFF。選択はExportダイアログ内のUI状態で、Projectやschemaには保存しない。全体WAVと選択TrackのWAVに同じ設定を使う
- RIFFはword境界に揃える。data sizeが奇数(24-bitのmonoで奇数frame等)の時はdata chunkの後ろに0の1 byte padを置き、RIFF sizeにはpadを含め、data sizeには含めない。RIFF sizeが32-bitに収まらない出力は、確保の前に`RangeError`で拒否する
- 24-bitはlittle-endian 3 byte PCM(fmt chunkの`bitsPerSample` 24、`blockAlign`、`byteRate`を正しく書く)。full scaleを超える値はwrapせずclampし、+1.0は`0x7FFFFF`、-1.0は`-0x800000`になる。24-bitにはディザをかけない
- ディザは16-bitへ丸める時だけのTPDF(±1 LSB)。PRNGは固定seed(`0x43545335`)の線形合同法で、Math.randomを使わない。同じ描画結果なら同じbytesになり、テストを再現できる。ディザ後もclampする。値がちょうど0のsample(デジタル無音)にはディザをかけず0のまま出力し、PRNGも進めない
- 48 kHzは`OfflineAudioContext`を48000で生成し、tail計画・frame数・resource予算のsample rateもこれに合わせる。frame数は`ceil(totalSeconds × sampleRate)`
- サイズ予算はPCM bufferを`bitDepth / 8`で見積もる。48 kHz / 24-bitは同じ曲でも44.1 kHz / 16-bitより大きく見積もられ、`OfflineAudioContext`生成前に`WavRenderLimitError`で拒否する(例: 5分の曲+40秒tailは44.1 kHz / 16-bit・48 kHz / 16-bitで通り、48 kHz / 24-bitは拒否)。native保存の上限192 MiBは変えない
- 内蔵instrument / drumとAudio Trackをレンダー対象にし、Audio Clipはliveと同じshared planner、source range、gain、fade、loopを使う
- ライブ自然終了とWAVは、resolved eventとAudio Clip regionから同じ`planAudioTail`を使う。instrumentはノート長とpreset ADSR、oscillator停止padを、drumは各laneの実source停止時刻を、Audio Trackはtrim / loop後の可聴source終端を使う。source終端をrouting DAG順に伝播し、main / post-fader sendではsource Track insert、到達BusごとにBus insertのtail-timeを加える。pre-fader sendはsource fader / insert / panを迂回して送るためsource insert tailをそのedgeへ持ち込まず、到達後のBus insertは加える。常設Master limiterは全体へ1回だけ加え、可聴sourceがないrenderにはeffectsやlimiterだけを理由とするtailを追加しない
- enabledなDelay / Reverbは振幅0.001（-60 dB）以上の最後の出力まで含め、exact thresholdも含む。Filterと3段EQはWeb Audio 1.1係数の最大pole半径から36dBのstate headroomを持って-60dB到達時刻を求め、無効・不安定な係数は1 stage最大2秒でfail-closedする。各Compressorは規格固定6ms look-aheadを直列加算し、Master limiter分は全体へ1回だけ加える
- 異常または多段のinsert chainはMaster limiter 6msを含むtail全体を40秒でhard capする。tailがある時はlimiter前のpost-effect出力を最後50msでfadeし、`fadeEndSeconds`から`totalSeconds`まではlimiter出力だけを保持する
- ブラウザ版は曲本体を5分までとし、tail込みの動的frame数を`OfflineAudioContext`生成前に計算する。render固有のstereo Float32 offline buffer + `44 + frames × 2ch × PCM16 2 bytes` encoder bufferを192 MiB未満とする。end-to-end予約では同じPCM16 bytesをencoder、Blob snapshot、native ArrayBuffer、IPC bodyの4copyとして保守的に数え、Float32 outputとの合計を384 MiB以下にする。曲本体5分と最大40秒tailは両上限内で許可し、超過はallocation前に初心者向けエラーを表示する
- schema上は最大131,072 Clipを保存できるが、再生session / WAV snapshotがcompileするplayable Audio Clip regionと1 planning windowのAudio source occurrenceは各10,000件までとする。liveのregion超過はTrack graph生成前に拒否し、各planning window超過はそのwindowのsourceを1件もscheduleせずsessionを中断する。後続windowで初めて超過した場合、それ以前のwindowは再生済みになり得る。WAVはMIDI / drum / chordのresolved eventとAudio source occurrenceの合計も10,000件までとし、全曲plan超過時は`OfflineAudioContext`生成前に型付きで拒否する
- WAVのAudio Asset working setはoffline Float32 output、PCM16 encoder / Blob / native ArrayBuffer / IPC copies、raw object、decode copy、decoded AudioBuffer、retained decode cacheを合算して384 MiB以下とし、個別上限内でも合計超過ならpartial WAVを作らない
- drum hitの採否・onset・velocityと32-bit `voiceSeed`はライブ再生と同じProject由来resolverで決める。固定seed noise PCMとsample-frame offsetもライブ/WAVで同じ実装を使う。transport loopとメトロノームはWAVへ含めない
- 各drum subvoice gainはsource stopと同じAudioParam時刻で0にし、main-threadの`ended` cleanupがfilter tailを切る時刻にPCMを依存させない
- テール長はPCMをsilence scanする値ではなく、source / effectパラメータから保守的に導出する。40秒capへ達する病的な多段insertは最後50msでfadeする。同じapp buildのpinned Chromiumでは同一Projectの再WAV書き出しを全bytes一致とし、seedだけ変えたfixtureではevent planを保ったままPCMが変わることを確認する。browser / OS / WebView / sample rateが異なるWeb Audio実装間のPCM bit identityは保証しない

### 10.3 Portable Project Bundle（`.ctsbundle` v1、実装済み）

- `.ctsproj.json`は16 MiB以下のcanonical Project metadataだけを扱う。`.ctsbundle`は同じcanonical Projectと、そのProjectが参照する全ready Audio Assetを1つのpathless binary containerへ格納する持ち運び用形式である。SQLite、absolute path、Elastic Audio派生PCM、解析cache、A/B状態、ハミングの録音PCM、カラオケ作成の一時PCMは含めない
- file layoutは`32-byte header → canonical UTF-8 manifest JSON → canonical Project JSON → distinct asset payloads`である。headerはlittle-endianで、0..7が`CTSBNDL1`、8..9がversion `1`、10..11がflags `0`、12..15がmanifest length、16..19がProject length、20..23がasset count、24..27がfile全体のexact length、28..31がreserved `0`である
- manifestのexact keyは`format / version / project / assets`、Project descriptorと各asset descriptorのexact keyは`byteLength / checksumSha256`である。`format`は`ctsbundle`、`version`は`1`。Project内のAudioAssetはchecksum、availability、IDの順でcanonical化し、distinct payloadとmanifest asset descriptorはlowercase SHA-256の昇順に並べる。同じchecksumと同じdecode metadataを持つProject entityは1 payloadへdeduplicateするが、byte length / media type / sample rate / channel count / frame countが矛盾する同checksumは拒否する
- manifestは512 KiB以下、Project JSONは16 MiB以下、個々のassetとheader・manifest・Project・全payloadを含むfile全体は128 MiB以下とする。exportはsafe-integer checked sumでoperation全体のexact byte lengthをrepository readと出力buffer確保より前に算出し、1 byteでも超える候補、unresolved asset、asset数超過を部分読込なしで拒否する
- rendererはexport/import operation全体に384 MiBの排他予約を取り、予約できない場合はcodec、repository、file handoffへ進まない。この値はWeb Crypto / Blob / Tauri内部の全process RSS copy数を断定するものではなく、appが制御する同時処理の保守的な上限である
- exportは全distinct repository objectのlengthとSHA-256を照合した後だけbundleを完成する。Webは`.ctsbundle` download、nativeは専用command `file_export_project_bundle`へraw binaryを渡す。nativeはTauri `Request`のborrowed raw bodyをsize・header・manifest structureまで検証してから、dialogとblocking atomic writeをまたぐために必要なcommand-owned copyをexact 1回だけ作る。JSON/base64 IPC、renderer path指定、検証前cloneは使わない
- native open cancelは1 byteの`[0x00]`、成功は`[0x01][filenameLengthLE u32][UTF-8 basename][bundle bytes]`を返し、absolute pathを返さない。native saveはexact `{ status: "saved" | "cancelled" }`を返す。open/save cancelはいずれも成功toast、repository store、Project置換、履歴、revisionを発生させない
- importはheader、manifest canonicality、Project codec、exact lengths、全SHA-256、payload終端、Projectのready AudioAsset descriptorとの一致を全て検証してからrepository storeを始める。payload viewは入力bundleをborrowするため、decoderだけのためのwhole-bundle copyは作らない。全distinct payloadのstore receiptがchecksum / lengthと一致した後だけfresh Project IDへcloneし、現在Projectを1回のatomic adoptionで置換する
- repositoryはcontent-addressed objectのdelete/rollback APIを持たない。full validation後の後続storeまたはadoption失敗ではimmutableな未参照objectが残り得るが、欠損objectを参照するProjectや部分採用Projectは作らない。nativeはgeneration-aware GCを持ち、Webのgeneration-aware orphan GCは既知の後続制約として明示する

## 11. MIDI Import

### 11.1 加算読み込み

- Format 0 / 1を受け付け、現在のProjectを置換せず、noteを持つ各`MTrk index × channel`を1つの追加Track候補にする。noteのないconductor MTrkは候補へ含めない
- 候補順はMTrk index、同じMTrk内ではchannel番号の昇順とする。非blankな明示FF 03名は`Track N`も含めてそのまま基底名に使う。FF 03が欠落またはblankでparserが合成した`Track N`だけをfile stem由来名へfallbackし、複数channelの識別子と既存名を含む衝突時の`(2)`、`(3)`を決定的に付ける
- noteのpitch / start / duration / velocityを保持する。各channelのtick 0にあるCC7 `c`は`volume = 2c / 127`、CC10は`c = 64`をcenter 0、それ以外を`pan = 2c / 127 - 1`へ変換し、欠落時はunity / centerにする。同じcontrollerが複数ある場合は最後のtick 0値を使う
- 現在のtempo / 拍子map、そのcompatibility mirror、key / scaleは変更しない。FF 59 key signatureを含むMIDIの初期値との差、途中または複数のtempo / meter / key signature、marker、Program / Bank、tick 0より後のvolume / pan / Program変更は、失われる内容と件数を区別したwarningとして通知する
- invalid UTF-8のtextは決定的な互換decodeへfallbackしてwarningを出す。duration 0のnote、未完了Note On、孤立Note Offは、usable noteが1音以上ある場合にだけ追加対象から除外し、種類別の件数をbounded summary warningで通知する。usable noteがない場合とその他の不正noteは全体を拒否する。C2〜C6外のnoteはProjectと再exportに保持し、Piano Rollで見えない件数をwarningに含める

### 11.2 Channel 10のdrum判定

channel 9の1候補は、全noteが次の条件をすべて満たす場合だけ16-step drum clipへ変換する。

- GM pitchがKick 36、Perc 37、Snare 38、Clap 39、Closed Hat 42、Open Hat 46の6種だけ
- durationが0.25 beatをsource PPQで表す位置から0.5 tick以内
- 受け入れ先Projectの該当beatで有効な拍子map上で、各小節を16分割したstep位置からsource PPQで0.5 tick以内
- 同一lane / stepの重複がない

1音でも条件を外れる場合、その`MTrk index × channel`候補全体をpitchと元beatを保持したinstrument MIDI Trackとして追加し、fallback warningを出す。可変拍子上で16-stepへexactに表現できない音を近いstepへ移動せず、変換可能な音だけを部分的にdrumへ移さない。

### 11.3 atomic commitと結果

- 全候補を1つのProject候補へ追加し、project codecで1回検証してから1回だけcommitする。既存Trackを含む128 Track上限、clip / event / timeline上限のいずれかを超えた場合は全体を拒否する
- browser file read、native picker / gateway、parse、map、codec validation、commitのどこで失敗または例外になっても、Project、history、revision、save queue、選択、active viewを読み込み開始前から変更しない。失敗表示には曲・選択・表示が不変である保証を必ず含める
- file read / native gateway / importのpending中はProject dialog全体をoperation lockし、rename、tab切替、新規作成、load / delete、再importと、X / Escape / backdropによるdismissをすべて無効にする。成功・失敗のsettle後に一括unlockする
- 成功時は`Nトラック・M音を追加しました`と複数形で件数を通知し、先頭の追加Track / Clipを選択する。先頭がdrumならDrum Editor、それ以外はPiano Rollへ移動する
- warningが1件以上ある成功ではProject dialogを自動で閉じず、件数と全warningをresult cardへ表示する。利用者が確認して「閉じて編集を続ける」を選ぶまでcardを保持する
- MIDIをexport後に再importして比較する対象は上記のnormalized projectionであり、Project全体のexact roundtripではない。exactな再編集には`.ctsproj.json`を使う

## 12. カラオケ作成（中央定位ボーカル軽減）

### 12.1 入力とpreflight

- 端末内のWAV / MP3 / M4A / AACを読み込み、拡張子だけでなく各container構造とchannel metadataも検証する。M4Aはsample tableを完全検証できる非fragmented AAC-LCに限定し、ALAC / HE-AAC / fragmented MP4は安全側に拒否する。入力は128 MiB以下、decode前にexact stereoかつ5分以下、生成WAVは192 MiB以下、入力Blob / decode用bytes / decoder scratch / stereo PCM / WAV二重保持を含む推定working memoryは384 MiB以下を必須とし、mono、多channel、左右差がほぼないnear-monoは処理前に拒否する
- 5分 / memory preflightは再生metadataだけを信用しない。WAVはPCM / IEEE float32の`fmt`と`data`、MP3 / ADTS AACは宣言frame列とdecoderが再同期し得るbounded header候補、M4AはAAC-LC codec設定、`mdhd` / `stts` / sample count / chunk offset / `mdat`の一致から時間上限を導出する。MP3 payload内の孤立したheader類似byte列は数えず、同一構成で連続する再同期候補だけをdecode上限へ加える。`decodeAudioData`前にbrowser presentation時間と正規container時間が300秒＋format / sample rate由来のbounded codec padding以下、decode時間上限が正規container時間＋2秒以下であることを要求する。duration tableを持たずbrowserが過大推定し得るADTS AACだけは、完全走査した正規frame列をpresentation時間より優先する
- memoryはdecode phase（入力保持＋decode時間上限のPCM＋decoder余裕）と、最大5分だけが到達できるoutput phase（入力保持＋stereo PCM＋WAV二重保持）を別々に見積もり、大きい方を384 MiB以下にする。decode後の実frame時間が300秒を超える場合、上記codec padding以内だけをzero-copy prefix viewで300秒へ切り詰め、それ以外はoutput allocation前に拒否する
- native版のpicker / I/Oは専用Rust commandと限定permissionで、128 MiB、拡張子、主要container構造を予備検証し、絶対pathをrendererへ返さない。受け取ったbytesはrendererの厳格parserでも必ず再検証し、Web版と同じ最終size / structure条件を適用する
- codec対応はOS / browser / WebViewに依存し得るため、container検証成功とdecode成功を分けて案内する

### 12.2 DSPとpreset

- 左右からMid / Sideを導出し、中央定位成分を減衰してSideを残す。低域は低域保護filterから戻し、中央のbass / kickが過度に消えるのを抑える
- presetは「自然」=中央75%軽減・150Hz以下を保護、「標準」=90%・120Hz以下、「強め」=100%・100Hz以下の3種とする
- 出力peakが1を超える場合だけ全体を減衰し、上向きnormalizeはしない。decode用AudioContextは44.1 kHzを要求し、端末が対応しない場合だけそのcontextのsample rateへfallbackする。最終出力はdecode後sample rate / 2 channelのPCM 16-bit WAVとする

### 12.3 UIと処理lifecycle

- Top Barの「カラオケ」から専用dialogを開き、音源選択、preset、作成、元音源 / カラオケのA/B preview、WAV保存を1つの導線で行う。A/B切替は同じ再生位置を維持する
- decode、解析、中央定位軽減、WAV encodeのphaseと進捗を表示する。長いloopはchunk化してevent loopへ制御を戻し、利用者は処理をcancelできる。処理中は閉じる、Escape、backdrop dismissと競合操作をlockし、cancel受付後はdialogを閉じられる状態へ戻す
- `decodeAudioData`とBlob全量read自体にAbort APIがないため、音源確認jobとdecode jobをそれぞれapp-scoped single-flight leaseで実settleまで追跡する。その間はdialogを閉じても同種jobの再開始を禁止し、source変更、再実行、cancel、dialog終了時は古いgenerationを無効化して、実job settle後にpreviewのobject URLと一時bufferを解放する
- background jobの開始から30秒を超えてもsettleしない場合はleaseを強制解除せず、作曲内容を保存してからWeb版を再読み込み、デスクトップ版を再起動する復旧案内をlive statusで表示する。settle時も、現在sourceがあるかに応じて「再作成可能」または「音源を選び直す」を通知する

### 12.4 Project境界と制限

- 読み込んだ音源、preset、進捗、decode済みPCM、生成WAVはtool-localな一時状態であり、Project / history / revision / autosave / SQLite / `.ctsproj.json`を変更しない。音源と処理結果は外部送信しない
- これはMLによるvocal stem分離ではない。中央に定位した声へ効きやすい一方、左右へ広がる声やreverbは残り、中央の楽器も弱くなり得る。Stem separation本実装はFutureのままとする
- 利用前とWAV保存前に、自作音源または利用許諾のある音源だけを使用する注意を表示する

## 13. 鼻歌からメロディ

### 13.1 入力とローカル解析

- Assistantからマイクで直接録音するか、録音済みのWAV / MP3 / 非fragmented AAC-LC M4A / ADTS AACを選び、外部送信せず端末内だけで単音メロディを解析する。どちらも60秒、mono / stereo、解析を含む推定working memory 256 MiB、fileは32 MiBを上限とする
- マイク導線は利用者の明示操作から権限要求、3秒カウント、録音、停止、解析の順に進める。再生中なら録音dialogを開く前にtransportを停止し、monitor出力は常に無音、0.5秒未満は拒否、60秒でexact frame停止する。許可拒否、deviceなし・使用中・切断、非対応環境を区別し、録音済みfileを常にfallbackとして残す
- raw PCMはAudioWorkletからbounded chunkで受け取り、録音中はchunk列、最終連続PCM、runtime overheadのworst-case peakとしてshared audio resource ledgerへ208 MiBを予約する。録音PCM、入力level、権限待ち、countdownはtransientで、録音終了後の解析予約へ所有権を渡し、Projectや永続storageへ保存しない
- source parser、browser presentation時間、format / sample rate別codec padding、decoder再同期上限をdecode前に検査する。presentation / containerは60秒＋許容padding以内とし、ADTS AACのbrowser過大推定だけは完全走査したframe列を優先する。decode後に残る許容paddingだけをzero-copyで60秒へ切り詰める
- 全source sampleの有限性とPCM 256 MiB上限を解析用配列の確保前に検査する。逆相channelを極性整合してmixし、8極low-passで8 kHz化前のaliasingを抑え、50〜1,000 Hzの正規化自己相関、RMS / periodicity gate、中央値、semitone hysteresis、無声区間分割から`startSeconds / durationSeconds / midi / confidence`を得る。同じ解析passから最大512 binのwaveform min/maxと最大3,000件のpitch frameだけを表示用に返し、raw PCMやAudioBufferは保持しない
- validation、極性整合、mix、pitch解析はbounded chunkごとにevent loopへyieldし、AbortSignalとgenerationで古い結果を破棄する。検出数が0または512超ならProjectを変更せず具体的に案内する

### 13.2 確認とProject反映

- 検出後にbounded waveform、pitch trace、半音guide、stable IDを持つ音符segmentを同じ時間軸へ表示する。選択segmentは確定前にpitch、開始、終了、位置を修正でき、分割、次segmentとの結合、候補除外、候補編集専用Undo / Redo / resetを行える。反映先MIDI Clipと1/16、1/8、1/4、補正なしを選ぶ
- segmentは開始時刻順の重ならないhalf-open区間とし、gapを許可する。長さは60 ms以上、MIDIは整数0〜127、confidenceは0〜1、最大512件に制限し、不正操作は候補全体を変更せず理由を表示する
- 秒位置は確定時点のcompiled tempo mapでclip-local quarter-note beatへ変換する。beat 0だけの固定mapも同じ経路で従来の固定BPM計算と一致する。量子化で同時刻へ畳み込まれた単音候補はconfidenceが高い1件だけを残し、clip終端でdurationをclampする
- 「メロディクリップへ反映」の明示操作まではProject / history / revision / autosaveを変更しない。確定は対象clipの既存notesを置換する1回のProject changeとし、Undo 1回で全体を戻す。成功後は対象Track / ClipとPiano Rollを選択する
- 入力は単音のマイク録音または録音済みfileを対象とする。表示と編集はMIDI化前のtransient候補だけに作用し、元音声を破壊編集しない。これはAudio Clipへ保存するElastic Audioとは別機能で、解析した鼻歌自体を修復しない。polyphonic transcription、歌詞認識、formant / vibrato編集は未対応としてUIとgap matrixに明示する

### 14. 選択Track WAV solo bounce

- 選択対象はinstrument / drum / audioだけとし、未選択・欠落・Master・Busはresolver、resource reservation、OfflineAudioContextより前に拒否する
- source projectionは全Track identityを保ち、未選択clipを除外する。選択Trackのlinked canonical sourceとAudioTakeFolder全体を保持し、他Track folderは除外する。選択clip／takeの素材metadataが欠落またはunresolvedならresource reservationとOfflineAudioContextより前に失敗し、無音／部分WAVを成功扱いしない
- original routingを1回compileし、選択sourceからenabledかつpositive-gainのoutput/sendで到達するBus closureを、graph、automation scheduler、tail plannerへ同一値で渡す
- full mixの既定契約とPCM bytesは変更しない

## 15. 試聴（音を鳴らして確かめる）

- ピアノロールの鍵盤を押す、ノートを追加する（ダブルクリック・キーボードのEnter/Space）、コードトラックのコードをクリックする、コード編集ポップオーバーの「このコードを鳴らす」を押すと、短い音がすぐ鳴る。
- 試聴は音だけで、Projectを変更せず、Undo履歴にも積まず、保存形式も変えない。
- 音は対象Trackの楽器・音色（マクロ設定を含む）を使い、再生と同じ音になる。コードはコードトラックの再生と同じ構成音（`realizeChordPitches`）を鳴らす。
- 同時に鳴る試聴音は最大16音で、超えると古い音から止める。各音は最長2秒で必ず止まり、新しいコードを鳴らすと前のコードは止まる。
- 再生中でも鳴らせる。試聴は専用の出力経路を使い、再生のスケジュールには触れない。再生開始・停止、Project切替、ウィンドウのフォーカス喪失・非表示、画面の終了で試聴音はすべて止まる。
- 録音中（Audio録音・オートメーション録音）は、入力モニタリングを持たないため試聴しない。
- **PC鍵盤で弾く**: トラック一覧の見出しにある⌨ボタン（「PC鍵盤で弾く」）をオンにすると、パソコンのキーボードで選んだ楽器トラックを弾ける（A W S E D F T G Y H U J K L が半音ずつ、Zでオクターブを下げ、Xで上げ、Escでやめる）。キーを押している間だけ鳴り、離すと止まる。同じ試聴の出力経路を使うので、全体で最大16音、押しっぱなしの音も最長8秒で必ず止まる。キーのリピートでは鳴り直さず、同じ高さのキーを2つ押しても別々の音として扱う。再生開始・停止、Project切替、ウィンドウのフォーカス喪失・非表示、画面の終了、録音の開始、画面のどこかをクリックした時、フォーカスが移った時、Ctrl / Cmd / Alt / AltGrを押した時、モードをオフにした時（Escを含む）に、鳴っている音はすべて止まる。押しっぱなしの音は、リリースを含めて8秒までに必ず無音になる。テキスト入力中、IME変換中（keyが「Process」「Unidentified」、keyCode 229を含む）、Ctrl / Cmd / Alt（AltGrを含む）つきでは鳴らない。モードがオンの間は、鍵盤に割り当てた文字のキーの単独ショートカット（スケールスナップのSとコードトーンのC。フォーカスがどこでも止める）を止める。Projectは変えず、Undo履歴にも積まず、保存もしない（オン・オフとスケールロックはその画面の間だけの状態）。
- **スケールロック**: オンにすると、キーは曲のキーとスケールの音だけを順にたどる（音名の半音ではなく、スケールの何番目の音かで割り当てる）。オフのときは半音ずつ。小さなパネルに「キー → 音名」の割り当てを常に表示し、「スケールロックをオンにすると、どのキーを押してもスケールの音だけが鳴ります」と説明する。MIDI 127を超えるキーは鳴らさない。録音（P42）はこの機能に含まれない。
