// COMPOSE_COURSE — practical composition lessons (Japanese UI)
// 5 lessons × 3-6 steps each

import type { Course, TutorialLesson } from '../types.js';

export const COMPOSE_COURSE: Course = {
  id: 'compose',
  title: '作曲実践',
  description:
    '8小節の曲を完成させるための実践的なレッスンです。コード進行、ドラム、ベース、メロディ、仕上げを順番に学びます。',
  lessonIds: [
    'compose-1',
    'compose-2',
    'compose-3',
    'compose-4',
    'compose-5',
  ],
};

// ─── Lesson 1: 8小節のコード進行を作る ──────────────────────────────────────

export const COMPOSE_LESSON_1: TutorialLesson = {
  id: 'compose-1',
  courseId: 'compose',
  level: 'compose',
  schemaVersion: 1,
  title: '8小節のコード進行を作る',
  description:
    '定番の4コード進行を2回繰り返して、8小節のコード進行を完成させましょう。',
  steps: [
    {
      id: 'compose-1-s1',
      title: '最初のコードを置こう',
      instruction:
        'コードトラックの1小節目に「C」コードを追加してください。',
      explanation:
        'まずは「C（ド・ミ・ソ）」からスタートです。Cメジャーコードはキーの中心で、もっとも安定した響きを持ちます。曲の始まりにぴったりです。',
      goal: {
        kind: 'event',
        eventType: 'chord.added',
        count: 1,
        match: { chordSymbol: 'C' },
      },
      hints: [
        'コードトラックの1小節目をクリックして、コードパレットから「C」を選びましょう。',
        'まず最初の1つだけ置けば次のステップへ進めます。',
      ],
    },
    {
      id: 'compose-1-s2',
      title: '4コード進行を完成させよう',
      instruction:
        'コードトラックに C → G → Am → F の順で4つのコードを置いてください（各1小節）。',
      explanation:
        'C-G-Am-F（I-V-vi-IV）は世界中の名曲で使われている黄金の進行です。明るさ(C)→動き(G)→しっとり感(Am)→温かさ(F)という流れが、聴く人に親しみやすい感情を生みます。',
      goal: {
        kind: 'project',
        predicate: {
          type: 'progressionEquals',
          symbols: ['C', 'G', 'Am', 'F'],
        },
      },
      hints: [
        'C → G → Am → F の順に4つのコードを1小節ずつ置きましょう。',
        '1小節は4拍です。コードの長さを4拍に合わせましょう。',
      ],
    },
    {
      id: 'compose-1-s3',
      title: '8小節に拡張しよう',
      instruction:
        'C-G-Am-F をもう1回繰り返して、合計8つのコードを配置してください。',
      explanation:
        '同じ進行を繰り返すことで8小節の土台ができます。繰り返しは聴きやすさの基本です。後でAセクション(1〜4小節)とBセクション(5〜8小節)に展開するときのベースになります。',
      goal: {
        kind: 'project',
        predicate: { type: 'chordCountAtLeast', value: 8 },
      },
      hints: [
        '5〜8小節目にも同じ C → G → Am → F を繰り返して置きましょう。',
        'コードをコピー&ペーストできると便利です。',
      ],
    },
    {
      id: 'compose-1-s4',
      title: '進行を再生して確認しよう',
      instruction:
        'トランスポートを再生して、8小節のコード進行を通して聴いてみましょう。',
      explanation:
        'C-G-Am-F の進行は2回繰り返すと自然にループします。「あ、どこかで聴いたことがある」という感覚は、この進行が普遍的に心地よいからです。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーで再生できます。',
        'ループ再生をオンにすると繰り返し聴けます。',
      ],
    },
    {
      id: 'compose-1-s5',
      title: '進行クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'コード進行の役割を理解すると、次にドラムやベースを加えるときに迷いにくくなります。',
      goal: { kind: 'exercise' },
      hints: ['C-G-Am-F の各コードの機能を思い出してみましょう。'],
      exercise: {
        kind: 'multipleChoice',
        question:
          'C-G-Am-F（I-V-vi-IV）の中で「ドミナント」機能を持つコードはどれですか？',
        choices: ['C（I）', 'G（V）', 'Am（vi）', 'F（IV）'],
        correctIndex: 1,
        explanation:
          'GコードはCメジャーのV度で、ドミナント機能を持ちます。Cへの解決感を生み出し、進行に推進力を与えます。',
      },
    },
  ],
};

