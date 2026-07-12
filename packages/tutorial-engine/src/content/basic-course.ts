// BASIC_COURSE — music theory foundation lessons (Japanese UI)
// 4 lessons × 3-6 steps each

import type { Course, TutorialLesson } from '../types.js';

export const BASIC_COURSE: Course = {
  id: 'basic',
  title: '音楽理論の基礎',
  description:
    'ドレミの仕組みからダイアトニックコードまで、作曲に必要な基礎知識を身につけましょう。',
  lessonIds: ['basic-1', 'basic-2', 'basic-3', 'basic-4'],
};

// ─── Lesson 1: 音名と半音・全音 ──────────────────────────────────────────────

export const BASIC_LESSON_1: TutorialLesson = {
  id: 'basic-1',
  courseId: 'basic',
  level: 'basic',
  schemaVersion: 1,
  title: '音名と半音・全音',
  description:
    'ピアノの鍵盤を見ながら、音の名前と音の間隔（半音・全音）を学びましょう。',
  steps: [
    {
      id: 'basic-1-s1',
      title: 'ピアノロールに音を置いてみよう',
      instruction:
        'ピアノロールエディタを開き、「C」の音（ド）をクリックして1つノートを置いてください。',
      explanation:
        '音楽の音には名前がついています。英語では C, D, E, F, G, A, B（ドレミファソラシ）と呼びます。まずは「C（ド）」から始めましょう。',
      goal: { kind: 'event', eventType: 'note.added', count: 1 },
      hints: [
        'ピアノロールの左端にある鍵盤の「C」と書かれた行をクリックしてみましょう。',
        '中央のCはMIDIノート番号60です。白鍵の一番左から数えると、8番目の白鍵です。',
      ],
    },
    {
      id: 'basic-1-s2',
      title: '半音と全音を確認しよう',
      instruction:
        'ピアノロールで「C」と「D」の音を並べて置いてください（同じ長さで）。',
      explanation:
        '「C（ド）」から「D（レ）」は「全音」（2半音分）の距離です。鍵盤の上で黒鍵1つを間に挟んで隣り合う音が全音です。半音は鍵盤が直接隣り合う距離（例：EとF）です。',
      goal: {
        kind: 'project',
        predicate: { type: 'noteCountAtLeast', trackName: 'Melody', value: 2 },
      },
      hints: [
        'Cの音の右隣（全音先）がDです。間に黒鍵（C#）があるのが見えますか？',
        'ピアノロールでは上が高い音、下が低い音です。CとDは隣の行です。',
      ],
    },
    {
      id: 'basic-1-s3',
      title: '音名クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        '音名を正確に覚えることで、コードやスケールの理解がスムーズになります。',
      goal: { kind: 'exercise' },
      hints: [
        'ピアノの鍵盤で白鍵だけ数えると C, D, E, F, G, A, B の7音です。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: '「C（ド）」の半音上の音は何ですか？',
        choices: ['D（レ）', 'C#（ド#）', 'B（シ）', 'E（ミ）'],
        correctIndex: 1,
        explanation:
          'Cの半音上はC#（またはDb）です。ピアノでは黒鍵にあたります。',
      },
    },
  ],
};

// ─── Lesson 2: メジャースケールの仕組み ──────────────────────────────────────

