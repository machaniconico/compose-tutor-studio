# 06. データモデル

## 1. エンティティ概要

| Entity | 説明 |
|---|---|
| Project | 曲全体 |
| Track | MIDI/Drum/Audio/Bus/Master |
| Clip | タイムライン上の素材 |
| NoteEvent | MIDIノート |
| DrumEvent | ドラムステップ |
| ChordEvent | コードトラック上のコード |
| AutomationLane / AutomationPoint | non-Master Track音量/パン、effective Master出力音量の時間変化 |
| Lesson | 教材 |
| LessonStep | 教材の各ステップ |
| UserProgress | 学習進捗 |
| ExerciseAttempt | 演習履歴 |
| AudioAsset | Projectが参照する音声metadata。実binaryはchecksumをkeyにした別repositoryで保持 |
| AudioWarp / AudioWarpMarker / AudioPitchRegion | Audio Clipの元素材を変更しないtiming / monophonic pitch編集metadata |
| AudioTakeFolder / AudioTake / AudioCompSegment | 同一Audio Track・同一時間窓の非破壊take群と、実際に鳴らすgaplessな範囲選択 |
| AudioRouting / AudioSend | non-Masterのmain outputとstereo Busへのpre/post-fader send |
| AppSetting | 設定 |

## 2. TypeScript型案

```ts
export type Project = {
  id: string;
  schemaVersion: number;
  title: string;
  bpm: number;
  timeSignature: [number, number];
  key: MusicalKey;
  scale: ScaleName;
  lengthBars: number;
  lengthBeats: number;
  tempoMap: TempoMapEvent[];
  timeSignatureMap: TimeSignatureMapEvent[];
  audioAssets: AudioAsset[];
  audioTakeFolders: AudioTakeFolder[];
  automationLanes: AutomationLane[];
  audioRouting: AudioRouting;
  tracks: Track[];
  chordTrack: ChordEvent[];
  sections: Section[];
  createdAt: string;
  updatedAt: string;
};

export type Track = {
  id: string;
  name: string;
  type: 'instrument' | 'drum' | 'audio' | 'bus' | 'master';
  role: 'general' | 'learning.chords' | 'learning.bass' | 'learning.melody';
  color?: string;
  clips: Clip[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  instrument?: InstrumentConfig;
  effects: EffectConfig[];
};

export type AudioRouteDestination =
  | { type: 'master' }
  | { type: 'bus'; trackId: string };

export type AudioRouting = {
  outputs: Array<{
    sourceTrackId: string;
    destination: AudioRouteDestination;
  }>;
  sends: Array<{
    id: string;
    sourceTrackId: string;
    targetBusId: string;
    position: 'pre-fader' | 'post-fader';
    gain: number;
    enabled: boolean;
  }>;
};

export type Clip = {
  id: string;
  trackId: string;
  type: 'midi' | 'drum' | 'audio' | 'automation';
  startBeat: number;
  lengthBeats: number;
  loop: boolean;
  aliasOf?: string;
  notes?: NoteEvent[];
  drumEvents?: DrumEvent[];
  stepsPerBar?: number;
  drumGroove?: DrumGrooveSettings;
  audioAssetId?: string;
  sourceStartFrame?: number;
  sourceFrameCount?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  gainDb?: number;
  audioWarp?: AudioWarp;
};

export type AudioClip = Clip & {
  type: 'audio';
  audioAssetId: string;
  sourceStartFrame: number;
  sourceFrameCount: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  gainDb: number;
  audioWarp?: AudioWarp;
};

export type AudioWarp = {
  algorithm: 'wsola-v1';
  formantMode: 'off' | 'preserve';
  timingEnabled: boolean;
  pitchEnabled: boolean;
  markers: AudioWarpMarker[];
  pitchRegions: AudioPitchRegion[];
};

export type AudioWarpMarker = {
  sourceFrame: number;
  targetBeatOffset: number;
};

export type AudioPitchRegion = {
  sourceStartFrame: number;
  sourceFrameCount: number;
  sourcePitchCents: number;
  targetPitchCents: number;
  correctionAmount: number;
  transitionFrames: number;
};

export type AudioTake = {
  id: string;
  audioAssetId: string;
  offsetBeats: number;
  lengthBeats: number;
  sourceStartFrame: number;
  sourceFrameCount: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  gainDb: number;
};

export type AudioCompSegment = {
  id: string;
  takeId: string;
  offsetBeats: number;
  lengthBeats: number;
};

export type AudioTakeFolder = {
  id: string;
  trackId: string;
  startBeat: number;
  lengthBeats: number;
  crossfadeMs: number;
  takes: AudioTake[];
  compSegments: AudioCompSegment[];
};

export type TempoMapEvent = {
  id: string;
  beat: number;
  bpm: number;
};

export type TimeSignatureMapEvent = {
  id: string;
  beat: number;
  numerator: number;
  denominator: number;
};

export type AudioAsset =
  | {
      id: string;
      availability: 'ready';
      checksumSha256: string;
      originalName: string;
      mediaType: 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/aac';
      byteLength: number;
      sampleRate: number;
      channelCount: number;
      frameCount: number;
    }
  | {
      id: string;
      availability: 'unresolved';
      legacyAssetId?: string;
      reason: 'legacy-reference' | 'missing-reference';
    };

export type AutomationLane = {
  id: string;
  target: {
    type: 'track-volume' | 'track-pan';
    trackId: string;
  };
  points: Array<{
    id: string;
    beat: number;
    value: number;
    interpolation: 'hold' | 'linear';
  }>;
};

export type DrumEvent = {
  id: string;
  lane: DrumLane;
  stepIndex: number;
  velocity: number;
  probability?: number;
};

export type DrumGrooveSettings = {
  swing: number;
  probability: number;
  humanizeVelocity: number;
  seed: number;
};

export type NoteEvent = {
  id: string;
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
};

export type ChordEvent = {
  id: string;
  startBeat: number;
  durationBeats: number;
  symbol: string;
  root: string;
  quality: string;
  notes: number[];
  degree?: string;
  function?: 'T' | 'SD' | 'D' | 'Other';
  tags?: string[];
};
```

### 2.1 Project schema v10（current）

