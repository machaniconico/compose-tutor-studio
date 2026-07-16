# 13. Pro DAW ギャップマトリクス

## 1. 比較条件

- 基準日: 2026-07-17
- 比較対象: Cubase Pro 15.0.30 / Logic Pro 12.3 / 現在の Compose Tutor Studio リポジトリ
- Cubase の根拠は Steinberg 公式 Cubase Pro 15.0 マニュアル、Logic Pro の根拠は Apple 公式 Logic Pro ユーザガイドだけを使用する。
- この表は「競合と同じ画面や全機能を複製する」計画ではない。初心者が曲を完成させる導線を保ちつつ、録音・編集・ミックス・書き出しを壊さず拡張するための差分台帳である。
- 現アプリの判定は、production UI から利用でき、保存・Undo・再生・書き出しの該当境界まで接続されているかを基準にする。単独の型、未接続コード、将来用フィールドだけでは「実装済」としない。

### ステータス

| 表記 | 判定 |
|---|---|
| 実装済 | 現行の対象範囲で end-to-end に利用でき、主要テストがある |
| 部分 | 基本機能または一時ツールはあるが、プロジェクト統合・高度編集・互換性のいずれかが不足 |
| 未実装 | production の利用導線がない。将来用の型や内部コードだけの場合も含む |

### 優先度

| 優先度 | 意味 |
|---|---|
| P0 | 次の土台。これがないとオーディオ制作または後続データモデルを安全に拡張できない |
| P1 | 制作・録音・ミックスを実用域へ引き上げる機能。P0 の安定後に追加する |
| P2 | 外部エコシステム、業務交換、高度な映像・空間音響。独立した技術検証と製品判断が必要 |

## 2. 機能ギャップ

