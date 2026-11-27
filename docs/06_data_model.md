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
| AutomationEvent | 音量/パン/パラメータ変化 |
| Lesson | 教材 |
| LessonStep | 教材の各ステップ |
| UserProgress | 学習進捗 |
| ExerciseAttempt | 演習履歴 |
| Asset | サンプル/音声/MIDI素材 |
| AppSetting | 設定 |

## 2. TypeScript型案

```ts
export type Project = {
  id: string;
  schemaVersion: number;
  title: string;
  bpm: number;
  timeSignature: [number, number]; // [分子, 分母]。小節の長さ(4分音符の拍数)は beatsPerBar() だけが決める: 4/4=4、3/4=3、6/8=3、2/2=4、2/4=2
  key: MusicalKey;
  scale: ScaleName;
  lengthBars: number; // 小節数。拍子を変えると ceil(総拍数 / 新しい小節の拍数) に切り上げる
  legacyBarLimit?: number; // v1 の拍子換算で通常の上限を超えたときの換算後の小節数
  loopRange?: { startBeat: number; endBeat: number }; // 再生を繰り返す範囲
  swing?: number; // 0〜60。未設定は 0
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
  role?: 'chords' | 'bass' | 'melody' | 'drums';
  color?: string;
  clips: Clip[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  instrument?: InstrumentConfig;
  effects: EffectConfig[];
  automation?: { volume?: AutomationLane; pan?: AutomationLane; cutoff?: AutomationLane };
  sends?: Record<string, number>;
};

export type AutomationLane = { points: { beat: number; value: number }[] };

// どのレーンも曲全体の拍位置を使い、点の範囲外では最寄りの値を保つ。
// 同じ拍に複数の点がある場合、配列で最後の値を使う。追加・移動した点は同じ拍の末尾に置く。
// volume はミキサー音量への倍率 (0〜1)、pan はミキサーの左右位置への加算値 (−1〜1)。どちらも直線補間。
// cutoff はマクロ適用後のシンセの各音が持つフィルター周波数への倍率 (0.1〜10)。
// 1 倍は元の音。1200 × log2(倍率) を共有信号源で直線補間して detune に送る。
// 通常は 20 Hz〜サンプルレートの 45%。基準周波数が 45% を超える場合は基準周波数を上限とする。
// ブラウザーは最終周波数をナイキスト周波数以下に収める。リターントラックでは音に影響しない。
// 空・未指定のレーンには専用ノードを追加しない。マスターでは 3 種類のレーンすべてを禁止する。
// スキーマ版は据え置き。読み込み時にレーンや点を追加・並べ替え・補正しない。

// sends は送り先のリターン (type: 'bus') の id と送る量 (0〜1) の組。
// 未指定または 0 なら接続を作らない。読み込みで sends の追加や書き換えは行わず、スキーマ版も据え置く。
// フェーダーと各オートメーションを通った音は既存パンの後、送り元の effects の前からリターンの入力へ分岐する。
// リターンは最大 2 つで、clips は空。リターンとマスターを送り元にできず、自分自身へも送れない。

// effects の type は 'eq' | 'compressor' | 'filter' | 'delay' | 'reverb'(スキーマ版は上げない)。
// eq か compressor が有効なら、再生・書き出しの処理順は配列順に関わらず eq → compressor → filter → delay → reverb。
// どちらも無効なら配列順のまま(既存プロジェクトの音を変えないため)。delay の timeSeconds は最大 1.5 秒(旧 time / delayTime も同じ上限で、上限超えの保存値は変更前と同じ 1.5 秒に丸める)。
//   eq params:         lowGainDb / midGainDb / highGainDb(各 -12〜12 dB。低域・高域はシェルビング、中域はピーキング)
//   compressor params: thresholdDb(-60〜0)/ ratio(1〜20)/ attackSeconds(0〜1)/ releaseSeconds(0.01〜1)
//   範囲外は validateProject がエラーにする。
// master トラックの volume(0〜2)がマスターゲインになる(ライブ再生と WAV 書き出しで共通)。

// instrument は { type: 'synth' | 'drumkit'; preset: string; params?: Record<string, number>; macros?: InstrumentMacros }。
// synth の preset は音色名(warmPad / roundBass / brightLead / pianoLike / bell / organLike / stringsLike / brassLike /
//   pluck / deepSubBass / softKeys / squareLead / glassPad、別名 subBass = roundBass・leadSine = brightLead)。
//   未知の名前('piano' / 'pad' / 'bass' / 'lead' など既存ファイルの値を含む)は warmPad で鳴る。
// instrument.macros(オプション、スキーマ版は上げない)は { brightness, release, width, attack } で各 0〜1。
//   brightness = フィルタのカットオフ、release / attack = エンベロープの時間(0.5 で音色のまま、0 で 1/4 倍、1 で 4 倍)、
//   width = 左右の広がり(0 で中央、1 で隣り合う音を左右に振る)。未設定なら音色そのまま。
//   範囲外・非有限・数値以外は validateProject がエラーにする(読み込み時に値を直したり補ったりはしない)。
//   ライブ再生・WAV 書き出し・試聴は同じ applyMacros(apps/studio/src/audio/macros.ts)で音色に反映する。

// role は役割(コード / ベース / メロディ / ドラム)を表す安定した識別子。
// 表示名 `name` は自由に変えてよく、レッスン判定・アシスタント・コーチは role を優先し、
// role が無い古いプロジェクトだけトラック名('Bass' など)にフォールバックする。

export type Clip = {
  id: string;
  trackId: string;
  type: 'midi' | 'drum' | 'audio' | 'automation';
  startBeat: number;
  lengthBeats: number;
  contentLengthBeats?: number; // ループ周期。未設定は lengthBeats
  loop: boolean;
  aliasOf?: string;
  legacyClipSettings?: { loop: boolean; aliasOf?: string; contentLengthBeats?: number };
  notes?: NoteEvent[];
  drumEvents?: DrumEvent[];
  stepsPerBar?: number; // ドラムクリップの 1 小節のステップ数(未設定は 16)。新規クリップは拍子に合わせて beatsPerBar × 4(4/4=16、3/4=12)。ステップ i の拍位置は i × beatsPerBar / stepsPerBar。拍子を変えると beatsPerBar × 4 に揃え、各打点の拍位置を保つ(同じレーン・同じステップに重なった打点は 1 つだけ残し、消える数は変更前に確認する)
  audioAssetId?: string;
};
```