- `schemaVersion`のcurrent valueは`10`。decodeはversionごとにrequired field、unknown field、型、有限値、整数、範囲を厳密検証し、`v1 → v2 → v3 → v4 → v5 → v6 → v7 → v8 → v9 → v10`の順にpureかつ決定的にmigrationする。
- v3では`Project.lengthBeats`を曲長の正本、`tempoMap` / `timeSignatureMap`を時間変換の正本とする。mapはbeat 0から始まり、IDを含む昇順event列として保存する。`bpm`、`timeSignature`、`lengthBars`は旧consumer用の互換mirrorであり、それぞれ先頭tempo、先頭拍子、拍子mapから算出した実小節数と一致しなければならない。
- `compileMusicalTime`でimmutable indexを作り、`beatToSecondsAt` / `secondsToBeatAt` / `secondsBetweenBeats` / `barToBeatAt` / `beatToBarPosition`を共通変換境界とする。従来の固定tempo用`beatToSeconds(bpm)`は互換APIとして残す。
- Trackの意味は`role`が正本であり、runtimeで名前から推測しない。`general`は予約名を含め自由に改名でき、改名でroleは変わらない。学習role Trackの削除は保護し、Track複製時のroleは`general`にする。
- v2→v3は全Trackを一度`general`にし、保存順で最初に正規化名`Chords` / `Bass` / `Melody`へ一致するinstrument Trackだけを対応する学習roleへ移す。固定曲長を`lengthBeats`へ移し、beat 0のtempo / 拍子event、空のAutomationを作る。
- legacy audio参照は捨てず、同じ非空`audioAssetId`を1つの`unresolved` AudioAssetへ集約する。欠落・空参照はClipごとの`missing-reference` placeholderにし、source range / fadeは0へ移行する。migration IDはraw object全体の既存IDとの衝突を避けて決定的に発行する。
- `ready` AudioAssetはchecksum、元名、media type、byte / sample / channel / frame metadataを持つ。v3 audio Clipは`audioAssetId`、frame単位のsource range / fade、`gainDb`を必須とする。`ready`参照はaudio Trackに限り、asset範囲とfadeを検証する。`unresolved`参照はframe range / fadeを0とし、legacy dataを破壊しないためmigration後だけ非audio Track上にも残せる。
- AutomationLaneはnon-Master Trackのvolume / panと、Project Track順で最初のeffective Masterのoutput volumeをtargetとし、pointのbeat / value、`hold` / `linear`補間、必須`bypassed`を保存する。Master panとlater Master targetは拒否する。v7で導入した必須`automationReadState`は`globalEnabled:boolean`と、Project Track順で一意な対応Track ID列`disabledTrackIds:string[]`を保存し、effective Master IDも許容する。effective Readは`globalEnabled && !disabledTrackIds.includes(trackId) && !lane.bypassed`で、live schedulerとfull / selected Track WAVは同じresolverを使い、falseならcommandを0件にしてTrack scalarを使う。Read / Touch / Latch / Writeの選択と記録pass状態はruntime-onlyで、確定したpointだけがAutomationLaneへ入る。
- v3→v4は各non-Masterへ保存順のdirect-to-Master outputをexact 1件作り、sendを空にする。v4はoutput / sendを合わせたDAGを正本にし、Master発edge、自分自身、missing / non-Bus target、重複send、main outputと同じBusへのsend、cycleを拒否する。無効またはgain 0のsendもgraph edgeとしてcycle検査へ含める。
- v4→v5は`audioTakeFolders: []`を追加するだけで既存のAudio Clipと再生結果を変えない。v5はfolder / take / comp segmentをProject全体のID名前空間へ加え、Audio Track・ready asset・source frame・gapless compの相関制約を正本にする。
- v5→v6は各AutomationLaneへ`bypassed: false`を決定的に追加し、既存curveと可聴結果を変えない。v5 payloadへの`bypassed`混入、v6 payloadでの欠落 / null / 非boolean / unknown fieldをTypeScriptとRustで同条件に拒否する。
- v6→v7は`automationReadState: { globalEnabled: true, disabledTrackIds: [] }`だけを追加し、Track、scalar、lane、pointと可聴結果を変えない。v6へのfield混入、v7の欠落 / null / 型違い / 重複 / Master / missing Track / unknown field / 非canonical順を拒否する。
- v7→v8は`schemaVersion`だけを更新し、v7で不正だったMaster automation / Read IDを移行時に許容しない。canonical v8だけが最初のeffective Masterのvolume target / Read IDを追加で許容し、Master pan、later Master、missing Track、重複 / 非canonical順を拒否する。
- v8→v9も`schemaVersion`だけを更新し、既存のAudio Clip、Automation、routing、takeと可聴結果を変えない。canonical v9だけがAudio Clipのoptional `audioWarp`を受理し、v8以下へのfield混入をunknown fieldとして拒否する。
- v9→v10は既存`audioWarp`に`formantMode: 'off'`を決定的に追加して既存の可聴結果を変えない。canonical v10は`off | preserve`を必須とし、v9のfield混入、v10での欠落 / unknown値 / unknown keyを拒否する。
- TypeScript codecとnative Rust境界は同じcanonical schema v10 JSONを検証・migration・保存する。AudioAsset binary、Elastic Audioの解析候補 / 表示用waveform / pitch frame、派生PCM cache、A/B状態はJSONへ埋め込まず、保存済み`audioWarp`はchecksum / byte lengthでapp-owned repositoryのimmutable objectを参照する。

linked Clipのv2契約はcurrent v10でも次のとおり維持する。

- v2の`aliasOf`はMIDI / Drum Clipだけが持てる。同じTrack・同じtype・同じ`lengthBeats`の非alias正本Clipを直接参照し、自己参照、dangling、別Track/type、chain/cycleを禁止する。
- 正本だけが`notes`または`drumEvents` / `stepsPerBar` / `drumGroove`を所有する。aliasはこれらと`audioAssetId`を省略し、`id` / `trackId` / `type` / `startBeat` / `lengthBeats` / `loop` / `aliasOf`だけを保存する。
- 独立複製と連動解除では全Note / DrumEvent IDを新規発行する。連動中の編集は正本へ1 commitで適用する。
- v1では`aliasOf`が保存されてもruntimeで参照されず、各Clip自身のpayloadが鳴っていた。v1→v2は音を変えないため全legacy `aliasOf`を削除し、独立Clipとして移行する。
- 永続境界の`resolved-stored`予算は、非Master Clipごとに正本の保存済みNote / DrumEvent件数をinstance回数ぶん数え、200,000件以下を必須とする。v1は互換性のため各Clip自身のpayloadを数え、派生Chord noteは含めない。連動/独立複製がこの上限を越える候補はProject、履歴、選択を変えずatomicに拒否する。

`Section`の時間境界はproject全体との相関制約として扱う。`startBar`は0以上、`lengthBars`は1以上の整数で、常に`startBar + lengthBars <= Project.lengthBars`を満たす。編集UIは数値入力の途中状態をlocal draftとして保持し、Enterまたはフォーカス移動でこの相関制約へclampしてからproject候補を作る。

永続化境界では、track colorをhex CSS色に限定し、project timelineを最大8192四分音符拍に制限し、clip/chord/note/map/automation pointをその範囲内へ収め、正のdurationを最低1/960拍とする。`notes`はMIDI clip、`drumEvents`/`stepsPerBar`/`drumGroove`はdrum clip、schema v4のAudio payloadはaudio clipだけに格納する。ただしv2→v3で生成した`unresolved`参照だけはlegacy data保全のため非audio Track上にも残せる。

ライブ再生とWAVは、schedule配列を作る前に`audible`予算を検査する。これは各MIDI Clip instanceの`loop`展開後Noteと派生Chord noteを数え、ライブ全体20,000件、全曲を一括scheduleするWAV 10,000件、さらにMIDI展開後・drum swing後onsetの0.75拍rolling window内256件以下に制限するruntime専用上限である。永続`resolved-stored`予算はloop派生音を増やさず、保存payload数との互換性を保つ。transport loopはschedule index構築後・per-track Web Audio graph構築前に、loop反復後のsteady-state 0.75拍密度も256件以下か再検査する。超過は型付きエラーで拒否し、event node、OfflineAudioContext、WAV部分fileを作らない。

MIDI Clipの`loop`は保存notesから導出するtransient occurrence projectionである。自然周期を`P = max(note.startBeat + note.durationBeats)`とし、各noteについて`note.startBeat + kP < Clip.lengthBeats`を満たす`k >= 0`だけを生成する。最終partial occurrenceのdurationはClip終端までに短縮し、終端と等しいonsetは生成しない。aliasはsourceのnotesとinstanceの`startBeat` / `lengthBeats` / `loop`を合成する。drum `Clip.loop`はこの契約の対象外である。

Project走査順のraw scheduleは一時projectionであり、時間順を保証しない。WAV projectionはdrum occurrence解決後にonset昇順へstable sortし、同一onsetの順序を保持したままvoiceへ渡す。これにより、後位置の正本より前位置のlinked instanceが後から走査される場合も、voice reaping / stealingが未来の音を先に停止しない。

### 2.2 Project aggregateとMIDI projection

`.ctsproj.json`はversioned project-model codecが扱うProject集約そのものであり、metadataのexact roundtrip形式である。`.ctsbundle` v1は同じcanonical Projectに全ready Audio Asset payloadを添えた持ち運び用containerで、import時は新しいtop-level Project IDを持つコピーとして採用する。どちらもProject schemaを増やさず、MIDIはProjectの別schemaではなく、他アプリとの相互運用に使うlossyなnormalized projectionとして扱う。

### 2.2.1 Portable Project Bundle projection

`.ctsbundle`はProject entityではなく、`Project + repository objects`から決定的に導出するexport projectionである。32-byte header、512 KiB以下のcanonical manifest、16 MiB以下のcanonical Project JSON、lowercase SHA-256昇順のdistinct payloadを連結し、全体を128 MiB以下に制限する。header / manifest / Project / 全payloadのexact lengthをsafe integerで事前合算し、超過、unresolved asset、同checksumでbyte length / media type / sample rate / channel count / frame countが矛盾するmetadataをrepository read・全体buffer確保前に拒否する。