| カテゴリ | Cubase Pro 15.0.30 / Logic Pro 12.3 の代表機能 | 現アプリ | 優先度 | 差分と採用方針 | 公式根拠 |
|---|---|---|---:|---|---|
| プロジェクト、履歴、素材管理 | 多数のトラック種別、素材参照、プロジェクト内の音声を前提に編集する | **部分**: schema v3、SQLite 自動保存、クラッシュ復旧、Undo/Redo、`.ctsproj.json` のexact roundtrip、AudioAsset / Audio Clip metadataのnative保存境界はある。実binary transactionと素材poolはない | P0 | schema v3 metadataを維持し、次Batchでapplication-owned assets directory、checksum検証、Project JSONとのatomic commit / recoveryを追加する。競合の全交換形式を直ちに再現しない | [Cubase Pro Help](https://www.steinberg.help/r/cubase-pro/15.0/en), [Logic Pro project basics](https://support.apple.com/en-ie/guide/logicpro/lgcpe9cc47b2/mac) |
| トラック管理と音色 | Audio / MIDI / Instrument / Group / FX / Folder などを作成・削除・複製・並べ替えでき、音源やパッチを選べる。Logic は Track Stacks も持つ | **部分**: production UIからinstrument / drumを全曲長Clip付きで追加し、non-masterの複製・並べ替え、一般Trackの削除・改名、canonical synth 4音色を扱える。schema v3のroleが学習意味の正本で、学習Trackも改名可能・削除保護、複製先はgeneralになる。Audio / Bus追加、Folder/Stack、freeze、track versionはない | P0 | role / 名前の分離を維持し、次BatchでAudio配置・再生、その後にroutingを導入する | [Cubase Pro Help](https://www.steinberg.help/r/cubase-pro/15.0/en), [Logic Pro Track Stacks](https://support.apple.com/en-ca/guide/logicpro/lgcp9bc4b63d/mac) |
| MIDI / Drum 編集 | Piano Roll、controller lane、pitch bend、aftertouch、step input、複数 part 編集、expression map、詳細 quantize など | **部分**: ノート作成・移動・複製・長さ・velocity・量子化・scale snap、Drum Step Sequencer、MIDI import/export はある。CC lane、pitch bend、MPE/Note Expression、step/real-time MIDI 録音、高度 transform はない | P1 | 初心者向け編集を保ち、controller lane、sustain、pitch bend、入力記録を段階追加する。MPE / articulation / logical editor は後段 | [Cubase Key Editor](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/midi_editors/midi_editors_key_editor_r.html), [Cubase Scale Assistant](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/midi_editors/midi_editors_scales_in_key_editor_r.html), [Logic Pro User Guide](https://support.apple.com/guide/logicpro/welcome/mac) |
| コード、スケール、伴奏支援 | 両製品に Chord Track があり、Cubase は Chord Assistant、Logic は Chord Track と Session Players の連携を持つ | **部分**: Chord Track、機能和声表示、コード候補、scale guide、Bass/Melody Assistant、学習解説は実装済。音声/MIDIからのコード解析、演奏スタイル付き伴奏、コード追従オーディオはない | P1 | 現アプリの教育的な説明は維持する。先に Project/Audio 基盤を作り、その後にコード解析と編集可能な伴奏生成を足す | [Cubase Chord Track](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/chord_functions/chord_functions_chord_track_c.html), [Cubase Chord Assistant](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/chord_functions/chord_functions_chord_assistant_c.html), [Logic Pro chords](https://support.apple.com/en-ie/guide/logicpro/lgcp2633963f/mac), [Logic Pro Session Players](https://support.apple.com/en-ie/guide/logicpro/lgcpbf624405/mac) |
| セクション、非線形アレンジ | Cubase の Arranger Track は chain、repeat、live jump、flatten を持つ。Logic の Live Loops は cell/scene を同期再生し Tracks area へ記録できる | **部分**: section label、clip の独立/連動複製、transport loop はある。section 順序を再生する chain、scene/cell 起動、performance capture はない | P1 | section annotation を壊さず、最初に「セクション再生順と反復」を追加する。Live Loops 相当の即興 grid はその後 | [Cubase Arranger Track](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/arranger_track/arranger_track_c.html), [Logic Pro Live Loops](https://support.apple.com/guide/logicpro/live-loops-overview-lgcpf46ffc88/10.7/mac/11.0) |
| Tempo / 拍子 / musical time | Tempo Track、拍子イベント、tempo change、音声からの tempo 解析・追従を扱える。Logic は Smart Tempo を持つ | **部分**: schema v3でtempo / 拍子mapと`lengthBeats`が正本、固定値はlegacy mirrorである。共通変換をlive / WAV / MIDI / timeline、metronome、Piano Roll / Drum / Chord UIへ接続済み。productionのmap編集UIとaudio followはない | P0 | variable-map回帰を維持してmap editorを提供し、Smart Tempo相当はP1で別評価する | [Cubase Tempo Track](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/editing_tempo_and_signature/editing_tempo_tempo_track_c.html), [Cubase Signature Track](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/tracks_about/tracks_about_signature_track_c.html), [Logic Pro tempo overview](https://support.apple.com/guide/logicpro/tempo-overview-lgcp3c2e8ef9/mac), [Logic Pro Smart Tempo](https://support.apple.com/guide/logicpro/smart-tempo-overview-lgcp9281e70c/10.7/mac/11.0) |
| Audio Asset / Audio Track | 音声をプロジェクトへ読み込み、region/event として配置・分割・trim・fade・crossfade・loop・gain 調整できる | **未実装**: schema v3にready / unresolved AudioAsset metadataとAudio Clipのframe source range / fade / gainはあるが、production導線、実binary保管、配置、再生、編集はない。音声は現在ボーカルカット用の一時入力だけ | P0 | 次Batchでapp-owned assets transactionを実装し、最初は非破壊trim / move / gain / fadeとlive/offline再生まで接続する | [Cubase Pro Help](https://www.steinberg.help/r/cubase-pro/15.0/en), [Logic Pro project basics](https://support.apple.com/en-ie/guide/logicpro/lgcpe9cc47b2/mac) |
| Audio 録音、take、comping | Audio/MIDI 録音、cycle take、punch、lane/take folder、comping、複数入力を扱える | **未実装**: record arm、入力 device、monitoring、録音 file、take/lane/comp の production 導線がない | P1 | schema v3 Audio Asset と Track CRUD 後に、単一入力録音→cycle takes→非破壊 comp の順で実装する。初回から multi-I/O 全対応を約束しない | [Cubase recording lanes and takes](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/track_handling/track_handling_lanes_working_with_c.html), [Logic Pro recording overview](https://support.apple.com/guide/logicpro/overview-lgcp7f3af10b/mac), [Logic Pro comping](https://support.apple.com/guide/logicpro/comping-overview-lgcp317d758e/10.7/mac/11.0) |
| Audio の time / pitch 編集 | Cubase は AudioWarp / VariAudio、Logic は Flex Time / Flex Pitch で timing と pitch を編集できる | **未実装**: waveform editor、warp marker、pitch segment、formant、audio quantize はない | P1 | 先に Audio Clip の非破壊 source range と tempo map を完成させる。その後に time stretch、単音 pitch correction の順で評価する | [Cubase AudioWarp](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/sample_editor_window/sample_editor_inspector_audiowarp_r.html), [Cubase VariAudio](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/sample_editor_variaudio/sample_editor_variaudio_c.html), [Logic Pro Flex overview](https://support.apple.com/guide/logicpro/flex-time-pitch-logic-pro-mac-audio-track-lgcp308143aa/mac), [Logic Pro Flex Pitch editing](https://support.apple.com/guide/logicpro/edit-pitch-and-timing-with-flex-pitch-lgcpc53e6bef/mac) |
| ハミング / 単音音声 → Melody MIDI | VariAudio と Flex Pitch は、解析済みの単音音声から MIDI note を生成できる | **部分**: 60秒以内の録音済み単音ファイルをローカル解析し、検出結果を確認して既存 MIDI Clip へ1回の変更で配置できる。マイク直録り、波形/pitch segment手修正、polyphonic transcriptionはない | P0 | 現行のfile decode → pitch/onset → confidence → tempo/grid quantize →確認→NoteEvent確定を堅牢化する。次にマイク権限と録音Asset基盤へ接続し、歌詞認識とは分離する | [Cubase Extracting MIDI from Audio](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/sample_editor_variaudio/sample_editor_variaudio_midi_extract_from_audio_t.html), [Logic Pro Create MIDI from Flex Pitch Data](https://support.apple.com/guide/logicpro/create-midi-from-audio-recordings-lgcpe2fd1b83/mac) |
| ボーカルカット / Stem 分離 | 両製品は vocal、drums、bass、その他などを推定分離する Stem Separation を持つ | **部分**: ローカル Mid/Side 中央定位軽減、3 preset、A/B、PCM 16-bit WAV 書き出しはある。中央にない vocal や reverb は残り、中央の楽器も減る。ML stem 分離ではない | P0 | まず現方式の境界・5分上限・codec padding・cancel/recovery を完成させる。ML stem 分離は品質、モデル配布、端末負荷、権利を別評価して P1 で判断する | [Cubase Stem Separation](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/audio_functions/audio_functions_stem_separation_r.html), [Logic Pro Stem Splitter](https://support.apple.com/guide/logicpro/extract-vocal-instrumental-stems-stem-lgcp61bae908/mac) |
| Mixer、routing、bus/send | MixConsole/Mixer は insert、send、group/aux、output、VCA、side-chain、複数 routing、automation を扱う | **部分**: per-track volume/pan/mute/solo、meter、Filter/Delay/Reverb/EQ/Compressor insert、Master gain/limiter はある。bus/send/return、VCA、side-chain、hardware I/O はない | P1 | schema v3 後に明示的な audio graph routing を導入する。最初は stereo bus と pre/post-fader send、循環拒否、live/offline parity を完了条件にする | [Cubase MixConsole](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/mixconsole/mixconsole_c.html), [Logic Pro mixing overview](https://support.apple.com/guide/logicpro/mixing-overview-lgcpbc219818/mac), [Logic Pro channel strip types](https://support.apple.com/guide/logicpro/channel-strip-types-lgcpbc2192ea/10.7/mac/11.0) |
| Automation / modulation | Track/region automation、write/read mode、parameter curve を持ち、mix や plug-in parameter を時間変化させられる | **部分**: schema v3にvolume / pan target、point、hold / linear補間があり、共通resolverでlive / offline schedulingする。production lane UIとwrite/read操作、insert/send/tempo automationはない | P0 | volume/panのlane editorとwrite/readを接続し、保存・Undo・loop・live/offline parityを維持してからinsert/send/tempoへ広げる | [Cubase Automation](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/automation/automation_c.html), [Logic Pro automation overview](https://support.apple.com/guide/logicpro/automation-overview-lgcpb1a1ea03/mac) |
| 内蔵音源、effect、sample library | 多数の software instrument / sampler / effect、preset browser、multi-output、modulation を持つ | **部分**: 小規模な内蔵 subtractive synth/drum と5種の insert はある。Sampler、音源 browser、multi-output、modulator、convolution、専門的 metering はない | P1 | P0 では現在の preset を選択可能にする。Sampler と asset browser を Audio Asset 上へ追加し、音源数の競争より一貫した保存・再現性を優先する | [Cubase Pro Help](https://www.steinberg.help/r/cubase-pro/15.0/en), [Logic Pro User Guide](https://support.apple.com/guide/logicpro/welcome/mac) |
| Export、bounce、相互運用 | 複数 format、channel/stem、range、real-time/offline bounce、業務用交換形式を扱う | **部分**: project 全体の stereo WAV、SMF Format 1 MIDI、`.ctsproj.json` はある。track/stem 一括、MP3/M4A、bit depth/sample rate 選択、AAF/XML/MusicXML はない | P1 | 先に routing/automation と同一結果の track/stem WAV を追加し、format option を拡張する。AAF/XML は P2 の明示的な互換プロジェクトとして扱う | [Cubase Export Audio Mixdown](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/export_audio_mixdown/export_audio_mixdown_r.html), [Logic Pro bounce](https://support.apple.com/en-gb/guide/logicpro/lgcp785a41c3/mac), [Logic Pro sharing](https://support.apple.com/guide/logicpro/sharing-overview-lgcp5a70f0fc/10.7/mac/11.0) |
| 楽譜 | MIDI を譜面表示・入力・layout・印刷/出力できる | **未実装** | P2 | Piano Roll と NoteEvent が安定した後の別 editor とする。初期は閲覧と MusicXML export の価値を検証する | [Cubase Score Editor](https://www.steinberg.help/r/cubase-pro/cubasescore/15.0/en), [Logic Pro Score Editor](https://support.apple.com/guide/logicpro/score-editor-interface-lgcpc7885e0b/10.7/mac/11.0) |
| 外部 plug-in / controller | Cubase は VST、Logic は Audio Units をhostし、両製品とも MIDI/controller mapping を持つ | **未実装**: VST3/AU host、plug-in scan、sandbox/crash isolation、latency compensation、MIDI learn/control surface がない | P2 | 「内蔵 effect がある」ことを plugin host 実装済とは数えない。SDK/license、署名、scan隔離、state保存、latency、crash復旧の検証を独立して行う | [Cubase VST plug-ins](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/installing_and_managing_plugins/installing_and_managing_plugins_plugin_manager_installing_vst_plugins_c.html), [Cubase MIDI Remote](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/midi_remote/midi_remote_c.html), [Logic Pro Audio Units](https://support.apple.com/guide/logicpro/work-with-audio-units-in-logic-pro-for-mac-lgcp22a0dab0/mac), [Logic Pro controller assignments](https://support.apple.com/guide/logicpro/controller-assignments-overview-ctls71c31487/10.7/mac/11.0) |
| Surround / Spatial Audio / video sync | Surround/object routing、Dolby Atmos authoring/monitoring、映像・timecode と同期する制作機能を持つ | **未実装**: 現在の可聴経路と WAV は stereo 前提。object/bed、ADM、video track、timecode、external sync はない | P2 | stereo の録音・routing・automation が安定するまで着手しない。Atmos 対応を現在の実装済機能として表示しない | [Cubase Pro Help: Dolby Atmos and video](https://www.steinberg.help/r/cubase-pro/15.0/en), [Logic Pro Dolby Atmos plug-in](https://support.apple.com/en-mide/guide/logicpro/lgcp8e75f0b5/10.7/mac/11.0) |

## 3. 優先度別バックログ

### P0: 次の基盤

1. ボーカルカットの入力時間・codec padding・cancel/recovery・書き出し回帰を完了する。
2. ハミング/単音音声ファイルを解析し、確認後に Melody MIDI へ変換する。
3. Track管理のうちinstrument / drum追加、non-master整理、roleと名前を分離した改名・削除保護、内蔵synth音色選択を部分完了する。Audio / Busは後続基盤へ送る。
4. **完了済み基盤**: Project schema v3としてTrack role、AudioAsset / Automation metadata、Tempo/Signature Map、v1→v2→v3 migration、native metadata境界を導入する。
5. **次Batch**: application-owned audio binary transactionを作り、schema v3を使うAudio Clip配置・再生・非破壊trim/gain/fadeを実装する。

### P1: 制作・録音・ミックス

- Audio 録音、monitor、take/lane、comping、punch
- stereo bus、pre/post-fader send/return、side-chain の最小基盤
- controller lane、sustain/pitch bend、MIDI step/real-time recording
- automation lane UI、write/read、insert/send parameter automation
- tempo/signature change 対応と Smart Tempo 相当の段階的な解析
- AudioWarp/Flex 相当を目指す非破壊 timing 編集と単音 pitch correction
- section chain と非線形再生、performance の arrangement 化
- track/stem WAV、range、format option、loudness/peak 診断
- ML Stem Separation はローカルモデルの品質・配布サイズ・処理時間を満たす場合だけ採用

### P2: 外部・業務・空間制作

- VST3/AU host と plug-in sandbox/crash recovery/latency compensation
- control surface / MIDI learn / remote mapping
- Score Editor と MusicXML
- AAF/XML などの業務交換
- Surround / Dolby Atmos / ADM、video track、timecode/external sync

## 4. 短期実装バッチと依存関係

```mermaid
flowchart LR
  B1[1. ボーカルカット完了] --> B2[2. ファイル入力の<br/>ハミング→メロディ]
  B2 --> B3[3. Track管理 + 音色<br/>部分完了]
  B3 --> B4[4. schema v3<br/>Track role / Audio Asset / Automation / Tempo Map]
  B4 --> B5[5. Audio Clip<br/>配置 + 再生 + 非破壊編集]
  B5 --> B6A[6a. Audio録音 + monitor]
  B5 --> B6B[6b. bus / send routing]
  B6A --> B6C[6c. takes / comping]
  B6B --> B6C
```

### Batch 1: ボーカルカット完了

- 対象: 現在のローカル Mid/Side 軽減方式。
- 完了境界: 対応 container の構造検証、exact 5分と codec padding の扱い、memory preflight、処理中 cancel、dialog 再開、A/B、PCM 16-bit stereo WAV。
- 非対象: vocal/drums/bass/other の ML 分離。

### Batch 2: ファイル入力のハミング → メロディ

- 単音のハミング・鼻歌・口笛を対象にし、polyphonic material は明示的に非対応とする。
- file decode → pitch/onset 推定 → confidence による除外 → tempo/grid quantize → preview → NoteEvent 確定を分離する。
- 初回は既存 Melody MIDI Clip への挿入で成立させ、Batch 3のinstrument追加導入後は新規instrument TrackのMIDI Clipも選べるようにする。
- 確定までは Project/history/autosave を変更せず、確定を Undo 1回にまとめる。

### Batch 3: Track 管理 + 音色（部分完了、schema v3 roleへ移行済み）

- production UIから追加できるのはinstrument / drumだけとし、全曲長の空Clipを持たせて先頭Master直前へ挿入する。Audio / BusはAsset / routingが必要という未提供理由を表示し、利用可能とは扱わない。
- non-masterのduplicate / reorder、一般non-masterのdeleteとcanonical synth 4 presetをProject mutationとして検証する。duplicateは全nested IDを新規にしてTrack内aliasをremapし、Masterは全管理操作から保護する。
- renameはlocal draftから1 commitにまとめる。schema v3では学習role Trackも改名できてroleを保持し、削除だけを保護する。一般TrackはChords / Bass / Melodyという名前でも学習roleにならない。
- 128 Track上限とcodec拒否はatomicにし、成功だけをUndo 1回・自動保存1回として採用する。selectionを生存IDへreconcileし、採用されたtopology / preset変更はplayheadを保持して再生を停止する。
- 残作業は、次BatchのAudio binary transactionとAudio Track配置・再生、Batch 6のBus routingである。

### Batch 4: schema v3 metadata foundation（実装済み）

- v2→v3 migration を pure/atomic にし、既存曲の音と固定 tempo を変えない。
- Track semantic roleをIDと独立して永続化し、既存の正規化済みChords / Bass / Melodyを決定的に移行する。欠落・重複roleを黙って推測せず、role再作成と一般Track化の規則を明示する。
- `AudioAsset`はready / unresolved metadataとchecksum fieldを持ち、Audio Clipはasset IDとframe単位の非破壊source range / fade / gainを参照する。legacy audio参照はunresolvedとして保持する。
- Automation metadataはtarget、point、interpolationを持ち、最初はvolume/panを対象にする。
- Tempo/Signature Mapはbeat-domainの正本、固定`bpm` / `timeSignature` / `lengthBars`はcompatibility mirrorとし、project-modelの単一変換境界を提供する。
- TypeScript codecとRust native境界はcanonical schema v3 metadataを検証・migration・保存する。

Batch 4ではmetadata/domain foundationに加え、Automationのlive/offline schedulingとtempo / 拍子mapのlive / WAV / MIDI / timeline接続まで実装した。application-owned assets directoryとbinary commit/recovery、Audio Clip playback、Automation lane UI / write/read、tempo / 拍子map編集UIは次Batch以降へ残る。

### Batch 5: Audio Clip 配置 / 再生 / 非破壊編集

- application-owned assets directoryへ実binaryをchecksum検証付きで取り込み、Project JSON commitとfile move / rollback / orphan recoveryを結ぶ。
- Batch 4の`AudioAsset` metadataを参照するAudio Track / Clipをproduction UIから追加し、配置、移動、trim、gain、fade、loopを非破壊に保存する。
- live playbackとoffline WAVが同じasset resolver、source range、gain / fade planを使い、missing / changed assetを型付きに拒否する。
- Project / Assetのcommit、Undo/Redo、再読込、削除時のorphan cleanupをatomicにし、音声fileを履歴snapshotへ重複コピーしない。

### Batch 6: 録音 / comping / bus-send

- 一つの巨大変更にはせず、`6a 録音とmonitor`、`6b bus/send`、`6c takes/comping` に分ける。
- recording は permission、device loss、disk full、入力切替、cancel、録音中のproject closeを回復可能にする。
- bus/send は routing cycle を保存前に拒否し、live/offline export で同じ graph を解決する。
- comp は元 take を破壊せず、採用範囲の編集だけを保存する。

## 5. 実装判断の原則

- Cubase/Logic の UI や用語をそのまま複製せず、「何ができるか」を初心者向けの操作へ翻訳する。
- 外部ネットワーク送信は追加しない。音声解析は原則ローカルで行い、外部サービスを導入する場合は別の明示的な製品判断にする。
- Audio/MIDI の transient 処理結果と、Project に永続する正本を区別する。
- live playback と offline export は同じ tempo、automation、routing resolver を使う。
- 高度な項目の型だけを先に追加して、利用可能であるように見せない。
- VST/AU、ML Stem Separation、Dolby Atmos、AAF は、最低限版と呼んで一括実装せず、それぞれ独立した品質・安全性・互換性 gate を持つ。

## 6. 完了条件チェックリスト

### 短期バッチ

- [x] Batch 1: 対応する通常音源、exact 5分、上限超過、cancel/reopen を含む unit/E2E/実ブラウザ検証が通る。
- [x] Batch 2: 単音 fixture で pitch/onset/休符/quantize が許容誤差内となり、preview から MIDI 確定を Undo 1回で戻せる。
- [ ] Batch 2: 無音、雑音、和音、多すぎるノート、上限超過を Project 無変更で説明付き拒否できる。
- [x] Batch 3 production導線（部分実装）: instrument / drum追加、non-master duplicate/reorder、一般Track delete/rename、schema v3の学習role Track改名・削除保護、canonical synth selectorを提供し、Audio / Busを未提供と表示する。
- [ ] Batch 3検証gate: 127→128と追加/複製上限、候補だけがcodec拒否されるevent/string fixture、全構造commandのactive playback停止差、canonical 4 presetのlive/WAV/Undo/`.ctsproj.json`/SQLite一致、drum browser E2Eを完了する。
- [ ] Batch 3後続境界: Audio TrackとBus Trackが完了するまで全Track CRUDと表現しない。
- [x] Batch 4 metadata foundation: v2→v3 migration、Track role、AudioAsset / Automation metadata、Tempo/Signature Mapのexact roundtrip、壊れた入力拒否、native metadata境界を実装する。
- [x] Batch 4 consumer integration: variable tempo / 拍子でもlive / WAV / MIDI / timeline / metronome /主要editorが共通mapを使う。
- [ ] Batch 5: 実binaryのchecksum付きtransaction / rollback / orphan recoveryを完成する。
- [ ] Batch 5: Audio Clipの配置・trim・gain・fade・loopが非破壊で、live/WAV/Undo/Redo/再読込後に同じ範囲を再生する。
- [ ] Batch 6: 録音失敗・device loss・disk full・close/cancel で既存 Project と Asset が壊れない。
- [ ] Batch 6: bus/send/automation を含む live と offline WAV の topology と parameter plan が一致する。
- [ ] Batch 6: take/comp の編集が非破壊で、保存・再読込・Undo/Redo 後も同じ範囲を再生する。

### リリース判定

- [ ] 各機能に「実装済/部分/未実装」の表示と実際の導線の不一致がない。
- [ ] TypeScript strict、unit、component、Playwright、Rust、release preflight、desktop build がすべて成功する。
- [ ] 対応OSの実機で入力device、長時間再生/録音、休止復帰、保存復旧、WAV書き出しを確認する。
- [ ] 著作権のある sample asset や無許諾 ML model を同梱しない。
- [ ] P2 の VST/AU、Atmos、AAF、Score を、未検証のまま「プロ対応済」と表示しない。
