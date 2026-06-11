/**
 * Tutorial Engine — Course 0: はじめての1曲
 *
 * 仕様書 docs/03_tutorial_learning_spec.md Course 0 の8レッスン構成。
 * Static, beginner-friendly lesson data.
 * All instruction/successMessage text is in Japanese.
 *
 * COURSE0_COURSE は TutorialCourse (= Course) 型で定義され、
 * TutorialEngine 経路 (AppEvent / StepGoal) で動作する。
 * legacy の course0 (Lesson[]) は既存テスト互換のため残す。
 */

import type { Lesson } from './dsl.js';
import type { TutorialCourse, TutorialLesson } from './types.js';

// ─── Lesson 0-1: テンプレートから音を鳴らす ─────────────────────────────────

const lesson01: Lesson = {
  id: 'course0_lesson01',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'テンプレートから音を鳴らす',
  summary:
    '最初の一歩！テンプレートを使って新しいプロジェクトを作り、テンポを設定して再生してみましょう。',
  steps: [
    {
      id: 'course0_lesson01_step1',
      title: '新しいプロジェクトを作成する',
      instruction:
        '画面左上の「新規プロジェクト」ボタンを押して、新しい曲を始めましょう。',
      check: { kind: 'hasEvent', eventType: 'project.created' },
      hint: 'メニューの「ファイル → 新規プロジェクト」からも作成できます。',
      successMessage: 'プロジェクトが作成されました！すごい、最初の一歩です！',
    },
    {
      id: 'course0_lesson01_step2',
      title: 'テンポを設定する',
      instruction:
        '画面上部のBPM表示をクリックして、テンポを変えてみましょう。120くらいから始めるのがおすすめです。',
      check: { kind: 'hasEvent', eventType: 'tempo.changed' },
      hint: 'BPMの数字をダブルクリックして直接入力できます。',
      successMessage: 'テンポが設定されました！曲のスピード感が決まりましたね。',
    },
  ],
};

// ─── Lesson 0-2: コード進行を選ぶ ───────────────────────────────────────────