同checksumかつ同decode metadataの複数`ReadyAudioAsset`はProject内の独立ID / originalNameを保持したままmanifestでは1 descriptor・1 payloadへdeduplicateする。Projectの`audioAssets`はchecksum、availability、IDの順、manifest descriptorとpayloadはchecksum順にcanonical化する。decoderは入力bundleのpayload subarrayをborrowし、magic / version / flags / reserved / manifest keys / canonical JSON / Project codec / exact lengths / SHA-256 / payload終端を全て検証してから返す。

importはfull validation後にdistinct payloadをcontent-addressed repositoryへ保存し、全store receiptがchecksum / byte lengthと一致した後だけfresh Project IDのcopyを1回採用する。失敗やcancelでは現在Project / history / revisionを変えない。repositoryにdelete/rollback APIがないため、検証後のstoreまたはadoption失敗でimmutableな未参照objectが残ることは許容するが、欠損objectを参照するProjectや部分Projectは作らない。Elastic Audio派生PCM、解析候補、ハミング録音PCM、カラオケ作成の一時PCMはこのprojectionへ含めない。

| MIDI source / output | Projectへの対応 | exactに扱う範囲 |
|---|---|---|
| `MTrk index × channel` | 1 Track + 1 Clip | import順はMTrk index、次にchannel昇順。noteなしconductorは作らない |
| Note On / Off pair | NoteEvent | pitch / startBeat / durationBeats / velocity |
| tick 0 CC7 / CC10 | Track volume / pan | 最後のtick 0値。CC7 `c`は`2c/127`、CC10は64なら0、その他は`2c/127-1`。欠落時はunity / center |
| channel 9 exact drum group | 16 `stepsPerBar`のDrumEvent | GM 36 / 37 / 38 / 39 / 42 / 46、duration 0.25とstep位置がsource PPQで0.5 tick以内、lane / step一意をgroup全件が満たす場合だけ |
| tempo / meter / FF 59 key signature | import warning comparison | 初期差と途中・複数変化を件数category化し、現Projectのtempo / 拍子map、その互換mirror、`key` / `scale`は暗黙変更しない |
| Project→MIDI | Format 1 MTrk列 | 単一conductorへtempo / 拍子map全eventとChord markerを投影し、Trackごとにpart MTrkを作る。各part先頭にFF 21、続いてname / CC7 / CC10。melodic `i`はport `floor(i/15)`と非drum channel、drum `j`はport `j` / channel 9。MIDI Clip loopは展開後Noteとしてbakeする |

一時IRの`hasExplicitName`で名前provenanceを区別する。非blankな明示FF 03名は`Track N`も文字列どおりTrack名の基底にし、FF 03欠落またはblankで合成した`Track N`だけをfile stem由来名へfallbackする。その後mixed channel識別子と既存名衝突suffixを決定的に付ける。provenance自体はProjectへ保存しない。

全groupを1つのProject候補へ写し、128 Track、clip / event、timelineなど既存のProject validationを1回通した後だけ1回commitする。browser file read、native picker / gateway、parse、mapping、validation、commitのどこで失敗・例外になっても候補を破棄し、Project / history / revision / save queue / selection / active viewは変えない。failure resultは曲・選択・表示が不変という共通assuranceをUIで1回付与できる形にする。

Program / Bank、marker、variable tempo / meter / key signature、initial key差、tick 0より後のchannel automationはProjectへ暗黙変換せず件数category付きwarning summaryへ残す。invalid UTF-8 fallback、duration 0、未完了Note On、孤立Note Offは種類別のbounded countを持ち、usable noteがある場合にだけ不完全eventを除外して続行する。C2〜C6外のNoteEventはProjectとMIDI再exportに残るがPiano Rollの表示集合には入らない。

成功resultは`trackCount`、`noteCount`、省略なしの`warnings[]`を持つ。warningがあればUIはこの配列全件をresult cardへ表示し、確認前にProject dialogを自動dismissしない。

drum Clipの表示小節数は永続fieldではなく、Clip開始位置に有効な拍子と以後の`timeSignatureMap`をたどって導出する。beat 0だけの固定mapでは従来の`max(1, ceil(Clip.lengthBeats / beatsPerBar(Project.timeSignature)))`と一致する。各cellは対応するmap-aware beatがClip終端未満の場合だけ編集可能とし、partial final barのclip終端以降はdisabledにする。Clip length、stepsPerBar、DrumEventをpaddingしない。

MIDI writerはProject上限まで各partのFF 21 `port/channel` pairを一意にする。chord realizationとdestination allocationの前にClip `trackId`、包含Trackとのtype対応、payload exclusivityを検証する。authored / realized pitch、note / drum velocity、export対象Track volume / pan、DrumEvent laneもdata byte生成前に全件検証し、量子化で省略されるnoteを含め、整数範囲外、非有限値、不明laneの1件でもあれば部分SMFを返さず全体を`invalid-project`にする。MIDI Clip noteはライブ/WAVと同じbeat-domain occurrenceをabsolute beatから個別に量子化し、final note-offをclip終端tick以下へclampする。start tickがclip終端tickと同じになり正durationを内部へ収められないsub-tick partialは省略する。量子化可否を数えるallocation-free occurrence workは各Clipではなくexport全体で累積し、最大event数の半数をhard capにする。各part内で量子化後の同一channel/pitch intervalが重なる場合、Note Offから元instanceを識別できずnormalized durationを保てないため`overlapping-note`として拒否する。exact adjacencyと別part destinationは許可する。正しいautomation Clipとaudio Trackは有効なlossy入力として受理するが、MIDI event / part MTrkには投影しない。

MIDIからはclip境界、loop / alias、instrument preset、effects、mute / solo、groove、section、chordの機能・構成音をexactに復元しない。Project→MIDI→Projectの比較は上表のnormalized projectionだけを対象とする。

### 2.3 Drum playback projection

`DrumEvent`と`DrumGrooveSettings`が永続正本であり、再生用scheduleはProjectから毎回導出するtransient projectionである。Project schemaへruntime stateを追加せず、各raw hitだけがTrack / Clip / DrumEvent identity、`sourceStepIndex`、`clipEndBeat`、`stepsPerBar`、拍子由来の`beatsPerBar`、velocity、実効probability、swing、humanize、seedを自己完結して持つ。選択中clipやEditor mount状態はprojection入力に含めない。

raw onsetはClip開始位置からlocal barを進め、各bar開始時に有効な`timeSignatureMap`の`beatsPerBar / stepsPerBar`で導出する。高密度consumerは`clipStartBeat + stepsPerBar`ごとに拍子境界のclip-local bar閾値を1回だけcompileし、全DrumEventで共有する。compileは拍子map件数Mに対してO(M log M)以下、各step lookupはO(log M)以下であり、eventごとのmap再走査を許可しない。単発互換API `drumStepToBeatOnTimeline`も同じ結果を返す。beat 0だけの固定mapでは`Clip.startBeat + DrumEvent.stepIndex * (beatsPerBar / stepsPerBar)`と一致する。source clip終端は`Clip.startBeat + Clip.lengthBeats`である。実効probabilityはDrumEvent値をclip値より優先する。swingは絶対timelineのstepではなく`sourceStepIndex`のclip-local parityに適用し、humanize幅は0〜127とする。決定的saltはTrack / Clip / DrumEvent identityとunwrapped occurrence beatから作るため、同じProject・seed・開始条件ではhit採否、onset、velocityのsequenceが一致する。

transport反復時のclip終端は`source clip end + (playheadBeat - raw event beat)`へ平行移動する。resolved onsetがこの値以上ならdropする。no-loop schedulerはswing遅延分をlookbackしてraw eventを選ぶため、隣接half-open windowをまたぐhitを欠落・重複させない。