// ─── Lesson 2: ドラムでリズムの土台を作る ────────────────────────────────────

export const COMPOSE_LESSON_2: TutorialLesson = {
  id: 'compose-2',
  courseId: 'compose',
  level: 'compose',
  schemaVersion: 1,
  title: 'ドラムでリズムの土台を作る',
  description:
    'キック・スネア・ハイハットを使った基本的なドラムパターンを作り、曲のリズムの土台を作りましょう。',
  steps: [
    {
      id: 'compose-2-s1',
      title: 'キックを置こう',
      instruction:
        'ドラムトラックのステップシーケンサーで、1拍目と3拍目（ステップ1と9）にキックを入れてください。',
      explanation:
        'キック（バスドラム）は曲の重心です。1拍目と3拍目に置くと「ドン・ドン」というシンプルで安定したグルーヴが生まれます。ポップスやロックの基本パターンです。',
      goal: {
        kind: 'project',
        predicate: { type: 'drumLaneActive', lane: 'kick', minSteps: 2 },
      },
      hints: [
        '16ステップのシーケンサーで、1番目と9番目のボタンをオンにしましょう。',
        'キック（kick）の行を探してください。',
      ],
    },
    {
      id: 'compose-2-s2',
      title: 'スネアを加えよう',
      instruction:
        '2拍目と4拍目（ステップ5と13）にスネアを入れてください。',
      explanation:
        'スネアは「裏拍」に置くのが基本です。キック(1・3拍)とスネア(2・4拍)が組み合わさって、ポップス・ロックの定番リズムが完成します。このパターンを「バックビート」と呼びます。',
      goal: {
        kind: 'project',
        predicate: { type: 'drumLaneActive', lane: 'snare', minSteps: 2 },
      },
      hints: [
        'スネア（snare）の行のステップ5と13をオンにしましょう。',
        'キックとスネアが交互に鳴る感じになればOKです。',
      ],
    },
    {
      id: 'compose-2-s3',
      title: 'ハイハットで細かさを加えよう',
      instruction:
        '8分音符のハイハットを入れてください（2ステップごと：1,3,5,7,9,11,13,15）。',
      explanation:
        'ハイハット（クローズ）を8分音符で刻むと、リズムに細かさとノリが加わります。「タカタカタカタカ」という感じで、ドラムパターンにスピード感が生まれます。',
      goal: {
        kind: 'project',
        predicate: {
          type: 'drumLaneActive',
          lane: 'closedHat',
          minSteps: 4,
        },
      },
      hints: [
        'closedHat の行で、奇数番号のステップ（1,3,5,7,9,11,13,15）をオンにしましょう。',
        '全部で8つのステップをオンにします。',
      ],
    },
    {
      id: 'compose-2-s4',
      title: 'ドラムパターンを再生しよう',
      instruction:
        'トランスポートを再生して、作ったドラムパターンを確認しましょう。',
      explanation:
        'キック+スネア+ハイハットが揃うと、基本的なビートが完成します。コードトラックと一緒に鳴らしてみると、曲らしさがぐっと増します。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーで再生できます。',
        'コードトラックもオンにして一緒に聴いてみましょう。',
      ],
    },
    {
      id: 'compose-2-s5',
      title: 'ドラムのリズムクイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'ドラムの各パーツの役割を理解すると、より効果的なリズムアレンジができるようになります。',
      goal: { kind: 'exercise' },
      hints: ['スネアは「裏拍」に置くのが基本です。'],
      exercise: {
        kind: 'multipleChoice',
        question: '4/4拍子の「バックビート」でスネアを置く拍はどれですか？',
        choices: [
          '1拍目と3拍目',
          '2拍目と4拍目',
          '1拍目と2拍目',
          '3拍目と4拍目',
        ],
        correctIndex: 1,
        explanation:
          'バックビートでは、スネアを2拍目と4拍目（裏拍）に置きます。キックの1・3拍目と交互になることで、安定したグルーヴが生まれます。',
      },
    },
  ],
};

