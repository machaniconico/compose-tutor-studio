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

### Course 4: DAW 操作コース

音楽理論ではなく、画面の操作を一つずつ試すコース(`daw-course`、`packages/tutorial-engine/src/content/daw-course.ts`)。全ステップのゴールは確定操作のAppEventだけで判定し、Project状態の再照合に頼らない。文章はこのアプリの画面に合わせて書き下ろし、他のDAWの手引きや用語を写さない。

| Lesson | 内容 | 判定するEvent |
|---|---|---|
| `daw-tracks-clips` | 楽器トラックを足す、クリップを分割する、曲の長さを変える | `track.added`(`trackType: instrument`)、`clip.split`、`song.lengthChanged` |
| `daw-edit-notes` | 音を置く、Shiftを押しながらドラッグして格子からずらし、クオンタイズで寄せる、再生して聴く | `note.added`、`notes.quantized`、`transport.played` |
| `daw-accompaniment` | コードを置く、伴奏パターンから伴奏トラックを作る、聴く | `chord.added`、`accompaniment.created`、`transport.played` |
| `daw-mix-export` | イコライザーを足す、音量を変える、24 bit のWAVを書き出す | `effect.added`(`effectType: eq`)、`track.volumeChanged`、`export.wav`(`bitDepth: 24`) |

**扱わない機能**(本体に無い、または完了を確かめる手段が無いため。実装後に、そのEventとあわせて足す):

- MIDI録音、ステップ入力、ループ範囲の書き出し(本体に未実装)
- オートメーション、セクションの複製、クリップの複製(本体にこれらを表すAppEventが無い。`clip.created` / `section.added` / `bpm.changed` は型だけで、現状どの操作からも発行されない)
- PC鍵盤での演奏、音・コードの試聴(音を鳴らすだけで、確定する状態が無い)
- コード検出(既存の`chord.added`で足りるため、専用Eventは足さない)

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

レッスン目標は、確定操作を表すAppEventと、Storeへ採用済みのProject/UI状態の2経路で評価する。

| Event | Payload例 | 用途 |
|---|---|---|
| `project.created` | templateId, key, bpm | 初回導線 |
| `chord.added` | bar, chordSymbol, degree | コード課題判定 |
| `note.added` | pitch, startBeat, durationBeats, trackId | ピアノロール課題 |
| `scale_snap.enabled` | key, scale | 操作理解 |
| `clip.created` | type, bars, trackId | パターン作成課題 |
| `export.midi` / `export.wav` | format(WAVはsampleRate, bitDepthも) | 最終課題、書き出し形式の課題 |
| `track.added` | trackId, trackName, trackType | トラック追加課題 |
| `clip.split` | trackId, clipId, rightClipId | クリップ分割課題 |
| `song.lengthChanged` | lengthBars | 曲の長さ課題 |
| `notes.quantized` | clipId, noteCount | クオンタイズ課題 |
| `accompaniment.created` | trackId, noteCount | 伴奏パターン課題 |

イベントは「利用者がその操作をした」ことを表す。**元に戻す・やり直すは、元の操作のイベントを再発行しない**(Undo/Redoで教材が進まない)。

- `track.added`と`song.lengthChanged`は、採用された変更をStoreが確定する1か所(`commitProject`)で、変更前後のProjectを比べて発行する。トラックの追加ダイアログ、複製、リバーブ用リターン、「ファイルから追加」の音声取り込み、MIDI取り込み(作ったトラックごとに1回)、伴奏パターンなど、どの経路でも1トラックにつちょうど1回で、断られた操作では出ない。曲の長さは、直接の変更に加え、コード提案が最終小節で曲を延ばした時やMIDI取り込みで長くなった時も、小節数が変わった時だけ1回出る。操作側では重ねて発行しない。
- `clip.split`は分割の成功後、`notes.quantized`は1つ以上の音が実際に動いた時だけ、`accompaniment.created`は伴奏が採用された後に、それぞれちょうど1回発行する(伴奏の新しいトラックには`track.added`も出る)。
- `chord.added` / `chord.changed`もStoreが採用した後にだけ発行する。録音中などで断られた編集では出ない。
- `export.wav`は保存まで成功した後に、書き出しに使った形式を付けて発行し、キャンセルでは発行しない。

一致条件の判定では、payloadを信用しない。payloadが`null`・配列・基本型・Proxyで、値の読み取りが例外を投げる場合は、例外にせず「一致しない」とする。

プロジェクト編集を表すイベントは、候補が検証を通りStoreへ採用された後に、採用済みの値から発行する。対象が存在しない操作、同値変更、保存可能範囲を外れて拒否された候補では発行しない。生成IDを持つ`effect.added`等は、そのIDが採用済みProjectに実在することも確認する。これにより、画面に反映されなかった操作で教材だけが進む状態を禁止する。

状態を条件にする目標は、操作を見逃して到達不能にならないよう次の契約にする。

- `kind: "project"`はレッスン開始・再開、採用済みProject参照の更新（イベントを伴わない編集、Undo/Redo、Project切替・読込を含む）、および直前手順の完了直後に、最新の確定Projectで再照合する
- 1つの状態目標が成立したら、次も状態目標（Project predicateまたは現在有効な`scale_snap.enabled`）である間だけ同じ最新状態で順に再照合し、最初の未成立目標・通常イベント目標・演習目標で止める
- 同じ同期的なcommitでProject更新とpost-commit AppEventが生じる場合、そのEventは操作時点の手順にだけ適用し、直後の手順へ再利用しない。Project再照合は同一ターン内でまとめ、レッスンの中断・再開始時には古い予約を無効化する
- 状態再照合はAppEvent busへ人工イベントを再配信しない。成立して進んだ最終stepと進捗を即時反映・保存し、表示中だった前stepのhintを消去する
- 値を指定する目標は完全一致で判定する。Cメジャーの`scale_snap.enabled`は`key: "C"`かつ`scale: "major"`で、スナップが現在オンのときだけ成立する
- `noteCountAtLeast`と`drumLaneActive`は各timeline Clip instanceの解決済みpayloadを数える。正本と各valid direct aliasは配置ごとに1回数え、dangling/unresolved aliasは0件とする。`Clip.loop`の反復は教材上の編集event数を増やさない

### 4.2 判定DSL

- Project predicate: `chordCountAtLeast`、`progressionEquals`、`drumLaneActive`、`noteCountAtLeast`、`hasSection`、`bpmInRange`、`trackVolumeInRange`
- Event goal: `AppEventType`、任意の一致条件（`swingAtLeast`だけは下限判定。`trackType`・`sampleRate`・`bitDepth`は完全一致で、payload自身が持つ値だけを見る）、必要event数
- Exercise goal: 選択、並べ替え、音名・コード等の回答を採点し、正解時だけ進行

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
