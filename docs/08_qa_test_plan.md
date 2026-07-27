# 08. QA・テスト計画

## 1. テスト方針

音楽アプリは、一般的なUIバグに加えて、音楽理論・タイミング・保存互換性・音声出力の検証が必要です。

| 領域 | テスト種別 | 目的 |
|---|---|---|
| theory-engine | unit | コード/スケール/度数判定の正確性 |
| tutorial-engine | unit/integration | レッスン判定の再現性 |
| project-model | unit/migration | schema v4の保存/読み込み、v1→v2→v3→v4移行、time map、role、AudioAsset / Automation / routing metadataの安全性 |
| UI | component/e2e | 主要操作フロー |
| audio | integration/golden | 再生イベント、レンダー結果 |
| audio-assets | unit/integration/e2e | canonical 48 kHz PCM16、content-addressed保存、staging recovery / GC、欠落診断、Audio Clip live/WAV parity |
| vocal-cut | unit/integration/e2e | container検証、中央軽減DSP、cancel、A/B試聴、WAV出力、Project分離 |
| track-management | unit/component/e2e | ID再発行、alias remap、Master / learning role削除保護、名前とroleの独立、atomic拒否、Undo / autosave / selection / playback |
| midi-io | unit/integration | Format 0 / 1 import、Format 1 export、lossy境界、攻撃的fileの上限制御 |
| export | integration | MIDI/WAVの独立playerでの読み出し可能性 |

## 2. Theory Engine テスト例

```ts
describe('analyzeChord', () => {
  it('analyzes G7 in C major as V7 dominant', () => {
    const result = analyzeChord({ symbol: 'G7', key: 'C', scale: 'major' });
    expect(result.degree).toBe('V7');
    expect(result.function).toBe('D');
    expect(result.notes).toEqual(['G', 'B', 'D', 'F']);
  });
});
```

## 3. Tutorial Engine テスト例

```ts
it('completes I-V-vi-IV lesson when user places C-G-Am-F in C major', () => {
  const lesson = loadLesson('course2_lesson4');
  const engine = createTutorialEngine(lesson);
  engine.dispatch(chordAdded('C', 0));
  engine.dispatch(chordAdded('G', 4));
  engine.dispatch(chordAdded('Am', 8));
  engine.dispatch(chordAdded('F', 12));
  expect(engine.currentStep.status).toBe('completed');
});
```

## 4. E2Eシナリオ

### E2E-001: 最初の1曲

1. アプリ起動
2. テンプレート「8小節BGM」選択
3. 再生
4. コード進行追加
5. ドラムパターン追加
6. ベース生成
7. メロディ入力
8. 保存
9. 再起動
10. 読み込み
11. MIDI export
12. WAV export

期待結果:

- エラーなし
- 書き出しファイルが存在
- プロジェクトのノート/コード数が保存前後で一致

### E2E-002: カラオケ用音源を作る

1. Top Barから「カラオケ」を開く
2. 中央1 kHzと左右差2 kHzを持つ短い合成stereo WAVを選ぶ
3. 「標準」で作成し、元音源 / カラオケをA/B試聴する
4. PCM 16-bit WAVを保存する

期待結果:

- 中央1 kHzが十分に減衰し、左右差2 kHzが維持される
- outputがRIFF / stereo PCM 16-bitとして独立parserで読める
- source名由来の`_karaoke.wav`で保存され、Project / history / save状態は変化しない
- near-mono fixtureは出力とdownloadを作らず、理由を表示する

### E2E-003: Trackを追加・整理して音色を保存する

1. 停止中に楽器Trackを追加し、`brightPluck`を選ぶ
2. 新Trackを改名し、複製、上下移動、削除、Undo / Redoを行う
3. drum Trackとstereo Busを追加し、楽器TrackからBusへのsendを作る
4. Projectを保存して再読込し、再生中に送り量と有効状態を変更する
5. send位置をpost-faderからpre-faderへ変更し、もう一度再生する

期待結果:

- instrument / drumは全曲長の対応Clipを1つ持ち、BusはClip / instrumentを持たず、いずれも先頭Master直前へ追加される。追加・複製後の新Track / Clipが選択される
- Audioはlocal Asset importから、Busは空のstereo returnとして作成でき、全新規non-MasterへMaster直結outputが同じ変更で作られる
- send gain / enabledは再生を継続したまま平滑更新され、target / position / add / removeはplayheadを保持して再生を停止する。保存・再読込・Undo / Redo後もmain outputとsendが一致する
- 複製したTrack / Clip / Note / DrumEvent / EffectのIDは元と重ならず、Track内aliasは複製先Clipを参照する
- Masterは変更対象にならない。学習role Trackも改名できてroleは変わらず、削除commandだけを理由付きでatomicに拒否する。一般TrackはChords / Bass / Melodyという名前でも学習roleにならず、改名・削除をUndo 1回で戻せる
- 採用された構造 / preset変更は再生を停止してplayheadを保持し、次の再生、保存後の再読込、WAVで同じ音色と構成を使う
- 削除後、Undo / Redo後、再読込後のselectionは存在するTrack / Clipだけを参照する

## 5. 音声テスト