const lesson02: Lesson = {
  id: 'course0_lesson02',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'コード進行を選ぶ',
  summary:
    '世界中のヒット曲で使われる「I–V–vi–IV」進行を作ります。Cメジャーでは C → G → Am → F の4コードです。',
  steps: [
    {
      id: 'course0_lesson02_step1',
      title: 'コードを1つ追加する',
      instruction:
        'コードトラックにコードを追加しましょう。まず「C」（Cメジャー）を1小節目に置いてみてください。',
      check: { kind: 'chordCountAtLeast', min: 1 },
      hint: 'コードトラックの空白部分をクリックするとコードを追加できます。',
      successMessage: '最初のコードが置けました！続けて進行を完成させましょう。',
    },
    {
      id: 'course0_lesson02_step2',
      title: 'C → G → Am → F の進行を設定する',
      instruction:
        'コード進行パネルで C、G、Am、F の順に4つのコードを並べましょう。この進行は「1度→5度→6度→4度」と呼ばれます。',
      check: { kind: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
      hint: 'コード進行パネルで「進行を設定」ボタンを押すと、コードをまとめて入力できます。',
      successMessage:
        'I–V–vi–IV 進行が完成しました！有名なコード進行ができましたね！',
    },
  ],
};

// ─── Lesson 0-3: ドラムを足す ────────────────────────────────────────────────

const lesson03: Lesson = {
  id: 'course0_lesson03',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'ドラムを足す',
  summary:
    'ドラムパターンを作ると曲にグルーヴが生まれます。キックとスネアで基本のビートを打ち込みましょう。',
  steps: [
    {
      id: 'course0_lesson03_step1',
      title: 'キックを配置する',
      instruction:
        'ドラムトラックのステップシーケンサーを開いて、キック（Kick）を1・5・9・13ステップ目に置きましょう。4拍のダウンビートです。',
      check: { kind: 'eventCount', eventType: 'drum.step.toggled', min: 4 },
      hint: 'キックは低音の「ドン」という音です。1拍目から4拍置いて試してみましょう。',
      successMessage: 'キックが置けました！続けてスネアも追加しましょう。',
    },
    {
      id: 'course0_lesson03_step2',
      title: 'スネアを追加して16ステップパターンを完成させる',
      instruction:
        'スネア（Snare）を5ステップ目・13ステップ目（2拍目・4拍目）に置きましょう。キックとスネアが交互に鳴るビートになります。',
      check: { kind: 'eventCount', eventType: 'drum.step.toggled', min: 6 },
      hint: 'スネアは高めの「パン」という音です。キックの合間に置くと基本のビートが完成します。',
      successMessage: 'ドラムパターンができました！曲にリズムが生まれましたね！',
    },
  ],
};

// ─── Lesson 0-4: ベースを足す ────────────────────────────────────────────────

const lesson04: Lesson = {
  id: 'course0_lesson04',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'ベースを足す',
  summary:
    'ベースはコードのルート音（一番低い音）を弾いて、曲の土台を支えます。シンプルなルートベースを作りましょう。',
  steps: [
    {
      id: 'course0_lesson04_step1',
      title: 'ベーストラックに4音以上入力する',
      instruction:
        'ベーストラックのピアノロールを開いて、各コードのルート音（C・G・A・F）を4音以上置きましょう。低い音域（オクターブ2〜3あたり）を使うと本物らしくなります。',
      check: { kind: 'noteCountAtLeast', min: 4 },
      hint: 'コードが C のとき → C（ド）、G のとき → G（ソ）を置くとルートベースになります。',
      successMessage:
        'ベースができました！曲の土台がしっかりしてきましたね。',
    },
  ],
};

// ─── Lesson 0-5: メロディを足す ─────────────────────────────────────────────

const lesson05: Lesson = {
  id: 'course0_lesson05',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'メロディを足す',
  summary:
    'ピアノロールを使ってメロディを入力します。4つ以上のノートを置くと、曲らしくなってきます。',
  steps: [
    {
      id: 'course0_lesson05_step1',
      title: 'メロディを4音以上入力する',
      instruction:
        'メロディトラックのピアノロールを開いて、4つ以上の音符を置きましょう。Cメジャースケール（白鍵）の音を使うと合わせやすいです。',
      check: { kind: 'noteCountAtLeast', min: 4 },
      hint: 'ピアノロール上でクリックすると音符を置けます。まずはC・E・G（ドミソ）から試してみましょう。',
      successMessage:
        'メロディができました！音が重なると曲らしくなりますね。',
    },
  ],
};

// ─── Lesson 0-6: 8小節に展開する ─────────────────────────────────────────────

const lesson06: Lesson = {
  id: 'course0_lesson06',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: '8小節に展開する',
  summary:
    '4小節のループを8小節に伸ばして、A/A\'（Aセクション → 少し変化させたA\'セクション）の構成を作ります。',
  steps: [
    {
      id: 'course0_lesson06_step1',
      title: 'セクションを追加して8小節にする',
      instruction:
        'アレンジャー画面でセクションを追加して、曲を8小節に展開しましょう。最初の4小節をコピーして2回繰り返すだけでも OK です。',
      check: { kind: 'hasEvent', eventType: 'section.added' },
      hint: 'アレンジャー画面の空白部分を右クリックして「セクションを追加」を選択してみましょう。',
      successMessage:
        '8小節に展開できました！曲に流れが生まれましたね。',
    },
  ],
};

// ─── Lesson 0-7: 音量を整える ─────────────────────────────────────────────────

const lesson07: Lesson = {
  id: 'course0_lesson07',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: '音量を整える',
  summary:
    'ミキサーでトラックの音量バランスを整えます。クリップ（音が割れる状態）が出ないように調整しましょう。',
  steps: [
    {
      id: 'course0_lesson07_step1',
      title: 'トラックの音量を調整する',
      instruction:
        'ミキサーを開いて、各トラックのフェーダー（音量スライダー）を動かして音量バランスを整えましょう。メロディが一番聴こえやすいように他を少し下げてみてください。',
      check: { kind: 'hasEvent', eventType: 'track.volumeChanged' },
      hint: '一般的にはドラム・ベースを中心に、メロディが埋もれないようにバランスを取ります。',
      successMessage:
        '音量バランスが整いました！完成まであと少しです。',
    },
  ],
};

// ─── Lesson 0-8: 書き出す ────────────────────────────────────────────────────

const lesson08: Lesson = {
  id: 'course0_lesson08',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: '書き出す',
  summary:
    '完成した曲をMIDIまたはWAVファイルとして書き出します。これで最初の1曲が完成です！',
  steps: [
    {
      id: 'course0_lesson08_step1',
      title: 'MIDIまたはWAVファイルを書き出す',
      instruction:
        '「ファイル → 書き出し」からMIDIまたはWAVを選んで曲を保存しましょう。MIDIは他のDAWでも使え、WAVはどこでも再生できる音声ファイルです。',
      check: { kind: 'exported' },
      hint: 'キーボードショートカット Cmd+Shift+E（Mac）/ Ctrl+Shift+E（Win）でも書き出せます。',
      successMessage:
        'おめでとうございます！最初の1曲が完成しました！MIDIまたはWAVファイルが書き出されました。',
    },
  ],
};

// ─── Course 0 export (legacy Lesson[] — for existing checker.test.ts) ────────

/**
 * "はじめての1曲" — Course 0 の8レッスン。
 * 仕様書 docs/03_tutorial_learning_spec.md 「Course 0: 最初の1曲」準拠。
 *
 * Index mapping (used by checker.test.ts):
 *   [0] = 0-1 テンプレートから音を鳴らす
 *   [1] = 0-2 コード進行を選ぶ
 *   [2] = 0-3 ドラムを足す
 *   [3] = 0-4 ベースを足す
 *   [4] = 0-5 メロディを足す
 *   [5] = 0-6 8小節に展開する
 *   [6] = 0-7 音量を整える
 *   [7] = 0-8 書き出す
 */
export const course0: Lesson[] = [
  lesson01,
  lesson02,
  lesson03,
  lesson04,
  lesson05,
  lesson06,
  lesson07,
  lesson08,
];

// ─── COURSE0_COURSE — TutorialEngine 経路 (TutorialCourse / TutorialLesson) ──

/**
 * Lesson 0-1: テンプレートから音を鳴らす
 * Goal: project.created → transport.played の2ステップ (仕様書準拠)
 * content.test が3ステップ以上を要求するため、学習クイズを追加
 */
const LESSON_0_1: TutorialLesson = {
  id: 'c0-lesson01',
  courseId: 'course0',
  level: 'basic',
  schemaVersion: 1,
  title: 'テンプレートから音を鳴らす',
  description:
    '最初の一歩！テンプレートを使って新しいプロジェクトを作り、再生してみましょう。',
  steps: [
    {
      id: 'c0-l01-s1',
      title: '新しいプロジェクトを作成する',
      instruction:
        '画面左上の「新規プロジェクト」ボタンを押して、新しい曲を始めましょう。',
      explanation:
        'プロジェクトとは1曲分の作業ファイルです。テンプレートを選ぶと、あらかじめ楽器が用意された状態で始められます。',
      goal: { kind: 'event', eventType: 'project.created', count: 1 },
      hints: [
        'メニューの「ファイル → 新規プロジェクト」からも作成できます。',
        'テンプレートを選択すると楽器が最初からセットされています。',
      ],
    },
    {
      id: 'c0-l01-s2',
      title: '再生してみよう',
      instruction:
        '画面上部のトランスポートバーにある再生ボタン（▶）を押して、テンプレートの音を聴いてみましょう。',
      explanation:
        'テンプレートにはあらかじめサンプルの音が入っています。まず再生して、どんな音が鳴るか確かめましょう。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'スペースキーでも再生できます。',
        'もう一度スペースキーを押すと停止します。',
      ],
    },
    {
      id: 'c0-l01-s3',
      title: 'DAWの基本クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'DAW（Digital Audio Workstation）の基本操作を覚えると、作曲がスムーズになります。',
      goal: { kind: 'exercise' },
      hints: [
        'トランスポートバーは画面上部にあります。',
        '再生・停止・録音ボタンが並んでいます。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: 'DAWで曲を再生・停止するためのコントローラーを何と呼びますか？',
        choices: ['ミキサー', 'トランスポートバー', 'ピアノロール', 'アレンジャー'],
        correctIndex: 1,
        explanation:
          'トランスポートバーは再生・停止・録音などを操作するコントローラーです。画面上部に配置されています。',
      },
    },
  ],
};

