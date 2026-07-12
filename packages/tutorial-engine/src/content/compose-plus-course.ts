// COMPOSE_PLUS_COURSE — 作曲ステップアップ（応用）レッスン (Japanese UI)
//
// basic（理論の基礎）と compose（8小節を完成させる実践）を終えた初学者が、
// 一歩進んだ「曲を魅力的にする」テクニックを学ぶ課程。
// 今回のアップデートで入った機能を題材にする:
//   - 借用和音 / セカンダリドミナント（コード候補ポップオーバーで表示）
//   - ドラムの swing / ヒューマナイズ（グルーヴ）
//   - トラック・インサートエフェクト（Filter / Delay / Reverb）
//   - ローカル作曲コーチ
//
// すべてのステップは StepGoal 種別（event / project predicate / exercise）で
// 達成判定する。グルーヴ（drum.grooveChanged）とエフェクト（effect.added）の
// ステップは、実際にその操作をしたときだけ発火する専用イベントで判定する
// （＝再生ボタンだけでは合格にならない）。
// 文言はすべて初学者にやさしい日本語で、音楽的にも正しい説明にしている。

import type { Course, TutorialLesson } from '../types.js';

export const COMPOSE_PLUS_COURSE: Course = {
  id: 'compose-plus',
  title: '作曲ステップアップ',
  description:
    '基礎と実践を終えたら、曲を「もっと魅力的に」するテクニックを学びましょう。借用和音・セカンダリドミナントで彩りを、グルーヴとエフェクトで質感を、コーチと書き出しで仕上げます。',
  lessonIds: [
    'compose-plus-1',
    'compose-plus-2',
    'compose-plus-3',
    'compose-plus-4',
    'compose-plus-5',
  ],
};

// ─── Lesson 1: 借用和音で“エモさ”を出す ──────────────────────────────────────

export const COMPOSE_PLUS_LESSON_1: TutorialLesson = {
  id: 'compose-plus-1',
  courseId: 'compose-plus',
  level: 'compose',
  schemaVersion: 1,
  title: '借用和音で“エモさ”を出す',
  description:
    'ダイアトニックだけの進行に、同じ主音の短調から借りてきた「借用和音」を1つ加えて、切なさ・深みを出しましょう。',
  steps: [
    {
      id: 'compose-plus-1-s1',
      title: 'まずは基本の進行を用意しよう',
      instruction:
        'コードトラックに、コードを2つ以上置いて短い進行を用意してください（例: C → G）。',
      explanation:
        '借用和音は「普段と違う響き」で効くので、まずは普通のダイアトニックコード（キーの中の基本コード）を土台に置きます。ここでは C メジャーの I（C）や V（G）から始めましょう。',
      goal: {
        kind: 'project',
        predicate: { type: 'chordCountAtLeast', value: 2 },
      },
      hints: [
        'コードレーンをクリックして、候補から C や G を選びましょう。',
        'まだ曲が空なら、テンプレートの I–V–vi–IV を置くのが早いです。',
      ],
    },
    {
      id: 'compose-plus-1-s2',
      title: '借用和音を1つ加えよう',
      instruction:
        'コード候補のポップオーバーで「借用和音」に分類された候補（例: Fm、A♭、B♭）を1つ選んで進行に加えてください。',
      explanation:
        'C メジャーの曲に、同じ主音の短調（Cマイナー）からコードを借りてくるのが「借用和音（モーダルインターチェンジ）」です。中でも iv（Fm）は、明るいメジャーの中に一瞬の切なさを差し込む定番。ポップスやゲーム音楽の“エモい”瞬間はこれでできています。',
      goal: { kind: 'event', eventType: 'chord.added', count: 1 },
      hints: [
        'コードをクリックすると出る候補パネルで、色分けされた「借用和音」グループを探しましょう。',
        'まずは Fm（iv）がおすすめ。C の直後や、主音 C に戻る直前に置くと効果的です。',
      ],
    },
    {
      id: 'compose-plus-1-s3',
      title: '借用和音クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        '借用和音は「どこから借りてくるか」を知っておくと使いこなせます。',
      goal: { kind: 'exercise' },
      hints: ['「同じ主音の“短調”から借りる」のが基本でした。'],
      exercise: {
        kind: 'multipleChoice',
        question:
          'C メジャーの曲で使う「借用和音（モーダルインターチェンジ）」は、主にどこから借りてきますか？',
        choices: [
          '同じ主音の短調（Cマイナー）',
          '半音上のキー（C#メジャー）',
          '完全に無関係なキー',
          '同じ音名の別の曲',
        ],
        correctIndex: 0,
        explanation:
          '借用和音は、同じ主音の短調（ここでは Cマイナー）から借りてくるのが基本です。iv(Fm)・♭VI(A♭)・♭VII(B♭) などがよく使われ、メジャーの明るさの中に短調の色を差し込めます。',
      },
    },
  ],
};

