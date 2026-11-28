// P70 fixture generator. Run it ONLY inside a checkout of wave5 commit d85f796 (see ../README.md).
//
// It writes, for every fixture project:
//   inputs/<name>.json            the wave5 v3 project (the converter input)
//   expected/<name>.events.json   what wave5's REAL `soundingEvents` (d85f796) plays for it  (the golden answer)
//   expected/<name>.lanes.json    wave5's REAL `evaluateAutomation` sampled every 1/8 beat, in main's units
//   manifest.json                 index of the fixtures
//
// BASELINE = the wave5 LOAD path: every golden is computed from `deserializeProject(JSON.stringify(input))`
// (migrate + normalizeClipDomain), because that is what the wave5 app plays (projectFileImport / persistence).
//
// Nothing in here is imported from main or from any converter. The golden events come only from wave5's
// own `soundingEvents(project, { includeMuted: true })`. The numbers the converter must produce for the
// non-event rules (roles, lane values, sends, ...) are NOT produced here; the tests hold them as
// hand-computed literals.
//
// Environment: W5_ROOT = absolute path of the d85f796 checkout, P70_OUT = this fixtures/p70 directory.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W5 = process.env.W5_ROOT;
const OUT = process.env.P70_OUT;
if (!W5 || !OUT) throw new Error('set W5_ROOT and P70_OUT');

// ---- determinism: the wave5 app ids use Date.now / Math.random / new Date() ----
const FIXED = '2026-01-01T00:00:00.000Z';
const RealDate = Date;
let seed = 0x1234abcd;
Math.random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED);
    else super(...(args as [string]));
  }
  static override now(): number {
    return RealDate.parse(FIXED);
  }
}
globalThis.Date = FixedDate as unknown as DateConstructor;

const model: any = await import(`${W5}/packages/project-model/src/index.ts`);
const appDefault: any = await import(`${W5}/apps/studio/src/state/defaultProject.ts`);
const appSample: any = await import(`${W5}/apps/studio/src/state/sampleProject.ts`);
const effectsMod: any = await import(`${W5}/apps/studio/src/audio/effects.ts`);
const automationMod: any = await import(`${W5}/packages/project-model/src/automation.ts`);
const {
  soundingEvents, validateProject, deserializeProject, serializeProject, beatTick, instantiateTemplate, PROJECT_TEMPLATES,
  createEmptyProject, addNoteToClip, addTrack, addClip, resizeClip, duplicateClip, splitClip, toggleDrumStep, addReverbReturn,
  setTrackSend, setTrackInstrumentMacros, setTrackVolume, setTrackPan,
} = model;
const { upsertEffect, createDefaultEffectConfig } = effectsMod;
const { evaluateAutomation, addPoint } = automationMod;
const clock = () => new RealDate(FIXED);

type J = Record<string, any>;
const fixtures: Array<{ name: string; kind: string; description: string; project: J }> = [];
const add = (name: string, kind: string, description: string, project: J) =>
  fixtures.push({ name, kind, description, project });

// ---- real wave5 projects ----
add('default-app', 'app-default', 'apps/studio createDefaultProject() as the wave5 app starts', appDefault.createDefaultProject());
add('default-empty', 'package-default', 'packages/project-model createEmptyProject() (Chords/Bass/Melody/Drums/Master)', createEmptyProject({ clock }));
add('sample-song', 'app-sample', 'apps/studio createSampleProject()', appSample.createSampleProject());
for (const id of Object.keys(PROJECT_TEMPLATES)) {
  add(`template-${id}`, 'template', `instantiateTemplate('${id}')`, instantiateTemplate(id, clock));
}

// ---- hand-built builders ----
const note = (id: string, pitch: number, startBeat: number, durationBeats: number, velocity = 100) =>
  ({ id, pitch, startBeat, durationBeats, velocity });
const hit = (id: string, lane: string, stepIndex: number, velocity = 100) => ({ id, lane, stepIndex, velocity });
const midiClip = (id: string, trackId: string, startBeat: number, lengthBeats: number, notes: J[], extra: J = {}) =>
  ({ id, trackId, type: 'midi', startBeat, lengthBeats, loop: false, notes, ...extra });
const drumClip = (id: string, trackId: string, startBeat: number, lengthBeats: number, drumEvents: J[], extra: J = {}) =>
  ({ id, trackId, type: 'drum', startBeat, lengthBeats, loop: false, stepsPerBar: 16, drumEvents, ...extra });
const instrument = (id: string, name: string, clips: J[], extra: J = {}) => ({
  id, name, type: 'instrument', clips, volume: 0.5, pan: 0, mute: false, solo: false,
  instrument: { type: 'synth', preset: 'warmPad' }, effects: [], ...extra,
});
const drumTrack = (id: string, name: string, clips: J[], extra: J = {}) => ({
  id, name, type: 'drum', clips, volume: 0.5, pan: 0, mute: false, solo: false,
  instrument: { type: 'drumkit', preset: 'acoustic' }, effects: [], ...extra,
});
const bus = (id: string, name: string, extra: J = {}) => ({
  id, name, type: 'bus', clips: [], volume: 1, pan: 0, mute: false, solo: false, effects: [], ...extra,
});
const master = (id = 'master') => ({
  id, name: 'Master', type: 'master', clips: [], volume: 1, pan: 0, mute: false, solo: false, effects: [],
});
const project = (id: string, tracks: J[], extra: J = {}) => ({
  id, schemaVersion: 3, title: id, bpm: 120, timeSignature: [4, 4], key: 'C', scale: 'major', lengthBars: 8,
  tracks, chordTrack: [], sections: [], createdAt: FIXED, updatedAt: FIXED, ...extra,
});

