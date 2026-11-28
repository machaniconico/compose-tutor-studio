// P70 acceptance tests (wave5 v3 project converter, R3). Written BEFORE the implementation; do not edit.
// Revised after the Fable ruling (docs: .omc scratch p70-fable-ruling.md): baseline = the wave5 LOAD path, effect table, lane samples.
//
// CONTRACT. Module: packages/project-model/src/legacy-wave5/ (or wave5-convert.ts), published from packages/project-model/src/index.ts;
// the tests import everything from '@cts/project-model'. Pure; no I/O, no clock, no randomness, no network. No schema bump: the output is
// the CURRENT main schema (CURRENT_SCHEMA_VERSION, v12 today). wave5 v3 is NOT registered in MIGRATIONS; detectProjectFormat and
// decodeProject('legacy-wave5-format') are unchanged (P02).
//
//   convertWave5Project(json: unknown): Wave5ConvertResult      (never throws, whatever the input)
//     ok   -> { ok: true, project: Project, report: Wave5ReportItem[] }
//     fail -> { ok: false, code: 'not-wave5-v3' | 'invalid-project' | 'over-limit', reason: string }  (reason: non-empty beginner Japanese; NO `project`/`report` key)
//     'not-wave5-v3'    detectProjectFormat(json) is 'main', or json is not an object.
//     'invalid-project' detectProjectFormat(json) is 'invalid-project' (1..4 of the five main-v3 keys), or the wave5 structure is unusable, or
//                       the converted project would not pass decodeProject (a successful result ALWAYS decodes; this is the safety net).
//     'over-limit'      rule 14.
//   The input is NEVER mutated (it may be deep-frozen) and prototypes are never polluted, even by keys/ids such as __proto__ / constructor.
//   Determinism: same input value -> byte-identical JSON.stringify(result). Generated ids derive from input ids/positions only. All ids unique, non-empty.
//
//   BASELINE (rule 0). The converter first applies wave5's LOAD normalization (a frozen copy of `deserializeProject` = migrate + normalizeClipDomain, d85f796):
//   what wave5 plays is `soundingEvents(deserializeProject(json))`, and that is what the golden files hold. Its effects, all reproduced by the converter:
//     - a clip whose link target is missing / cyclic / of another clip type, or that owns content itself, is DETACHED (aliasOf removed, own content kept);
//       a link to a link is rewired to its root;
//     - lengthBars is capped at 64 unless legacyBarLimit (65..256) allows more;
//     - clips of one track that overlap are moved onto extra tracks "<trackId>-overlap-<n>" (a copy of the track, inserted right after it).
//   Wave5ReportItem = { code, severity: 'info'|'changed'|'dropped', trackId?, clipId?, effectId?, detail?: Record<string, string|number|boolean> }
//   severity: dropped = data is lost; changed = what you hear or how clips are linked/edited changes; info = neither. `report` is ordered: project-level items first,
//   then track order, then clip order. WAVE5_REPORT_CODES (exported readonly array) lists every code; a report never has another one.
//   code (severity)  [where; detail]
//     legacy-bar-limit-dropped (info) [project]            loop-range-dropped (dropped) [project]       legacy-clip-settings-dropped (info) [clip]
//     loop-unrolled (changed) [clip; passes]               drum-loop-snapped (changed) [clip]
//     link-materialized (changed) [clip; reason: 'cross-track'|'length-mismatch'|'source-unrolled'|'own-loop']
//     link-broken (info) [clip; reason: 'missing'|'type-mismatch'|'owns-content']     link-cyclic (info) [clip]
//     duplicate-role-demoted (changed) [track; role]       send-dropped (dropped) [track; targetId]
//     automation-lane-dropped (dropped) [track; parameter] automation-point-dropped (info) [track; parameter, count]   (one per lane)
//     audio-clip-unresolved (changed) [clip]               chord-track-audible (changed) [project]
//     effects-approximated (changed) [project, at most one]   effect-adjusted (changed) [track, effectId]   effect-dropped (dropped) [track, effectId]
//     hidden-events-dropped (dropped) [clip; count]        song-end-trimmed (dropped) [project; clips, chords, sections]    overlap-split (changed) [track; layers]
//     drum-hits-merged (dropped) [clip; count]   count = how many hits disappeared into another hit (see rule 23)
//     clip-type-changed (changed) [clip; from, to]   from/to are clip type values 'midi' | 'drum' (see rule 24)
//   ('effect-disabled' no longer exists.)
//
// RULES (numbers are hand-computed in the tests; wave5 answers are the d85f796 goldens).
//  1  Shape. schemaVersion = CURRENT_SCHEMA_VERSION; swing = wave5 swing ?? 0; hiHatChoke = true (wave5 chokes unconditionally); audioTakeFolders = [];
//     automationReadState = { globalEnabled: true, disabledTrackIds: [] }; only keys of main's types survive. id, title, key, scale, bpm, timeSignature,
//     createdAt, updatedAt are carried over; tracks lose `sends`/`automation`; no `macros`.
//  2  Time. tempoMap = [{ beat 0, bpm }]; timeSignatureMap = [{ beat 0, numerator, denominator }]; lengthBeats = lengthBars * numerator * (4 / denominator).
//  3  Roles. wave5 'chords'|'bass'|'melody' -> 'learning.*' for the FIRST track holding it; later holders -> 'general' + duplicate-role-demoted. Everything else 'general'.
//  4  Effects (table; input is read like wave5's readNumber: aliases, clamp to wave5's range, wave5 default; output uses main's keys ONLY; `enabled` is kept):
//       filter     cutoffHz|cutoff (80..18000, 1800)         -> cutoff    = ln(Hz/80) / ln(200)        (Hz is first limited to main's 80..16000)
//                  resonance|q|Q (0.0001..30, 0.7)           -> resonance = (Q - 0.2) / 17.8           (Q first limited to main's 0.2..18)
//       delay      timeSeconds|time|delayTime (0..1.5, 0.25) -> delayTime = (t - 0.02) / 0.73          (t > 0.75 is first halved; then limited to 0.02..0.75)
//                  feedback (0..0.85, 0.28)                  -> feedback  = g / 0.85
//                  mix (0..1, 0.32)                          -> mix
//       reverb     mix (0..1, 0.25)                          -> wet = mix, decay = 0.43859649122807015 (wave5's fixed 1.4 s)
//       eq         lowGainDb|midGainDb|highGainDb (-12..12, 0) -> lowGain|midGain|highGain = (dB + 12) / 24
//       compressor thresholdDb (-60..0, -24)                 -> threshold = (dB + 48) / 42   (dB first limited to -48..-6)
//                  ratio (1..20, 3)                          -> ratio     = (r - 1) / 11     (r first limited to 1..12)
//                  attackSeconds (0..1, 0.01)                -> attack    = (a - 0.003) / 0.077  (a first limited to 0.003..0.08)
//                  releaseSeconds (0.01..1, 0.2)             -> release   = (r - 0.05) / 0.75    (r first limited to 0.05..0.8)
//     All results clamped to 0..1. Order: if ANY ENABLED eq or compressor exists, the effects are stably sorted eq, compressor, filter, delay, reverb; otherwise saved order.
//     Reports: effect-adjusted when a physical value had to be limited/halved; effect-dropped (and the effect removed) for any other type; effects-approximated once if any
//     enabled effect remains (EQ frequencies, compressor knee, reverb shape and the insert position differ; waveforms are not guaranteed).
//  5  Volume lane. value = track.volume * lane value, 'linear', bypassed false; track.volume stays.
//  6  Pan lane. value = clamp(track.pan + lane value, -1, 1); where a segment crosses +-1 an extra point at the crossing beat (value exactly +-1) is inserted.
//  7  Cutoff lane. value = log2(multiplier) clamped to +-MAX_FILTER_CUTOFF_OCTAVES, target 'track-filter-cutoff'. Lanes main cannot hold or wave5 never played are dropped
//     with automation-lane-dropped: everything on Master; pan/cutoff handling per track type: cutoff only on instrument tracks (drum/bus/audio cutoff dropped).
//  8  Points. wave5 uses only the LAST point of equal beats (the curve already runs toward it), so earlier points of one beat are dropped; one automation-point-dropped per lane
//     with detail { parameter, count }. If the first point is after beat 0, a point at beat 0 with the first value is prepended (wave5 holds it; main would use the fader/0).
//     The converted lane, evaluated by main's automationValueAt, equals wave5's evaluateAutomation sampled every 1/8 beat within 1e-6.
//  9  Sends. sends[returnId] = level (0 < level <= 1, existing 'bus', source not bus/master) -> { sourceTrackId, targetBusId, position 'post-fader', gain: level, enabled: true },
//     ordered by source track then return track. Level 0 is dropped silently, anything else unusable with send-dropped. outputs: one { sourceTrackId, destination master } per non-master track.
// 10  Loop without contentLengthBeats, or loop:false: one pass -> loop false, contentLengthBeats removed, no report.
// 11  Loop with contentLengthBeats P < clip length: unrolled into owned content, loop false, contentLengthBeats removed, one loop-unrolled (passes). Pass r exists while
//     tick(start + r*P) < tick(clip end). Only source events whose in-clip start tick < tick(P) take part; the others never sounded and are dropped and counted ONCE per clip
//     as hidden-events-dropped (also: source events starting at/after the clip end of a non-looping clip, and notes on a drum track / drum hits on an instrument track,
//     i.e. content whose KIND does not fit the TRACK type). A clip whose own `type` field disagrees with its track but whose content fits the track is NOT hidden: wave5 plays it (rule 24).
//     A note is cut at its pass end and at the clip end; the STORED length is (pass end or clip end) - (start AFTER swing), because main keeps the stored length when it swings
//     the onset. Pass-0 events keep their ids; later passes get ids derived from the original id and r. Drum repeats move by r*P/(beats per step) steps and snap (Math.round)
//     when that is not whole -> drum-loop-snapped. Notes extending past the clip end are cut to it; they are not reported.
// 12  Links. The ROOT of a link chain is found. A link stays an alias (aliasOf = root, ONE hop, no own notes/drumEvents/stepsPerBar) only if: same track, same clip type, same
//     lengthBeats as the root, the link does not unroll a loop, the root does not unroll a loop. Otherwise it is MATERIALIZED (owned copy of the root's RAW content, fresh ids, steps
//     per bar of the root, trimmed to the link's length, unrolled if the link loops): link-materialized with reason cross-track | length-mismatch | source-unrolled | own-loop.
//     Truncation inside a materialized copy is NOT counted as hidden-events-dropped.
// 13  Detached links (rule 0). missing target -> link-broken 'missing'; target of another clip type -> link-broken 'type-mismatch' (silent clip); link that also owns content ->
//     link-broken 'owns-content' (the own content is kept); cycle (incl. self) -> link-cyclic (silent clip). A silent clip keeps id/type/trackId/start/length, loop false,
//     no aliasOf/notes/drumEvents.
// 14  Limits. 'over-limit' (whole project refused, no partial output) when: a drum clip has stepsPerBar > 128; any clip would own > 20000 events; or the converted project
//     fails main's runtime budget exactly as buildScheduleEvents asserts it (more than 20000 audible events, or more than 256 in 0.75 beat). 20000 is accepted, 20001 is not.
// 15  Audio clips become unresolved assets as main's v2->v3 migration does (legacy-reference per distinct non-empty id, else missing-reference; frames 0, gain 0) +
//     audio-clip-unresolved per clip.
// 16  legacyBarLimit (info), loopRange (dropped) and clip legacyClipSettings (info) are dropped and reported. lengthBars is min(lengthBars, 64 or the legacy limit).
// 17  Macros -> params macroBrightness / macroRelease / macroWidth / macroAttack (existing params kept; `macros` removed).
// 18  Swing is copied; drum clips get no drumGroove.
// 19  chordTrack is carried over. chord-track-audible (changed) is reported exactly when countRealizedChordNotes(project) > 0 (main then plays chords wave5 never played).
// 20  Song end. wave5 plays nothing at/after min(clip end, song end) and main requires clips, chords and sections to end inside the song. Clips are cut at the song end, clips
//     starting at/after it are removed, chords and sections crossing it are shortened, those starting at/after it are removed; one song-end-trimmed { clips, chords, sections }
//     (counts of items cut or removed) when anything changed. (lengthBars 80 without legacyBarLimit loads as 64 bars = 256 beats.)
// 21  Overlapping clips are split like wave5's load does: extra track "<id>-overlap-<n>" (copy of the track, right after it, role 'general', own audioRouting output),
//     the clip's trackId follows; one overlap-split { layers } on the original track.
// 22  Hidden content: see rule 11 (hidden-events-dropped, detail.count).
// 23  Merged drum hits. wave5 plays EVERY hit; main holds one hit per drum lane and step of a clip. Hits of one clip on the same lane and the same (final) step become ONE
//     hit that keeps the HIGHEST velocity; one drum-hits-merged per clip with detail.count = number of hits that disappeared. This covers hits that are already on one step
//     in the input and repeats of a loop that land on one step after snapping (rule 11). It is NOT hidden-events-dropped, which only counts hits wave5 never sounded.
// 24  Clip type that disagrees with its track, content wave5 plays. wave5 sounds the clip's content by what the TRACK is (instrument track: notes; drum track: drumEvents), so a clip
//     typed 'drum' that holds notes on an instrument track (or typed 'midi' holding drumEvents on a drum track) IS played. main plays by the clip type, so the clip is converted to the
//     track's type ('midi' for an instrument track, 'drum' for a drum track), its content is kept untouched, and ONE clip-type-changed (changed, detail {from, to}) is reported for
//     that clip. Content that does not fit the track (rule 11) is not played by wave5: it is dropped as hidden-events-dropped and gets NO clip-type-changed.
//
// EVENT PARITY. buildScheduleEvents on the converted project (drums through resolveDrumOccurrence, chordTrack cleared) vs the golden, with the P20 rule
// (per track/kind/pitch-or-lane: start ticks within 1 tick, note end ticks within 1 tick, open-hat choke tick within 1 tick; velocity and counts exact). See p70-helpers.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CURRENT_SCHEMA_VERSION,
  MAX_FILTER_CUTOFF_OCTAVES,
  WAVE5_REPORT_CODES,
  convertWave5Project,
  countRealizedChordNotes,
  decodeProject,
  decodeProjectJson,
  detectProjectFormat,
  encodeProjectJson,
  createEmptyProject,
} from '@cts/project-model';
import { describe, expect, it } from 'vitest';
import { buildScheduleEvents } from '../../src/audio/events';
import { decayToSeconds, cutoffToFrequency, delayTimeToSeconds, eqGainToDb, resonanceToQ } from '../../src/audio/effects';
import {
  FIXTURE_DIR,
  allInputNames,
  allKeys,
  allLaneGoldenNames,
  clipOf,
  convertOk,
  convertibleNames,
  deepFreeze,
  drumRows,
  expectEventParity,
  expectFixtureParity,
  expectLaneParity,
  goldenOf,
  inputOf,
  laneOf,
  mainEventsOf,
  mergeSameStepDrumHits,
  noteRows,
  reportItems,
  trackOf,
  uniqueStrings,
} from './p70-helpers';

