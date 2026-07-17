# 04. UI/UX仕様

## 1. 情報設計

アプリは「作る」「学ぶ」「整える」を同じ画面内で切り替えられる構造にする。

```
┌──────────────────────────────────────────────────────────────┐
│ Top Bar: Project / BPM / Key / Scale / Transport             │
│          Export / カラオケ                                   │
├───────────────┬──────────────────────────────────┬───────────┤
│ Track List    │ Timeline + Chord Track            │ Learn     │
│               │                                  │ /Theory   │
├───────────────┼──────────────────────────────────┤ Panel     │
│ Browser       │ Editor: Piano Roll / Drum / Clip  │           │
└───────────────┴──────────────────────────────────┴───────────┘
```

## 2. 主要画面

### 2.1 Start Screen

目的: 最初の1分で迷わせない。

要素:

- 新規作成
- テンプレートから作る
- 前回の続き
- チュートリアル開始
- サンプルプロジェクト

テンプレート:

| テンプレート | 初期設定 |
|---|---|
| 8小節BGM | 120 BPM, C Major, 4/4 |
| Lo-fi Loop | 82 BPM, A Minor, 4/4 |
| Game Jingle | 140 BPM, C Major, 4/4 |
| Rock Sketch | 128 BPM, E Minor, 4/4 |
| Blank | ユーザー指定 |

### 2.2 Main Studio

要素:

- Top Bar
- Track List
- Timeline
- Chord Track
- Clip/Pattern Lane
- Editor Pane
- Learn Panel

Track Listの管理UI:

- 見出しの「追加」からdialogを開き、楽器 / ドラム / オーディオ / Bus、名前、楽器の場合は4つの内蔵音色を選ぶ。楽器 / ドラム作成後は全曲長の空Clip、オーディオ作成後はasset全rangeのAudio Clipを選択してArrangerへ移す。BusはClipを作らず選択する
- オーディオ選択時はWeb file inputまたはnative pickerでWAV / MP3 / M4A / AACを選ぶ。「端末内で48 kHz PCM 16-bit WAVへ変換し、Project JSON単体には音声を含めない」ことを選択前から表示する。読込・decode・resample・encode・保存中はdialogを`aria-busy`にし、競合操作を無効化しつつcancelを提供する
- Bus Trackは「複数トラックの音をまとめて同じ音量・エフェクトで調整する」空のstereo Busとして選べる。追加時はClipを作らずMasterへ直接つなぎ、作成後にMixerの「経路」からmain output / send先へ選べることを説明する
- 各non-MasterのMixer stripにはkeyboard操作可能な「経路」disclosureを置く。出力先はMasterまたはBus、sendは有効、送り量、フェーダー前 / 後、削除をsource Track名とtarget Bus名入りlabelで読み上げる。同名Busには保存順のordinalを付けてoptionと各controlを区別する。「前」は音量・効果の前、「後」は音量・効果・パンの後というplain-language説明を常に同じ領域に置く
- 循環、重複send、main outputと同じBusへのsendは変更を採用せず、音が同じ経路を回るため接続できないこととProjectが未変更であることをtoastで伝える。topology変更で再生を止めた時はplayheadを保持したことも通知する
- 選択したnon-master Trackに、名前の確定、音色選択、複製、上へ / 下への操作をまとめ、一般Trackには削除も表示する。Masterにはこれらを表示せず、schema v4の学習`role`を持つTrackは名前に関係なく削除を保護する理由を表示する
- 名前入力はlocal draftとし、入力途中にUndo / autosaveを増やさない。「名前を保存」または同等の明示確定でtrim済み名称を1回commitし、失敗時はdraftと再試行手段を残す
- 一般Trackの削除は対象名を含む確認dialogを経由する。Chords / Bass / Melodyには削除buttonを表示せず、domain commandを直接呼ばれても拒否する。成功後は生存する隣接Trackへ、追加・複製後は新Trackへfocusを移し、並べ替え後は同じTrackの操作にfocusを保つ。dialogをcancelした場合は起点buttonへ戻す
- commandの成功はpolite status、codec / 128 Track上限 / Master保護などの拒否はalertで理由を通知する。採用された構造・音色変更が再生を停止した時は、再生位置を保持したことと再度再生できることを知らせる

