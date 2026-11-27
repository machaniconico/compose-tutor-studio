# 14. wave5/desktop 機能の移植計画(2026-11-28)

> wave5/desktop(タグ `wave5-desktop-final`、d85f796)で作った作曲・学習機能を、main の v10 モデルの上へ小さな PR に分けて移す計画。ロードマップの正本は `docs/13_pro_daw_gap_matrix.md`。進み具合は各 PR とこの文書の更新で追う。

パスはすべてリポジトリ直下からの相対です。コードは `origin/main`(73a5d54)と `wave5/desktop`(d85f796)を `git show` で読みました。読めていない点は【未確認】と書いています。全体のリスク等級は **R3**(永続フォーマット・並行処理を含む)です。

## 0. 採用案と却下案

**採用**: main のモデルは変えず、wave5 の機能を 3 種類に分けて小さな PR で入れます。スキーマ追加は v11(スウィング・チョーク)と v12(明るさオートメーション)の 2 回だけで、直列に進めます。wave5 の v3 ファイルは通常の移行経路に入れず、コーデック入口の検出器で止め、別の純粋関数で現行版 Project に変換します。

**却下**(後で蒸し返さないための理由つき):
- **`sounding.ts` / `clipExpand.ts` を main の再生の正本にする**: 単一拍子・`lengthBars`・`Project.swing`・明示ループ周期が前提です。main には `timeSignatureMap` と `compileDrumStepProjector`、`buildScheduleEvents`(apps/studio/src/audio/events.ts)、イベント予算(`schedule-budget.ts`)があり、置き換えると main の e2e 37 本と Rust 側の前提が崩れます。wave5 版は変換器の中に凍結コピーとしてだけ残します。
- **wave5 v3 を `MIGRATIONS` に登録する**: main の v3 と番号が衝突します。Rust にも移行の写しがあり(`repository.rs` の `migrate_project_for_legacy_proof`)、登録すると main の保存データの証明経路が壊れます。
- **`Clip.contentLengthBeats`(明示ループ周期)とドラムクリップのループを main に入れる**: main のループ周期は「最後のノート終端」(`midiClipNaturalPatternLength`)で、MIDI 専用です。別の周期を足すとコーデック、Rust 検証、予算、MIDI 書き出し、ピアノロールの全部に波及します。変換時にループを展開して音を保ちます(§5 の判断 2)。
- **`InstrumentConfig.macros` を型付きフィールドで足す**: main の `InstrumentConfig.params`(数値レコード、キー検証なし)に入れればスキーマ変更が要りません。wave5 自身も版を上げずに足していました。公開ビルドが無く(タグ・リリース 0 件)、旧ビルドが黙って違う音で開く心配もありません。「新データは v11+ 移行で」の原則からの意図的な例外です。
- **`Project.loopRange` を保存する**: main のループはランタイム状態(`store.transport.loopStartBeat` ほか)で、サイクル録音・パンチ・オートメーションがそれに乗っています。
- **wave5 の `apps/studio/src-tauri` を残す**: Rust は `app_version` の 13 行だけで、main の `apps/desktop` が完全に上位です。

## 1. 原則

1. **main のモデルが正**: `automationLanes` / `automationReadState` / `audioRouting` / `tempoMap` / `timeSignatureMap` / `lengthBeats` と `project-codec.ts` / `migrations.ts` に合わせます。発音の正本は `buildScheduleEvents`(ライブと WAV で共用)です。MIDI 書き出しは別経路(`packages/midi-io/src/export.ts`)なので、発音に効く PR は 3 経路の一致テストを必ず付けます。
2. **main の v1→v10 と保存ファイルを壊さない**: 既存の移行関数と `inspectLegacyProjectStructure` の既存分岐は編集しません。最初のスキーマ変更の前に v10 のゴールデン(P04)を固定します。
3. **スキーマ変更 1 回の変更点**(毎回すべて必要):
   - TypeScript: `types.ts`、`factories.ts`(`CURRENT_SCHEMA_VERSION`)、`migrations.ts`、`project-codec.ts`(`decodeCurrentProject` と `inspectLegacyProjectStructure` の版の型)、`validation.ts`
   - Rust: `apps/desktop/src-tauri/src/native_persistence/repository.rs`(`PROJECT_SCHEMA_VERSION`、`migrate_project_for_legacy_proof` の分岐、`validate_project`、`validate_project_versioned_presence`)と `tests.rs`
   - 文書: `schemas/openapi.yaml`、`docs/06_data_model.md`、`docs/11_persistence_protocol.md`、`docs/COMBINED_SPECIFICATION.md`(CI の `docs:combine:check`)
   - 版番号が衝突するので、スキーマ PR は並行させません。
