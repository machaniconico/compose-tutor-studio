# 16. 主要DAWとの機能ギャップ分析(訂正版)

調査日: 2026-10-31 / 対象: `wave5/desktop` @ 7c84674 / 初版の批評(Opus critic、判定 REVISE)を反映した訂正版。実行計画は `.omc/prd.json`(US-000〜US-038)。

## 1. 結論

- **最大の欠落は高度な機能ではなく、曲を組み立てる土台そのもの**です。トラックの追加と削除、クリップの配置、ループ範囲の指定、拍子の変更、**再生位置の移動(シーク)**ができません。これらが揃わないと、上位機能を載せても 8〜16 小節の曲を完成させる導線が閉じません。
- 初版で見落としていた初心者必須の 2 件を追加しました: **シークと再生ヘッド**(US-004)、**曲全体の移調**(US-016)。
- **コードが鳴らない問題**は初版で第 3 段階まで届かなかったため、「コードを鳴らす・ノートにする」(US-009)を土台直後に前倒ししました。
- 候補は初版 20 件 → 分割・追加・削除の結果 **38 story** です(P0 土台 12、P1 中核 16、P2 降格 8、仕上げ 2)。ユーザーの依頼は「DAW 機能の実装」なので、過剰スコープは却下ではなく**分割と降格**で扱い、降格した機能(センド/リターン、スペクトラム、ステム/LUFS/ディザ/24bit、演奏の回収、ステップ入力)も実装対象に残しています。削除したのはユークリッドリズムだけです(ドラムパターンと伴奏パターンに集約)。
- プロ向けのオーディオ編集、VST、クラウド連携、大規模モデルが必要な機能は採用しません(第 6 節)。
- UI の言語は**日本語**です(`TransportBar.tsx` の aria-label などで確認)。新しい文言も初心者向けの日本語で統一します。

## 2. 検証で判明した、棚卸しの訂正と追加事項

「無い」とされた項目は grep とコード確認で再検証しました。批評で指摘された既存機能の誤判定 4 件(マスターフェーダー、コードパッド、Alt+ドラッグ複製、MIDI のループ展開)を含めて訂正しています。

