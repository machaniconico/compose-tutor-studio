# 03. チュートリアル・学習仕様

## 1. 基本方針

チュートリアルは「ツールの使い方」だけではなく、「なぜその操作が作曲上有効なのか」を教える。

本アプリの教材は、以下の3層で構成する。

| 層 | 内容 | 例 |
|---|---|---|
| 操作 | DAWの使い方 | ノートを置く、コードを変更する、書き出す |
| 理論 | 音楽理論 | メジャースケール、ダイアトニックコード、コード機能 |
| 作曲判断 | 曲作りの判断 | なぜサビで音を増やすか、なぜ強拍にコードトーンを置くか |

## 2. 学習コース構成

### Course 0: 最初の1曲

目的: 理論を細かく理解する前に、1曲を完成させる。

| Lesson | タイトル | 成果物 |
|---|---|---|
| 0-1 | テンプレートから音を鳴らす | 4小節ループ再生 |
| 0-2 | コード進行を選ぶ | 4コード進行 |
| 0-3 | ドラムを足す | 16ステップドラム |
| 0-4 | ベースを足す | ルート中心のベース |
| 0-5 | メロディを足す | 4小節メロディ |
| 0-6 | 8小節に展開する | A/A' 構成 |
| 0-7 | 音量を整える | クリップなしのミックス |
| 0-8 | 書き出す | MIDI/WAV |

### Course 1: 音とスケール

| Lesson | 内容 | 演習 |
|---|---|---|
| 1-1 | 音名とピアノロール | C, D, E を置く |
| 1-2 | 半音と全音 | Cメジャースケールを作る |
| 1-3 | メジャー/マイナー | CメジャーとAマイナーを比較 |
| 1-4 | スケール内/外 | スケール外音を見つける |
| 1-5 | フレーズ | 2小節モチーフを作る |

### Course 2: コード理論

| Lesson | 内容 | 演習 |
|---|---|---|
| 2-1 | 三和音 | C, F, G, Am を作る |
| 2-2 | ダイアトニックコード | I〜viiø を並べる |
| 2-3 | トニック/サブドミナント/ドミナント | 機能を分類する |
| 2-4 | 定番進行 | I-V-vi-IV を使う |
| 2-5 | 7thコード | maj7, m7, 7 を比較 |
| 2-6 | セカンダリードミナント | E7 -> Am を試す |
| 2-7 | 借用和音 | iv, bVII を試す |

### Course 3: 作曲実践

| Lesson | 内容 | 演習 |
|---|---|---|
| 3-1 | ドラムの役割 | キック/スネア/ハットを分けて作る |
| 3-2 | ベースの役割 | ルートと5度で支える |
| 3-3 | メロディの着地 | 強拍にコードトーンを置く |
| 3-4 | 反復と変化 | 2小節モチーフを変形 |
| 3-5 | セクション構成 | A/B/Chorus を作る |
| 3-6 | 盛り上げ | 密度、音域、音色を変える |
| 3-7 | 仕上げ | 音量、パン、空間系を整える |

## 3. Lessonデータ仕様

```json
{
  "id": "course2_lesson4",
  "title": "定番進行 I-V-vi-IV",
  "level": "beginner",
  "estimatedMinutes": 8,
  "goals": [
    "I-V-vi-IV の度数を説明できる",
    "Cメジャーで C-G-Am-F を配置できる",
    "各コードの機能を確認できる"
  ],
  "prerequisites": ["course2_lesson2"],
  "steps": [
    {
      "type": "explain",
      "body": "I-V-vi-IV は安定感と展開感を作りやすい進行です。"
    },
    {
      "type": "task",
      "action": "place_chord_progression",
      "target": ["C", "G", "Am", "F"],
      "bars": 4
    },
    {
      "type": "check",
      "checker": "chord_progression_equals",
      "expected": ["I", "V", "vi", "IV"]
    }
  ]
}
```

## 4. Tutorial Engine

### 4.1 イベント駆動

アプリ内の操作はイベントとして記録し、レッスン進行判定に使う。

| Event | Payload例 | 用途 |
|---|---|---|
| `project.created` | templateId, key, bpm | 初回導線 |
| `chord.added` | bar, chordSymbol, degree | コード課題判定 |
| `note.added` | pitch, start, duration, trackId | ピアノロール課題 |
| `scale_snap.enabled` | key, scale | 操作理解 |
| `clip.created` | type, bars | パターン作成課題 |
| `export.completed` | format | 最終課題 |

### 4.2 判定関数

- `hasChordProgression(project, degrees, startBar)`
- `hasNotesWithinScale(track, key, scale, ratio)`
- `hasDrumPattern(track, patternType)`
- `hasBassRootOnDownbeat(track, chordTrack, ratio)`
- `hasMelodyChordToneOnStrongBeat(track, chordTrack, ratio)`
- `hasExported(format)`

### 4.3 フィードバック設計

フィードバックは3段階で返す。

1. 結果: 成功/惜しい/要修正
2. 理由: どの条件が満たされたか
3. 次の一手: 具体的な編集指示

例:

> 惜しいです。1小節目と3小節目はコードトーンに着地していますが、2小節目の強拍がスケール外音です。Gコード上では G/B/D のどれかに着地すると安定します。

## 5. 学習UI

### 5.1 Learn Panel

右サイドバーに常時表示できる。

- 現在のレッスン
- 目標
- 現在の達成状況
- 次に押すボタン/編集する場所
- 用語説明
- ヒント

### 5.2 Inline Hint

エディタ上の該当箇所に吹き出し表示。

- ノート
- コードイベント
- トラックヘッダー
- ミキサー

### 5.3 Theory Inspector

選択中の音楽要素を分析する。

- ノート: 音名、度数、コードトーンか
- コード: 構成音、機能、テンション
- フレーズ: 音域、跳躍、反復、着地点

## 6. 難易度調整

| モード | 表示内容 |
|---|---|
| Beginner | 専門用語を避け、操作と結果を説明 |
| Standard | 度数、コード機能、スケールを表示 |
| Advanced | テンション、借用、代理、ボイスリーディングを表示 |

## 7. 進捗保存

- lesson status: not_started / in_progress / completed / skipped
- step progress
- score
- attempts
- lastFeedback
- nextReviewAt

## 8. カリキュラム拡張案

- EDM基礎
- Lo-fi Hip Hop基礎
- ゲームBGM基礎
- ボカロ/歌もの基礎
- シティポップ風コード進行
- ブルース/ジャズ入門
- ミックス入門
- 耳コピ入門