4. **既存ファイルの音を変えない**: 新フィールドは、移行では「今と同じ音」になる値(`swing: 0`、`hiHatChoke: false`)を入れます。
5. **wave5 v3 ファイルの扱い**(推奨):
   - **入口**: wave5 のデータは 2 経路で main に届きます。書き出した JSON と、同一オリジンの localStorage `cts.project.*` です(main は `LEGACY_PREFIX` として読みます)。デスクトップ版は識別子が違い(`com.cts.studio` と `com.composetutor.studio`)、保存領域を共有しません。
   - **検出**: `decodeProject` の `inspectLegacyProjectStructure` より前に `detectProjectFormat(raw)` を置きます。
     - `schemaVersion === 3` のとき、main v3 の必須 5 キー(`lengthBeats` / `tempoMap` / `timeSignatureMap` / `audioAssets` / `automationLanes`)を own-key で数えます。
     - 5 個なら main、0 個なら `wave5-v3`、1〜4 個は推測せず `invalid-project` で拒否します。
     - `wave5-v3` には新しいエラーコード `legacy-wave5-format` を返します。現状でも未知キーか必須欠落で拒否されますが、理由が伝わりません。
     - アプリが書いたファイルなら誤判定しません。wave5 の型はこの 5 キーを持たず、main v3 は 5 つとも必須です。
   - **変換**: `packages/project-model/src/legacy-wave5/` に `convertWave5V3Project(raw) → { project, report }` を置きます。
     - 出力は固定の版(v12)で、以後は通常の移行に乗ります。Rust の移行証明には入れず、新規取り込みとして保存します。
     - wave5 の `migrate.ts` / `serialization.ts`(`normalizeClipDomain`)/ `clipExpand.ts` / `groove.ts` の必要部分を凍結コピーし、`index.ts` からは変換関数だけ公開します。
   - **wave5 v2 は非対応**: main v2 と構造で区別できません(`role` が無いと同形)。「wave5 版で開いて保存し直す」と案内します。v1 は共通祖先なので main の経路のままです。
   - **保証の粒度**: 一致させるのは鳴るイベント(トラック・開始拍・長さ・音高・ベロシティ)とミキサー値です。シンセ・エフェクト・マスター段は両側で別実装なので、波形の一致は保証しません。

## 2. 移植の分類

(a) ほぼそのまま写す / (b) main のモデルで作り直す / (c) 落とす・後回し