| 項目 | 検証結果 |
|---|---|
| ループ | 棚卸しの「full」は誤りで、**実質無効(stub)**。`loopStartBeat/EndBeat` は store.ts:223-224 で 0 に初期化された後、設定する処理がない |
| シーク・再生ヘッド | **無い**。`setPosition` は store.ts:574 に定義があるが `features/` からの呼び出しが 0 件。`playhead` の grep も 0 件。位置が見えるのは `TransportBar.tsx:217` の数値だけ。F08 の「再生位置を基準に貼り付け」、F12 の「カーソル位置に追加」、F14 の途中からの録音はこれに依存する → US-004 を P0 に追加 |
| 曲全体の移調 | **無い**。`setKey`(store.ts:361)はキーの値を変えるだけで、ノートもコードも動かない → US-016 を追加 |
| 拍子の計算 | **既存の不整合を発見**。`factory.ts:118` は `分子×(4/分母)`、`events.ts`、`Arranger`、`ChordLane`、`DrumGrid`、`PianoRoll:130,457`、`coach/mockCoach.ts:54`、tutorial-engine `checker.ts:154` は分子のみで計算する。6/8 では 1 小節が 3 拍と 6 拍にずれる。さらに `midi-io/export.ts:145` はドラムのステップ長を `4/stepsPerBar` に固定しており、4/4 以外では MIDI と音声のドラム位置がずれる。`DRUM_PATTERNS`(editorActions.ts:600)と checker の `stepsPerBar/4`(checker.ts:414)も 4/4 前提 |
| コードレーンの音 | 確定。`src/audio/` に `chordTrack` の参照がなく、コードは**鳴らない**。既定プロジェクトのトラックは空クリップ、テンプレートもコードをイベントとして持つだけ(`templates.ts:242`) |
| コードパッド | 初版の「無」は**誤り**。`ChordPopover.tsx` と `paletteData.ts` にダイアトニック、進行、借用、ドミナントのタブと `suggestNextChords` がある。不足は発音だけ → 新規 `ChordPads.tsx` は作らず、`ChordPopover` に試聴を追加する(US-009) |
| コード検出 | grep のヒットは `detectChordTensions` のみ。ノートからコードを判定する機能はない |
| マスターフェーダー・dB 表示 | 初版の「無」は**誤り**。`MixerStrip.tsx:81` がマスターにも ChannelStrip を描画し、音量スライダーと `gainToDbLabel` がある。ただし**音には効かない**(`graph.ts:32` がマスターを除外、`engine.ts:53` と `wav.ts` でゲインは 1 固定)。`defaultProject.ts` の master volume は 0.9 なので、単純に連動させると既存プロジェクトが約 0.9 dB 小さくなる → 移行時に master.volume を実効値 1 に正規化する(US-001) |
| コピー/複製 | 初版の「無」は**誤り**。Alt+ドラッグ複製がある(`editorActions.ts:322`、`PianoRoll.tsx:243`)。クリップボード(Ctrl+C/V)と移調は無い |
| ドラッグと Undo | `PianoRoll.tsx:212` が移動中に `updateNote` を呼び、store.ts:427 に接続する。ドラッグが複数の Undo 段に分かれる。さらに `MixerStrip.tsx:173`、`TrackList.tsx` の音量、エフェクトスライダー、`TransportBar.tsx:229` の BPM、タイトル入力、`Arranger.tsx:135` も onChange ごとに `commitProject` を呼ぶ。`HISTORY_CAP = 100`、step 0.01 なので 1 回のフェーダー操作で履歴全体が流れうる |
| クリップ | `events.ts:72-100` は `lengthBeats`、`loop`、`aliasOf` を無視する。一方 `midi-io/export.ts:109-120` は**既に** `clip.loop` を独自に展開し、周期は `notePatternLength`(ノート終端)。ドラムは MIDI でループしない(`export.ts:138-149`)。3 経路の統一では export.ts の独自展開を削除する(US-007) |
| クリップ相対拍 | 既存エディタは「クリップは拍 0 から始まる」前提。`PianoRoll.tsx:483,505`(コードは絶対拍、ノートは相対拍を同じ軸に描画)、`PianoRoll.tsx:130`(編集範囲がプロジェクト全長)、`useInspection.ts:122` と `mockCoach.ts:33`(`chordAtBeat(note.startBeat)` が相対拍のまま)、`editorActions.ts:409-415,542-548`(生成結果が絶対拍のまま `replaceClipNotes` へ)、`checker.ts:172`(aliasOf クリップの内容を数えない) → US-011 で一括修正 |
| スキーマ | `MIGRATIONS` は空で、バージョン 1 のまま。`schemaVersion: 1` の直書きが `defaultProject.ts:192`、`sampleProject.ts:338`、`factory.ts:125` にある。アプリの実際の起動経路は `store.ts` → `state/defaultProject.ts` なので、factory だけ直しても新規プロジェクトが v1 のまま保存される。`projectFileImport.ts:111` と `persistence.ts:140` は `deserializeProject` 経由で移行が動く。`persistence.ts:267` の `isProjectLike` は別の形状チェック |
| トラック名への依存 | `tutorial-engine/goals.ts:80,100`、`checker.ts:168` はトラック名の完全一致で判定。`editorActions.ts:102-108` も名前で検索。改名で壊れる → `Track.role` を追加し role 優先で解決(US-002) |
| MIDI チャンネル | `export.ts` の `allocChannel` に上限がない。チャンネル 16 以上で `0x90 \| channel` が別のステータスバイトになり MIDI が壊れる → 0〜15(9 除く)で循環(US-010) |
| MIDI のトラック名 | **実装済み**(`export.ts:162`)。初版 F18 の基準から外した |
| 音色プリセット | 3 種 + 別名(`synth.ts:36-37`)。MIDI 読み込みは `preset: 'piano'` を指定する(`editorActions.ts:488`)が warmPad にフォールバックする。互換テストに全別名を含める(US-020) |
| ドラムパターン・進行テンプレート | **有**(`DRUM_PATTERNS`、`paletteData.ts` の進行)。初版マトリクスに載っていなかった |
| 用語集 | 存在しない。PRD の P1 ペルソナは「専門用語のインライン解説」を要求している |
| ショートカット | ピアノロールが `S`/`C`/`Q` を占有しており、PC キーボード演奏と衝突する。キーマップの一元化が先に必要 |
| 24bit/48kHz | `docs/02:255-256` では 48kHz は仕様内だが、24bit は「後続検討」。初版の「仕様にある 48kHz/24bit」は不正確 |
| 0 件を確認 | AudioWorklet、getUserMedia、requestMIDIAccess、decodeAudioData、swing、addTrack 系、addClip 系、setTimeSignature、tempoMap、ghost、count-in、triplet、arpegg、LUFS、playhead |

## 3. 機能マトリクス(訂正版)

判定の凡例: **有** = 同等以上、**一部** = 不足あり、**無** = 未実装。候補列は `.omc/prd.json` の story ID。

### 3.1 構成・編集の土台

