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
};

// effects の type は 'eq' | 'compressor' | 'filter' | 'delay' | 'reverb'(スキーマ版は上げない)。
// eq か compressor が有効なら、再生・書き出しの処理順は配列順に関わらず eq → compressor → filter → delay → reverb。
// どちらも無効なら配列順のまま(既存プロジェクトの音を変えないため)。delay の timeSeconds は最大 1.5 秒(旧 time / delayTime も同じ上限で、上限超えの保存値は変更前と同じ 1.5 秒に丸める)。
//   eq params:         lowGainDb / midGainDb / highGainDb(各 -12〜12 dB。低域・高域はシェルビング、中域はピーキング)
//   compressor params: thresholdDb(-60〜0)/ ratio(1〜20)/ attackSeconds(0〜1)/ releaseSeconds(0.01〜1)
//   範囲外は validateProject がエラーにする。
// master トラックの volume(0〜2)がマスターゲインになる(ライブ再生と WAV 書き出しで共通)。

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

Clip の意味(再生・WAV・MIDI 共通、`expandClip` が唯一の実装。docs/02 §3.5):

- `lengthBeats`: クリップが鳴る長さ。これ以降に始まるノート・打点は鳴らず、終わりをまたぐノートは終わりで切る。
- `loop` / `contentLengthBeats`: `loop` が true のとき、中身を `contentLengthBeats ?? lengthBeats` 拍ごとに繰り返す。周期をまたぐノートは周期の終わりで切る。周期 0 以下は繰り返さない。1 クリップのループで鳴らす音は最大 100,000 個(`MAX_LOOP_EVENTS`)で、収まる回数だけ鳴らす。1 回分の途中では切らず、最初の 1 回分が上限を超える場合は無音になる。クリップの終わりで途中までになる最後の 1 回は実際に鳴る音だけを数え、残りの範囲は `problems` に鳴らない拍数を返す。上限を超えるループのクリップは `validateProject` が `contentLengthBeats` のエラーとして弾く。編集と保存にも同じ上限を適用するため、保存・読み込みが通ったプロジェクトでは打ち切りは起きない(打ち切りは検証前の値に対する安全策)。周期の中に音が無ければ繰り返さない。丸め誤差を吸収するため、終わりとの差が許容幅以内で始まる音は終わりに来たものとして扱う。許容幅は最大 1e-9 拍で、1 拍未満の範囲では長さに比例して小さくする。
- `aliasOf`: リンク先クリップの `notes` / `drumEvents` / `stepsPerBar` を、自分の `startBeat`・`lengthBeats`・`loop`・`contentLengthBeats` で鳴らす。リンクのリンクはたどる。参照切れ・循環は例外にせず無音にし、理由を `problems` に日本語で返す。クリップの `type` は問わない。
- トラックの種類: `expandClip` にトラックの `type` を渡すと、`drum` は打点だけを返し、`instrument` はノートだけを返す。`audio`・`bus`・`master` のクリップの打点・ノートは無音。外した個数は `problems` に日本語で返す。再生・WAV・MIDI・書き出し前チェックリストはどれもトラックの `type` を渡す。
- 曲の終わり(`lengthBars × beatsPerBar` 拍)以降に始まる音は、再生・WAV・MIDI のどれでも鳴らさない。
- **ノートの `startBeat` とドラムの `stepIndex` はクリップ相対**(クリップの `startBeat` を 0 とする)。コードトラック・セクション・ループ範囲は曲の先頭からの絶対拍なので、ノートに対応するコードは `clip.startBeat + note.startBeat` の拍で引く(Theory Inspector・コーチ・メロディ解析・レッスン判定)。ベース / メロディ生成と「コードをノートにする」は、クリップの範囲内にあるコードだけを相対拍に直してから書き込む。メロディ生成の強拍はクリップの開始拍を足した絶対拍で判定する。生成した音符はクリップの長さで切り、クリップは伸ばさない。範囲内にコードが 1 つもないときは何も書き換えず、その旨を案内する。ベース / メロディ生成では、書き込む音符が繰り返しの 1 回分に収まらない、書き換えで既存のループの上限を超える、またはリンクの共有元を解決できない場合も、既存の音符を残して理由を案内する。
- **ピアノロールの編集範囲**はクリップの終わりと曲の終わりのうち早い方までとする。グリッドは曲の終わりまでを表示し、クリップより後ろの部分は網掛け(`aria-disabled`)で音符を置けない。短縮で範囲外に残った音符はデータに保持し、ピアノロールでの表示と編集の対象から外す。置く・動かす・長さを変える・クオンタイズ(Q)のどれでも音符は編集範囲を越えず(動かす・Q は収まる最後のグリッドへ、置く・長さを変えるは終わりで切る)、クリップの長さは変わらない。ループするクリップでノートを移動・クオンタイズするときは、周期と編集範囲のうち短い方に収める。複数ノートの移動では全体が収まる範囲で同じ拍数だけ動かし、横幅が入りきらないときは開始拍を保つ。網掛けをダブルクリックすると、その拍を含む曲の小節の終わりまでクリップを伸ばすボタンを出し、押したときだけ伸ばす。
- **リンクの編集先**: `aliasOf` を持つクリップは自分の中身を持たず、編集は `resolveEditTarget(project, clipId)` が返すリンクの行き着く先(元のクリップ)に対して行う。ベース / メロディ生成をリンクに行うと、コードはリンクの位置と長さで読み、音符は元のクリップに書く(元のクリップと全リンクが同じ音符を鳴らす)。メロディ添削も元のクリップの音符をリンクの位置で解析する。参照切れ・循環のときは `undefined`。レッスン判定(tutorial-engine)も、リンククリップの中身を元のクリップから数える。スケールやコードに合う音を調べる判定では、リンク自身の長さと繰り返し設定で展開したノートを使う。参照切れ・循環のリンクは、保存されたノートや打点があっても判定には数えない。

