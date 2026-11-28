// P70 acceptance tests (import UI: detection -> offer -> report in beginner Japanese). Written BEFORE the implementation; do not edit.
//
// CONTRACT. Module apps/studio/src/features/export/wave5Import.ts (pure, synchronous, never throws, touches no store / storage):
//
//   planProjectJsonImport(text: string): Wave5ImportPlan
//     - decodeProjectJson(text) ok                                   -> { kind: 'open', project }   (project = the decoded project)
//     - fails with 'legacy-wave5-format' (detectProjectFormat = 'wave5-v3')
//                                                                    -> { kind: 'offer-conversion', code: 'legacy-wave5-format',
//                                                                         message: string, convert: () => Wave5ImportConversion }
//         message: beginner Japanese that OFFERS conversion (contains '変換'); it is NOT the old "cannot open" message.
//     - any other failure                                            -> { kind: 'error', code: <the decode error code>, message }
//         message: 'future-schema-version' keeps the existing text 'このファイルは新しいアプリ版で作成されています。アプリを更新してください。';
//         every other code keeps 'プロジェクトファイルを安全に検証できませんでした。' (1..4 main keys = 'invalid-project').
//   Wave5ImportConversion = { ok: true, project, report, lines: Wave5ReportLine[] } | { ok: false, code, message }
//     convert() runs convertWave5Project(JSON.parse(text)); on ok `project` / `report` are exactly its project / report and
//     lines = describeWave5Report(report, project); on failure code is the converter's code and message = its reason (Japanese).
//   describeWave5Report(report, project): Wave5ReportLine[]   with Wave5ReportLine = { code, severity, text }
//     One line per report item, same order, same code and severity. text is beginner Japanese: contains Japanese characters, names the
//     affected track by its NAME in `project` (for a clip item: the name of the track holding the clip, and where the clip starts as
//     "<bar>小節目" and "<beat>拍目" with bar = floor(startBeat / beatsPerBar) + 1 and beat = floor(startBeat % beatsPerBar) + 1, beatsPerBar
//     from project.timeSignature), and never shows raw ids or developer words (aliasOf, wave5, schema, JSON, legacy, automation, loopRange,
//     contentLengthBeats, undefined, null, NaN).
//   The import entry ExportMenuContent.tsx must use planProjectJsonImport and render Wave5ImportDialog (see p70-import-dialog.test.tsx)
//     instead of the old error toast for 'legacy-wave5-format'.
//
// DESKTOP (native open) must reach the same dialog. Today Rust rejects a wave5 file with LegacyWave5Format before any bytes reach the UI.
//   - Rust (native_files_p70_tests.rs): open_selected_file(FileFormat::Project, Some(path)) on a wave5 v3 file (schemaVersion 3, none of the five main keys)
//     returns an envelope whose FIRST BYTE is 2 (new tag "legacy wave5"; 0 = cancelled, 1 = opened), then the SAME layout as tag 1: u32 LE file-name length,
//     the file name, the file's bytes UNCHANGED. It validates/stores nothing as a main project and never writes anything. Anything that is neither a main
//     project nor a wave5 v3 file (1..4 main keys, broken JSON, ...) is still rejected exactly as before. Only FileFormat::Project may produce tag 2.
//   - TS: decodeNativeOpenEnvelope(envelope, 'project') -> { status: 'opened', fileName, bytes, legacyWave5: true } for tag 2 (tag-1 results have no `legacyWave5`);
//     tag 2 with any other format is NativeFileGatewayError('invalid-envelope').
//   - planProjectJsonImport also accepts { bytes: Uint8Array, legacyWave5?: boolean } (what the native open returns). Bytes are decoded as UTF-8 (invalid ->
//     { kind: 'error', code: 'invalid-json' }) and handled exactly like the text. The marker is never trusted on its own: marker true on bytes that are not a
//     wave5 v3 file -> { kind: 'error', code: 'invalid-project' }. ExportMenuContent.openNativeProjectFile passes the marker through (it mentions `legacyWave5`).
import { readFileSync } from 'node:fs';
import { decodeProject, decodeProjectJson, LEGACY_WAVE5_FORMAT_MESSAGE } from '@cts/project-model';
import { decodeNativeOpenEnvelope, NativeFileGatewayError } from '../../src/platform/nativeFileGateway';
import { describe, expect, it } from 'vitest';
import { describeWave5Report, planProjectJsonImport } from '../../src/features/export/wave5Import';
import { FIXTURE_DIR, clipOf, convertOk, inputOf } from './p70-helpers';