### 2.3 Piano Roll Editor

表示切替:

- Scale Highlight
- Chord Tone Highlight
- Ghost Notes
- Velocity Lane
- Theory Overlay
- 固定編集音域はC2〜C6。importされた音域外ノートはprojectとexportに保持するが、ノート表示・選択・Velocity Laneには出さない

編集ジェスチャー:

- ノート移動・長さ変更・ベロシティ変更はドラッグ中にプレビューし、主ポインターを離した時だけ1操作として確定する
- クリップ右端のダブルクリックは、現在のグリッド長を収められる最後の位置へノートを追加する。末尾量子化も終端を越えず、最後の有効グリッドへ置く
- キャンセルまたはpointer capture喪失時は、表示を確定済み状態へ戻す。保存中表示や教材成功通知を出さない
- Alt/Optionドラッグ中の複製候補は破線ゴーストで示し、実ノートとして選択・件数計上しない。クリックだけ、3px未満、原点へ戻した操作では複製しない
- 複数選択移動は境界でノート同士を潰さず、選択内の相対タイミングを維持する
- Scale Snap有効時も、上下方向に次のスケール音がC2〜C6内にない操作と、時間方向だけの移動・複製がclip境界でbeat delta 0になる操作はno-opにし、音高だけを補正しない
- 固定編集音域内にノートがある場合はアクティブな1音だけをTab順へ入れ、選択の内側線とキーボードフォーカスの外側線を形で区別する。固定編集音域内にノートがない場合は入力グリッドをTab順へ入れる
- 読み上げ名には音名、開始、長さ、強さ、スケール内外、選択状態を含め、キー操作の結果だけをpolite live statusで通知する
- coarse pointerではノートのpointer hit targetを最低24×24 CSS pxにする。Velocity Laneは固定編集音域内のノートだけを表示し、ベロシティの可視高を値どおりに保ったまま透明hit領域だけを44px以上へ広げる
- 固定編集音域内にノートがない空グリッドは、coarse pointerのnative pan・scroll gestureを妨げない
- キーボード操作は矢印=移動、Shift+左右=長さ、PageUp/PageDown=強さ、Shift+PageUp/PageDown=前後の音へフォーカス、Enter/Space=選択、Cmd/Ctrl+A=現在clipの固定編集音域C2〜C6全体（水平viewport外を含み、importされた音域外ノートは除く）を選択、Cmd/Ctrl+D=複製、Delete=削除、Escape=入力位置へ戻る

#### 2.3.1 Arranger Clip編集

- 選択Clipの開始・長さ、独立コピー、連動コピー、連動解除を1つの編集panelへまとめ、操作結果または拒否理由を`status` / `alert`で通知する
- MIDI Clipだけに「素材をクリップ末尾まで繰り返す」checkboxを表示する。native checkboxのchecked状態をProjectの`loop`と一致させ、キーボード・読み上げ操作を保つ
- 連動コピーでもcheckboxは選択instanceだけを変更する。「このクリップだけ」と明示し、正本の素材や別配置のloopまで変わったと誤解させない。変更はUndo/Redo可能にする
- 独立/連動コピーまたは連動解除をkeyboardで実行して起点buttonが消える場合は、成功後の対象Clip buttonへフォーカスを移す。loop checkboxはSpace操作後もフォーカスを保ち、transportのSpace shortcutを起動しない
- 成功`status`は採用済みProject上の対象Clip IDと期待状態へ結び付ける。UndoやProject切替で成立しなくなった通知は除去し、後のRedoで古い成功通知を再表示・再読み上げしない
- Drum Clipには同checkboxを表示しない。drum `Clip.loop`は現行再生で未展開のため、利用できない操作を示唆しない

Audio Clipを選択した場合は、通常Clip panelの代わりに音声素材名・状態と次の非破壊操作をまとめて表示する。