// meter + tempo: 6/8 at bpm 90, 4 bars (= 12 beats)
add('meter-6-8-bpm90', 'hand', '6/8, bpm 90, lengthBars 4 -> lengthBeats 12', project('p-meter', [
  instrument('t-piano', 'Piano', [midiClip('c-piano', 't-piano', 0, 12, [note('n1', 60, 0, 1), note('n2', 64, 1.5, 1)])]),
  drumTrack('t-drums', 'Drums', [drumClip('c-drums', 't-drums', 0, 12, [hit('d1', 'kick', 0), hit('d2', 'snare', 6)], { stepsPerBar: 12 })]),
  master(),
], { bpm: 90, timeSignature: [6, 8], lengthBars: 4 }));

// roles
add('roles', 'hand', 'role mapping: chords x2, bass, melody x2, drums, none', project('p-roles', [
  instrument('t-chords-1', 'Pad A', [], { role: 'chords' }),
  instrument('t-chords-2', 'Pad B', [], { role: 'chords' }),
  instrument('t-bass', 'Bass', [], { role: 'bass' }),
  instrument('t-melody-1', 'Lead A', [], { role: 'melody' }),
  instrument('t-melody-2', 'Lead B', [], { role: 'melody' }),
  drumTrack('t-drums', 'Drums', [], { role: 'drums' }),
  instrument('t-plain', 'Plain', []),
  master(),
]));

// lanes: volume, pan (with saturation), cutoff, equal beats
add('lane-volume', 'hand', 'volume lane on a fader of 0.5', project('p-lane-volume', [
  instrument('t-a', 'A', [], { volume: 0.5, automation: { volume: { points: [
    { beat: 0, value: 1 }, { beat: 4, value: 0.5 }, { beat: 8, value: 0.25 },
  ] } } }),
  master(),
]));
add('lane-pan', 'hand', 'pan lanes that saturate (pan 0.5 / -0.25) and one that does not', project('p-lane-pan', [
  instrument('t-up', 'Up', [], { pan: 0.5, automation: { pan: { points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] } } }),
  instrument('t-down', 'Down', [], { pan: -0.25, automation: { pan: { points: [{ beat: 0, value: 0 }, { beat: 4, value: -1 }] } } }),
  instrument('t-inside', 'Inside', [], { pan: 0.25, automation: { pan: { points: [{ beat: 0, value: 0 }, { beat: 4, value: 0.5 }] } } }),
  master(),
]));
add('lane-cutoff', 'hand', 'cutoff multiplier lane 1,2,0.5,10,0.1', project('p-lane-cutoff', [
  instrument('t-a', 'A', [], { automation: { cutoff: { points: [
    { beat: 0, value: 1 }, { beat: 4, value: 2 }, { beat: 8, value: 0.5 }, { beat: 12, value: 10 }, { beat: 16, value: 0.1 },
  ] } } }),
  master(),
]));
add('lane-equal-beats', 'hand', 'two points on the same beat make a jump', project('p-lane-equal', [
  instrument('t-a', 'A', [], { volume: 1, automation: { volume: { points: [
    { beat: 0, value: 1 }, { beat: 4, value: 0.5 }, { beat: 4, value: 0.25 }, { beat: 8, value: 0.25 },
  ] } } }),
  master(),
]));
add('lane-equal-beats-at-zero', 'hand', 'two points on beat 0', project('p-lane-equal-zero', [
  instrument('t-a', 'A', [], { volume: 1, automation: { volume: { points: [
    { beat: 0, value: 1 }, { beat: 0, value: 0.5 }, { beat: 4, value: 0.5 },
  ] } } }),
  master(),
]));

// sends (the dangling send makes this file invalid for wave5's own validateProject; it still plays)
add('sends', 'hand', 'two returns; sends of 0.5/0.25/0.75/1; a send to a missing return; a zero send', project('p-sends', [
  instrument('t-piano', 'Piano', [], { sends: { 'r-reverb': 0.5, 'r-delay': 0.25 } }),
  instrument('t-bass', 'Bass', [], { sends: { 'r-reverb': 0.75, 'r-missing': 0.5, 'r-delay': 0 } }),
  drumTrack('t-drums', 'Drums', [], { sends: { 'r-delay': 1 } }),
  bus('r-reverb', 'Reverb'),
  bus('r-delay', 'Delay'),
  master(),
]));

