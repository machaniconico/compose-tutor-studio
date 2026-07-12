import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatSavedTime,
  getSaveStatusPresentation,
  type SaveFailureCode,
} from '../src/features/transport/saveStatus';
import { SaveControl } from '../src/features/transport/SaveControl';

describe('save status presentation', () => {
  it('does not describe a fresh project as saved', () => {
    expect(
      getSaveStatusPresentation({ phase: 'idle', lastSavedAt: null, failure: null }),
    ).toMatchObject({
      label: '未保存',
      role: 'status',
      ariaLive: 'polite',
      buttonLabel: '保存',
      savedAt: null,
    });
  });

  it('announces pending changes without inventing a save time', () => {
    expect(
      getSaveStatusPresentation({
        phase: 'pending',
        lastSavedAt: '2026-07-10T01:00:00.000Z',
        failure: null,
      }),
    ).toMatchObject({
      label: '未保存の変更があります',
      role: 'status',
      buttonLabel: '保存',
      savedAt: null,
    });
  });

  it('distinguishes native crash protection in flight from acknowledged protection', () => {
    expect(
      getSaveStatusPresentation({
        phase: 'pending',
        lastSavedAt: null,
        failure: null,
        crashProtectionAvailable: true,
        revision: 3,
        protectedRevision: 2,
      }).label,
    ).toBe('未保存の変更を保護中です。');

    expect(
      getSaveStatusPresentation({
        phase: 'pending',
        lastSavedAt: null,
        failure: null,
        crashProtectionAvailable: true,
        revision: 3,
        protectedRevision: 3,
      }).label,
    ).toBe('未保存の変更は保護済みです。自動保存を待っています。');
  });

  it('warns assertively when the latest revision could not be crash-protected', () => {
    expect(
      getSaveStatusPresentation({
        phase: 'error',
        lastSavedAt: null,
        failure: 'write-failed',
        retry: 'automatic',
        protectionFailed: true,
      }),
    ).toMatchObject({
      label: expect.stringContaining('強制終了から保護できません'),
      role: 'alert',
      ariaLive: 'assertive',
      buttonLabel: '再試行',
    });
  });

  it('does not suggest an unavailable retry after a terminal protection failure', () => {
    const result = getSaveStatusPresentation({
      phase: 'error',
      lastSavedAt: null,
      failure: 'storage-unavailable',
      retry: 'never',
      protectionFailed: true,
    });
    expect(result.label).toContain('保存を再試行できません');
    expect(result.label).not.toContain('今すぐ保存を再試行するか');
    expect(result).toMatchObject({
      buttonLabel: '保存不可',
      canRetry: false,
      role: 'alert',
    });
  });

  it('keeps the real timestamp only for a successful save', () => {
    const savedAt = '2026-07-10T01:02:03.000Z';

    expect(
      getSaveStatusPresentation({ phase: 'saved', lastSavedAt: savedAt, failure: null }),
    ).toMatchObject({
      label: '保存済み',
      role: 'status',
      buttonLabel: '保存',
      savedAt,
    });
    expect(formatSavedTime(savedAt)).not.toBeNull();
    expect(formatSavedTime('not-a-date')).toBeNull();
  });

  it.each<[SaveFailureCode, string]>([
    ['storage-unavailable', 'この環境ではローカル保存を利用できません'],
    ['quota-exceeded', '端末の空き容量を確認してください'],
    ['access-denied', '端末またはアプリの保存許可を確認してください'],
    ['invalid-project', 'プロジェクトの内容を確認してください'],
    ['serialization-failed', '保存データを作成できませんでした'],
    ['lock-unavailable', '安全に保存するための排他制御を利用できません'],
    ['write-failed', 'もう一度お試しください'],
  ])('makes %s failures explicit and retryable', (failure, expectedText) => {
    const result = getSaveStatusPresentation({
      phase: 'error',
      lastSavedAt: '2026-07-10T01:02:03.000Z',
      failure,
    });

    expect(result.label).toContain(expectedText);
    expect(result).toMatchObject({
      role: 'alert',
      ariaLive: 'assertive',
      buttonLabel: '再試行',
      savedAt: null,
    });
  });

  it('renders the retry control as an assertive, described alert', () => {
    const html = renderToStaticMarkup(
      <SaveControl
        state={{ phase: 'error', lastSavedAt: null, failure: 'quota-exceeded', retry: 'manual' }}
        onSave={() => undefined}
        onEmergencyExport={() => undefined}
      />,
    );
    expect(html).toContain('aria-describedby="project-save-status"');
    expect(html).toContain('id="project-save-status"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('再試行');
    expect(html).not.toContain('保存済み');
  });

  it('disables meaningless retry while keeping emergency export available', () => {
    const html = renderToStaticMarkup(
      <SaveControl
        state={{
          phase: 'error',
          lastSavedAt: null,
          failure: 'storage-unavailable',
          retry: 'never',
        }}
        onSave={() => undefined}
        onEmergencyExport={() => undefined}
      />,
    );

    expect(html).toContain('保存不可');
    expect(html).toContain('disabled=""');
    expect(html).toContain('バックアップを書き出す');
    expect(html.match(/aria-describedby="project-save-status"/g)).toHaveLength(2);
  });

  it('disables duplicate emergency exports while preserving the failure description', () => {
    const html = renderToStaticMarkup(
      <SaveControl
        state={{
          phase: 'error',
          lastSavedAt: null,
          failure: 'quota-exceeded',
          retry: 'manual',
        }}
        onSave={() => undefined}
        onEmergencyExport={() => undefined}
        emergencyExportBusy
      />,
    );
    expect(html).toContain('バックアップを書き出し中…');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
});