| テスト | 内容 |
|---|---|
| scheduler drift | 120 BPMで小節境界が期待値からズレないか |
| note on/off | note duration通りにoffされるか |
| drum Project isolation | 保存済みgrooveを持つProjectをDrum Editor未表示のまま再生しても、選択clipや以前のprojectのUI状態に依存せずprobability / swing / humanize / seedが効くか |
| drum live/WAV parity | 異なる`stepsPerBar`、groove、event probability、seedを持つ複数clip / Trackで、ライブとWAVのhit数・onset・velocityが一致するか |
| clip-local swing | 非0またはoff-gridのclip startでもsource step 0はstraight、source step 1はswingし、project絶対gridのparityへ反転・無効化されないか |
| drum deterministic occurrence | identityが異なる同時hitは乱数系列を共有せず、同じseed / identity / unwrapped playhead sequenceでは同じ結果になり、transport pass間では決定的に変化し得るか |
| drum deterministic source | 固定seed noise PCMが同じsample rateで完全一致し、resolved `voiceSeed`とsubvoice saltがboundedな整数sample-frame offsetを再現するか。`Math.random`をthrowしても全laneを生成でき、clap各burstが独立するか |
| drum clip-end drop | partial clip途中とproject末尾の両方で、nominalには有効な最終stepがswing後にtranslated clip end以上ならライブ / WAVともdropするか |
| scheduler indexed swing | raw beatが直前windowでもswing後onsetが現windowなら1回だけ発火し、実効onset indexの範囲外eventへfull resolverを実行しないか。小数loopの初回・late cycle境界も欠落しないか |
| loop-expanded density | 0.25拍loop・0.75拍windowで同時85件→255件を受理し、86件→258件をper-track Web Audio graph生成前の型付き失敗にするか。clip終端外へswingした恒久drop hitは数えないか |
| delayed scheduler recovery | timerを複数拍ぶん飛ばしても過去のnote / loop pass / metronome clickをburst再演せず、現在playhead以後のlookaheadだけを発火するか。曲末超過ではmissed noteなしで`onEnd`が1回だけか |
| transport loop fallback | 初回0..0を全曲boundsへ直し、6/8を含む曲長・song end位置を安全に扱うか。starting / playing中のtoggleは旧sessionを破棄して新generationを開始し、停止中は再生を始めずProject / historyも変えないか |
| play at / beyond end | 曲末と同じ位置、曲末超過、負値、非有限位置を同じstore更新で0へ巻き戻して新generationを開始するか。6/8の曲長判定、valid位置保持、loop bounds / Project / history / save不変、失敗後の再試行も確認する |
| source tail model | instrumentのnote duration対attack+decay、release、0.02s oscillator padと、6 drum laneの0.35 / 0.25 / 0.095 / 0.37 / 0.144 / 0.28秒が共有`voiceTiming`からruntime / plannerへ一致して導出されるか。Reverb peak 0.35も共有し、可聴eventなしではtail 0か |
| source graph cleanup | Synthは全oscillatorの`ended`後、Drumは各subvoiceの`ended`後にsource / layer gain / filter / gainをexactly onceでdisconnectするか。停止・中断・WAV成功/失敗ではmanagerが同期disposeし、共有Track output / noise buffer / Masterを切らず、stale callback / triggerもnodeを再生成・再解放しないか |
| voice scheduling failure | source/layer/filter/gainの各allocation・connect・start・stop失敗で部分graphと同じcompound hitの先行branchを全rollbackするか。初回failureはstart失敗、interval中はscheduler停止→session中断を各1回だけ行い、同じdue batchを再試行しないか。voice stealは予約済みADSR値をholdして早いstopを遅らせないか |
| effect tail threshold | Delayの最後のwet echoとReverbのsquared impulse envelopeを振幅0.001（-60 dB）まで含めるか。exact thresholdの浮動小数点境界は含み、直下、disabled、wet 0は含めないか。Filter/EQは共有runtime係数のpole半径からsample rate別に-60dB到達frameを保守的に求めるか |
| bounded tail / WAV preflight | Filter/EQ/Delay/Reverb/Compressorのsequential insertsとMaster limiterを加算し、limiter込み40秒cap、limiter前50ms fade、fade後6ms保持を適用するか。動的frames / 推定bytesをallocation前に計算し、5分body + 40秒tailを192 MiB未満で受理するか |
| live natural drain | non-loop曲末でtransport / metronome / position更新を即時停止・位置0にしながら、graphとpost-fader Master meterを絶対deadlineまで1つのcontroller-owned drainとして保持するか。Master fadeはdeadlineの6ms前に終わるか |
| drain cancellation / stale callback | 新play、手動stop、Project切替、context interruption、controller disposeでdrainを同期破棄し、Master fade automationをcancelしてgainを復元するか。reentrant stopped guardとstale completionが現sessionを破棄しないか |
| loop wrap ownership | transport loopのwrapでは自然終了callbackやdrainを開始せず、同じloop sessionを継続するか |
| mute/solo | 初期muteはsample 0から漏れ0、初期soloは対象Trackだけが鳴るか。offlineも同じで、再生中の変更だけ10msで平滑化されるか |
| Master 0 | ライブのTrack音とメトロノーム、WAV PCMがsample 0から完全に無音か。ライブmeterはpost-fader 0で、offlineにはclick / UI meter / analyserがないか |
| Master 0.5 | limiterが作動しないfixtureで、ライブのTrack音とメトロノーム、WAV PCMがそれぞれunity時の0.5倍になり、offline PCMにclickがなく、Master gainの未適用・二重適用がないか |
| Master fallback | Masterなしlegacy projectがunity、非有限Master volumeがfail-silent、予約pan/mute/soloが出力へ影響しないか |
| multiple Master | 異なるvolumeのMasterを2件置いた時、`project.tracks`配列で先頭のMasterだけがライブとWAVへ効き、順序を入れ替えると有効volumeも入れ替わるか |
| initial fader | 初期Track volumeと初期Master volumeがライブとofflineのsample 0から反映され、既定gain 1.0や10ms rampの過渡音が漏れないか |
| Mixer surface parity | Track ListとMixerのvolume / pan / mute / soloが同一状態を表示・更新し、操作順にかかわらず可聴結果も一致するか |
| minimum window layout | production rendererを1440×900からTauri最小1024×640へresizeした時、Mixerが自動収納され、Piano Roll入力面が0pxにならず、document横overflowとwindow下端超過がないか。keyboardで再展開してもfocus・ARIA・内部scrollが保たれるか |
| per-track meter ownership | live TrackGraph構築時にentryを登録し、構築失敗・graph破棄では一致identityだけをcleanupして、古いgraphが新しいentryを削除しないか |
| Master meter ownership | 同じmaster source / contextのaccepted session間でMaster analyser identityを再利用し、session置換では削除せず、source / context退役時だけownership guard付きで削除するか |
| live export isolation | live再生中のWAV export成功後も同じtransport session、per-track analyser、Master analyserが継続し、meter値が更新されるか。render / encode失敗時も同じか |
| offline meter ownership | unit / integrationでoffline WAVがclickやUI meterを生成せず、per-track / MasterどちらのUI analyserやmeter registry entryも作成・登録・置換・削除せず、既存live entryのidentityを変えないか |
| offline graph cleanup | unit / integrationでWAV成功・失敗の両経路が各offline TrackGraph、Master gain、limiterを一度だけ解放し、live graphは解放しないか |
| clipping warning | Masterが0dBFS超過時に警告するか |
| offline render | 同じProjectとresolved event planから同じ動的frame数・tail plan・WAV formatが出るか。同じapp buildのpinned Chromiumで同一Projectを2回UI exportしWAV全bytesが一致し、seedだけ変えるとevent planを保ったままPCM dataが変わるか。cross-engine bit identityは合否条件にしない |
| start failure | AudioContext生成/resume拒否で停止へ戻り、再試行案内・未処理Promiseなし・教程イベント0件になるか |
| async generation race | A開始→停止→B開始を両解決順で完了しても、Bのsessionだけが残るか |
| context interruption | suspended/interrupted/closedでsession資源を破棄し、編集を保持した中断案内へ戻るか |
| session cleanup | lookahead済みのnote/drum/metronomeを含め、停止後に旧sessionの音が新sessionへ重ならないか |
| vocal-cut center/side | 同相の中央成分がpresetどおり減衰し、逆相を含むSide成分は保持されるか。90%軽減が約-20 dBになるか |
| vocal-cut bass preservation | cutoff以下の中央低域を高域の中央声より多く残し、3 presetのstrength / cutoffが仕様値と一致するか |
| vocal-cut safety | exact stereo / 5分 / memoryをallocation前に検査し、non-finiteとnear-monoを拒否するか。WAV `fmt`、MP3 Xing/Info・frame length、ADTS frame length、M4A `mdhd` / `stts` / `stsz` / `stsc` / sample rateを短く見せても、decoder再同期候補 / sample table由来のdecode時間上限を実ChromiumのAudioBufferより短くしないか。Info偽装10分MP3とouter-frame内の連続chainをdecode前に拒否し、孤立したMP3 payload headerは過大計上しないか。正規exact 5分WAV / MP3 / ffmpeg M4A / macOS AudioToolbox M4Aをbounded padding込みで受理し、browser durationが過大なADTS AACもframe列で受理してdecode後paddingだけをzero-copyで300秒へtrimするか。peak 1以下は持ち上げず、超過時だけ減衰するか |
| vocal-cut chunk/cancel | processingとWAV encodeがchunkごとに進捗を単調更新し、cancel後に古いgenerationが結果やdownloadを公開しないか |
| humming pitch core | 50 / 1,000 Hz境界、2音＋無声、vibrato、強い第2倍音、逆相stereo、192 kHz downsampleのaliasingを合成fixtureで検査し、同入力 / 異chunkで結果が一致するか |
| humming safety | 60秒UI上限、256 MiB PCM / working上限、NaN / Inf、32ch core上限、mono / stereo UI上限、巨大chunk、cancelをallocation / commit前に拒否するか |
| microphone capture | secure context / AudioWorklet / device有無、権限拒否、single-flight、permission pending cancel後のlate stream停止、device切断、manual / exact 60秒停止、0.5秒未満、2ch / sample rate / memory上限、invalid chunk、flush timeoutでresourceを一度だけ解放するか。入力ID省略時はhost既定、明示時は`deviceId.exact`になり、take中に変更されないか |
| microphone input inventory | `enumerateDevices()`からaudioinputだけを抽出し、duplicate IDは先頭だけ、空labelは`マイク N`、空IDはdialogのシステム既定optionへ統合されるか。unsupported / enumerate失敗でも既定入力を残し、`devicechange`再取得、stale generation破棄、選択device消失表示、unsubscribe exactly onceを検査する |
| recording latency calibration DSP | 固定PRBSの複数burstを0、1、500 ms境界と既知の整数frameだけshiftしたmono/stereo・複数sample rate fixtureで正規化相関し、exact `latencyFrames`と有限0〜1 confidenceを返すか。silence、clipping、500 ms窓外、同率 / 近接peak、burst間不一致、閾値直下confidence、NaN / Infを決定的にfail closedにするか |
| recording latency calibration lifecycle | exact input ID / Context generation / sample rateを開始・解析前・公開前に照合し、context変化、cancel、capture failureで新profileを公開せず前回値を保持するか。成功profileがProject / history / revision / autosave / Asset / SQLite / `.ctsproj.json`へ現れず、dialogを閉じた時と通常録音中を含むapp lifetimeの`devicechange`でfuture profileを破棄するか。bind前はtakeをfail closed、bind後はcurrent take token / frozen配置を保ち、以前の入力へ戻しても旧profileを再利用しないか。transport stopped後にnatural drainが残るfixtureでsession dispose / Master restoreがprobe scheduleより先に完了するか |
| humming E2E | local mono WAVと合成MediaStreamの直接録音をAssistantから解析し、候補修正 / 除外、target / quantize確認後に2音をUndo 1回のProject changeとしてPiano Rollへ反映するか。権限拒否時にfile fallbackが残り、失敗 / cancelではProjectが不変か |

## 6. パフォーマンステスト

- 1-oscillator Synth voice 10,000件とClosed Hat subvoice 10,000件を順次自然終了させ、全source / layer gain / filter / gainのdisconnectが各1回、共有outputが0回で、最後のmanager disposeが追加disconnectを発生させないこと

| 条件 | 目標 |
|---|---|
| 16 tracks / 64 clips | UI操作が実用範囲 |
| 10,000 MIDI notes | Piano Rollのズーム/スクロールが破綻しない |
| 20,000-event indexed sweep | 0.6拍×1,707 queryで候補走査合計20,000、lower-bound比較54,624以下、最大候補256を満たし、全schedule×query回数の走査へ戻らない |
| production Chromium 20,000 events | 200ノート×100 linked instanceをproduction buildへ読み込み、再生開始、3回以上の位置更新、停止応答、runtime errorなしを満たす |
| 30分プロジェクト | 保存/読み込みが実用範囲 |
| レッスン100件 | Learn Panel検索が実用範囲 |

## 7. 回帰テスト対象

### 7.1 MIDI / Project交換契約