const JAPANESE = /[぀-ヿ一-鿿]/;
const DEV_WORDS = ['aliasOf', 'wave5', 'Wave5', 'schema', 'JSON', 'legacy', 'automation', 'loopRange', 'contentLengthBeats', 'undefined', 'null', 'NaN', 'エイリアス', 'スキーマ', 'レガシー', '実体化', 'マテリアライズ'];
const text = (name: string) => readFileSync(`${FIXTURE_DIR}inputs/${name}.json`, 'utf8');
const mainV3Text = () => readFileSync(new URL('../../../../packages/project-model/tests/fixtures/main/project-v3.json', import.meta.url), 'utf8');

describe('P70 import UI: plan', () => {
  it('ui_wave5File_isOfferedConversion_notRefused', () => {
    expect(decodeProjectJson(text('template-8bar-pop'))).toMatchObject({ ok: false, error: { code: 'legacy-wave5-format' } });
    const plan = planProjectJsonImport(text('template-8bar-pop'));
    expect(plan.kind).toBe('offer-conversion');
    if (plan.kind !== 'offer-conversion') return;
    expect(plan.code).toBe('legacy-wave5-format');
    expect(JAPANESE.test(plan.message)).toBe(true);
    expect(plan.message).toContain('変換');
    expect(plan.message).not.toBe(LEGACY_WAVE5_FORMAT_MESSAGE);
    expect(typeof plan.convert).toBe('function');
  });

  it('ui_convert_returnsTheConverterProject_andBeginnerLines', () => {
    const plan = planProjectJsonImport(text('roles'));
    if (plan.kind !== 'offer-conversion') throw new Error('expected an offer');
    const done = plan.convert();
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const direct = convertOk('roles');
    expect(done.project).toEqual(direct.project);
    expect(done.report).toEqual(direct.report);
    expect(decodeProject(done.project).ok).toBe(true);
    expect(done.lines.map((l) => [l.code, l.severity])).toEqual(direct.report.map((i) => [i.code, i.severity]));
  });

  it('ui_convert_failure_returnsJapaneseMessage_andNoProject', () => {
    const plan = planProjectJsonImport(text('over-limit-steps'));
    if (plan.kind !== 'offer-conversion') throw new Error('expected an offer');
    const done = plan.convert();
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.code).toBe('over-limit');
    expect(JAPANESE.test(done.message)).toBe(true);
    expect('project' in done).toBe(false);
  });

  it('ui_mainFile_opensDirectly', () => {
    const plan = planProjectJsonImport(mainV3Text());
    const decoded = decodeProjectJson(mainV3Text());
    expect(plan.kind).toBe('open');
    if (plan.kind === 'open' && decoded.ok) expect(plan.project).toEqual(decoded.project);
  });

  it('ui_otherFailures_keepTheirExistingMessages', () => {
    const wave5 = inputOf('template-8bar-pop');
    const partial = { ...wave5, lengthBeats: 32 }; // 1 of the 5 main keys
    expect(planProjectJsonImport(JSON.stringify(partial))).toMatchObject({
      kind: 'error', code: 'invalid-project', message: 'プロジェクトファイルを安全に検証できませんでした。',
    });
    expect(planProjectJsonImport('{ not json')).toMatchObject({
      kind: 'error', code: 'invalid-json', message: 'プロジェクトファイルを安全に検証できませんでした。',
    });
    expect(planProjectJsonImport('{"schemaVersion":999}')).toMatchObject({
      kind: 'error', code: 'future-schema-version',
      message: 'このファイルは新しいアプリ版で作成されています。アプリを更新してください。',
    });
  });
});