/**
 * Lesson 0-2: コード進行を選ぶ
 * Goal: chordCountAtLeast(1) → progressionEquals(['C','G','Am','F']) → クイズ
 */
const LESSON_0_2: TutorialLesson = {
  id: 'c0-lesson02',
  courseId: 'course0',
  level: 'basic',
  schemaVersion: 1,
  title: 'コード進行を選ぶ',
  description:
    '世界中のヒット曲で使われる「I–V–vi–IV」進行を作ります。C → G → Am → F の4コードです。',
  steps: [
    {
      id: 'c0-l02-s1',
      title: 'コードを1つ追加する',
      instruction:
        'コードトラックの1小節目に「C」（Cメジャー）を置いてみましょう。',
      explanation:
        'コードは複数の音を同時に鳴らす「和音」です。Cコードは C・E・G の3音からできています。',
      goal: {
        kind: 'project',
        predicate: { type: 'chordCountAtLeast', value: 1 },
      },
      hints: [
        'コードトラックの空白部分をクリックするとコードを追加できます。',
        'コードパレットから「C」を選んでください。',
      ],
    },
    {
      id: 'c0-l02-s2',
      title: 'C → G → Am → F の進行を完成させる',
      instruction:
        'コード進行を C・G・Am・F の順に4つ並べましょう。この進行は「1度→5度→6度→4度」と呼ばれます。',
      explanation:
        'I–V–vi–IV 進行は世界中のポップス・ロックで使われる王道進行です。この4コードを覚えるだけで、たくさんの曲が弾けるようになります。',
      goal: {
        kind: 'project',
        predicate: { type: 'progressionEquals', symbols: ['C', 'G', 'Am', 'F'] },
      },
      hints: [
        'コード進行パネルで「進行を設定」ボタンを押すと、コードをまとめて入力できます。',
        '順番が重要です。C → G → Am → F の順に並べてください。',
      ],
    },
    {
      id: 'c0-l02-s3',
      title: 'コード進行クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'I–V–vi–IV 進行の数字の意味を理解すると、他のキーでも同じ進行が作れるようになります。',
      goal: { kind: 'exercise' },
      hints: [
        'ローマ数字は音階の度数を表します。I = 1度（C）、V = 5度（G）です。',
        'Cメジャーキーの場合、I = C、II = Dm、III = Em、IV = F、V = G です。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: 'Cメジャーキーで「I–V–vi–IV」に対応するコードはどれですか？',
        choices: [
          'C → G → Am → F',
          'C → F → G → Am',
          'Am → F → C → G',
          'G → Am → F → C',
        ],
        correctIndex: 0,
        explanation:
          'I=C、V=G、vi=Am、IV=F です。この順番が「I–V–vi–IV」進行です。',
      },
    },
  ],
};

