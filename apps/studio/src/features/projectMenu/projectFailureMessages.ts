import { formatDiagnosticValue } from '../../platform/diagnostics';

export function templateLoadFailureMessage(): string {
  return 'テンプレートの読み込みに失敗しました。別のテンプレートを選び、続く場合はサポートから診断情報をコピーしてください。';
}

export function templateLoadDiagnosticMessage(templateId: string, error: unknown): string {
  return `Template load failed. id=${formatDiagnosticValue(templateId, 80)}; detail=${formatDiagnosticValue(
    errorDetail(error),
    800,
  )}`;
}

export function savedProjectLoadFailureMessage(): string {
  return '保存済みプロジェクトの読み込みに失敗しました。別の保存データを選び、続く場合はサポートから診断情報をコピーしてください。';
}

export function savedProjectLoadDiagnosticMessage(projectId: string): string {
  return `Saved project load failed. id=${formatDiagnosticValue(projectId, 80)}`;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return String(error);
}