Clip の意味(再生・WAV・MIDI 共通、docs/02 §3.5):

- `lengthBeats`: クリップが鳴る長さ。これ以降に始まるノート・打点は鳴らず、終わりをまたぐノートは終わりで切る。
- `loop` / `contentLengthBeats`: ループの中身を `contentLengthBeats ?? lengthBeats` 拍ごとに繰り返す。最短周期は 1/64 拍。周期の終わり以降に始まる元の音は鳴らさず、周期をまたぐノートは周期の終わりで切る。クリップや曲の終わりでは、最後の繰り返しも同じ規則で切る。
- `aliasOf`: 同じクリップ種別の共有元を 1 段だけ指す。共有元の `notes` / `drumEvents` / `stepsPerBar` を、自分の位置・長さ・ループ設定で使う。リンクは自分の中身を持たない。
- トラックの種類: `drum` は打点だけ、`instrument` はノートだけを鳴らす。参照切れ・循環やトラックで鳴らせない音の理由は `problems` に日本語で返す。
- ミュート中の音は再生・WAV・MIDI のいずれにも入らない。ミュートされていないソロがあれば、ソロのトラックだけが鳴る。

- **ノートの `startBeat` とドラムの `stepIndex` はクリップ相対**(クリップの `startBeat` を 0 とする)。コードトラック・セクション・ループ範囲は曲の先頭からの絶対拍なので、ノートに対応するコードは `clip.startBeat + note.startBeat` の拍で引く(Theory Inspector・コーチ・メロディ解析・レッスン判定)。ベース / メロディ生成と「コードをノートにする」は、クリップの範囲内にあるコードだけを相対拍に直してから書き込む。メロディ生成の強拍はクリップの開始拍を足した絶対拍で判定する。生成した音符はクリップの長さで切り、クリップは伸ばさない。範囲内にコードが 1 つもないときは何も書き換えず、その旨を案内する。ベース / メロディ生成では、書き込む音符が繰り返しの 1 回分に収まらない、書き換えで既存のループの上限を超える、またはリンクの共有元を解決できない場合も、既存の音符を残して理由を案内する。
- **ピアノロールの編集範囲**はクリップの終わりと曲の終わりのうち早い方までとする。グリッドは曲の終わりまでを表示し、クリップより後ろの部分は網掛け(`aria-disabled`)で音符を置けない。短縮で範囲外に残った音符はデータに保持し、ピアノロールでの表示と編集の対象から外す。置く・動かす・長さを変える・クオンタイズ(Q)のどれでも音符は編集範囲を越えず(動かす・Q は収まる最後のグリッドへ、置く・長さを変えるは終わりで切る)、クリップの長さは変わらない。ループするクリップでノートを移動・クオンタイズするときは、周期と編集範囲のうち短い方に収める。複数ノートの移動では全体が収まる範囲で同じ拍数だけ動かし、横幅が入りきらないときは開始拍を保つ。網掛けをダブルクリックすると、その拍を含む曲の小節の終わりまでクリップを伸ばすボタンを出し、押したときだけ伸ばす。
- **リンクの編集先**: `aliasOf` を持つクリップは自分の中身を持たず、編集は `resolveEditTarget(project, clipId)` が返すリンクの行き着く先(元のクリップ)に対して行う。ベース / メロディ生成をリンクに行うと、コードはリンクの位置と長さで読み、音符は元のクリップに書く(元のクリップと全リンクが同じ音符を鳴らす)。メロディ添削も元のクリップの音符をリンクの位置で解析する。参照切れ・循環のときは `undefined`。レッスン判定は、リンク自身の長さや繰り返し設定を反映した発音を数える。