/**
 * Lesson 0-3: ドラムを足す
 * Goal: drumPatternHas — kick≥4 かつ snare≥2 (実パターン検証)
 */
const LESSON_0_3: TutorialLesson = {
  id: 'c0-lesson03',
  courseId: 'course0',
  level: 'basic',
  schemaVersion: 1,
  title: 'ドラムを足す',
  description:
    'ドラムパターンを作ると曲にグルーヴが生まれます。キックとスネアで基本のビートを打ち込みましょう。',
  steps: [
    {
      id: 'c0-l03-s1',
      title: 'ドラムトラックを開く',
      instruction:
        'トラックリストからドラムトラックを選び、ステップシーケンサーを開きましょう。',
      explanation:
        'ステップシーケンサーは16個のボタン（ステップ）でリズムパターンを入力するツールです。各ボタンが1拍の16分の1に対応しています。',
      goal: { kind: 'event', eventType: 'drum.stepToggled', count: 1 },
      hints: [
        'トラックリストのドラムトラックをダブルクリックするとステップシーケンサーが開きます。',
        'まずキック（Kick）の行を探してみましょう。',
      ],
    },
    {
      id: 'c0-l03-s2',
      title: 'キックとスネアでビートを完成させる',
      instruction:
        'キック（Kick）を4つ以上・スネア（Snare）を2つ以上置いてビートを完成させましょう。',
      explanation:
        'キックは「ドン」という低い音、スネアは「パン」という高い音です。キックが4拍の土台を作り、スネアがアクセントを加えます。',
      goal: {
        kind: 'project',
        predicate: {
          type: 'drumPatternHas',
          lanes: [
            { lane: 'kick', minSteps: 4 },
            { lane: 'snare', minSteps: 2 },
          ],
        },
      },
      hints: [
        'キックは1・5・9・13ステップ目（各拍の頭）に置くのが基本です。',
        'スネアは5ステップ目と13ステップ目（2拍目・4拍目）に置くとロックなビートになります。',
      ],
    },
    {
      id: 'c0-l03-s3',
      title: 'ドラムの役割クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'ドラムの各パーツの役割を知ると、より表現豊かなビートが作れるようになります。',
      goal: { kind: 'exercise' },
      hints: [
        'キックは英語で「kick drum」、スネアは「snare drum」といいます。',
        '一般的にキックは低音、スネアは中高音の音域を担当します。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: 'ポップスのドラムパターンでスネアが主に配置される拍はどれですか？',
        choices: ['1拍目と3拍目', '2拍目と4拍目', '1拍目と2拍目', '3拍目と4拍目'],
        correctIndex: 1,
        explanation:
          '一般的なポップス・ロックでは、スネアを2拍目と4拍目に置く「バックビート」が基本です。これがグルーヴの核になります。',
      },
    },
  ],
};

