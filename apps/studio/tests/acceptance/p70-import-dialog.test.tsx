// @vitest-environment jsdom
// P70 acceptance tests (import dialog component). Written BEFORE the implementation; do not edit.
//
// CONTRACT. apps/studio/src/features/export/Wave5ImportDialog.tsx exports
//   Wave5ImportDialog(props: { plan: <the 'offer-conversion' variant of Wave5ImportPlan>,
//                              onOpen: (project: Project) => void, onCancel: () => void })
// Two steps, no state outside the component:
//   1. role="dialog" whose text includes plan.message, a button named "変換する" and a button named "やめる".
//      Nothing is converted yet (plan.convert is NOT called until the first button is pressed).
//      "やめる" -> onCancel() once; plan.convert never called; onOpen never called.
//   2. After "変換する": plan.convert() is called once. If ok: a list (role="list") with one listitem per report line, each showing
//      line.text, and a button "この内容で開く" (plus "やめる"). onOpen is NOT called yet. Pressing "この内容で開く" calls
//      onOpen(project) exactly once with the converted project.
//      Before the list the dialog shows a summary that contains `変わる項目 <changed>件` and `消える項目 <dropped>件` (counts of report items by severity;
//      info items are in neither), the sentence 元のファイルは変わりません and the sentence コピーとして開きます (so nothing about the file on disk is a surprise). If the report is empty the dialog says so in Japanese (no list items)
//      and still offers "この内容で開く".
//      If not ok: role="alert" showing the failure message; no "この内容で開く" button; onOpen never called; "やめる" still works.
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wave5ImportDialog } from '../../src/features/export/Wave5ImportDialog';
import { planProjectJsonImport } from '../../src/features/export/wave5Import';
import { FIXTURE_DIR, convertOk } from './p70-helpers';

afterEach(cleanup);

function offer(name: string) {
  const plan = planProjectJsonImport(readFileSync(`${FIXTURE_DIR}inputs/${name}.json`, 'utf8'));
  if (plan.kind !== 'offer-conversion') throw new Error('expected an offer');
  return plan;
}

describe('P70 import dialog', () => {
  it('dialog_firstStep_offersConversion_andConvertsNothingYet', () => {
    const plan = offer('roles');
    const convert = vi.fn(plan.convert);
    render(<Wave5ImportDialog plan={{ ...plan, convert }} onOpen={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(plan.message);
    expect(within(dialog).getByRole('button', { name: '変換する' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toBeTruthy();
    expect(convert).not.toHaveBeenCalled();
  });

  it('dialog_cancelAtFirstStep_callsOnCancelOnly', async () => {
    const plan = offer('roles');
    const convert = vi.fn(plan.convert);
    const onOpen = vi.fn();
    const onCancel = vi.fn();
    render(<Wave5ImportDialog plan={{ ...plan, convert }} onOpen={onOpen} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it('dialog_afterConvert_showsTheReport_andOpensOnlyOnConfirm', async () => {
    const plan = offer('roles');
    const expected = convertOk('roles');
    const onOpen = vi.fn();
    render(<Wave5ImportDialog plan={plan} onOpen={onOpen} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '変換する' }));
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(expected.report.length);
    expect(items.length).toBe(2);
    expect(items.map((li) => li.textContent).join('\n')).toContain('Pad B');
    const dialogText = screen.getByRole('dialog').textContent ?? '';
    expect(dialogText).toContain('変わる項目 2件'); // two duplicate-role-demoted
    expect(dialogText).toContain('消える項目 0件');
    expect(dialogText).toContain('元のファイルは変わりません');
    expect(dialogText).toContain('コピーとして開きます');
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'この内容で開く' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![0]).toEqual(expected.project);
  });

  it('dialog_summary_countsChangedAndDroppedSeparately_infoIsNeither', async () => {
    // legacy-fields: loop-range-dropped (dropped) + legacy-bar-limit-dropped, legacy-clip-settings-dropped (both info)
    render(<Wave5ImportDialog plan={offer('legacy-fields')} onOpen={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '変換する' }));
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toContain('変わる項目 0件');
    expect(text).toContain('消える項目 1件');
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3); // info items are still listed
  });

  it('dialog_emptyReport_stillOffersToOpen_withoutListItems', async () => {
    const plan = offer('lane-volume');
    const onOpen = vi.fn();
    render(<Wave5ImportDialog plan={plan} onOpen={onOpen} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '変換する' }));
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'この内容で開く' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('dialog_conversionFailure_showsAlert_andNeverOpens', async () => {
    const plan = offer('over-limit-steps');
    const onOpen = vi.fn();
    const onCancel = vi.fn();
    render(<Wave5ImportDialog plan={plan} onOpen={onOpen} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: '変換する' }));
    const alert = screen.getByRole('alert');
    expect(/[぀-ヿ一-鿿]/.test(alert.textContent ?? '')).toBe(true);
    expect(screen.queryByRole('button', { name: 'この内容で開く' })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