| 機能 | 主な製品 | 本アプリ | 判定 | story |
|---|---|---|---|---|
| シーク、再生ヘッド | 全DAW | 無(数値表示のみ) | 実装 | US-004 |
| トラック追加/削除/名前/順序 | 全DAW[^fl-pl] | 無 | 実装 | US-010 |
| タイムライン上のクリップ配置/分割/複製 | 全DAW[^fl-pl] | 無(データ型のみ) | 実装 | US-007, US-011, US-012 |
| ループ範囲をルーラーで指定 | FL Studio ほか[^fl-pl] | 無(トグルのみ) | 実装 | US-006 |
| 拍子/長さの変更 | 全DAW | 無 | 実装 | US-005 |
| セクションの移動/複製(中身ごと) | Cubase, Studio One, Logic, GarageBand[^arr][^so-arr][^gb-mark] | 一部(ラベルのみ) | 実装 | US-013 |
| スクラッチパッド/プロジェクト代替案 | Studio One, Logic[^so-sp][^lp-alt] | 無 | 見送り | - |
| クリップランチャー | Logic, Live, Bitwig[^lp-ll][^al-sess] | 無 | 却下 | - |
| トラックスタック/グループ | Logic, Reaper[^lp-ts] | 無 | 却下 | - |

### 3.2 ノート編集

| 機能 | 主な製品 | 本アプリ | 判定 | story |
|---|---|---|---|---|
| スケール強調/スナップ | Cubase, FL, Live[^cb-scale][^fl-pr][^al-midi] | 有 | - | - |
| コピー/ペースト/移調 | 全DAW | 一部(Alt+ドラッグ複製のみ) | 実装 | US-014 |
| 曲全体の移調 | 全DAW | 無(キー値のみ変わる) | 実装 | US-016 |
| 選択音をスケールへ合わせる | Live[^al-midi] | 無 | 実装 | US-014 |
| レガート/スタッカート、連結/分割 | Live, FL[^al-tools][^fl-pr] | 無 | 実装 | US-015 |
| 3連符グリッド | 全DAW | 無 | 実装 | US-015 |
| ゴーストノート | FL, Live, Bitwig[^fl-pr][^al-midi] | 無 | 実装 | US-017 |
| ノートの色分け | Bitwig[^bw-note] | 一部 | 実装 | US-017 |
| 鍵盤クリック試聴、音域の拡大 | 全DAW | 無(C2〜C6固定) | 実装 | US-008 |
| 強さ指定クオンタイズ、ヒューマナイズ | Live[^al-midi] | 一部(開始位置のみ) | 実装 | US-018 |
| スウィング、グルーヴ | FL, Live, Logic[^fl-cr][^al-gr] | 無 | 実装 | US-018 |
| ベロシティのランプ/ランダム | Live[^al-midi] | 一部 | 実装 | US-015 |
| ノート確率 | Live, Bitwig[^bw-op] | 無 | 却下 | - |
| CC/ピッチベンドレーン、Note Expression、MPE | Cubase, Bitwig[^cb-ne] | 無 | 却下 | - |
| ロジカルエディタ | Cubase[^cb-le] | 無 | 却下 | - |

### 3.3 和声・作曲支援

| 機能 | 主な製品 | 本アプリ | 判定 | story |
|---|---|---|---|---|
| コードトラック、次のコード提案、進行プリセット | Cubase, Logic, Studio One[^cb-ct][^cb-ca][^lp-ch][^so-ch] | 有(強み) | - | - |
| コードパッド(候補一覧と提案) | Cubase[^cb-pad] | 一部(ChordPopover にタブと提案あり。発音なし) | 実装(試聴追加) | US-009 |
| コードを鳴らす、ノートにする | 全DAW | 無 | 実装 | US-009 |
| ボイシング、滑らかな声部連結 | Cubase[^cb-voi][^cb-adapt] | 無 | 実装 | US-009 |
| パターン伴奏、アルペジオ | Cubase, Logic, Live[^cb-pp][^gb-arp][^al-tools] | 無 | 実装 | US-021 |
| ノートからコード検出 | Logic, Studio One[^lp-det][^so-ch] | 無 | 実装 | US-022 |
| ドラムパターン | 全DAW | 有(`DRUM_PATTERNS`) | - | - |
| 生成演奏者(複雑さ/強さ/再生成/MIDI化) | Logic, GarageBand[^lp-sp][^lp-spe] | 一部(ベース/メロディ生成) | 実装 | US-031 |
| ユークリッドリズム生成 | Live[^al-tools] | 無 | 却下(ドラムパターンと伴奏パターンに集約) | - |
| スケールイベント(途中転調) | Cubase[^cb-sev] | 無 | 見送り | - |
| コード追従の自動再ピッチ | Studio One, Logic[^so-harm] | 無 | 却下 | - |

### 3.4 入力・録音