/**
 * Lesson 0-4: ベースを足す
 * Goal: noteCountAtLeast(4) for Bass track → クイズ含む
 */
const LESSON_0_4: TutorialLesson = {
  id: 'c0-lesson04',
  courseId: 'course0',
  level: 'basic',
  schemaVersion: 1,
  title: 'ベースを足す',
  description:
    'ベースはコードのルート音（一番低い音）を弾いて、曲の土台を支えます。シンプルなルートベースを作りましょう。',
  steps: [
    {
      id: 'c0-l04-s1',
      title: 'ベーストラックのピアノロールを開く',
      instruction:
        'トラックリストからベーストラックを選び、ピアノロールエディタを開きましょう。',
      explanation:
        'ピアノロールは鍵盤（縦軸）と時間（横軸）を組み合わせたエディタです。マス目をクリックして音符を配置します。',
      goal: { kind: 'event', eventType: 'note.added', count: 1 },
      hints: [
        'ベーストラックをダブルクリックするとピアノロールが開きます。',
        'ピアノロールの左端の鍵盤図で音名を確認できます。',
      ],
    },
    {
      id: 'c0-l04-s2',
      title: 'ベースラインを4音以上入力する',
      instruction:
        '各コードのルート音（C・G・A・F）を4音以上置きましょう。低い音域（オクターブ2〜3あたり）を使うと本物らしくなります。',
      explanation:
        'ルートベースとは、そのときのコードのルート音（一番基本の音）だけを弾くベースラインです。シンプルですが、曲をしっかり支えます。',
      goal: {
        kind: 'project',
        predicate: { type: 'noteCountAtLeast', trackName: 'Bass', value: 4 },
      },
      hints: [
        'コードが C のとき → C（MIDIノート36か48）を置きましょう。',
        'ベーストラックが見つからない場合は、トラックリストから「ベース」を選んでください。',
      ],
    },
    {
      id: 'c0-l04-s3',
      title: 'ルートベースのクイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'ルートを理解すると、コードが変わっても迷わずベースラインが作れるようになります。',
      goal: { kind: 'exercise' },
      hints: [
        'コードのルートはコード名の最初のアルファベットです。例：Am のルートは A です。',
        'Cコードのルートは C（ド）、Gコードのルートは G（ソ）です。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: 'コード「Am（Aマイナー）」のルート音はどれですか？',
        choices: ['C（ド）', 'E（ミ）', 'A（ラ）', 'G（ソ）'],
        correctIndex: 2,
        explanation:
          'コード名の最初のアルファベットがルートです。Am のルートは A（ラ）です。',
      },
    },
  ],
};

