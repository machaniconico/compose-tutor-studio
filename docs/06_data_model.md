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
  timeSignature: [number, number];
  key: MusicalKey;
  scale: ScaleName;
  lengthBars: number;
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
  color?: string;
  clips: Clip[];
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  instrument?: InstrumentConfig;
  effects: EffectConfig[];
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