- 配置、左端、右端はmap-awareな小節番号、gainは-96〜+24 dB、fade in / outはミリ秒で入力し、確定時にframeへ変換する。入力途中はlocal draftに留め、Enterまたはフォーカス移動で1回だけcommitする
- loop checkbox、分割位置、「右へ独立コピー」、削除確認をkeyboardで操作できるようにする。Audio Clipのコピーはimmutable bytesだけを共有し、編集値は常に独立することを補足する
- loop中は左端trimとsplitをdisabledにし、source loop phaseをまだ保存していない理由を説明する。右端trimは反復の外側窓として利用できる
- `ready` metadataでも実binaryがmissing / changed / unavailableならClip上とpanel内で色以外の状態文を表示し、素材を必要とする配置 / trim / gain / fade / loop / split / duplicate controlを無効にする。削除は利用可能にし、最後の参照なら現行ProjectのAudioAsset metadataも安全に外す。保存場所の確認または元の環境で開く案内を出す

#### 2.3.2 Section編集

- Section blockは`aria-expanded`と、開いている編集regionへの`aria-controls`を持つdisclosureにする
- keyboardで開いた直後は「セクション名」へフォーカスし、種類、開始、長さ、削除、閉じるの順にTabだけで到達できるようにする
- 閉じる場合は起点Sectionへ戻す。削除した場合は次、前、「＋ セクションを追加」の優先順で、DOMに残る操作へフォーカスを移す

#### 2.3.3 Drum Grid

- 6 lane×1小節のstep matrixは`grid` / `row` / `rowheader` / `gridcell`で行列関係を公開し、編集buttonは常に有効cell 1件だけをTab順へ入れる
- 矢印キーで前後step / lane、Home / Endで表示中小節の先頭 / 末尾へ移り、Enter / Spaceで強→中→弱→オフを切り替える。partial最終小節では無効cellへ移動しない
- 小節切替buttonは`aria-pressed`を持ち、gridと各cellの読み上げ名に現在小節を含める。同じlane / stepでも小節1と小節2を区別できるようにする

### 2.4 Chord Palette

タブ:

- Basic
- Diatonic
- Common Progressions
- Borrowed
- Dominant Motion
- Custom

### 2.5 Learn Mode

画面の主導権を教材が持つモード。

- 次の操作対象をハイライト
- 関係ない機能を薄くする Focus Mode
- 成功時に短い音/視覚フィードバック
- スキップ可能

### 2.6 Mixer / Master

- Mixerは常時操作可能なdisclosureを持ち、buttonの`aria-expanded` / `aria-controls`と実際の表示状態を一致させる。展開・収納後もbuttonへkeyboard focusを保持する
- desktop幅（901px以上）かつ高さ700px以下では、Tauri最小windowでも中央編集面を残すためMixerを初期収納する。利用者が操作するまではviewport変化へ追従し、手動操作後はその選択をsession中保持する
- 低いdesktop windowでMixerを展開した場合は高さを160px以下に抑え、Mixer内部をscroll可能にする。Piano Roll本体は編集領域内で最低240pxのcontent heightを保ち、狭い残り領域ではEditor側をscrollして入力面を0pxにしない
- Track ListとMixerはTrackのvolume / pan / mute / soloについて同じproject stateを読み書きし、片方の変更をもう片方へ即時反映する
- Track ListとMixerのM/Sボタンは可視文字だけをaccessible nameにせず、`${Track名} ミュート` / `${Track名} ソロ`を持つtoggle buttonにする。`aria-pressed`を両surfaceで同じ状態へ同期し、Masterには表示しない
- 同じ種類のinsert effectを複数追加した場合はTrack名・効果名・同種内の連番をgroup、parameter、削除buttonのaccessible nameへ含め、各controlを一意にする
- MasterでMVP中に表示・操作するのは0.0〜2.0のvolumeだけとし、将来互換用のMaster `pan` / `mute` / `solo`はUIへ表示しない
- Master trackを持たないlegacy projectはvolume 1.0として扱う。非有限のMaster volumeを検出した場合は音を出さず、破損値を有効な音量として表示しない
- メトロノームはMaster volumeに追従し、Master meterはpost-faderの実出力レベルを表示する
- Track Listで変更したcanonical synth音色は保存済みProjectを正本とし、次のライブ再生とWAV書き出しで同じ音色を使う。Masterとdrum Trackにはsynth音色selectorを表示しない