クリップ操作(`packages/project-model/src/mutations.ts`、純粋関数)。移動・伸縮・複製に指定した拍が非有限値なら、元の Project を返す。

- `addClip(project, trackId, clip)`: トラックにクリップを追加する。クリップ、ノート、打点の ID が重複する場合は新しい ID を割り当てる。
- `moveClip(project, clipId, startBeat)`: 同じトラック内で動かす。他のクリップと重なる位置なら、重ならない最も近い開始拍(0 以上、同じ距離なら早い方)へ置く。位置と距離は整数 tick で扱う。重なりの判定は `validateProject` と同じ規則(`tickSpansOverlap`: 各クリップの開始・終了を別々に `beatTick` で丸め、長さ 0 tick になる区間は何とも重ならない)。候補はこの規則で同じトラックの他のクリップと重ならない開始 tick `t` すべてで、指定拍 `r` からの距離は丸める前の `r` で `|t / PPQ - r|` 拍として測り、同じ距離なら早い方を選んで `t / PPQ` を返す。`r` 自体が重ならなければ `r` をそのまま使う。`MAX_CLIP_END_BEATS`(130,560 拍)を越えて終わる位置は候補にせず、置ける位置がなければ動かさない。`duplicateClip` の置き場所も同じ規則で決める。
- `resizeClip(project, clipId, lengthBeats)`: ループ周期を保って長さを変更する。別のクリップと重なる場合は元の Project を返す。
- `splitClip(project, clipId, atBeat)`: 曲の絶対拍でクリップを 2 つに分け、打点がある場合は最も近いステップ境界に合わせる。境界をまたぐノートの長さは左右で分ける。リンク元を分けるときは左側に元の保存データを残し、共有先の発音を保つ。ループやリンクのクリップを分けようとした場合は(D4)、`{ ok: false, project(元のまま), code, reason }` を返す。`code` は `loopingClip` / `linkedClip` / `invalidBoundary` / `missingClip`、`reason` は初心者向けの日本語の文(`SPLIT_FAILURE_MESSAGES`)で、曲全体ビューはこの文をそのまま表示し、分割できない位置では分割ボタンを無効にする。
- `duplicateClip(project, clipId, { mode })`: 直後の空き位置に複製する。`copy` は中身を複製した独立クリップ(リンクを複製したときも中身と `stepsPerBar` はリンク元のもの。リンク元が `stepsPerBar` を持たなければ持たない)、`link` は `aliasOf` に元のクリップを指し、ノート・打点を持たない。
- `removeClip(project, clipId)`: 削除する。削除したクリップにリンクしていたクリップは、削除クリップがリンクならその先へ付け替え、そうでなければ中身と `stepsPerBar`(持たなければ持たない)のコピーを受け取って、同じ拍で鳴り続ける。
- `quantizeClipNotes(project, clipId, noteIds, snap)`: 指定ノートの開始拍を `snap` 拍のグリッドの最も近い線へ揃える(D2)。ノートは 1 周目(ループ周期、ループしなければ曲の終わりまでのクリップ)に収め、はみ出すときは収まる最後のグリッドに留める(1 周目より長いノートは 1 周目の長さとみなして位置を決める)。保存されたノートの長さとクリップの長さは変えない。揃えると、どれか一つの配置(元のクリップや各リンク)で鳴る回数が減るノート(クリップ末尾の途中までの繰り返しで鳴らなくなる等)は元の位置のままにする。
- ピアノロールの強さ付きクオンタイズとヒューマナイズ(`apps/studio/src/state/editorActions.ts` の `quantizeNotes` / `humanizeNotes`、US-018)では、開始を動かす音が共有元と全リンクの 1 周目に収まることを `placedNoteTicks` で判定する。スウィング込みの開始 tick が 1 周目の終端より前、切る前の終了 tick が終端以下なら収まる。再生上の長さと発音の有無は `soundingEvents` を使って各配置・各周で比べる。
- 強さ付きクオンタイズの目標は、元の開始から `quantizeClipNotes` が返す開始までを指定の割合で補間した正確な値とする。目標位置で 1 周目に収まらない音、短くなる音、鳴らなくなる音は、それぞれ元の位置に残す。一部の音を動かせる場合は Undo 1 段で確定し、移動候補がすべて条件を満たさない場合はトーストを出す。
- ヒューマナイズは「元の開始 ± 幅」の中で、乱数で決めた開始、幅の両端、1 周目の終端 tick から求めた候補と、その前後 2 tick を調べる。全配置の 1 周目に収まり、鳴る長さを保つ候補が見つからなければ開始を保つ。ベロシティは独立に変更できる。候補を適用した結果がいずれかの周で発音を失うか短くする場合、操作全体を断る。
- `placedNoteTicks(clip, note, { repeat, swing, songEnd })`: 配置したノートの開始・終了 tick(最短 1 tick の補正前)と、その回の終わりの tick を返す。`soundingEvents` もエディタの判定もこれを使い、`(クリップ開始 + 相対開始) + 長さ` の同じ足し算の順で丸める。
- `resolveEditTarget(project, clipId)`: ノート・打点の編集先のクリップを返す。リンクなら `aliasOf` をたどった先、そうでなければ自分自身。クリップが無い、参照切れ、循環のときは `undefined`。

