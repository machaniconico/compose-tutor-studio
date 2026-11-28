import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyProject, type ChordEvent, type Project, type Track } from '@cts/project-model';
import { buildScheduleEvents, type SchedulePayload } from '../src/audio/events';
import { installLocalStorage } from './localStorageStub';
import { generateCompingInProject } from '../src/state/compingGeneration';
import { transposeNotesInProject } from '../src/state/noteEditActions';

beforeAll(() => installLocalStorage());

// 16 分の奇数拍(x.25)の音は swing > 0 で後ろにずれる。予定と事後確認の鍵が同じ時間軸か確かめる。
const MODES: ReadonlyArray<[string, Partial<Project>]> = [
  ['legacy swing 0', { swing: 0 }],
  ['resolved swing 50', { swing: 50 }],
  ['resolved swing 60', { swing: 60 }],
  ['resolved hiHatChoke only (swing 0)', { swing: 0, hiHatChoke: true }],
];

function noteEvents(project: Project, trackId: string) {
  return buildScheduleEvents(project)
    .filter((event) => (event.payload as SchedulePayload).kind === 'note' && (event.payload as { trackId: string }).trackId === trackId)
    .map((event) => [event.beat, (event.payload as { pitch: number }).pitch]);
}

describe.each(MODES)('swung new-clip schedule check: %s', (_name, over) => {
  it('P38 comping accepts a chord starting on a swung 16th', () => {
    const base = createEmptyProject({});
    const chord: ChordEvent = { id: 'c0', startBeat: 0.25, durationBeats: 3.5, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] };
    const project: Project = { ...base, ...over, chordTrack: [chord] };
    const out = generateCompingInProject(project, { startBar: 1, endBar: 2, pattern: 'whole', register: 55, voiceLeading: true });
    if (!out.ok) throw new Error(out.reason);
    const swung = (over.swing ?? 0) > 0;
    const onsets = new Set(noteEvents(out.project, out.trackId).map(([beat]) => beat));
    expect(onsets).toEqual(new Set([swung ? 0.25 + (0.25 * (over.swing ?? 0)) / 100 : 0.25]));
  });

  it('transposing a note on a swung 16th is accepted (removed side uses the same resolution)', () => {
    const base = createEmptyProject({});
    const track = base.tracks.find((t) => t.type === 'instrument') as Track;
    const clip = {
      ...track.clips[0]!,
      id: 'swing-clip',
      type: 'midi' as const,
      startBeat: 0,
      lengthBeats: 8,
      notes: [{ id: 'n1', pitch: 60, startBeat: 0.25, durationBeats: 0.25, velocity: 90 }],
    };
    const project: Project = {
      ...base,
      ...over,
      tracks: base.tracks.map((t) => (t.id === track.id ? { ...t, clips: [clip] } : t)),
    };
    const out = transposeNotesInProject(project, 'swing-clip', ['n1'], { semitones: 2 });
    if (!out.ok) throw new Error(out.reason);
  });
});