| 機能 | 主な製品 | 本アプリ | 判定 | story |
|---|---|---|---|---|
| PC キーボード演奏、スケールロック | 全DAW | 無 | 実装 | US-023 |
| MIDI キーボード入力 | 全DAW | 無 | 実装(任意の追加機能) | US-024 |
| カウントイン、オーバーダブ | Live, Logic[^al-rec] | 無 | 実装 | US-025 |
| ステップ入力 | Logic[^lp-step] | 無 | 実装(P2) | US-036 |
| 録音せず弾いた音の回収 | Live, Reaper[^al-rec][^rp] | 無 | 実装(P2) | US-036 |
| 音声録音、テイク管理、コンピング | Logic, Live, Reaper[^lp-comp][^al-comp] | 無 | 却下 | - |

### 3.5 音色・ドラム

| 機能 | 主な製品 | 本アプリ | 判定 | story |
|---|---|---|---|---|
| 音色選択、簡単マクロ | Logic, GarageBand, Live[^lp-sc][^al-rack] | 無(3プリセット、UIなし) | 実装 | US-020 |
| ハイハットのチョーク、12/16 ステップ | Live, Bitwig[^bw-cont] | 無 | 実装 | US-019 |
| サンプルベースのドラム、音源ブラウザ | Cubase, Logic, Live[^cb-dm][^lp-loop][^al-new] | 無 | 却下 | - |
| ラック、モジュレータ | Live, Bitwig, Cubase[^al-rack][^bw-mod][^cb-mod] | 無 | 却下 | - |

### 3.6 ミックス

| 機能 | 主な製品 | 本アプリ | 判定 | story |
|---|---|---|---|---|
| EQ、コンプレッサー | 全DAW | 無(型だけ予約) | 実装 | US-026 |
| マスターフェーダー | 全DAW | 一部(UI あり、音に未反映のバグ) | 実装 | US-026 |
| dB 表示 | 全DAW | 有(`gainToDbLabel`) | - | - |
| スペクトラム表示 | Cubase[^cb-sa] | 無 | 実装(P2) | US-032 |
| センド/リターン | Live ほか[^al-mix] | 無 | 実装(P2) | US-034 |
| オートメーション(音量) | Logic, Live, Bitwig[^lp-auto][^bw-auto] | 無 | 実装 | US-027 |
| オートメーション(パン・フィルター) | 同上 | 無 | 実装(P2) | US-033 |
| チャンネルストリッププリセット | Logic, GarageBand[^lp-cs] | 無 | 実装(P2) | US-032 |
| LUFS計測 | Reaper[^rp] | 無 | 実装(P2、書き出し時のみ) | US-035 |

### 3.7 書き出し・学習

| 機能 | 主な製品 | 本アプリ | 判定 | story |
|---|---|---|---|---|
| 48kHz、範囲指定 | 全DAW | 無(16bit/44.1kHz固定) | 実装 | US-028 |
| MIDI プログラムチェンジ、調号 | 全DAW | 無 | 実装 | US-028 |
| MIDI トラック名 | 全DAW | 有(`export.ts:162`) | - | - |
| 24bit、ディザ、ステム書き出し、ノーマライズ | 全DAW | 無 | 実装(P2) | US-035 |
| 用語集 | GarageBand[^gb-gl] | 無 | 実装 | US-029 |
| レッスン、演習、進捗 | GarageBand[^gb-les] | 有(強み) | 拡張 | US-030 |
| 演奏の採点レッスン | GarageBand[^gb-score] | 無 | 却下 | - |

## 4. 実装順序

`.omc/prd.json` の priority と dependsOn が正本。概要:

1. **土台(P0)**: US-000 DOM テスト基盤 → US-001 スキーマ v2 → US-002 Track.role → US-003 Undo トランザクション/キーマップ → US-004 シーク/再生ヘッド → US-005 拍子統一 → US-006 ループ範囲 → US-007 クリップ展開 → US-008 試聴基盤 → **US-009 コードを鳴らす** → US-010 トラック管理 → US-011 クリップ操作と相対拍 → US-012 曲全体ビュー。
2. **編集(P1)**: US-013 セクション → US-014 クリップボード/移調 → US-015 ノート加工 → US-016 曲全体移調 → US-017 ゴースト/色分け → US-018 グルーヴ → US-019 チョーク。
3. **音と入力(P1)**: US-020 音色 → US-021 伴奏パターン → US-022 コード検出 → US-023 PC 演奏 → US-024 Web MIDI → US-025 録音。
4. **ミックスと出口(P1)**: US-026 EQ/コンプ/マスター → US-027 音量オートメーション → US-028 書き出し(48kHz/範囲/PC/調号)。
5. **降格(P2、実装は維持)**: US-029 用語集 → US-030 レッスン → US-031 伴奏おまかせ → US-032 スペクトラム/プリセット → US-033 パン/フィルターのオートメーション → US-034 センド/リターン → US-035 ステム/LUFS/24bit → US-036 ステップ入力/演奏の回収。
6. **仕上げ**: US-037 E2E と手動 QA、US-038 文書の最終同期。