```ts
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

## 3. SQLiteスキーマ案

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  bpm REAL NOT NULL,
  time_signature_num INTEGER NOT NULL,
  time_signature_den INTEGER NOT NULL,
  key_root TEXT NOT NULL,
  scale_name TEXT NOT NULL,
  length_bars INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  color TEXT,
  volume REAL NOT NULL DEFAULT 1.0,
  pan REAL NOT NULL DEFAULT 0.0,
  mute INTEGER NOT NULL DEFAULT 0,
  solo INTEGER NOT NULL DEFAULT 0,
  instrument_json TEXT,
  sort_order INTEGER NOT NULL
);

CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  start_beat REAL NOT NULL,
  length_beats REAL NOT NULL,
  loop INTEGER NOT NULL DEFAULT 0,
  alias_of TEXT,
  audio_asset_id TEXT
);

CREATE TABLE note_events (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  pitch INTEGER NOT NULL,
  start_beat REAL NOT NULL,
  duration_beats REAL NOT NULL,
  velocity INTEGER NOT NULL
);

CREATE TABLE drum_events (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  velocity INTEGER NOT NULL
);

CREATE TABLE chord_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_beat REAL NOT NULL,
  duration_beats REAL NOT NULL,
  symbol TEXT NOT NULL,
  root TEXT NOT NULL,
  quality TEXT NOT NULL,
  notes_json TEXT NOT NULL,
  degree TEXT,
  function TEXT,
  tags_json TEXT
);

CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  level TEXT NOT NULL,
  course_id TEXT NOT NULL,
  lesson_json TEXT NOT NULL
);

CREATE TABLE user_progress (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  score REAL,
  last_feedback TEXT,
  next_review_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE exercise_attempts (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  result TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  feedback TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  original_name TEXT,
  license TEXT,
  metadata_json TEXT
);
```