| story | 区分 | 理由と main 側の変更先 |
|---|---|---|
| US-000 DOM テスト基盤 | a | main に jsdom / Testing Library が無い。`apps/studio/vite.config.ts`、`tests/setupDom.ts`。既存 131 本は node のまま(プラグマで opt-in) |
| US-001 / 007a / 007b / 007 クリップ長・発音の正・旧移行 | c | main に `clip-resolution.ts` / `midi-clip-loop.ts` / `clip-content.ts` がある。wave5 版は変換器の凍結コピーへ。`legacyClipSettings` / `legacyBarLimit` は捨てる(UI が読んでいない。main は `MAX_PROJECT_LENGTH_BARS = 256`) |
| US-002 Track.role | c | main の `TrackRole`(`general` / `learning.*`)と `learning-track.ts` が勝つ。`drums` は `Track.type` から導く |
| US-003 Undo トランザクション・keymap | b | main は単純スナップショット(`past` / `future`)でキーは `App.tsx` 直書き。`state/store.ts`(`commitProject`)、新規 `state/keymap.ts`、`ShortcutHelpDialog.tsx` |
| US-004 シーク・再生ヘッド | b(小) | `setPosition` は既存。`TimelineRuler.tsx` を足す |
| US-005 拍子統一・曲長 | 拍子 c / 曲長 b | 拍子は `TempoMapEditor.tsx` が上位。曲長変更の UI は main に無い(`lengthBeats` の mutation を足す) |
| US-006 ループ範囲・タップテンポ | b | `tapTempo.ts` は a。ループは main の `setLoopRange` にルーラードラッグをつなぐ。wave5 の再スケジュール系の残課題は対象コードが別なので持ち越さない |
| US-008 / 009 試聴・コードを鳴らす | b | `audio/livePreview.ts` を main の `engine.ts` / `synth.ts` に合わせる。`voicing.ts` は a。main の `chord-realization.ts` と重なるので重複分を落とす【重なりの範囲は未確認】 |
| US-010 トラック管理 | c | `state/trackActions.ts` に全操作あり。MIDI チャンネル上限はテストだけ足す【main の挙動は未確認】 |
| US-011a / 011b / 011 / 012 クリップ操作・全体ビュー | b | main に無いのは分割と D2 / D4 規則。`clip-content.ts` に `splitClip` を足す。`Arranger.tsx` が勝ち、`ArrangeView.tsx` は入れない |
| US-012b 再生中編集 | c(テストだけ a) | main の `playback.ts` は別設計。`playbackLiveEdit` の不変条件をテストとして移す【main の現挙動は未確認】 |
| US-013 セクション操作 | b(後回し) | main ではテンポ・拍子イベント、オートメーション点、オーディオクリップ、テイクフォルダも動かす必要がある。§5 の判断 4 |
| US-014 / 015 ノート編集・加工 | b | `theory-engine/transpose.ts` は a。`PianoRoll.tsx`、`gridMath.ts`、`editorActions.ts`。事後確認は `placedNoteTicks` でなく `buildScheduleEvents` の前後比較にする |
| US-016 曲全体の移調 | b | ノート + `chordTrack` + key。オーディオクリップは動かさず、その旨を表示 |
| US-017 ゴースト・色分け | a + b | `noteColor.ts` は a。表示は `PianoRoll.tsx` |
| US-018 / 019 グルーヴ・チョーク | b(スキーマ v11) | `groove.ts` の純粋関数は a。`Project.swing` と `Project.hiHatChoke` を新設。`events.ts`、`scheduler.ts`、`drums.ts`、`tail.ts`、`schedule-budget.ts`、midi-io `export.ts` |
| US-020 プリセット・マクロ | b(スキーマ変更なし) | `audio/presets.ts`、`macros.ts` を main の `synth.ts` に合わせる。マクロは `instrument.params` の `macroBrightness` / `macroRelease` / `macroWidth` / `macroAttack`、使用時にクランプ |
| US-021 / 022 / 031 伴奏・コード検出・おまかせ | a + b | `comping.ts` / `chord-detect.ts` / `accompaniment.ts` / `drum-patterns.ts` は a。UI は `ChordLane.tsx`、`PianoRoll.tsx`、アシスタント |
| US-023 / 024 PC 鍵盤・Web MIDI | a + b | `keyboardMap.ts`、`platform/webMidi.ts`。US-003 の keymap が前提 |
| US-025 / 036 MIDI 録音・ステップ入力 | b | main の録音ロック(`audioRecordingOperationId` と `recordingAuthorization`)を MIDI にも使う。カウントインは main に無いので `metronome.ts` に足す【grep で見当たらず】。時刻→拍は `secondsToBeatAt` |
| US-026 EQ・コンプ・マスター | c | main の `audio/effects.ts` に 5 種あり、マスターフェーダーも有効。テンポ同期ディレイだけ b(後回し。テンポマップ追従が要る) |
| US-027 / 033 オートメーション | 音量・パン c / 明るさ b(v12) | main のレーンが上位。新ターゲット `track-filter-cutoff` を足す |
| US-034 センド・リターン | c + b(小) | `audioRouting.sends` と `MixerStrip.tsx` の UI あり。足すのは「リバーブ用リターンを 1 操作で追加」だけ。`MAX_RETURN_TRACKS` は入れない |
| US-028 / 035 書き出し強化 | b | main の `wav.ts` は PCM16・44.1kHz 固定。`loudness.ts`、`zipStore.ts` は a。ステムは `renderSelectedTrackToWav` を回す。ZIP 保存は Rust コマンドの追加が要る。範囲書き出しはトランスポートのループを使う |
| US-029 用語集 | a | `glossary.ts`、`GlossaryPanel.tsx`、`Term.tsx` |
| US-030 レッスン・AppEvent | b | `content/daw-course.ts` を main の `AppEventType`(16 種)+ 追加分に合わせる。機能 PR の後 |
| US-032 スペクトラム・チャンネルプリセット | b(後回し) | `metering.ts`、`SpectrumView.tsx`。プリセット値は main のエフェクト params に合わせ直す |
| US-037 E2E | b | 3 本を `*.e2e.ts` に改名(main の `testMatch`)。`piano-roll-viewport` の既存失敗 2 本は持ち込まない |
| US-038 文書同期 | b | 番号が衝突(11〜13 が両側で別文書)。wave5 の 14〜16 はそのまま、11〜13 は main の `docs/08` と `docs/12` に吸収 |
| release:* スクリプト | 一部 a | §4 |

