# 02. 機能仕様

## 1. 機能一覧

| モジュール | 機能 | MVP | 説明 |
|---|---|---:|---|
| Project | 新規作成/保存/読み込み | Yes | WebはlocalStorage repository、Tauriはapplication-owned SQLiteへ自動保存。Project集約をexact roundtripできる交換形式は`.ctsproj.json`だけ |
| Template | 作曲テンプレート | Yes | 8小節、16小節、BGM、ジングル等 |
| Chord Track | コードタイムライン | Yes | 小節単位でコードを置く。機能と候補を表示 |
| Chord Palette | コード候補 | Yes | ダイアトニック、代理、借用、セカンダリ候補 |
| Scale Assist | スケールガイド | Yes | スケール内外を可視化。スナップ可能 |
| Piano Roll | MIDI編集 | Yes | ノート作成、移動、複製、量子化、ベロシティ |
| Drum Sequencer | ステップ入力 | Yes | 16ステップ基本。後続で確率/スウィング |
| Clip Launcher | ループ試作 | Partial | MVPは簡易クリップ一覧。v1で非線形再生 |
| Arranger | セクション配置 | Yes | Intro/A/B/Chorus/Bridge/Outro ラベル |
| Mixer | 音量/パン/ミュート/ソロ | Yes | 各トラックに基本操作 |
| Effects | 基本エフェクト | Partial | Filter/Delay/Reverbを最小実装 |
| Tutorial | 操作・状態連動チュートリアル | Yes | 確定操作イベントと採用済みProject/UI状態を再照合して進行 |
| Exercise | 理論演習 | Yes | コード判定、スケール判定、メロディ添削 |
| AI Coach | 説明付き改善提案 | Optional | APIキー設定時のみ。MVPではモック可 |
| Export | MIDI/WAV | Yes | MIDIはFormat 1の正規化projection、WAVは簡易レンダー |
| Import | MIDI import | Yes | `.mid` / `.midi`を検証し、MTrkとchannelに応じた複数トラックを現在の曲へ追加する |
| Audio Track | Audio file配置 | Should | MVPでは再生のみ候補。編集は後続 |
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

### 3.3 操作

- ダブルクリックでノート追加
- ドラッグで移動
- 端をドラッグで長さ変更
- Alt/Option + ドラッグで複製
- 「選択ノートをクオンタイズ」ボタンにフォーカス中のQで量子化
- 「スケールスナップ」ボタンにフォーカス中のSで切替
- 「コードトーン」ボタンにフォーカス中のCでChord Tone Highlight切替
- ノート移動・長さ・ベロシティのドラッグ中はローカルプレビューだけを表示し、主ポインターの`pointerup`で最終値を1回だけ確定する。1ジェスチャーはUndo 1回で全体を戻せる
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

複製後に解決される保存済みNote / DrumEvent payloadが200,000件を越える場合、操作はProject / history / selectionを変えず拒否し、ノート・ドラム・コピーを減らす案内を表示する。この永続予算ではMIDI Clip loopの派生音を増やさない。ライブはMIDI Clip loopの展開後Noteと派生Chord noteを含む実効scheduleを20,000件以下、WAVは全曲を一括scheduleするため10,000件以下に制限する。両者とも展開後onsetの0.75拍rolling window内を256件以下に検査する。transport loopは反復後のsteady-state密度も同じ上限で再検査し、超過時はper-track Web Audio graph / event nodeを作らず型付きに拒否する。WAV超過時はOfflineAudioContextと部分fileを作らない。

### 7.4 学習連動

- Intro: 要素を少なく始める
- A: メロディ/モチーフを提示
- Chorus: 音域、密度、コード変化で盛り上げる
- Outro: 要素を減らして終える

## 8. Mixer

### 8.1 MVP仕様

- Track volume
- Pan
- Mute/Solo
- Meter
- Master volume（MVPで有効なMaster操作はこれだけ。0.0〜2.0）
- Basic effects slot

Masterの`pan` / `mute` / `solo`は将来互換用の予約フィールドであり、MVPでは音声へ適用せずUIにも表示しない。Master trackを持たないlegacy projectはunity gain（1.0）として再生・WAV書き出しし、Master volumeが非有限値なら音声境界でfail-silent（gain 0）にする。

ライブのTrack出力とWAV PCMは同じMaster gainをlimiter直前で一度だけ適用する。ライブ専用のメトロノームもMaster faderを通し、ライブのMaster meterはpost-fader信号を表示する。WAVにはメトロノームclickとUI meter / analyserを含めない。Trackのmute / solo、各Track volume、Master volumeは、再生開始時およびoffline renderではsample 0から確定値を使い、再生中に値を変更した場合だけ10msで平滑化する。

### 8.2 学習連動

- クリッピング時に警告
- ベースとキックの重なり説明
- リバーブ過多の警告
- 書き出し前チェックリスト

### 8.3 再生終端と自然テール