## 4. バージョニング

- `schema_version` を必ず持つ
- 破壊的変更は migration を書く
- Lesson DSL も `lesson_schema_version` を持つ
- Export時に `app_version` と `created_with` を記録する
- 現行の `schemaVersion` は 3。値は `CURRENT_SCHEMA_VERSION` だけで定義し、生成コードに数値を直書きしない
- 新しいバージョンのファイルは読み込みを拒否する
- オプションフィールドの追加だけならバージョンを上げない

### v1 → v2 の移行規則

`migrateProject` は冪等。v1 の拍子、マスター音量、トラックの役割を換算してから、v2 → v3 の共通処理でクリップを移行する。

- **v1 のクリップ**: v2 → v3 の共通処理で `lengthBeats` を中身の終端まで伸ばす。旧ライブ再生と WAV にそろえて各クリップ自身の音を 1 回ずつ鳴らし、元のループとリンクの設定を `legacyClipSettings` に退避する。旧 MIDI との差は既知の制限
- **x/4 以外の拍子の小節換算**: v1 は 1 小節を分子の拍数(6/8 なら 6 拍)として再生していた。v2 の `beatsPerBar`(6/8 なら 3 拍)で同じ音になるよう、`lengthBars` を `ceil(旧小節数 × 分母 / 4)` に、セクションの `startBar` / `lengthBars` を同じ倍率で換算する。ドラムクリップは `stepsPerBar` を `旧 stepsPerBar × 4 / 分母` にし(16 ステップの 6/8 なら 8)、ステップ番号はそのまま。割り切れないときは `stepsPerBar` を 4 倍にしてステップ番号に分母を掛ける。どちらも各打点の拍位置は厳密に変わらない。x/4 の曲は何も変えない
- **master volume 正規化**: `type: 'master'` のトラックの `volume` を 1 にする。v1 ではこの値にかかわらず実効ゲインが常に 1 だったため
- **換算後の曲長**: v1 で 1〜64 小節だった曲が拍子換算で 64 小節を超える場合、換算後の小節数(最大 256)を `legacyBarLimit` に保存し、その曲の上限にする。例として、6/8 の 33 小節は 66 小節に換算され、曲末は 198 拍のまま。保存して開き直しても同じ上限を使う
- **role 推定**: `type: 'drum'` は `drums`。それ以外はトラック名を大文字小文字を区別せず単語単位で照合し、chords / chord → `chords`、bass → `bass`、melody / lead → `melody`。master と、どれにも当たらないトラックは未設定のまま
- **移行前バックアップ**: localStorage から読んだ JSON の `schemaVersion` が現行より古いと、移行前の生 JSON を `cts.project.backup.v<旧バージョン>` に保存してから移行する。キーはバージョンごとに 1 つで、複数の曲を移行すると最後に読んだ曲で上書きされる。容量超過で保存できなくても移行は続ける。このキーはプロジェクト一覧の対象にしない

### v2 → v3 の移行規則

v2 までのライブ再生と WAV は `lengthBeats` を無視し、各クリップ自身のノート・打点をクリップの長さを超えても 1 回ずつ鳴らしていた。v3 はクリップの長さ・ループ・リンクを音に反映する(docs/02 §3.5)ので、v2 のファイルを読み込むと各クリップを次のように扱う。v1 のファイルは v1 → v2 → v3 の順に移行する。

