// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, type Clip, type Project } from '@cts/project-model';
import { buildScheduleEvents } from '../src/audio/events';
import { collectGhostNotes, MAX_GHOST_NOTES } from '../src/features/pianoRoll/ghostNotes';
import { installLocalStorage } from './localStorageStub';

let useStore: typeof import('../src/state/store')['useStore'];
let PianoRoll: typeof import('../src/features/pianoRoll/PianoRoll')['PianoRoll'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ PianoRoll } = await import('../src/features/pianoRoll/PianoRoll'));
});
afterEach(cleanup);

function midiClips(project: Project): Clip[] {
  return project.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'midi');
}

/** 既定プロジェクトの先頭 MIDI クリップを複製し、別トラックに置いた 2 クリップ構成にする。 */
function withTwoClips(): Project {
  const project = createDefaultProject();
  const first = midiClips(project)[0]!;
  const otherTrack = project.tracks.find((t) => t.type !== 'master' && t.id !== first.trackId)!;
  otherTrack.clips.push({
    ...first,
    id: 'ghost-src',
    trackId: otherTrack.id,
    notes: [{ id: 'g1', pitch: 64, startBeat: 0, durationBeats: 1, velocity: 90 }],
  });
  return project;
}

describe('collectGhostNotes: 窓だけを数え、窓に合わせて切る', () => {
  const loopProject = (): Project => {
    const project = createDefaultProject();
    const first = midiClips(project)[0]!;
    const other = project.tracks.find((t) => t.type !== 'master' && t.id !== first.trackId)!;
    other.clips.push({
      ...first,
      id: 'dense',
      trackId: other.id,
      startBeat: 0,
      lengthBeats: 32,
      loop: true,
      notes: [{ id: 'd1', pitch: 60, startBeat: 0, durationBeats: 1 / 960, velocity: 90 }],
    });
    return project;
  };
  it('32 拍を 1/960 拍ごとにループするクリップでも、窓 4-8 拍のゴーストが出る', () => {
    const project = loopProject();
    const ghosts = collectGhostNotes(project, 'none', 4, 4, 0, 127);
    expect(ghosts.length).toBeGreaterThan(0);
    expect(ghosts.length).toBeLessThanOrEqual(MAX_GHOST_NOTES);
    expect(ghosts.every((g) => g.startBeat >= 0 && g.startBeat < 4)).toBe(true);
  });
  it('4-8 拍の窓に 7-11 拍のノートは、描画範囲(窓の終端)で切れる', () => {
    const project = createDefaultProject();
    const first = midiClips(project)[0]!;
    const other = project.tracks.find((t) => t.type !== 'master' && t.id !== first.trackId)!;
    other.clips.push({
      ...first, id: 'long', trackId: other.id, startBeat: 0, lengthBeats: 16, loop: false,
      notes: [{ id: 'l1', pitch: 60, startBeat: 7, durationBeats: 4, velocity: 90 }],
    });
    const [g] = collectGhostNotes(project, 'none', 4, 4, 0, 127);
    expect(g).toBeDefined();
    expect(g!.startBeat).toBe(3);
    expect(g!.startBeat + g!.durationBeats).toBe(4);
  });
  it('窓の手前から始まるノートは開始 0 に切る', () => {
    const project = createDefaultProject();
    const first = midiClips(project)[0]!;
    const other = project.tracks.find((t) => t.type !== 'master' && t.id !== first.trackId)!;
    other.clips.push({
      ...first, id: 'early', trackId: other.id, startBeat: 0, lengthBeats: 16, loop: false,
      notes: [{ id: 'e1', pitch: 60, startBeat: 2, durationBeats: 4, velocity: 90 }],
    });
    const [g] = collectGhostNotes(project, 'none', 4, 4, 0, 127);
    expect(g!.startBeat).toBe(0);
    expect(g!.durationBeats).toBe(2);
  });
});