現行のdrum `Clip.loop`はライブ、WAV、drum MIDIで反復展開しない。MIDI normalized projectionはaudio resolverを通さず、swing / probability / humanize / seed / mute / soloをbakeしない。transport loopの無効boundsは、拍子分母を含むProject曲長から導出した`0..songEnd`へ正規化し、active playback中の切替はProject / historyを変えず新しいrequest generationへ移る。audio resolverはversion tag、保存済みseed、Track / Clip / DrumEvent identity、lane、source step、丸めたunwrapped occurrenceから32-bit `voiceSeed`を導出する。`voiceSeed`はresolved payloadだけの一時値であり、Project codec / SQLite / `.ctsproj.json`へ保存しない。

### 2.4 Transient audio tail / transport end projection

自然テールはProjectへ保存するfieldではなく、Project snapshot、共有resolved-event schedule、AudioContext sample rateから再生ごとに導出する`AudioTailPlan`である。`uncappedTailSeconds`、40秒cap後の`tailSeconds`、start beatからの`totalSeconds`、Master limiterがfade後に保持する`postLimiterTailSeconds`、tailがある場合だけの`fadeStartSeconds / fadeEndSeconds`、`capped`を一時値として持つ。WAVの`frames`と推定bytesもこのplanから導出し、codec / SQLite / `.ctsproj.json`へ書き込まない。

Track別のsource endは可聴resolved eventとAudio Clip sourceから求める。instrumentは`onset + max(note duration, attack + decay) + release + 0.02s`、drumはKick 0.35s、Snare 0.25s、Closed Hat 0.095s、Open Hat 0.37s、Clap 0.144s、Perc 0.28s、Audio Trackはtrim / loop後の可聴region終端を使う。runtimeとplannerはsynth stop pad、drum各subvoice stop、Reverb impulse peak 0.35、Compressor look-ahead 0.006sを同じimmutable timing契約から参照する。enabledなDelay / Reverbは振幅0.001（-60 dB）まで、Filter / 3-stage EQはsample rate別Web Audio biquad poleから36dB headroom付きで解析し、insert順に加算する。source endはrouting DAG順に伝播し、main output / post-fader sendはsource insert後、pre-fader sendはsource insert前を使い、到達Busごとにそのinsert tailを加える。insert Compressorは各6ms、Master limiterは全体へ1回6msを加える。可聴event / Audio Clipがなければeffects / limiterだけからtailを生成しない。

live drainの所有権はProject schemaではなく`PlaybackController`のtransient `active / draining` slotと単調request IDにある。曲末でtransportを即時停止して位置を0へ戻しても、1つのdraining sessionが絶対project-end deadlineまでgraphとMaster post-fader meterを保持できる。Masterの50ms fadeはdeadlineの6ms前に完了し、残りはlimiter look-ahead出力だけを保持する。新play、手動stop、Project activation、context interruptionはdrainを破棄し、古いcallbackはslot identity不一致として無視する。loop wrapはdrainを作らない。

停止中のplay位置は`0 <= positionBeat < projectLengthBeats`の有限値だけを保持し、それ以外を同じtransport更新内で0へ補正する。projectLengthは拍子分母を含むquarter-note beatで求める。このruntime補正はloop bounds、Project、history、revision、save stateへ永続差分を作らない。drum `Clip.loop`の未展開とbrowser / OS / WebView / sample rateが異なるWeb Audio engine間のPCM差は、このtransient契約とは別の既知制約である。同じapp build・engine/version・sample rateの再WAVは固定noise PCMとsample-frame offsetを共有し、全bytes一致を回帰条件にする。

### 2.5 Transient vocal-cut projection

カラオケ作成はProject entityではない。`SourceAudio`はbasename、extension、container、正規sample rate / channel metadata、byte length、browser presentation時間、正規container時間、decoder再同期候補を含むdecode時間・channel上限だけをfile選択中に保持する。decode前後の`VocalCutPlan`はsample rate、frame count、duration、phase別の推定working / output bytes、`VocalCutOptions`はpreset由来の中央軽減率と低域保護cutoffを一時値として持つ。入力は128 MiB以下、presentation / container時間は300秒＋format / sample rate別codec padding以下、decode上限はcontainer＋2秒以下、channel数はexact 2とする。duration tableのないADTS AACでは完全走査したframe列をbrowserの過大なpresentation推定より優先する。decode後に実frame時間が300秒を超える場合は許容codec padding分だけzero-copyで300秒へ切り詰める。mono、多channel、non-finite sample、near-mono、その他の上限超過をPCM出力作成前に拒否する。

処理中のphase / progress / cancellation generation、元音源と結果のobject URL、decode済みAudioBuffer、生成PCM / WAV bytesもdialog所有のtransient stateである。source変更、cancel、dialog終了時に破棄し、Project、history、revision、autosave queue、SQLite、`.ctsproj.json`、tutorial進捗へ投影しない。保存されるのは利用者が明示的にexportした独立PCM 16-bit stereo WAVだけである。

### 2.6 Transient humming transcription

`HummingMelodyNote`は`startSeconds / durationSeconds / midi / confidence`だけを持つ解析候補で、確定前はProject entityではない。file metadata、decode済みPCM、マイク権限・countdown・入力level・録音PCM、8 kHz analysis signal、pitch frames、progress、Abort generation、候補pitch修正 / 除外、target Clip、quantizeもAssistant component所有のtransient stateとする。マイク録音PCMは最大60秒・2 channelで、解析へ渡すまでだけmemory上に保持し、Audio Asset、Project bundle、SQLite、browser storageへ保存しない。

確定時にProjectのcompiled tempo mapでsecondsをclip-local beatへ写し、fresh ID、pitch、startBeat、durationBeats、confidence由来velocityを持つ`NoteEvent`へ変換する。固定tempo Projectもbeat 0だけのmapとして同じ経路を通る。clip終端、event数、MIDI範囲を検査し、対象MIDI Clipのnotesを1回だけ置換する。成功した`NoteEvent`だけが通常のProject / history / autosave / SQLite / `.ctsproj.json`へ保存され、source fileや解析中間値は保存しない。

### 2.6.1 Transient Audio Track recording

Audio Track録音のpermission、countdown、入力level、monitor opt-in、単一Audio Trackの`armedAudioTrackId`、host既定を表す`null`またはopaqueな`preferredMicrophoneInputDeviceId`、`recordingLatencyCompensationMode`、整数`recordingLatencyAdjustmentMs`、開始時Project snapshot / playhead / exact targetを束ねる所有handle、shared AudioContext generation / anchor frame / request、Abort generation、raw Float32 PCM、encode進捗はruntime-onlyであり、Project codec / history / SQLite / `.ctsproj.json`へ保存しない。production境界は単一input、1〜2 channel、最大60秒、dry録音、monitor初期OFFである。Record ArmはTrack fieldではなく1件だけのrenderer stateで、Project切替または対象Audio Track消失時に解除する。入力IDは明示選択時だけ`deviceId: { exact: id }`へ渡し、`null`はhost既定とする。録音中のinput hot switchと複数入力は行わない。fixed-pass cycle captureとbounded Auto Punchは、この通常録音と同じruntime所有・asset-first採用境界を再利用する。

`RecordingLatencyCalibrationProfile`はexact `inputDeviceId / contextGeneration / sampleRate / latencyFrames / confidence`だけを持つrenderer runtime値である。`inputDeviceId`は校正時に`deviceId.exact`へ渡した空でないopaque IDで、`システム既定`を表す`null`はprofileへ採用しない。`contextGeneration`と`sampleRate`は測定に使ったapp-wide AudioContextのidentity、`latencyFrames`は0〜500 ms窓内の非負整数sample数、`confidence`は有限な0〜1とする。通常録音asset、Project entity、history snapshot、revision、autosave、SQLite、Audio Asset、browser storage、`.ctsproj.json`には保存しない。app-lifetimeの`devicechange`またはexact入力の変更ではfuture profileをoperation fence中でも破棄し、Context generationまたはsample rate不一致では適用不可とする。take所有handleは開始時のprofile objectを凍結するため、bind前の破棄はCAS不一致、bind後は現在take不変となる。output identityを安定取得できないため出力device / driver / buffer変更時の再校正は利用者の明示操作に委ねる。通常のcancel / 解析failureは直前のprofile値を保持するが、不一致profileを有効化しない。