クリップ操作(`packages/project-model/src/mutations.ts`、純粋関数)。移動・伸縮・複製に指定した拍が非有限値なら、元の Project を返す。

- `addClip(project, trackId, clip)`: トラックにクリップを追加する。クリップ、ノート、打点の ID が重複する場合は新しい ID を割り当てる。
- `moveClip(project, clipId, startBeat)`: 同じトラック内で動かす。他のクリップと重なる位置なら、重ならない最も近い開始拍(0 以上、同じ距離なら早い方)へ置く。
- `resizeClip(project, clipId, lengthBeats)`: 長さだけ変える。ループの周期は保つ(`contentLengthBeats` が未設定なら元の長さを書き込んでから伸縮する)。
- `splitClip(project, clipId, atBeat)`: 曲の絶対拍 `atBeat` で 2 つに分ける。境界をまたぐノートは 2 つに分け、`durationBeats` を分配する(合計は変わらない)。打点を持つクリップは、再生と同じステップ間隔(リンク元の `stepsPerBar`)で最も近いステップ境界で分ける。どの音も分ける前と同じ拍で鳴る。ループ中のクリップ・リンククリップ・リンク元のクリップは、左側がループ / リンクのまま分割位置で終わり(リンク元は中身をすべて残すので、リンクしているクリップの音は変わらない)、右側は分割位置から後ろで鳴っていた音を自分の中身として持つ、ループもリンクもしない独立クリップになる。成功時は `{ ok: true, project }` を返す。対象がない、指定拍がステップ境界に丸める前か後でクリップの端か外にある、リンクが切れている、展開の上限を超える、またはループした打点が右側のステップに乗らない場合は、`{ ok: false, project, reason }` に元のプロジェクトと失敗理由を返す。右側のステップに乗らない場合の理由は `offGridDrumHit`。
- `duplicateClip(project, clipId, { mode })`: 直後の空き位置に複製する。`copy` は中身を複製した独立クリップ(リンクを複製したときも中身と `stepsPerBar` はリンク元のもの。リンク元が `stepsPerBar` を持たなければ持たない)、`link` は `aliasOf` に元のクリップを指し、ノート・打点を持たない。
- `removeClip(project, clipId)`: 削除する。削除したクリップにリンクしていたクリップは、削除クリップがリンクならその先へ付け替え、そうでなければ中身と `stepsPerBar`(持たなければ持たない)のコピーを受け取って、同じ拍で鳴り続ける。

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

`migrateProject` は冪等で、既存の曲の音を変えない。

- **lengthBeats 切り上げ**: 各クリップの `lengthBeats` を、内部の最後のノート終端(`startBeat + durationBeats`)と最後のドラムステップ終端以上に切り上げる。v1 の再生は `lengthBeats` を無視して全ノートを鳴らしていたため、はみ出した音を残す。ドラムステップ終端は再生と同じく 1 小節の拍数(`beatsPerBar`。6/8 なら 3 拍)を stepsPerBar で割って求める
- **v1 のループとリンク**: v1 の再生どおり各クリップ自身の音を 1 回ずつ鳴らす(D1: 旧ライブ/WAV の音を正とする)。`loop` とリンクは無効にし、元の `loop`、`contentLengthBeats`、`aliasOf` は `legacyClipSettings` に退避する。旧 MIDI との差は既知の制限
- **x/4 以外の拍子の小節換算**: v1 は 1 小節を分子の拍数(6/8 なら 6 拍)として再生していた。v2 の `beatsPerBar`(6/8 なら 3 拍)で同じ音になるよう、`lengthBars` を `ceil(旧小節数 × 分母 / 4)` に、セクションの `startBar` / `lengthBars` を同じ倍率で換算する。ドラムクリップは `stepsPerBar` を `旧 stepsPerBar × 4 / 分母` にし(16 ステップの 6/8 なら 8)、ステップ番号はそのまま。割り切れないときは `stepsPerBar` を 4 倍にしてステップ番号に分母を掛ける。どちらも各打点の拍位置は厳密に変わらない。x/4 の曲は何も変えない
- **master volume 正規化**: `type: 'master'` のトラックの `volume` を 1 にする。v1 ではこの値にかかわらず実効ゲインが常に 1 だったため
- **role 推定**: `type: 'drum'` は `drums`。それ以外はトラック名を大文字小文字を区別せず単語単位で照合し、chords / chord → `chords`、bass → `bass`、melody / lead → `melody`。master と、どれにも当たらないトラックは未設定のまま
- **移行前バックアップ**: localStorage から読んだ JSON の `schemaVersion` が現行より古いと、移行前の生 JSON を `cts.project.backup.v<旧バージョン>` に保存してから移行する。キーはバージョンごとに 1 つで、複数の曲を移行すると最後に読んだ曲で上書きされる。容量超過で保存できなくても移行は続ける。このキーはプロジェクト一覧の対象にしない