### 2.7 Project / MIDI交換

- Project menuでは、`.ctsproj.json`を「曲をexactに再編集する形式」、MIDIを「他アプリとの音符中心の交換形式」と説明する。MIDIへclip / loop / alias / preset / effects / mute / solo / groove / section / chord semanticsの完全復元を示唆しない
- MIDI書き出しで量子化後の同一Track・同一音程が重なる場合はfile dialog / browser downloadへ進まず、「同じ音程のノートが重なっているためMIDIを書き出せません。重なりを短くするか、1つのノートにまとめてください。」とerror alertで案内する
- MIDI importは現在の曲へ加算し、BPM / 拍子 / key / scaleを変更しない。完了statusは単数のTrack名ではなく、`Nトラック・M音を追加しました`を読み上げる
- 成功後は先頭の追加Track / Clipを選択し、drumならDrum Editor、instrumentならPiano Rollを表示する。C2〜C6外のnoteは保持するが画面外であることを件数付きで知らせる
- browserのfile readまたはnative picker / gatewayからimport完了までProject dialogを`aria-busy`にし、内部fieldsetをdisabledにする。rename、tab切替、新規作成、load / delete、再importを含む全Project操作と、閉じるbutton、Escape、backdropのdismiss経路を同時に無効化し、resolve / reject後に同時unlockする
- warningはtempo / meter / FF 59 key / scale差と途中変化、marker、Program / Bank、後続automation、drum fallback、invalid UTF-8、duration 0、未完了Note On、孤立Note Off、画面外noteを区別する。toastには概要と残件数を出し、warningがある成功ではdialogを開いたまま、件数・全warning・明示的な「閉じて編集を続ける」をresult cardへ表示する。raw eventを無制限に列挙しない
- file read、gateway、parse、mapping、validation、commitのいずれが失敗・例外になっても追加件数を成功通知せず、読み込み前の曲・選択・Editor表示を保つ。errorには`MIDI読み込みによる曲・選択・表示の変更はありません。`を必ず1回だけ付け、再試行可能な原因を続ける

### 2.8 Drum Editor

- 選択したdrum Clipを優先して表示し、選択がない場合だけ先頭のdrum Clipへfallbackする
- 表示小節はClip開始位置から`timeSignatureMap`をたどって導出する。beat 0だけの固定mapでは`max(1, ceil(clip.lengthBeats / beatsPerBar))`と一致する。小節途中で終わるimported clipでも最終partial barを表示し、map-awareなstep開始beatがclip終端より前のcellだけを編集可能にする。終端と同じまたは後のcellはdisabledにして範囲外と読み上げる
- 表示のためにclip length、stepsPerBar、DrumEventをpaddingまたは丸めない

### 2.9 カラオケ作成（ボーカルカット）

- Top Barの常時表示buttonは可視ラベルを「カラオケ」、accessible nameを「カラオケ用音源を作る」とし、Exportの隣に置く。dialog見出しは「カラオケ作成（ボーカルカット）」とする
- dialogは「音源を選ぶ」→3つの軽減presetから選ぶ→「ボーカルカットを作成」→元音源 / カラオケを同じ位置でA/B試聴→WAV保存の順で迷わず進める。選択file名、形式、容量、長さ、処理結果の適合情報を表示する
- 処理phaseと実進捗を`aria-live`で通知し、cancelを用意する。処理中はdialogを`aria-busy`にし、閉じるbutton、Escape、backdrop dismiss、音源 / preset変更、再実行を一括で無効化する
- cancel後もAbort不能な端末処理が残る間は、dialogを閉じられる一方で音源選択 / 再実行をdisabledにする。30秒を超えた場合は保存後の再読み込み / 再起動を案内し、完了時は再作成可能か音源再選択が必要かをlive statusで通知する
- 結果見出しへfocusを移し、A/B切替と保存をkeyboardだけで操作できる。最小375×667でも横overflowを作らず、内容はdialog内で縦scrollできる
- 「端末内だけで処理」「ML分離ではない品質限界」「自作または利用許諾のある音源のみ」の3点を作成前から明示する

### 2.10 鼻歌からメロディ

