import type { Course, TutorialLesson } from '../types.js';

const courseId = 'daw-course';

export const DAW_LESSONS: TutorialLesson[] = [
  {
    id: 'daw-arrange-clips',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: 'クリップを並べる',
    description: '音のかたまりを置いて、好きな順番で聞けるようにします。',
    steps: [
      {
        id: 'daw-arrange-add-track',
        title: '楽器の置き場所を作る',
        instruction: '左の一覧で「楽器トラックを追加」を押しましょう。',
        explanation: '楽器ごとにトラックを分けると、音を足したり音量を変えたりしやすくなります。',
        hints: ['左側のトラック一覧の上にボタンがあります。'],
        goal: { kind: 'event', eventType: 'track.added', match: { trackType: 'instrument' } },
      },
      {
        id: 'daw-arrange-create-clip',
        title: 'クリップをもう一つ置く',
        instruction: '「曲全体」を開き、追加したトラックのクリップを選んで「複製(コピー)」を押しましょう。',
        explanation: 'クリップがあると、短い演奏をひとまとまりで扱えます。',
        hints: ['新しいトラックには最初から空のクリップがあります。すでに空きがあれば、空いている場所をダブルクリックして置くこともできます。'],
        goal: { kind: 'event', eventType: 'clip.created' },
      },
      {
        id: 'daw-arrange-split-clip',
        title: 'クリップを二つに分ける',
        instruction: 'クリップを選び、上の目盛りのクリップの途中を Shift を押しながらクリックします。「分割」を押しましょう。',
        explanation: '前半と後半を分けると、片方だけを別の場所へ動かせます。',
        hints: ['「分割」が押せないときは、クリップの端より少し内側の拍を選びましょう。'],
        goal: { kind: 'event', eventType: 'clip.split' },
      },
      {
        id: 'daw-arrange-copy-clip',
        title: '同じ音をもう一度並べる',
        instruction: '音が入ったクリップを選び、「複製(コピー)」を押しましょう。',
        explanation: '短い演奏をもう一度鳴らすと、聴く人がそのフレーズを覚えやすくなります。',
        hints: ['音がないときは、クリップをダブルクリックして開き、ピアノロールのマスをダブルクリックして音を置きましょう。ミュートされていないトラックを使います。'],
        goal: { kind: 'event', eventType: 'clip.created', match: { minSoundingEvents: 1 } },
      },
    ],
  },
  {
    id: 'daw-duplicate-section',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: 'セクションを複製する',
    description: '曲の一部分をまとめてコピーし、もう一度使います。',
    steps: [
      {
        id: 'daw-section-duplicate',
        title: 'まとまりごとコピーする',
        instruction: '「アレンジ」でセクションをクリックし、下に出る「複製」を押しましょう。',
        explanation: 'セクションをコピーすると、同じ部分を繰り返しつつ、あとで片方に変化をつけられます。',
        hints: ['まだ区切りがなければ、「＋ セクションを追加」を押しましょう。'],
        goal: { kind: 'event', eventType: 'section.duplicated' },
      },
      {
        id: 'daw-section-loop',
        title: 'コピーした部分をくり返す',
        instruction: '元のセクションのすぐ右にできたセクションをクリックし、ループ範囲を移しましょう。',
        explanation: 'ループを使うと、手を止めずに同じ部分を何度も聴けます。',
        hints: ['上の目盛りで色がつく範囲を確認し、再生してみましょう。'],
        goal: { kind: 'event', eventType: 'loop.set', match: { loopRangeSet: true } },
      },
    ],
  },
  {
    id: 'daw-record',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: 'キーボードで録音する',
    description: 'PC のキーボードで弾いた音を曲に残します。',
    steps: [
      {
        id: 'daw-record-take',
        title: '弾いた音を残す',
        instruction: '楽器のクリップを開き、「PC で演奏」をオンにします。クリップの頭で「● 録音」を押し、合図のあとで A や S を押して離します。「録音を止める」を押しましょう。',
        explanation: '録音すると、弾いたタイミングを残してから、音の高さや長さを直せます。',
        hints: ['ループがオンなら、まずオフにしましょう。MIDI 鍵盤がなくても、PC の A S D F で弾けます。'],
        goal: { kind: 'event', eventType: 'recording.finished' },
      },
    ],
  },
  {
    id: 'daw-mix',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: 'ミックスを整える',
    description: '楽器の大きさや音色を整え、聴きたい音が分かるようにします。',
    steps: [
      {
        id: 'daw-mix-eq',
        title: 'EQ を入れる',
        instruction: '画面下のミキサーで、楽器の「FX」を開きます。EQ（イコライザー）をオンにしましょう。',
        explanation: 'EQ で低い音を少し弱めると、同時に鳴るベースが聴き取りやすくなります。',
        hints: ['すでにイコライザーを使っていたら、別のトラックを選びましょう。練習用に楽器トラックを足してもかまいません。'],
        goal: { kind: 'event', eventType: 'effect.added', match: { effectType: 'eq' } },
      },
      {
        id: 'daw-mix-fader',
        title: '楽器の音量を変える',
        instruction: '曲を再生し、画面下のミキサーで楽器の音量つまみを少し動かして離しましょう。',
        explanation: '目立ちすぎる楽器の音量を下げると、小さな音も聴き取りやすくなります。',
        hints: ['楽器名の下にある横長のつまみで音量を変えられます。'],
        goal: { kind: 'event', eventType: 'track.volumeChanged' },
      },
      {
        id: 'daw-mix-automation',
        title: '途中で変わる音量を決める',
        instruction: '「曲全体」で楽器の「音の変化」を開き、「音量」を選んで「再生位置に点を追加」を押しましょう。',
        explanation: 'オートメーションを使うと、曲が進むにつれて音量を変えられます。違う高さに二つの点を置くと、その間をなめらかに変えられます。',
        hints: ['追加した点は上下に動かせます。もう一つの点を離れた場所に置いて聴いてみましょう。'],
        goal: { kind: 'event', eventType: 'automation.pointAdded', match: { parameter: 'volume' } },
      },
    ],
  },
  {
    id: 'daw-export',
    courseId,
    level: 'basic',
    schemaVersion: 1,
    title: '曲をファイルに書き出す',
    description: '作った曲を、ほかの場所でも聴ける音声ファイルにします。',
    steps: [
      {
        id: 'daw-export-wav',
        title: 'WAV を保存する',
        instruction: '「書き出し」を開き、範囲を「全体」にして「WAVエクスポート」を押します。確認画面を読んで、ファイルを保存しましょう。',
        explanation: 'WAV にすると、調整した音量や音色も含めて曲を聴けます。',
        hints: ['書き出しが終わったら、保存したファイルを開いて最後まで聴いてみましょう。'],
        goal: { kind: 'event', eventType: 'export.wav' },
      },
    ],
  },
];

export const DAW_COURSE: Course = {
  id: courseId,
  title: 'DAW 操作コース',
  description: '音を並べ、録音して、聴けるファイルにするまでを練習します。',
  lessonIds: DAW_LESSONS.map((lesson) => lesson.id),
};