## 3. PR の順序

実装者は ~/.claude/CLAUDE.md §1 に従います。既存コードへの差分は Claude(Sonnet、難所は Opus)、新規モジュールは Codex Sol medium、R3 はレビュー 2 本と `deep-review` です。R3 の受け入れテストは `packages/project-model/tests/acceptance/` と `apps/studio/tests/acceptance/` に置き、実装者は編集しません。

**土台**
| PR | 内容 | 依存 | 等級 |
|---|---|---|---|
| P00 | `docs/07_development_plan.md` に本計画、`docs/16_daw_gap_analysis.md` を取り込み、wave5 に保存用タグ | なし | R1 |
| P01 | DOM テスト基盤(US-000)。追加する依存は `pnpm audit` を通す | なし | R2 |
| P02 | wave5 形式の検出器(§1-5) | なし | **R3** |
| P03 | Undo トランザクションと keymap(US-003)。ドラッグ 1 回が Undo 1 段、録音ロック中は不可のまま、取引中の自動保存は確定後 | P01 | R2 |
| P04 | v10 ゴールデン固定(テストのみ)。既定プロジェクト、全テンプレート、オートメーション・ルーティング・オーディオ入りの見本について、`encodeProjectJson` のバイトと `buildScheduleEvents` のスナップショット | なし | R2 |
| P05 | CI に wave5 の検査 4 本(§4) | なし | R2 |

**純粋モジュール**(並行可、すべて R2)
- P10: theory-engine の `voicing` / `transpose` / `note-role` / `chord-detect`。両側で変わった `chords.ts` / `parse-chord.ts` / `harmony.ts` は、必要な追加 export だけ main 版に足します。
- P11: `comping` / `drum-patterns` / `accompaniment`。
- P12: project-model の `tapTempo.ts`、`groove.ts`、新規 `ticks.ts`(`PPQ = 480`、`beatTick`)。main の `time.ts` は触りません。
- P13: studio の `loudness.ts` / `zipStore.ts` / `noteColor.ts` / `keyboardMap.ts`。
- P14: 用語集(US-029。R1、画面確認 1 段)。

**スキーマ**(直列)
| PR | 内容 | 依存 | 等級 |
|---|---|---|---|
| P20 | v11: `Project.swing`(0〜60)と `Project.hiHatChoke`。再生・WAV・MIDI の 3 経路まで。UI なし | P04, P12 | **R3** |
| P21 | グルーヴの UI: スウィング、強さ付きクオンタイズ、ヒューマナイズ、チョーク切替、12 / 16 ステップ | P20, P03 | R2 |
| P22 | プリセット 10 種以上とマクロ(US-020)。マクロ無しのトラックは現状とバイト一致 | P04 | R2 |
| P23 | v12: `track-filter-cutoff` | P20 | **R3** |
| P24 | リバーブ用リターンを 1 操作で追加(US-034) | なし | R2 |

**編集**(R2、P03 に依存)
- P30: ルーラーのシークとループドラッグ、タップテンポ。
- P31: 曲長の変更 UI。
- P32: クリップ分割と D2 / D4 規則。
- P33: クリップボード、半音・度数移調、スケール適合(P10)。
- P34: レガート、スタッカート、連結、分割、矢印移動、3 連符グリッド、ベロシティランプ(P33)。
- P35: 曲全体の移調。
- P36: ゴーストノートと色分け(R1 相当、画面確認)。
- P37: 試聴基盤とコード試聴(P10)。
- P38: 伴奏パターン(P11)。
- P39: コード検出の UI。
- P3A: 伴奏おまかせ(P21, P38)。
- P3B: 再生中編集の不変条件テスト。