// loops
add('loop-no-content-length', 'hand', 'loop:true without contentLengthBeats: wave5 plays one pass', project('p-loop-plain', [
  instrument('t-a', 'A', [midiClip('c-a', 't-a', 0, 8, [note('n1', 60, 0, 1), note('n2', 62, 1, 1)], { loop: true })]),
  master(),
]));
add('loop-content-length', 'hand', 'clip 2..10, loop period 3: three passes, last one cut by the clip end', project('p-loop-content', [
  instrument('t-a', 'Lead', [midiClip('c-a', 't-a', 2, 8, [
    note('n1', 60, 0, 1), note('n2', 62, 1, 2.5), note('n3', 64, 2.5, 1), note('n4', 65, 3.5, 1),
  ], { loop: true, contentLengthBeats: 3 })]),
  master(),
]));
add('loop-drum-content-length', 'hand', 'drum clip 0..8, loop period 2 beats = 8 steps, with an open hat the closed hat chokes', project('p-loop-drum', [
  drumTrack('t-d', 'Drums', [drumClip('c-d', 't-d', 0, 8, [
    hit('d1', 'kick', 0), hit('d2', 'snare', 4), hit('d3', 'openHat', 5), hit('d4', 'closedHat', 6), hit('d5', 'perc', 10),
  ], { loop: true, contentLengthBeats: 2 })]),
  master(),
]));
add('loop-drum-offgrid-period', 'hand', 'drum clip 0..2, loop period 0.6 beat (2.4 steps): repeats land between steps', project('p-loop-drum-snap', [
  drumTrack('t-d', 'Drums', [drumClip('c-d', 't-d', 0, 2, [hit('d1', 'kick', 0), hit('d2', 'snare', 1)],
    { loop: true, contentLengthBeats: 0.6 })]),
  master(),
], { lengthBars: 1 }));

// links
add('link-chain', 'hand', 'A owns notes, B links A, C links B (same track, same type, same length)', project('p-link-chain', [
  instrument('t-a', 'A', [
    midiClip('c-a', 't-a', 0, 4, [note('n1', 60, 0, 1), note('n2', 64, 2, 1)]),
    midiClip('c-b', 't-a', 4, 4, [], { aliasOf: 'c-a' }),
    midiClip('c-c', 't-a', 8, 4, [], { aliasOf: 'c-b' }),
  ]),
  master(),
]));
add('link-cross-track', 'hand', 'a clip on another track links a clip of the first track', project('p-link-cross', [
  instrument('t-a', 'Piano', [midiClip('c-a', 't-a', 0, 4, [note('n1', 60, 0, 1), note('n2', 64, 2, 1)])]),
  instrument('t-b', 'Strings', [midiClip('c-x', 't-b', 0, 4, [], { aliasOf: 'c-a' })]),
  master(),
]));
add('link-length-mismatch', 'hand', 'same track, same type, but the link is shorter than its source', project('p-link-length', [
  instrument('t-a', 'A', [
    midiClip('c-a', 't-a', 0, 4, [note('n1', 60, 0, 1), note('n2', 62, 1.5, 1), note('n3', 64, 3, 1)]),
    midiClip('c-y', 't-a', 4, 2, [], { aliasOf: 'c-a' }),
  ]),
  master(),
]));
add('link-broken-cyclic', 'hand', 'missing target, type mismatch, owns content, two-clip cycle, self link, plus one normal clip', project('p-link-broken', [
  instrument('t-a', 'A', [
    midiClip('c-ok', 't-a', 0, 2, [note('n1', 60, 0, 1)]),
    midiClip('c-missing', 't-a', 2, 2, [], { aliasOf: 'c-nowhere' }),
    midiClip('c-cyc1', 't-a', 4, 2, [], { aliasOf: 'c-cyc2' }),
    midiClip('c-cyc2', 't-a', 6, 2, [], { aliasOf: 'c-cyc1' }),
    midiClip('c-self', 't-a', 8, 2, [], { aliasOf: 'c-self' }),
    midiClip('c-owns', 't-a', 10, 2, [note('n2', 67, 0, 1)], { aliasOf: 'c-nowhere' }),
    midiClip('c-type', 't-a', 12, 2, [], { aliasOf: 'c-dr' }),
  ]),
  drumTrack('t-d', 'Drums', [drumClip('c-dr', 't-d', 0, 2, [hit('d1', 'kick', 0)])]),
  master(),
]));
add('link-of-looped-source', 'hand', 'a link to a source that loops (source unrolled), and a link with its own loop', project('p-link-looped', [
  instrument('t-a', 'A', [
    midiClip('c-a', 't-a', 0, 4, [note('n1', 60, 0, 1), note('n2', 62, 1.5, 1), note('n3', 64, 2.5, 1)],
      { loop: true, contentLengthBeats: 2 }),
    midiClip('c-b', 't-a', 4, 4, [], { aliasOf: 'c-a' }),
    midiClip('c-c', 't-a', 8, 4, [], { aliasOf: 'c-a', loop: true, contentLengthBeats: 2 }),
  ], { }),
  master(),
], { lengthBars: 4 }));

