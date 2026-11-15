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
  notes?: NoteEvent[];
  drumEvents?: DrumEvent[];
  stepsPerBar?: number; // ドラムクリップの 1 小節のステップ数(未設定は 16)。新規クリップは拍子に合わせて beatsPerBar × 4(4/4=16、3/4=12)。ステップ i の拍位置は i × beatsPerBar / stepsPerBar。拍子を変えると beatsPerBar × 4 に揃え、各打点の拍位置を保つ(同じレーン・同じステップに重なった打点は 1 つだけ残し、消える数は変更前に確認する)
  audioAssetId?: string;
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
- 現行の `schemaVersion` は 2。値は `CURRENT_SCHEMA_VERSION` だけで定義し、生成コードに数値を直書きしない
- 新しいバージョンのファイルは読み込みを拒否する
- オプションフィールドの追加だけならバージョンを上げない

### v1 → v2 の移行規則

`migrateProject` は冪等で、既存の曲の音を変えない。

- **lengthBeats 切り上げ**: 各クリップの `lengthBeats` を、内部の最後のノート終端(`startBeat + durationBeats`)と最後のドラムステップ終端以上に切り上げる。v1 の再生は `lengthBeats` を無視して全ノートを鳴らしていたため、はみ出した音を残す。ドラムステップ終端は再生と同じく 1 小節の拍数(`beatsPerBar`。6/8 なら 3 拍)を stepsPerBar で割って求める
- **x/4 以外の拍子の小節換算**: v1 は 1 小節を分子の拍数(6/8 なら 6 拍)として再生していた。v2 の `beatsPerBar`(6/8 なら 3 拍)で同じ音になるよう、`lengthBars` を `ceil(旧小節数 × 分母 / 4)` に、セクションの `startBar` / `lengthBars` を同じ倍率で換算する。ドラムクリップは `stepsPerBar` を `旧 stepsPerBar × 4 / 分母` にし(16 ステップの 6/8 なら 8)、ステップ番号はそのまま。割り切れないときは `stepsPerBar` を 4 倍にしてステップ番号に分母を掛ける。どちらも各打点の拍位置は厳密に変わらない。x/4 の曲は何も変えない
- **master volume 正規化**: `type: 'master'` のトラックの `volume` を 1 にする。v1 ではこの値にかかわらず実効ゲインが常に 1 だったため
- **role 推定**: `type: 'drum'` は `drums`。それ以外はトラック名を大文字小文字を区別せず単語単位で照合し、chords / chord → `chords`、bass → `bass`、melody / lead → `melody`。master と、どれにも当たらないトラックは未設定のまま
- **移行前バックアップ**: localStorage から読んだ JSON の `schemaVersion` が現行より古いと、移行前の生 JSON を `cts.project.backup.v<旧バージョン>` に保存してから移行する。キーはバージョンごとに 1 つで、複数の曲を移行すると最後に読んだ曲で上書きされる。容量超過で保存できなくても移行は続ける。このキーはプロジェクト一覧の対象にしない

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
