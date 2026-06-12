// Composition templates. Each template defines tempo/key/length, a preset chord
// progression (chord notes as MIDI pitch classes), and a basic drum pattern.
// instantiateTemplate() builds a fully-formed Project via the factories.

import type { Clock } from './clock';
import { systemClock } from './clock';
import { createEmptyProject } from './factories';
import { chordPitchClasses } from './theory';
import { beatsPerBar } from './time';
import { makeId } from './ids';
import type {
  ChordEvent,
  DrumEvent,
  DrumLane,
  MusicalKey,
  Project,
  ScaleName,
} from './types';

export type TemplateId =
  | '8bar-pop'
  | '16bar-pop'
  | 'bgm-loop'
  | 'jingle-15s'
  | 'jingle-30s'
  | 'jingle-60s'
  | 'lofi-chill'
  | 'game-loop';

/** A single chord step in a template progression (one chord per `bars` bars). */
type ChordStep = {
  symbol: string;
  root: MusicalKey;
  quality: string;
  bars: number;
};

/** A drum hit expressed as lane + step index within a 16-step bar. */
type DrumHit = { lane: DrumLane; step: number };

export type ProjectTemplate = {
  id: TemplateId;
  /** Japanese display name. */
  name: string;
  /** Japanese description. */
  description: string;
  bpm: number;
  key: MusicalKey;
  scale: ScaleName;
  lengthBars: number;
  /** One-loop chord progression; repeated to fill lengthBars. */
  progression: ChordStep[];
  /** One-bar drum pattern (16 steps); repeated to fill lengthBars. */
  drumPattern: DrumHit[];
};

// --- Reusable drum patterns (one bar, 16 steps) ---

const FOUR_ON_THE_FLOOR: DrumHit[] = [
  { lane: 'kick', step: 0 },
  { lane: 'kick', step: 4 },
  { lane: 'kick', step: 8 },
  { lane: 'kick', step: 12 },
  { lane: 'snare', step: 4 },
  { lane: 'snare', step: 12 },
  { lane: 'closedHat', step: 2 },
  { lane: 'closedHat', step: 6 },
  { lane: 'closedHat', step: 10 },
  { lane: 'closedHat', step: 14 },
];

const EIGHT_BEAT_POP: DrumHit[] = [
  { lane: 'kick', step: 0 },
  { lane: 'kick', step: 8 },
  { lane: 'snare', step: 4 },
  { lane: 'snare', step: 12 },
  { lane: 'closedHat', step: 0 },
  { lane: 'closedHat', step: 2 },
  { lane: 'closedHat', step: 4 },
  { lane: 'closedHat', step: 6 },
  { lane: 'closedHat', step: 8 },
  { lane: 'closedHat', step: 10 },
  { lane: 'closedHat', step: 12 },
  { lane: 'closedHat', step: 14 },
];

const LOFI_BEAT: DrumHit[] = [
  { lane: 'kick', step: 0 },
  { lane: 'kick', step: 10 },
  { lane: 'snare', step: 4 },
  { lane: 'snare', step: 12 },
  { lane: 'closedHat', step: 0 },
  { lane: 'closedHat', step: 4 },
  { lane: 'closedHat', step: 8 },
  { lane: 'closedHat', step: 12 },
  { lane: 'perc', step: 6 },
];

const GAME_LOOP_BEAT: DrumHit[] = [
  { lane: 'kick', step: 0 },
  { lane: 'kick', step: 6 },
  { lane: 'kick', step: 8 },
  { lane: 'snare', step: 4 },
  { lane: 'snare', step: 12 },
  { lane: 'closedHat', step: 0 },
  { lane: 'closedHat', step: 2 },
  { lane: 'closedHat', step: 4 },
  { lane: 'closedHat', step: 6 },
  { lane: 'closedHat', step: 8 },
  { lane: 'closedHat', step: 10 },
  { lane: 'closedHat', step: 12 },
  { lane: 'closedHat', step: 14 },
];

// --- Reusable progressions ---

const IVviIV: ChordStep[] = [
  { symbol: 'C', root: 'C', quality: 'major', bars: 1 },
  { symbol: 'G', root: 'G', quality: 'major', bars: 1 },
  { symbol: 'Am', root: 'A', quality: 'minor', bars: 1 },
  { symbol: 'F', root: 'F', quality: 'major', bars: 1 },
];

const viIVIV: ChordStep[] = [
  { symbol: 'Am', root: 'A', quality: 'minor', bars: 1 },
  { symbol: 'F', root: 'F', quality: 'major', bars: 1 },
  { symbol: 'C', root: 'C', quality: 'major', bars: 1 },
  { symbol: 'G', root: 'G', quality: 'major', bars: 1 },
];

const LOFI_PROG: ChordStep[] = [
  { symbol: 'Fmaj7', root: 'F', quality: 'major7', bars: 1 },
  { symbol: 'Em7', root: 'E', quality: 'minor7', bars: 1 },
  { symbol: 'Dm7', root: 'D', quality: 'minor7', bars: 1 },
  { symbol: 'Cmaj7', root: 'C', quality: 'major7', bars: 1 },
];

const iiVI: ChordStep[] = [
  { symbol: 'Dm7', root: 'D', quality: 'minor7', bars: 1 },
  { symbol: 'G7', root: 'G', quality: 'dominant7', bars: 1 },
  { symbol: 'Cmaj7', root: 'C', quality: 'major7', bars: 2 },
];

