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
│               │         / Automation              │           │
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

#### 2.3.4 Automation Lane Editor

- Editorの4つ目のARIA tabを「オートメーション」とし、選択中のTrackを編集対象にする。Track未選択では選択案内、Master選択では非対応理由、point 0件ではTrack scalarが全区間に使われることと最初の追加方法を表示し、暗黙にTrackやlaneを作らない
- non-Master Trackでは音量 / パンのtargetとbeat snapを選べる。lane上の位置または現在の再生位置へpointを追加し、音量laneとパンlaneは独立して保存する。snapは入力位置の確定時だけに使い、Projectへ別設定として保存しない
- laneの折れ線は、最初のpoint前が現在のTrack scalar、各pointの「値を保つ / なめらかに変化」がそのpointから次のpointへの出力方向、最終point後が最終値保持であることを形と説明文の両方で示す。hold区間は段差、linear区間は斜線で描き、色だけに依存しない
- pointは最低44×44 CSS pxのnative buttonとし、parameter名、順番、beat、値、次のpointまでの変化方法をaccessible nameに含める。選択pointだけをroving tab stopにし、削除後は次、前、lane追加操作の順でfocusを回復する
- 選択pointのInspectorではbeat、値、次までの変化方法をlabel付きnative controlで編集し、Delete / Backspaceによる1件削除と確認付きのlane全消去を提供する。同一beat、曲外、値範囲外、stale selectionはProjectを変更せずinline alertで具体的な修正を案内し、成功はpolite statusで通知する
- local draftまたはpointer previewは確定前にProject / history / revisionを変えない。Enter / blur / pointerupなど1 gestureの確定をProject変更1回、Undo 1回にまとめ、no-opでは履歴・保存通知を増やさない
- Inspectorはfieldごとのdirty状態を持ち、無編集blurではcommandを発行しない。値だけの確定はbeatをpatchせず、beat snapはbeat fieldの確定時だけに適用する。表示用の丸め値を未変更fieldへ書き戻さず、off-grid / 高精度beatを保持する
- lane編集でactive playbackが停止した場合は、再生位置を保持して次回再生から新しいcurveを使うことを通知する。保存・再読込、Undo / Redo、transport loop、可変tempo、offline WAVで同じlaneを使う
- 最大20,000 pointの正当なlaneでもnative point controlはviewportと選択pointを合わせて最大400件、curveは意味を保った最大3本のSVG pathへまとめる。30 Hzの再生位置購読はplayheadだけへ隔離し、lane全体を再renderしない。keyboardでviewport外を選択した場合もそのpointをrenderしてfocus / scrollを回復する
- 320px幅ではdocument全体を横overflowさせず、時間軸だけをlane内部で横scrollさせる。target、snap、追加、Inspector、削除、全消去は折り返して読める状態を保ち、hover、focus-visible、selected、disabled、errorを色以外でも区別する
- 現行のlaneは常時再生へ適用される。read / bypass、write / touch / latch記録、Master、insert / send / tempo automation、MIDI CC / LFO modulationを利用可能に見せるcontrolや状態名は表示しない

#### 2.3.5 Tempo / 拍子map Editor