capture開始前に同じ所有handleがProject切替 / close token、Audio Track import / recordingのsingle-flight lease、開始時Project snapshot / playheadと`new-track`または`existing-audio-track` targetを同期取得する。既存active playbackは停止し、permissionと3秒countdown後にapp-wide AudioContext上の将来128-frame境界へcaptureと新しい伴奏再生をarmする。`MicrophonePcmCapture`は`contextGeneration / firstContextFrame / endContextFrameExclusive / inputLatencySeconds`を持ち、chunkのabsolute frameとsequenceを連続検査する。capture開始時に未使用のdecoded playback cacheを破棄し、残るactive cacheを含めてcaptureからcanonicalize / persistとcancel後に残るresample workのsettlementまで同じ384 MiB予約を同期resizeして所有する。permission待ちcancel後のlate streamはmicrophone内部tokenが停止・破棄まで所有し、PCM graphを作らない。GC未実施のworklet chunk 1組、連続source PCM、capture runtime overhead、real AudioBuffer copy、optional 48 kHz resample、PCM16 WAV、repository copyのphase peakをallocation前に検査する。高sample-rate / stereoで合算上限を超えるtakeはAudioBuffer作成前に拒否する。canonical WAV bytesとchecksum receiptを保存してからだけ、開始時snapshot / target / exact tokenと共有clockをCASし、可変tempoと選択した推定 / 実測 / 無補正値にmanual offsetを加えたlatencyから`startBeat / sourceStartFrame / sourceFrameCount`を決めて`ReadyAudioAsset`とAudio ClipをUndo 1回で採用する。実測modeはexact一致profileの`latencyFrames`でhost input / base / output / limiter推定全体を置き換える。新規targetではAudio Track / output routeも作り、既存targetではTrack / routingを変えずClipを追記する。permission / device loss / clock不連続 / context世代変更 / cancel / store失敗 / stale snapshot / target消失 / revoked tokenではProjectとhistoryを変更しない。保存済みbytesだけが孤児になる場合は許容し、欠損bytesを参照するmetadataは作らない。

bounded Auto Punchの`punchEnabled / punchInBeat / punchOutBeat / punchPreRollBeats / punchPostRollBeats`はTransportのruntime-only locatorであり、transport loop / cycleのlocatorとは独立する。`playbackStartBeat = max(0, punchInBeat - preRoll)`、`playbackEndBeat = min(Project末尾, punchOutBeat + postRoll)`を開始時に凍結し、`playbackStartBeat <= punchInBeat < punchOutBeat <= playbackEndBeat`とpunch区間0.5〜60秒を要求する。Auto Punchとcycleは同時に開始しない。Auto Punch自体はProject fieldやschema versionを増やさず、Project / history / SQLite / `.ctsproj.json`へlocatorを投影しない。

Auto Punch plannerは開始anchorから可変tempoのbeat境界を累積secondsへ変換し、同じsample rateで整数frameへ丸める。captureは共有clock上のpunch-in exact frameから始まり、正latencyは末尾tailを追加取得して先頭をtrimし、負latencyは先頭へsilenceを加える。どちらも採用Assetの可聴frame数をpunch区間exactにする。再生graphは録音対象Trackの既存再生だけをhalf-open `[punchInBeat, punchOutBeat)`でmuteし、他Trackと対象Trackの区間外audibilityを変えない。これはautomatic input monitoringではなく、monitorは通常録音と同じ明示opt-inを維持する。capture完了と同じclock / context generationによるnatural post-roll完走の両方が揃った時だけfinalizeし、到着順、duplicate / late callbackに依存しない。手動停止、cancel、transport中断はpost-roll完走の代用にならない。

採用はpure domain mutationの3形だけを許す。windowが空ならexact punch範囲の新しい非loop Audio Clipを作る。exactに1件のready・非loop Audio Clipがpunch window全体を覆う場合は、外側のsource materialを左右Clipとして保持し、window内の旧sourceを第1take、録音Assetを第2takeにしたexact windowのfolderを作り、第2take全体をcompへ採用する。既存folderが同じTrack・同じexact windowに1件だけある場合は録音takeを追記し、その全rangeをcompへ採用する。部分overlap、複数overlap、windowをまたぐ別folder、loop / unresolved source、source coverage不足は既存素材を変更せず拒否する。

canonical Asset bytesとreceiptを先に保存し、fresh IDを含むdomain候補を作った後、Storeは同じ入力とexact IDでpure mutationを再実行してcanonical JSONの一致を確認する。開始時Project snapshotとoperationへのstrict CASを通った成功だけがProject / selection / historyを1回変更し、Undo 1回でfolder / take / Clip / Asset metadataをまとめて戻す。permission / device / context / clock / target gate / planner / canonicalize / store / replay / CASの失敗、capture完了だけ、post-roll完了だけ、cancel / unmountではProject・historyをatomicに保持する。asset-first保存後の失敗でorphan bytesは残り得るが、欠損または未採用bytesを指すmetadataは作らない。Quick Punch、automatic input monitoring、cycleとの併用、disk streaming、arbitrary overlaps、input hot switch、multi-input、MIDI comp、named comps、flatten / bounceはこの境界に含めない。

### 2.6.2 Automation lane編集、Read gate、runtime write pass（schema v3 / v6 / v7 / v8）

Automationの永続正本は`Project.automationLanes`とschema v8の`Project.automationReadState`である。schema v6は各laneへ必須`bypassed`、schema v7はGlobal / Track Read gateを加え、schema v8は最初のeffective Masterのoutput volumeとRead IDを許容する。non-Master Trackはvolumeとpan、effective Masterはvolumeだけをtargetごとに最大1 lane持つ。最初のpoint追加で`bypassed: false`のlaneを遅延作成し、最後のpoint削除または全消去では空laneをProjectから除去する。

- volume pointの`value`は0〜2、pan pointは-1〜1、`beat`は0〜`Project.lengthBeats`で有限値にする。同一laneのbeatは重複させず、保存時は厳密な昇順にする
- pointの`interpolation`はそのpointから次のpointへのoutbound semanticsである。`hold`は次のpoint直前まで現在値を保持し、`linear`はbeat domainで次の値へ直線補間する。最初のpoint前はTrack scalar、最後のpoint後は最終値を使う
- Editorのbeat snapと選択point、local draft、hover / focus、statusはruntime-onlyで、Project / SQLite / `.ctsproj.json`へ保存しない
- lane / point IDはProject全entityに対して一意に発行し、既存point更新ではidentityを保つ。add / update / remove / clearの候補はsourceとcandidateのcanonical validationを通過した場合だけ採用する
- lane単位のRead / Bypassは`bypassed`だけを変更し、point / target / ID / Track scalarを保持する。同値切替は同じProject参照を返すsemantic no-opである。Bypass中のpoint編集も`bypassed`を保持する
- 1 gestureの確定は1 Project snapshot、Undo 1回、save revision 1回である。semantic no-opとstale / invalid候補は元Project参照、history、revisionを変えない
- lane編集またはRead / Bypass切替はactive playbackのimmutable session snapshotを停止し、accepted切替は残存natural drainも破棄する。その停止状態と保持playheadは永続fieldではない。再生時とoffline WAVは保存済みlaneを同じtempo / loop-aware resolverへ入力し、`bypassed: true`ならcommandを生成しない
- Global / TrackまたはMaster Readのpure mutationはlane / pointを保持し、同値は元Project参照を返す。Track削除はdisabled IDを除去し、複製Trackは常にRead enabledで開始する。各採用は1 CAS / 1 Undo / 1 save revisionでactive snapshotを1回停止する
- `AutomationWriteMode = read | touch | latch | write`、Track別mode map、Armed / Writing、touching target、playback request / activation ownershipはrenderer runtime-onlyである。Project、history、revision、SQLite、`.ctsproj.json`、OpenAPIへ投影せず、Project activation / 再読込時は全TrackをReadへ戻す
- runtime `AutomationPass`は開始時Projectのexact参照、canonical fingerprint、deep-frozen snapshot、開始beat、全対応Trackのmode、target別sample / regionをimmutableに所有する。Readだけの再生はpassを作らない。Touchは接触区間とtempo-awareな100 ms return、Latchは最初の接触からhalf-open punch-out、Writeはpass開始からnon-Masterのvolume / pan、effective Masterのvolumeを開始時scalarでcaptureする
- raw sampleは同beatの最新値へ正規化し、volume 0.001 / pan 0.0005以内の最大再構成誤差で決定的にpoint削減する。置換範囲外のpoint object / ID、lane ID、`bypassed`、Global / Track Readを保持し、必要な境界だけfresh global IDで作る。20,000 point / lane、2,048 laneとcandidate全体のcodecを越える場合はProjectを変更しない
- punch-outは終了beatを曲内へclampし、開始時source参照 / fingerprintへのCASが一致した時だけ確定laneをProject変更・Undo・save revision各1回で採用する。開始時Readだった別Trackのvolume / pan scalarだけはexact rebaseを許し、passのfrozen curve / scalar判断を変えない。他の並行変更、stale ownership、resource / ID / codec failureは部分pointを公開しない。成功または明示cancelはruntimeのWrite modeを同じtransaction内でTouchへ戻す
- 保存・再読込するのは確定したAutomationLane、lane Bypass、Global / TrackまたはMaster Readだけであり、記録時modeはlive / WAV resolverの入力ではない。Master pan、later Master、insert / send / tempo automation、MIDI CC / LFO、Trim / Relative / Cross-Over / Fill、parameter group単位のSuspend、複数loop pass管理のstateは未定義である