- Assistant内に「鼻歌からメロディ」を置き、主操作を「マイクで鼻歌を録音」、fallbackを「録音済みファイルを選ぶ」とする。「端末内」「単音限定」「録音は保存しない」「fileは32 MB・両入力60秒」を開始前から表示する
- 録音dialogは説明と明示的な開始buttonを初期focusにし、許可待ち→3秒countdown→録音中→終了処理をstatusで示す。録音中は経過時間、入力level meter、終了して解析、破棄をkeyboardで操作でき、暗黙dismissは無効にする。許可拒否やdevice失敗後は再試行とfile fallbackを同じdialogに残す
- file確認、decode、sample検証、channel極性整合、mix、pitch解析を総合progressと`aria-live`で通知し、解析中はcancelを表示する
- 成功時は音符候補をscroll可能な一覧で表示し、音名、編集可能なMIDI note、候補除外、反映先clip、リズム補正をkeyboardだけで操作できる
- 反映buttonの直前に既存notesを置き換えることとUndo対応を明示する。解析成功時は候補結果へfocusを移し、確定後はPiano Rollへ移動して反映件数をlive statusとtoastで通知する

## 3. ナビゲーション

| ショートカット | 状態 | 動作 |
|---|---|---|
| Space | 実装済み | 再生/停止（input・button・ローカル操作要素にフォーカスがある場合を除く） |
| C | 実装済み | コードトーンボタンにフォーカス中、表示を切替 |
| S | 実装済み | スケールスナップボタンにフォーカス中、切替 |
| Q | 実装済み | クオンタイズボタンにフォーカス中、選択ノートを量子化 |
| Cmd/Ctrl+S | 実装済み | 保存 |
| R | 現行未実装（予約） | 録音/入力開始 |
| B | 現行未実装（予定） | Browser表示切替 |
| L | 現行未実装（予定） | Learn Panel表示切替 |
| T | 現行未実装（予定） | Theory Inspector表示切替 |
| Cmd/Ctrl+E | 現行未実装（予定） | Export |

Chord Track のコンテキスト内操作:

| ショートカット | 動作 |
|---|---|
| ← / → / Home / End | 追加対象の小節を移動 |
| Enter / Space（グリッド） | 選択中の小節にコードを追加 |
| Enter / Space / F2（コード） | コード編集を開く |
| Escape | コード編集を閉じて起点へ戻る |

## 4. 初回導線

1. 起動
2. 「最初の1曲」テンプレートを選択
3. 再生ボタンを押す
4. コード進行を選ぶ
5. ドラムをオンにする
6. ベース生成を試す
7. メロディを2小節入力
8. 8小節に複製
9. 音量を整える
10. 書き出す

## 5. エラー/警告