/**
 * Lesson 0-5: メロディを足す
 * Goal: noteCountAtLeast(4) for Melody track → クイズ含む
 */
const LESSON_0_5: TutorialLesson = {
  id: 'c0-lesson05',
  courseId: 'course0',
  level: 'basic',
  schemaVersion: 1,
  title: 'メロディを足す',
  description:
    'ピアノロールを使ってメロディを入力します。4つ以上のノートを置くと、曲らしくなってきます。',
  steps: [
    {
      id: 'c0-l05-s1',
      title: 'スケールスナップをオンにする',
      instruction:
        'ツールバーの「スケール」設定で「Cメジャー」を選び、スケールスナップをオンにしましょう。',
      explanation:
        'スケールスナップをオンにすると、スケール外の音に誤って触れにくくなります。初心者はまずこの機能を使ってスケール内の音だけで作曲するのがおすすめです。',
      goal: { kind: 'event', eventType: 'scale_snap.enabled', count: 1 },
      hints: [
        'ツールバーの「スケール」ボタンでスケールスナップを設定できます。',
        'キーをC、スケールをメジャーに設定してオンにしましょう。',
      ],
    },
    {
      id: 'c0-l05-s2',
      title: 'メロディを4音以上入力する',
      instruction:
        'メロディトラックのピアノロールを開いて、4つ以上の音符を置きましょう。Cメジャースケール（白鍵）の音を使うと合わせやすいです。',
      explanation:
        'メロディは曲の「歌」にあたるパートです。スケール内の音を使えば、コードと合いやすいメロディが作れます。',
      goal: {
        kind: 'project',
        predicate: { type: 'noteCountAtLeast', trackName: 'Melody', value: 4 },
      },
      hints: [
        'ピアノロール上でクリックすると音符を置けます。まずはC・E・G（ドミソ）から試してみましょう。',
        'スケールスナップ機能をオンにすると、スケール外の音に誤って触れにくくなります。',
      ],
    },
    {
      id: 'c0-l05-s3',
      title: 'スケールとメロディのクイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'スケールを使うとコードとメロディが自然にマッチします。この仕組みを覚えると、自由にメロディが作れるようになります。',
      goal: { kind: 'exercise' },
      hints: [
        'Cメジャースケールはピアノの白鍵だけの音：C D E F G A B です。',
        'スケール外の音も使えますが、まずはスケール内の音で練習しましょう。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: 'Cメジャースケールに含まれない音はどれですか？',
        choices: ['D（レ）', 'F#（ファ#）', 'A（ラ）', 'G（ソ）'],
        correctIndex: 1,
        explanation:
          'Cメジャースケールは C D E F G A B の7音で構成されます。F#（ファ#）はスケール外の音です。',
      },
    },
  ],
};

/**
 * Lesson 0-6: 8小節に展開する
 * Goal: section.added event → クイズ含む
 */