| テスト | 必須検証 |
|---|---|
| Project exact roundtrip | schema v4の`.ctsproj.json`をcanonical codecでencode→decodeし、Track role、`lengthBeats`、tempo / 拍子map、AudioAsset、AutomationLane、Audio routing、Audio Clip frame payloadに加え、既存のTrack / Clip / loop / alias / preset / effects / groove / section / chord semanticsがexactに一致する |
| Project schema v1→v2 migration | own payloadを持つv1 Clipへlegacy `aliasOf`を設定したfixtureをTypeScript codecとRust native migrationへ通し、v2 stepでは`aliasOf`だけが削除され、Clip / Note / DrumEvent ID、payload、配置、順序が一致する |
| Project schema v2→v3 migration | 固定tempo / 拍子 / 曲長、名前variantと重複Chords / Bass / Melody Track、非空・空・欠落legacy audio参照、migration用prefixと衝突するraw IDを混在させる。保存順の最初だけが学習role、mapはbeat 0、mirrorsは一致、同一legacy参照は同一`unresolved` asset、欠落はClip別placeholder、frame fieldは0になり、入力を変えず同一bytesから同一v3を返す |
| Project schema v3→v4 migration | v3の全non-Masterへ保存順を保ったdirect-to-Master outputをexact 1件ずつ作り、sendを空にする。同じv3 bytesからTypeScript / Rustが同じcanonical v4を返し、入力object / raw snapshot / provenanceを変更しない |
| migration chain / native parity | v1 fixtureを`v1 → v2 → v3 → v4`へ通し、TypeScriptとRust native metadata境界が同じcanonical v4を受理する。Chord / Chords / コード、BOM / EM SPACE / NEXT LINEのtrim差、Master automation、parameter map、routing DAGを含む200,000 total-item境界も一致させる。unknown / required / null / non-finite / integer / range違反とfuture schemaを両方でfail closedし、移行元exact raw snapshotとprovenanceは保持する |
| valid v3 linked persistence | MIDI / Drumそれぞれで同一Track・type・lengthの正本とpayloadlessな直接aliasを作り、canonical codec、SQLite save/reload、`.ctsproj.json` export/importを通してexact roundtripする。aliasのID / start / loop / `aliasOf`と正本だけのpayload ownershipを保持する |
| musical-time map / mirrors | 複数tempo / 拍子eventでbeat↔seconds往復、区間duration、bar↔beat、変更境界、小数beatを許容誤差内で検証する。空map、beat 0欠落、非昇順、重複ID、曲外event、`bpm` / `timeSignature` / `lengthBars` mirror不一致を拒否する。beat 0だけの固定mapは旧固定計算と一致する |
| AudioAsset metadata | `ready`のmedia type、lowercase SHA-256、byte/sample/channel/frame bounds、Audio Track参照、source range、fade合計、gainを検査する。`unresolved`はzero range/fadeでlegacy非audio Track上にも保持でき、dangling / duplicate ID / ready assetの非audio参照を拒否する。この行はmetadata codecだけを対象とし、binaryは下記の別gateで検証する |
| Audio Asset repository | Web memory / IndexedDBとnativeで128 MiB、実length、SHA-256、deduplicate、defensive copy、missing / changed / unavailableを検査する。nativeはprivate staging write→fsync→再読込→rename、valid stagingの起動roll-forward、corrupt staging削除、symlink / reparse / hardlink fail-closedを検査する |
| Audio Asset save / GC / erase | native canonical saveとcrash draftが全ready objectをSQLite transaction前に検証する。GCは全retained generation / branch / draft参照を保持し、prune後だけorphanを消し、future / corrupt payloadがあれば全削除を中止する。端末全消去はasset rootも削除し、外部sentinelを変えない |
| Audio Track import atomicity | source 128 MiB、1〜2 channel、canonical output 128 MiB、decode PCM 256 MiBに加え、source read / decoded Float32 / 48 kHz resample / PCM16 WAV / persist copyのphase peakを384 MiB以下としてallocation前に検査する。descriptorなしは`2 × source + cache`の共有予約をinspect前に境界±1で検査し、descriptorありもplanner予約競合時にinspect / decodeを呼ばない。nativeは`openAudio`前に最大envelope + Blob + cacheを予約し、実sizeへの縮小、Blob直後のextra envelope→import同一turn引継ぎ、cancel / gateway失敗 / unmount / import拒否の冪等解放を検査する。要求48 kHzを無視する384 kHz contextはresize失敗後に`decodeAudioData`を呼ばず予約を解放する。48 kHz PCM16 WAV保存後、metadata / Track / Clip / selectionをUndo 1回で採用する。cancel、decode / store失敗、stale Project、throwing ID factoryではProject fingerprintが不変で、保存済みorphanを参照しない。cancel後もdecode / resample / storeの実作業がsettleするまでapp-scoped leaseを保持し、再openした2件目をtyped busyで拒否する |
| Audio Clip domain editing | move、non-loop左右trim、gain -96〜+24 dB、fade、loop、split、fresh-ID独立duplicate、deleteをvariable tempo fixtureで検査する。create / move / right trim / duplicateが曲末を越える時は有効拍子mapの次小節境界までProjectを延長し、256小節 / 8,192拍超過はatomic rejectする。loop right trimは外側窓だけ、loop left trim / splitはtyped reject、各no-op / failureはhistoryを進めない |
| Audio Clip live/WAV parity | shared plannerへseek途中、Clip loop、transport loop、variable tempo、source range、gain、fadeを入力し、half-open slice列を一致させる。playable region indexと1 windowを各10,000件で拒否し、複数live tickが同じcompiled indexを再利用する。region超過はlive graph前、window超過は当該windowのsourceを1件もscheduleせずsession interruptionにする（以前のwindowは再生済みでもよい）。liveは実context rateで`max(raw合計 + 2×最大raw + active/in-flight retained, raw合計 + 最大raw + target decoded + active/in-flight retained)`を384 MiB以下にし、未使用LRUを除外してresolver前に境界±1を検査する。WAVはMIDI / drum / chord eventとの合計10,000 source、Float32 output + PCM16 encoder / Blob / native ArrayBuffer / IPC copiesを含むasset working set 384 MiBをOfflineAudioContext前に境界±1で検査する。liveはasset全件preflight後だけgraph/source/scheduler、WAVはpreflight後だけOfflineAudioContextを作り、missing / changed / decode / resource超過でpartial outputを作らない |
| Automation metadata / playback | non-Master volume / pan target、lane / point ID、beat昇順・曲内、有限value、hold / linear補間をroundtripし、Master / stale target、重複ID、不正順序・補間を拒否する。base value、linear / hold、half-open window、曲末exact hold point、transport loopを共通resolverで検査する。可変tempoではlinear区間をtempo change beatで分割し、lane point / tempo change / window endの同時刻重複を除去する一方、loop境界の終値→reset順は維持する。固定tempo / holdの余分なcommandがなく、lookahead分割したliveと全曲一括のoffline WAVが同じbeat / value / AudioParam time曲線になることを確認する。無関係な改名 / event編集は予約済みAudioParamをcancelせず、lane変更またはlane存在中のmixer / effect変更はactive sessionを停止する。lane edit / write/read UIは別gateとする |
| linked effective-event budgets | 少数eventの正本を多数のaliasから参照し、resolved-stored 200,000超をTypeScript / Rust保存境界と複製操作がatomicに拒否する。MIDI Clip loop派生音はresolved-storedへ加えず、audibleだけへinstanceごとに加える。100,000超の非alias v1＋空Chord metadataは移行・保存できる。ライブ20,000、WAV 10,000、展開後timelineの任意0.75拍window 256超はschedule / OfflineAudioContext生成前、transport loop反復後の同window 256超はper-track Web Audio graph生成前の型付き失敗となり、部分WAVとProject / history / selection差分がない |
| WAV schedule ordering | 16声を超えるNoteを持つ正本を後位置、linked instanceを前位置に置き、正本を先に格納する。WAVのresolved scheduleがonset非減少かつ同一onsetで元順序を保ち、未来のvoiceを先にsteal / stopしない |
| Format 1 Track境界 | instrumentだけの1 / 15 / 16 / 128 Track fixtureをexportし、`1 conductor + N part MTrk`を保つ。各partの最初のeventがtick 0のFF 21 1件で、その後にchannel eventが始まることを検査する |
| MIDI port isolation | 0-based melodic `i`がport `floor(i/15)`とchannel `[0..8, 10..15][i%15]`、0-based drum `j`がport `j`とchannel 9になる。melodic 16本目の競合CC7 / CC10、複数drum、mixed instrument / drum、128 Trackで全`port:channel` pairが一意かつpayloadが混線しない |
| conductor MTrk | Projectのtempo / 拍子map全eventが対応tickにあり、両mapの先頭eventがtick 0、chord markerが同じMTrkの各chord開始tickにある。音楽MTrkにはtick 0のtrack name / CC7 / CC10が1組ある |
| UTF-8 text限界 | ASCIIと多byte Unicodeの両方で実encode長4,096 bytesを受理し、4,097 bytesをexport全体の失敗にする。UTF-16 code unit数で判定せず、部分fileを返さない |
| Format 0 / 1 mixed channels | Format 0の1 MTrk内とFormat 1の複数MTrk内に複数channelを混在させ、`MTrk index → channel昇順`のTrack順になる。noteなしconductorは追加数へ含めない |
| note / CC projection | pitch / start / duration / velocityが一致する。CC7とCC10は各0〜127の全値をtable-drivenで検査し、同controllerのtick 0イベントは最後の値がTrack volume / panへ写る。欠落時はunity / centerになる |
| MIDI Clip loop parity | period 1 / length 4のexact multiple、length 3.5のfinal partial、0.3 / 0.9のdecimal境界、空Clip、project末尾、source loop off＋alias loop onと逆方向を作る。ライブscheduleとWAV scheduleのbeat/duration、parse後MIDIのtick/durationが共通occurrenceと一致し、clip終端onsetとdecimal ghostを出さない。1 tick未満のMIDI partialは越境せず省略するが、不正pitch/velocity検証を省略しない。低PPQで全noteが省略される多数Clipでも累積projection work上限で同期処理を止める |
| ambiguous same-pitch overlap | 同一part/channel/pitchのnested・crossing interval、linked/独立Clip間、loop pattern内、realized chord、同drum laneを量子化後に検査し、`overlapping-note`でbytesなしの全体失敗にする。同pitch adjacency、別pitch、別Project Trackは成功する。beat上は隣接でも低PPQの最低1 tick化で重なるfixtureも拒否し、browser E2Eでdownload 0件と具体的な修正案内を確認する |
| additive metadata | FF 59を初期・途中・複数位置でparseし、import前後で現在のtempo / 拍子map、そのcompatibility mirror、key / scaleがexactに不変になる。初期値の差、variable tempo / meter / key signature、marker、Program / Bank、tick 0より後のvolume / pan / Program変更ごとに件数category付きwarningが出る |
| Track名 provenance | 明示FF 03の`Track 1` / `Track 2`と前後spaceを持つ非blank名を文字どおり保持する。FF 03欠落・blankでparserが合成した`Track N`だけがfile stem由来名になり、mixed channel識別子と衝突時`(2)`、`(3)`が決定的に付く |
| Channel 10 exact drum | GM pitch 36 / 37 / 38 / 39 / 42 / 46、duration 0.25と受け入れ先Projectのcompiled拍子map上の16 steps/bar位置がsource PPQで0.5 tick以内、lane / step重複なしを満たすgroup全体だけがdrumになる。5/8・PPQ 100、4/4→3/4境界など非整数step tickも含める |
| Channel 10 fallback | 非対応pitch、duration差、0.5 source tickを超えるoff-grid、可変拍子上で表現不能なbeat、lane / step重複を1条件ずつ与え、各fixtureでgroup全体がpitchと元beat保持のinstrument noteになりwarningが出る。0.5 tick以内は受理し、境界外との間で部分drum変換は0件である |
| partial final drum bar | 4/4・16 steps/barで`lengthBeats=4`は1 bar、`4.25`は2 barを表示する。2 bar目のstep 16は編集可能、clip終端と同じbeatのstep 17以降はdisabledかつ範囲外と読み上げ、表示前後でclip length / stepsPerBar / DrumEventが不変である。pattern適用も可変拍子とpartial最終barへ同じprojectorを使い、clip外hitを生成しない |
| compiled drum projector performance | 257拍子点＋20,000 DrumEventの有効Projectでclip単位projectorのthreshold数がmap件数以下、全stepが単発互換APIと一致し、寛容な2秒上限内でvalidationを完了する。`lengthBars=1024`＋1,024拍子点＋20,000 eventの不正入力はmap / derived bar検証後にprojectorをcompileせず、同じ上限内で拒否する。Rustも1 clipにつきthresholdを1回作って20,000 stepへ再利用する |
| damaged event summary | usable noteとduration 0、未完了Note On、孤立Note Off、invalid UTF-8 textを混在させ、対象eventだけを除外し、種類別件数のbounded warningを返す。usable noteが0件なら拒否する |
| offscreen note | C2〜C6外のnoteをProjectと再exportに保持し、Piano Roll対象外の件数warningを返す |
| Track / event cap | 現Projectとの合計が128 Trackちょうどなら受理し、129 Track相当、1 clipのevent上限、timeline上限を1つでも超えれば全候補を拒否する |
| malformed export input | authored / realized pitchの負値・128・小数・NaN、note / drum velocityの0・128・小数・NaN、Track volume / panの範囲外・NaN・Infinity、不明drum laneを各fixtureで与え、`invalid-project`になり成功bytesや不正data byteを返さない |
| malformed export shape / valid omission | instrument Track＋drum Clip、drum Track＋MIDI Clip、競合payload、Clip `trackId`不一致をchord realization / port allocation前に拒否する。正しいautomation Clip / audio Trackを加えたfixtureは成功し、SMFをparseして対応MTrk / eventが増えていないことを確認する |
| atomic commit拒否 | multi-Track importでcodec拒否と`applyProjectChange`拒否を注入し、Project、history、revision、save queue、selection、active viewの開始前fingerprintが全て一致し、部分Track / IDが見えない。成功時はcommit / history / revision / save予約が各1回だけ進む |
| normalized roundtrip | Project→MIDI export→同じ初期tempo / meterの新規Projectへのimportで、MIDI Clip loopをbakeした展開後noteを含むexport対象Track順、pitch / start / duration / velocity、CC7 / CC10という共通projectionを比較する。conductorのtempo / meterは検出して現在値を維持し、markerはwarning対象でChordへ復元しない。clip / loop / alias / preset / effects / mute / solo / groove / section / chord semanticsのexact一致は期待しない |
| delayed operation lock | browser `File.arrayBuffer()`とnative picker / gatewayをそれぞれdeferし、pending中のrename、tab、新規作成、load / delete、再import、X、Escape、backdropがdisabledでProject dialogが`aria-busy`であることを検査する。resolve / reject後に全操作が同時に戻る |
| every failure unchanged | file read / gateway throw、parse、mapping cap、codec、commitの各失敗でsong / selection / active view fingerprintが一致し、errorに共通assuranceが重複なく1回含まれる |
| plural UI / warning card | 1 Trackと複数Trackの両方で`Nトラック・M音を追加しました`の値が一致し、先頭Track / Clipと適切なEditorへfocusする。warning成功はdialogを自動dismissせず、result cardの件数・全warning・「閉じて編集を続ける」が結果と一致する。raw eventを無制限に列挙しない |