describe('P70 import UI: report lines', () => {
  const cases: Array<[string, string, string]> = [
    // fixture, report code, track NAME that the line must show ('' = project-level item, no track)
    ['roles', 'duplicate-role-demoted', 'Pad B'],
    ['effects-adjusted', 'effect-adjusted', 'Piano'],
    ['effects-adjusted', 'effect-dropped', 'Piano'],
    ['mixer-effects', 'effects-approximated', ''],
    ['link-cross-track', 'link-materialized', 'Strings'],
    ['loop-content-length', 'loop-unrolled', 'Lead'],
    ['loop-content-length', 'hidden-events-dropped', 'Lead'],
    ['audio-clips', 'audio-clip-unresolved', 'Audio'],
    ['sends', 'send-dropped', 'Bass'],
    ['song-end', 'song-end-trimmed', ''],
    ['drum-same-step-hits', 'drum-hits-merged', 'Drums'],
    ['clip-type-mismatch-played', 'clip-type-changed', 'Piano'],
    ['overlap-clips', 'overlap-split', 'Piano'],
    ['link-broken-cyclic', 'link-broken', 'A'],
    ['lanes-unplayable', 'automation-lane-dropped', 'Drums'],
    ['template-8bar-pop', 'chord-track-audible', ''],
  ];

  it('ui_reportLines_areBeginnerJapanese_withTrackNames_andNoRawIdsOrDeveloperWords', () => {
    for (const [fixture, code, trackName] of cases) {
      const result = convertOk(fixture);
      const lines = describeWave5Report(result.report, result.project);
      expect(lines, fixture).toHaveLength(result.report.length);
      lines.forEach((line, i) => {
        const item = result.report[i]!;
        expect([line.code, line.severity], fixture).toEqual([item.code, item.severity]);
        expect(JAPANESE.test(line.text), `${fixture}/${line.code}: Japanese`).toBe(true);
        for (const word of DEV_WORDS) expect(line.text.includes(word), `${fixture}/${line.code}: "${word}"`).toBe(false);
        for (const id of [item.trackId, item.clipId, item.effectId]) {
          if (id) expect(line.text.includes(id), `${fixture}/${line.code}: raw id ${id}`).toBe(false);
        }
        if (item.clipId) {
          const clip = clipOf(result.project, item.clipId);
          const [num, den] = result.project.timeSignature;
          const bpb = num * (4 / den);
          expect(line.text, `${fixture}/${line.code}: bar`).toContain(`${Math.floor(clip.startBeat / bpb) + 1}小節目`);
          expect(line.text, `${fixture}/${line.code}: beat`).toContain(`${Math.floor(clip.startBeat % bpb) + 1}拍目`);
        }
      });
      const shown = lines.filter((l) => l.code === code);
      expect(shown.length, `${fixture}: ${code}`).toBeGreaterThan(0);
      if (trackName) expect(shown.some((l) => l.text.includes(trackName)), `${fixture}/${code}: names track ${trackName}`).toBe(true);
      // the chord-track line must tell how to silence the chords (the new sound is the reader's decision)
      if (code === 'chord-track-audible') expect(shown[0]!.text, 'chord-track-audible: how to silence').toContain('ミュート');
    }
  });

  it('ui_reportLines_distinctItemsGetDistinctText', () => {
    const result = convertOk('link-broken-cyclic');
    const lines = describeWave5Report(result.report, result.project);
    expect(lines.length).toBe(6); // 3 detached links (missing / type mismatch / owns content) + 3 cyclic
    expect(new Set(lines.map((l) => l.text)).size).toBe(lines.length);
    expect(lines.filter((l) => l.code === 'link-cyclic')).toHaveLength(3);
    expect(lines.filter((l) => l.code === 'link-broken')).toHaveLength(3);
  });

  it('ui_emptyReport_givesNoLines', () => {
    const result = convertOk('lane-volume');
    expect(result.report).toEqual([]);
    expect(describeWave5Report(result.report, result.project)).toEqual([]);
  });
});