`store.ts`、`editorActions.ts`、`mutations.ts`、`docs/02` は多くの story が触るため、ファイルロック(touchedFiles)による並列実行はほぼ直列になります。これは意図した結果で、`docs/` の更新は各 story 内で行います(Definition of Done「For every task」に従う。初版の「ウェーブ単位でまとめる」は撤回)。

## 5. 主なリスク

- **既存プロジェクトの互換性**: US-001 のマイグレーションは本アプリで初めて動きます。移行前の JSON を `cts.project.backup.v1` に退避し、クリップ長を切り上げ、master volume を実効値 1 に正規化して、US-007 のスナップショットテストで全テンプレート・既定・サンプルの音が変わらないことを確認します。
- **ライブとオフラインの一致**: US-007、US-018、US-019、US-026、US-027、US-034 はすべて再生と WAV 書き出しで同じ純粋関数(expandClip、applySwing、applyHiHatChoke、masterChain、buildParamSchedule)を通します。チョークは発音ノードの持ち回りではなくイベント構築時に長さを切ります。
- **再生中の編集**: 現状はイベントを再生開始時に一度だけ展開するため、新機能でも編集の反映は次回の再生からになります。
- **Web MIDI**: Windows(WebView2)では利用できる見込みですが、Tauri の capabilities/CSP に該当設定が無く、実機未確認。US-024 は任意の追加機能とし、US-023 の PC キーボード演奏を主経路にします。
- **localStorage の容量**: 全データが localStorage に保存され、オートメーションや録音でプロジェクトが大きくなった時の上限(一般に 5MB 前後)は数値検証していません。当面は JSON が小さい見込みですが、既知リスクとして記録します。US-001 のバックアップ退避は QuotaExceededError を握りつぶして続行します。docs/01 3.5 の SQLite 保存(`src-tauri/src/lib.rs` には `app_version` のみ)は別案件です。
- **トラック名への依存**: US-002 で `Track.role` を導入し、レッスン判定・アシスタントは role 優先、名前はフォールバックにします。
- **note.moved の発火回数**: US-003 でドラッグを 1 トランザクションにすると発火が 1 回になります。回数を数えるレッスン目標があれば US-030 で調整します。

## 6. 採用しない機能