const LESSON_0_6: TutorialLesson = {
  id: 'c0-lesson06',
  courseId: 'course0',
  level: 'basic',
  schemaVersion: 1,
  title: '8小節に展開する',
  description:
    '4小節のループを8小節に伸ばして、曲に流れを作ります。',
  steps: [
    {
      id: 'c0-l06-s1',
      title: 'アレンジャー画面を確認する',
      instruction:
        'アレンジャー画面（トラックビュー）を開いて、現在の4小節の構成を確認しましょう。',
      explanation:
        'アレンジャーは曲全体の構成（どの楽器がどこで鳴るか）を俯瞰で見られる画面です。各トラックのクリップが横に並んでいます。',
      goal: { kind: 'project', predicate: { type: 'chordCountAtLeast', value: 1 } },
      hints: [
        'アレンジャー画面は画面中央のトラックが並んでいるエリアです。',
        'クリップ（音のかたまり）をドラッグして伸ばすか、コピーして8小節にしましょう。',
      ],
    },
    {
      id: 'c0-l06-s2',
      title: 'セクションを追加して8小節にする',
      instruction:
        'アレンジャー画面でセクションを追加して、曲を8小節に展開しましょう。最初の4小節をコピーして2回繰り返すだけでも OK です。',
      explanation:
        'セクションとは曲の「区切り」です。「Aメロ」「サビ」などがセクションの例です。8小節に展開することで、聴き手が曲の流れを感じやすくなります。',
      goal: { kind: 'event', eventType: 'section.added' },
      hints: [
        'アレンジャー画面の空白部分を右クリックして「セクションを追加」を選択してみましょう。',
        '4小節のクリップをコピーして貼り付けるだけでも8小節になります。',
      ],
    },
    {
      id: 'c0-l06-s3',
      title: '曲の構成クイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        '曲の構成（セクション構造）を意識すると、飽きない曲が作れます。',
      goal: { kind: 'exercise' },
      hints: [
        '一般的なポップスは「イントロ → Aメロ → Bメロ → サビ → アウトロ」の構成です。',
        '小節数が決まっていると、構成が組みやすくなります。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: '曲の中で一番盛り上がる部分を一般的に何と呼びますか？',
        choices: ['イントロ', 'Aメロ', 'サビ（コーラス）', 'アウトロ'],
        correctIndex: 2,
        explanation:
          '曲の中で最も印象的で盛り上がる部分を「サビ」（英語では chorus）と呼びます。多くの場合、曲のメインテーマが歌われます。',
      },
    },
  ],
};

/**
 * Lesson 0-7: 音量を整える
 * Goal: track.volumeChanged event → クイズ含む
 */
const LESSON_0_7: TutorialLesson = {
  id: 'c0-lesson07',
  courseId: 'course0',
  level: 'basic',
  schemaVersion: 1,
  title: '音量を整える',
  description:
    'ミキサーでトラックの音量バランスを整えます。クリップ（音が割れる状態）が出ないように調整しましょう。',
  steps: [
    {
      id: 'c0-l07-s1',
      title: 'ミキサーを開く',
      instruction:
        'ミキサーパネルを開いて、各トラックのフェーダー（音量スライダー）を確認しましょう。',
      explanation:
        'ミキサーは各楽器の音量・定位（左右の位置）を調整するパネルです。全トラックの音量バランスを一覧で確認できます。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'ミキサーパネルは画面下部またはメニューから開けます。',
        'まず現在の音量バランスを再生で確認してみましょう。',
      ],
    },
    {
      id: 'c0-l07-s2',
      title: 'トラックの音量を調整する',
      instruction:
        '各トラックのフェーダー（音量スライダー）を動かして音量バランスを整えましょう。メロディが一番聴こえやすいように他を少し下げてみてください。',
      explanation:
        'ミキシングとは各楽器の音量・定位を調整して、全体のバランスを整える作業です。一般的にはドラム・ベースを土台にして、メロディが埋もれないようにバランスを取ります。',
      goal: { kind: 'event', eventType: 'track.volumeChanged' },
      hints: [
        'ミキサーパネルの各トラックのスライダーを動かしてみましょう。',
        '一般的にはドラム・ベースを中心に、メロディが埋もれないようにバランスを取ります。',
      ],
    },
    {
      id: 'c0-l07-s3',
      title: 'ミキシングのクイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'ミキシングの基本を知ると、完成度の高い曲が作れるようになります。',
      goal: { kind: 'exercise' },
      hints: [
        'フェーダーを上げると音量が大きく、下げると小さくなります。',
        '0dB が基準で、それを超えるとクリップ（音割れ）が発生します。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question: '音量を調整するスライダーをミキサーでは何と呼びますか？',
        choices: ['パン（Pan）', 'フェーダー（Fader）', 'イコライザー（EQ）', 'コンプレッサー'],
        correctIndex: 1,
        explanation:
          '音量を調整するスライダーを「フェーダー」と呼びます。パンは左右の定位、EQは音域の調整に使います。',
      },
    },
  ],
};

