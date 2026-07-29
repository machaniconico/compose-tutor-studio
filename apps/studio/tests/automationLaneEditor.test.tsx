import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@cts/project-model';
import { automationRecordingStatusMessage } from '../src/audio/automationRecording';
import { installLocalStorage } from './localStorageStub';

const studioStyles = readFileSync(
  new URL('../src/styles.css', import.meta.url),
  'utf8',
);

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
  server.automationRecording = current.automationRecording;
}

function automationReadToggle(html: string): string | null {
  return html.match(
    /<button[^>]*data-automation-read-toggle="true"[^>]*>[^<]*<\/button>/,
  )?.[0] ?? null;
}

function minimumHeightPxForRule(selectorPattern: RegExp): number {
  const declarations = studioStyles.match(selectorPattern)?.[1];
  const value = declarations?.match(/min-height:\s*([\d.]+)px/)?.[1];
  return Number(value ?? 0);
}

describe('AutomationLaneEditor accessibility rendering', () => {
  it('renders a direct-placement lane, target controls, snap, and actionable empty state', () => {
    selectedEditableTrackId();
    syncServerSnapshot();
    const html = renderToStaticMarkup(<AutomationLaneEditor />);

    expect(html).toContain('role="group" aria-label="オートメーション対象"');
    expect(html).toContain('aria-label="Read設定"');
    expect(html).toContain('aria-pressed="true">Global Read: オン</button>');
    expect(html).toContain('aria-pressed="true">Track Read: オン</button>');
    expect(html).toContain('role="radiogroup"');
    for (const mode of ['Read', 'Touch', 'Latch', 'Write']) {
      expect(html).toContain(`>${mode}</button>`);
    }
    expect(html).toContain('data-automation-write-status="read"');
    expect(html).toContain('読み取り（Read）');
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

  it('computes 44px Read and mode controls covered by the global focus-visible style', () => {
    selectedEditableTrackId();
    syncServerSnapshot();
    const html = renderToStaticMarkup(<AutomationLaneEditor />);
    const automationControls = html.match(
      /<button[^>]*>(?:Global Read: [^<]+|Track Read: [^<]+|Read|Touch|Latch|Write)<\/button>/g,
    ) ?? [];

    expect(automationControls).toHaveLength(6);
    expect(automationControls.every((control) => (
      control.includes('type="button"')
      && !control.includes('disabled=""')
      && !control.includes('tabindex="-1"')
    ))).toBe(true);
    expect(minimumHeightPxForRule(
      /\.automation-lane__read-gates button,\s*\.automation-lane__mode-selector button\s*\{([^}]*)\}/,
    )).toBeGreaterThanOrEqual(44);
    expect(studioStyles).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*(?!none)[^;}]+;/,
    );
  });

  it('reports armed and actively writing as distinct text states', () => {
    const trackId = selectedEditableTrackId();
    expect(useStore.getState().setTrackAutomationMode(trackId, 'touch')).toBe(true);
    syncServerSnapshot();
    const armedHtml = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(armedHtml).toContain('data-automation-write-status="armed"');
    expect(armedHtml).toContain('待機中（Armed）');
    expect(armedHtml).not.toContain('記録中（Writing）');

    const runtime = useStore.getState().automationRecording;
    useStore.setState({
      automationRecording: {
        ...runtime,
        armedTrackIds: [trackId],
        writingTrackIds: [trackId],
      },
    });
    syncServerSnapshot();
    const writingHtml = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(writingHtml).toContain('data-automation-write-status="writing"');
    expect(writingHtml).toContain('記録中（Writing）');
  });

  it('exposes an assertive 44px recovery action for an uncommittable pass', () => {
    selectedEditableTrackId();
    const runtime = useStore.getState().automationRecording;
    const recoveryMessage = automationRecordingStatusMessage('point-limit');
    useStore.setState({
      automationRecording: {
        ...runtime,
        passActive: true,
        status: {
          code: 'point-limit',
          message: recoveryMessage,
        },
      },
    });
    syncServerSnapshot();

    const html = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(html).toContain('role="alert" aria-live="assertive"');
    expect(html).toContain('オートメーション記録を確定できませんでした。');
    expect(html).toContain(recoveryMessage);
    expect(html).toContain(
      '「記録を破棄して停止」で終了した後、不要なポイントを減らして',
    );
    expect(html).toContain('>記録を破棄して停止</button>');
    expect(minimumHeightPxForRule(
      /\.automation-lane__recording-recovery button\s*\{([^}]*)\}/,
    )).toBeGreaterThanOrEqual(44);
  });

  it('names the lane resource in the lane-limit recovery path', () => {
    const message = automationRecordingStatusMessage('lane-limit');

    expect(message).toContain('レーン数上限');
    expect(message).toContain('「記録を破棄して停止」で終了した後');
    expect(message).toContain('不要なレーンを削除');
  });

  it('keeps persisted Read gates separate from per-lane Bypass', () => {
    const trackId = selectedEditableTrackId();
    const added = automationActions.addStudioAutomationPoint(
      { type: 'track-volume', trackId },
      { beat: 1, value: 0.8, interpolation: 'linear' },
    );
    if (!added.ok) throw new Error('automation lane fixture missing');
    expect(
      automationActions.setStudioGlobalAutomationReadEnabled(false),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      automationActions.setStudioTrackAutomationReadEnabled(trackId, false),
    ).toMatchObject({ ok: true, changed: true });
    syncServerSnapshot();

    const html = renderToStaticMarkup(<AutomationLaneEditor />);
    expect(html).toContain('data-global-read="off"');
    expect(html).toContain('data-track-read="off"');
    expect(html).toContain('Global Read: オフ');
    expect(html).toContain('Track Read: オフ');
    expect(automationReadToggle(html)).toContain(
      'aria-label="Lane Bypass: オフ"',
    );
    expect(automationReadToggle(html)).toContain('aria-pressed="false"');
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
