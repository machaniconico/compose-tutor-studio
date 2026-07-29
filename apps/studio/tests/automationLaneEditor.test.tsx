import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@cts/project-model';
import { installLocalStorage } from './localStorageStub';

let AutomationLaneEditor:
  typeof import('../src/features/automation/AutomationLaneEditor')['AutomationLaneEditor'];
let useStore: typeof import('../src/state/store')['useStore'];
let automationActions: typeof import('../src/state/automationActions');

beforeAll(async () => {
  installLocalStorage();
  ({ useStore } = await import('../src/state/store'));
  ({ AutomationLaneEditor } = await import(
    '../src/features/automation/AutomationLaneEditor'
  ));
  automationActions = await import('../src/state/automationActions');
});

beforeEach(async () => {
  await useStore.getState().flushPendingSave();
  installLocalStorage();
  expect(
    await useStore.getState().createNewProject('オートメーションUI検証'),
  ).toBe(true);
});

function selectedEditableTrackId(): string {
  const track = useStore
    .getState()
    .project.tracks.find((candidate) => candidate.type !== 'master');
  if (!track) throw new Error('editable track fixture missing');
  useStore.getState().selectTrack(track.id);
  return track.id;
}

function syncServerSnapshot(): void {
  const current = useStore.getState();
  const server = useStore.getInitialState();
  server.project = current.project;
  server.editor = current.editor;
  server.projectOperationBusy = current.projectOperationBusy;
  server.audioRecordingOperationId = current.audioRecordingOperationId;
  server.transport = current.transport;
}

function automationReadToggle(html: string): string | null {
  return html.match(
    /<button[^>]*data-automation-read-toggle="true"[^>]*>[^<]*<\/button>/,
  )?.[0] ?? null;
}