| 機能 | 理由 |
|---|---|
| VST3/AU ホスティング | CLAUDE.md がライセンスとクラッシュ分離の別途承認まで禁止している |
| チャンネルストリップやトラックテンプレートの他社プリセットの再現 | UI、プリセット、文言の複製は禁止。US-032 の自作プリセットのみ採用する |
| ループブラウザ、サンプルドラムマシン、類似サンプル検索、音源ライブラリ | ライセンスが明記された音源を同梱できる見込みがなく、音源配布も伴う。ドラムと音色は合成で対応する |
| Ableton Link などのネットワーク同期、クラウド連携 | 外部通信は明示的なスコープ外で、既定でデータをローカルに保つ方針にも反する |
| 実在アーティスト風の生成 | 生きている作家の模倣を禁止する方針に反する。US-031 は固定の雰囲気名のみで自由入力欄を持たない |
| ステム分離 | モデルが重く、Web Audio と決定的なロジックの制約に合わない。権利面のリスクもある |
| オーディオから MIDI への変換、音声ハーモニー生成 | 解析モデルが重く、オーディオトラックも前提になる |
| 音声ピッチ補正、フォルマント編集、オーディオクオンタイズ | オーディオトラックと高度な DSP が前提で、8〜16 小節の MIDI 作曲の目的から外れる |
| タイムストレッチ、ワープ、Flex、トランジェント編集、テンポ検出、スライス | オーディオ素材を扱うプロ向け機能で、Web Audio 標準では実現が難しい |
| 音声録音、テイクレーン、コンピング | 音声データの保存が localStorage の容量上限に当たる。US-025 の MIDI 録音で目的の大半を満たす |
| ユークリッドリズム | 批評を受けて削除。ドラムパターン(既存)と伴奏パターン(US-021)、伴奏おまかせ(US-031)に集約する |
| オーディオトラックの読み込み(見送り) | docs 上は Should だが、localStorage では音声を保持できず、ZIP プロジェクトまたは IndexedDB/SQLite の保存基盤が先に必要 |
| クリップランチャー、シーン、フォローアクション(見送り) | 初心者価値は高いが、再生開始時に一括展開する現行スケジューラの作り直しが必要。8〜16 小節では US-012 と US-013 で試行できる |
| テンポマップ、テンポランプ(見送り) | メトロノーム、MIDI、位置表示まで影響する。短い曲での必要性が低く、単一テンポと US-005 で足りる |
| スケールイベント、途中転調(見送り) | スナップ、解析、提案のすべてに時間軸が必要になる。8〜16 小節では単一キーで足りる |
| モード(ドリアンなど)の追加(見送り) | 実装は小さいが、コード提案や教材の整合性確認が伴う。P3 向けとして別途扱う |
| スクラッチパッド、プロジェクト/トラック代替案(見送り) | localStorage の容量と保存基盤に依存する。当面は US-013 の複製とプロジェクト保存で代替する |
| ロジカルエディタ、ノート条件検索 | 初心者価値が低く、抽象度が高い |
| Expression Map、Note Expression、MPE、CC/ピッチベンドレーン | 初心者価値が低く、内蔵シンセでは効果が限られる。ノートのデータモデルも複雑になる |
| ノート確率、タイムワープ、シャッフル/ミラー | 初心者価値が低い、または決定的な再生の学習に反する |
| 描画によるメロディ生成 | 生成機能は US-031 に集約し、優先度が低い |
| Rack、Macro Variations、モジュレータ、チェーン分岐、ゾーン | プロ向けの音作り機能で、US-020 の 4 マクロで初心者向けの目的を満たす |
| トラックスタック、グループ、VCA、エフェクトコンテナ | 8〜16 小節の小規模な曲には不要で、初心者価値が低い |
| Razor 編集、リップル編集 | US-011〜US-013 の分割とセクション操作で主要な用途を満たす |
| マイクロチューニング、ネスト、Project Bay、トラックディレイ | 初心者価値が低く、目的から外れる |
| 楽器演奏の採点レッスン、速度調整、チューナー | 本製品の目的は演奏練習ではなく作曲の学習 |
| 実 LLM の AI コーチ接続 | DAW 機能の差分ではなく、同意フローと外部通信の別途承認が必要 |

## 7. 設計判断(批評の Open Questions への回答)

- **AudioWorklet への移行は見送り**: 本アプリの再生は AudioContext 上のスケジュール済み OscillatorNode/GainNode/BiquadFilter 等で構成され、リアルタイムコールバック内の処理が無い。今回の 38 story もすべて既存ノードと OfflineAudioContext で実現できる。CLAUDE.md の技術構成に AudioWorklet の記載はあるが、ユーザー価値に直結する必要(カスタム DSP、サンプル再生)が生じるまで実施しない。US-038 で docs/05 に追記する。
- **localStorage の容量**: 上記 §5 のとおり既知リスクとして記録し、保存基盤(SQLite/IndexedDB)は別案件とする。
- **Web MIDI**: 任意の追加機能。PC キーボード演奏が主経路。実機確認は US-024 の受け入れ時に Windows WebView2 で行う。
- **docs の更新単位**: story ごと(Definition of Done に従う)。
- **難易度別の説明文**: 新しい説明文は `difficultyText.ts` を通す。構成用語(サビなど)の 1 行説明のように難易度で変わらないものは story に明記して固定文にする。
- **テンプレートの Chords トラック**: `templates.ts` はコードをイベントとして持つだけでノートは作らない(grep で確認)。US-009 の優先度は変わらない。

## 8. 法務上の注意

docs/09 に従い、DAW 名は本調査の文脈でのみ使います。製品内の UI、文言、プリセット名は独自に作ります。音色、スタイル、レッスンの名称は機能的な日本語にし、製品名やアーティスト名を使いません。US-020 と US-032 のテストは名称に製品名らしき語が含まれないことを検査します。

## 9. 候補と story の対応表

