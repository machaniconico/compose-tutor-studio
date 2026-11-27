# v10 ゴールデン(P04)

main の現行 v10 の出力を固定するテストです。後続のスキーマ変更(v11 / v12)で、既存ファイルが同じバイト・同じ音のままであることを証明するために使います。

## 固定しているもの

- `fixtures/` : 入力。手作りの v10 見本 3 つ(`v10-automation-routing` / `v10-drum-loop-alias` / `v10-tempo-meter-map`)と、移行経路の入力 `v1-legacy` / `v2-legacy`。
- `expected/` : `encodeProjectJson` の出力(`*.json` と `*.sha256`)。対象は `createDefaultProject`、`createEmptyProject`、全テンプレート、v10 見本、v1/v2 の移行結果。
- `apps/studio/tests/golden/expected/` : 同じプロジェクト群の `buildScheduleEvents` スナップショット(ソート済みのプレーンデータ)に、テンポ・拍子マップ越しの秒数とオートメーションの解決値を添えたもの。studio の `createDefaultProject` も固定。

見本は音量・パン・マスターのオートメーション(Read / Bypass)、pre / post の send、スウィング付きドラム、MIDI クリップのループ、エイリアスクリップ、テンポ変更、拍子変更を含みます。

## 変更してよい条件

これらのファイルは、PR が意図的に v10 の出力を変える場合を除き、変更してはいけません。差分が出たら回帰を疑ってください。v11 / v12 の PR で v10 の期待値が変わる時は、理由を PR に書いてください。

## 再生成

通常のテスト実行は期待値を書き換えません(不一致なら失敗します)。再生成は環境変数で明示します。

```sh
GOLDEN_UPDATE=1 pnpm --filter @cts/project-model exec vitest run tests/golden
GOLDEN_UPDATE=1 pnpm --filter @cts/studio exec vitest run tests/golden
```

ID は乱数 nonce を固定しカウンタをケースごとにリセットして決定論化しています。時刻はテストで固定した値です。

## 守らない範囲

- グラフのノード配線(`connectRouteEdge` など AudioNode の接続)は固定しない。ルーティングは計画とエッジゲインまでを固定する。
- オーディオクリップのトリム(`sourceStartFrame` / フェード等)は固定しない。