### 2.6.3 Tempo / 拍子map編集（schema v4）

production Editorが変更する正本は既存の`Project.tempoMap`と`Project.timeSignatureMap`であり、schema versionとentity型を増やさない。両mapはbeat 0 anchorをexact 1件持ち、IDを保った厳密昇順event列である。

- production Editorが新規追加または移動先として確定するtempo eventは有限な`0 <= beat < lengthBeats`と20〜300 BPMを持つ。拍子eventは分子1〜32、分母2 / 4 / 8 / 16を持ち、先行segmentから見た小節境界の`0 <= beat < lengthBeats`に置く
- canonical schema v4が許容する既存の`beat === lengthBeats` eventは互換入力として保持する。終端eventは同じbeatでの値更新 / no-op、曲内への移動、削除だけを許し、新規追加と曲内eventの終端への移動は拒否する。終端exactの拍子eventが表す最終segmentは長さ0であり、`lengthBars`へ加算しない
- beat 0 anchorは移動・削除できないが値は更新できる。先頭tempo / 拍子変更時は`bpm` / `timeSignature` mirrorを同じ候補で更新し、全拍子変更時は`lengthBeats`を変えずに実小節数`lengthBars`を再導出する
- 拍子候補は後続eventとProject終端も小節境界に保たなければならない。同beat衝突、曲外、上限、global ID衝突、invalid source / candidateを採用しない
- add / update / move / deleteはimmutableなtyped resultで、semantic no-opとfailureは元Project参照を返す。成功だけが1 history snapshot / save revisionとなる
- 選択event、Inspector draft、focus、timeline scroll、playback停止通知はruntime-onlyでProject / SQLite / `.ctsproj.json`へ保存しない
- live / WAV / MIDI / metronome / 各timelineは保存済みmapを同じcompiled musical-time indexへ入力する。連続tempo ramp、audio follow、tempo automationの永続stateは未定義である

### 2.6.4 Audio take / comp編集（schema v5）

`Project.audioTakeFolders`は既存のAudio Clipを同一Track・同一timeline windowの代替takeへまとめた非破壊編集正本である。group時に元ClipはTrackから除去するが、各takeは同じready AudioAssetとimmutableなsource frame window / fade / gainを保持し、asset bytesを書き換えない。

- folderは既存Audio Trackを参照し、曲内の`startBeat / lengthBeats`、0〜50 msの`crossfadeMs`、2〜128 take、1〜4,096 comp segmentを持つ。Project全体では最大1,024 folderとし、同じAudio Track・`startBeat / lengthBeats` windowには1 folderだけを許す
- takeはfolder-localな`offsetBeats / lengthBeats`を持ち、ready assetの正のframe range、非負fade、-96〜+24 dB gainを保持する。comp segmentは同じfolder内のtakeを参照し、そのtakeが覆うhalf-open範囲だけを選べる
- `compSegments`はoffset 0からfolder末尾まで厳密昇順・gapless・非overlapでexact coverする。隣接して同じtakeを選ぶsegmentは保存前にmergeし、dangling take、source overflow、未解決assetを拒否する
- groupは同一Audio Track、同一start / length、非loop、ready asset、可変tempo上で1 frame以内に必要sourceを覆うClipを2件以上要求する。先頭takeを全rangeの初期compにし、後から一致Clipをtakeへ追加しても現在のcompを変えない
- range paint、境界移動、未使用take削除はimmutable candidateをcanonical codecで検証し、採用された1 gestureだけをProject snapshot / Undo / save revision各1回にする。pointer preview、選択take / folder、focus、draftはruntime-onlyである
- Track削除は所有folderをcascade除去し、Track複製はfolder / take / segmentへfresh IDを発行してassetを共有する。AudioAsset GCはAudio Clipだけでなく全take参照もrootとして数える
- liveとoffline WAVはfolderを一時的なAudio regionへ正規化して既存Audio Clip plannerへ渡す。選択takeだけを鳴らし、spliceは`crossfadeMs`を境界中心に半分ずつ延長したlinear overlap、persist済みtake fadeはslice長へ再正規化せずtake-local時間のままtruncateする
- MIDI exportはtake audioを出力しないが、壊れたv5 aggregateを無視せず独立validationで`invalid-project`として拒否する
- fixed-pass Audio cycleとbounded Auto Punchのexact-window folder生成はv5で導入されcurrent schema v10へ継承された同じtake aggregateを使う。Quick Punch、automatic input monitoring、cycleとの併用、disk streaming、arbitrary overlaps、MIDI comping、multi-input、named comps、flatten / bounceはschema / UIの対応済み範囲に含めない

### 2.6.5 Audio Clip timing / monophonic pitch編集（schema v10）

`AudioClip.audioWarp`はimmutableなAudioAsset binaryへ作用する非破壊metadataで、未編集Clipでは省略できる。保存されるのはalgorithm、`formantMode`、timing / pitchの有効状態、timing marker、確定pitch regionだけである。解析候補、解析waveform / pitch frame、selection、zoom、cursor、pointer preview、focus、Worker generation、派生PCM cache、補正前 / 補正後のA/Bはruntime-onlyで、Project / history / revision / SQLite / `.ctsproj.json`へ保存しない。

- `algorithm`は現在`wsola-v1`だけを受理する。`audioWarp`はreadyなcanonical 48 kHz mono/stereo PCM16 WAVを参照する非loop Audio Clipだけが持て、対象source windowは60秒以下とする。MIDI / drum / automation Clip、linked Clip、unresolved asset、loop Clip、AudioTakeFolderのtakeには保存しない
- `markers`は2〜128件で、`sourceFrame`と`targetBeatOffset`をそれぞれ厳密昇順にする。先頭はClipの`sourceStartFrame` / 0 beat、末尾はsource window終端 / `lengthBeats`にexact一致する。隣接source / target区間は40 ms以上、tempo mapで求めたtarget秒数 ÷ source秒数は0.5〜2の範囲とする
- `pitchRegions`は0〜128件で、source window内をsource frame昇順・非重複にする。`sourcePitchCents` / `targetPitchCents`は0〜12,700、`correctionAmount`は0〜1で、`(target - source) × amount`の実効shiftを±300 cent以内にする。`transitionFrames`は非負safe integerでregion長の半分以下とする
- timing / pitchの各enabled flagがfalseでもmarker / regionは保持する。`formantMode`は`off | preserve`の保存済み値で、Undo / Redoとreload後も保持し、canonical request / cache key / live / WAVへ反映する。pitch A/Bは永続flagやformantModeを変更せずlive用snapshotだけで`pitchEnabled: false`にする。WAVは常に保存済みflagを使う
- left / right trimは残るsource windowへmarker / regionをcropし、始終点をexactに作り直す。splitは左右へpartitionして両Clipのsource frame / target beatをrebaseする。audioWarp付きClipのloop化、take folder化、Auto Punchのspanning Clip変換はmetadataの意味を保てないため候補をatomicに拒否する
- accepted editはAudio Clipの`audioWarp`だけを含むcandidate全体をcanonical codecで検証し、1 gesture = 1 Project change / 1 Undo / 1 save revisionとする。解析だけ、semantic no-op、invalid / busy / staleではProject参照と履歴を変えない
- live、全体WAV、選択Track WAVは保存済みmetadataとAudioAsset checksumから同じversioned派生PCM requestを作る。派生PCMは永続正本ではなく再生成可能なcontent-addressed cacheである
- manual formant editing、vibrato editing、polyphonic pitch、take folder / loop-cycle warp、phase-coherent multitrack stretch、audio quantize / groove extraction、audio follow / Smart Tempoのfieldはcurrent schema v10に定義しない。off / preserveの実声品質、unsupported rate、極端なpitch shiftは別品質gateでありschema fieldではない

