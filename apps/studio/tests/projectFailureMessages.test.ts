import { describe, expect, it } from 'vitest';
import {
  savedProjectLoadDiagnosticMessage,
  savedProjectLoadFailureMessage,
  templateLoadDiagnosticMessage,
  templateLoadFailureMessage,
} from '../src/features/projectMenu/projectFailureMessages';

describe('project failure messages', () => {
  it('points template failures to another template and support diagnostics', () => {
    const message = templateLoadFailureMessage();

    expect(message).toContain('テンプレート');
    expect(message).toContain('サポート');
    expect(message).toContain('診断情報');
  });

  it('includes the template id and error detail in diagnostics', () => {
    const message = templateLoadDiagnosticMessage('8bar-pop', new Error('missing track'));

    expect(message).toContain('id=8bar-pop');
    expect(message).toContain('missing track');
  });

  it('keeps template diagnostic details compact and redacted', () => {
    const message = templateLoadDiagnosticMessage(
      'starter',
      new Error(`Failed at C:\\Users\\name\\template.json
      ${'x'.repeat(900)}`),
    );

    expect(message).toContain('id=starter');
    expect(message).toContain('detail=Failed at [local-path]');
    expect(message).not.toContain('C:\\Users\\name');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(920);
  });

  it('points saved-project load failures to support diagnostics', () => {
    const message = savedProjectLoadFailureMessage();

    expect(message).toContain('保存済みプロジェクト');
    expect(message).toContain('サポート');
    expect(message).toContain('診断情報');
  });

  it('includes the saved project id in load diagnostics', () => {
    const message = savedProjectLoadDiagnosticMessage('project_123');

    expect(message).toContain('Saved project load failed');
    expect(message).toContain('id=project_123');
  });

  it('keeps saved-project diagnostic ids compact and single-line', () => {
    const message = savedProjectLoadDiagnosticMessage(`  project_123
    ${'x'.repeat(120)}`);

    expect(message).not.toContain('\n');
    expect(message).toContain('id=project_123 ');
    expect(message.endsWith('...')).toBe(true);
    expect(message.length).toBeLessThan(120);
  });
});
