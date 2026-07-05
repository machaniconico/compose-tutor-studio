export function templateLoadFailureMessage(): string {
  return 'テンプレートの読み込みに失敗しました。別のテンプレートを選び、続く場合はサポートから診断情報をコピーしてください。';
}

export function templateLoadDiagnosticMessage(templateId: string, error: unknown): string {
  return `Template load failed. id=${templateId}; detail=${errorDetail(error)}`;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return String(error);
}