- Editorの5つ目のARIA tabを「テンポ / 拍子」とし、tempo laneと拍子laneを同じ小節目盛り・playhead・内部横scroll領域に並べる。固定tempoだけの初期Projectでもbeat 0 anchorを明示し、空に見せない
- 「再生位置に追加」はtempoを現在beatへ、拍子を現在位置を含む小節の開始境界へ置く。同beatに既存eventがある場合は黙って上書きせず、そのeventを選択して編集方法を案内する
- eventは最低44×44 CSS pxのnative buttonとし、種類、順番、小節 / 拍、値、先頭anchorかどうかをaccessible nameに含める。矢印キーで前後event、Home / Endで先頭 / 末尾へ移り、削除後は次、前、追加buttonの順にfocusを回復する
- 選択eventのInspectorはbeat、BPMまたは分子 / 分母をlabel付きcontrolで編集する。beat 0は位置と削除をdisabledにし、値の編集は残す。小節境界、範囲、衝突、Project末尾整合の拒否理由をinline alert、成功と再生停止をpolite statusで通知する
- local draftやfocus変更ではProjectを変えず、確定したadd / edit / move / deleteだけを1 gesture = 1 Undoにする。Undo / Redoと保存・再読込後もevent ID、位置、値、compatibility mirrorを保つ
- 320px幅ではtoolbar / Inspectorを折り返し、document横overflowを出さず時間軸だけを内部scrollする。連続tempo ramp、audio follow / Smart Tempo、tempo automationを利用可能に見せるcontrolは置かない

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
- 成功時はbounded waveform概要とpitch laneを同じ時間軸で表示し、pitch traceと半音guideは装飾、stable IDを持つ音符segmentはnative buttonとする。低confidenceは色に加えて破線で区別し、時間軸だけを内部横scrollさせて320 px幅でもdocumentを横overflowさせない
- segment群はroving tab stopを1件だけ持つ。Home / EndとPageUp / PageDownで候補選択、上下で半音移動、左右で50 ms移動、Alt+左右で10 ms微調整、Shift+左右で終端変更、Delete / Backspaceで除外する。Cmd/Ctrl+ZとCmd/Ctrl+Shift+Zは候補編集専用Undo / Redoとし、ProjectのUndoへ伝播させない
- 選択segmentの音名、MIDI、confidence、開始、終了をlabel付きcontrolで示し、半音変更、分割、次との結合、除外、候補編集のUndo / Redo / resetをkeyboardだけで操作できる。不正な境界や最小長はinline alert、成功操作は専用のpolite live statusで通知する
- 反映buttonの直前に既存notesを置き換えることとUndo対応を明示する。解析成功時は候補結果へfocusを移し、確定後はPiano Rollへ移動して反映件数をlive statusとtoastで通知する

### 2.11 Audio Track録音

- Audio Trackだけに`R`の録音待機buttonを表示し、Track ListとInspectorの両方で同じ単一選択を`aria-pressed`、文字、形で示す。computed nameは`${Track名} 録音待機`とし、色だけに依存しない。Project操作または録音中は切替をdisabledにする
- transportの録音buttonには、通常レイアウトで待機中のTrack名または`新規Track`を可視表示し、accessible name / titleでも録音先を伝える。最小高のcompact layoutでは編集領域を守るため補助表示だけを省略し、`R`の状態とaccessible name / titleは維持する。録音待機なしでは新規Audio Track、待機中ではその既存Trackへ新しいClipを追加する
- 録音dialogは開始前に録音先と入力deviceを表示する。入力は`システム既定`を常に選べ、列挙済みdeviceのlabelが空なら`マイク N`を使う。`devicechange`後に選択済み入力が見つからなければalertと選び直しを表示し、一覧取得不可でもシステム既定による再試行を残す
- 録音開始後は録音先と入力deviceを固定し、終了または破棄まで変更controlを表示しない。3秒後に伴奏と録音を同じaudio clockで開始し、通常録音は「録音中・伴奏再生中」と表示する。開始前に`実測 / 自動（推定） / 自動なし`と-500〜+500 msの手動offsetを選べるようにし、正値=早め、負値=遅め、推定値は実測校正ではないことを常時説明する。実測optionは現在の明示入力に一致する成功profileがある時だけ表示し、不一致時は黙って録音を続けず再校正を案内する。再生中の任意punch、device hot switchを対応済みと示唆しない
- transport loopがONなら録音dialogに「サイクル録音」、明示loop範囲、2〜128のテイク数、約総時間、完走後にtake folderへまとめることを表示する。総時間は正のlatency tail込みで60秒以内に制限し、録音中は`テイク N/M`、Nth右境界後は最終入力遅延の収録状態を文字で示す。唯一の停止操作は「サイクル録音を中止して破棄」とし、manual stop / cancel / unmount / failureでは部分takeを保存しない。完走時はfolderを選択して「テイク編集」tabへ移り、生成テイク数をtoastで伝える
- 実測校正は通常録音とは別wizardで、明示選択した入力IDがある時だけ開ける。`システム既定`ではbuttonをdisabledにし、通常録音は既定入力のまま使えることと、校正には接続先の明示選択が必要な理由を表示する。wizardはスピーカーをOFFにしてinterface出力から選択入力へ物理cableを接続すること、入出力levelを低くすること、開放スピーカーとマイクでは実行しないこと、app monitorに加えてinterface / driver mixerのDirect Monitor・hardware Loopback・同一outputへのreturnもOFFにすること、出力 / driver / buffer変更後は再校正することを開始前に示す
- 校正中は3秒countdown、測定状態、入力level、取消をstatus / meterで示し暗黙dismissを無効にする。instructions / running / success / errorの各表示切替では、消えるbuttonにfocusを残さず新stepのprimary actionへ移す。成功時はmsとsample数を表示し、Projectや測定PCMを保存しない。通常のcancel / silence / clipping / ambiguity / low confidenceでは以前のprofileを維持する。入力選択または`devicechange`では進行中の校正を中止して旧profileも破棄し、推定へ戻ったことを明示する