export const BASIC_LESSON_2: TutorialLesson = {
  id: 'basic-2',
  courseId: 'basic',
  level: 'basic',
  schemaVersion: 1,
  title: 'メジャースケールの仕組み',
  description:
    'ドレミファソラシドの音の並び方（全全半全全全半）を理解しましょう。',
  steps: [
    {
      id: 'basic-2-s1',
      title: 'Cメジャースケールを弾いてみよう',
      instruction:
        'ピアノロールに C, D, E, F, G, A, B の7音を順番に置いてください。',
      explanation:
        'Cメジャースケールはピアノの白鍵だけを使った音の並びです。「全・全・半・全・全・全・半」という間隔で並んでいます。この並び方のルールがすべてのメジャースケールに共通です。',
      goal: {
        kind: 'project',
        predicate: { type: 'noteCountAtLeast', trackName: 'Melody', value: 7 },
      },
      hints: [
        'C(ド)→D(レ)→E(ミ)→F(ファ)→G(ソ)→A(ラ)→B(シ) の順に置きましょう。',
        'スケールスナップ機能をオンにすると、スケール内の音だけ入力できて便利です。',
      ],
    },
    {
      id: 'basic-2-s2',
      title: 'スケールスナップを使ってみよう',
      instruction:
        'キーを「C」、スケールを「メジャー」に設定し、「スケールスナップ」をオンにしてください。すでにこの設定でオンなら、自動で完了します。',
      explanation:
        'スケールスナップは、オンにした後に新しく追加した音や移動した音を、Cメジャーの音に合わせます。すでに置かれている音は変わりません。',
      goal: {
        kind: 'event',
        eventType: 'scale_snap.enabled',
        count: 1,
        match: { key: 'C', scale: 'major' },
      },
      hints: [
        '上部の「ピアノロール」タブを開き、キーが「C」、スケールが「メジャー」になっていることを確認してから、スケールスナップをオンにしましょう。',
        'すでにCメジャーでオンなら操作は不要です。このステップは自動で完了します。',
      ],
    },
    {
      id: 'basic-2-s3',
      title: 'スケールの種類クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'メジャースケールの音の間隔のパターンを覚えることが、他のスケールを理解する基礎になります。',
      goal: { kind: 'exercise' },
      hints: ['C→Dは全音、E→Fは半音です。'],
      exercise: {
        kind: 'multipleChoice',
        question: 'メジャースケールの音の間隔のパターンはどれですか？',
        choices: [
          '全・全・半・全・全・全・半',
          '全・半・全・全・半・全・全',
          '半・全・全・全・半・全・全',
          '全・全・全・半・全・全・半',
        ],
        correctIndex: 0,
        explanation:
          'メジャースケールは「全全半全全全半」のパターンです。例：C→D(全)→E(全)→F(半)→G(全)→A(全)→B(全)→C(半)。',
      },
    },
    {
      id: 'basic-2-s4',
      title: '曲を再生して確認しよう',
      instruction:
        'トランスポートの再生ボタンを押して、置いた音を聴いてみましょう。',
      explanation:
        '自分の耳で音の並びを確認することが大切です。明るく爽やかな響きを感じたら、それがメジャースケールの特徴です。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーで再生できます。',
        'もう一度スペースキーを押すと停止します。',
      ],
    },
  ],
};

// ─── Lesson 3: ダイアトニックコード ──────────────────────────────────────────

export const BASIC_LESSON_3: TutorialLesson = {
  id: 'basic-3',
  courseId: 'basic',
  level: 'basic',
  schemaVersion: 1,
  title: 'ダイアトニックコード',
  description:
    'メジャースケールの各音を根音（ルート）とした7つのコードを学びましょう。',
  steps: [
    {
      id: 'basic-3-s1',
      title: 'コードトラックにCのコードを置こう',
      instruction:
        'コードトラックの1小節目に「C」（Cメジャーコード）を追加してください。',
      explanation:
        'コードは3つ以上の音を同時に鳴らすものです。Cメジャーコードは C, E, G の3音からできています（「1度・3度・5度」）。',
      goal: { kind: 'event', eventType: 'chord.added', count: 1 },
      hints: [
        'コードトラックの小節上でクリックまたは右クリックするとコードを追加できます。',
        'コードパレットから「C」を選んでください。',
      ],
    },
    {
      id: 'basic-3-s2',
      title: '4つのコードを置こう',
      instruction:
        'コードトラックに C, Am, F, G の4つのコードを1小節ずつ配置してください。',
      explanation:
        'これらはCメジャースケールのダイアトニックコードの代表格です。I(C)・vi(Am)・IV(F)・V(G) という組み合わせで、多くのポップス曲に使われています。',
      goal: {
        kind: 'project',
        predicate: { type: 'chordCountAtLeast', value: 4 },
      },
      hints: [
        'C(Iコード)→Am(viコード)→F(IVコード)→G(Vコード)の順に置いてみましょう。',
        '各コードは1小節分（4拍）の長さにしましょう。',
      ],
    },
    {
      id: 'basic-3-s3',
      title: 'コードの機能クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'ダイアトニックコードにはそれぞれ「トニック・サブドミナント・ドミナント」という機能があります。この機能を理解すると、自然な進行が作れるようになります。',
      goal: { kind: 'exercise' },
      hints: [
        'Cメジャーキーで G コードは「引っ張り感」を持つコードです。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question:
          'Cメジャーキーで「G（ソシレ）」コードはどの機能を持ちますか？',
        choices: [
          'トニック（安定）',
          'サブドミナント（やや不安定・色彩感）',
          'ドミナント（緊張・解決したがる）',
          'どの機能もない',
        ],
        correctIndex: 2,
        explanation:
          'GコードはCメジャーのV度で、ドミナント機能を持ちます。Cコードに向かって解決しようとする緊張感があります。',
      },
    },
    {
      id: 'basic-3-s4',
      title: 'コード進行の並び替えクイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'コードの並び順を変えると、曲の雰囲気が大きく変わります。典型的な進行を体で覚えましょう。',
      goal: { kind: 'exercise' },
      hints: ['ドミナント(G)は通常トニック(C)の直前に来ます。'],
      exercise: {
        kind: 'orderChoices',
        question:
          '最も自然な「解決感」がある順番に並べ替えてください（Cメジャー）。',
        choices: ['Am（vi）', 'F（IV）', 'G（V）', 'C（I）'],
        correctOrder: [1, 0, 2, 3],
        explanation:
          'F→Am→G→C の順は「サブドミナント→トニック代理→ドミナント→トニック」で自然な解決感があります。',
      },
    },
  ],
};