### 7.2 Drum live / WAV realization contract

| テスト | 必須検証 |
|---|---|
| self-contained raw payload | Project→scheduleで各hitがTrack / Clip / DrumEvent identity、source step、clip end、steps / meter、実効probability、swing、humanize、seedを持つ。event probabilityがclip probabilityをoverrideし、未指定値はneutral defaultになる |
| no-UI persisted groove | Drum Editorを一度もmountせず、保存済み`probability=0`がライブ / WAVとも0 hit、保存済みswingが同じonsetになる。project切替や選択clip変更でも結果が変わらない |
| multi-clip isolation | probability 0のclip、event override 1のhit、異なるswing / humanize / seed / stepsを持つ別clipを同時に置き、ライブとWAVのhit数・lane・onset・velocityが完全一致する |
| meter and clip start | 4/4と6/8で`beatsPerBar / stepsPerBar`を使い、非0 clip startへ正しく加算する。clip-local step 0 / 1のswing parityは絶対beat位置に依存しない |
| probability / identity / humanize | probability 0 / 1のedgeを守り、humanize 127が±32へ縮小されない。同lane・同beatでもidentityが異なる複数eventは独立し、同じ入力の再解決は一致する |
| transport occurrence salt | 同じsource hitを明示loop regionで3 pass以上反復し、unwrapped occurrenceごとに値が変化し得る一方、同じ開始条件の再実行ではsequence全体が一致する |
| resolved voice identity | version tag、保存済みseed、Track / Clip / DrumEvent identity、lane、source step、unwrapped raw occurrenceの各要素を1つずつ変えると32-bit `voiceSeed`が変わる。同じ入力は一致し、loopの0..12一括windowと0..4 / 4..8 / 8..12分割windowでseed列が一致する |
| deterministic noise / offset | 同じfixed seedとsample rateのnoise Float32列が完全一致し、異seedでは変わる。offsetはnoise末尾0.4秒を保護する範囲内のsample-frame境界で、同じvoice/saltは一致し、異なるvoice/saltとclap burstは独立する。全subvoice gainはsource stopと同時刻に0となり、`ended` cleanup時刻へPCMを依存させない。複数drum Trackは同じContextのbufferを共有する |
| deterministic WAV E2E | 1小節のkick / snare / closed/open hat / clap ProjectをUIから2回WAV exportし、RIFF/chunk/非無音とWAV全bytes一致を確認する。probability 1 / swing 0 / humanize 0のままseedだけ変え、PCM dataが変わることも確認する |
| translated clip end | source clip途中とproject末尾のpartial clipで、swing後onsetが`clipEnd + (playhead - sourceBeat)`以上の全passをdropする。内側のonsetは各passで維持する |
| adjacent no-loop windows | swing前raw beatを含むwindowではまだ発火せず、swing後onsetを含む次のhalf-open windowで1回だけ発火し、その後windowでは重複しない |
| transport toggle generation | stoppedでは0..0を全曲boundsへ直しても再生開始・request増加がなく、starting / playingではrequest IDが1増え`starting`となる。controllerが旧sessionをdisposeして新sessionを開始し、位置をsong end以下へclampする。6/8曲長とProject / history不変も検証する |
| explicit loss boundaries | drum `Clip.loop=true/false`が現行audio / drum MIDIで同じ1回projectionであることを既知制約として固定する。MIDIはgroove / mute / soloをbakeしない。同じbuild/engine/sample rateの再WAVはbit一致を必須とするが、live対offlineおよびcross-browser / OS / WebView / sample rateのbit一致は要求しない |

### 7.3 Natural tail / transport end contract

