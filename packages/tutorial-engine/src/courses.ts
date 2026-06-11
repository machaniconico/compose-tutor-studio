/**
 * Tutorial Engine — Course 0: はじめての8小節
 *
 * Static, beginner-friendly lesson data.
 * All instruction/successMessage text is in Japanese.
 */

import type { Lesson } from './dsl.js';

// ─── Lesson 0-1: プロジェクトを作ってテンポを設定しよう ─────────────────────

const lesson01: Lesson = {
  id: 'course0_lesson01',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'プロジェクトを作ってテンポを設定しよう',
  summary:
    '最初の一歩！新しいプロジェクトを作り、曲のテンポを設定します。テンポとは1分間の拍数（BPM）のことです。',
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

// ─── Lesson 0-2: キーをCメジャーに設定しよう ────────────────────────────────

const lesson02: Lesson = {
  id: 'course0_lesson02',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'キーをCメジャーに設定しよう',
  summary:
    'キー（調）は曲の「音の家」です。今回はピアノの白鍵だけで演奏できる「Cメジャー」を使います。',
  steps: [
    {
      id: 'course0_lesson02_step1',
      title: 'キーをCメジャーに変更する',
      instruction:
        '画面上部の「キー」設定を「C」「メジャー」に変更しましょう。これで曲の土台が決まります。',
      check: { kind: 'hasEvent', eventType: 'key.changed' },
      hint: 'キー設定はツールバーの「Key」と書かれたドロップダウンから変更できます。',
      successMessage:
        'Cメジャーに設定されました！ドレミファソラシドの音で作れます。',
    },
  ],
};

// ─── Lesson 0-3: コード進行を作ろう（I–V–vi–IV） ────────────────────────────

const lesson03: Lesson = {
  id: 'course0_lesson03',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'コード進行を作ろう（I–V–vi–IV）',
  summary:
    '世界中のヒット曲で使われる「I–V–vi–IV」進行を作ります。Cメジャーでは C → G → Am → F の4コードです。',
  steps: [
    {
      id: 'course0_lesson03_step1',
      title: 'コードを1つ追加する',
      instruction:
        'コードトラックにコードを追加しましょう。まず「C」（Cメジャー）を1小節目に置いてみてください。',
      check: { kind: 'chordCountAtLeast', min: 1 },
      hint: 'コードトラックの空白部分をクリックするとコードを追加できます。',
      successMessage: '最初のコードが置けました！続けて進行を完成させましょう。',
    },
    {
      id: 'course0_lesson03_step2',
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

// ─── Lesson 0-4: メロディを作ろう ───────────────────────────────────────────

const lesson04: Lesson = {
  id: 'course0_lesson04',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'メロディを作ろう',
  summary:
    'ピアノロールを使ってメロディを入力します。4つ以上のノートを置くと、曲らしくなってきます。',
  steps: [
    {
      id: 'course0_lesson04_step1',
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

// ─── Lesson 0-5: ドラムを足そう ─────────────────────────────────────────────

const lesson05: Lesson = {
  id: 'course0_lesson05',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'ドラムを足そう',
  summary:
    'ドラムパターンを作ると曲にグルーヴが生まれます。16ステップのドラムパッドでリズムを打ち込みましょう。',
  steps: [
    {
      id: 'course0_lesson05_step1',
      title: 'ドラムステップを4つ以上オンにする',
      instruction:
        'ドラムトラックのステップシーケンサーを開いて、キックやスネアのステップを4つ以上オンにしましょう。',
      check: { kind: 'eventCount', eventType: 'drum.step.toggled', min: 4 },
      hint: 'まずキックを1・5・9・13ステップ目（4拍のダウンビート）に置いてみましょう。',
      successMessage: 'ドラムパターンができました！曲にリズムが生まれましたね！',
    },
  ],
};

// ─── Lesson 0-6: MIDIで書き出そう ───────────────────────────────────────────

const lesson06: Lesson = {
  id: 'course0_lesson06',
  courseId: 'course0',
  level: 'beginner',
  lessonSchemaVersion: 1,
  title: 'MIDIで書き出そう',
  summary:
    '完成した曲をMIDIファイルとして書き出します。MIDIファイルは他のDAWや楽器でも使えます。',
  steps: [
    {
      id: 'course0_lesson06_step1',
      title: 'MIDIファイルを書き出す',
      instruction:
        '「ファイル → 書き出し → MIDI」を選んで曲をMIDIファイルで保存しましょう。',
      check: { kind: 'exported', format: 'midi' },
      hint: 'キーボードショートカット Cmd+Shift+E（Mac）/ Ctrl+Shift+E（Win）でも書き出せます。',
      successMessage:
        'おめでとうございます！最初の8小節コースが完了しました！MIDIファイルが書き出されました。',
    },
  ],
};

// ─── Course 0 export ─────────────────────────────────────────────────────────

/** "はじめての8小節" — Course 0 lessons in order. */
export const course0: Lesson[] = [
  lesson01,
  lesson02,
  lesson03,
  lesson04,
  lesson05,
  lesson06,
];