P32〜P34 はプロジェクトメモの規則に従います。領域の上限チェック、`buildScheduleEvents` の前後比較、BLOCK 2 連続で実装者交代です。

**入力・録音**
- P40: PC 鍵盤演奏とスケールロック(R2。P03, P37)。
- P41: Web MIDI 入力(R2)。
- P42: MIDI 録音(**R3**。P21, P40)。
- P43: ステップ入力と「今の演奏を拾う」(R2)。

**書き出し**(R2)
- P50: 48kHz・24bit・ディザ。16bit・ディザ OFF は現行 main とバイト一致。
- P51: ラウドネス測定とノーマライズ。
- P52: ステム ZIP。`native_files.rs` に `file_export_zip`、Rust テスト、`capabilities/main.json`。
- P53: ループ範囲の書き出し。
- P54: MIDI のプログラムチェンジと調号。

**学習・仕上げ**
- P60: AppEvent 拡張と DAW 操作コース(R2)。
- P61: E2E 3 本(R2)。
- P62: 文書の最終同期(R1)。
- P70: wave5 v3 変換器と取り込み UI(**R3**。P20, P22, P23)。

**R3 の受け入れ基準**(テスト名の粒度)

P02 検出器:
- `detect_mainV3_withAllFiveMapKeys_isMain`
- `detect_v3_withNoMapKeys_isWave5V3`
- `detect_v3_withOneToFourMapKeys_isRejectedAsInvalidProject`(1〜4 個の全組み合わせ)
- `detect_inheritedKeysOnPrototype_areNotCounted`
- `detect_nonV3Versions_areAlwaysMain`(1, 2, 4〜10)
- `decode_wave5V3_returnsLegacyWave5FormatCode_andNeverCallsMigrateProject`
- `decode_wave5V3_withOnlyBaseFields_isStillDetected`(swing も role も無い最小ファイル)
- `decode_everyMainFixture_v1ToV10_resultUnchanged`(検出器の追加前後で一致)
- `localStorageLegacyScan_wave5Snapshot_isReportedUnsupported_andNotDeleted`
- `localStorageLegacyScan_wave5BackupKeys_doNotCrash`(`cts.project.backup.v2`、`cts.projectBackup.<id>`)
- Rust: `legacy_proof_rejects_wave5_v3_snapshot`

P20 v11:
- `migrate_v10ToV11_addsSwingZeroAndChokeFalse_only`(他のキーは不変)
- `migrate_v1ThroughV10Goldens_scheduleEventsUnchanged`(P04 と照合)
- `createProject_defaultsSwingZero_chokeTrue`
- `validate_swing_rejectsNegative_NaN_above60`
- `validate_hiHatChoke_rejectsNonBoolean`
- `codec_v10File_withSwingKey_isUnknownKey`
- `codec_v11File_missingSwing_isRejected`
- `schedule_swing_delaysOnlyOddSixteenthsOnGrid_forMidiNotes`(3 連符位置は動かない)
- `schedule_swing_drumClipWithOwnSwing_usesClipSwingOnly`(二重にかからない)
- `schedule_swing_drumClipWithoutOwnSwing_followsProjectSwing`
- `schedule_swungOnsetAtOrPastClipEnd_isDropped`
- `schedule_choke_closedHatStopsEarlierOpenHat_sameTrackOnly`
- `schedule_choke_sameTickClosedHats_picksEarliestSounding`(wave5 US-019 の 1 tick 未満のずれを解消)
- `schedule_chokeFalse_matchesV10Golden`
- `threePaths_live_wav_midi_agreeWithinOneTick_withSwing30And60`
- `budget_swingDelay_isCountedInSongTail`
- `transportLoop_withSwing_doesNotDoubleTriggerAtLoopStart`
- Rust: `migrate_v10_to_v11_matches_typescript`、`validate_project_v11_requires_swing_and_choke`