describe('collectGhostNotes', () => {
  it('編集中クリップ以外のノートだけを、編集中クリップ基準の拍で返す', () => {
    const project = withTwoClips();
    const [viewed] = midiClips(project);
    expect(midiClips(project).length).toBeGreaterThan(1);
    const total = midiClips(project).reduce((n, c) => n + (c.notes?.length ?? 0), 0);
    const own = viewed!.notes?.length ?? 0;
    const ghosts = collectGhostNotes(project, viewed!.id, viewed!.startBeat, 1e6, 0, 127);
    expect(ghosts.length).toBe(total - own);
    expect(ghosts.every((g) => !g.key.startsWith(`${viewed!.id}:`))).toBe(true);
  });

  it('上限を超えて返さない', () => {
    const project = withTwoClips();
    const [viewed] = midiClips(project);
    expect(collectGhostNotes(project, viewed!.id, 0, 1e6, 0, 127, 3).length).toBeLessThanOrEqual(3);
    expect(MAX_GHOST_NOTES).toBe(2000);
  });

  it('音域・表示範囲の外は含めず、不正な入力でも throw しない', () => {
    const project = createDefaultProject();
    const [viewed] = midiClips(project);
    expect(collectGhostNotes(project, viewed!.id, 0, 1e6, 200, 300)).toEqual([]);
    expect(collectGhostNotes(project, viewed!.id, Number.NaN, 4, 0, 127)).toEqual([]);
    expect(collectGhostNotes(project, viewed!.id, 0, -1, 0, 127)).toEqual([]);
    expect(collectGhostNotes(project, 'none', 0, 4, 0, 127)).toBeInstanceOf(Array);
  });

  it('シード付きファジング: 任意の窓でも上限内・窓内に収まり、project を書き換えない', () => {
    const project = withTwoClips();
    const frozen = JSON.stringify(project);
    const [viewed] = midiClips(project);
    let seed = 20261128;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let n = 0; n < 200; n += 1) {
      const start = Math.floor(rnd() * 64) - 8;
      const len = Math.floor(rnd() * 32) + 1;
      const cap = Math.floor(rnd() * 20);
      const lo = Math.floor(rnd() * 60);
      const ghosts = collectGhostNotes(project, viewed!.id, start, len, lo, lo + 40, cap);
      expect(ghosts.length).toBeLessThanOrEqual(cap);
      for (const g of ghosts) {
        expect(g.pitch).toBeGreaterThanOrEqual(lo);
        expect(g.pitch).toBeLessThanOrEqual(lo + 40);
        expect(g.startBeat).toBeLessThan(len);
        expect(g.startBeat + g.durationBeats).toBeGreaterThan(0);
      }
    }
    expect(JSON.stringify(project)).toBe(frozen);
  });
});

describe('PianoRoll ゴースト・色分け(表示専用)', () => {
  beforeEach(async () => {
    installLocalStorage();
    await act(async () => {
      await useStore.getState().createNewProject('ゴースト検証');
    });
    const clips = midiClips(useStore.getState().project);
    // 別トラックのクリップへ 1 音足し、先頭の MIDI クリップを編集対象にする。
    const viewed = clips[0]!;
    const other = clips.find((c) => c.trackId !== viewed.trackId)!;
    act(() => {
      useStore.getState().addNote(other.id, { pitch: 64, startBeat: 0, durationBeats: 1, velocity: 90 });
      useStore.getState().selectClip(viewed.id);
      useStore.setState((s) => ({ editor: { ...s.editor, ghostNotes: true, noteRoleColors: false } }));
    });
  });

  it('ゴーストを描き、ポインタを受けず、チェックを外すと消える。project は変わらない', () => {
    render(<PianoRoll />);
    const ghosts = screen.getAllByTestId('ghost-note');
    expect(ghosts.length).toBeGreaterThan(0);
    expect(ghosts[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(ghosts[0]!.tagName).not.toBe('BUTTON');
    const before = JSON.stringify(useStore.getState().project);
    const scheduleBefore = JSON.stringify(buildScheduleEvents(useStore.getState().project));
    fireEvent.pointerDown(ghosts[0]!);
    fireEvent.click(ghosts[0]!);
    expect(useStore.getState().editor.selectedNoteIds).toEqual([]);
    fireEvent.click(screen.getByRole('checkbox', { name: /^ゴースト/ }));
    expect(screen.queryAllByTestId('ghost-note')).toHaveLength(0);
    expect(JSON.stringify(useStore.getState().project)).toBe(before);
    expect(JSON.stringify(buildScheduleEvents(useStore.getState().project))).toBe(scheduleBefore);
  });

  it('色分けは既定でオフ。オンにすると凡例が出て、スケール外は「間違い」と書かない', () => {
    render(<PianoRoll />);
    expect(screen.queryByRole('list', { name: '色分けの見かた' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /^役割色/ }));
    const legend = screen.getByRole('list', { name: '色分けの見かた' });
    expect(legend.textContent).toContain('スケールの外の音(経過音などで使えます)');
    expect(legend.textContent).not.toMatch(/間違い|ミス|誤り/);
    expect(useStore.getState().editor.noteRoleColors).toBe(true);
  });

  it('色分けオンのとき、ノートに役割クラスと記号が付く', () => {
    act(() => {
      const clip = midiClips(useStore.getState().project)[0]!;
      useStore.getState().addNote(clip.id, { pitch: 61, startBeat: 0, durationBeats: 1, velocity: 90 });
      useStore.getState().toggleNoteRoleColors();
    });
    expect(useStore.getState().editor.noteRoleColors).toBe(true);
    const { container } = render(<PianoRoll />);
    const noteButtons = container.querySelectorAll('button.pr__note');
    expect(noteButtons.length).toBeGreaterThan(0);
    for (const b of noteButtons) {
      expect(b.className).toMatch(/pr__note--(chordTone|scaleTone|outside)/);
      expect(b.querySelector('.pr__note-role')?.textContent).toMatch(/[●○◇]/);
    }
  });
});