// ─── Lesson 4: コードの機能（T・SD・D） ──────────────────────────────────────

export const BASIC_LESSON_4: TutorialLesson = {
  id: 'basic-4',
  courseId: 'basic',
  level: 'basic',
  schemaVersion: 1,
  title: 'コードの機能（T・SD・D）',
  description:
    'トニック・サブドミナント・ドミナントの3つの機能とその流れを理解しましょう。',
  steps: [
    {
      id: 'basic-4-s1',
      title: 'I-IV-V-I の進行を作ろう',
      instruction:
        'コードトラックに C → F → G → C の順でコードを置いてください。',
      explanation:
        'I-IV-V-I はもっとも基本的なコード進行です。「安定（C）→色彩（F）→緊張（G）→解決（C）」という流れで、曲の起承転結を作れます。',
      goal: {
        kind: 'project',
        predicate: {
          type: 'progressionEquals',
          symbols: ['C', 'F', 'G', 'C'],
        },
      },
      hints: [
        'コードトラックに4つのコードを順番に置きましょう。',
        '各コードは1小節ずつ配置してください。',
      ],
    },
    {
      id: 'basic-4-s2',
      title: '機能分類クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'コードの機能を理解すると、「なぜこの進行が気持ちいいのか」が分かるようになります。',
      goal: { kind: 'exercise' },
      hints: [
        'T=トニック(安定)、SD=サブドミナント(色彩)、D=ドミナント(緊張)です。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: 'Cメジャーキーで「F（ファラド）」コードの機能はどれですか？',
        choices: [
          'トニック（T）',
          'サブドミナント（SD）',
          'ドミナント（D）',
          'サブドミナントマイナー（SDm）',
        ],
        correctIndex: 1,
        explanation:
          'FコードはCメジャーのIV度で、サブドミナント機能を持ちます。安定と緊張の中間にあり、曲に色彩感を与えます。',
      },
    },
    {
      id: 'basic-4-s3',
      title: '曲を再生して機能を感じよう',
      instruction:
        'トランスポートを再生して I-IV-V-I の進行を聴いてみましょう。',
      explanation:
        'I-IV-V-I を聴くと、Gコード(V)の「解決したい感じ」とCコード(I)で着地する「安心感」が感じられるはずです。この感覚を体で覚えることが大切です。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーで再生できます。',
        'GコードからCコードに移る瞬間の「解決感」に注目してみましょう。',
      ],
    },
    {
      id: 'basic-4-s4',
      title: '進行の順序クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        '機能の流れを理解すれば、オリジナルのコード進行を作るときも迷いにくくなります。',
      goal: { kind: 'exercise' },
      hints: ['「D→T」（ドミナント→トニック）が最も強い解決感を生みます。'],
      exercise: {
        kind: 'orderChoices',
        question:
          'T→SD→D→T の機能の順に対応するコードを並べ替えてください（Cメジャー）。',
        choices: ['G（V）', 'F（IV）', 'C（I）開始', 'C（I）解決'],
        correctOrder: [2, 1, 0, 3],
        explanation:
          'C(T開始)→F(SD)→G(D)→C(T解決) が I-IV-V-I の機能的な流れです。',
      },
    },
    {
      id: 'basic-4-s5',
      title: 'BPMを確認しよう',
      instruction:
        'プロジェクトのBPMが60〜180の範囲に設定されているか確認してください。',
      explanation:
        'BPM（Beats Per Minute）は曲のテンポです。ポップスは通常90〜140 BPM、バラードは60〜90 BPM が多いです。',
      goal: {
        kind: 'project',
        predicate: { type: 'bpmInRange', min: 60, max: 180 },
      },
      hints: [
        'トランスポートバーの数字がBPMです。クリックして変更できます。',
        '初期値は通常120 BPMに設定されています。',
      ],
    },
  ],
};

export const BASIC_LESSONS: TutorialLesson[] = [
  BASIC_LESSON_1,
  BASIC_LESSON_2,
  BASIC_LESSON_3,
  BASIC_LESSON_4,
];
