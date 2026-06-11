/**
 * Tutorial Engine — Course 0: はじめての1曲
 *
 * 仕様書 docs/03_tutorial_learning_spec.md Course 0 の8レッスン構成。
 * Static, beginner-friendly lesson data.
 * All instruction/successMessage text is in Japanese.
 */

import type { Lesson } from './dsl.js';

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

// ─── Course 0 export ─────────────────────────────────────────────────────────

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
