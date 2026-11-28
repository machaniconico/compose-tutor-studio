/**
 * DAW 操作コース(移植 P60 / wave5 US-030)。
 *
 * 曲づくりのアプリの「操作」を一つずつ試すコースです。音楽理論ではなく、
 * 画面のどこを触ると何が起きるかを、実際に操作して確かめます。
 *
 * 設計の決まり:
 *  - 各ステップのゴールは、実際の操作が成功した後に出るアプリのイベントだけで判定する
 *    (断られた操作では進まない)。
 *  - 文章はすべてこのアプリの画面に合わせて書き下ろした。
 *  - 次の機能は、まだ本体に無い、または完了を確かめる手段が無いため扱わない
 *    (docs/03 の「DAW 操作コース」を参照): MIDI 録音、ステップ入力、ループ範囲の書き出し、
 *    オートメーション、セクションの複製、PC 鍵盤・音の試聴(鳴らすだけで状態が変わらない)。
 */

import type { Course, TutorialLesson } from '../types.js';

const courseId = 'daw-course';

export const DAW_LESSONS: TutorialLesson[] = [
  {
    id: 'daw-tracks-clips',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: 'トラックとクリップを扱う',
    description: '楽器を足し、音のかたまりを二つに分け、曲の長さを整えます。',
    steps: [
      {
        id: 'daw-tracks-clips-s1',
        title: '楽器の置き場所を足す',
        instruction: '左の「トラック」一覧の「＋ 追加」を押し、「楽器トラック」を選んで「追加」を押しましょう。',
        explanation: '楽器ごとにトラックを分けておくと、あとから音量や音色を楽器ごとに変えられます。',
        hints: [
          '「トラックの種類」で「楽器トラック」が選ばれているか確かめましょう。',
          '名前は空のままにせず、分かりやすい名前を付けると迷いません。',
        ],
        goal: { kind: 'event', eventType: 'track.added', match: { trackType: 'instrument' } },
      },
      {
        id: 'daw-tracks-clips-s2',
        title: 'クリップを二つに分ける',
        instruction: '「アレンジ」タブでクリップをクリックして選び、「分割位置（小節）」にクリップの内側の小節を入れて「分割」を押しましょう。',
        explanation: '一つのクリップを前半と後半に分けると、片方だけを動かしたり、別の音を重ねたりできます。',
        hints: [
          'クリップの端と同じ位置では分けられません。端より少し内側の位置を入れましょう。',
          '分けたあと、右側のクリップが自動で選ばれます。',
        ],
        goal: { kind: 'event', eventType: 'clip.split' },
      },
      {
        id: 'daw-tracks-clips-s3',
        title: '曲の長さを変える',
        instruction: '「テンポ / 拍子」タブの「曲の長さ」で小節数を変え、「変更」を押しましょう。',
        explanation: '曲の長さは小節の数で決まります。短くすると終わりより後ろのものは消えるので、音があるところより短くはできません。',
        hints: [
          '断られたときは、画面に出る理由を読み、音のない小節までにしましょう。',
          '長くする分には、中身は何も消えません。',
        ],
        goal: { kind: 'event', eventType: 'song.lengthChanged' },
      },
    ],
  },
  {
    id: 'daw-edit-notes',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: '音のタイミングを整える',
    description: '音を置き、ずれた位置を格子に寄せて、聴いて確かめます。',
    steps: [
      {
        id: 'daw-edit-notes-s1',
        title: '音を置く',
        instruction: '「ピアノロール」タブで、マス目をダブルクリックして音を一つ置きましょう。',
        explanation: '横が時間、縦が音の高さです。置く場所で、いつ・どの高さで鳴るかが決まります。',
        hints: [
          '先に左のトラック一覧で、音を入れたい楽器トラックのクリップを選びましょう。',
        ],
        goal: { kind: 'event', eventType: 'note.added' },
      },
      {
        id: 'daw-edit-notes-s2',
        title: 'ずれた音を格子に寄せる',
        instruction: '置いた音をクリックして選び、Shift キーを押しながら少し横へドラッグして、格子からずらします。そのあと、ピアノロール上部の「クオンタイズ」を押しましょう。',
        explanation: 'クオンタイズは、音の始まりをいちばん近い格子の線へ寄せる操作です。手でずらした音がそろい、リズムが安定します。',
        hints: [
          'Shift を押さずにドラッグすると、音は格子に吸い付くので、ずれは作れません。',
          '「グリッド」が「1/4」なら、いちばん近い拍に寄ります。',
          '音が一つも選ばれていないと、「クオンタイズ」は押せません。',
        ],
        goal: { kind: 'event', eventType: 'notes.quantized' },
      },
      {
        id: 'daw-edit-notes-s3',
        title: '再生して聴き比べる',
        instruction: '再生ボタンを押して、そろえた音を聴きましょう。',
        explanation: '数字や見た目だけでなく、耳で確かめるのが大事です。そろえる前と後で、ノリの違いを感じてみましょう。',
        hints: ['スペースキーでも再生できます。'],
        goal: { kind: 'event', eventType: 'transport.played' },
      },
    ],
  },
  {
    id: 'daw-accompaniment',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: 'コードから伴奏を作る',
    description: 'コードを置いて、そこから伴奏のトラックを自動で作ります。',
    steps: [
      {
        id: 'daw-accompaniment-s1',
        title: 'コードを置く',
        instruction: 'コードトラックの小節をクリックして、コードを一つ追加しましょう。',
        explanation: 'コードは、伴奏が使う音のもとになります。コードが無い小節には、伴奏も作られません。',
        hints: [
          'コードを選ぶ画面で、候補から「C」などを選びましょう。',
          'コードは 1 小節に一つずつ置くと、あとで伴奏の形がつかみやすいです。',
        ],
        goal: { kind: 'event', eventType: 'chord.added' },
      },
      {
        id: 'daw-accompaniment-s2',
        title: '伴奏を作る',
        instruction: '右側の「アシスタント」タブの「伴奏パターン」で、小節の範囲と形を選んで「伴奏を作る」を押しましょう。',
        explanation: '伴奏は、新しい「伴奏」トラックに作られます。いま使っているトラックは変わらないので、気軽に試せます。',
        hints: [
          '「はじめの小節」と「おわりの小節」が、コードを置いた小節に重なっているか確かめましょう。',
          '気に入らなければ、元に戻す操作 1 回で取り消せます。',
        ],
        goal: { kind: 'event', eventType: 'accompaniment.created' },
      },
      {
        id: 'daw-accompaniment-s3',
        title: '作った伴奏を聴く',
        instruction: '再生ボタンを押して、伴奏といっしょに曲を聴きましょう。',
        explanation: 'コードの変わり目で音の高さがどうつながるかに耳を向けると、「前のコードから近い音でつなぐ」の効果が分かります。',
        hints: ['スペースキーでも再生できます。'],
        goal: { kind: 'event', eventType: 'transport.played' },
      },
    ],
  },
  {
    id: 'daw-mix-export',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: '音を整えてファイルにする',
    description: '音色と音量を整え、聴けるファイルに書き出します。',
    steps: [
      {
        id: 'daw-mix-export-s1',
        title: 'イコライザーを足す',
        instruction: '画面下のミキサーで楽器の「音づくり」を探し、「追加する効果」から「イコライザーを追加」を選びましょう。',
        explanation: 'イコライザーは、低い音・中くらいの音・高い音の強さを分けて変えられます。ほかの楽器と音がぶつかるときに使います。',
        hints: [
          '「効果なし」と出ている楽器のそばに、選ぶ欄があります。',
          '追加したら、つまみを少し動かして音の変わり方を聴いてみましょう。',
        ],
        goal: { kind: 'event', eventType: 'effect.added', match: { effectType: 'eq' } },
      },
      {
        id: 'daw-mix-export-s2',
        title: '楽器の音量を変える',
        instruction: '曲を再生しながら、ミキサーで楽器の音量のつまみを動かしましょう。',
        explanation: '目立ちすぎる楽器は少し下げると、ほかの音が聴こえやすくなります。全部を大きくしても聴き取りやすくはなりません。',
        hints: ['各楽器の名前の近くに「音量」のつまみがあります。'],
        goal: { kind: 'event', eventType: 'track.volumeChanged' },
      },
      {
        id: 'daw-mix-export-s3',
        title: '高い音質で書き出す',
        instruction: '上部の「書き出し」を開き、「ビット数」を「24 bit」にして「WAVエクスポート」を押し、ファイルを保存しましょう。',
        explanation: '24 bit は、16 bit より細かく音を記録します。あとで編集や仕上げをするファイルには、24 bit が向いています。聴くだけの配布なら 16 bit で足ります。',
        hints: [
          '「サンプルレート」は、迷ったら 48 kHz でかまいません。',
          '書き出しが終わったら、保存したファイルを開いて最後まで聴いてみましょう。',
        ],
        goal: { kind: 'event', eventType: 'export.wav', match: { format: 'wav', bitDepth: 24 } },
      },
    ],
  },
];

export const DAW_COURSE: Course = {
  id: courseId,
  title: 'DAW 操作コース',
  description: '音を並べ、整えて、聴けるファイルにするまでの画面操作を練習します。',
  lessonIds: DAW_LESSONS.map((lesson) => lesson.id),
};