// ─── Lesson 2: セカンダリドミナントでサビ前を盛り上げる ──────────────────────

export const COMPOSE_PLUS_LESSON_2: TutorialLesson = {
  id: 'compose-plus-2',
  courseId: 'compose-plus',
  level: 'compose',
  schemaVersion: 1,
  title: 'セカンダリドミナントでサビ前を盛り上げる',
  description:
    '次のコードへ「強く進みたくなる」力を一時的に作るセカンダリドミナントを使って、進行に推進力を足しましょう。',
  steps: [
    {
      id: 'compose-plus-2-s1',
      title: 'セカンダリドミナントを1つ加えよう',
      instruction:
        'コード候補のポップオーバーで「セカンダリドミナント」に分類された候補（例: D7、E7、A7）を1つ進行に加えてください。',
      explanation:
        'ある和音へ「その和音のドミナント（V7）」を一時的に置くのがセカンダリドミナントです。例えば V(G) の前に D7 を置くと（D7 は G にとっての V7）、G へ強く進みたくなる推進力が生まれます。サビや盛り上がりの直前に効きます。',
      goal: { kind: 'event', eventType: 'chord.added', count: 1 },
      hints: [
        '候補パネルの「セカンダリドミナント」グループから選びましょう。',
        'D7 →（G へ）や E7 →（Am へ）のように、"行き先の直前" に置くのがコツです。',
      ],
    },
    {
      id: 'compose-plus-2-s2',
      title: '進行を再生して推進力を感じよう',
      instruction:
        'コードを再生して、セカンダリドミナントから次のコードへ進む「引っ張られる感じ」を聴いてみましょう。',
      explanation:
        'セカンダリドミナントには不安定な緊張感があり、その分だけ次の和音に着地したときの解決感が強くなります。「緊張 → 解決」の落差が、盛り上がりの正体です。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: ['スペースキーで再生できます。', 'セカンダリドミナントの箇所に耳を集中してみましょう。'],
    },
    {
      id: 'compose-plus-2-s3',
      title: 'セカンダリドミナント クイズ',
      instruction: '下の問題に答えてください。',
      explanation: 'セカンダリドミナントの「働き」を言葉で確認しておきましょう。',
      goal: { kind: 'exercise' },
      hints: ['「次のコードへ強く進みたくなる、一時的なドミナント」でした。'],
      exercise: {
        kind: 'multipleChoice',
        question: 'セカンダリドミナント（例: G の前に置く D7）の主な効果はどれですか？',
        choices: [
          '次のコードへの推進力（進みたくなる力）を強める',
          'テンポを自動で速くする',
          '曲の音量を上げる',
          'コードを消して無音にする',
        ],
        correctIndex: 0,
        explanation:
          'セカンダリドミナントは「行き先のコードのV7」を一時的に借りることで、そのコードへ強く進みたくなる推進力（緊張→解決）を作ります。サビ前など、盛り上げたい直前に置くと効果的です。',
      },
    },
  ],
};

// ─── Lesson 3: リズムに“ノリ”を出す（グルーヴ） ──────────────────────────────