| 初版候補 | 処置 | story | 優先 | 状態 |
|---|---|---|---|---|
| F01 スキーマ v2 | 分割(a: 移行、b: role) | US-001, US-002 | P0 | 未着手 |
| F02 Undo/キーマップ | 対象を拡大 | US-003 | P0 | 未着手 |
| (追加)シーク・再生ヘッド | 新規 | US-004 | P0 | 未着手 |
| F03 拍子/長さ/ループ/タップ | 分割(a: 拍子と長さ、b: ループ範囲とタップ) | US-005, US-006 | P0 | 未着手 |
| F04 クリップ展開 | export.ts の独自展開を削除 | US-007 | P0 | 未着手 |
| F09 ピアノロール | 分割(a: 試聴と音域、b: ゴーストと色分け) | US-008, US-017 | P0 / P1 | 未着手 |
| F12 コード相互変換 | 分割(a: 鳴らす/ノート化、b: 伴奏パターン、c: 検出)。ChordPads は作らない | US-009, US-021, US-022 | P0 / P1 / P1 | 未着手 |
| F05 トラック管理 | MIDI チャンネル循環を追加 | US-010 | P0 | 未着手 |
| F06 タイムライン編集 | 分割(a: 純粋関数と相対拍、b: UI) | US-011, US-012 | P0 | 未着手 |
| F07 セクション | store/editorActions を追加 | US-013 | P1 | 未着手 |
| F08 ノート編集 | 分割(a: クリップボード/移調/スケール適合、b: 加工)。理論は theory-engine へ | US-014, US-015 | P1 | 未着手 |
| (追加)曲全体の移調 | 新規 | US-016 | P1 | 未着手 |
| F10 グルーヴ | 分割(a: スウィング/クオンタイズ/ヒューマナイズ、b: チョークと 12/16) | US-018, US-019 | P1 | 未着手 |
| F11 音色 | 別名互換を追加 | US-020 | P1 | 未着手 |
| F13 リアルタイム入力 | 分割(a: PC 演奏、b: Web MIDI 任意) | US-023, US-024 | P1 | 未着手 |
| F14 録音 | 分割(a: カウントイン/重ね録り、b: ステップ入力/回収) | US-025, US-036 | P1 / P2 | 未着手 |
| F15 ミックス | 分割(a: EQ/コンプ/マスター、b: スペクトラム/プリセット) | US-026, US-032 | P1 / P2 | 未着手 |
| F17 オートメーション | 分割(a: 音量、b: パン/フィルター) | US-027, US-033 | P1 / P2 | 未着手 |
| F18 書き出し | 分割(a: 48kHz/範囲/PC/調号、b: 24bit/ディザ/ステム/LUFS) | US-028, US-035 | P1 / P2 | 未着手 |
| F16 センド/リターン | 降格 | US-034 | P2 | 未着手 |
| F19 伴奏おまかせ | ユークリッドを削除 | US-031 | P2 | 未着手 |
| F20 用語集とレッスン | 分割(a: 用語集、b: レッスン) | US-029, US-030 | P2 | 未着手 |
| (追加)DOM テスト基盤 | 新規 | US-000 | P0 | 未着手 |
| (追加)E2E と手動 QA | 新規 | US-037 | 仕上げ | 未着手 |
| (追加)文書の最終同期 | 新規 | US-038 | 仕上げ | 未着手 |

聴感でしか確認できない項目(音色、EQ、ループのまたぎ、スウィングの感じなど)は受け入れ基準に書かず、`docs/12_release_qa_log.md` の「§8 機能追加の聴感・手動QA」に `FEAT-MAN-001`〜`015` として追加します(`REL-MAN` 行と `createReleaseQaLog.mjs` には触れません)。

## 10. 出典

出典は調査レーンが収集した URL です。本統合の工程では URL を再取得していません。