- 停止中に再生を要求した時、現在位置が有限かつ`0 <= positionBeat < songEnd`ならその位置を保つ。負値、非有限値、曲末と同じ位置、曲末より後では、拍子分母を含むquarter-note beat長から求めた`0`へ同じstate更新内で巻き戻してから再生を開始する。この補正はloop bounds、Project、Undo/Redo history、save stateを変更しない
- transport loopなしで曲末へ達した時は、transportをただちに停止して位置を0へ戻し、メトロノームと位置更新も止める。一方、最後の音、Filter / EQのIIR state、Delay / Reverb、Compressorのlook-aheadは、controllerが所有する1つだけのdraining sessionで自然に減衰させる。drain中もpost-fader Master meterは残響を表示する
- 最終50ms fadeはMaster limiterより前で完了し、その後もWeb Audio規格の固定6ms look-ahead分だけgraph / offline renderを保持する。40秒hard capはこの6msを含む出力全体へ適用し、短いtailでもfadeを曲本体へ食い込ませない
- 新しい再生、手動停止、Project切替、AudioContextの`suspended / interrupted / closed`は残っているdrainを即時に破棄する。破棄時は末尾fadeのMaster gain automationをcancelし、現在のMaster volumeを復元する。transport loopのwrapではdrainを開始しない
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

- Standard MIDI File Format 1で出力する。先頭の単一conductor MTrkに曲名、tick 0のtempo 1件、tick 0のtime signature 1件、各コード開始tickのchord markerを置く
- export対象のinstrument / drum Trackごとに独立したpart MTrkを作る。各part MTrkの先頭eventはtick 0のFF 21 MIDI Portとし、その後にtick 0のtrack name、CC7 volume、CC10 panを置く。ProjectのTrack上限は128であり、128音楽トラックでもこの対応を変えない
- 0-based melodic index `i`には`port = floor(i / 15)`とchannel `[0..8, 10..15][i % 15]`、0-based drum index `j`には`port = j`とchannel 9（MIDI Channel 10）を割り当てる。Project上限まで全partの`port / channel` pairを一意にし、channel再利用時もCC7 / CC10を別destinationとして分離する
- 曲名・track name・markerはUTF-8の実byte列で各4,096 bytes以下とする。4,097 bytes以上は途中までのfileを返さずexport全体を拒否する
- authored note / realized chord / drumのpitchとvelocity、Track volume / pan、drum laneをSMF data byteへ変換する前に検証する。整数範囲外、非有限値、不明laneをclampや不正byteへ変換せず、部分fileを返さずexport全体を失敗にする
- MIDI Clipの`loop=true`はライブ/WAVと同じ共通projectionでbakeする。自然周期`P = max(note.startBeat + note.durationBeats)`を使い、`note.startBeat + kP < clip.lengthBeats`の各開始だけを出力する。最終partial noteはclip終端で短縮し、量子化後に正の1 tickをclip内へ収められない断片は越境させず省略する。aliasは正本notesとinstance側のstart / length / loopを組み合わせる
- 各part MTrkは量子化後の全authored / linked / loop-expanded / realized / drum noteを同一channel・pitchごとに検査する。前のNote Offより早い同pitch Note OnはMIDI上で終了対象を識別できないため、無警告で音価を変換せず`overlapping-note`として全体を拒否する。同じtickのNote Off→Note Onという隣接は許可し、UIは同じ音程の重なりを短くするか統合する案内を出す
- MIDIはpitch / start / duration / velocity、先頭volume / pan、初期tempo / meter、chord symbol markerを相互運用向けに正規化する形式である。audio / automation、clip境界、loop / alias、音源preset、effects、mute / solo、groove、section、chordの機能・構成音などProject固有の意味をexactには復元しない
- drum MIDIはライブ/WAVのoccurrence resolverを通さず、保存されたstep位置とvelocityをnormalized projectionとして1回出力する。swing、probability、humanize、seed、mute / soloを演奏結果としてbakeせず、drum `Clip.loop`も展開しない。実際に聞こえる演奏を共有する場合はWAVを使う

### 10.2 WAV

- MVPは44.1kHz stereo
- 16bit / 24bit は後続検討
- MVPは内部音源のみレンダー対象
- ライブ自然終了とWAVは、resolved eventから同じ`planAudioTail`を使う。instrumentはノート長とpreset ADSR、oscillator停止padを、drumはKick / Snare / Closed Hat / Open Hat / Clap / Percの実source停止時刻を使い、enabledなFilter / EQ / Delay / Reverb / Compressorと常設Master limiterのtail-timeを加える。可聴eventがないrenderにはeffectsやlimiterだけを理由とするtailを追加しない
- enabledなDelay / Reverbは振幅0.001（-60 dB）以上の最後の出力まで含め、exact thresholdも含む。Filterと3段EQはWeb Audio 1.1係数の最大pole半径から36dBのstate headroomを持って-60dB到達時刻を求め、無効・不安定な係数は1 stage最大2秒でfail-closedする。各Compressorは規格固定6ms look-aheadを直列加算し、Master limiter分は全体へ1回だけ加える
- 異常または多段のinsert chainはMaster limiter 6msを含むtail全体を40秒でhard capする。tailがある時はlimiter前のpost-effect出力を最後50msでfadeし、`fadeEndSeconds`から`totalSeconds`まではlimiter出力だけを保持する
- ブラウザ版は曲本体を5分までとし、tail込みの動的frame数と、stereo Float32 offline buffer + 16-bit PCMの推定bytesを`OfflineAudioContext`生成前に計算する。曲本体5分と最大40秒tailを192 MiB未満で許可し、上限超過はallocation前に初心者向けエラーを表示する
- drum hitの採否・onset・velocityと32-bit `voiceSeed`はライブ再生と同じProject由来resolverで決める。固定seed noise PCMとsample-frame offsetもライブ/WAVで同じ実装を使う。transport loopとメトロノームはWAVへ含めない
- テール長はPCMをsilence scanする値ではなく、source / effectパラメータから保守的に導出する。40秒capへ達する病的な多段insertは最後50msでfadeする。同じapp buildのpinned Chromiumでは同一Projectの再WAV書き出しを全bytes一致とし、seedだけ変えたfixtureではevent planを保ったままPCMが変わることを確認する。browser / OS / WebView / sample rateが異なるWeb Audio実装間のPCM bit identityは保証しない