export const COMPOSE_PLUS_LESSON_3: TutorialLesson = {
  id: 'compose-plus-3',
  courseId: 'compose-plus',
  level: 'compose',
  schemaVersion: 1,
  title: 'リズムに“ノリ”を出す（グルーヴ）',
  description:
    '機械的に等間隔なドラムに、スイングとヒューマナイズで“人間らしいノリ”を足しましょう。',
  steps: [
    {
      id: 'compose-plus-3-s1',
      title: 'ドラムパターンを用意しよう',
      instruction:
        'ドラムのステップシーケンサーで、キックやスネアのステップをいくつかオンにしてください。',
      explanation:
        'まずはノリを付ける前の「素の」パターンを用意します。キックを1・3拍、スネアを2・4拍に置く基本形でOKです。',
      goal: { kind: 'event', eventType: 'drum.stepToggled', count: 1 },
      hints: [
        'ドラムグリッドのマスをクリックするとステップがオン/オフします。',
        'まずはキック（Kick）の行から置いてみましょう。',
      ],
    },
    {
      id: 'compose-plus-3-s2',
      title: 'スイングをかけてノリを出そう',
      instruction:
        'ドラムパネルの「スイング」スライダーを右へ動かして、10%以上まで上げてみましょう。',
      explanation:
        'スイングは、裏拍（偶数の16分）の発音を少し後ろにずらすことで“ハネた”ノリを作ります。0のときは真っ直ぐ（マシン的）、上げるほどジャズやヒップホップのような揺れが出ます。かけすぎると重くなるので、まずは10〜30%くらいから。スライダーを動かして数値が上がると、このステップはクリアです。上げたら再生して、ノリの変化も聴き比べてみましょう。',
      goal: {
        kind: 'event',
        eventType: 'drum.grooveChanged',
        match: { swingAtLeast: 0.1 },
      },
      hints: [
        'ドラムパネルの「スイング」スライダーを、表示が10%以上になるまで右へ動かしましょう。',
        '同じパターンでもスイングの有無で印象が大きく変わります。上げたあと再生して聴き比べてみましょう。',
      ],
    },
    {
      id: 'compose-plus-3-s3',
      title: 'グルーヴ クイズ',
      instruction: '下の問題に答えてください。',
      explanation: 'スイングが「何を」しているのかを言葉で確認しましょう。',
      goal: { kind: 'exercise' },
      hints: ['裏拍のタイミングを“ずらす”のがスイングでした。'],
      exercise: {
        kind: 'multipleChoice',
        question: 'ドラムの「スイング」を上げると、何が変わりますか？',
        choices: [
          '裏拍の発音が少し後ろにずれて“ハネた”ノリになる',
          'すべての音が半音上がる',
          'テンポの数値（BPM）が変わる',
          'ドラムの音色がピアノに変わる',
        ],
        correctIndex: 0,
        explanation:
          'スイングは裏拍（偶数の16分）の発音タイミングを少し後ろへずらして、ハネたノリ（グルーヴ）を作ります。音程やテンポの数値そのものは変わりません。ヒューマナイズを足すと強弱も揺れて、より人間らしくなります。',
      },
    },
  ],
};

// ─── Lesson 4: エフェクトで音を仕上げる ──────────────────────────────────────

export const COMPOSE_PLUS_LESSON_4: TutorialLesson = {
  id: 'compose-plus-4',
  courseId: 'compose-plus',
  level: 'compose',
  schemaVersion: 1,
  title: 'エフェクトで音を仕上げる',
  description:
    'ミキサーの各トラックに Filter / Delay / Reverb を足して、音に奥行きと質感を加えましょう。',
  steps: [
    {
      id: 'compose-plus-4-s1',
      title: 'ミキサーで音量バランスを整えよう',
      instruction:
        'ミキサーで、どれか1つのトラックの音量（フェーダー）を動かしてバランスを調整してください。',
      explanation:
        '仕上げの第一歩はバランスです。まずベースとドラムを土台として少し大きめに、メロディを聴こえる程度に。全部を最大にすると団子になって何も目立たなくなります。',
      goal: { kind: 'event', eventType: 'track.volumeChanged', count: 1 },
      hints: [
        'ミキサーの各トラックにある音量つまみ／フェーダーを動かしましょう。',
        'まずはドラムとベースの音量を基準に決めると整えやすいです。',
      ],
    },
    {
      id: 'compose-plus-4-s2',
      title: 'エフェクトを足して音を仕上げよう',
      instruction:
        'どれかのトラックに Reverb（響き）・Delay（やまびこ）・Filter のいずれかを実際に1つ追加してください。',
      explanation:
        'Reverb は空間の“響き”を足して音を遠く・広く感じさせます。Delay は音を繰り返す“やまびこ”で、メロディに広がりを出せます。Filter は高音・低音を削って音の“明るさ”を調整します。かけすぎると濁るので、うっすらから始めるのがコツです。トラックにエフェクトを1つ追加すると、このステップはクリアです。追加したあと再生して、原音との違いを聴いてみましょう。',
      goal: { kind: 'event', eventType: 'effect.added', count: 1 },
      hints: [
        'ミキサーのトラックで「音づくり」を見つけ、「追加する効果」から Reverb か Delay か Filter を選びましょう。',
        '追加できたら wet（かかり具合）を少しだけ上げて、原音とのバランスを聴きましょう。',
      ],
    },
    {
      id: 'compose-plus-4-s3',
      title: 'エフェクト クイズ',
      instruction: '下の問題に答えてください。',
      explanation: '3つのエフェクトの役割を整理しておきましょう。',
      goal: { kind: 'exercise' },
      hints: ['「響き」を足すのがどれか、を思い出しましょう。'],
      exercise: {
        kind: 'multipleChoice',
        question: '音に“空間の響き”を足して、広がりや奥行きを感じさせるエフェクトはどれですか？',
        choices: ['Reverb（リバーブ）', 'Filter（フィルター）', 'テンポ', 'クオンタイズ'],
        correctIndex: 0,
        explanation:
          'Reverb（リバーブ）は空間の響きを加えて、音を広く・奥行きのあるものにします。Delay は音を繰り返す“やまびこ”、Filter は高音/低音を削って明るさを調整するエフェクトです。',
      },
    },
  ],
};