| テスト | 必須検証 |
|---|---|
| instrument source end | Soft Padの最終noteで`max(durationSeconds, attack + decay) + release + 0.02s`をonsetへ加え、期待するsource end / tail / fade startと一致する |
| six drum source ends | Kick 0.35s、Snare 0.25s、Closed Hat 0.095s、Open Hat 0.37s、Clap 0.144s、Perc 0.28sのlane mapを個別に確認し、代表する最終open hatでは曲末超過分だけをtailにする |
| Audio-only source end | MIDI / drum eventが0件でAudio Clipだけが可聴なProjectでもtrim / loop後のregion終端からTrack insert / Master limiter tailを計画し、live自然終了とWAVが同じdeadlineを使う |
| no-event / audibility | resolved event 0件ではDelay / Reverbがあってもtail / fade 0である。WAV snapshotのmute / soloで非可聴eventを除き、liveはsession中に一度でも可聴だったTrackを過小評価しない |
| Delay exact -60 dB | 最大feedbackのecho列と、数学的にexact thresholdへ置いたmixを使い、0.001以上のechoを含めて直下を除く。log計算の丸めで1 echo欠落しない |
| Reverb analytic bound | wet gain、fixed impulse peak、squared decay envelopeからthreshold時刻を算出し、wet 0 / disabledは0になる |
| Biquad coefficient bound | Filterのcutoff / resonanceをruntimeと同じlowpass frequency / Q dBへ解決し、高Qほどtailが単調増加する。EQのlow shelf / peaking / high shelfを3段加算し、neutral 0dBは0、invalid / unstableは1 stage 2秒以内でfail-closedする |
| real DSP tail | pinned ChromiumのOfflineAudioContextで80Hz/Q18 Filterを励振し、source停止後0.1秒超の実ringingが解析上限内に収まる。impulseを通したDynamicsCompressor出力が規格6ms frame付近に現れる |
| compressor / limiter ownership | enabledなinsert Compressorを1段6msで直列加算し、Master limiterは全体へ1回だけ加える。synth filterは後段ADSR Gainが0になるため追加tailを持たない |
| sequential inserts / cap | Filter / EQ / Delay / Reverb / Compressorを順序どおり保守的に加算し、通常chainは40秒未満、病的な複数insertはMaster limiter込み40秒capになる。50ms fadeは`fadeEndSeconds`で終わり、`totalSeconds`まで6msだけlimiter outputを保持する |
| WAV dynamic allocation | `ceil(totalSeconds × 44,100)` frames、render固有`frames × 2ch × Float32 4 + 44 + frames × 2ch × PCM16 2` bytes、end-to-end `frames × 2ch × Float32 4 + 4 × (44 + frames × 2ch × PCM16 2)` bytesが一致する。5分body + 40秒tailをrender 192 MiB / export 384 MiB未満で受理し、body / memory、audible 10,000件、0.75拍window 256件のいずれかの超過をOfflineAudioContext生成前に拒否する |
| immediate finish / one drain | natural endでtransportを即時`stopped`、位置0にしてreentrant stopped通知を1回だけguardし、scheduler / metronome / position timerを止める。drain完了までgraphとpost-fader Master meterを保持し、disposeは1回だけである |
| absolute deadline / late callback | cleanupを`projectEndTime + tailSeconds`へ固定し、fade endをその6ms前へ置く。callbackがfade中まで遅れたら残時間だけrampし、limiter保持区間なら即時0、deadline経過済みならtimerなしで完了する。いずれも現在時刻からtailを延ばさない |
| cancellation / Master restore | 新play、手動stop、Project activation、context interruption、bridge disposeでtimer / graphを即時破棄し、pending fade automationをcancelして現在Master gainを復元する |
| stale drain callback | replacement開始前に旧drainをdisposeし、旧completionを後から呼んでも新しいactive / draining sessionとtransportへ作用しない。重複completionもdisposeを増やさない |
| loop wrap | loop schedulerのwrapで`onEnd` / drainを発火せず、通常sessionとmeterを継続する |
| play-at-end rewind | 4/4のexact end / beyond、負値、NaNと、6/8のdenominator-aware endを0へ補正する。valid位置、loop bounds、Project identity、past / future、save stateを保持し、endからの開始失敗後も新request IDで0から再試行・confirmできる |
| explicit determinism limits | tailはPCM silence scanではなく解析値で、40秒capへ達する病的insertはfadeされる。drum source noise / offsetは決定的でもWeb Audio engine間bit identityは別保証であり、別契約のdrum `Clip.loop`未展開とも混同しない |

### 7.4 Vocal cut contract

| テスト | 必須検証 |
|---|---|
| source structure | Rust境界はWAV / MP3 / M4A / AACの拡張子、主要container構造、申告byte長、128 MiBを予備検証し、rendererのTypeScript境界がnative / Web両方のbytesを厳格再検証して同じ最終可否にする。WAVはPCM / IEEE float32に限定する。M4Aは非fragmented AAC-LCのcodec設定、`mdhd` / `stts` / `stsz`または`stz2` / `stsc` / `stco`または`co64` / 単一`mdat` exact coverを一致必須とし、ALAC / HE-AAC / `moof`を拒否する |
| native permission | `file_open_audio`だけをmain capabilityへ追加し、汎用fs/dialog/shell/opener、path返却、network permissionを追加しない。basenameとbounded bytesだけを返す |
| input plan | exact stereo・300秒以下・有限sample・working/output memory内を受理し、mono、多channel、near-mono、non-finite、duration / memory超過を処理前に型付き拒否する |
| preset DSP | 自然75% / 150Hz、標準90% / 120Hz、強め100% / 100Hzをtable-drivenで確認し、Side保持、低域保護、no upward normalizeを数値比較する |
| asynchronous lifecycle | source read / metadata / decode / analysis / processing / encodeのphase、単調progress、cancel、source差替え、dialog unmount、stale generationを検査する。dialog close後も実source job / decode jobがsettleするまで各single-flight leaseを保持して同種jobを1件へ制限し、30秒後の安全な復旧案内とsettle時live statusを出し、古い結果・object URL・buffer・未追跡Promiseを残さない |
| UI / export | A/Bが同じ再生位置を維持し、最小375×667と1024×640でtrigger / dialog / cancel / saveへkeyboard到達できる。出力は2 channel PCM 16-bit WAVで、保存cancel / 失敗を成功表示しない |
| persistence / privacy | 成功、失敗、cancelの全経路でProject identity / history / revision / autosave / SQLite / `.ctsproj.json`を変更せず、音源・結果のnetwork requestが0件である |
| limitation copy | ML stem分離ではないこと、声が残る・中央の楽器も弱くなり得ること、権利のある音源だけを使うことを作成前から表示する |