P23 v12:
- `migrate_v11ToV12_isVersionOnly`
- `target_cutoff_supportedOnlyForInstrumentTracks`(ドラム・バス・オーディオ・マスターは不可)
- `validate_cutoffValue_isOctaveOffset_withinPlusMinusLog2Of10`
- `validate_oneCutoffLanePerTrack`
- `render_cutoffLaneAllZero_isByteIdenticalToNoLane`(WAV)
- `render_cutoffLane_appliesAsDetuneCents_1200PerOctave`
- `readState_trackDisabledOrBypassed_cutoffLaneIgnored`
- `removeTrack_removesItsCutoffLane`
- `codec_v11File_withCutoffTarget_isRejected`
- Rust: `validate_project_v12_accepts_cutoff_target`、`validate_project_v11_rejects_cutoff_target`

値はオクターブ差(log2 倍率)で保存します。main の `linear` 補間のままで、wave5 の対数補間と同じ曲線になります。

P42 MIDI 録音:
- `record_start_takesRecordingLock_editsAndUndoRejected`
- `record_whileAudioRecordingActive_isRejected`(逆も)
- `record_countIn_oneBar_noNotesCapturedBeforeDownbeat`
- `record_timestamps_convertViaTempoMap_acrossTempoChange`
- `record_overdub_keepsExistingNotes`
- `record_replace_removesOnlyNotesInsideRecordedRange`
- `record_autoQuantize_usesSongAbsoluteGrid`
- `record_loop_requiresIntegerTickBounds_andAtLeastOneBeat`
- `record_noteHeldAcrossLoopEnd_isCutAtLoopEnd`
- `record_stop_commitsOneUndoStep`
- `record_projectReplacedDuringTake_commitsTakeFirst`
- `record_droppedNotes_areCounted_notWholeTakeDiscarded`
- `record_resultPassesEncodeProjectJson`

P70 変換器(wave5 の d85f796 で `soundingEvents` を実行して作った固定 fixture が正解):
- `convert_output_passesDecodeCurrentProject_andRustValidate`
- `convert_isDeterministic_sameInputSameBytes`
- `convert_eventParity_defaultProjectAndAllWave5Templates_withinOneTick`
- `convert_bpmAndMeter_becomeSingleTempoAndSignatureEvents_lengthBeatsMatches`
- `convert_roles_chordsBassMelody_mapToLearningRoles_duplicatesBecomeGeneral_drumsBecomeGeneral`
- `convert_volumeLane_valueIsFaderTimesLane`
- `convert_panLane_valueIsPanPlusLaneClamped_withPointsAtSaturation`
- `convert_cutoffLane_valueIsLog2`
- `convert_equalBeatPoints_becomeStepWithin1Over960Beat`
- `convert_sends_becomePostFaderAudioSends_busRoutedToMaster`
- `convert_loopWithoutContentLength_becomesLoopFalse`(main ではループ扱いで繰り返してしまうため)
- `convert_loopWithContentLength_isUnrolled_eventParity`
- `convert_linkChain_sameTrackSameType_becomesOneHopAlias`
- `convert_linkAcrossTracks_isMaterializedCopy`
- `convert_brokenOrCyclicLink_isSilentClip_andReported`
- `convert_swing_copied_drumClipsHaveNoOwnSwing`
- `convert_macros_moveToInstrumentParams`
- `convert_loopRange_legacyBarLimit_legacyClipSettings_dropped_andReported`
- `convert_overLimit_stepsPerBarAbove128_orEventsOverBudget_failsWithReason_noPartialOutput`
- `convert_audioClips_becomeUnresolvedAssets`(main の v2→v3 と同じ扱い)
- `convert_doesNotMutateInput`

## 4. 重なりの裁定

| 領域 | 勝つ側 | 取り込むもの |
|---|---|---|
| オートメーション | main(プロジェクト直下のレーン、Read ゲート、書き込みモード、絶対値) | 明るさターゲット。wave5 の `AutomationLane.tsx` / `automationSchedule.ts` は入れない。値の意味が違う点(wave5 の音量はフェーダーとの積、パンは和)は変換器で吸収 |
| センド | main(`audioRouting`、pre / post、bus 数は自由) | 初心者向けの 1 操作リターン追加と「リターン」の説明文 |
| ループ / サイクル | main(ランタイム状態) | ルーラードラッグ、セクションループ、範囲書き出し、MIDI ループ録音 |
| デスクトップ構成 | main(`apps/desktop`) | Rust は何も移さない。ファイル入出力は `platform/nativeFileGateway.ts` 経由で、`plugin-fs` は使わない |
| CI | main(`ci.yml` の行列、`release.yml`、auto-merge、dependabot) | `checkNoHiddenNetwork` / `checkReleaseSecrets` / `checkSourceAssetPolicy` / `checkSize`(web)を `web` ジョブへ。QA ログ・リリースノート・スモーク計画などの文書系は入れない |
| トラックの役割 | main | なし(`drums` は型から導く) |