### 2.12 Audio Take / Comp Editor

- 同一Audio Track・同一時間窓のAudio Clipを選択したAudio Clip Editorに「テイクにまとめる」を表示する。対象候補は自動検出し、2件未満、loop、素材problem、録音 / 保存中はbuttonをdisabledにして理由を同じpanelで説明する
- group成功後はArranger上の重なった元Clipを1つのtake folder blockへ置き換え、folderを選択してEditorの6つ目のtab「テイク編集」を開く。blockは「テイク N件」と仕上がり範囲を文字でも示し、通常Audio Clipと形・ラベルの両方で区別する
- Editorは最上段に「仕上がり」、続けてtake laneを縦に並べる。各laneはtake名と採用状態を持ち、選択範囲は色だけでなくoutline / pattern / accessible nameでも区別する。既存DAWのlane配置や専用tool iconを模倣せず、「この範囲を使う」という初心者向け動詞を使う
- pointer drag中は仕上がりrowだけをlocal previewし、pointerupで1回確定する。Escape / pointer cancelではpreviewを破棄する。精密操作はtake、開始beat、終了beatのlabel付きinputと「この範囲を使う」buttonを同じformに置く
- comp境界を選択すると左右のtake名と境界beatを表示し、native number inputで移動できる。採用中でないtakeだけに削除buttonを出し、確認後の削除でfocus対象が消えた時は次のtake、なければ前のtakeへ戻す
- accepted操作が再生を止めた場合は「仕上がりを更新したため、再生位置を保って停止しました」をpolite statusで伝える。errorはProjectが変更されなかったこと、素材problemは対象素材名、busyは録音 / 保存終了後に再試行できることをalertで伝える
- 320px幅ではtablistやdocumentを横overflowさせず、takeのmusical timelineだけを内部scrollする。lane、form、境界、削除はnative control、明確なfocus ring、44px相当のpointer targetを持つ。pointer精度をkeyboard利用の前提にしない
- UIに固定pass Audio cycle recording以外の任意punch、MIDI comping、名前付き複数comp、flattenを示すcontrolや予約labelを出さない

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
| Audio Track録音の開始前 | transportとTrack追加の両方から開ける。Track追加は常に新規Track、transportはAudio Trackの`R`が1件だけ待機中なら既存Track、待機なしなら新規Trackを対象にする。loop OFFは現在playheadへのone-shot、loop ONは明示範囲の2〜128固定passと約総時間を示す。0.5〜60秒、3秒countdown、dry録音、端末内処理を説明し、monitorは初期OFF、ON時はヘッドホン推奨を常時表示する |
| Audio Track録音中 | 通常は`録音中`、cycleは`テイク N/M`を色以外の文字でも示し、経過時間と入力level meterを表示する。one-shotは44px以上の保存 / 破棄、cycleは中止して全破棄だけをkeyboard操作可能にする。録音・保存中のX / Escape / backdrop、Project切替、window closeは安全に拒否し、cycle完走だけを自動保存する |
| Audio Track録音失敗 | permission拒否、マイクなし / 使用中 / 切断、短すぎる録音、memory上限、WAV変換、素材保存を区別し、再試行方法と`プロジェクトは変更されていません`を表示する。保存cancel後のlate resultを採用しない |
| Audio Assetが見つからない / 変更された | 素材名と`見つかりません` / `内容が変わっています` / `保存場所を利用できません`をClipと編集panelに表示する。別fileへ黙って置換せず、元のprofile / 端末で開き直すよう案内する。保存場所を利用できない場合はstorage / 権限を確認して再読込する。配置と編集metadataは保持し、素材を必要とする編集controlを無効にするが、最後の参照を安全に外せる削除は利用可能にする |
| テイク編集の対象不足 / 不一致 | 同じAudio Track・同じ開始位置・同じ長さの非loop Clipが2件以上必要であることを説明し、既存Clipや履歴を変更しない |
| テイク素材が見つからない / 変更された | folderと該当takeを保持し、範囲採用・境界移動・take追加を無効にする。別素材へ黙って差し替えず、元の端末 / profileでの再読込を案内する |
| テイク編集中の競合 | 録音または保存operation中はgroup / take追加 / comp確定 / 削除を無効にし、処理完了後に再試行できることを表示する。pointer previewはProject変更前に破棄する |
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