// ─── Lesson 3: コードに合うベースを作る ──────────────────────────────────────

export const COMPOSE_LESSON_3: TutorialLesson = {
  id: 'compose-3',
  courseId: 'compose',
  level: 'compose',
  schemaVersion: 1,
  title: 'コードに合うベースを作る',
  description:
    'コードのルート音を中心にベースラインを作り、リズムと和声の架け橋を作りましょう。',
  steps: [
    {
      id: 'compose-3-s1',
      title: 'ベーストラックに最初の音を置こう',
      instruction:
        'ベーストラック（Bassトラック）のピアノロールで、1小節目の1拍目に音を置いてください。',
      explanation:
        'ベースはコードの一番低い音（ルート音）を鳴らすパートです。コードがCなら「C（ド）」の低い音を置きます。ベースが曲全体の土台を支えます。',
      goal: {
        kind: 'event',
        eventType: 'note.added',
        count: 1,
        match: { trackName: 'Bass' },
      },
      hints: [
        'ベーストラックのクリップをダブルクリックしてピアノロールを開きましょう。',
        '低い音域（MIDI番号36〜48付近）に音を置くとベースらしくなります。',
      ],
    },
    {
      id: 'compose-3-s2',
      title: 'ベースラインを作ろう',
      instruction:
        'ベーストラックに4つ以上の音を置いて、コードに合ったベースラインを作ってください。',
      explanation:
        'コードに合わせてルート音を置くだけで、シンプルで効果的なベースラインができます。例：Cコードの1小節目はC音、Gコードの小節はG音を置く。リズムはキックのタイミングに合わせると自然にグルーヴします。',
      goal: {
        kind: 'project',
        predicate: {
          type: 'noteCountAtLeast',
          trackName: 'Bass',
          value: 4,
        },
      },
      hints: [
        '各コードの小節の最初の拍にルート音を置くだけで十分です。',
        'C=ド(MIDI36か48)、G=ソ(MIDI43か55)、Am=ラ(MIDI33か45)、F=ファ(MIDI41か53)が目安です。',
      ],
    },
    {
      id: 'compose-3-s3',
      title: 'ベースとドラムを合わせて確認しよう',
      instruction:
        'トランスポートを再生して、ドラムとベースが合っているか確認しましょう。',
      explanation:
        'ベースのルート音がキックと同じタイミングで鳴ると、低音が一体となって曲にどっしりとした安定感が生まれます。この「ベースとキックのロック」が、プロのサウンドの基本です。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーで再生できます。',
        'ベースがコードの音から大きく外れていないか耳で確認しましょう。',
      ],
    },
    {
      id: 'compose-3-s4',
      title: 'ベースの役割クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'ベースの基本的な役割を理解することで、より効果的なベースラインを作れるようになります。',
      goal: { kind: 'exercise' },
      hints: ['ベースはコードの「根音（ルート）」を担当します。'],
      exercise: {
        kind: 'multipleChoice',
        question:
          'コードが「Am（ラドミ）」のとき、ベースが一番自然に鳴らす音はどれですか？',
        choices: ['ド（C）', 'ミ（E）', 'ラ（A）', 'ソ（G）'],
        correctIndex: 2,
        explanation:
          'Amコードのルート音は「A（ラ）」です。ベースはルート音を弾くのが基本で、コードの響きを安定させます。',
      },
    },
  ],
};

// ─── Lesson 4: コードに合うメロディを作る ────────────────────────────────────