// swing
add('swing', 'hand', 'project swing 35 with off-grid and on-grid material', project('p-swing', [
  instrument('t-a', 'A', [midiClip('c-a', 't-a', 0, 4, [
    note('n1', 60, 0, 0.2), note('n2', 62, 0.25, 0.2), note('n3', 64, 0.5, 0.2), note('n4', 65, 0.75, 0.2),
    note('n5', 67, 2 + 1 / 3, 0.2),
  ])]),
  drumTrack('t-d', 'Drums', [drumClip('c-d', 't-d', 0, 4, [
    hit('d1', 'kick', 0), hit('d2', 'snare', 1), hit('d3', 'closedHat', 3), hit('d4', 'closedHat', 6), hit('d5', 'perc', 9),
  ])]),
  master(),
], { swing: 35 }));

// macros
add('macros', 'hand', 'one instrument with macros and an existing param, one without', project('p-macros', [
  instrument('t-a', 'With', [], { instrument: {
    type: 'synth', preset: 'warmPad', params: { gain: 0.5 },
    macros: { brightness: 0.75, release: 0.25, width: 0.5, attack: 1 },
  } }),
  instrument('t-b', 'Without', []),
  master(),
]));

// legacy fields
add('legacy-fields', 'hand', 'legacyBarLimit, loopRange and legacyClipSettings', project('p-legacy', [
  instrument('t-a', 'A', [midiClip('c-a', 't-a', 0, 4, [note('n1', 60, 0, 1)],
    { legacyClipSettings: { loop: true, contentLengthBeats: 2 } })]),
  master(),
], { lengthBars: 80, legacyBarLimit: 80, loopRange: { startBeat: 4, endBeat: 8 } }));

// limits
add('over-limit-steps', 'hand', 'drum clip with 192 steps per bar (main allows at most 128)', project('p-over-steps', [
  drumTrack('t-d', 'Drums', [drumClip('c-d', 't-d', 0, 4, [hit('d1', 'kick', 0)], { stepsPerBar: 192 })]),
  master(),
], { lengthBars: 1 }));
add('over-limit-events', 'hand', '6 notes looped every 1/16 beat for 256 beats = 24576 events (wave5 allows 100000, main runtime 20000)', project('p-over-events', [
  instrument('t-a', 'A', [midiClip('c-a', 't-a', 0, 256, [
    note('n1', 60, 0, 0.005), note('n2', 62, 0.01, 0.005), note('n3', 64, 0.02, 0.005),
    note('n4', 65, 0.03, 0.005), note('n5', 67, 0.04, 0.005), note('n6', 69, 0.05, 0.005),
  ], { loop: true, contentLengthBeats: 0.0625 })]),
  master(),
], { lengthBars: 64 }));

// audio
add('audio-clips', 'hand', 'audio clips: two share a legacy asset id, one has another, one has none', project('p-audio', [
  { id: 't-au', name: 'Audio', type: 'audio', volume: 1, pan: 0, mute: false, solo: false, effects: [], clips: [
    { id: 'c-au1', trackId: 't-au', type: 'audio', startBeat: 0, lengthBeats: 4, loop: false, audioAssetId: 'wave-a' },
    { id: 'c-au2', trackId: 't-au', type: 'audio', startBeat: 4, lengthBeats: 4, loop: false, audioAssetId: 'wave-a' },
    { id: 'c-au3', trackId: 't-au', type: 'audio', startBeat: 8, lengthBeats: 4, loop: false, audioAssetId: 'wave-b' },
    { id: 'c-au4', trackId: 't-au', type: 'audio', startBeat: 12, lengthBeats: 4, loop: false },
  ] },
  master(),
]));