[^fl-pl]: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm
[^fl-pr]: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm
[^fl-cr]: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/channelrack.htm
[^arr]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/arranger_track/arranger_track_c.html?contentId=9padlJ8SD4IT6kySLRZ1Ww
[^so-arr]: https://ask.audio/articles/experimenting-with-musical-ideas-using-presonus-studio-ones-arranger-and-scratch-pad
[^so-sp]: https://soundonsound.com/techniques/studio-one-using-scratch-pad
[^so-ch]: https://www.audeobox.com/learn/studio-one/chord-track-guide/
[^so-harm]: https://musictech.com/news/presonus-releases-studio-one-4/
[^gb-mark]: https://support.apple.com/guide/garageband/add-arrangement-markers-gbnd8431c634/10.4.14/mac/15.6
[^gb-arp]: https://support.apple.com/guide/garageband/use-the-arpeggiator-gbndb52043b6/10.4.14/mac/15.6
[^gb-gl]: https://support.apple.com/guide/garageband/view-glossary-topics-gbndd09deb8d/10.4.14/mac/15.6
[^gb-les]: https://support.apple.com/guide/garageband/play-a-lesson-gbnd7008d91b/10.4.14/mac/15.6
[^gb-score]: https://support.apple.com/guide/garageband/see-how-well-you-played-a-lesson-gbndb71d9eec/10.4.14/mac/15.6
[^lp-alt]: https://support.apple.com/guide/logicpro/use-project-alternatives-and-backups-lgcpa158ef77/12.3/mac/15.6
[^lp-ll]: https://support.apple.com/guide/logicpro/live-loops-overview-lgcpf46ffc88/12.3/mac/15.6
[^lp-ts]: https://support.apple.com/guide/logicpro/track-stacks-overview-lgcp9bc4b63d/12.3/mac/15.6
[^lp-ch]: https://support.apple.com/guide/logicpro/chords-overview-lgcp2633963f/12.3/mac/15.6
[^lp-det]: https://support.apple.com/guide/logicpro/analyze-chords-audio-midi-regions-logic-pro-lgcp4993e80c/12.3/mac/15.6
[^lp-sp]: https://support.apple.com/guide/logicpro/session-players-overview-lgcpbf624405/12.3/mac/15.6
[^lp-spe]: https://support.apple.com/guide/logicpro/the-session-player-editor-lgcp32d55998/12.3/mac/15.6
[^lp-step]: https://support.apple.com/guide/logicpro/step-record-step-sequencer-patterns-lgcp3c340e11/12.3/mac/15.6
[^lp-comp]: https://support.apple.com/guide/logicpro/comping-overview-lgcp317d758e/12.3/mac/15.6
[^lp-sc]: https://support.apple.com/guide/logicpro/smart-controls-overview-lgcp7e59f24b/12.3/mac/15.6
[^lp-loop]: https://support.apple.com/guide/logicpro/customize-the-loop-browser-lgcpe6fe978f/12.3/mac/15.6
[^lp-auto]: https://support.apple.com/guide/logicpro/choose-automation-modes-lgcpb1a6ab26/12.3/mac/15.6
[^lp-cs]: https://support.apple.com/guide/logicpro/work-with-channel-strip-settings-lgcp35966da6/12.3/mac/15.6
[^cb-scale]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/midi_editors/midi_editors_scales_in_key_editor_r.html?contentId=hgOvLq0u_ZJ4kunWOAMTQg
[^cb-ct]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/chord_functions/chord_functions_chord_track_c.html?contentId=JY8XTZfKhUr3NFLsytZ_6g
[^cb-ca]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/chord_functions/chord_functions_chord_assistant_c.html?contentId=NoesQJqOZv0i9rDB4g3B9g
[^cb-pad]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/chord_pads/chord_pads_c.html?contentId=VdF3jBPijG1MvFDpjmICag
[^cb-voi]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/chord_functions/chord_functions_voicings_c.html?contentId=CtoVmp5A0O46AGGY_7H2nA
[^cb-adapt]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/chord_pads/chord_pads_adaptive_voicing_c.html?contentId=i7QTeuVpNDpFrVaPnYCL2A
[^cb-pp]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/chord_pads/chord_pads_using_the_pattern_player_t.html?contentId=KAF5EfMGh47VRGmEJCQAoA
[^cb-sev]: https://www.steinberg.help/r/9_A2jNxlDJdZgViRgyezjA/HMN0qMibp9C_cdDq1E2Kow?section=chord_functions_scale_events_c
[^cb-ne]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/note_expression/note_expression_c.html?contentId=o25mlU9e9x0vo5i31Zj51g
[^cb-le]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/logical_editor_transformer_and_input_transformer/logical_editor_transformer_and_input_transformer_c.html?contentId=GzSzvOwz2IRSuoGSretZkw
[^cb-dm]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/drum_machine/drum_machine_c.html?contentId=PqrX1iR1UuPRpkrvjtFjGg
[^cb-mod]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/modulators/modulators_c.html?contentId=~pAJMyw5C_Lw6Od1mWZFQg
[^cb-sa]: https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/audio_functions/audio_functions_spectrum_analyzer_t.html?contentId=qIgjeA9C8HVcB5oghUPjRA
[^al-sess]: https://www.ableton.com/en/live-manual/12/session-view/
[^al-midi]: https://www.ableton.com/en/live-manual/12/editing-midi/
[^al-tools]: https://www.ableton.com/en/live-manual/12/midi-tools/
[^al-gr]: https://www.ableton.com/en/live-manual/12/using-grooves/
[^al-rec]: https://www.ableton.com/en/live-manual/12/recording-new-clips/
[^al-comp]: https://www.ableton.com/en/live-manual/12/comping/
[^al-rack]: https://www.ableton.com/en/live-manual/12/instrument-drum-and-effect-racks/
[^al-mix]: https://www.ableton.com/en/live-manual/12/mixing/
[^al-new]: https://www.ableton.com/en/live/all-new-features/
[^bw-note]: https://www.bitwig.com/userguide/latest/working_with_note_events
[^bw-op]: https://www.bitwig.com/userguide/latest/operators
[^bw-cont]: https://www.bitwig.com/userguide/latest/container
[^bw-mod]: https://www.bitwig.com/userguide/latest/modulator
[^bw-auto]: https://www.bitwig.com/userguide/latest/automation
[^rp]: https://www.reaper.fm/