| 状況 | 表示 |
|---|---|
| 音が出ない | Audio device、mute、master volume を順に確認するチェックリスト |
| 保存失敗 | pathは表示せず、権限・空き容量・再試行/別名保存を確認する初心者向け案内を表示 |
| Native編集の保護中 | `未保存の変更を保護中です。`。まだ強制終了耐性を約束しない |
| Native編集の保護済み | 現在revisionのSQLite commit receiptを照合した場合だけ`未保存の変更は保護済みです。自動保存を待っています。` |
| Native編集の保護失敗 | assertive statusで、強制終了から保護できないことと、再試行または緊急書き出しを案内する |
| 緊急バックアップ | canonical codecで再読込可能と検証できたprojectだけを`.ctsproj.json`として出す。nativeはOS pickerの保存結果、Webはdownload開始だけを通知し、invalid/cancel/失敗を成功と表示しない |
| MIDI読み込み中 | Project dialogをbusyにし、内部の全Project操作とX / Escape / backdropをdisabledにする。file read / native gateway / importの完了前に別project操作や背後の編集へ戻れないようにする |
| MIDI読み込み成功 | `Nトラック・M音を追加しました`。warningがあればdialog内のresult cardへ種類別の概要、件数、全warning、確認後に閉じる導線を続ける |
| MIDI読み込みの一部非対応 | 現在のBPM / 拍子 / key / scaleを維持したこと、FF 59を含む差異・除外・fallback・保持内容を件数category付きwarningにし、Project全体をexactに戻すには`.ctsproj.json`を案内する |
| MIDI読み込み失敗 | 全failure pathで`MIDI読み込みによる曲・選択・表示の変更はありません。`を一度だけ伝え、上限、破損、対応形式、再試行を初心者向けに案内する |
| Audio Track読み込み中 | dialogを`aria-busy`にし、検査 / decode / resample / encode / 保存の進捗とcancelを表示する。別Track追加、閉じる、再importを競合させない |
| Audio Track入力が非対応 | WAV / MP3 / M4A / AAC、128 MiB以下、1〜2 channel、canonical output 128 MiB以下、decode PCM 256 MiB以下、source / decode / resample / WAV / 保存copyを含むphase peak 384 MiB以下という条件と、端末codecでdecodeできなかった可能性を分けて案内する。失敗時は曲・履歴・選択が不変であることを伝える |
| Audio Assetが見つからない / 変更された | 素材名と`見つかりません` / `内容が変わっています` / `保存場所を利用できません`をClipと編集panelに表示する。別fileへ黙って置換せず、元のprofile / 端末で開き直すよう案内する。保存場所を利用できない場合はstorage / 権限を確認して再読込する。配置と編集metadataは保持し、素材を必要とする編集controlを無効にするが、最後の参照を安全に外せる削除は利用可能にする |
| Project JSONへ音声がない | `.ctsproj.json`は音声binaryを同梱しないことをimport前に説明し、対応objectがlocal repositoryにない場合は現在のProjectを置換しない |
| カラオケ音源が非対応 | WAV / MP3 / M4A / AAC、128 MiB以下、5分以下、stereoという条件と、端末codecでdecodeできなかった可能性を分けて案内する |
| カラオケ音源がmono / near-mono | stereo中央定位の差分を利用する処理であることを説明し、左右に広がりのあるstereo音源を案内する |
| ボーカル軽減の品質 | 声が残る場合や中央の楽器も弱くなる場合があることを失敗扱いにせず、preset比較とA/B試聴を案内する |
| スケール外音 | 学習モードでは警告、通常モードでは情報表示 |
| クリッピング | Master meterを赤表示。下げる候補を提示 |
| LLM送信 | 送信されるデータを表示し、明示的同意を取る |

## 6. デザイン原則

- DAWらしい複雑さを一度に出さない
- 初心者モードでは1画面1目的にする
- 音楽理論は操作に紐づけて説明する
- 「正解」より「狙いに対する効果」を説明する
- 既存DAWのUI配置やアイコンをそのまま模倣しない

## 7. アクセシビリティ

- 主要操作にキーボードショートカット
- 色だけで状態を伝えない
- コード/スケールの色にはテキストラベルも付ける
- フォントサイズは設定可能
- チュートリアル音声読み上げ用テキストを保持
- 中央編集面は`main`、Mixerは名前付き`region`として公開し、ページに重複する`contentinfo` landmarkを作らない
- Track選択、ベース生成mode、小節切替は`aria-pressed`、現在読み込まれている保存Projectは`aria-current`で、見た目と同じ選択状態を公開する

### 7.1 スケールスナップ

- 新規プロジェクトではオフを初期値にし、利用者が明示的に有効化する
- コントロール名は教材と同じ「スケールスナップ」に統一する
- オンの場合は、オンにした後に追加（複製を含む）または移動した音だけを現在のキー／スケール内へ補正する。既存の音を一括変更しない
- 上下方向に次のスケール音が固定編集音域C2〜C6内にない場合は逆方向へ移動せずno-opにする。時間方向だけの移動・複製がclip境界でbeat delta 0になる場合も、音高だけを補正せずno-opにする
- トグルは `aria-pressed` と `aria-keyshortcuts="S"` を持ち、オン／オフと効果を読み上げ可能な状態テキストで通知する
- 単一文字ショートカットは対応コントロールへフォーカスがある間だけ有効にする。無効化・再割当なしで画面全体へ適用しない
- `Cmd/Ctrl+S` の保存操作と混同せず、スケールスナップへフォーカス中の修飾キーなし `S` だけを切替に使う
