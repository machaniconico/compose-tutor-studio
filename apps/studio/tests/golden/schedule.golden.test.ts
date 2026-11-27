import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// project-model の ids.ts は import 時に randomUUID で nonce を決める。固定値へ差し替える。
vi.hoisted(() => {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => '00000000-0000-4000-8000-000000000000',
    configurable: true,
  });
});

import { compileAudioRouting, compileMusicalTime, beatToSecondsAt, type Project } from '@cts/project-model';
import {
  buildCase,
  goldenCases,
} from '../../../../packages/project-model/tests/golden/cases';
import { buildScheduleEvents } from '../../src/audio/events';
import { buildWavScheduleEvents } from '../../src/audio/wav';
import { clampVolume, resolveAudioRoutingMix } from '../../src/audio/graph';
import { beatDurationSeconds, createProjectMusicalTime } from '../../src/audio/musicalTime';
import { beatToTime } from '../../src/audio/scheduler';
import {
  automationBaseValue,
  automationCommandsInWindow,
  automationValueAt,
  isAutomationReadEnabled,
} from '../../src/audio/automation';
import { checkGolden } from './golden-io';

const EXPECTED_DIR = join(import.meta.dirname, 'expected');

/** 関数・AudioNode を含まないプレーンデータへ落とし、安定順に並べる。 */
function schedulePlain(project: Project): unknown {
  const events = buildScheduleEvents(project).map(
    (event) => JSON.parse(JSON.stringify({ beat: event.beat, payload: event.payload })) as {
      beat: number;
    },
  );
  return events
    .map((event) => ({ key: JSON.stringify(event), event }))
    .sort((a, b) => a.event.beat - b.event.beat || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.event);
}

/** テンポ・拍子マップ越しの時間と、オートメーションの解決値(音の元になる数値)。 */
function soundPlain(project: Project): unknown {
  const index = compileMusicalTime(project);
  const mapBeats = [
    ...new Set([
      0,
      project.lengthBeats,
      ...project.tempoMap.map((e) => e.beat),
      ...project.timeSignatureMap.map((e) => e.beat),
    ]),
  ].sort((a, b) => a - b);
  const seconds = mapBeats.map((beat) => [beat, beatToSecondsAt(index, beat)]);
  const automation = project.automationLanes.map((lane) => {
    const track = project.tracks.find((t) => t.id === lane.target.trackId);
    const base = track ? automationBaseValue(track, lane.target) : null;
    const samples: number[] = [];
    if (base !== null) {
      for (let beat = 0; beat <= project.lengthBeats; beat += 0.5) {
        samples.push(automationValueAt(lane, base, beat));
      }
    }
    return {
      laneId: lane.id,
      target: lane.target,
      base,
      readEnabled: isAutomationReadEnabled(project.automationReadState, lane),
      samples,
    };
  });
  // wav.ts が AudioParam へ流すコマンド(同じ引数・同じ時刻変換)。
  const tempoChangeBeats = project.tempoMap.slice(1).map((event) => event.beat);
  const { tempo } = createProjectMusicalTime(project);
  const automationCommands = project.automationLanes.map((lane) => {
    const track = project.tracks.find((t) => t.id === lane.target.trackId);
    const readEnabled = isAutomationReadEnabled(project.automationReadState, lane);
    const commands = track && readEnabled
      ? automationCommandsInWindow(
          lane, automationBaseValue(track, lane.target), 0, project.lengthBeats, null, true, tempoChangeBeats,
        ).map((c) => ({
          type: c.interpolation,
          beat: c.beat,
          time: beatToTime(c.beat, tempo, 0, 0),
          value: c.value,
        }))
      : [];
    return { laneId: lane.id, target: lane.target, readEnabled, commands };
  });
  return { seconds, automation, automationCommands };
}

/**
 * 再生・WAV が使う解決済みドラム(swing 適用後)と、テンポマップ経由の秒数。
 * ノートは開始・終了の両方を秒で固定する(テンポ変更をまたぐ長さを検出するため)。
 */