### v2 → v3 の移行規則

v2 までのライブ再生と WAV は `lengthBeats` を無視し、各クリップ自身のノート・打点をクリップの長さを超えても 1 回ずつ鳴らしていた。v3 はクリップの長さ・ループ・リンクを音に反映する(docs/02 §3.5)ので、v2 のファイルを読み込むと各クリップを次のように扱う。v1 のファイルは v1 → v2 → v3 の順に移行する。

- 各クリップの `lengthBeats` を、最後のノート終端・ドラムステップ終端以上に切り上げ、はみ出していた音も残す
- 移行後のライブ再生・WAV・MIDI は v2 のライブ再生にそろえ、各クリップ自身の音を 1 回ずつ鳴らす。旧 MIDI はループをノートの終端から求めた長さで繰り返していたため、その出力は移行後に変わる(D1: 旧ライブ/WAV の音を正とし、この MIDI の差は既知の制限として受け入れる)。再生用の `loop` をオフにし、`contentLengthBeats` と `aliasOf` を外す。元の値は復元用の `legacyClipSettings` に記録し、v3 の JSON を保存して読み直しても保持する
- 自分のクリップにノートを持つ v2 の `bus` と `audio` は、同じ ID・音色・音量・パン・ミュート・ソロ・エフェクトを持つ `instrument` に変換する。v2 でそのトラックから鳴っていたノートを再生と WAV で引き続き鳴らせる
- v3 のファイル(`schemaVersion: 3`)は長さ・ループ・リンクを書かれたとおりに鳴らし、読み込み時に変更しない

### クリップの発音規則(収束計画 D2〜D5)

ライブ・WAV・MIDI は、次の 3 つだけを発音の正とする(`packages/project-model/src/sounding.ts`。`.omc/plans/clip-convergence-2026-11-26.md`)。3 経路は結果を書き換えず、形式に合わせて写すだけにする。

- `soundingEvents(project)`: 実際に鳴る音の一覧と `problems`。ループ、リンク、スウィング、曲末の切り方をすべて含む。
- `storedEventAt(project, clipId, localBeat)`: その位置で鳴る音が、どの保存済みのノート・打点(`sourceClipId` と `sourceIndex`)から来たかを返す。なければ `null`。編集 UI は境界の規則を自分で計算せず、これを使う。
- `songEndBeat(project)`: 曲の終わりの拍。`projectLengthBeats` の定義はこの 1 か所にする。

規則:

- **D2 クオンタイズ**: ループ中のクリップは 1 周目の最後のグリッドに留める。クリップは伸ばさず、音も消さない。
- **D3 曲末**: 曲の終わりをまたぐノートは曲の終わりで切る。3 経路で終了 tick は同じ。
- **D4 分割**: ループ・リンクのクリップは分割できない。操作は理由付きで元のプロジェクトを返し、ボタンは無効になる(上の `splitClip` の記述より優先する)。
- **D5 レッスン判定**: クリップの内容を数える判定は、保存された内容ではなく実際に鳴る内容(`soundingEvents`)で数える。
- 境界の比較は `Math.round(beat * PPQ)` の整数 tick で行い、許容誤差の定数は使わない。

## 5. Validationルール

| 対象 | ルール |
|---|---|
| bpm | 20〜300 |
| time signature | 分母は 2/4/8/16 のいずれか |
| pitch | 0〜127 |
| velocity | 1〜127 |
| pan | -1.0〜1.0 |
| volume | 0.0〜2.0 |
| chord duration | 0より大きい |
| clip start | 0以上 |
| clip contentLengthBeats | 0より大きい |
| swing | 0〜60 |
| loopRange | 0 ≦ startBeat < endBeat |
| track role | chords / bass / melody / drums のいずれか |

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