- 既存プロジェクト読み込み
- Lesson DSL schema
- Chord parser
- MIDI export
- Autosave recovery
- AI Coach mock response parsing
- Arranger sectionの`start + length <= project length`相関境界。数値の選択→削除→再入力中は保存候補を作らず、確定後の保存・再起動でも値を保持する
- ArrangerのMIDI loop checkboxはchecked状態と選択instanceの`loop`が一致し、linked aliasだけをオンにしても正本はオフのままであること。Undo/Redo各1回で往復し、Drum Clipには表示せず、native checkboxとして読み上げ可能であること
- Arrangerの独立/連動コピーと連動解除をEnterで実行すると、消えたaction buttonから成功後の対象Clip buttonへフォーカスが移ること。loop checkboxはSpace後もfocusを保ち、transportを再生しないこと
- Section disclosureは`aria-expanded` / `aria-controls`を同期し、開くと最初の名前入力へ移ること。通常のTab順だけで種類→開始→長さ→削除→閉じるへ到達し、閉じると起点、削除すると次→前→追加buttonへ戻ること
- Drum matrixは1 `grid` / 6 `row` / 6 `rowheader` / 96 `gridcell`を公開し、有効buttonの`tabIndex=0`が常に1件であること。矢印 / Home / End / Enter / Spaceがtransportへ漏れず、partial小節境界を越えず、小節切替後はgrid / cell名と`aria-pressed`が新しい小節へ変わること
- Arrangerのduplicate / unlink / resize / loop成功`status`は、UndoやProject切替で期待状態が失われると消え、Redoしても古い通知を再表示・再読み上げしないこと
- codecが採用前のproject候補を拒否した場合、現在のproject/history/save stateを変更せず、拒否理由だけを通知する
- `note.added` / `note.moved` は採用済みprojectを購読側が読める時点でのみ発行する。対象なし、同値変更、範囲外で拒否された追加・移動はrevisionも教材進捗も変えず、velocity/lengthだけの変更を移動として数えない
- `effect.added`は生成effect IDが採用済みProjectに存在する場合だけ発行する。Track上限64件の状態で65件目を追加してcodec拒否された場合、Project / history / effect数を変えず、compose-plus-4をクイズstepへ進めず、成功toastを出さない
- `TutorialEngine.reconcileProject`はidle/completed、非Project goal、未成立predicateでno-opになり、成立中のProject goalだけを1 step進めること
- Project goalは開始・再開、eventlessなArranger section種類変更、Undo/Redo、Project読込、直前stepからの遷移で成立できること。codec拒否候補はProject identityも教材進捗も変えないこと
- 連続するstate-backed goalは最新確定状態で順に進むこと。compose-5ではchorus成立後、既定Melody volumeが成立済みなら再操作なしで再生stepへ到達し、最終進捗だけを保存すること
- 同じ編集がProject goal成立と同期post-commit AppEventを伴っても、そのEventを直後のevent goalへ再利用しないこと。同一ターンの複数更新は最新状態で1回にまとめ、中断・再開始後に古い予約callbackが別lessonを進めないこと
- step進行/完了時は前stepの表示中hintを必ずclearし、次stepの「ヒントを見る」前に古い操作案内を表示しないこと
- `noteCountAtLeast`は2-note正本＋linked aliasを4件、dangling aliasを0件として扱うこと。`drumLaneActive`も同一drum track内で2-hit正本＋linked aliasを4件として扱い、MIDI/Drum `Clip.loop`反復では教材上の編集event数を増やさないこと
- compose-5実E2Eで「アレンジ」→「＋ セクションを追加」→「セクション種類」=「サビ」と教材hint/進行が一致し、既定音量の自動再照合後に旧hintが消え、page errorがないこと
- スケールスナップ教材はCメジャーだけで進み、誤ったキーまたはスケールでは進まないこと。有効中に設定を修正した場合は再トグルなしで進むこと
- スケールスナップの同値設定、無効化、確定に失敗した変更では教材イベントを発行せず、二重進行や二重通知がないこと
- スケールスナップは初期オフで、ボタンへフォーカス中の修飾キーなし`S`だけが同じ切替経路を使い、`aria-pressed`、可視のオン／オフ表示、読み上げ状態が実状態に一致すること。画面全体の単一文字キーや`Ctrl/Cmd/Shift+S`では切り替わらないこと
- スケールスナップをオンにしても既存音は変わらず、その後の追加・移動・Alt+ドラッグ複製は実ピッチがスケール内になり、複製音だけがドラッグ先へ移動すること
- Piano Rollの多段`pointermove`中はproject/history/revision/save/eventが変わらないこと。`pointerup`後の履歴・revision・save予約は1回だけ進み、`note.moved`はpitchまたはstartが実際に変わった確定ノートごとに最終値を1件発行し、長さ・ベロシティだけの変更では0件であること。単一・複数移動、長さ、ベロシティはUndo/Redo各1回でジェスチャー全体を往復できること
- `pointercancel`と予期しない`lostpointercapture`では移動・長さ・ベロシティ・Alt複製のプレビューが破棄され、異なるpointer IDのmove/up/cancelも無視されること
- 複数ノートを時間・clip境界へ移動しても相対タイミングを維持し、個別clampで同じ開始位置へ潰れないこと。音域境界までは共通pitch deltaで移動し、Scale Snap有効時は音程間隔維持より各最終音のスケール内化を優先すること。ただし上下方向に次のスケール音がC2〜C6内にない場合と、時間方向だけの移動・複製がclip境界でbeat delta 0になる場合はno-opで、音高だけの変更・commit・ID生成がないこと
- Alt/Optionはクリック、3px未満、ドラッグ後の原点復帰では複製せず、完了ドラッグ中も実ノート件数へゴーストを含めないこと。完了時だけ1 batchで追加し、Undo 1回でコピー全体を除去すること
- Piano Rollの固定編集音域内に20音以上あっても実ノートの`tabIndex=0`は常に1件で、各音がトグルボタン、非空の読み上げ名、選択状態、キー説明、可視フォーカスを持つこと。選択線とフォーカス線を形で判別できること
- Arrow移動、Shift+Arrow長さ、PageUp/PageDown強さ、Cmd/Ctrl+D複製は各1 batchで、Undo/Redo各1回で往復すること。キーリピート、範囲端、同値では履歴・revision・save・eventを増やさないこと
- クリップ右端のダブルクリックは最後の有効開始位置へ追加し、終端を越える最近傍量子化は手前の有効グリッドへ置くこと。`(any-pointer: coarse)`ではhybrid端末を含め、ノートのpointer hit targetが最低24×24 CSS pxあり、低ベロシティの可視高と44px以上の透明hit領域が両立すること
- project-modelで有効な音域外MIDIノートをimportしてもprojectとexportで保持される一方、Piano RollのノートDOM・選択・Velocity Laneには含まれないこと。固定編集音域内にノートがないグリッドは唯一のPiano Roll tab stopになり、coarse pointerのnative pan・scroll gestureを妨げないこと
- Spaceの選択切替でtransportを再生せず、Cmd/Ctrl+Sとフォーカス中だけのQ/S/Cを奪わないこと。Cmd/Ctrl+Aは現在clipの固定編集音域C2〜C6全体を水平viewport位置にかかわらず選択し、importされた音域外ノートは対象外であること
- Shift+PageUp/PageDownとHome/Endで全ノートへ到達でき、選択を勝手に変えないこと。削除後は次、なければ前、全削除なら入力グリッドへフォーカスし、複製後は最初のコピーへフォーカスすること
- 空クリップではグリッドがTab順に入り、矢印/Home/EndとEnter/Spaceだけで追加でき、作成音へフォーカスすること。Scale Snapの上下移動は入力方向だけで次のスケール音を探索し、音域境界では逆方向へ移動しないこと
- 選択ノートのQ量子化は1 batchで確定し、開始位置が変わった各ノートの確定後最終値を`note.moved`として1件だけ発行すること。focused Qは確定件数、no-opは既にgrid上である旨をpolite live statusへ通知すること
- Master volume 0.0 / 0.5 / 1.0 / 2.0で、ライブのTrack音とライブ専用メトロノーム、およびWAV PCMが同じgainをlimiter前に一度だけ適用すること。ライブmeterはpost-faderを観測し、offline WAVにはメトロノームclickとUI meter / analyserがないこと。Masterなしはunity、非有限値はfail-silent、Master pan / mute / soloはMVP出力とUIへ影響しないこと。異なるvolumeのMasterが複数ある場合は`project.tracks`配列の先頭だけが有効で、順序変更に追従すること
- Track List / Mixerの全M/S buttonは`M` / `S`だけでなく`${Track名} ミュート` / `${Track名} ソロ`をcomputed accessible nameに持ち、Masterには存在しないこと。keyboard Spaceでfocusを保ったまま`aria-pressed`と両surfaceの状態が同期すること
- production browserの1440×900ではMixerを初期展開してPiano Roll viewportを150px以上保つこと。1024×640へresizeすると未操作のMixerを自動収納し、document横overflowなし、中央編集面500px以上、active Editor 260px以上、Piano Roll viewport 96px以上、Mixer 56px以下でshell下端がviewport内に収まること
- 1024×640でMixer disclosureをkeyboard Enterにより再展開でき、focusを同buttonへ保持し、`aria-expanded`とcontentの表示状態が一致すること。展開時もMixerを160px以下、Piano Roll viewportを80px以上に保ち、Mixer内部で残りのcontrolへscrollできること
- Track、ベース生成mode、小節buttonの選択は`aria-pressed`、保存一覧のactive Projectは`aria-current`と一致すること。中央は1つの`main`、Mixerは名前付き`region`で、不要な`contentinfo`がないこと
- 同じTrackへ同種effectを2件追加しても、group、各slider、削除buttonがTrack名・効果名・連番を含む一意なcomputed nameを持ち、2件目のkeyboard削除後も1件目を同じ名前で操作できること
- graph初期化直後とoffline renderの初期Track volume、初期Master volume、初期mute / soloはsample 0から即時反映され、10ms平滑化は再生中更新だけに使われること。Track ListとMixerのvolume / pan / mute / soloは同じstateと可聴結果を保つこと
- live TrackGraphを構築するunit / integrationではper-track analyser entryを登録し、構築失敗・置換・破棄では一致identityだけをcleanupして、古いgraphが後から登録されたentryを消さないこと。同じmaster source / contextを使うaccepted sessionの置換ではMaster analyser identityを再利用し、source / context退役時だけ一致identityを削除すること
- live再生中にWAV exportを成功させた後も、開始前と同じtransport session、per-track analyser、Master analyser、各meter registry entryが残り、meter更新と再生が継続すること。renderまたはencodeを失敗させた場合も同じで、offline処理はper-track / Master analyserの作成・登録・置換・削除を一度も行わないこと
- unit / integrationの両層で、offline WAVの成功・失敗ごとに独立TrackGraph、Master gain、limiterが一度だけ解放され、live所有のTrackGraph / master source / analyser / transportは解放・置換されないこと

### 7.5 Track管理 / preset / routing contract（schema v4）

- instrument / drum追加は0拍から拍子分母を含むsong endまでの対応Clipをexact 1件作ること。Audio追加は選んだsourceをcanonicalizeしready asset全rangeのClipをexact 1件作り、BusはClip / instrumentを持たない空のstereo returnにすること。いずれも先頭Master直前、Masterなしlegacyでは末尾へ追加し、Master直結outputを同じtransactionで作ること
- duplicateはTrack / Clip / Note / DrumEvent / Effectの全IDを新規にし、正本とaliasを混在させたTrackでも複製先`aliasOf`が複製先正本だけを直接参照すること。main outputとsource所有sendを複製し、send IDをfreshにする一方、複製元Busへのincoming routeは複製しないこと。複製先roleは`general`になり、元Trackの編集が複製先へ漏れず、codec roundtrip後も同じであること
- Bus削除はincoming main outputをMasterへ戻し、source / targetいずれかが削除Busであるsendを除去すること。routing修復を含む成功はUndo 1回、cycle / codec拒否はProject / history / revision / autosave / playbackを変えないこと
- 127 Trackから追加して128件は成功し、128件からの追加 / 複製はProject参照、history、revision、autosave予約、selection、active playbackを変えず拒否すること。codecがevent budgetや文字列上限で拒否するfixtureも同じatomic保証を満たすこと
- 全Masterに改名 / 複製 / 移動 / 削除 / preset commandを適用できず、複数Master fixtureのidentityと相対順が変わらないこと。学習role Trackは名前variantに関係なく改名できてroleを保持し、削除だけを拒否すること。一般TrackはChords / Bass / Melodyという名前でも削除できること。local draftは入力中0 commit、確定時1 commit、Undo 1回で戻ること
- canonical 4 presetを順に確定し、保存値、live event plan、offline WAV、Undo/Redo、`.ctsproj.json`とSQLite再読込後の値が一致すること。legacy aliasの表示だけではrevision / save bytesを変えないこと
- active playback中に採用された追加 / 複製 / reorder / delete / presetだけがsessionを停止し、停止前の有限playhead beatを保持すること。rename、拒否、no-opはsessionを停止せず、次のplayが採用済みTrack topology / presetだけからgraphを再構築すること
- deleteした選択Track / Clip IDを残さず、隣接する生存Trackまたはnullへreconcileすること。追加 / 複製後の対象行、reorder後の同一行、削除確認cancel後の起点へkeyboard focusが移るか保持され、status / alertがscreen readerで区別できること

#### 7.5.1 Track管理の現時点の自動化状況

Track管理はproduction導線とschema v4 routingを持つ「部分実装」であり、この節の全契約を検証済みという意味ではない。完了判定では、既存のdomain / store / component / browser回帰に加えて、次の未実施gateを個別に閉じる。