type Json = Record<string, any>;

function allIds(project: ReturnType<typeof convertOk>['project']): string[] {
  const ids: string[] = [project.id];
  for (const t of project.tracks) {
    ids.push(t.id, ...t.effects.map((e) => e.id));
    for (const c of t.clips) ids.push(c.id, ...(c.notes ?? []).map((n) => n.id), ...(c.drumEvents ?? []).map((d) => d.id));
  }
  ids.push(...project.tempoMap.map((e) => e.id), ...project.timeSignatureMap.map((e) => e.id));
  ids.push(...project.audioAssets.map((a) => a.id), ...project.automationLanes.flatMap((l) => [l.id, ...l.points.map((p) => p.id)]));
  ids.push(...project.audioRouting.sends.map((s) => s.id), ...project.chordTrack.map((c) => c.id), ...project.sections.map((s) => s.id));
  return ids;
}

const effectOf = (project: ReturnType<typeof convertOk>['project'], trackId: string, id: string) =>
  trackOf(project, trackId).effects.find((e) => e.id === id)!;

describe('P70 wave5 v3 converter', () => {
  it('convert_output_passesDecodeCurrentProject_andRustValidate', () => {
    const names = convertibleNames();
    expect(names.length).toBeGreaterThanOrEqual(45);
    // The Rust test (native_persistence/tests.rs, p70_converted_fixtures_pass_native_validation) validates the files written here:
    // fixtures/p70/converted/<name>.json. CI runs this TS test first and then cargo test with CTS_P70_REQUIRE_CONVERTED=1.
    mkdirSync(`${FIXTURE_DIR}converted`, { recursive: true });
    for (const name of names) {
      const { project } = convertOk(name);
      expect(project.schemaVersion, name).toBe(CURRENT_SCHEMA_VERSION);
      const decoded = decodeProject(project);
      expect(decoded.ok, `${name}: ${decoded.ok ? '' : JSON.stringify(decoded.error.issues.slice(0, 3))}`).toBe(true);
      expect(uniqueStrings(allIds(project)), `${name}: ids are unique`).toBe(true);
      expect(() => buildScheduleEvents(project), `${name}: main can schedule it`).not.toThrow();
      const encoded = encodeProjectJson(project, { pretty: true });
      expect(encoded.ok, name).toBe(true);
      if (!encoded.ok) continue;
      expect(decodeProjectJson(encoded.json).ok, `${name}: reread`).toBe(true);
      writeFileSync(`${FIXTURE_DIR}converted/${name}.json`, `${encoded.json}\n`);
    }
  });

  it('convert_isDeterministic_sameInputSameBytes', () => {
    for (const name of ['default-app', 'template-16bar-pop', 'loop-content-length', 'link-of-looped-source', 'sends', 'lane-pan', 'audio-clips', 'mixer-effects', 'realistic-song', 'overlap-clips']) {
      const first = JSON.stringify(convertWave5Project(inputOf(name)));
      const second = JSON.stringify(convertWave5Project(inputOf(name)));
      expect(second, name).toBe(first);
      expect(first.length, name).toBeGreaterThan(100);
    }
  });

  it('convert_eventParity_defaultProjectAndAllWave5Templates_withinOneTick', () => {
    const names = ['default-app', 'default-empty', 'sample-song', ...allInputNames().filter((n) => n.startsWith('template-'))];
    expect(names.filter((n) => n.startsWith('template-'))).toHaveLength(8);
    let total = 0;
    for (const name of names) {
      expectFixtureParity(name);
      total += goldenOf(name).eventCount;
    }
    expect(total).toBeGreaterThan(1000); // the golden files really contain music (not an empty comparison)
  });

  it('convert_bpmAndMeter_becomeSingleTempoAndSignatureEvents_lengthBeatsMatches', () => {
    const six = convertOk('meter-6-8-bpm90').project;
    expect(six.bpm).toBe(90);
    expect(six.timeSignature).toEqual([6, 8]);
    expect(six.lengthBars).toBe(4);
    expect(six.lengthBeats).toBe(12); // 4 bars * 6 * (4/8)
    expect(six.tempoMap).toHaveLength(1);
    expect(six.tempoMap[0]).toMatchObject({ beat: 0, bpm: 90 });
    expect(six.timeSignatureMap).toHaveLength(1);
    expect(six.timeSignatureMap[0]).toMatchObject({ beat: 0, numerator: 6, denominator: 8 });
    expectFixtureParity('meter-6-8-bpm90');

    const four = convertOk('default-empty').project;
    expect(four.lengthBeats).toBe(four.lengthBars * 4);
    expect(four.tempoMap).toEqual([expect.objectContaining({ beat: 0, bpm: four.bpm })]);
    expect(four.timeSignatureMap).toEqual([expect.objectContaining({ beat: 0, numerator: 4, denominator: 4 })]);
  });

  it('convert_roles_chordsBassMelody_mapToLearningRoles_duplicatesBecomeGeneral_drumsBecomeGeneral', () => {
    const result = convertOk('roles');
    const role = (id: string) => trackOf(result.project, id).role;
    expect(role('t-chords-1')).toBe('learning.chords');
    expect(role('t-chords-2')).toBe('general');
    expect(role('t-bass')).toBe('learning.bass');
    expect(role('t-melody-1')).toBe('learning.melody');
    expect(role('t-melody-2')).toBe('general');
    expect(role('t-drums')).toBe('general');
    expect(role('t-plain')).toBe('general');
    expect(role('master')).toBe('general');
    const demoted = reportItems(result, 'duplicate-role-demoted');
    expect(demoted.map((i) => i.trackId).sort()).toEqual(['t-chords-2', 't-melody-2']);
    expect(demoted.every((i) => i.severity === 'changed')).toBe(true);
  });

  it('convert_volumeLane_valueIsFaderTimesLane', () => {
    const { project } = convertOk('lane-volume');
    expect(project.automationLanes).toHaveLength(1);
    const lane = laneOf(project, 'track-volume', 't-a');
    expect(lane.bypassed).toBe(false);
    expect(lane.points.map((p) => [p.beat, p.value])).toEqual([[0, 0.5], [4, 0.25], [8, 0.125]]); // fader 0.5 * (1, 0.5, 0.25)
    expect(lane.points.every((p) => p.interpolation === 'linear')).toBe(true);
    expect(trackOf(project, 't-a').volume).toBe(0.5);
    expect(project.automationReadState).toEqual({ globalEnabled: true, disabledTrackIds: [] });
  });

  it('convert_panLane_valueIsPanPlusLaneClamped_withPointsAtSaturation', () => {
    const { project } = convertOk('lane-pan');
    const rows = (id: string) => laneOf(project, 'track-pan', id).points.map((p) => [p.beat, p.value]);
    // pan 0.5, lane 0 -> 1: sum 0.5 -> 1.5 reaches +1 halfway (beat 2), then stays at +1.
    expect(rows('t-up')).toEqual([[0, 0.5], [2, 1], [4, 1]]);
    // pan -0.25, lane 0 -> -1: sum -0.25 -> -1.25 reaches -1 at three quarters (beat 3).
    expect(rows('t-down')).toEqual([[0, -0.25], [3, -1], [4, -1]]);
    // pan 0.25, lane 0 -> 0.5: sum stays inside, no extra point.
    expect(rows('t-inside')).toEqual([[0, 0.25], [4, 0.75]]);
    expect(trackOf(project, 't-up').pan).toBe(0.5);
  });

  it('convert_cutoffLane_valueIsLog2', () => {
    const { project } = convertOk('lane-cutoff');
    const lane = laneOf(project, 'track-filter-cutoff', 't-a');
    expect(lane.points.map((p) => p.beat)).toEqual([0, 4, 8, 12, 16]);
    const values = lane.points.map((p) => p.value);
    expect(values[0]).toBeCloseTo(0, 12); // x1
    expect(values[1]).toBeCloseTo(1, 12); // x2
    expect(values[2]).toBeCloseTo(-1, 12); // x0.5
    expect(values[3]).toBeCloseTo(MAX_FILTER_CUTOFF_OCTAVES, 12); // x10
    expect(values[4]).toBeCloseTo(-MAX_FILTER_CUTOFF_OCTAVES, 12); // x0.1
    for (const v of values) expect(Math.abs(v)).toBeLessThanOrEqual(MAX_FILTER_CUTOFF_OCTAVES); // the validator is exact at the bound
  });

  it('convert_equalBeatPoints_keepOnlyLastPoint_curveMatchesWave5', () => {
    // wave5 evaluates a beat shared by several points with the LAST one, and the segment before it already runs toward that value.
    const result = convertOk('lane-equal-beats');
    const points = laneOf(result.project, 'track-volume', 't-a').points;
    expect(points.map((p) => [p.beat, p.value])).toEqual([[0, 1], [4, 0.25], [8, 0.25]]);
    const dropped = reportItems(result, 'automation-point-dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ trackId: 't-a', severity: 'info', detail: { parameter: 'volume', count: 1 } });
    expectLaneParity('lane-equal-beats', result.project); // 0.625 at beat 2, ~0.2502 at beat 3.999 like wave5
  });

  it('convert_lanes_curveSamplesMatchWave5', () => {
    const names = allLaneGoldenNames();
    expect(names).toEqual(expect.arrayContaining(['lane-volume', 'lane-pan', 'lane-cutoff', 'lane-equal-beats', 'lane-first-point-late', 'lanes-unplayable', 'realistic-song']));
    for (const name of names) expectLaneParity(name, convertOk(name).project);
    // before its first point wave5 holds the first value; main would use the fader (or 0 for cutoff), so a point at beat 0 is added
    const late = convertOk('lane-first-point-late').project;
    expect(laneOf(late, 'track-volume', 't-a').points.map((p) => [p.beat, p.value])).toEqual([[0, 0.25], [2, 0.25], [6, 0.5]]);
    expect(laneOf(late, 'track-pan', 't-a').points.map((p) => [p.beat, p.value])).toEqual([[0, 0.75], [3, 0.75]]);
    expect(laneOf(late, 'track-filter-cutoff', 't-a').points.map((p) => [p.beat, p.value])).toEqual([[0, 1], [4, 1], [8, 0]]);
  });

  it('convert_masterAndUnplayableLanes_areDropped', () => {
    const result = convertOk('lanes-unplayable');
    const kept = result.project.automationLanes.map((l) => `${l.target.trackId}|${l.target.type}`).sort();
    expect(kept).toEqual(['r-bus|track-pan', 'r-bus|track-volume', 't-d|track-volume']); // bus volume/pan and drum volume stay
    const dropped = reportItems(result, 'automation-lane-dropped').map((i) => `${i.trackId}|${i.detail?.parameter}|${i.severity}`).sort();
    expect(dropped).toEqual([
      'master|cutoff|dropped', 'master|pan|dropped', 'master|volume|dropped', 'r-bus|cutoff|dropped', 't-d|cutoff|dropped',
    ]);
  });

  it('convert_sends_becomePostFaderAudioSends_busRoutedToMaster', () => {
    const result = convertOk('sends');
    const { project } = result;
    const sends = project.audioRouting.sends.map((s) => [s.sourceTrackId, s.targetBusId, s.position, s.gain, s.enabled]);
    expect(sends).toEqual([
      ['t-piano', 'r-reverb', 'post-fader', 0.5, true],
      ['t-piano', 'r-delay', 'post-fader', 0.25, true],
      ['t-bass', 'r-reverb', 'post-fader', 0.75, true],
      ['t-drums', 'r-delay', 'post-fader', 1, true],
    ]);
    const outputs = project.audioRouting.outputs.map((o) => [o.sourceTrackId, o.destination.type]).sort();
    expect(outputs).toEqual([
      ['r-delay', 'master'], ['r-reverb', 'master'], ['t-bass', 'master'], ['t-drums', 'master'], ['t-piano', 'master'],
    ]);
    expect(project.tracks.filter((t) => t.type === 'bus').map((t) => t.id)).toEqual(['r-reverb', 'r-delay']);
    expect(project.tracks.some((t) => 'sends' in t)).toBe(false);
    const dropped = reportItems(result, 'send-dropped'); // the send to the missing return; the level-0 send is silent
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ trackId: 't-bass', severity: 'dropped' });
    expect(dropped[0]!.detail).toMatchObject({ targetId: 'r-missing' });
  });

  it('convert_returnReverb_staysWet_sendLevelKept', () => {
    // Made by wave5's own addReverbReturn (reverb { mix: 1 }) and setTrackSend(0.5).
    const result = convertOk('return-reverb');
    const bus = result.project.tracks.find((t) => t.type === 'bus')!;
    expect(bus.effects).toHaveLength(1);
    expect(bus.effects[0]).toMatchObject({ type: 'reverb', enabled: true });
    expect(Object.keys(bus.effects[0]!.params).sort()).toEqual(['decay', 'wet']);
    expect(bus.effects[0]!.params.wet).toBe(1); // NOT passed through dry
    expect(bus.effects[0]!.params.decay).toBeCloseTo(0.43859649122807015, 12);
    const melody = result.project.tracks.find((t) => t.role === 'learning.melody')!;
    expect(result.project.audioRouting.sends).toEqual([
      expect.objectContaining({ sourceTrackId: melody.id, targetBusId: bus.id, position: 'post-fader', gain: 0.5, enabled: true }),
    ]);
    expect(reportItems(result, 'effects-approximated')).toHaveLength(1);
    expectFixtureParity('return-reverb');
  });

  it('convert_effects_mapToMainParams_physicalValuesMatch_orderFollowsWave5', () => {
    // wave5 defaults (createDefaultEffectConfig) of all five types, eq +6 / 0 / -3 dB, saved as filter, delay, reverb, eq, compressor.
    const mixed = convertOk('mixer-effects');
    const a = trackOf(mixed.project, 't-a');
    expect(a.effects.map((e) => e.type)).toEqual(['eq', 'compressor', 'filter', 'delay', 'reverb']); // an enabled eq/compressor sorts the chain
    expect(a.effects.every((e) => e.enabled)).toBe(true);
    const filter = effectOf(mixed.project, 't-a', 'fx-filter').params;
    expect(Object.keys(filter).sort()).toEqual(['cutoff', 'resonance']);
    expect(filter.cutoff).toBeCloseTo(0.5876422822, 9);
    expect(filter.resonance).toBeCloseTo(0.0280898876, 9);
    expect(cutoffToFrequency(filter.cutoff!, 48000)).toBeCloseTo(1800, 6); // the physical value wave5 plays
    expect(resonanceToQ(filter.resonance!)).toBeCloseTo(0.7, 9);
    const delay = effectOf(mixed.project, 't-a', 'fx-delay').params;
    expect(Object.keys(delay).sort()).toEqual(['delayTime', 'feedback', 'mix']);
    expect(delay.delayTime).toBeCloseTo(0.3150684932, 9);
    expect(delay.feedback).toBeCloseTo(0.3294117647, 9);
    expect(delay.mix).toBe(0.32);
    expect(delayTimeToSeconds(delay.delayTime!)).toBeCloseTo(0.25, 9);
    const reverb = effectOf(mixed.project, 't-a', 'fx-reverb').params;
    expect(Object.keys(reverb).sort()).toEqual(['decay', 'wet']);
    expect(reverb.wet).toBe(0.25);
    expect(reverb.decay).toBeCloseTo(0.4385964912, 9);
    expect(decayToSeconds(reverb.decay!)).toBeCloseTo(1.4, 9);
    const eq = effectOf(mixed.project, 't-a', 'fx-eq').params;
    expect(Object.keys(eq).sort()).toEqual(['highGain', 'lowGain', 'midGain']);
    expect([eq.lowGain, eq.midGain, eq.highGain]).toEqual([0.75, 0.5, 0.375]);
    expect([eqGainToDb(eq.lowGain!), eqGainToDb(eq.midGain!), eqGainToDb(eq.highGain!)]).toEqual([6, 0, -3]);
    const comp = effectOf(mixed.project, 't-a', 'fx-compressor').params;
    expect(Object.keys(comp).sort()).toEqual(['attack', 'ratio', 'release', 'threshold']);
    expect(comp.threshold).toBeCloseTo(0.5714285714, 9);
    expect(comp.ratio).toBeCloseTo(0.1818181818, 9);
    expect(comp.attack).toBeCloseTo(0.0909090909, 9);
    expect(comp.release).toBeCloseTo(0.2, 9);
    expect(reportItems(mixed, 'effect-adjusted')).toHaveLength(0);
    expect(reportItems(mixed, 'effect-dropped')).toHaveLength(0);
    expect(reportItems(mixed, 'effects-approximated')).toEqual([expect.objectContaining({ severity: 'changed' })]);
    expect((mixed.report as Array<{ code: string }>).some((i) => i.code === 'effect-disabled')).toBe(false);

    // order: eq enabled -> sorted; eq disabled -> saved order kept; `enabled` is carried over as it is
    const on = convertOk('effects-order-eq-enabled').project;
    expect(trackOf(on, 't-a').effects.map((e) => e.id)).toEqual(['fx-eq', 'fx-filter', 'fx-reverb']);
    const off = convertOk('effects-order-eq-disabled').project;
    expect(trackOf(off, 't-a').effects.map((e) => [e.id, e.enabled])).toEqual([['fx-reverb', true], ['fx-filter', true], ['fx-eq', false]]);

    // values main cannot hold, and a type main does not have
    const adjusted = convertOk('effects-adjusted');
    const effects = trackOf(adjusted.project, 't-a').effects;
    expect(effects.map((e) => e.id)).toEqual(['fx-filter', 'fx-delay']); // chorus removed
    expect(effectOf(adjusted.project, 't-a', 'fx-filter').params).toEqual({ cutoff: 0, resonance: 0 }); // 0.7 Hz -> 80 Hz, Q 0.15 -> 0.2
    const slow = effectOf(adjusted.project, 't-a', 'fx-delay').params;
    expect(slow.delayTime).toBeCloseTo(0.6575342466, 9); // 1.0 s is halved to 0.5 s
    expect(slow.feedback).toBeCloseTo(0.3294117647, 9);
    expect(slow.mix).toBe(0.32);
    expect(reportItems(adjusted, 'effect-adjusted').map((i) => [i.trackId, i.effectId, i.severity]).sort()).toEqual([
      ['t-a', 'fx-delay', 'changed'], ['t-a', 'fx-filter', 'changed'],
    ]);
    expect(reportItems(adjusted, 'effect-dropped')).toEqual([expect.objectContaining({ trackId: 't-a', effectId: 'fx-chorus', severity: 'dropped' })]);
    expect(reportItems(adjusted, 'effect-disabled' as never)).toHaveLength(0);
    expectFixtureParity('effects-adjusted');
  });

  it('convert_loopWithoutContentLength_becomesLoopFalse', () => {
    const result = convertOk('loop-no-content-length');
    const clip = clipOf(result.project, 'c-a');
    expect(clip.loop).toBe(false);
    expect(noteRows(clip)).toEqual([[0, 1, 60, 100], [1, 1, 62, 100]]);
    expect(reportItems(result, 'loop-unrolled')).toHaveLength(0);
    expect(goldenOf('loop-no-content-length').eventCount).toBe(2); // wave5 played exactly one pass
    expectFixtureParity('loop-no-content-length'); // main must not repeat it
  });

  it('convert_loopWithContentLength_isUnrolled_eventParity', () => {
    // Clip 2..10 (length 8), period 3, notes n1(0,1) n2(1,2.5) n3(2.5,1) n4(3.5,1: starts after the period, never sounded).
    const melodic = convertOk('loop-content-length');
    const clip = clipOf(melodic.project, 'c-a');
    expect(clip.loop).toBe(false);
    expect('contentLengthBeats' in clip).toBe(false);
    expect(clip.startBeat).toBe(2);
    expect(clip.lengthBeats).toBe(8);
    expect(noteRows(clip)).toEqual([
      [0, 1, 60, 100], [1, 2, 62, 100], [2.5, 0.5, 64, 100], // pass 0: n2 and n3 cut at the period end (3)
      [3, 1, 60, 100], [4, 2, 62, 100], [5.5, 0.5, 64, 100], // pass 1
      [6, 1, 60, 100], [7, 1, 62, 100], // pass 2: n2 cut at the clip end (8); n3 would start at 8.5 and is dropped
    ]);
    expect(clip.notes!.slice(0, 3).map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(reportItems(melodic, 'loop-unrolled')).toEqual([expect.objectContaining({ clipId: 'c-a', severity: 'changed' })]);
    expect(reportItems(melodic, 'loop-unrolled')[0]!.detail).toMatchObject({ passes: 3 });
    // n4 never sounded in any pass: counted once; the pass-end truncation of n3 (8.5) is not "hidden"
    expect(reportItems(melodic, 'hidden-events-dropped')).toEqual([
      expect.objectContaining({ clipId: 'c-a', severity: 'dropped', detail: expect.objectContaining({ count: 1 }) }),
    ]);
    expectFixtureParity('loop-content-length');

    // Drum clip 0..8, period 2 beats = 8 steps (16 steps per bar), hits kick0 snare4 openHat5 closedHat6 perc10 (perc is after the period).
    const drums = convertOk('loop-drum-content-length');
    const drumClip = clipOf(drums.project, 'c-d');
    expect(drumClip.loop).toBe(false);
    expect('contentLengthBeats' in drumClip).toBe(false);
    expect(drumRows(drumClip)).toEqual([
      [0, 'kick'], [5, 'openHat'], [4, 'snare'], [6, 'closedHat'],
      [8, 'kick'], [13, 'openHat'], [12, 'snare'], [14, 'closedHat'],
      [16, 'kick'], [21, 'openHat'], [20, 'snare'], [22, 'closedHat'],
      [24, 'kick'], [29, 'openHat'], [28, 'snare'], [30, 'closedHat'],
    ].sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as string).localeCompare(b[1] as string)));
    expect(reportItems(drums, 'drum-loop-snapped')).toHaveLength(0); // 2 beats is a whole number of steps
    expect(reportItems(drums, 'hidden-events-dropped')).toEqual([expect.objectContaining({ clipId: 'c-d', detail: expect.objectContaining({ count: 1 }) })]);
    expectFixtureParity('loop-drum-content-length'); // includes the open hat choked by the next closed hat
  });

  it('convert_swingLoop_cutNotesEndAtPassEnd_eventParity', () => {
    // swing 50: the note at 1.75 (odd 16th) starts at 1.875 = 900 ticks; the pass ends at 2.0 = 960 ticks. Stored length = 2.0 - 1.875, not 2.0 - 1.75.
    const result = convertOk('swing-loop-cut');
    expect(noteRows(clipOf(result.project, 'c-a'))).toEqual([
      [1.75, 0.125, 60, 100], [3.75, 0.125, 60, 100], [5.75, 0.125, 60, 100], [7.75, 0.125, 60, 100],
    ]);
    expect(goldenOf('swing-loop-cut').events.map((e) => [e.startTick, e.endTick])).toEqual([[900, 960], [1860, 1920], [2820, 2880], [3780, 3840]]);
    expectFixtureParity('swing-loop-cut');
  });

  it('convert_linkChain_sameTrackSameType_becomesOneHopAlias', () => {
    const result = convertOk('link-chain');
    const a = clipOf(result.project, 'c-a');
    const b = clipOf(result.project, 'c-b');
    const c = clipOf(result.project, 'c-c');
    expect(a.aliasOf).toBeUndefined();
    expect(noteRows(a)).toEqual([[0, 1, 60, 100], [2, 1, 64, 100]]);
    expect(b.aliasOf).toBe('c-a');
    expect(c.aliasOf).toBe('c-a'); // c linked b which linked a: rewired to the root, one hop
    for (const linked of [b, c]) {
      expect(linked.notes ?? []).toHaveLength(0);
      expect(linked.drumEvents ?? []).toHaveLength(0);
    }
    expect([b.startBeat, c.startBeat, b.lengthBeats, c.lengthBeats]).toEqual([4, 8, 4, 4]);
    expect(reportItems(result, 'link-materialized')).toHaveLength(0);
    expectFixtureParity('link-chain'); // 6 events
  });

  it('convert_linkAcrossTracks_isMaterializedCopy', () => {
    const cross = convertOk('link-cross-track');
    const x = clipOf(cross.project, 'c-x');
    const a = clipOf(cross.project, 'c-a');
    expect(x.aliasOf).toBeUndefined();
    expect(noteRows(x)).toEqual(noteRows(a));
    expect(noteRows(x)).toEqual([[0, 1, 60, 100], [2, 1, 64, 100]]);
    const xIds = x.notes!.map((n) => n.id);
    expect(xIds.some((id) => a.notes!.some((n) => n.id === id))).toBe(false); // fresh ids, not shared with the source
    expect(reportItems(cross, 'link-materialized')).toEqual([
      expect.objectContaining({ clipId: 'c-x', severity: 'changed', detail: expect.objectContaining({ reason: 'cross-track' }) }),
    ]);
    expectFixtureParity('link-cross-track');

    // Same track and type but a shorter link: main requires equal length, so it is copied too (trimmed to the link's 2 beats).
    const short = convertOk('link-length-mismatch');
    const y = clipOf(short.project, 'c-y');
    expect(y.aliasOf).toBeUndefined();
    expect(noteRows(y)).toEqual([[0, 1, 60, 100], [1.5, 0.5, 62, 100]]); // n2 cut at 2, n3 (start 3) dropped
    expect(reportItems(short, 'link-materialized')).toEqual([
      expect.objectContaining({ clipId: 'c-y', detail: expect.objectContaining({ reason: 'length-mismatch' }) }),
    ]);
    expect(reportItems(short, 'hidden-events-dropped')).toHaveLength(0); // truncation inside a materialized copy is not counted
    expectFixtureParity('link-length-mismatch');

    // A link LONGER than its source (4 vs 2): the content is not repeated.
    const long = convertOk('link-longer');
    const longLink = clipOf(long.project, 'c-y');
    expect(longLink.aliasOf).toBeUndefined();
    expect(longLink.lengthBeats).toBe(4);
    expect(noteRows(longLink)).toEqual([[0, 1, 60, 100], [1, 0.5, 62, 100]]);
    expect(reportItems(long, 'link-materialized')).toEqual([expect.objectContaining({ detail: expect.objectContaining({ reason: 'length-mismatch' }) })]);
    expectFixtureParity('link-longer');
  });

  it('convert_brokenOrCyclicLink_isDetached_keepsOwnContent_andReported', () => {
    // Rule 0: wave5's load detaches these links. Silent clips keep their frame; a link that owns content keeps the content.
    const result = convertOk('link-broken-cyclic');
    const silent = ['c-missing', 'c-type', 'c-cyc1', 'c-cyc2', 'c-self'];
    const input = (inputOf('link-broken-cyclic').tracks as Json[]).flatMap((t) => t.clips as Json[]);
    for (const id of silent) {
      const clip = clipOf(result.project, id);
      const original = input.find((c) => c.id === id)!;
      expect(clip.aliasOf, id).toBeUndefined();
      expect(clip.loop, id).toBe(false);
      expect(clip.notes ?? [], id).toHaveLength(0);
      expect(clip.drumEvents ?? [], id).toHaveLength(0);
      expect([clip.type, clip.trackId, clip.startBeat, clip.lengthBeats], id).toEqual([original.type, original.trackId, original.startBeat, original.lengthBeats]);
    }
    const owns = clipOf(result.project, 'c-owns');
    expect(owns.aliasOf).toBeUndefined();
    expect(noteRows(owns)).toEqual([[0, 1, 67, 100]]);
    expect(noteRows(clipOf(result.project, 'c-ok'))).toEqual([[0, 1, 60, 100]]);
    const broken = Object.fromEntries(reportItems(result, 'link-broken').map((i) => [i.clipId, [i.detail?.reason, i.severity]]));
    expect(broken).toEqual({ 'c-missing': ['missing', 'info'], 'c-type': ['type-mismatch', 'info'], 'c-owns': ['owns-content', 'info'] });
    expect(reportItems(result, 'link-cyclic').map((i) => [i.clipId, i.severity]).sort()).toEqual([['c-cyc1', 'info'], ['c-cyc2', 'info'], ['c-self', 'info']]);
    expect(goldenOf('link-broken-cyclic').eventCount).toBe(3); // c-ok, c-owns and the kick of c-dr
    expectFixtureParity('link-broken-cyclic');
  });

  it('convert_swing_copied_drumClipsHaveNoOwnSwing', () => {
    const { project } = convertOk('swing');
    expect(project.swing).toBe(35);
    expect(project.hiHatChoke).toBe(true);
    const drumClips = project.tracks.filter((t) => t.type === 'drum').flatMap((t) => t.clips);
    expect(drumClips.length).toBeGreaterThan(0);
    for (const clip of drumClips) expect(clip.drumGroove, clip.id).toBeUndefined();
    expectFixtureParity('swing'); // wave5 delays only on-grid odd 16ths; the triplet note stays put
    const straight = convertOk('default-empty').project;
    expect(straight.swing).toBe(0);
    expect(straight.hiHatChoke).toBe(true);
  });

  it('convert_macros_moveToInstrumentParams', () => {
    const { project } = convertOk('macros');
    const withMacros = trackOf(project, 't-a').instrument!;
    expect(withMacros.params).toEqual({
      gain: 0.5, macroBrightness: 0.75, macroRelease: 0.25, macroWidth: 0.5, macroAttack: 1,
    });
    expect('macros' in withMacros).toBe(false);
    expect(withMacros.preset).toBe('warmPad');
    const without = trackOf(project, 't-b').instrument!;
    expect(Object.keys(without.params ?? {}).filter((k) => k.startsWith('macro'))).toEqual([]);
  });

  it('convert_loopRange_legacyBarLimit_legacyClipSettings_dropped_andReported', () => {
    const result = convertOk('legacy-fields');
    const keys = allKeys(result.project);
    for (const gone of ['legacyBarLimit', 'loopRange', 'legacyClipSettings']) expect(keys.has(gone), gone).toBe(false);
    expect(result.project.lengthBars).toBe(80);
    expect(result.project.lengthBeats).toBe(320);
    expect(reportItems(result, 'legacy-bar-limit-dropped')).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(reportItems(result, 'loop-range-dropped')).toEqual([expect.objectContaining({ severity: 'dropped' })]);
    expect(reportItems(result, 'legacy-clip-settings-dropped')).toEqual([
      expect.objectContaining({ clipId: 'c-a', severity: 'info' }),
    ]);
    // Project-level items come before clip-level items.
    const order = result.report.map((i) => i.code);
    expect(order.indexOf('legacy-clip-settings-dropped')).toBeGreaterThan(order.indexOf('loop-range-dropped'));
    expect(order.indexOf('legacy-clip-settings-dropped')).toBeGreaterThan(order.indexOf('legacy-bar-limit-dropped'));
  });

  it('convert_overLimit_stepsPerBarAbove128_orEventsOverBudget_failsWithReason_noPartialOutput', () => {
    expect(goldenOf('over-limit-events').eventCount).toBe(24576); // wave5 accepted it (limit 100000); main must refuse it
    for (const name of ['over-limit-steps', 'over-limit-events']) {
      const result = convertWave5Project(inputOf(name));
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.code, name).toBe('over-limit');
      expect(result.reason.length, name).toBeGreaterThan(0);
      expect(/[぀-ヿ一-鿿]/.test(result.reason), `${name}: reason is Japanese`).toBe(true);
      expect('project' in result, `${name}: no partial output`).toBe(false);
      expect('report' in result, `${name}: no partial report`).toBe(false);
    }
  });

  it('convert_overLimit_density_failsWithReason', () => {
    // 300 notes inside 0.3 beat: far below 20000 in total, but buildScheduleEvents refuses more than 256 per 0.75 beat.
    expect(goldenOf('over-limit-density').eventCount).toBe(300);
    const result = convertWave5Project(inputOf('over-limit-density'));
    expect(result).toMatchObject({ ok: false, code: 'over-limit' });
    if (!result.ok) {
      expect(/[぀-ヿ一-鿿]/.test(result.reason)).toBe(true);
      expect('project' in result).toBe(false);
    }
  });

  it('convert_audioClips_becomeUnresolvedAssets', () => {
    const result = convertOk('audio-clips');
    const { project } = result;
    expect(project.audioAssets).toHaveLength(3);
    const [wa, wb, missing] = project.audioAssets;
    expect(wa).toMatchObject({ availability: 'unresolved', legacyAssetId: 'wave-a', reason: 'legacy-reference' });
    expect(wb).toMatchObject({ availability: 'unresolved', legacyAssetId: 'wave-b', reason: 'legacy-reference' });
    expect(missing).toMatchObject({ availability: 'unresolved', reason: 'missing-reference' });
    expect('legacyAssetId' in missing!).toBe(false);
    const clipAsset = (id: string) => clipOf(project, id).audioAssetId;
    expect(clipAsset('c-au1')).toBe(wa!.id);
    expect(clipAsset('c-au2')).toBe(wa!.id); // same legacy id, one asset
    expect(clipAsset('c-au3')).toBe(wb!.id);
    expect(clipAsset('c-au4')).toBe(missing!.id);
    for (const id of ['c-au1', 'c-au2', 'c-au3', 'c-au4']) {
      expect(clipOf(project, id)).toMatchObject({ type: 'audio', sourceStartFrame: 0, sourceFrameCount: 0, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0 });
    }
    expect(reportItems(result, 'audio-clip-unresolved').map((i) => i.clipId)).toEqual(['c-au1', 'c-au2', 'c-au3', 'c-au4']);
  });

  it('convert_contentPastClipOrSongEnd_isTrimmed_andReported', () => {
    // lengthBars 4 = 16 beats. c-b 12..20 is cut to 12..16 (n4 at beat 17 and the part of n3 after 16 go); c-c 20..24 is removed.
    const ended = convertOk('song-end');
    const a = trackOf(ended.project, 't-a');
    expect(a.clips.map((c) => c.id)).toEqual(['c-a', 'c-b']);
    expect(a.clips[1]).toMatchObject({ startBeat: 12, lengthBeats: 4 });
    expect(noteRows(a.clips[1]!)).toEqual([[0, 1, 62, 100], [3.5, 0.5, 64, 100]]);
    expect(ended.project.lengthBars).toBe(4);
    expect(ended.project.chordTrack.map((c) => [c.id, c.startBeat, c.durationBeats])).toEqual([['ch1', 0, 4], ['ch2', 14, 2]]); // ch3 starts after the end
    expect(ended.project.sections.map((s) => [s.id, s.startBar, s.lengthBars])).toEqual([['s1', 0, 2], ['s2', 3, 1]]); // s3 starts after the end
    expect(reportItems(ended, 'song-end-trimmed')).toEqual([
      expect.objectContaining({ severity: 'dropped', detail: { clips: 2, chords: 2, sections: 2 } }),
    ]);
    expectFixtureParity('song-end');

    // lengthBars 80 with no legacyBarLimit: wave5 loads 64 bars; the note at beat 290 never sounds.
    const long = convertOk('song-length-80');
    expect(long.project.lengthBars).toBe(64);
    expect(long.project.lengthBeats).toBe(256);
    expect(clipOf(long.project, 'c-a').lengthBeats).toBe(256);
    expect(noteRows(clipOf(long.project, 'c-a'))).toEqual([[10, 1, 60, 100]]);
    expect(reportItems(long, 'song-end-trimmed')).toEqual([expect.objectContaining({ detail: { clips: 1, chords: 0, sections: 0 } })]);
    expect(reportItems(long, 'legacy-bar-limit-dropped')).toHaveLength(0);
    expectFixtureParity('song-length-80');
  });

  it('convert_overlappingClips_splitLikeWave5Load_eventParity', () => {
    const result = convertOk('overlap-clips');
    expect(result.project.tracks.map((t) => t.id)).toEqual(['t-a', 't-a-overlap-1', 't-b', 'master']);
    const layer = trackOf(result.project, 't-a-overlap-1');
    expect([layer.name, layer.type, layer.role]).toEqual(['Piano', 'instrument', 'general']);
    expect(trackOf(result.project, 't-a').clips.map((c) => c.id)).toEqual(['c-a']);
    expect(layer.clips.map((c) => [c.id, c.trackId])).toEqual([['c-b', 't-a-overlap-1']]);
    expect(result.project.audioRouting.outputs.map((o) => o.sourceTrackId).sort()).toEqual(['t-a', 't-a-overlap-1', 't-b']);
    expect(reportItems(result, 'overlap-split')).toEqual([
      expect.objectContaining({ trackId: 't-a', severity: 'changed', detail: expect.objectContaining({ layers: 1 }) }),
    ]);
    expect(uniqueStrings(allIds(result.project))).toBe(true);
    expectFixtureParity('overlap-clips');
  });

  it('convert_realisticSong_eventParity_lanes_decode', () => {
    // Built only with wave5's own edit functions and written by serializeProject: swing 25, a looping clip with a link and a copy, macros,
    // an open hat at the end of drum clip 1 choked by a closed hat at the start of clip 2, a reverb return with two sends, five effects, three lanes.
    const result = convertOk('realistic-song');
    expect(result.project.swing).toBe(25);
    expectFixtureParity('realistic-song');
    expectLaneParity('realistic-song', result.project);
    expect(decodeProject(result.project).ok).toBe(true);
    expect(result.project.audioRouting.sends).toHaveLength(2);
    expect(reportItems(result, 'effects-approximated')).toHaveLength(1);
    expect(reportItems(result, 'loop-unrolled').length).toBeGreaterThanOrEqual(1);
    expect(goldenOf('realistic-song').eventCount).toBeGreaterThan(100);
  });

  it('convert_sameLaneSameStepHits_areMerged_keepHighestVelocity_andCounted', () => {
    // kick step 0 x2 (100, 80) -> 1 hit (100); closedHat step 2 x3 (60, 110, 70) -> 1 hit (110); snare step 4 stays (90). 6 hits -> 3, so 3 disappeared.
    const result = convertOk('drum-same-step-hits');
    const clip = clipOf(result.project, 'c-d');
    expect(drumRows(clip)).toEqual([[0, 'kick'], [2, 'closedHat'], [4, 'snare']]);
    const velocity = (lane: string) => clip.drumEvents!.find((d) => d.lane === lane)!.velocity;
    expect([velocity('kick'), velocity('closedHat'), velocity('snare')]).toEqual([100, 110, 90]);
    expect(reportItems(result, 'drum-hits-merged')).toEqual([
      expect.objectContaining({ clipId: 'c-d', severity: 'dropped', detail: { count: 3 } }),
    ]);
    expect(reportItems(result, 'hidden-events-dropped')).toHaveLength(0); // wave5 DID play all six
    const golden = goldenOf('drum-same-step-hits');
    expect(golden.eventCount).toBe(6);
    expectEventParity('drum-same-step-hits', mergeSameStepDrumHits(golden.events), mainEventsOf(result.project));
  });

  it('convert_loopUnrollSnapCollision_mergesRepeats_andCounted', () => {
    // clip 0..2, period 0.6 beat = 2.4 steps; kick step0 (vel 100) repeats at 0, 2.4, 4.8, 7.2 -> steps 0, 2, 5, 7;
    // kick step2 (vel 120, in the period: 0.5 < 0.6) repeats at 2, 4.4, 6.8 -> steps 2, 4, 7 (the 4th pass would start after the clip end).
    // Steps 2 and 7 are hit twice -> 7 hits become 5 (2 disappeared); the merged steps keep the higher velocity 120.
    const result = convertOk('loop-drum-snap-collision');
    const clip = clipOf(result.project, 'c-d');
    expect(clip.loop).toBe(false);
    const rows = clip.drumEvents!.map((d) => [d.stepIndex, d.velocity]).sort((a, b) => a[0]! - b[0]!);
    expect(rows).toEqual([[0, 100], [2, 120], [4, 120], [5, 100], [7, 120]]);
    expect(goldenOf('loop-drum-snap-collision').eventCount).toBe(7); // wave5 plays 7 hits
    expect(reportItems(result, 'drum-loop-snapped')).toEqual([expect.objectContaining({ clipId: 'c-d' })]);
    expect(reportItems(result, 'loop-unrolled')).toHaveLength(1);
    expect(reportItems(result, 'drum-hits-merged')).toEqual([
      expect.objectContaining({ clipId: 'c-d', severity: 'dropped', detail: { count: 2 } }),
    ]);
    expect(reportItems(result, 'hidden-events-dropped')).toHaveLength(0);
  });

  it('convert_drumTypedClipWithNotesOnInstrumentTrack_becomesInstrumentClip_eventParity', () => {
    // wave5 plays the one note (pitch 60, tick 0..480) although the clip is typed 'drum'; main must play it too.
    const result = convertOk('clip-type-mismatch-played');
    const clip = clipOf(result.project, 'c-x');
    expect(clip.type).toBe('midi');
    expect(noteRows(clip)).toEqual([[0, 1, 60, 100]]);
    expect(clip.drumEvents ?? []).toHaveLength(0);
    expect(reportItems(result, 'clip-type-changed')).toEqual([
      expect.objectContaining({ clipId: 'c-x', trackId: 't-i', severity: 'changed', detail: { from: 'drum', to: 'midi' } }),
    ]);
    expect(reportItems(result, 'hidden-events-dropped')).toHaveLength(0);
    expect(goldenOf('clip-type-mismatch-played').eventCount).toBe(1);
    expectFixtureParity('clip-type-mismatch-played');
  });

  it('convert_doesNotMutateInput', () => {
    for (const name of allInputNames()) {
      const pristine = inputOf(name);
      const frozen = deepFreeze(inputOf(name));
      expect(() => convertWave5Project(frozen), name).not.toThrow();
      expect(frozen, name).toEqual(pristine);
    }
  });

  it('convert_mutatedInputs_neverThrow_andOkImpliesDecodable', () => {
    // Seeded mutants (deleted keys, wrong types, out-of-range numbers, __proto__ / constructor as keys and ids).
    let seed = 20261128;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
    const containers = (root: unknown): Array<Record<string, unknown> | unknown[]> => {
      const out: Array<Record<string, unknown> | unknown[]> = [];
      const walk = (v: unknown) => {
        if (v !== null && typeof v === 'object') {
          out.push(v as never);
          for (const child of Object.values(v as Record<string, unknown>)) walk(child);
        }
      };
      walk(root);
      return out;
    };
    const wrong: unknown[] = [null, 'x', -1, 1e308, Number.NaN, Number.POSITIVE_INFINITY, [], {}, true, 0.5, '__proto__', 'constructor'];
    const bases = ['template-8bar-pop', 'realistic-song', 'sends', 'lane-pan', 'link-broken-cyclic', 'audio-clips', 'loop-content-length', 'link-drum', 'effects-adjusted', 'song-end'];
    const prototypeKeysBefore = Object.getOwnPropertyNames(Object.prototype).sort();
    let accepted = 0;
    let total = 0;
    for (const base of bases) {
      for (let i = 0; i < 40; i++) {
        const mutant = inputOf(base);
        for (let m = 0, count = 1 + Math.floor(rand() * 3); m < count; m++) {
          const node = pick(containers(mutant));
          const keys = Object.keys(node);
          if (keys.length === 0) continue;
          const key = pick(keys);
          const mode = Math.floor(rand() * 4);
          if (mode === 0) Reflect.deleteProperty(node, key);
          else if (mode === 1) (node as Record<string, unknown>)[key] = pick(wrong);
          else if (mode === 2) Object.defineProperty(node, pick(['__proto__', 'constructor', 'prototype']), { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
          else if (typeof (node as Record<string, unknown>).id === 'string') (node as Record<string, unknown>).id = pick(['__proto__', 'constructor', 'toString', '']);
        }
        total += 1;
        let result: ReturnType<typeof convertWave5Project> | undefined;
        expect(() => { result = convertWave5Project(mutant); }, `${base}#${i}`).not.toThrow();
        if (result?.ok) {
          accepted += 1;
          expect(decodeProject(result.project).ok, `${base}#${i}: ok must decode`).toBe(true);
        } else {
          expect(['not-wave5-v3', 'invalid-project', 'over-limit']).toContain(result?.code);
        }
      }
    }
    expect(total).toBe(400);
    expect(accepted).toBeGreaterThan(0); // not everything is refused
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeKeysBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// EXTRA tests (not part of the named acceptance tests): detection, legacy-wave5-format flow, and rule edges.
// ---------------------------------------------------------------------------------------------------------------
describe('P70 extras: detection and legacy-wave5-format', () => {
  const MAIN_KEYS = ['lengthBeats', 'tempoMap', 'timeSignatureMap', 'audioAssets', 'automationLanes'] as const;
  const mainFixture = () => JSON.parse(readFileSync(new URL('../../../../packages/project-model/tests/fixtures/main/project-v3.json', import.meta.url), 'utf8'));

  it('extra_detect_fiveMainKeys_isNotWave5_zeroKeys_converts_oneToFourKeys_isInvalid', () => {
    const main = mainFixture();
    expect(detectProjectFormat(main)).toBe('main');
    expect(convertWave5Project(main)).toMatchObject({ ok: false, code: 'not-wave5-v3' });

    const wave5 = inputOf('template-8bar-pop');
    expect(detectProjectFormat(wave5)).toBe('wave5-v3');
    expect(convertWave5Project(wave5).ok).toBe(true);

    for (let count = 1; count <= 4; count++) {
      const partial = { ...wave5 } as Record<string, unknown>;
      for (const key of MAIN_KEYS.slice(0, count)) partial[key] = main[key];
      expect(detectProjectFormat(partial), `${count} keys`).toBe('invalid-project');
      const result = convertWave5Project(partial);
      expect(result, `${count} keys`).toMatchObject({ ok: false, code: 'invalid-project' });
      expect('project' in result).toBe(false);
    }
  });

  it('extra_convert_nonWave5Values_failWithNotWave5V3_andNeverThrow', () => {
    for (const value of [null, 3, 'text', [], {}, { schemaVersion: 2 }, { schemaVersion: 4 }, inputOf('template-8bar-pop').tracks]) {
      let result: ReturnType<typeof convertWave5Project> | undefined;
      expect(() => { result = convertWave5Project(value); }).not.toThrow();
      expect(result, JSON.stringify(value)?.slice(0, 40)).toMatchObject({ ok: false });
      if (result && !result.ok) expect(['not-wave5-v3', 'invalid-project']).toContain(result.code);
    }
    const base = { ...inputOf('template-8bar-pop'), tracks: 'nope' };
    expect(convertWave5Project(base)).toMatchObject({ ok: false, code: 'invalid-project' });
  });

  it('extra_legacyWave5Format_decodeRefuses_thenConvertSucceeds_forTheRepoWave5Fixtures', () => {
    for (const file of ['project-full.json', 'project-base-only.json']) {
      const text = readFileSync(new URL(`../../../../packages/project-model/tests/fixtures/wave5-v3/${file}`, import.meta.url), 'utf8');
      expect(decodeProjectJson(text)).toMatchObject({ ok: false, error: { code: 'legacy-wave5-format' } });
      const converted = convertWave5Project(JSON.parse(text));
      expect(converted.ok, file).toBe(true);
      if (converted.ok) expect(decodeProject(converted.project).ok, file).toBe(true);
    }
  });

  it('extra_report_codesAreOnlyTheDocumentedOnes_withTheDocumentedSeverity', () => {
    const SEVERITY: Record<string, string> = {
      'legacy-bar-limit-dropped': 'info', 'loop-range-dropped': 'dropped', 'legacy-clip-settings-dropped': 'info',
      'loop-unrolled': 'changed', 'drum-loop-snapped': 'changed', 'link-materialized': 'changed', 'link-broken': 'info',
      'link-cyclic': 'info', 'duplicate-role-demoted': 'changed', 'send-dropped': 'dropped',
      'automation-lane-dropped': 'dropped', 'automation-point-dropped': 'info', 'audio-clip-unresolved': 'changed',
      'chord-track-audible': 'changed', 'effects-approximated': 'changed', 'effect-adjusted': 'changed', 'effect-dropped': 'dropped',
      'hidden-events-dropped': 'dropped', 'song-end-trimmed': 'dropped', 'overlap-split': 'changed', 'drum-hits-merged': 'dropped', 'clip-type-changed': 'changed',
    };
    expect([...WAVE5_REPORT_CODES].sort()).toEqual(Object.keys(SEVERITY).sort());
    for (const name of convertibleNames()) {
      for (const item of convertOk(name).report) {
        expect(SEVERITY[item.code], `${name}: ${item.code}`).toBeDefined();
        expect(item.severity, `${name}: ${item.code}`).toBe(SEVERITY[item.code]);
      }
    }
  });
});

describe('P70 extras: rule edges', () => {
  it('extra_chordTrack_isCarriedOver_andReportedExactlyWhenMainWouldPlayIt', () => {
    const input = inputOf('template-8bar-pop');
    const result = convertOk('template-8bar-pop');
    expect(result.project.chordTrack).toEqual(input.chordTrack);
    expect(input.chordTrack.length).toBeGreaterThan(0);
    expect(reportItems(result, 'chord-track-audible')).toEqual([expect.objectContaining({ severity: 'changed' })]);
    const { id, title, key, scale, sections, createdAt, updatedAt } = input;
    expect(result.project).toMatchObject({ id, title, key, scale, sections, createdAt, updatedAt });
    // the report is exactly main's own question: does main realize chords onto the Chords track?
    let audible = 0;
    for (const name of convertibleNames()) {
      const converted = convertOk(name);
      const reported = reportItems(converted, 'chord-track-audible').length;
      expect(reported, name).toBe(countRealizedChordNotes(converted.project) > 0 ? 1 : 0);
      audible += reported;
    }
    expect(audible).toBeGreaterThanOrEqual(9); // the 8 templates and the default project at least
  });

  it('extra_equalBeatPointsAtBeatZero_dropTheEarlierPoint_andReport', () => {
    const result = convertOk('lane-equal-beats-at-zero');
    const points = laneOf(result.project, 'track-volume', 't-a').points;
    expect(points.map((p) => [p.beat, p.value])).toEqual([[0, 0.5], [4, 0.5]]); // wave5 played 0.5 from beat 0
    expect(reportItems(result, 'automation-point-dropped')).toEqual([
      expect.objectContaining({ trackId: 't-a', severity: 'info', detail: { parameter: 'volume', count: 1 } }),
    ]);
  });

  it('extra_mixerValuesSurviveConversion_andMutedTracksStayInTheSchedule', () => {
    const result = convertOk('mixer-effects');
    const a = trackOf(result.project, 't-a');
    expect([a.volume, a.pan, a.mute, a.solo, a.color]).toEqual([0.75, -0.5, true, false, '#7c9cf0']);
    const b = trackOf(result.project, 't-b');
    expect([b.volume, b.pan, b.mute, b.solo]).toEqual([1.25, 0.5, false, true]);
    expectFixtureParity('mixer-effects'); // muted tracks are still in the schedule (the scheduler applies mute)
  });

  it('extra_drumLoopWithOffGridPeriod_snapsToNearestStep_andReports', () => {
    // Clip 0..2, period 0.6 beat = 2.4 steps (0.25 beat per step): pass r moves hits by r*2.4 steps, rounded half up.
    const result = convertOk('loop-drum-offgrid-period');
    const clip = clipOf(result.project, 'c-d');
    expect(clip.loop).toBe(false);
    expect(drumRows(clip)).toEqual([[0, 'kick'], [1, 'snare'], [2, 'kick'], [3, 'snare'], [5, 'kick'], [6, 'snare'], [7, 'kick']]);
    expect(reportItems(result, 'drum-loop-snapped')).toEqual([expect.objectContaining({ clipId: 'c-d', severity: 'changed' })]);
    expect(reportItems(result, 'loop-unrolled')).toHaveLength(1);
  });

  it('extra_linkToLoopedSource_andLinkWithOwnLoop_areMaterializedFromRawContent', () => {
    const result = convertOk('link-of-looped-source');
    // c-a: clip 0..4, period 2 over n1(0,1) n2(1.5,1) n3(2.5,1: after the period, inaudible)
    expect(noteRows(clipOf(result.project, 'c-a'))).toEqual([[0, 1, 60, 100], [1.5, 0.5, 62, 100], [2, 1, 60, 100], [3.5, 0.5, 62, 100]]);
    // c-b links c-a but does not loop: wave5 plays c-a's RAW notes once, including n3.
    const b = clipOf(result.project, 'c-b');
    expect(b.aliasOf).toBeUndefined();
    expect(noteRows(b)).toEqual([[0, 1, 60, 100], [1.5, 1, 62, 100], [2.5, 1, 64, 100]]);
    // c-c links c-a and loops with period 2 itself.
    const c = clipOf(result.project, 'c-c');
    expect(c.aliasOf).toBeUndefined();
    expect(c.loop).toBe(false);
    expect(noteRows(c)).toEqual([[0, 1, 60, 100], [1.5, 0.5, 62, 100], [2, 1, 60, 100], [3.5, 0.5, 62, 100]]);
    const reasons = Object.fromEntries(reportItems(result, 'link-materialized').map((i) => [i.clipId, i.detail?.reason]));
    expect(reasons).toEqual({ 'c-b': 'source-unrolled', 'c-c': 'own-loop' });
    expect(reportItems(result, 'loop-unrolled').map((i) => i.clipId).sort()).toEqual(['c-a', 'c-c']);
    expect(reportItems(result, 'hidden-events-dropped')).toEqual([expect.objectContaining({ clipId: 'c-a', detail: expect.objectContaining({ count: 1 }) })]);
    expectFixtureParity('link-of-looped-source'); // 11 events
  });

  it('extra_drumLinks_followTheSourceStepsPerBar', () => {
    const result = convertOk('link-drum');
    const src = clipOf(result.project, 'c-src');
    const alias = clipOf(result.project, 'c-alias');
    const copy = clipOf(result.project, 'c-x');
    expect(src.stepsPerBar).toBe(12);
    expect(alias.aliasOf).toBe('c-src');
    expect(alias.stepsPerBar).toBeUndefined(); // an alias cannot carry its own; wave5 used the source's 12 too
    expect(copy.aliasOf).toBeUndefined();
    expect(copy.stepsPerBar).toBe(12); // the copy takes the SOURCE's steps per bar, not its own 16
    expect(drumRows(copy)).toEqual(drumRows(src));
    expect(drumRows(src)).toEqual([[0, 'kick'], [3, 'snare'], [6, 'closedHat'], [9, 'openHat'], [11, 'perc']]);
    expect(reportItems(result, 'link-materialized')).toEqual([expect.objectContaining({ clipId: 'c-x', detail: expect.objectContaining({ reason: 'cross-track' }) })]);
    expectFixtureParity('link-drum'); // 15 events
  });

  it('extra_drumClipWithoutStepsPerBar_in34_isRead_as16', () => {
    const result = convertOk('drum-no-steps-3-4');
    expect(clipOf(result.project, 'c-d').stepsPerBar ?? 16).toBe(16);
    expectFixtureParity('drum-no-steps-3-4'); // step 15 lands at 2.8125 beats
  });

  it('extra_loopFalseWithContentLength_playsOnce_andDropsTheField', () => {
    const result = convertOk('loop-false-with-content-length');
    const clip = clipOf(result.project, 'c-a');
    expect(clip.loop).toBe(false);
    expect('contentLengthBeats' in clip).toBe(false);
    expect(noteRows(clip)).toEqual([[0, 1, 60, 100], [3, 1, 62, 100], [6, 1, 64, 100]]); // wave5 plays all three
    expect(reportItems(result, 'loop-unrolled')).toHaveLength(0);
    expect(reportItems(result, 'hidden-events-dropped')).toHaveLength(0);
    expectFixtureParity('loop-false-with-content-length');
  });

  it('extra_contentWave5NeverPlayed_onTheWrongTrackType_isDroppedAndCounted', () => {
    const result = convertOk('type-mismatch-content');
    expect(clipOf(result.project, 'c-dn').notes ?? []).toHaveLength(0);
    expect(clipOf(result.project, 'c-id').drumEvents ?? []).toHaveLength(0);
    expect(reportItems(result, 'hidden-events-dropped').map((i) => [i.clipId, i.detail?.count, i.severity]).sort()).toEqual([
      ['c-dn', 2, 'dropped'], ['c-id', 2, 'dropped'],
    ]);
    expect(goldenOf('type-mismatch-content').eventCount).toBe(0);
    expect(reportItems(result, 'clip-type-changed')).toHaveLength(0); // wave5 played nothing here, so nothing is converted (rule 24)
    expectFixtureParity('type-mismatch-content'); // main plays notes on ANY track, so they must really be gone
  });

  it('extra_eventsExactlyAtBudget_isAccepted_andOneMoreIsRefused', () => {
    const wave5With = (count: number): Json => {
      const input = inputOf('default-empty');
      input.lengthBars = 50;
      for (const track of input.tracks as Json[]) for (const clip of track.clips as Json[]) clip.lengthBeats = 200;
      const melody = (input.tracks as Json[]).find((t) => t.role === 'melody')!;
      melody.clips[0].notes = Array.from({ length: count }, (_, k) => ({ id: `n${k}`, pitch: 40 + (k % 48), startBeat: k * 0.0099, durationBeats: 0.005, velocity: 100 }));
      return input;
    };
    // guard: main's own threshold
    const mainProject = (count: number) => {
      const project: Json = createEmptyProject({ lengthBars: 50 });
      const melody = project.tracks.find((t: Json) => t.name === 'Melody');
      melody.clips[0].lengthBeats = 200;
      melody.clips[0].notes = wave5With(count).tracks.find((t: Json) => t.role === 'melody').clips[0].notes;
      return project as never;
    };
    expect(() => buildScheduleEvents(mainProject(20000))).not.toThrow();
    expect(() => buildScheduleEvents(mainProject(20001))).toThrow();
    const ok = convertWave5Project(wave5With(20000));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(() => buildScheduleEvents(ok.project)).not.toThrow();
    expect(convertWave5Project(wave5With(20001))).toMatchObject({ ok: false, code: 'over-limit' });
  });

  it('extra_stepsPerBar_exactly128_isAccepted', () => {
    const input = inputOf('over-limit-steps');
    input.tracks.find((t: Json) => t.type === 'drum').clips[0].stepsPerBar = 128;
    const result = convertWave5Project(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(decodeProject(result.project).ok).toBe(true);
  });

  it('extra_parityHelperIsStrict_aShiftedEventFails', () => {
    // Guards the comparison itself: a 2-tick shift or a changed velocity must NOT pass.
    const golden = goldenOf('link-chain').events;
    const shifted = mainEventsOf(convertOk('link-chain').project).map((e, i) => (i === 0 ? { ...e, startTick: e.startTick + 2 } : e));
    expect(() => expectEventParity('shift', golden, shifted)).toThrow();
    const louder = mainEventsOf(convertOk('link-chain').project).map((e, i) => (i === 0 ? { ...e, velocity: e.velocity + 1 } : e));
    expect(() => expectEventParity('velocity', golden, louder)).toThrow();
  });
});