- 各クリップの `lengthBeats` を、最後のノート終端・ドラムステップ終端以上に切り上げ、はみ出していた音も残す。ドラムの 1 ステップは `beatsPerBar / stepsPerBar` 拍で、`stepsPerBar` の既定値は 16
- v1・v2 のライブ再生と WAV は `swing` を使っていなかったため、移行時にこの値を取り除く。v3 では保存された `swing` を使う
- 移行後のライブ再生・WAV・MIDI は v2 のライブ再生にそろえ、各クリップ自身の音を 1 回ずつ鳴らす。旧 MIDI はループをノートの終端から求めた長さで繰り返していたため、その出力は移行後に変わる(D1: 旧ライブ/WAV の音を正とし、この MIDI の差は既知の制限として受け入れる)。再生用の `loop` をオフにし、`contentLengthBeats` と `aliasOf` を外す。元の値は復元用の `legacyClipSettings` に記録し、v3 の JSON を保存して読み直しても保持する
- 自分のクリップにノートを持つ v2 の `bus` と `audio` は、同じ ID・音色・音量・パン・ミュート・ソロ・エフェクトを持つ `instrument` に変換する。v2 でそのトラックから鳴っていたノートを再生と WAV で引き続き鳴らせる
- v3 のファイルで検証範囲内の長さ・ループ・リンクは読み込み時に変更しない。上限を超える曲長は 64 小節(有効な `legacyBarLimit` がある曲はその値)に収め、短いループ周期は最短周期に補正する。リンク鎖は共有元に直接つなぎ、参照切れ・循環・種別違い・自分の中身を持つリンクは解除して自分の中身を残す。同じトラックの重なるクリップは、同じ設定の別トラックに移して拍位置を保つ。
- 読み込んだトラックの名前が文字列でなければ「名前のないトラック」に補正する。

### クリップの発音規則(収束計画 D2〜D5)

ライブ・WAV・MIDI は、次の 3 つだけを発音の正とする(`packages/project-model/src/sounding.ts`。`.omc/plans/clip-convergence-2026-11-26.md`)。3 経路は結果を書き換えず、形式に合わせて写すだけにする。

- `soundingEvents(project)`: 実際に鳴る音の一覧と `problems`。ループ、リンク、スウィング、曲末の切り方を含む。各音は絶対拍、トラックとクリップの ID、共有元のクリップ ID、保存配列内の位置、0 始まりの繰り返し番号を持つ。スウィングは 16 分音符グリッドの偶数番目を指定割合だけ遅らせる(`groove.ts` の `swingBeat`。3 経路で再適用しない)。
- ドラムの発音イベントは長さ `durationBeats` を持ち得る(US-019 のハイハットのチョーク)。同じドラムトラックで後ろ(tick で比べ、同時は含まない)の最も近いクローズドハットがあるオープンハットだけに、その発音 tick で終わる長さが付き(`groove.ts` の `applyHiHatChoke`、スウィング後の位置で判定)、ライブ・WAV・MIDI はそれぞれの音の長さをこの長さまで短くする。その他の打点は長さを持たない。
- `storedEventAt(project, clipId, localBeat)`: その位置で始まる音が、どの保存済みのノート・打点(`sourceClipId` と `sourceIndex`)から来たかを返す。クリップの開始拍に `localBeat` を加えて曲全体での tick に変換し、同じ tick に始まる音を探す。同時に始まる音は保存順の先頭を返し、なければ `null`。編集 UI は境界の規則を自分で計算せず、これを使う。
- `songEndBeat(project)`: 曲の終わりの拍。小節数に `beatsPerBar` を掛ける。

規則:

- **D2 クオンタイズ**: ループ中のクリップは 1 周目の最後のグリッドに留める。クリップは伸ばさず、音も消さない。
- **D3 曲末**: 曲の終わりをまたぐノートは曲の終わりで切る。3 経路で終了 tick は同じ。
- **最短の長さ**: ノートの終了 tick は `max(開始 tick + 1, 丸めた終了 tick)`。1 tick 未満のノートも 1 tick 鳴らす。この補正は `soundingEvents`(480 tick/拍)が行い、3 経路は写すだけにする。MIDI 書き出しは別の分解能(`ppq`)でも 0 長にならないよう、書き出し ppq の tick で同じ規則をもう一度当てる(`projectToMidi` と `exportNotesToMidi` で共通)。MIDI では同じ tick の note-off を note-on より先に書く。
- **D4 分割**: ループ・リンクのクリップは分割できない。操作は理由付きで元のプロジェクトを返し、ボタンは無効になる。
- **D5 レッスン判定**: クリップの内容を数える判定は、保存された内容ではなく実際に鳴る内容(`soundingEvents`)で数える。
- 境界は `Math.round(beat * PPQ)` の整数 tick で比較する。1 拍は 480 tick。
- スウィングは配置後に曲の 16 分グリッドで掛かるため、移動・分割の不変条件(平行移動・発音区間の和集合)はスウィング前の位置で成り立つ。スウィング有りで裏の 16 分に動かす/分けると発音位置がずれ得る(既知の制限)。