describe('P70 import UI: wiring', () => {
  it('extra_exportMenuUsesThePlanAndTheDialog_forProjectJsonImport', () => {
    // A structural guard (the menu pulls in the whole store, so it is not rendered here).
    const source = readFileSync(new URL('../../src/features/export/ExportMenuContent.tsx', import.meta.url), 'utf8');
    expect(source).toContain('planProjectJsonImport');
    expect(source).toContain('Wave5ImportDialog');
  });
});

describe('P70 import UI: desktop (native open) reaches the same dialog', () => {
  const envelope = (tag: number, fileName: string, bytes: Uint8Array): Uint8Array => {
    const name = new TextEncoder().encode(fileName);
    const out = new Uint8Array(5 + name.length + bytes.length);
    out[0] = tag;
    new DataView(out.buffer).setUint32(1, name.length, true);
    out.set(name, 5);
    out.set(bytes, 5 + name.length);
    return out;
  };
  const bytesOf = (name: string) => new TextEncoder().encode(text(name));

  it('ui_nativeEnvelopeTag2_decodesToOpenedWithLegacyWave5Marker', () => {
    const bytes = bytesOf('template-8bar-pop');
    const opened = decodeNativeOpenEnvelope(envelope(2, 'old-song.ctsproj.json', bytes), 'project');
    expect(opened).toMatchObject({ status: 'opened', fileName: 'old-song.ctsproj.json', legacyWave5: true });
    if (opened.status === 'opened') expect(Array.from(opened.bytes)).toEqual(Array.from(bytes));

    const main = decodeNativeOpenEnvelope(envelope(1, 'song.ctsproj.json', new TextEncoder().encode(mainV3Text())), 'project');
    expect(main.status).toBe('opened');
    expect('legacyWave5' in main).toBe(false);

    expect(() => decodeNativeOpenEnvelope(envelope(2, 'piece.mid', bytes), 'midi')).toThrow(NativeFileGatewayError);
  });

  it('ui_planFromNativeBytesWithMarker_offersConversion_andConverts', () => {
    const plan = planProjectJsonImport({ bytes: bytesOf('roles'), legacyWave5: true });
    expect(plan.kind).toBe('offer-conversion');
    if (plan.kind !== 'offer-conversion') return;
    expect(plan.code).toBe('legacy-wave5-format');
    expect(plan.message).toContain('変換');
    const done = plan.convert();
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.project).toEqual(convertOk('roles').project);
    // the same bytes without the marker lead to the same offer (the text path)
    expect(planProjectJsonImport({ bytes: bytesOf('roles') }).kind).toBe('offer-conversion');
  });

  it('ui_planFromNativeBytes_neverTrustsTheMarkerAlone', () => {
    const mainBytes = new TextEncoder().encode(mainV3Text());
    expect(planProjectJsonImport({ bytes: mainBytes, legacyWave5: true })).toMatchObject({ kind: 'error', code: 'invalid-project' });
    expect(planProjectJsonImport({ bytes: mainBytes }).kind).toBe('open');
    expect(planProjectJsonImport({ bytes: new Uint8Array([0xff, 0xfe, 0x00]), legacyWave5: true })).toMatchObject({ kind: 'error', code: 'invalid-json' });
    const partial = new TextEncoder().encode(JSON.stringify({ ...inputOf('roles'), lengthBeats: 32 }));
    expect(planProjectJsonImport({ bytes: partial, legacyWave5: true })).toMatchObject({ kind: 'error', code: 'invalid-project' });
  });

  it('extra_nativeOpenPassesTheMarkerThrough', () => {
    const source = readFileSync(new URL('../../src/features/export/ExportMenuContent.tsx', import.meta.url), 'utf8');
    expect(source).toContain('legacyWave5');
  });
});