### 2.7 Track管理とpreset（schema v4）

- productionで新規生成するTrackはinstrument / drum / bus、またはimport済みassetを持つaudioで、roleは`general`とする。instrument / drumは開始0・長さ`Project.lengthBeats`の空MIDI / Drum Clipを1つ、audioはcanonical asset全rangeのAudio Clipを1つ持つ。BusはClip / instrumentを持たない。先頭Masterがあればその直前、Masterがないlegacy Projectでは末尾へ置き、全新規TrackへMaster直結outputを同じtransactionで作る
- Track複製はTrack、全Clip、正本が所有する全Note / DrumEvent、全EffectのIDを新規発行する。同じ複製元Track内の旧Clip ID→新Clip ID mapを作ってから`aliasOf`を張り替え、複製元IDへの参照を残さない。main outputとsource所有sendも複製し、send IDはProject全体でfreshにするが、複製元Busへのincoming routeは複製しない。payloadとparameterは値として複製し、identityだけを分離する
- Track削除は自身のmain outputとsource / targetいずれかが自身であるsendを同じtransactionで除去する。Bus削除では、そのBusをmain outputとしていた生存TrackだけをMaster直結へ戻し、cycleやdangling routeを途中状態として公開しない
- production synth selectorが新規保存するpreset keyは`softPad` / `brightPluck` / `warmBass` / `brightLead`の4つである。旧`pad` / `bass` / `lead`系aliasは互換入力として保持できるが、UI表示のcanonical解決だけではProject bytesを変えない
- schema v4では`Track.role`が教材 / 伴奏のsemantic source of truthである。名前はroleと独立して変更でき、一般Trackが`Chords` / `Bass` / `Melody`を名乗っても学習roleにはならない。学習role Trackの削除はdomain境界で保護し、複製先はroleを`general`へ落として重複roleを作らない
- 学習roleの再割当は新ownerへの設定と旧ownerの`general`化を同じProject transactionで行い、roleが変えるrealized harmonyのroutingを古い再生snapshotへ残さないためactive playbackを停止する
- Master TrackはTrack管理mutationの対象外とする。既存の「複数Masterでは配列先頭だけが音声上有効」という互換契約は維持し、Batch 3の操作でMaster identity、数、相対順を変更しない
- 候補Projectは128 Track上限を含む既存codec / validationを全体で通過した時だけ採用する。拒否時はProject、history、revision、autosave、selectionを一切変更せず、採用時は1 commandをUndo 1回へ対応させる。runtimeの選択、dialog draft、playback sessionはschemaへ保存しない

### 2.8 Audio Asset / Audio Clip（Batch 5）

Projectが保存する`ReadyAudioAsset`はcontent identityとdecode前metadataであり、file path、Blob、AudioBuffer、object URL、repository kindを持たない。schemaの互換範囲はWAV / MPEG / MP4 / AAC、8〜384 kHz、1〜32 channelである。一方、production importerが新規生成するready assetは常に次のcanonical subsetに正規化する。

- `mediaType = audio/wav`
- `sampleRate = 48000`
- `channelCount = 1 | 2`
- RIFF/WAVE PCM 16-bit little-endian
- `byteLength <= 128 MiB`
- `checksumSha256`はcanonical WAV全bytesのlowercase SHA-256

source inputも128 MiB以下とし、decode用Float32 PCM見積りを256 MiB以下に制限する。descriptor未確定時のsource inspectは`2 × source + retained decoded cache`、import resource planはdecode `2 × source + decoded`、canonicalize `source + decoded + optional resample + WAV`、persist `source + decoded + 8 × WAV`の各phase peakを384 MiB以下に制限する。native pickerは最大response envelopeとprospective Blobを`openAudio`前から予約し、実envelopeをimport完了まで追加保持する。cancel後も実decode / resample jobがsettleするまでapp-wide import leaseを保持する。正規化後bytesはWebではIndexedDB、nativeでは`audio-assets-v1/sha256/<checksum>`へ保存する。複数のAudioAsset metadataやClipが同じchecksumを持てるため、binary objectはdeduplicateされてもProject entity IDは独立である。

Audio Clipは`aliasOf`を持たず、`audioAssetId`、`sourceStartFrame`、`sourceFrameCount`、`fadeInFrames`、`fadeOutFrames`、`gainDb`を全て必須とする。ready assetではsource rangeをasset内の正のhalf-open frame区間、fadeを非負safe integerかつ合計をsource range以下、gainを-96〜+24 dBにする。unresolved assetではsource / fade frame fieldを全て0にし、migration evidenceを保持する。

編集はProject fieldだけを書き換える非破壊操作であり、asset bytesを変更しない。

- move: `startBeat`だけを移動する
- non-loop left / right trim: tempo map上の経過秒をasset sample rateのframeへ写し、timeline windowとsource rangeをrate 1.0で同期する
- loop right trim: `sourceFrameCount`を変えず外側の`lengthBeats`だけを変える
- gain / fade: `gainDb`とframe fieldだけを更新する
- split: non-loop source rangeを2つの独立Clipへ分け、元の外側fadeだけを残す
- duplicate: fresh Clip IDで同じimmutable assetと編集値を共有する独立コピーにする
- delete: Clipを除去し、残るAudio Clipから参照されないAudioAsset metadataも同じProject snapshotから除く。Undoは直前snapshotのmetadataを復元し、binary objectの回収可否はretained generationを含むrepository GCが判定する

新規作成、move、right trim、duplicateでclip終端が曲末を越える場合は、その終端位置で有効な拍子mapを使って次の小節境界まで`Project.lengthBeats`と互換mirrorを同じcommand内で延長する。最大256小節かつ8,192拍を越える候補は、Project / history / selectionを変えずatomicに拒否する。

`loop=true`はsource rangeを外側timeline windowまで反復する。現在のschemaにはloop phase fieldがないため、loop中left trim / splitはdomain errorにし、bytesや暗黙phaseを推測しない。shared live/offline plannerがseek、transport loop、variable tempo、fade位相を一時sliceへ解決し、このsliceはProjectへ保存しない。

binaryの存在・checksum診断もruntime stateである。`audioAssetIssues[id] = missing | changed | unavailable`はUIと再生preflightで使うが、`ReadyAudioAsset.availability`を自動変更しない。`.ctsproj.json`は上記metadataだけをexact roundtripしbinaryを同梱しない。binaryを持ち運ぶ明示操作だけが`.ctsbundle`を生成し、current schema Projectと全ready objectを検証済みcopyとして同梱する。

## 3. SQLite v2スキーマ

SQLiteは編集用domain modelを別表へ再解釈せず、`project-model` codecのcanonical JSONをimmutable aggregate snapshotとして保存する。これによりWeb/nativeで同じschema migration・validationを使い、track/clip表とJSON codecの二重正本を作らない。

主要table:

- `project_generations`: save/delete operation、親head version、activation/revision、canonical JSON bytes、payload/record checksum、明示branch sourceを保持するSTRICT table。
- `project_heads`: projectごとの唯一のcommitted generation pointer。head checksumとdeleted flagを持つ。
- `project_crash_drafts`: 通常保存のdebounce前に保護するcanonical JSON。`(project_id, activation_id)`ごとに最新revisionを1件だけ保持し、stable write ID、base head、predecessor、payload/record checksumを持つSTRICT table。
- `legacy_migration_snapshots` / `legacy_migration_records`: 旧localStorageのsorted exact key/value backup。
- `legacy_project_staging`: migration versionごとのhead/branch/diagnostic候補。UIから即公開しない。
- `legacy_migration_runs`: staging集合を単一transactionで適用した完了marker。

不変条件:

- `PRAGMA application_id = 0x43545331`（CTS1）、`user_version = 2`。既存v1 databaseは`0002_crash_drafts.sql`で前進migrationする。
- WAL、`synchronous=FULL`、`foreign_keys=ON`、`trusted_schema=OFF`、5秒busy timeout。
- 通常save/removeは`BEGIN IMMEDIATE`でexpected headをCASし、stable write/delete IDで冪等化する。
- crash draftも`BEGIN IMMEDIATE`でcommitし、同じactivationではrevisionを後退させない。同revisionでwrite ID、base head、predecessor、payloadまで一致するexact logical requestの再試行だけが冪等成功する。同revisionのcausal metadata/payload違いと古いrevisionはconflictである。全体を64件/64 MiB以内に制限する。
- canonical saveは同activationのcommit済みrevision以下だけを消す。同時にstageされた次revisionは消さない。削除tombstone、project remove、端末全消去は該当するdraftを再出現させない。
- canonical historyはheadを含め最低3世代。明示branchは別countで、通常saveの保持数を水増ししない。
- checksum済みdeleted headはpointed tombstone payloadが壊れてもstickyで、古いsaveを復活させない。
- migrationはraw backup、candidate provenance検証、source再capture、atomic applyの順。completed migration versionが無いstagingはcanonical/listへ見せない。

Lesson/progressはProject aggregate外である。AudioAsset metadataはcanonical Project JSON、実binaryはapp dataのcontent-addressed repositoryに分離する。canonical save / crash draftは全ready objectの実length / SHA-256をSQLite transaction前に検証する。起動時はvalid stagingをroll forwardした後、全retained generation / branch / crash draftをreachability rootにしてorphanをGCする。future / corrupt payloadがあれば削除を止めるため、current headだけを見て過去世代用objectを消さない。

### 3.1 プロジェクト削除と端末全消去

通常のプロジェクト削除は、削除tombstoneを新しいgenerationとしてcommitする**論理削除**である。古いgenerationをbest effortで整理しても、次のデータまで単一project IDから安全に物理削除できるとは限らない。

- 旧localStorageのexact migration snapshotは、複数project・診断・互換性未知recordを1つのchecksum付き集合として保存する。
- recovery branchや中断generationは、別activationの編集を失わないためcanonical headと独立して保持する。
- SQLiteのWAL/SHMなどはdatabase全体のtransaction補助ファイルで、特定projectだけの所有物ではない。

exact snapshotから特定projectらしいbytesだけを抜くと、snapshot checksumと将来decoderでの再評価可能性を壊し、未知recordを誤って消すおそれがある。このため「プロジェクトを削除」は保存一覧からの削除であり、archiveを含む物理消去とは表示しない。

デスクトップ版の「この端末のデータをすべて消去」はproject単位のpurgeではなく、Compose Tutor Studioが管理するapp data全体を境界にする。project database本体・WAL/SHM/journalを含むdatabase family、exact migration archive、全generation/branch/diagnostic、`audio-assets-v1`のobject / staging、rendererの緊急復旧・tutorial/onboarding・WebView storage/cacheを一括処理する。外部へ書き出したproject/MIDI/WAVはapp dataの外なので対象外である。

## 4. バージョニング

- `schema_version` を必ず持つ
- 破壊的変更は migration を書く
- Lesson DSL も `lesson_schema_version` を持つ
- Export時に `app_version` と `created_with` を記録する

## 5. Validationルール

| 対象 | ルール |
|---|---|
| bpm | 20〜300 |
| time signature | 分母は 2/4/8/16 のいずれか |
| time signature numerator | 1〜32 |
| musical-time正本 | `lengthBeats`は正かつ8192拍以下で小節境界。tempo / 拍子mapはbeat 0必須、ID一意、beat昇順、曲内。拍子変更は小節境界 |
| legacy mirrors | `bpm` / `timeSignature`は各map先頭、`lengthBars`は拍子mapから算出した実小節数と一致 |
| project length | 1〜256小節、かつ`lengthBeats`の正本と一致 |
| tracks | 128以下 |
| production Track追加 | instrument / drumは全曲長の対応Clip、audioはready asset全rangeのAudio Clip、BusはClipなしで先頭Master直前へ挿入。全non-Masterへexact 1件のoutputを作る |
| audio routing | output/send合計1,024 edge以下、sourceごとsend 16件以下、send gain 0..2、targetは既存Bus。全edgeでDAG、send IDはProject全体で一意 |
| Track role | `role`必須で各学習roleは一意。改名は名前に依存せず許可し、学習role Trackの削除を保護。複製先は`general` |
| synth preset command | softPad / brightPluck / warmBass / brightLead |
| clips | 1トラックあたり1,024以下 |
| audioAssets | Project全体で4,096以下 |
| ready AudioAsset | SHA-256はlowercase hex 64桁。対応media typeと正のbyte/sample/channel/frame metadataを持つ。production importは48 kHz / 1〜2ch PCM16 WAV、128 MiB以下 |
| unresolved AudioAsset | `legacy-reference` / `missing-reference`だけ。参照Clipのsource range / fadeは0 |
| ready Audio Clip | audio Track上でasset参照、frame rangeがasset内、fade合計がrange以下、gain -96〜+24 dB。loop中left trim / splitは禁止 |
| Audio Clip audioWarp | ready canonical 48 kHz mono/stereo PCM16、非loop、60秒以下。marker 2〜128、始終点exact、source / target厳密昇順、隣接40 ms以上、0.5〜2倍。pitch region 0〜128、source window内・非重複、pitch 0〜12,700 cents、補正量0〜1、実効shift ±300 cents、transitionはregion半分以下 |
| Audio take folder | Project全体1,024以下、folderごとtake 2〜128・comp segment 1〜4,096。同じAudio Track / startBeat / lengthBeats windowは1 folderだけ。Audio Track / ready asset参照、source frame範囲、folder内take範囲、0〜50 ms crossfade、gapless exact-cover comp、隣接同take禁止 |
| automation | Project全体で2,048 lane以下、1 laneあたり20,000 point以下。targetはnon-Master Trackのvolume/panまたは最初のeffective Masterのvolumeでtargetごとに最大1 lane。Master panとlater Masterは拒否。point ID一意、beat厳密昇順・0〜曲末、volume valueは0〜2、pan valueは-1〜1、補間はoutboundのhold/linear |
| note/drum events | 1クリップあたり20,000以下 |
| drum resolution | 1〜128 steps/bar |
| drum swing / probability | 0.0〜1.0 |
| drum humanize velocity | 整数0〜127 |
| drum groove seed | 正のsafe integer |
| pitch | 0〜127 |
| velocity | 1〜127 |
| pan | -1.0〜1.0 |
| volume | 0.0〜2.0 |
| chord duration | 0より大きい |
| clip start | 0以上 |

## 6. Theory Engine入出力

### chord analyze

Input:

```json
{ "symbol": "G7", "key": "C", "scale": "major" }
```

Output:

```json
{
  "symbol": "G7",
  "root": "G",
  "quality": "dominant7",
  "notes": ["G", "B", "D", "F"],
  "degree": "V7",
  "function": "D",
  "explanation": "CメジャーではG7はV7で、Cへ解決しやすいドミナントです。"
}
```

### melody analysis

Input:

```json
{
  "key": "C",
  "scale": "major",
  "chords": [{"symbol": "C", "startBeat": 0, "durationBeats": 4}],
  "notes": [{"pitch": 64, "startBeat": 0, "durationBeats": 1}]
}
```

Output:

```json
{
  "score": 0.82,
  "findings": [
    {"type": "chord_tone", "severity": "info", "message": "1拍目のEはCコードの3度で安定します。"}
  ]
}
```