#### クリップ操作の決定表

移動・複製・長さ変更・分割は、対象領域(長さ 1/64 拍以上・終端 130,560 拍(`MAX_CLIP_END_BEATS` = 4 × 64 小節 × 1 小節の最大 510 拍)以内)の外のクリップがあるトラックでは操作せず、元の Project を返す(分割は `invalidBoundary`)。保存・読み込みと `validateProject` はこの領域を課さない。曲全体ビューでクリップを追加するとき、置ける場所が見つからなければ追加せず「ここには置ける場所がありません。」と知らせる。

各操作が実際に鳴る音(`soundingEvents`)に与える影響。境界の判定は `storedEventAt` / `soundingEvents` に任せ、操作側で計算し直さない。どの操作も同じトラックに重なりを作らず、Undo 1 段で元の Project に戻る。

| 操作 | 通常の MIDI(copy) | リンク(`aliasOf`) | ループ | ドラム |
|---|---|---|---|---|
| 移動 `moveClip` | クリップの音がすべて移動量だけ平行移動する。他のクリップの音は変わらない。重なる位置なら最も近い空き位置へ。対象領域外のクリップがあるトラックでは動かさない | リンク自身の音が平行移動する。リンク元・他のリンクは変わらない | 繰り返しごと平行移動する | 打点が平行移動する(ステップ位置はクリップ先頭からの相対で保つ) |
| 分割 `splitClip` | 音高ごとの発音区間の和とノート長の合計が変わらない。境界をまたぐノートは左右に分ける。左右どちらかが 1/64 拍未満になる位置は `invalidBoundary` で拒否する。対象領域外のクリップがあるトラックでも `invalidBoundary` | 不可(D4)。元の Project と理由を返す。リンク元を分けるときは左側が保存データを持ち、共有先の音は変わらない | 不可(D4) | ステップ境界で分ける。打点の鳴る拍は変わらない |
| 複製 `duplicateClip` | `copy`: 直後の空き位置に同じ音が増える。元の音は変わらない。対象領域外のクリップがあるトラックでは複製しない | `link`: `aliasOf` を持ちノートを持たない。元と同じ内容が新しい位置で鳴る | 周期ごと複製する | `stepsPerBar` もリンク元のものを引き継ぐ |
| 長さ変更 `resizeClip` | 短くすると終わり以降の音が鳴らなくなる(データは残す)。長くすると保存済みの音が再び鳴る。重なる、1/64 拍未満になる、`MAX_CLIP_END_BEATS` を越えて終わる、対象領域外のクリップがあるトラックなら元のまま | リンク自身の長さだけ変わる | `contentLengthBeats`(周期)を保ち、繰り返し回数が変わる | ステップ数は変えない |
| 削除 `removeClip` | クリップの音が消える。他は変わらない | リンクを消しても元は変わらない。リンク元を消すと、リンクは中身のコピー(音声クリップは同じ `audioAssetId`)を受け取り同じ拍で鳴り続ける | 同左 | 同左 |
| クオンタイズ `quantizeClipNotes` | 開始拍がグリッドに揃う。発音数は減らず、クリップ長は変わらない | 編集先(`resolveEditTarget`)のノートを揃えるので、共有するクリップすべてに反映される | 1 周目の最後のグリッドに留める(D2)。繰り返しで鳴らなくなる移動はしない | 対象外(ドラムはステップ入力) |

セクション操作(`packages/project-model/src/sections.ts`、docs/02 §7.3.5)は上の操作を組み合わせる。境目をまたぐクリップは `splitClip` で分け、複製は `duplicateClip`(リンクは `link`、それ以外は `copy`)、削除は `removeClip` を使う。後ろの中身は `startBeat` をずらすだけで動かす(`moveClip` は途中で重なったクリップを空き位置へ逃がすため使わない)。境目の比較は整数 tick。