function timingPlain(project: Project): unknown {
  const { tempo, index } = createProjectMusicalTime(project);
  const notes = buildWavScheduleEvents(project).flatMap((event) => {
    const payload = event.payload as { kind: string; trackId: string; pitch?: number; durationBeats?: number };
    if (payload.kind !== 'note') return [];
    return [{
      trackId: payload.trackId,
      pitch: payload.pitch,
      startBeat: event.beat,
      endBeat: event.beat + (payload.durationBeats ?? 0),
      startSeconds: tempo.beatToSeconds(event.beat),
      endSeconds: tempo.beatToSeconds(event.beat + (payload.durationBeats ?? 0)),
      // wav.ts が synth.noteOn に渡す引数と同じ呼び出し(time, duration)。
      noteOnTime: beatToTime(event.beat, tempo, 0, 0),
      noteOnDuration: beatDurationSeconds(index, event.beat, payload.durationBeats ?? 0),
    }];
  });
  const drums = buildWavScheduleEvents(project).flatMap((event) => {
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind !== 'drum') return [];
    return [{
      trackId: payload.trackId,
      clipId: payload.clipId,
      eventId: payload.eventId,
      lane: payload.lane,
      velocity: payload.velocity,
      voiceSeed: payload.voiceSeed,
      beat: event.beat,
      seconds: tempo.beatToSeconds(event.beat),
    }];
  });
  const byKey = (a: unknown, b: unknown) => {
    const x = a as { startBeat?: number; beat?: number }; const y = b as { startBeat?: number; beat?: number };
    const d = (x.startBeat ?? x.beat ?? 0) - (y.startBeat ?? y.beat ?? 0);
    return d || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  };
  return { notes: notes.sort(byKey), resolvedDrums: drums.sort(byKey) };
}

/** コンパイル済みルーティング計画(tap 位置)と、解決済みのエッジゲイン・フェーダー値。 */
function routingPlain(project: Project): unknown {
  const compiled = compileAudioRouting(project);
  if (!compiled.ok) throw new Error('routing failed to compile');
  const mix = resolveAudioRoutingMix(project, compiled.plan);
  const sends = new Map(project.audioRouting.sends.map((s) => [s.id, s]));
  const probeBeats = [0, 2, 4, 6, 8, project.lengthBeats];
  const edges = compiled.plan.edges.map((edge) => {
    const key = edge.kind === 'output' ? `output:${edge.sourceTrackId}` : `send:${edge.sendId}`;
    const source = project.tracks.find((t) => t.id === edge.sourceTrackId);
    const lane = project.automationLanes.find(
      (l) => l.target.trackId === edge.sourceTrackId && l.target.type === 'track-volume',
    );
    const fader = probeBeats.map((beat) => {
      if (!source) return null;
      const read = lane && isAutomationReadEnabled(project.automationReadState, lane);
      return clampVolume(lane && read ? automationValueAt(lane, source.volume, beat) : source.volume);
    });
    const edgeGain = mix.edgeGains.get(key) ?? null;
    const post = edge.kind === 'send' && edge.position === 'post-fader';
    return {
      key,
      kind: edge.kind,
      source: edge.sourceTrackId,
      destination: edge.destination,
      tap: edge.kind === 'send' ? edge.position : 'post-fader',
      sendGain: edge.kind === 'send' ? sends.get(edge.sendId)?.gain ?? null : null,
      edgeGain,
      probeBeats,
      faderAtBeats: fader,
      // post-fader は自動化済みフェーダーを通り、pre-fader は通らない。
      effectiveGainAtBeats: fader.map((f) => (edgeGain === null || f === null ? null : post || edge.kind === 'output' ? edgeGain * f : edgeGain)),
    };
  });
  return { topologicalTrackIds: compiled.plan.topologicalTrackIds, edges };
}

const cases = goldenCases().map((c) => [c.name, c] as const);

describe('golden: v10 buildScheduleEvents snapshot', () => {
  it.each(cases)('%s: schedule events and timing are pinned', (name, c) => {
    const project = buildCase(c);
    const snapshot = {
      schedule: schedulePlain(project),
      sound: soundPlain(project),
      timing: timingPlain(project),
      routing: routingPlain(project),
    };
    checkGolden(join(EXPECTED_DIR, `${name}.schedule.json`), `${JSON.stringify(snapshot, null, 1)}\n`);
  });

  it('schedule snapshot is identical across repeated builds', () => {
    for (const [, c] of cases) {
      const a = JSON.stringify(schedulePlain(buildCase(c)));
      const b = JSON.stringify(schedulePlain(buildCase(c)));
      expect(a).toBe(b);
    }
  });

  it('fixtures with audible content produce events', () => {
    for (const [name, c] of cases) {
      if (name.startsWith('fixture-v10-') || name.startsWith('template-')) {
        expect(buildScheduleEvents(buildCase(c)).length).toBeGreaterThan(0);
      }
    }
  });
});
