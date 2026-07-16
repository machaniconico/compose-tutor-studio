import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  duplicateClip,
  findClip,
  resizeClip,
  setMidiClipLoop,
  unlinkClip,
  type Project,
} from '@cts/project-model';
import { createDefaultProject } from '../src/state/defaultProject';
import { installLocalStorage } from './localStorageStub';

let Arranger: typeof import('../src/features/arranger/Arranger')['Arranger'];
let clipOperationMessage: typeof import('../src/features/arranger/Arranger')['clipOperationMessage'];
let isClipNoticeCurrent: typeof import('../src/features/arranger/Arranger')['isClipNoticeCurrent'];
let useStore: typeof import('../src/state/store')['useStore'];

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ Arranger, clipOperationMessage, isClipNoticeCurrent } = await import(
    '../src/features/arranger/Arranger'
  ));
});

function fourBarSource(): { project: Project; clipId: string } {
  const project = createDefaultProject('Arranger test');
  const clip = project.tracks[0]?.clips[0];
  if (!clip) throw new Error('clip fixture missing');
  return {
    clipId: clip.id,
    project: {
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((candidate) =>
          candidate.id === clip.id
            ? { ...candidate, lengthBeats: 16 }
            : candidate,
        ),
      })),
    },
  };
}

function activate(project: Project, clipId: string): void {
  const current = useStore.getState();
  const track = project.tracks.find((candidate) =>
    candidate.clips.some((clip) => clip.id === clipId),
  );
  const nextState = {
    project,
    editor: {
      ...current.editor,
      activeView: 'arranger' as const,
      selectedTrackId: track?.id ?? null,
      selectedClipId: clipId,
    },
  };
  useStore.setState(nextState);
  // React's server renderer reads useSyncExternalStore's initial snapshot.
  // Keep that test-only snapshot aligned with the active store state.
  Object.assign(useStore.getInitialState(), nextState);
}

beforeEach(() => {
  const fixture = fourBarSource();
  activate(fixture.project, fixture.clipId);
});

describe('Arranger clip workflow', () => {
  it('explains an effective-event duplicate refusal in plain language', () => {
    expect(clipOperationMessage('event-limit')).toContain('再生イベントが多くなりすぎる');
    expect(clipOperationMessage('event-limit')).toContain('コピーを減らしてください');
  });

  it('renders track lanes and enables both copy modes when the pattern fits', () => {
    const html = renderToStaticMarkup(<Arranger />);

    expect(html).toContain('aria-label="トラック別クリップ配置"');
    expect(html).toContain('aria-label="Chordsのクリップ"');
    expect(html).toContain('aria-label="選択クリップの編集"');
    expect(html).toContain('素材をクリップ末尾まで繰り返す');
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toMatch(/<button[^>]*>独立コピーを右へ<\/button>/);
    expect(html).toMatch(/<button[^>]*>連動コピーを右へ<\/button>/);
  });

  it('keeps a valid partial-bar clip editable as a fractional bar range', () => {
    const fixture = fourBarSource();
    const partialProject = {
      ...fixture.project,
      tracks: fixture.project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === fixture.clipId
            ? { ...clip, startBeat: 2, lengthBeats: 2 }
            : clip,
        ),
      })),
    };
    activate(partialProject, fixture.clipId);

    const html = renderToStaticMarkup(<Arranger />);

    expect(html.match(/value="0\.5"/g)).toHaveLength(2);
    expect(html.match(/step="any"/g)).toHaveLength(2);
  });

  it('shows a linked badge and unlink action without duplicating payload', () => {
    const fixture = fourBarSource();
    const linked = duplicateClip(fixture.project, fixture.clipId, {
      id: 'arranger-linked',
      startBeat: 16,
      linked: true,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    activate(linked.project, linked.clipId);

    const html = renderToStaticMarkup(<Arranger />);
    const alias = findClip(linked.project, linked.clipId)?.clip;

    expect(alias?.notes).toBeUndefined();
    expect(html).toContain('連動コピー');
    expect(html).toContain('連動を解除');
    expect(html).toContain('aria-pressed="true"');
  });

  it('invalidates success notices when undo restores the prior clip state', () => {
    const fixture = fourBarSource();
    const duplicated = duplicateClip(fixture.project, fixture.clipId, {
      id: 'notice-linked',
      startBeat: 16,
      linked: true,
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;

    const duplicateNotice = {
      kind: 'status' as const,
      message: 'copied',
      expected: { operation: 'duplicate' as const, clipId: duplicated.clipId },
    };
    expect(isClipNoticeCurrent(duplicated.project, duplicateNotice)).toBe(true);
    expect(isClipNoticeCurrent(fixture.project, duplicateNotice)).toBe(false);

    const unlinked = unlinkClip(duplicated.project, duplicated.clipId);
    expect(unlinked.ok).toBe(true);
    if (!unlinked.ok) return;
    const unlinkNotice = {
      kind: 'status' as const,
      message: 'unlinked',
      expected: { operation: 'unlink' as const, clipId: duplicated.clipId },
    };
    expect(isClipNoticeCurrent(unlinked.project, unlinkNotice)).toBe(true);
    expect(isClipNoticeCurrent(duplicated.project, unlinkNotice)).toBe(false);

    const resized = resizeClip(fixture.project, fixture.clipId, {
      startBeat: 4,
      lengthBeats: 12,
    });
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    const resizeNotice = {
      kind: 'status' as const,
      message: 'resized',
      expected: {
        operation: 'resize' as const,
        clipId: fixture.clipId,
        startBeat: 4,
        lengthBeats: 12,
      },
    };
    expect(isClipNoticeCurrent(resized.project, resizeNotice)).toBe(true);
    expect(isClipNoticeCurrent(fixture.project, resizeNotice)).toBe(false);

    const looped = setMidiClipLoop(fixture.project, fixture.clipId, true);
    expect(looped.ok).toBe(true);
    if (!looped.ok) return;
    const loopNotice = {
      kind: 'status' as const,
      message: 'looped',
      expected: { operation: 'loop' as const, clipId: fixture.clipId, loop: true },
    };
    expect(isClipNoticeCurrent(looped.project, loopNotice)).toBe(true);
    expect(isClipNoticeCurrent(fixture.project, loopNotice)).toBe(false);
  });
});