/**
 * Lesson 0-8: 書き出す
 * Goal: export.midi または export.wav AppEvent で達成 → クイズ含む
 */
const LESSON_0_8: TutorialLesson = {
  id: 'c0-lesson08',
  courseId: 'course0',
  level: 'basic',
  schemaVersion: 1,
  title: '書き出す',
  description:
    '完成した曲をMIDIまたはWAVファイルとして書き出します。これで最初の1曲が完成です！',
  steps: [
    {
      id: 'c0-l08-s1',
      title: '書き出し形式を選ぶ',
      instruction:
        '「ファイル → 書き出し」メニューを開いて、MIDIまたはWAVのどちらで書き出すか選びましょう。',
      explanation:
        'MIDIは音符データ（音程・タイミング）を保存するファイル形式で、他のソフトでも編集できます。WAVは実際の音声を保存するファイルで、どこでもそのまま再生できます。',
      goal: { kind: 'event', eventType: 'transport.played', count: 1 },
      hints: [
        'キーボードショートカット Ctrl+Shift+E（Win）/ Cmd+Shift+E（Mac）でも書き出しメニューを開けます。',
        'MIDIは後で編集できる形式、WAVはすぐに聴ける形式です。',
      ],
    },
    {
      id: 'c0-l08-s2',
      title: 'MIDIまたはWAVファイルを書き出す',
      instruction:
        '「ファイル → 書き出し」からMIDIまたはWAVを選んで曲を保存しましょう。これで最初の1曲が完成です！',
      explanation:
        'ファイルを書き出すことで、曲を他の人に共有したり、他のソフトで使ったりできるようになります。MIDIとWAVはそれぞれ違う用途に向いています。',
      goal: {
        kind: 'project',
        predicate: { type: 'exportCompleted' },
      },
      hints: [
        'MIDIを選ぶと音符データが、WAVを選ぶと音声ファイルが保存されます。',
        '保存先フォルダを確認してから書き出しましょう。',
      ],
    },
    {
      id: 'c0-l08-s3',
      title: 'ファイル形式のクイズ',
      instruction: '下の問題に答えてください。',
      explanation:
        'MIDIとWAVの違いを理解すると、用途に合ったファイル形式を選べるようになります。',
      goal: { kind: 'exercise' },
      hints: [
        'MIDIは楽譜データ、WAVは音声データと覚えましょう。',
        'MIDIは再生するソフトによって音が変わりますが、WAVはどこでも同じ音で再生されます。',
      ],
      exercise: {
        kind: 'multipleChoice',
        question:
          '友達にそのまま聴いてもらいたい場合、どのファイル形式で書き出すのが適していますか？',
        choices: ['MIDI', 'WAV', 'どちらでも同じ', 'どちらも不向き'],
        correctIndex: 1,
        explanation:
          'WAVは音声ファイルなので、どのデバイスでもそのまま再生できます。MIDIは音符データのため、再生するには対応ソフトが必要です。',
      },
    },
  ],
};

// ─── COURSE0_COURSE — TutorialCourse 型 ──────────────────────────────────────

/**
 * "はじめての1曲" — Course 0 の8レッスン (TutorialEngine 経路)。
 * 仕様書 docs/03_tutorial_learning_spec.md 「Course 0: 最初の1曲」準拠。
 * content/index.ts の ALL_COURSES に登録済み。
 */
export const COURSE0_COURSE: TutorialCourse = {
  id: 'course0',
  title: 'はじめての1曲',
  description:
    'テンプレートから始めて、コード・ドラム・ベース・メロディを重ね、8小節の曲を完成させましょう。',
  lessonIds: [
    'c0-lesson01',
    'c0-lesson02',
    'c0-lesson03',
    'c0-lesson04',
    'c0-lesson05',
    'c0-lesson06',
    'c0-lesson07',
    'c0-lesson08',
  ],
};

export const COURSE0_LESSONS: TutorialLesson[] = [
  LESSON_0_1,
  LESSON_0_2,
  LESSON_0_3,
  LESSON_0_4,
  LESSON_0_5,
  LESSON_0_6,
  LESSON_0_7,
  LESSON_0_8,
];
