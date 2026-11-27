// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { installLocalStorage } from './localStorageStub';

let bridge: typeof import('../src/state/tutorialBridge');
let GlossaryPanel: typeof import('../src/features/tutorial/GlossaryPanel')['GlossaryPanel'];
let TutorialPanel: typeof import('../src/features/tutorial/TutorialPanel')['TutorialPanel'];
let Term: typeof import('../src/features/common/Term')['Term'];
let GLOSSARY: typeof import('../src/features/tutorial/glossary')['GLOSSARY'];

beforeAll(async () => {
  installLocalStorage();
  bridge = await import('../src/state/tutorialBridge');
  ({ GlossaryPanel } = await import('../src/features/tutorial/GlossaryPanel'));
  ({ TutorialPanel } = await import('../src/features/tutorial/TutorialPanel'));
  ({ Term } = await import('../src/features/common/Term'));
  ({ GLOSSARY } = await import('../src/features/tutorial/glossary'));
});

/** Open basic-1 on its quiz step (step 3), the first step with an exercise. */
function openQuizStep() {
  act(() => {
    bridge.__resetBridgeForTest();
    localStorage.clear();
    bridge.startLesson('basic-1');
    const saved = bridge.loadProgress('basic-1');
    localStorage.setItem('cts.tutorial.basic-1', JSON.stringify({ ...saved, currentStep: 2 }));
    bridge.startLesson('basic-1');
  });
}

describe('GlossaryPanel', () => {
  it('lists every term, narrows by search, and reports no match', () => {
    render(<GlossaryPanel />);
    expect(screen.getAllByRole('term')).toHaveLength(GLOSSARY.length);

    const search = screen.getByLabelText('用語をさがす');
    fireEvent.change(search, { target: { value: 'せんど' } });
    expect(screen.getAllByRole('term').map((el) => el.textContent)).toEqual(['センド']);

    fireEvent.change(search, { target: { value: 'send' } });
    expect(screen.getAllByRole('term').map((el) => el.textContent)).toEqual(['センド']);

    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(screen.queryAllByRole('term')).toHaveLength(0);
    expect(screen.getByText(/見つかりませんでした/)).toBeTruthy();
  });

  it('shows the description of the matched term', () => {
    const send = GLOSSARY.find((entry) => entry.id === 'send')!;
    render(<GlossaryPanel />);
    fireEvent.change(screen.getByLabelText('用語をさがす'), { target: { value: 'send' } });
    expect(screen.getByRole('definition').textContent).toBe(send.description);
  });
});

describe('Term', () => {
  it('shows a tooltip on focus and closes it with Escape', () => {
    render(<Term id="reverb">響き</Term>);
    const term = screen.getByText('響き');
    fireEvent.focus(term);
    expect(screen.getByRole('tooltip').textContent).toContain('リバーブ');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('renders children untouched for an unknown id', () => {
    render(<Term id="no-such-term">そのまま</Term>);
    expect(screen.getByText('そのまま').className).toBe('');
  });
});

describe('TutorialPanel', () => {
  it('wraps glossary terms in the lesson explanation with a working tooltip', () => {
    openQuizStep();
    render(<TutorialPanel />);
    const why = document.querySelector('.lesson-runner__why')!;
    const term = within(why as HTMLElement).getByText('コード');
    expect(term.className).toBe('term');
    fireEvent.focus(term);
    expect(screen.getByRole('tooltip').textContent).toContain('コード');
  });

  it('keeps a partly answered exercise while the glossary is open', () => {
    openQuizStep();
    render(<TutorialPanel />);
    fireEvent.click(screen.getAllByRole('radio')[1]!);

    fireEvent.click(screen.getByRole('button', { name: '用語集をひらく' }));
    const lesson = document.querySelector('.lesson-runner')!.parentElement!;
    expect(lesson.hidden).toBe(true);
    expect(screen.getByLabelText('用語をさがす')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '← レッスンにもどる' }));
    expect(lesson.hidden).toBe(false);
    expect(screen.queryByLabelText('用語をさがす')).toBeNull();
    expect((screen.getAllByRole('radio')[1] as HTMLInputElement).checked).toBe(true);
  });
});