export const PROJECT_TEMPLATES: Record<TemplateId, ProjectTemplate> = {
  '8bar-pop': {
    id: '8bar-pop',
    name: '8小節ポップス',
    description: '定番のI–V–vi–IV進行を使った、はじめての作曲にちょうどいい8小節のポップスです。',
    bpm: 120,
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    progression: IVviIV,
    drumPattern: EIGHT_BEAT_POP,
  },
  '16bar-pop': {
    id: '16bar-pop',
    name: '16小節ポップス',
    description: 'AメロからサビまでつなげやすいI–V–vi–IVの16小節構成。展開の練習に向いています。',
    bpm: 124,
    key: 'C',
    scale: 'major',
    lengthBars: 16,
    progression: IVviIV,
    drumPattern: EIGHT_BEAT_POP,
  },
  'bgm-loop': {
    id: 'bgm-loop',
    name: 'BGMループ',
    description: '映像や配信の裏で流しやすい、繰り返し前提の落ち着いたvi–IV–I–Vループです。',
    bpm: 100,
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    progression: viIVIV,
    drumPattern: EIGHT_BEAT_POP,
  },
  'jingle-15s': {
    id: 'jingle-15s',
    name: '15秒ジングル',
    description: 'CMやイントロ向けの短いジングル。ii–V–Iでさっと終わる4小節構成です。',
    bpm: 128,
    key: 'C',
    scale: 'major',
    lengthBars: 4,
    progression: iiVI,
    drumPattern: FOUR_ON_THE_FLOOR,
  },
  'jingle-30s': {
    id: 'jingle-30s',
    name: '30秒ジングル',
    description: '少し長めのジングル。ii–V–Iを2回まわして印象を残す8小節構成です。',
    bpm: 128,
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    progression: iiVI,
    drumPattern: FOUR_ON_THE_FLOOR,
  },
  'jingle-60s': {
    id: 'jingle-60s',
    name: '60秒ジングル',
    description:
      'ラジオCMや動画オープニング向けの約60秒ジングル。ii–V–Iをくり返してしっかり聴かせる32小節構成です（128 BPMで32小節＝ちょうど60秒）。',
    bpm: 128,
    key: 'C',
    scale: 'major',
    lengthBars: 32,
    progression: iiVI,
    drumPattern: FOUR_ON_THE_FLOOR,
  },
  'lofi-chill': {
    id: 'lofi-chill',
    name: 'Lo-fiチル',
    description: 'メジャー7thを多用した、ゆったり聴かせるLo-fi向けの8小節ループです。',
    bpm: 82,
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    progression: LOFI_PROG,
    drumPattern: LOFI_BEAT,
  },
  'game-loop': {
    id: 'game-loop',
    name: 'ゲームループ',
    description: 'ステージBGMのようにテンポよく回る、明るいvi–IV–I–Vのゲーム用ループです。',
    bpm: 140,
    key: 'C',
    scale: 'major',
    lengthBars: 8,
    progression: viIVIV,
    drumPattern: GAME_LOOP_BEAT,
  },
};

function buildChordTrack(
  template: ProjectTemplate,
  timeSignature: [number, number],
): ChordEvent[] {
  const barBeats = beatsPerBar(timeSignature);
  const loopBars = template.progression.reduce((sum, step) => sum + step.bars, 0);
  const events: ChordEvent[] = [];
  let bar = 0;
  while (bar < template.lengthBars) {
    for (const step of template.progression) {
      if (bar >= template.lengthBars) break;
      events.push({
        id: makeId('chord'),
        startBeat: bar * barBeats,
        durationBeats: step.bars * barBeats,
        symbol: step.symbol,
        root: step.root,
        quality: step.quality,
        notes: chordPitchClasses(step.root, step.quality),
      });
      bar += step.bars;
    }
    if (loopBars <= 0) break;
  }
  return events;
}

function buildDrumEvents(template: ProjectTemplate, stepsPerBar: number): DrumEvent[] {
  const events: DrumEvent[] = [];
  for (let bar = 0; bar < template.lengthBars; bar++) {
    const base = bar * stepsPerBar;
    for (const hit of template.drumPattern) {
      events.push({
        id: makeId('drum'),
        lane: hit.lane,
        stepIndex: base + hit.step,
        velocity: hit.lane === 'kick' || hit.lane === 'snare' ? 110 : 90,
      });
    }
  }
  return events;
}

/**
 * Instantiate a fully-formed Project from a template id.
 * Throws if the template id is unknown.
 */
export function instantiateTemplate(templateId: TemplateId, clock: Clock = systemClock): Project {
  const template = PROJECT_TEMPLATES[templateId];
  if (!template) {
    throw new Error(`Unknown template id: ${templateId}`);
  }

  const project = createEmptyProject({
    title: template.name,
    bpm: template.bpm,
    key: template.key,
    scale: template.scale,
    lengthBars: template.lengthBars,
    clock,
  });

  const chordTrack = buildChordTrack(template, project.timeSignature);

  const drumTrack = project.tracks.find((t) => t.type === 'drum');
  const drumClip = drumTrack?.clips[0];
  const stepsPerBar = drumClip?.stepsPerBar ?? 16;
  const tracks = project.tracks.map((track) => {
    if (track.type !== 'drum') return track;
    return {
      ...track,
      clips: track.clips.map((clip, i) =>
        i === 0 ? { ...clip, drumEvents: buildDrumEvents(template, stepsPerBar) } : clip,
      ),
    };
  });

  return { ...project, chordTrack, tracks };
}