## 5. 壊れうる箇所、検知方法、判断が要る点

**壊れうる箇所と検知**
- **v10 以前のファイルの音が変わる**: P04 のゴールデンを v11 / v12 の受け入れテストで照合します。
- **TypeScript と Rust の移行・検証がずれる**: 各スキーマ PR に Rust テストを入れ、CI の `desktop` 行列の `cargo test` で見ます。
- **スウィングが二重にかかる**: main のドラムはクリップ単位(`drumGroove.swing`、ステップ偶奇)、wave5 は曲単位(曲頭からの 1/16、最大 60%)で、定義が違います。P20 の 2 本のテストで固定します。
- **3 経路(ライブ・WAV・MIDI)がずれる**: MIDI だけ別経路なので、P20 / P32 / P42 に一致テストを入れます。
- **イベント上限の差**: wave5 は 10 万、main は実行時 2 万・WAV 1 万です。大きな曲は、変換できても再生や書き出しができません。変換器が事前確認で止めます。
- **`store.ts`(4190 行)と `editorActions.ts` への差分**: 両側で大きく変わっているので、wave5 版の貼り付けは禁止です。main 版に関数単位で足します。
- **エフェクトの params 名**: `effects.ts` は両側が独立に作りました。変換時は対応表に無いエフェクトを無効化して報告します【対応表は未作成】。
- **未確認の前提**: main の post-fader の分岐点(`this.output`)がパンの後かどうか。P70 の一致テストで確かめます。

**ユーザーの判断が要る点**
1. **変換器の範囲**: 公開ビルドは無いので、wave5 のファイルは手元にしかありません。推奨は「検出器(P02)は必須、変換器(P70)は最後、UI は JSON 読み込み時の確認ダイアログだけ」です。残したい曲が無ければ P70 を丸ごと省けます。
2. **明示ループ周期とドラムループ**: 推奨は入れずに変換時に展開です(繰り返しの編集連動は失われます)。入れるならスキーマ v13 と R3 が 1 本増えます。
3. **スウィングとチョークの規則**: 推奨は「曲のスウィングが既定で、ドラムクリップ側が 0 より大きければそちらが優先」、チョークは新規プロジェクトで ON・既存は OFF です。テンプレートを ON にすると、そのテンプレートの見本の音が変わります。
4. **セクションの移動・複製・削除(US-013)**: main ではテンポ、オートメーション、オーディオ、テイクも動かす R3 の大物です。推奨は今回の列から外し、P32 までを先に入れてから別計画にします。
5. **Web MIDI(US-024)**: main は macOS も対象ですが、WKWebView は Web MIDI に対応していないはずです【実機は未確認】。「Windows / Linux のみ、無い環境では項目を隠す」でよいか確認が要ります。
6. **US 番号の無い Wave 3a〜5a の機能**: `mockCoach`、`feedback.ts`(714 行)、スタート画面、診断ログ、書き出し履歴は今回の表に入れていません。要るなら別に棚卸しします。

## 6. ユーザー決定(2026-11-28)
1. 変換器: 判別(P02)は最初に入れる。変換器(P70)は最後に作り、JSON 読み込み時の確認ダイアログだけにする。
2. 明示ループ周期とドラムクリップのループ: main には入れない。変換時に展開する(v13 は作らない)。
3. スウィング: 曲の値が既定で、ドラムクリップの値が 0 より大きいときはそちらを優先する。チョークは新規の曲で ON、既存の曲は OFF。
4. セクション操作(US-013): 今回の列から外し、別の計画にする。
5. Web MIDI: 推奨案(Windows / Linux のみ、未対応環境では項目を隠す)で進める。番号のない Wave 3a〜5a の機能(コーチ、スタート画面、診断ログ、書き出し履歴)は、移植の終盤に別途棚卸しする。