// mixer: mute / solo / fader / pan / the five wave5 effects (built with wave5's own createDefaultEffectConfig/upsertEffect)
const fiveEffects = () => {
  let fx: any[] = [];
  for (const type of ['filter', 'delay', 'reverb', 'eq', 'compressor']) fx = upsertEffect(fx, type, (e: any) => e);
  return upsertEffect(fx, 'eq', (e: any) => ({ ...e, params: { lowGainDb: 6, midGainDb: 0, highGainDb: -3 } }));
};
add('mixer-effects', 'hand', 'mute, solo, fader, pan, the five wave5 effects at their wave5 defaults (eq +6/0/-3), a chord track and a section', project('p-mixer', [
  instrument('t-a', 'Piano', [midiClip('c-a', 't-a', 0, 4, [note('n1', 60, 0, 1)])], {
    volume: 0.75, pan: -0.5, mute: true, color: '#7c9cf0', effects: fiveEffects() }),
  instrument('t-b', 'Strings', [midiClip('c-b', 't-b', 0, 4, [note('n2', 64, 0, 1)])], { solo: true, volume: 1.25, pan: 0.5 }),
  master(),
], { chordTrack: [{ id: 'ch1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] }],
  sections: [{ id: 's1', name: 'メイン', type: 'verse', startBar: 0, lengthBars: 8 }] }));

const oneTrack = (id: string, effects: any[], extra: J = {}) => project(id, [
  instrument('t-a', 'Piano', [midiClip('c-a', 't-a', 0, 4, [note('n1', 60, 0, 1)])], { effects }),
  master(),
], extra);
add('effects-order-eq-enabled', 'hand', 'saved order reverb, filter, eq(enabled): wave5 re-orders to eq, filter, reverb',
  oneTrack('p-fx-order-on', ['reverb', 'filter', 'eq'].reduce((fx: any[], t) => upsertEffect(fx, t, (e: any) => e), [])));
add('effects-order-eq-disabled', 'hand', 'saved order reverb, filter, eq(disabled): wave5 keeps the saved order',
  oneTrack('p-fx-order-off', ['reverb', 'filter', 'eq'].reduce((fx: any[], t) => upsertEffect(fx, t, (e: any) => (t === 'eq' ? { ...e, enabled: false } : e)), [])));
add('effects-adjusted', 'hand', 'values main cannot hold (filter 0.7 Hz / Q 0.15, delay 1 s) and an effect type main does not have', oneTrack('p-fx-adjusted', [
  { id: 'fx-filter', type: 'filter', enabled: true, params: { cutoff: 0.7, resonance: 0.15 } },
  { id: 'fx-delay', type: 'delay', enabled: true, params: { timeSeconds: 1 } },
  { id: 'fx-chorus', type: 'chorus', enabled: true, params: { rate: 1 } },
]));

// the reverb return exactly as the wave5 app makes it (addReverbReturn / setTrackSend)
{
  let p: any = createEmptyProject({ clock });
  const melody = p.tracks.find((t: J) => t.role === 'melody');
  p = addNoteToClip(p, melody.clips[0].id, { pitch: 64, startBeat: 0, durationBeats: 1, velocity: 100 }, clock);
  p = addReverbReturn(p, clock);
  const bus = p.tracks.find((t: J) => t.type === 'bus');
  p = setTrackSend(p, melody.id, bus.id, 0.5, clock);
  add('return-reverb', 'wave5-edit', 'addReverbReturn + setTrackSend(0.5) on the Melody track', JSON.parse(serializeProject(p)));
}

// lanes
add('lane-first-point-late', 'hand', 'lanes whose first point is after beat 0 (wave5 holds the first value before it; main would use the fader)', project('p-lane-late', [
  instrument('t-a', 'A', [], { volume: 0.5, pan: 0.25, automation: {
    volume: { points: [{ beat: 2, value: 0.5 }, { beat: 6, value: 1 }] },
    pan: { points: [{ beat: 3, value: 0.5 }] },
    cutoff: { points: [{ beat: 4, value: 2 }, { beat: 8, value: 1 }] },
  } }),
  master(),
]));
add('lanes-unplayable', 'hand', 'master lanes, a drum cutoff lane and a bus cutoff lane (wave5 never plays them) next to playable drum/bus volume+pan lanes', project('p-lanes-unplayable', [
  drumTrack('t-d', 'Drums', [], { automation: { cutoff: { points: [{ beat: 0, value: 2 }] }, volume: { points: [{ beat: 0, value: 1 }, { beat: 4, value: 0.5 }] } } }),
  bus('r-bus', 'Reverb', { automation: { cutoff: { points: [{ beat: 0, value: 2 }] }, volume: { points: [{ beat: 0, value: 0.5 }, { beat: 4, value: 1 }] }, pan: { points: [{ beat: 0, value: -0.5 }, { beat: 4, value: 0.5 }] } } }),
  { ...master(), automation: { volume: { points: [{ beat: 0, value: 1 }, { beat: 4, value: 0 }] }, pan: { points: [{ beat: 0, value: 0.5 }] }, cutoff: { points: [{ beat: 0, value: 2 }] } } },
]));

// swing + loop: wave5 ends the cut note at the pass end; the stored length must be pass end minus the SWUNG start
add('swing-loop-cut', 'hand', 'swing 50, clip 0..8, period 2, note at 1.75 for 1 beat (starts 900 ticks, ends 960)', project('p-swing-loop', [
  instrument('t-a', 'A', [midiClip('c-a', 't-a', 0, 8, [note('n1', 60, 1.75, 1)], { loop: true, contentLengthBeats: 2 })]),
  master(),
], { swing: 50 }));

// song end
add('song-end', 'hand', 'lengthBars 4: a clip crossing the end, a clip after it, chords and sections crossing / after the end', project('p-song-end', [
  instrument('t-a', 'A', [
    midiClip('c-a', 't-a', 0, 8, [note('n1', 60, 0, 1)]),
    midiClip('c-b', 't-a', 12, 8, [note('n2', 62, 0, 1), note('n3', 64, 3.5, 2), note('n4', 65, 5, 1)]),
    midiClip('c-c', 't-a', 20, 4, [note('n5', 67, 0, 1)]),
  ]),
  master(),
], { lengthBars: 4,
  chordTrack: [
    { id: 'ch1', startBeat: 0, durationBeats: 4, symbol: 'C', root: 'C', quality: 'major', notes: [0, 4, 7] },
    { id: 'ch2', startBeat: 14, durationBeats: 4, symbol: 'F', root: 'F', quality: 'major', notes: [5, 9, 0] },
    { id: 'ch3', startBeat: 18, durationBeats: 2, symbol: 'G', root: 'G', quality: 'major', notes: [7, 11, 2] },
  ],
  sections: [
    { id: 's1', name: 'A', type: 'verse', startBar: 0, lengthBars: 2 },
    { id: 's2', name: 'B', type: 'chorus', startBar: 3, lengthBars: 2 },
    { id: 's3', name: 'C', type: 'outro', startBar: 5, lengthBars: 1 },
  ] }));
add('song-length-80', 'hand', 'lengthBars 80 WITHOUT legacyBarLimit: wave5 loads it as 64 bars (256 beats); the note at 290 never sounds', project('p-song-80', [
  instrument('t-a', 'A', [midiClip('c-a', 't-a', 0, 300, [note('n1', 60, 10, 1), note('n2', 62, 290, 1)])]),
  master(),
], { lengthBars: 80 }));

// overlapping clips: wave5 splits them onto "<track>-overlap-N" tracks on load
add('overlap-clips', 'hand', 'two overlapping clips on one track (wave5 load moves the later one to t-a-overlap-1)', project('p-overlap', [
  instrument('t-a', 'Piano', [
    midiClip('c-a', 't-a', 0, 4, [note('n1', 60, 0, 1)]),
    midiClip('c-b', 't-a', 2, 4, [note('n2', 62, 0, 1)]),
  ]),
  instrument('t-b', 'Strings', [midiClip('c-c', 't-b', 0, 4, [note('n3', 64, 0, 1)])]),
  master(),
]));

// links: longer than the source, drum links (steps per bar of the source), drum clip without stepsPerBar in 3/4
add('link-longer', 'hand', 'a link LONGER than its source (4 beats vs 2): wave5 plays the source content once', project('p-link-longer', [
  instrument('t-a', 'A', [
    midiClip('c-a', 't-a', 0, 2, [note('n1', 60, 0, 1), note('n2', 62, 1, 0.5)]),
    midiClip('c-y', 't-a', 2, 4, [], { aliasOf: 'c-a' }),
  ]),
  master(),
]));
add('link-drum', 'hand', 'drum source with 12 steps per bar; an alias that wrongly carries stepsPerBar 16; a cross-track drum link', project('p-link-drum', [
  drumTrack('t-d1', 'Drums', [
    drumClip('c-src', 't-d1', 0, 4, [hit('d1', 'kick', 0), hit('d2', 'snare', 3), hit('d3', 'closedHat', 6), hit('d4', 'openHat', 9), hit('d5', 'perc', 11)], { stepsPerBar: 12 }),
    drumClip('c-alias', 't-d1', 4, 4, [], { aliasOf: 'c-src', stepsPerBar: 16 }),
  ]),
  drumTrack('t-d2', 'Drums 2', [drumClip('c-x', 't-d2', 0, 4, [], { aliasOf: 'c-src', stepsPerBar: 16 })]),
  master(),
]));
{
  const clip = drumClip('c-d', 't-d', 0, 12, [hit('d1', 'kick', 0), hit('d2', 'snare', 4), hit('d3', 'perc', 15)]);
  delete (clip as J).stepsPerBar;
  add('drum-no-steps-3-4', 'hand', '3/4, drum clip without stepsPerBar (wave5 and main both read 16)', project('p-drum-34', [
    drumTrack('t-d', 'Drums', [clip]), master(),
  ], { timeSignature: [3, 4], lengthBars: 4 }));
}
add('loop-false-with-content-length', 'hand', 'loop:false but contentLengthBeats 2: wave5 plays all notes once', project('p-loop-false-cl', [
  instrument('t-a', 'A', [midiClip('c-a', 't-a', 0, 8, [note('n1', 60, 0, 1), note('n2', 62, 3, 1), note('n3', 64, 6, 1)], { contentLengthBeats: 2 })]),
  master(),
]));
add('type-mismatch-content', 'hand', 'notes on a drum track and drum hits on an instrument track (wave5 plays neither)', project('p-type-mismatch', [
  drumTrack('t-d', 'Drums', [midiClip('c-dn', 't-d', 0, 4, [note('n1', 60, 0, 1), note('n2', 62, 1, 1)])]),
  instrument('t-i', 'Piano', [drumClip('c-id', 't-i', 0, 4, [hit('d1', 'kick', 0), hit('d2', 'snare', 4)]), ]),
  master(),
]));

// drum hits wave5 plays but main cannot hold: several hits on one lane and step
add('drum-same-step-hits', 'hand', 'kick step0 x2 (100,80), closedHat step2 x3 (60,110,70), snare step4 once: wave5 plays all 6', project('p-drum-merge', [
  drumTrack('t-d', 'Drums', [drumClip('c-d', 't-d', 0, 4, [
    hit('d1', 'kick', 0, 100), hit('d2', 'kick', 0, 80),
    hit('d3', 'closedHat', 2, 60), hit('d4', 'closedHat', 2, 110), hit('d5', 'closedHat', 2, 70),
    hit('d6', 'snare', 4, 90),
  ])]),
  master(),
]));
add('loop-drum-snap-collision', 'hand', 'clip 0..2, period 0.6 beat (2.4 steps), kick step0 (100) and kick step2 (120): snapped repeats land on steps 2 and 7 twice', project('p-drum-collide', [
  drumTrack('t-d', 'Drums', [drumClip('c-d', 't-d', 0, 2, [hit('d1', 'kick', 0, 100), hit('d2', 'kick', 2, 120)],
    { loop: true, contentLengthBeats: 0.6 })]),
  master(),
], { lengthBars: 1 }));

// a clip whose type does not match its track but whose content wave5 DOES play: drum-typed clip holding MIDI notes on an instrument track
add('clip-type-mismatch-played', 'hand', 'instrument track, clip type drum with one MIDI note (pitch 60, 1 beat) and no drumEvents: wave5 plays the one 480-tick note', project('p-clip-type', [
  instrument('t-i', 'Piano', [{ ...midiClip('c-x', 't-i', 0, 4, [note('n1', 60, 0, 1)]), type: 'drum' }]),
  master(),
]));

// density: 300 notes inside 0.3 beat (main refuses more than 256 events per 0.75 beat even when the total is small)
add('over-limit-density', 'hand', '300 notes within 0.3 beat (total far below 20000)', project('p-over-density', [
  instrument('t-a', 'A', [midiClip('c-a', 't-a', 0, 4,
    Array.from({ length: 300 }, (_, k) => note(`n${k}`, 40 + (k % 48), k * 0.001, 0.002)))]),
  master(),
], { lengthBars: 1 }));

// a realistic song, made ONLY with wave5's own edit functions and written by wave5's serializeProject
{
  let p: any = instantiateTemplate('8bar-pop', clock);
  const id = (role: string) => p.tracks.find((t: J) => t.role === role);
  const addNotes = (trackRole: string, rows: Array<[number, number, number, number?]>) => {
    for (const [pitch, startBeat, durationBeats, velocity] of rows) {
      p = addNoteToClip(p, id(trackRole).clips[0].id, { pitch, startBeat, durationBeats, velocity: velocity ?? 100 }, clock);
    }
  };
  addNotes('chords', [[48, 0, 4, 80], [52, 0, 4, 80], [55, 0, 4, 80], [53, 4, 4, 80], [57, 4, 4, 80], [60, 4, 4, 80]]);
  addNotes('bass', [[36, 0, 1], [36, 2, 0.5], [41, 4, 1], [43, 6, 1.5]]);
  addNotes('melody', [[72, 0, 0.5], [74, 0.25, 0.5], [76, 0.75, 1], [79, 2 + 1 / 3, 0.5], [77, 5.25, 0.75], [72, 30, 4]]);
  p = addTrack(p, { type: 'instrument', name: 'Arp' }, clock);
  const arp = p.tracks[p.tracks.length - 2];
  p = resizeClip(p, arp.clips[0].id, 8, clock);
  for (const [pitch, startBeat, durationBeats] of [[60, 0, 0.5], [64, 0.5, 0.5], [67, 1.5, 1], [72, 2.5, 1]] as const) {
    p = addNoteToClip(p, arp.clips[0].id, { pitch, startBeat, durationBeats, velocity: 90 }, clock);
  }
  p = { ...p, tracks: p.tracks.map((t: J) => t.id !== arp.id ? t : { ...t, clips: t.clips.map((c: J) => ({ ...c, loop: true, contentLengthBeats: 2 })) }) };
  p = duplicateClip(p, arp.clips[0].id, { mode: 'link', startBeat: 8 }, clock);
  p = duplicateClip(p, arp.clips[0].id, { mode: 'copy', startBeat: 16 }, clock);
  p = setTrackInstrumentMacros(p, arp.id, { brightness: 0.7, release: 0.3, width: 0.2, attack: 0.6 }, clock);
  // hi-hat choke across two drum clips: an open hat at the end of clip 1, a closed hat at the start of clip 2
  const drums = id('drums') ?? p.tracks.find((t: J) => t.type === 'drum');
  const split = splitClip(p, drums.clips[0].id, 16, clock);
  p = split.project;
  const [first, second] = p.tracks.find((t: J) => t.id === drums.id).clips;
  p = toggleDrumStep(p, first.id, 'openHat', 31, 100, clock);
  p = toggleDrumStep(p, second.id, 'closedHat', 1, 100, clock);
  // the reverb return, sends, swing, effects, lanes, mixer
  p = addReverbReturn(p, clock);
  const bus = p.tracks.find((t: J) => t.type === 'bus');
  p = setTrackSend(p, id('melody').id, bus.id, 0.4, clock);
  p = setTrackSend(p, id('chords').id, bus.id, 0.2, clock);
  p = setTrackVolume(p, id('melody').id, 0.8, clock);
  p = setTrackPan(p, id('melody').id, -0.3, clock);
  let fx: any[] = [];
  for (const type of ['reverb', 'filter', 'delay', 'eq', 'compressor']) fx = upsertEffect(fx, type, (e: any) => e);
  const lane = (parameter: string, points: Array<[number, number]>) =>
    points.reduce((acc: any, [beat, value]) => addPoint(acc, { beat, value }, parameter), { points: [] });
  p = { ...p, swing: 25, tracks: p.tracks.map((t: J) => t.id !== id('melody').id ? t : {
    ...t, effects: fx,
    automation: {
      volume: lane('volume', [[0, 1], [16, 0.5], [32, 1]]),
      pan: lane('pan', [[0, 0], [8, 0.5], [16, -0.5]]),
      cutoff: lane('cutoff', [[0, 1], [8, 2], [16, 0.5]]),
    } }) };
  add('realistic-song', 'wave5-edit', 'template 8bar-pop edited with wave5 mutations: swing, loop, link, copy, macros, cross-clip choke, return + sends, 5 effects, lanes', JSON.parse(serializeProject(p)));
}

// ---- write ----
mkdirSync(join(OUT, 'inputs'), { recursive: true });
mkdirSync(join(OUT, 'expected'), { recursive: true });

const norm = (e: J) => {
  const startTick = beatTick(e.startBeat);
  if (e.kind === 'note') {
    return {
      trackId: e.trackId, clipId: e.clipId, kind: 'note', pitch: e.pitch, velocity: e.velocity,
      startTick, endTick: beatTick(e.startBeat + e.durationBeats), startBeat: e.startBeat, durationBeats: e.durationBeats,
    };
  }
  return {
    trackId: e.trackId, clipId: e.clipId, kind: 'drum', lane: e.lane, velocity: e.velocity, startTick,
    startBeat: e.startBeat,
    ...(e.durationBeats !== undefined ? { chokeEndTick: beatTick(e.startBeat + e.durationBeats) } : {}),
  };
};
const key = (e: J) => [e.startTick, e.trackId, e.kind, e.pitch ?? e.lane, e.velocity, e.endTick ?? e.chokeEndTick ?? -1];
const cmp = (a: J, b: J) => {
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
};

// ---- lane goldens: wave5's real evaluateAutomation, sampled every 1/8 beat, in MAIN's units ----
const LOG2_10 = 3.321928094887362; // main's pinned MAX_FILTER_CUTOFF_OCTAVES
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function laneGolden(loaded: J) {
  const bpb = loaded.timeSignature[0] * (4 / loaded.timeSignature[1]);
  const end = loaded.lengthBars * bpb;
  const steps = Math.round(end / 0.125);
  const lanes: J[] = [];
  for (const t of loaded.tracks) {
    if (t.type === 'master' || !t.automation) continue; // wave5 never plays Master lanes
    const params = [['volume', 'track-volume'], ['pan', 'track-pan'], ...(t.type === 'instrument' ? [['cutoff', 'track-filter-cutoff']] : [])] as const;
    for (const [parameter, target] of params) {
      const lane = t.automation[parameter];
      if (!lane?.points?.length) continue;
      const samples: number[] = [];
      for (let k = 0; k <= steps; k++) {
        const v = evaluateAutomation(lane, k * 0.125, parameter);
        samples.push(parameter === 'volume' ? t.volume * v
          : parameter === 'pan' ? clamp(t.pan + v, -1, 1)
          : clamp(Math.log2(v), -LOG2_10, LOG2_10));
      }
      lanes.push({ trackId: t.id, target, samples });
    }
  }
  return lanes;
}

const manifest: J[] = [];
for (const f of fixtures) {
  // The baseline is what the wave5 APP plays: its load path (deserializeProject = migrate + normalizeClipDomain).
  const loaded = deserializeProject(JSON.stringify(f.project));
  const validation = validateProject(loaded);
  const { events, problems } = soundingEvents(loaded, { includeMuted: true });
  const sorted = events.map(norm).sort(cmp);
  writeFileSync(join(OUT, 'inputs', `${f.name}.json`), `${JSON.stringify(f.project, null, 2)}\n`);
  writeFileSync(join(OUT, 'expected', `${f.name}.events.json`), `${JSON.stringify({
    generatedBy: 'wave5 d85f796 packages/project-model soundingEvents(project, { includeMuted: true })',
    ppq: 480,
    eventCount: sorted.length,
    problems,
    // over-limit fixtures are expected to be REFUSED; their (huge) event list is not needed.
    events: f.name === 'over-limit-events' ? [] : sorted,
  }, null, 2)}\n`);
  const lanes = laneGolden(loaded);
  if (lanes.length > 0) {
    writeFileSync(join(OUT, 'expected', `${f.name}.lanes.json`), `${JSON.stringify({
      generatedBy: 'wave5 d85f796 evaluateAutomation on deserializeProject(input); volume = fader * lane, pan = clamp(pan + lane), cutoff = log2(multiplier)',
      stepBeats: 0.125, lanes,
    })}\n`);
  }
  manifest.push({
    name: f.name, kind: f.kind, description: f.description, laneGolden: lanes.length > 0,
    wave5Valid: validation.valid, eventCount: sorted.length, problemCount: problems.length,
  });
}
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${fixtures.length} fixtures`);
for (const m of manifest) console.log(`${m.name}\tvalid=${m.wave5Valid}\tevents=${m.eventCount}\tproblems=${m.problemCount}`);