- [ ] 127 Trackから128 Trackへの追加成功と、128 Trackからの追加・複製拒否を同じatomic fingerprintで検証する
- [ ] event budget / 文字列上限で候補Projectだけがcodec拒否されるfixtureを作り、active playbackを含む全付随stateが不変であることを検証する
- [ ] canonical 4 presetを順に確定し、live event plan、offline WAV、Undo/Redo、`.ctsproj.json`、native SQLite再読込で同じ値と音色になることを検証する
- [ ] active playback中の追加・複製・並べ替え・一般Track削除をそれぞれ検証し、rename・拒否・no-opとの停止条件差を確認する
- [ ] instrumentだけでなくdrum追加をbrowser E2Eの保存・再読込まで通し、学習role Trackの改名成功・role維持・削除拒否と可視alertもkeyboard / screen reader経路で確認する

### 7.6 Batch 5 Audio Track regression gate

Audio Trackを「利用可能」と判定する継続gateは次のとおり。実装の有無とrelease candidateでの3OS実測を分け、どれかが退行したbuildは出荷しない。

- app-owned objectへbinaryをstageし、実byte length / checksumを検証してからProjectを採用する。importのdecode / canonical / `source + decoded + 8 × WAV`保存phaseを384 MiB境界±1で検査する。I/O失敗・disk full・crash点で旧Projectを保持し、native起動時にvalid tempをroll forward、corrupt temp / generation-unreachable orphanを安全に回収する
- missing / changed / unavailable binaryはruntime issueとして表示し、ready metadataを暗黙に`unresolved`へ変更しない。save / load / Undo / Redo / retained branchをまたいで別Projectのassetを誤削除しない
- Audio Clipの配置・左右trim・gain・fade・loop・split・duplicate・deleteをproduction UIで操作し、frame source rangeどおりlive / offlineで再生する。loop中left trim / splitは理由付きdisabled / typed rejectにする
- playable Audio Clip region / 1 windowの10,000件、WAV全source合計10,000件、offline asset working set 384 MiBの境界±1を検査する。region超過はgraph前に拒否し、live window超過は当該windowを部分scheduleせず停止する。WAV超過は`OfflineAudioContext`と部分fileを作らない
- import / live startup / WAVの共有384 MiB予約を競合させ、先行予約中の後発処理がresolver / decode / `OfflineAudioContext`を呼ばず型付き拒否されることを検査する。WAVはencode後も予約中で、nativeのBlob read / IPC中とWeb object URL handoff中の競合を拒否し、saved / cancelled / download-started / errorの全経路で予約をexactly once解放する
- `.ctsproj.json`単体にbinaryを同梱しないことを事前表示し、repositoryに同じobjectがないimportは現在Projectを置換しない。Web IndexedDBのgeneration-aware orphan GCは未実装の既知制約として扱う

### 7.7 Batch 6b stereo Bus / send regression gate

- schema v4は全non-Masterにexact 1 outputを要求し、source非Master、target既存Bus、global send ID、sourceごと16 send、全edge合計1,024をTypeScript / Rustの境界±1で検査する。未知key / null / duplicate source-target / main outputと同じBus / self edgeを候補採用前に拒否する
- outputとsendを合わせたDAGでoutput-only cycle、send-only cycle、混在cycleを拒否し、disabled / gain 0のsendもcycle edgeとして数える。拒否時はProject / history / revision / autosave / playbackをatomicに保持する
- liveとoffline WAVは同じstable routing planを使い、pre-fader sendがsource fader / insert前、post-fader sendがpan後をtapすることをimpulse fixtureで検証する。Bus soloは関係する上流・下流edgeだけを開き、上流sourceの無関係なMaster直通edgeを漏らさない
- send gain / enabledは再生中10msで平滑更新し、target / position / add / removeとmain output変更はplayheadを保持してsessionを停止する。Undo / Redo、`.ctsproj.json`、SQLite再読込後も同じroutingになる
- Bus chainを通るFilter / EQ / Delay / Reverb tailをDAG順に伝播し、全体40秒capを守る。全Track / Bus graphを未接続で事前確保し、allocation / connect失敗では全nodeをrollbackしてpartial graphやWAVを残さない
- channel基礎node、insert、live meter、route edge、Master meterを含むstatic graph node見積りを4,096境界±1で検査し、起動 / WAV超過時は最初のAudioNode、analyser登録、OfflineAudioContextを作る前に拒否する。再生中は4,095 nodeのProjectへ5-node Reverbを追加する4,100 node fixtureを使い、既存channelを部分更新せずsession全体を停止し、採用済みeffectをUndo可能なままresource-limit表示へ戻す

### 7.8 Batch 6 remaining gates

- 実装済みのvolume / pan live/offline scheduling回帰を維持しつつ、Automationのlane edit / write / read UIを追加して保存・Undo・keyboard操作を検証する
- 6a自動gateは最大60秒のmono/stereo capture、monitor初期OFF / opt-in、raw PCM→48 kHz PCM16 WAV→asset-first保存を検証する。録音待機なしは新規Track / Clip、単一の既存Audio Track待機中は同TrackへClipだけを追記し、Trackのvolume / pan / effects / routingを保持する。両経路を開始時snapshot / targetへのexact CAS、selection更新、Undo 1回として検査する
- Record ArmはAudio Track以外を拒否し、同時1件のtoggle / replace、Project操作・録音中の変更拒否、Project切替時解除、delete / Undo / Redoでのtarget reconciliationを検査する。armと入力device preferenceの操作だけではProject identity / history / revision / autosave payload / `.ctsproj.json`が変わらないこと、開始後のarm / device変更が凍結済みtargetへ影響しないことを確認する
- device列挙はdefault option、audioinput filter、duplicate、空label、enumeration失敗、`devicechange`、選択device消失をcomponent / unitで検査する。captureでは選択IDが`getUserMedia`のexact constraintになり、未選択時にdevice constraintを付けず、消失・Overconstrained / device-endedでProjectを採用しないことを確認する
- 未使用decoded cacheの開始前破棄、active cacheとGC未実施chunkを含む384 MiB planner、高sample-rate超過のallocation前拒否、capture開始からcancel後に残るresample work settlementまでのimport / record single-flight lease、permission cancel後のlate stream破棄、同一tick二重開始拒否、permission / device-ended / cancel / stale開始snapshot / playhead / target / revoked token / project switch / close拒否も自動検査する
- 実測校正componentは通常録音と別wizardで、exact入力を選び、interfaceの出力→入力をケーブル接続する案内、スピーカー / マイクの空中loopback禁止、monitor強制OFF、固定低出力、PRBS複数burst、500 ms上限、cancelを確認する。成功だけがprofileをatomic置換し、失敗 / cancelは前回profileを保持する。出力identityを取得できない制約と、出力device / driver / buffer変更後の再校正案内も検査する
- 録音配置は推定 / 実測 / 無補正の3modeを比較する。実測modeではexact一致profileのframe値がinput / base / output / limiter推定全体を置換し、手動offsetだけが後段で加算されること、不一致profileで推定へfallbackしないこと、可変tempo / beat 0 trimが同じであることをsample frame fixtureで検査する
- 3OS実deviceでpermission、システム既定 / 明示device選択、`devicechange` / device loss、Record Arm先への追記、disk full、monitor feedback、close、再起動再生を確認する。shared AudioContextの伴奏同期と推定 / 実測 / 手動latency補正を有線・Bluetoothを分けて聴感 / 波形比較し、host申告値がない環境も確認する。実測はinterfaceの物理cable loopbackを使い、interface / driver mixerのDirect Monitor、hardware Loopback、同一outputへのreturnをOFFにして電気的feedbackがないこと、Project Master fader 0 / 1 / 2でも固定probe levelと測定値が一致することを確認する。OSごとに既知frame shiftとの誤差、silence / clip / ambiguity拒否、再校正案内を記録する。長時間streamingを閉じた後、cycle take / compingへ進む

## 8. 手動QAチェックリスト

- 初心者が説明なしでStart Screenから再生まで到達できる
- Learn Panelを閉じても作業できる
- スケール外音の警告が邪魔すぎない
- 既存DAWのUI模倣に見えない
- 音が鳴らない時の原因表示が分かりやすい
- 書き出し前チェックリストが役に立つ
- 予期しない起動・描画エラーで空画面にならず、キーボードで再読み込みと診断情報の明示コピーができる
- 診断情報に曲名、project bytes、取り込みfile名、端末path、raw error message/stackが入らず、自動送信も行われない
- カラオケ作成で3 presetを比較し、A/Bの位置がずれず、cancel後に結果が現れず、mono / near-mono / 5分超過 / 128 MiB超過が具体的な案内になる
- カラオケ作成前から品質限界と権利注意が読め、処理中もNetwork requestがなく、閉じた後に音声再生や一時URLが残らない
- Track追加で楽器 / ドラム / オーディオ / stereo Busと4音色を迷わず選べ、Audioのlocal正規化・JSON非同梱、Busが複数Trackをまとめるreturnであることを理解できる。Mixerの「経路」でmain output、pre/post-fader send、送り量、有効状態をkeyboard / screen readerで操作でき、循環拒否の理由がalertになる。Masterの操作不可、学習role Trackは改名可・削除不可、一般Trackは名前にかかわらず削除可能という案内と、topology変更後もplayheadを保持する案内を確認できる
- transportとTrack追加の両方からマイク録音を開始し、システム既定 / 列挙済み入力の選択、device追加・切断時の一覧更新、monitor初期OFF、ヘッドホン警告、3秒countdown、level、stop / discard、最大60秒を確認する。Track追加と待機なしのtransportでは新規Track、Audio Trackの`R`を1件だけ待機させたtransportでは既存TrackへClipが増える。既存再生は開始操作で停止し、countdown後は同じ将来AudioContext frameから伴奏とcaptureが始まり、録音中statusとtransportの双方が再生中を示すこと、手動stop・曲末・60秒上限・discardでexact requestだけが止まることを確認する
- Worklet unitではarmがrender quantum途中でも先頭frameが一致し、最大frameでexact stopし、chunk sequence / absolute frameの欠落・重複・channel変化をtyped failureにする。playback integrationではanchor到達前に`playing`を確定せず、Project / operation / playhead / context generationのstale、arm未解決中abort、deadline missedでgraphとdecoded leaseを解放する。通常再生の即時anchorは回帰させない
- 自動（推定） / 実測校正 / 自動なし、手動-500 / 0 / +500 ms、input latency未申告、可変tempo、beat 0 clamp、全frame trim拒否を検査する。推定値を実測値と表示せず、実測profile不一致時は具体的に再校正を案内する。校正wizardは`システム既定`では開始不可、明示入力だけで開始でき、interfaceの物理cable以外を案内せず、app / hardware / driverのmonitor・loopback return OFFと固定低出力を変更できないことを確認する。通常のcancel / silence / clip / ambiguity / low confidence / context changeは前回値を破壊せず、入力選択 / `devicechange`は進行中校正を中止して旧profileも破棄する。各stepでfocusを新しいprimary actionへ移し、user cancel後のlate successをcommitしない。permission拒否、選択device消失、保存容量不足、録音中closeで既存曲が変わらず、成功後はUndo / Redoと再起動再生が一致する