export const COMPOSE_LESSON_4: TutorialLesson = {
  id: 'compose-4',
  courseId: 'compose',
  level: 'compose',
  schemaVersion: 1,
  title: 'コードに合うメロディを作る',
  description:
    'スケール内の音を使って、コードに合うシンプルなメロディを作りましょう。',
  steps: [
    {
      id: 'compose-4-s1',
      title: 'スケールスナップをオンにしよう',
      instruction:
        'スケールスナップを「Cメジャー」に設定してオンにしてください。',
      explanation:
        'スケールスナップをオンにすると、スケール外の音が自動で補正されます。初めてメロディを作るときは、まずスケール内の音だけを使うのが失敗しないコツです。',
      goal: { kind: 'event', eventType: 'scale_snap.enabled', count: 1 },
      hints: [
        'ツールバーの「スケール」メニューからCメジャーを選んでオンにしましょう。',
        '一度設定するとすべての入力がスケールに合うようになります。',
      ],
    },
    {
      id: 'compose-4-s2',
      title: 'メロディの最初の音を置こう',
      instruction:
        'メロディトラック（Melodyトラック）のピアノロールで、1小節目の1拍目に音を置いてください。',
      explanation:
        'メロディの最初の音が曲の印象を決めます。コードがCのときは、C・E・Gのどれかの音（コードトーン）から始めると安定感があります。特にE（ミ）は明るく聞こえやすい音です。',
      goal: {
        kind: 'event',
        eventType: 'note.added',
        count: 1,
        match: { trackName: 'Melody' },
      },
      hints: [
        'メロディトラックのピアノロールを開きましょう。',
        'E（ミ）やG（ソ）など、高めの音域（MIDI60〜76）に置くとメロディらしくなります。',
      ],
    },
    {
      id: 'compose-4-s3',
      title: 'メロディを4小節分作ろう',
      instruction:
        'メロディトラックに合計6つ以上の音を置いて、4小節分のメロディを作ってください。',
      explanation:
        'スケール内の音をつなぎ合わせるだけでメロディになります。「同じ音を繰り返す」「上がって下がる」「跳躍する」など、少し変化をつけると聴き飽きないメロディになります。',
      goal: {
        kind: 'project',
        predicate: {
          type: 'noteCountAtLeast',
          trackName: 'Melody',
          value: 6,
        },
      },
      hints: [
        'まずは短い音（8分音符）を4〜8個置いてみましょう。',
        'コードのトーン（C・E・G など）を強拍（1拍目・3拍目）に置くと安定します。',
      ],
    },
    {
      id: 'compose-4-s4',
      title: '全パートを合わせて再生しよう',
      instruction:
        'コード・ドラム・ベース・メロディを一緒に再生して確認しましょう。',
      explanation:
        '4パートが揃うと、シンプルですが「曲らしい」サウンドになります。メロディがコードやベースと自然に合っているか確認しましょう。気になる音があれば少し動かして調整しましょう。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーで再生できます。',
        '全トラックのミュートをオフにして、全部一緒に鳴らしましょう。',
      ],
    },
    {
      id: 'compose-4-s5',
      title: 'メロディのコードトーンクイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'コードトーンを強拍に置くと安定感が生まれます。この原則を知っておくと、メロディの微調整がしやすくなります。',
      goal: { kind: 'exercise' },
      hints: ['Cコード（ドミソ）の構成音はC・E・Gの3つです。'],
      exercise: {
        kind: 'multipleChoice',
        question:
          'コードが「C（ドミソ）」のとき、メロディが1拍目（強拍）に置くと一番安定する音はどれですか？',
        choices: ['D（レ）', 'F（ファ）', 'E（ミ）', 'B（シ）'],
        correctIndex: 2,
        explanation:
          'E（ミ）はCコードの構成音（コードトーン）です。強拍にコードトーンを置くと、メロディとコードが自然にマッチします。DやFはコードトーンではないため、強拍では少し浮いた感じになります。',
      },
    },
  ],
};

// ─── Lesson 5: 曲の構成とミックスで仕上げる ──────────────────────────────────