// ─── Lesson 5: コーチを使って仕上げ、書き出す（キャップストーン） ─────────────

export const COMPOSE_PLUS_LESSON_5: TutorialLesson = {
  id: 'compose-plus-5',
  courseId: 'compose-plus',
  level: 'compose',
  schemaVersion: 1,
  title: 'コーチを使って仕上げ、書き出す',
  description:
    '作曲コーチの提案を参考に最後の仕上げをして、完成した曲を MIDI と WAV で書き出しましょう。',
  steps: [
    {
      id: 'compose-plus-5-s1',
      title: '全体を再生して聴き返そう',
      instruction: '曲を最初から再生して、全体のバランスと流れを聴き返してください。',
      explanation:
        '仕上げの前に、まず通しで聴くことが大切です。「サビが盛り上がっているか」「メロディが埋もれていないか」を耳で確認しましょう。作曲コーチのパネルには、いまの曲を見た改善提案（この解析は端末内で完結します）が並ぶので、迷ったら参考にしましょう。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーで最初から再生できます。',
        '右側の「作曲コーチ」パネルの提案に目を通してみましょう。',
      ],
    },
    {
      id: 'compose-plus-5-s2',
      title: 'MIDI で書き出そう',
      instruction: '完成した曲を MIDI ファイルとして書き出してください。',
      explanation:
        'MIDI は「どの音をいつ鳴らすか」の情報を保存する形式です。他の DAW に読み込んで音色を差し替えたり、続きを編集したりできます。作った曲を“素材”として残せます。',
      goal: {
        kind: 'event',
        eventType: 'export.midi',
        match: { format: 'midi' },
      },
      hints: [
        '上部の「書き出し」を開き、「MIDIエクスポート」を選びましょう。',
        '書き出した .mid は、このアプリの MIDIインポートで読み戻すこともできます。',
      ],
    },
    {
      id: 'compose-plus-5-s3',
      title: 'WAV で書き出して完成！',
      instruction: '仕上げに、曲を WAV（音声ファイル）として書き出してください。',
      explanation:
        'WAV は実際に鳴っている“音そのもの”を保存する形式です。動画のBGMにしたり、そのまま共有したりできます。ここまでできたら、あなたのオリジナル曲が完成です！おめでとうございます。',
      goal: {
        kind: 'event',
        eventType: 'export.wav',
        match: { format: 'wav' },
      },
      hints: [
        '上部の「書き出し」を開き、「WAVエクスポート」を選びましょう。',
        'WAV はファイルサイズが大きめですが、そのまま再生・共有できます。',
      ],
    },
    {
      id: 'compose-plus-5-s4',
      title: '仕上げの順番クイズ',
      instruction: '下の問題に、作業の順番として自然な流れになるよう並べ替えて答えてください。',
      explanation:
        '仕上げは「作る → 整える → 書き出す」の順が基本です。',
      goal: { kind: 'exercise' },
      hints: ['まず曲を作り、バランスやエフェクトで整えてから、最後に書き出します。'],
      exercise: {
        kind: 'orderChoices',
        question: '曲を仕上げて共有するまでの自然な順番に並べ替えてください。',
        choices: [
          'コード・ドラム・メロディで曲を作る',
          '音量バランスとエフェクトで整える',
          'MIDI / WAV で書き出す',
        ],
        correctOrder: [0, 1, 2],
        explanation:
          'まず曲の中身（コード・リズム・メロディ）を作り、次に音量バランスやエフェクトで質感を整え、最後に MIDI / WAV として書き出して共有します。この順番だと、整える対象がはっきりして仕上げがスムーズです。',
      },
    },
  ],
};

export const COMPOSE_PLUS_LESSONS: TutorialLesson[] = [
  COMPOSE_PLUS_LESSON_1,
  COMPOSE_PLUS_LESSON_2,
  COMPOSE_PLUS_LESSON_3,
  COMPOSE_PLUS_LESSON_4,
  COMPOSE_PLUS_LESSON_5,
];