### 8.1 Native release candidate（macOS / Windows / Linux共通）

各OSのunsigned release bundleから起動し、開発serverやtest WebDriverを使わずに確認する。pickerで選んだ絶対pathや保存先pathは画面、console、IPC responseへ表示しない。

- schema v4の`.ctsproj.json`をnative pickerで開き、曲名・tempo / 拍子mapとmirrors・Track role・ノート・コード・AudioAsset / Automation / routing metadataが一致する。同checksum objectがapp-owned repositoryに存在するfixtureではAudio Clipも再生でき、存在しないfixtureは現在Projectを置換せず「JSONに音声は含まれない」と表示する
- Busを2段接続し、main outputとpre/post-fader sendを保存・再読込・Undo / Redoする。live/WAVで同じ経路とtailになり、循環、disabled / gain 0を含む潜在循環、16 send / 1,024 edge超過は既存Projectを変えず拒否する
- 不正JSON、future schema、16 MiB超過projectを拒否し、元プロジェクトを変更しない
- `.mid` / `.midi`をnative pickerで開き、Format 0 / 1のmixed channelが複数Trackとして順序どおり追加される。無効header、8 MiB超過、128 Track超過、commit拒否は元Project・選択・表示を変更せず拒否する
- `.wav` / `.mp3` / `.m4a` / `.aac`をnative pickerからカラオケ作成へ読み込み、構造偽装、128 MiB超過、mono / near-mono、5分超過を拒否する。pathを画面 / console / IPC responseへ表示せず、生成PCM 16-bit WAVを独立playerで再生できる
- `.wav` / `.mp3` / `.m4a` / `.aac`をAudio Trackとして追加し、48 kHz mono/stereo PCM16 object、AudioAsset metadata、全range Clipが一致する。move / trim / gain / fade / loop / split / duplicate / deleteをUndo/Redoし、再起動後のlive/WAVが同じ範囲を使う。missing / tampered objectはtyped表示され、部分再生しない
- invalid UTF-8、duration 0、未完了Note On、孤立Note Off、画面外note、drum fallback、非対応metadataの複数warningを発生させ、成功件数とwarning詳細をキーボードとscreen readerで確認できる
- native picker応答とimport commitを意図的に遅延し、処理中のProject dialogで全Project操作とX / Escape / backdropがdisabledになり、warning成功後はunlockされた全warning result cardを確認してから閉じられる
- project / MIDI / WAVを書き出し、既存fileへの上書き確認、cancel、権限拒否、空き容量不足を初心者向けに処理する
- 書き出したprojectを再読込し、書き出したMIDI/WAVをOS標準または独立playerで開ける
- pickerと保存dialogへ提示する候補名が240 UTF-8 bytes以内で、予約名・区切り文字・末尾dot/spaceを安全化する
- 編集直後にwindow closeを要求し、保存完了後だけ終了する。保存失敗時はwindowが残り、再試行できる
- canonical保存後の一覧`list()`を保留し、その間に次revisionを受理した通常flushが`true`を返さないこと。同期recoveryは最新project / activation / revision / write IDを照合し、canonical `clean=false`のままclose-safeな保護成功を返し、次回loadで最新revisionを復元すること
- native closeは最初のawait前にproject mutation fenceを取り、claim / flush / recovery中の編集を採用しないこと。限定close dispatch前の失敗ではfenceを解放して再編集・再close可能にし、dispatch後の結果不明では解放しないこと
- repository初期化を1回失敗・2回目成功にし、同一processで再試行され保存済みprojectを復元できること。失敗後に編集してから保存を再試行した場合は現在projectを古い保存内容で置換せず、両方を保持して現在revisionを保存すること
- processを完全終了して再起動し、SQLiteの最新確定projectを復元する
- 予測不能な曲名へ編集し、1秒未満で現在revisionの`保護済み`表示を確認した直後に、harnessが直接所有するexact child PIDへ`SIGKILL`する。同じ隔離SQLiteで再起動し、その曲名がexact復元されること、新しい編集を保存できること、さらに再起動して保存一覧が1件かつ回復branchが無いことを確認する
- crash draftのACK前、stage失敗、同revision別bytes、古いrevision、canonical Nのcommit中にN+1をstageする競合を検査し、未保護を保護済みと表示しないことと、N+1を誤って消さないことを確認する
- native wrapperはdelegate対応時だけcrash protection capabilityを公開し、migration ready前とclose開始後のstageを拒否する。受理済みstage中のcloseは物理I/O完了を待ち、close失敗後は再stage可能であることを確認する
- 保存失敗時の緊急バックアップはcanonical codecを通る再読込可能なbytesだけを書き出す。nativeはOS picker/result契約、Webはdownload開始通知を使い、invalid project・cancel・権限/容量失敗を成功と表示しない
- native版でproject・未保存分岐・旧版archive・緊急復旧・tutorial/onboarding進捗を用意し、「この端末のデータをすべて消去」後の再起動で再出現しないことを確認する。外部へ書き出したproject/MIDI/WAVは残ることも確認する
- marker作成後、SQLite family削除途中、WebView cleanup前後でprocessを強制終了し、次回起動がeditorを出さず同じ消去を再開することを確認する
- process lockの非empty file・symlink/reparse・hardlinkと、SQLite familyのhardlinkを用意し、消去がmarkerを保持してfail closedし、どの別名のbytesも変更しないことを確認する
- 通常window closeと全消去をほぼ同時に操作し、どちらか一方だけが開始され、消去を受理したのに未消去データが再表示される状態がないことを確認する
- Linux AppImageでは同梱GStreamerで再生とWAV書き出しを確認する
- release bundleに`native-test` WebDriver、汎用fs/dialog/shell/opener permission、global Tauri APIが含まれない
- release security policyはproduction `connect-src`への`https:`追加、`core:default` permission、remote capability、global API、asset protocol、isolation pattern、updater/plugin、remote `frontendDist`、任意build hook / runner / feature、platform override、duplicate package名、`prebuild` / `postbuild`、Vite / Tauri CLI差替え、root pnpm override、workspace / lock / pnpmfile / auto-loaded PostCSS config変更、内部package export変更、Tauri `signCommand` / installer hook / `externalBin` / resources、repository Cargo configをexact差分として拒否する。Vite config / `build.rs`の変更・symlink、`_redirects`変更、source-root外relative import / `import.meta.glob`、executable SVG、protocol-relative URL / meta refresh、WebRTC + STUN/TURN、Cargo詳細dependency table / target path、Rust crate alias / libc grouped import / source-root外`#[path]` / `cfg_attr(path)` / `include!`のmutationを拒否する
- production / E2E Vite buildと各3OS Tauri buildの直後にprofile指定付き最終renderer asset scanを実行する。productionへのextra / mixed-case HTML、E2E entry混入、E2E fixture欠落、参照entry欠落、変更済み `_redirects`、extensionless / 未許可extension、symlink / size超過、RTC・socket primitive、protocol-relative / 未許可remote URLを署名・bundle検証前に拒否する。各署名OS jobはinstall lifecycleを無効化し、install後・secret読込前のclean worktreeとrelease policy再実行も必須とする

自動native E2Eは、実WebViewで保存・process再起動復元を行った後、予測不能な曲名への最新編集について現在revisionの`保護済み`表示と1秒未満の実測を確認する。その直後に、親harnessが直接spawnしたexact child PIDだけへ`SIGKILL`を送り、同じ隔離SQLiteからその曲名をexact復元する。復旧後のunique titleを通常保存し、二度目の再起動でもそのtitle、保存一覧1件、回復branchなしを検査する。別シナリオでは`native-test`限定の外部token要求から実`window.close()` / `CloseRequested`を発行し、renderer claim、durable flush、Rust repository close、process終了後の再起動で最新編集が復元し、さらに再保存できることを検査する。続けてUIへ確認語句を入力して全消去を実行する。現在のWebViewへ置いたonboarding、tutorial、native recovery namespace、local/session storageのsentinelが空になること、SQLite familyとmarkerが消えること、app data外のsentinelが変わらないこと、native close handoffでtest serverが停止することを検査する。さらに正しいchecksumのmarkerへ、保存済みSQLite database一式または単独sidecarを外部から組み合わせ、WebDriverを登録しない実binaryが起動時に再開・終了することと、最後の再起動で旧title・保存一覧が戻らないことを検査する。

ただし自動testのWebViewはproduction profileを汚さないincognito data storeである。production profileのcache/cookie残存、複雑なfuture/unreadable/archive/branch全組合せ、外部export実fileは、上記3OS release candidate手動QAを省略できない。