### 10.3 Project Bundle（将来案、MVP未実装）

- 下記はasset対応後に検討する単一の研究案であり、現行MVPの保存・入出力形式ではない
- `project.sqlite`
- `assets/`
- `exports/`
- `metadata.json`

## 11. MIDI Import

### 11.1 加算読み込み

- Format 0 / 1を受け付け、現在のProjectを置換せず、noteを持つ各`MTrk index × channel`を1つの追加Track候補にする。noteのないconductor MTrkは候補へ含めない
- 候補順はMTrk index、同じMTrk内ではchannel番号の昇順とする。非blankな明示FF 03名は`Track N`も含めてそのまま基底名に使う。FF 03が欠落またはblankでparserが合成した`Track N`だけをfile stem由来名へfallbackし、複数channelの識別子と既存名を含む衝突時の`(2)`、`(3)`を決定的に付ける
- noteのpitch / start / duration / velocityを保持する。各channelのtick 0にあるCC7 `c`は`volume = 2c / 127`、CC10は`c = 64`をcenter 0、それ以外を`pan = 2c / 127 - 1`へ変換し、欠落時はunity / centerにする。同じcontrollerが複数ある場合は最後のtick 0値を使う
- 現在のBPM / time signature / key / scaleは変更しない。FF 59 key signatureを含むMIDIの初期値との差、途中または複数のtempo / meter / key signature、marker、Program / Bank、tick 0より後のvolume / pan / Program変更は、失われる内容と件数を区別したwarningとして通知する
- invalid UTF-8のtextは決定的な互換decodeへfallbackしてwarningを出す。duration 0のnote、未完了Note On、孤立Note Offは、usable noteが1音以上ある場合にだけ追加対象から除外し、種類別の件数をbounded summary warningで通知する。usable noteがない場合とその他の不正noteは全体を拒否する。C2〜C6外のnoteはProjectと再exportに保持し、Piano Rollで見えない件数をwarningに含める

### 11.2 Channel 10のdrum判定

channel 9の1候補は、全noteが次の条件をすべて満たす場合だけ16-step drum clipへ変換する。

- GM pitchがKick 36、Perc 37、Snare 38、Clap 39、Closed Hat 42、Open Hat 46の6種だけ
- durationが0.25 beatをsource PPQで表す位置から0.5 tick以内
- 現在拍子の1小節を16分割したstep位置からsource PPQで0.5 tick以内
- 同一lane / stepの重複がない

1音でも条件を外れる場合、その`MTrk index × channel`候補全体をpitch保持のinstrument MIDI Trackとして追加し、fallback warningを出す。変換可能な音だけを部分的にdrumへ移さない。

### 11.3 atomic commitと結果

- 全候補を1つのProject候補へ追加し、project codecで1回検証してから1回だけcommitする。既存Trackを含む128 Track上限、clip / event / timeline上限のいずれかを超えた場合は全体を拒否する
- browser file read、native picker / gateway、parse、map、codec validation、commitのどこで失敗または例外になっても、Project、history、revision、save queue、選択、active viewを読み込み開始前から変更しない。失敗表示には曲・選択・表示が不変である保証を必ず含める
- file read / native gateway / importのpending中はProject dialog全体をoperation lockし、rename、tab切替、新規作成、load / delete、再importと、X / Escape / backdropによるdismissをすべて無効にする。成功・失敗のsettle後に一括unlockする
- 成功時は`Nトラック・M音を追加しました`と複数形で件数を通知し、先頭の追加Track / Clipを選択する。先頭がdrumならDrum Editor、それ以外はPiano Rollへ移動する
- warningが1件以上ある成功ではProject dialogを自動で閉じず、件数と全warningをresult cardへ表示する。利用者が確認して「閉じて編集を続ける」を選ぶまでcardを保持する
- MIDIをexport後に再importして比較する対象は上記のnormalized projectionであり、Project全体のexact roundtripではない。exactな再編集には`.ctsproj.json`を使う