| 操作 | 結果 | 行わない場合(元の Project と `code`・`reason` を返す) |
|---|---|---|
| 複製 `duplicateSection` | 範囲(セクションの小節、曲末で切る)の中身がすぐ後ろに増え、後ろは範囲の長さだけ後ろへ平行移動、`lengthBars` が範囲の小節数だけ増える。ループ範囲は始点が動くときは終点も動く | 曲長が `maxSongBars` を越える(`songTooLong`) |
| 入れ替え `moveSection` | 2 つのセクションの中身とそのあいだが平行移動する。曲長・ノート数・コード数は不変(境目をまたぐものは 2 つに分かれる) | となりが無い(`noNeighbor`)、となりと小節が重なる(`overlappingSections`) |
| 削除 `deleteSection` | 範囲の中身が消え、後ろが詰まる。リンク元を消したリンクは同じ音で鳴り続ける | — |
| 共通 | 範囲外の発音は平行移動のみ。同じトラックに重なりを作らない。`validateProject` を通る。Undo 1 段。内外の判定には整数 tick を使い、保存する位置は範囲の長さ(拍)だけ丸めずにずらす。0 未満になる開始は 0 にして終わりを保つ(クリップは自分のノートも寄せる) | 結果が `validateProject` を通らない(`invalidResult`)、以下の発音照合で 1 tick でもずれるか期待した音の個数と一致しない(`soundChanged`)、ループ・リンクのクリップかリンク元が境目をまたぐ(`loopingClip` / `linkedClip`。リンク元を分けると左右が同じノートを持つため)、境目でちょうど分けられない(`cannotSplitClip`)、0 拍より前に出るループ・リンク・リンク元(`clipBeforeSongStart`)、動く・分かれる・消えるクリップがあるトラックに対象領域外のクリップがある(`outsideClipDomain`)、セクションが無い・曲の外(`missingSection` / `invalidSectionRange`) |

発音照合では、`soundingEvents` のトラック・音高またはドラムのレーン・強さ・開始 tick・終了 tick が等しい発音を個数まで比較する。ドラムの打点は開始と終了が同じ tick として扱う。

1. 元の曲から境目で分けた後の曲へ。境目をまたぐノートを境目の tick ちょうどで分け、各片をつなぐと元の区間と一致する。ほかの発音は開始・終了と個数が一致する。
2. 分けた後の曲から操作結果へ。範囲外の発音と入れ替えで動く発音は開始・終了とも移動量の tick 分だけずれる。複製では範囲内の発音が元の位置と範囲の長さだけ後ろの位置に各 1 組あり、削除では範囲内の発音が消える。端数の位置の丸めで開始や終了が 1 tick でもずれる場合や、期待した個数と一致しない場合は操作を拒否する。

## 5. Validationルール

| 対象 | ルール |
|---|---|
| bpm | 20〜300 |
| time signature | 分母は 2/4/8/16 のいずれか |
| pitch | 0〜127 |
| velocity | 1〜127 |
| pan | -1.0〜1.0 |
| volume | 0.0〜2.0 |
| track automation.volume / pan / cutoff | 各 points は配列で最大 10,000 点。beat は 0 以上の有限値で昇順。value は有限値で、volume は 0〜1、pan は −1〜1、cutoff は 0.1〜10。マスターにレーンは置けず、ドラムに cutoff は置けない。構造や数値が不正な場合は日本語で報告する |
| track sends | 任意のオブジェクト。各キーは実在するリターンの id で、値は 0〜1 の有限数。継承したプロパティは送り先として扱わない |
| リターントラック | 1 曲に最大 2 つ。クリップやノートを持てず、リターン同士や自分自身には音を送れない |
| chord duration | 0より大きい |
| clip start | 0以上 |
| clip contentLengthBeats | 0 より大きい。ループの実効周期は 1/64 拍以上 |
| 曲長 | 1〜64 小節。v1 の拍子換算で上限を超えた曲は `legacyBarLimit` (65〜256 の整数) まで |
| クリップの配置 | 同一トラック上で重ならない |
| リンク | 同種別の共有元を直接参照し、自分の中身を持たない |
| 発音数 | 曲全体で最大 100,000。ミュートとスウィングの適用前に検証する |
| 発音の計算量 | クリップ、クリップがないトラック、各クリップで参照する保存イベントの合計が最大 100,000。重なりの補正でクリップを別トラックに移しても合計は変わらない |
| swing | 0〜60 |
| loopRange | 0 ≦ startBeat < endBeat |
| track role | chords / bass / melody / drums のいずれか |
| track name | 文字列 |

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