export const COMPOSE_LESSON_5: TutorialLesson = {
  id: 'compose-5',
  courseId: 'compose',
  level: 'compose',
  schemaVersion: 1,
  title: '曲の構成とミックスで仕上げる',
  description:
    'サビ（コーラス）のセクションを追加して、音量バランスを整えて曲を完成させましょう。',
  steps: [
    {
      id: 'compose-5-s1',
      title: 'コーラスセクションを追加しよう',
      instruction:
        'セクションマーカーで「コーラス（サビ）」セクションを追加してください。',
      explanation:
        '曲に「イントロ→Aメロ→サビ」のような構成を付けると、聴く人が「ここがサビだ」と感じやすくなります。サビは曲のハイライトで、一番盛り上がる部分です。',
      goal: {
        kind: 'project',
        predicate: { type: 'hasSection', sectionType: 'chorus' },
      },
      hints: [
        'タイムライン上部のセクションエリアを右クリックして「セクションを追加」を選びましょう。',
        'セクションタイプで「chorus（コーラス/サビ）」を選んでください。',
      ],
    },
    {
      id: 'compose-5-s2',
      title: 'メロディの音量を調整しよう',
      instruction:
        'メロディトラックの音量を0.8〜1.2の範囲に調整してください。',
      explanation:
        'ミックスでは各パートの音量バランスが重要です。メロディが他のパートに埋もれないように、少し音量を上げるのが一般的です。ただし大きすぎると他のパートが聴こえにくくなります。',
      goal: {
        kind: 'project',
        predicate: {
          type: 'trackVolumeInRange',
          trackName: 'Melody',
          min: 0.8,
          max: 1.2,
        },
      },
      hints: [
        'ミキサーまたはトラックヘッダーのフェーダーで音量を調整しましょう。',
        '1.0が標準音量です。メロディは少し上げ気味（1.0〜1.2）にするのがおすすめです。',
      ],
    },
    {
      id: 'compose-5-s3',
      title: '全体を再生して最終確認しよう',
      instruction:
        'トランスポートを再生して、曲全体を通して確認しましょう。',
      explanation:
        '全パートを通して聴くと、音量バランスや各パートの絡み合いが分かります。「メロディがはっきり聴こえる」「ドラムが埋もれていない」「ベースが低音を支えている」この3点を確認しましょう。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーで再生できます。',
        '気になる部分があれば、各トラックのフェーダーを微調整しましょう。',
      ],
    },
    {
      id: 'compose-5-s4',
      title: 'ミックスのクイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'ミックスの基本を理解しておくと、仕上げの作業がスムーズになります。',
      goal: { kind: 'exercise' },
      hints: ['メロディが最も前に出るように音量バランスを調整します。'],
      exercise: {
        kind: 'multipleChoice',
        question:
          'ポップスのミックスで一般的に一番音量が大きく（前に出て）聞こえるパートはどれですか？',
        choices: [
          'ベース',
          'ドラム（キック）',
          'メロディ（ボーカル）',
          'コード（ピアノ）',
        ],
        correctIndex: 2,
        explanation:
          'ポップスではメロディ（ボーカル）が一番前に出るように混ぜるのが基本です。聴く人はメロディに注目するので、埋もれないようにします。ドラムのキックも大切ですが、メロディより前には出しません。',
      },
    },
    {
      id: 'compose-5-s5',
      title: '曲をエクスポートしよう',
      instruction:
        '「書き出し（エクスポート）」メニューからMIDIまたはWAVファイルとして書き出してください。',
      explanation:
        '完成した曲をファイルに書き出すと、他のアプリで開いたり、人に聴かせたりできます。MIDIは音楽データ（音の高さ・タイミング情報）、WAVは音声ファイル（実際の音）です。',
      goal: { kind: 'event', eventType: 'export.midi', count: 1 },
      hints: [
        'メニューの「ファイル→書き出し」またはエクスポートボタンをクリックしましょう。',
        'まずMIDI形式で書き出してみましょう。',
      ],
    },
    {
      id: 'compose-5-s6',
      title: '曲の構成クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        '曲の構成を理解することで、次の曲作りでより意図的にセクションを設計できるようになります。',
      goal: { kind: 'exercise' },
      hints: ['サビは曲の一番盛り上がる部分です。'],
      exercise: {
        kind: 'orderChoices',
        question: 'ポップスの一般的な曲の構成を順番に並べてください。',
        choices: [
          'サビ（コーラス）',
          'Aメロ（ヴァース）',
          'イントロ',
          'アウトロ',
        ],
        correctOrder: [2, 1, 0, 3],
        explanation:
          'イントロ→Aメロ→サビ→アウトロ が基本的な構成です。実際にはBメロ（プリコーラス）が入ることも多いですが、まずはこの4段階を覚えましょう。',
      },
    },
  ],
};

export const COMPOSE_LESSONS: TutorialLesson[] = [
  COMPOSE_LESSON_1,
  COMPOSE_LESSON_2,
  COMPOSE_LESSON_3,
  COMPOSE_LESSON_4,
  COMPOSE_LESSON_5,
];
