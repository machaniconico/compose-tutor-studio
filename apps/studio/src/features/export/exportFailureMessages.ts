import type { DiagnosticKind } from '../../platform/diagnostics';

export type FileTransferFailureKind = Extract<
  DiagnosticKind,
  'import-midi' | 'project-import' | 'project-export' | 'export-midi' | 'export-wav'
>;

export function fileTransferFailureMessage(kind: FileTransferFailureKind): string {
  if (kind === 'import-midi') {
    return 'MIDIファイルの読み込みに失敗しました。Standard MIDI File（.mid）を選び、続く場合はサポートから診断情報をコピーしてください。';
  }

  if (kind === 'project-import') {
    return 'プロジェクトの読み込みに失敗しました。ファイル形式を確認し、続く場合はサポートから診断情報をコピーしてください。';
  }

  if (kind === 'project-export') {
    return 'プロジェクトの書き出しに失敗しました。保存先を確認し、続く場合はサポートから診断情報をコピーしてください。';
  }

  if (kind === 'export-midi') {
    return 'MIDIの書き出しに失敗しました。保存先を確認し、続く場合はサポートから診断情報をコピーしてください。';
  }

  return 'WAVの書き出しに失敗しました。曲の長さと保存先を確認し、続く場合はサポートから診断情報をコピーしてください。';
}