describe('AutomationLaneEditor accessibility rendering', () => {
  it('renders a direct-placement lane, target controls, snap, and actionable empty state', () => {
    selectedEditableTrackId();
    syncServerSnapshot();
    const html = renderToStaticMarkup(<AutomationLaneEditor />);

    expect(html).toContain('role="group" aria-label="オートメーション対象"');
    expect(html).toContain('aria-pressed="true">音量');
    expect(html).toContain('aria-pressed="false">パン');
    expect(html).toContain('aria-label="オートメーショングリッド"');
    expect(html).toContain('<option value="4">4拍</option>');
    expect(html).not.toContain('1小節（4/4）');
    expect(html).toContain('>再生位置に点を追加</button>');
    expect(html).toContain('点はまだありません');
    expect(html).toContain('data-horizontal-scroll="timeline-only"');
    expect(html).toContain('aria-label="トラック音量オートメーションレーン"');
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true" focusable="false"');
    expect(html).toContain('<summary>キーボード操作</summary>');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain(
      '最初の点を追加すると、Readが有効なレーンを作成します。',
    );
    expect(automationReadToggle(html)).toBeNull();
  });

  it('exposes persisted points as labelled, roving native buttons over a semantic curve', () => {
    const trackId = selectedEditableTrackId();
    expect(
      automationActions.addStudioAutomationPoint(
        { type: 'track-volume', trackId },
        { beat: 1, value: 0.5, interpolation: 'hold' },
      ),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      automationActions.addStudioAutomationPoint(
        { type: 'track-volume', trackId },
        { beat: 3, value: 1.25, interpolation: 'linear' },
      ),
    ).toMatchObject({ ok: true, changed: true });
    syncServerSnapshot();

    const html = renderToStaticMarkup(<AutomationLaneEditor />);
    const pointButtons =
      html.match(/<button[^>]*data-automation-point-id="[^"]+"[^>]*>/g) ?? [];

    expect(pointButtons).toHaveLength(2);
    expect(pointButtons[0]).toContain('音量 1点目、拍 1、値 50%、次の点まで保持');
    expect(pointButtons[1]).toContain('音量 2点目、拍 3、値 125%、次の点まで直線');
    expect(pointButtons.filter((button) => button.includes('tabindex="0"'))).toHaveLength(1);
    expect(pointButtons.filter((button) => button.includes('tabindex="-1"'))).toHaveLength(1);
    expect(pointButtons.every((button) => button.includes('aria-pressed="false"'))).toBe(true);
    expect(pointButtons.every((button) => button.includes('Shift+ArrowUp'))).toBe(true);
    expect(html).toContain('data-interpolation="hold"');
    expect(html).toContain('data-interpolation="jump"');
    expect(html).toContain('基準値 100%');
    expect(html).not.toContain('点はまだありません');
    expect(html).toContain('data-automation-read-state="read"');
    expect(automationReadToggle(html)).toContain('aria-pressed="false"');
    expect(automationReadToggle(html)).toContain('>Read</button>');
    expect(html).toContain('曲線を再生とWAV書き出しに反映します。');
  });

  it('renders Read -> Bypass -> Read without hiding or replacing persisted points', () => {
    const trackId = selectedEditableTrackId();
    const added = automationActions.addStudioAutomationPoint(
      { type: 'track-volume', trackId },
      { beat: 2, value: 0.75, interpolation: 'linear' },
    );
    expect(added).toMatchObject({ ok: true, changed: true });
    if (!added.ok) throw new Error('automation point fixture was rejected');

    const laneBefore = useStore
      .getState()
      .project.automationLanes.find((candidate) => candidate.id === added.laneId);
    if (!laneBefore) throw new Error('automation lane fixture missing');
    const pointsBefore = laneBefore.points;

    syncServerSnapshot();
    const readHtml = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(automationReadToggle(readHtml)).toContain('aria-pressed="false"');
    expect(automationReadToggle(readHtml)).toContain('>Read</button>');

    expect(
      automationActions.setStudioAutomationLaneBypassed(laneBefore.id, true),
    ).toMatchObject({ ok: true, changed: true });
    syncServerSnapshot();
    const bypassHtml = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(bypassHtml).toContain(
      'class="automation-lane is-bypassed"',
    );
    expect(bypassHtml).toContain('data-automation-read-state="bypassed"');
    expect(automationReadToggle(bypassHtml)).toContain('aria-pressed="true"');
    expect(automationReadToggle(bypassHtml)).toContain('>Bypass</button>');
    expect(bypassHtml).toContain(
      '再生とWAV書き出しではトラックの現在の基準値を使います。',
    );
    const bypassedPoint = bypassHtml.match(
      new RegExp(
        `<button[^>]*data-automation-point-id="${pointsBefore[0]?.id}"[^>]*>`,
      ),
    )?.[0];
    expect(bypassedPoint).toBeTruthy();
    expect(bypassedPoint).not.toContain('disabled=""');
    expect(
      useStore.getState().project.automationLanes.find(
        (candidate) => candidate.id === laneBefore.id,
      )?.points,
    ).toBe(pointsBefore);

    expect(
      automationActions.setStudioAutomationLaneBypassed(laneBefore.id, false),
    ).toMatchObject({ ok: true, changed: true });
    syncServerSnapshot();
    const restoredHtml = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(restoredHtml).toContain('data-automation-read-state="read"');
    expect(automationReadToggle(restoredHtml)).toContain(
      'aria-pressed="false"',
    );
    expect(automationReadToggle(restoredHtml)).toContain('>Read</button>');
    expect(
      useStore.getState().project.automationLanes.find(
        (candidate) => candidate.id === laneBefore.id,
      )?.points,
    ).toBe(pointsBefore);
  });

  it('bounds native controls and curve nodes for a valid 20,000-point lane', () => {
    const trackId = selectedEditableTrackId();
    const current = useStore.getState().project;
    const points: AutomationPoint[] = Array.from(
      { length: 20_000 },
      (_, index) => ({
        id: `stress-point-${index}`,
        beat: (index * current.lengthBeats) / 20_000,
        value: (index % 201) / 100,
        interpolation: index % 2 === 0 ? 'linear' : 'hold',
      }),
    );
    useStore.setState({
      project: {
        ...current,
        automationLanes: [{
          id: 'stress-volume-lane',
          target: { type: 'track-volume', trackId },
          bypassed: false,
          points,
        }],
      },
    });
    syncServerSnapshot();

    const html = renderToStaticMarkup(<AutomationLaneEditor />);
    const pointButtons =
      html.match(/<button[^>]*data-automation-point-id="[^"]+"[^>]*>/g) ?? [];
    const curvePaths =
      html.match(/<path[^>]*class="automation-lane__segment[^"]*"[^>]*>/g) ?? [];

    expect(html).toContain('data-automation-total-points="20000"');
    expect(html).toContain('data-automation-rendered-points="400"');
    expect(pointButtons).toHaveLength(400);
    expect(curvePaths.length).toBeLessThanOrEqual(3);
    expect(curvePaths.reduce((count, path) => {
      const match = path.match(/data-segment-count="(\d+)"/);
      return count + Number(match?.[1] ?? 0);
    }, 0)).toBeGreaterThanOrEqual(20_000);
  });

  it('renders explicit no-track, Master, and disabled states', () => {
    useStore.getState().selectTrack(null);
    syncServerSnapshot();
    expect(renderToStaticMarkup(<AutomationLaneEditor />)).toContain(
      '左のトラック一覧から編集するトラックを選択してください。',
    );

    const master = useStore
      .getState()
      .project.tracks.find((track) => track.type === 'master');
    if (!master) throw new Error('Master fixture missing');
    useStore.getState().selectTrack(master.id);
    syncServerSnapshot();
    const masterHtml = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(masterHtml).toContain(
      '通常トラックまたはBusを選択してください。',
    );
    expect(masterHtml).not.toContain('再生位置に点を追加');

    const editableTrackId = selectedEditableTrackId();
    expect(
      automationActions.addStudioAutomationPoint(
        { type: 'track-volume', trackId: editableTrackId },
        { beat: 1, value: 1, interpolation: 'linear' },
      ),
    ).toMatchObject({ ok: true, changed: true });
    useStore.setState({ projectOperationBusy: true });
    syncServerSnapshot();
    const disabledHtml = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(disabledHtml).toMatch(
      /aria-label="オートメーショングリッド"[^>]*disabled=""/,
    );
    expect(disabledHtml).toMatch(/>再生位置に点を追加<\/button>/);
    expect(disabledHtml).toMatch(
      /<button[^>]*disabled=""[^>]*>再生位置に点を追加<\/button>/,
    );
    expect(automationReadToggle(disabledHtml)).toContain('disabled=""');

    useStore.setState({
      projectOperationBusy: false,
      audioRecordingOperationId: 41,
    });
    syncServerSnapshot();
    const recordingHtml = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(automationReadToggle(recordingHtml)).toContain('disabled=""');

    useStore.setState({
      projectOperationBusy: false,
      audioRecordingOperationId: null,
    });
    syncServerSnapshot();
  });
});
