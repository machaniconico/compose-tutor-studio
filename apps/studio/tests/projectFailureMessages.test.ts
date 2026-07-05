import { describe, expect, it } from 'vitest';
import {
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
});
