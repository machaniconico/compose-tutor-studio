use super::*;
use crate::native_persistence::models::LegacyDiagnosticDto;
use serde::Deserialize;
use serde_json::json;
use std::{
    fs,
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

const CREATED_AT: &str = "2026-07-10T00:00:00.000Z";
const ERASE_ID_A: &str = "erase-12345678-1234-4abc-8def-1234567890ab";
const ERASE_ID_B: &str = "erase-abcdef01-2345-4abc-9def-1234567890ab";

#[test]
fn drum_step_projector_reuses_compiled_thresholds_for_large_maps() {
    let mut beat = 0.0;
    let signature_map: Vec<TimeSignatureMapEventDto> = (0..1_024)
        .map(|index| {
            let numerator = if index % 2 == 0 { 4 } else { 3 };
            let event = TimeSignatureMapEventDto {
                id: format!("signature-{index}"),
                beat,
                numerator,
                denominator: 4,
            };
            beat += numerator as f64;
            event
        })
        .collect();
    let projector = DrumStepTimelineProjector::compile(16, 0.0, &signature_map)
        .expect("valid signature map compiles");

    assert_eq!(projector.segments.len(), signature_map.len());
    for step in [0, 15, 16, 31, 4_095, 19_999] {
        assert_eq!(
            projector.project(step),
            drum_step_to_beat_on_timeline(step, 16, 0.0, &signature_map),
        );
    }
    let projected: Vec<f64> = (0..20_000)
        .map(|step| projector.project(step).expect("step projects"))
        .collect();
    assert_eq!(projected.len(), 20_000);
    assert!(projected.windows(2).all(|pair| pair[0] < pair[1]));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyParityCorpus {
    version: u64,
    created_at: String,
    cases: Vec<LegacyParityCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyParityCase {
    name: String,
    project_id: String,
    storage_entries: Vec<LegacyParityEntry>,
    expected: LegacyParityExpected,
    expected_imports: Vec<LegacyParityImport>,
    expected_completion: LegacyParityCompletion,
}

#[derive(Deserialize)]
struct LegacyParityEntry {
    key: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyParityExpected {
    status: String,
    canonical_project_json: Option<String>,
    error_code: Option<UnreadableProjectErrorCode>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum LegacyParityImport {
    Head {
        project_json: String,
    },
    Diagnostic {
        error_code: UnreadableProjectErrorCode,
    },
    Branch {
        project_json: String,
        source: ProjectBranchSource,
        activation_id: String,
        revision: u64,
        write_id: String,
        saved_at: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyParityCompletion {
    ready_project_count: u64,
    unreadable_project_count: u64,
    branch_count: u64,
}

fn project_json(project_id: &str, title: &str, revision: u64) -> String {
    serde_json::to_string(&json!({
        "id": project_id,
        "schemaVersion": 1,
        "title": title,
        "bpm": 120,
        "timeSignature": [4, 4],
        "key": "C",
        "scale": "major",
        "lengthBars": 8,
        "tracks": [],
        "chordTrack": [],
        "sections": [],
        "createdAt": CREATED_AT,
        "updatedAt": format!("2026-07-10T00:00:{revision:02}.000Z"),
    }))
    .expect("fixture serialization must succeed")
}

fn schema_v3_project_value() -> Value {
    json!({
        "id": "schema-v3-project",
        "schemaVersion": 3,
        "title": "Schema v3",
        "bpm": 120,
        "timeSignature": [3, 4],
        "key": "C",
        "scale": "major",
        "lengthBars": 2,
        "lengthBeats": 7,
        "tempoMap": [
            { "id": "tempo-1", "beat": 0, "bpm": 120 },
            { "id": "tempo-2", "beat": 3, "bpm": 90 }
        ],
        "timeSignatureMap": [
            { "id": "signature-1", "beat": 0, "numerator": 3, "denominator": 4 },
            { "id": "signature-2", "beat": 3, "numerator": 4, "denominator": 4 }
        ],
        "audioAssets": [{
            "id": "asset-ready",
            "availability": "ready",
            "checksumSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "originalName": "recording.wav",
            "mediaType": "audio/wav",
            "byteLength": 4096,
            "sampleRate": 48000,
            "channelCount": 2,
            "frameCount": 2000
        }],
        "automationLanes": [{
            "id": "automation-volume",
            "target": { "type": "track-volume", "trackId": "track-audio" },
            "points": [
                { "id": "automation-point-1", "beat": 1, "value": 1, "interpolation": "hold" },
                { "id": "automation-point-2", "beat": 7, "value": 0.5, "interpolation": "linear" }
            ]
        }],
        "tracks": [
            {
                "id": "track-chords",
                "name": "Chords",
                "type": "instrument",
                "role": "learning.chords",
                "clips": [],
                "volume": 1,
                "pan": 0,
                "mute": false,
                "solo": false,
                "effects": []
            },
            {
                "id": "track-audio",
                "name": "Recording",
                "type": "audio",
                "role": "general",
                "clips": [{
                    "id": "clip-audio",
                    "trackId": "track-audio",
                    "type": "audio",
                    "startBeat": 0,
                    "lengthBeats": 7,
                    "loop": false,
                    "audioAssetId": "asset-ready",
                    "sourceStartFrame": 500,
                    "sourceFrameCount": 1000,
                    "fadeInFrames": 100,
                    "fadeOutFrames": 100,
                    "gainDb": -3
                }],
                "volume": 1,
                "pan": 0,
                "mute": false,
                "solo": false,
                "effects": []
            },
            {
                "id": "track-master",
                "name": "Master",
                "type": "master",
                "role": "general",
                "clips": [],
                "volume": 1,
                "pan": 0,
                "mute": false,
                "solo": false,
                "effects": []
            }
        ],
        "chordTrack": [],
        "sections": [],
        "createdAt": CREATED_AT,
        "updatedAt": CREATED_AT
    })
}

fn schema_v3_project_json() -> String {
    serde_json::to_string(&schema_v3_project_value()).expect("schema-v3 fixture serializes")
}

fn linked_clip_project(schema_version: u64, alias_has_payload: bool) -> Vec<u8> {
    let alias_notes = if alias_has_payload {
        json!([{
            "id": "legacy-alias-note",
            "pitch": 64,
            "startBeat": 0,
            "durationBeats": 1,
            "velocity": 90
        }])
    } else {
        serde_json::Value::Null
    };
    let mut alias = json!({
        "id": "clip-alias",
        "trackId": "track-a",
        "type": "midi",
        "startBeat": 4,
        "lengthBeats": 4,
        "loop": false,
        "aliasOf": "clip-source"
    });
    if !alias_notes.is_null() {
        alias["notes"] = alias_notes;
    }
    serde_json::to_vec(&json!({
        "id": "linked-project",
        "schemaVersion": schema_version,
        "title": "Linked",
        "bpm": 120,
        "timeSignature": [4, 4],
        "key": "C",
        "scale": "major",
        "lengthBars": 2,
        "tracks": [{
            "id": "track-a",
            "name": "Lead",
            "type": "instrument",
            "clips": [{
                "id": "clip-source",
                "trackId": "track-a",
                "type": "midi",
                "startBeat": 0,
                "lengthBeats": 4,
                "loop": false,
                "notes": [{
                    "id": "source-note",
                    "pitch": 60,
                    "startBeat": 0,
                    "durationBeats": 1,
                    "velocity": 100
                }]
            }, alias],
            "volume": 1,
            "pan": 0,
            "mute": false,
            "solo": false,
            "effects": []
        }],
        "chordTrack": [],
        "sections": [],
        "createdAt": CREATED_AT,
        "updatedAt": CREATED_AT
    }))
    .expect("linked fixture serialization must succeed")
}

fn mutated_schema_v2_linked_project(mutate: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut project: Value = serde_json::from_slice(&linked_clip_project(2, false))
        .expect("schema-v2 linked fixture must parse");
    mutate(&mut project);
    serde_json::to_vec(&project).expect("mutated linked fixture must serialize")
}

fn linked_source_mut(project: &mut Value) -> &mut serde_json::Map<String, Value> {
    project
        .pointer_mut("/tracks/0/clips/0")
        .and_then(Value::as_object_mut)
        .expect("linked source fixture must exist")
}

fn linked_alias_mut(project: &mut Value) -> &mut serde_json::Map<String, Value> {
    project
        .pointer_mut("/tracks/0/clips/1")
        .and_then(Value::as_object_mut)
        .expect("linked alias fixture must exist")
}

fn convert_linked_fixture_to_drum(project: &mut Value) {
    {
        let source = linked_source_mut(project);
        source.insert("type".to_owned(), json!("drum"));
        source.remove("notes");
        source.insert("drumEvents".to_owned(), json!([]));
        source.insert("stepsPerBar".to_owned(), json!(16));
    }
    linked_alias_mut(project).insert("type".to_owned(), json!("drum"));
}

fn linked_amplification_project(notes_per_source: usize, instance_count: usize) -> Vec<u8> {
    let notes = (0..notes_per_source)
        .map(|index| {
            json!({
                "id": format!("amplified-note-{index}"),
                "pitch": 60,
                "startBeat": 0,
                "durationBeats": 1,
                "velocity": 90
            })
        })
        .collect::<Vec<_>>();
    let mut clips = vec![json!({
        "id": "amplified-source",
        "trackId": "amplified-track",
        "type": "midi",
        "startBeat": 0,
        "lengthBeats": 4,
        "loop": false,
        "notes": notes
    })];
    clips.extend((1..instance_count).map(|index| {
        json!({
            "id": format!("amplified-alias-{index}"),
            "trackId": "amplified-track",
            "type": "midi",
            "startBeat": 0,
            "lengthBeats": 4,
            "loop": false,
            "aliasOf": "amplified-source"
        })
    }));
    serde_json::to_vec(&json!({
        "id": "amplified-project",
        "schemaVersion": 2,
        "title": "Amplified",
        "bpm": 120,
        "timeSignature": [4, 4],
        "key": "C",
        "scale": "major",
        "lengthBars": 1,
        "tracks": [{
            "id": "amplified-track",
            "name": "Lead",
            "type": "instrument",
            "clips": clips,
            "volume": 1,
            "pan": 0,
            "mute": false,
            "solo": false,
            "effects": []
        }],
        "chordTrack": [],
        "sections": [],
        "createdAt": CREATED_AT,
        "updatedAt": CREATED_AT
    }))
    .expect("amplification fixture serialization must succeed")
}

fn large_non_aliased_v1_project() -> Vec<u8> {
    let clips = (0..6)
        .map(|clip_index| {
            let notes = (0..17_000)
                .map(|note_index| {
                    json!({
                        "id": format!("legacy-large-note-{clip_index}-{note_index}"),
                        "pitch": 60,
                        "startBeat": 0,
                        "durationBeats": 1,
                        "velocity": 90
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": format!("legacy-large-clip-{clip_index}"),
                "trackId": "legacy-large-track",
                "type": "midi",
                "startBeat": 0,
                "lengthBeats": 4,
                "loop": false,
                "notes": notes
            })
        })
        .collect::<Vec<_>>();
    let chords = (0..4_096)
        .map(|index| {
            json!({
                "id": format!("legacy-empty-chord-{index}"),
                "startBeat": 0,
                "durationBeats": 1,
                "symbol": "C",
                "root": "C",
                "quality": "major",
                "notes": []
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_vec(&json!({
        "id": "legacy-large-project",
        "schemaVersion": 1,
        "title": "Legacy large",
        "bpm": 120,
        "timeSignature": [4, 4],
        "key": "C",
        "scale": "major",
        "lengthBars": 1,
        "tracks": [{
            "id": "legacy-large-track",
            "name": "Lead",
            "type": "instrument",
            "clips": clips,
            "volume": 1,
            "pan": 0,
            "mute": false,
            "solo": false,
            "effects": []
        }],
        "chordTrack": chords,
        "sections": [],
        "createdAt": CREATED_AT,
        "updatedAt": CREATED_AT
    }))
    .expect("large legacy fixture serialization must succeed")
}

#[test]
fn native_project_validation_accepts_schema_v3_and_keeps_versions_strict() {
    let fixture = schema_v3_project_value();
    assert!(validate_project_file_json(
        &serde_json::to_vec(&fixture).unwrap()
    ));

    let mut end_events_and_empty_lane = fixture.clone();
    end_events_and_empty_lane["tempoMap"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "tempo-at-end", "beat": 7, "bpm": 80 }));
    end_events_and_empty_lane["timeSignatureMap"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "signature-at-end",
            "beat": 7,
            "numerator": 4,
            "denominator": 4
        }));
    end_events_and_empty_lane["automationLanes"][0]["points"] = json!([]);
    assert!(
        validate_project_file_json(&serde_json::to_vec(&end_events_and_empty_lane).unwrap()),
        "map events at the project end and empty automation lanes are valid"
    );

    let mut active_signature_drums = fixture.clone();
    active_signature_drums["timeSignature"] = json!([4, 4]);
    active_signature_drums["timeSignatureMap"] = json!([
        { "id": "signature-1", "beat": 0, "numerator": 4, "denominator": 4 },
        { "id": "signature-2", "beat": 4, "numerator": 3, "denominator": 4 }
    ]);
    active_signature_drums["tracks"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "track-drums",
            "name": "Drums",
            "type": "drum",
            "role": "general",
            "clips": [{
                "id": "clip-drums",
                "trackId": "track-drums",
                "type": "drum",
                "startBeat": 4,
                "lengthBeats": 3,
                "loop": false,
                "stepsPerBar": 16,
                "drumEvents": [{
                    "id": "drum-at-active-signature",
                    "lane": "kick",
                    "stepIndex": 15,
                    "velocity": 100
                }]
            }],
            "volume": 1,
            "pan": 0,
            "mute": false,
            "solo": false,
            "effects": []
        }));
    assert!(
        validate_project_file_json(&serde_json::to_vec(&active_signature_drums).unwrap()),
        "drum step ranges use the time signature active at the clip start"
    );

    let mut variable_signature_drums = fixture.clone();
    variable_signature_drums["timeSignature"] = json!([4, 4]);
    variable_signature_drums["timeSignatureMap"] = json!([
        { "id": "signature-1", "beat": 0, "numerator": 4, "denominator": 4 },
        { "id": "signature-2", "beat": 4, "numerator": 3, "denominator": 4 }
    ]);
    variable_signature_drums["tracks"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "track-variable-drums",
            "name": "Variable Drums",
            "type": "drum",
            "role": "general",
            "clips": [{
                "id": "clip-variable-drums",
                "trackId": "track-variable-drums",
                "type": "drum",
                "startBeat": 0,
                "lengthBeats": 7,
                "loop": false,
                "stepsPerBar": 16,
                "drumEvents": [{
                    "id": "drum-after-signature-change",
                    "lane": "kick",
                    "stepIndex": 31,
                    "velocity": 100
                }]
            }],
            "volume": 1,
            "pan": 0,
            "mute": false,
            "solo": false,
            "effects": []
        }));
    assert!(
        validate_project_file_json(&serde_json::to_vec(&variable_signature_drums).unwrap()),
        "drum steps re-evaluate the signature at each clip-local bar start"
    );

    for (name, mut project) in [
        ("v3 fields on v2", fixture.clone()),
        ("missing required root field", fixture.clone()),
        ("missing required track role", fixture.clone()),
        ("explicit null required field", fixture.clone()),
    ] {
        match name {
            "v3 fields on v2" => project["schemaVersion"] = json!(2),
            "missing required root field" => {
                project.as_object_mut().unwrap().remove("tempoMap");
            }
            "missing required track role" => {
                project["tracks"][0].as_object_mut().unwrap().remove("role");
            }
            "explicit null required field" => project["audioAssets"] = Value::Null,
            _ => unreachable!(),
        }
        assert!(
            !validate_project_file_json(&serde_json::to_vec(&project).unwrap()),
            "must reject {name}"
        );
    }

    let mut v2 = serde_json::from_str::<Value>(&project_json("legacy-v2", "Legacy", 1)).unwrap();
    v2["schemaVersion"] = json!(2);
    assert!(validate_project_file_json(
        &serde_json::to_vec(&v2).unwrap()
    ));
    v2["timeSignature"] = json!([3, 4]);
    v2["lengthBars"] = json!(2);
    v2["tracks"] = json!([{
        "id": "legacy-drum-track",
        "name": "Legacy Drums",
        "type": "drum",
        "clips": [{
            "id": "legacy-drum-clip",
            "trackId": "legacy-drum-track",
            "type": "drum",
            "startBeat": 3,
            "lengthBeats": 3,
            "loop": false,
            "stepsPerBar": 16,
            "drumEvents": [{
                "id": "legacy-drum-hit",
                "lane": "kick",
                "stepIndex": 15,
                "velocity": 100
            }]
        }],
        "volume": 1,
        "pan": 0,
        "mute": false,
        "solo": false,
        "effects": []
    }]);
    assert!(
        validate_project_file_json(&serde_json::to_vec(&v2).unwrap()),
        "schema v2 drums keep fixed-signature step projection"
    );
    v2["tracks"][0]["clips"][0]["drumEvents"][0]["stepIndex"] = json!(16);
    assert!(
        !validate_project_file_json(&serde_json::to_vec(&v2).unwrap()),
        "schema v2 fixed-signature projection still rejects the first out-of-range step"
    );
    v2["tracks"] = json!([{
        "id": "legacy-track",
        "name": "Legacy",
        "type": "instrument",
        "role": "general",
        "clips": [],
        "volume": 1,
        "pan": 0,
        "mute": false,
        "solo": false,
        "effects": []
    }]);
    assert!(!validate_project_file_json(
        &serde_json::to_vec(&v2).unwrap()
    ));
}

#[test]
fn native_project_validation_rejects_schema_v3_semantic_matrix() {
    type MutationCase = (&'static str, fn(&mut Value));
    let cases: Vec<MutationCase> = vec![
        ("tempo scalar mirror mismatch", |project: &mut Value| {
            project["bpm"] = json!(121)
        }),
        (
            "signature change off bar boundary",
            |project: &mut Value| project["timeSignatureMap"][1]["beat"] = json!(2),
        ),
        ("derived bar count mismatch", |project: &mut Value| {
            project["lengthBars"] = json!(3)
        }),
        ("duplicate global id", |project: &mut Value| {
            project["tempoMap"][0]["id"] = json!("track-audio")
        }),
        ("duplicate learning role", |project: &mut Value| {
            project["tracks"][1]["type"] = json!("instrument");
            project["tracks"][1]["role"] = json!("learning.chords");
        }),
        ("invalid ready checksum", |project: &mut Value| {
            project["audioAssets"][0]["checksumSha256"] = json!("A".repeat(64))
        }),
        ("audio source outside asset", |project: &mut Value| {
            project["tracks"][1]["clips"][0]["sourceFrameCount"] = json!(2000)
        }),
        ("ready audio on non-audio track", |project: &mut Value| {
            project["tracks"][1]["type"] = json!("instrument")
        }),
        ("missing automation target", |project: &mut Value| {
            project["automationLanes"][0]["target"]["trackId"] = json!("missing")
        }),
        ("master pan automation", |project: &mut Value| {
            project["automationLanes"][0]["target"] =
                json!({ "type": "track-pan", "trackId": "track-master" })
        }),
        ("master volume automation", |project: &mut Value| {
            project["automationLanes"][0]["target"] =
                json!({ "type": "track-volume", "trackId": "track-master" })
        }),
        ("unsorted automation points", |project: &mut Value| {
            project["automationLanes"][0]["points"][1]["beat"] = json!(0.5)
        }),
        ("invalid interpolation", |project: &mut Value| {
            project["automationLanes"][0]["points"][0]["interpolation"] = json!("curve")
        }),
        (
            "drum step outside after local signature change",
            |project: &mut Value| {
                project["tracks"].as_array_mut().unwrap().push(json!({
                    "id": "track-drums",
                    "name": "Drums",
                    "type": "drum",
                    "role": "general",
                    "clips": [{
                        "id": "clip-drums",
                        "trackId": "track-drums",
                        "type": "drum",
                        "startBeat": 0,
                        "lengthBeats": 6.5,
                        "loop": false,
                        "stepsPerBar": 16,
                        "drumEvents": [{
                            "id": "drum-outside-after-signature-change",
                            "lane": "kick",
                            "stepIndex": 31,
                            "velocity": 100
                        }]
                    }],
                    "volume": 1,
                    "pan": 0,
                    "mute": false,
                    "solo": false,
                    "effects": []
                }));
            },
        ),
        ("unknown nested field", |project: &mut Value| {
            project["tempoMap"][0]["unknown"] = json!(true)
        }),
    ];
    for (name, mutate) in cases {
        let mut project = schema_v3_project_value();
        mutate(&mut project);
        assert!(
            !validate_project_file_json(&serde_json::to_vec(&project).unwrap()),
            "must reject {name}"
        );
    }
}

#[test]
fn schema_v3_unresolved_audio_preserves_legacy_shape_without_ready_metadata() {
    let mut project = schema_v3_project_value();
    project["audioAssets"] = json!([{
        "id": "asset-unresolved",
        "availability": "unresolved",
        "legacyAssetId": "legacy-file",
        "reason": "legacy-reference"
    }]);
    project["tracks"][1]["type"] = json!("instrument");
    let clip = project
        .pointer_mut("/tracks/1/clips/0")
        .and_then(Value::as_object_mut)
        .unwrap();
    clip.insert("audioAssetId".to_owned(), json!("asset-unresolved"));
    clip.insert("sourceStartFrame".to_owned(), json!(0));
    clip.insert("sourceFrameCount".to_owned(), json!(0));
    clip.insert("fadeInFrames".to_owned(), json!(0));
    clip.insert("fadeOutFrames".to_owned(), json!(0));
    clip.insert("gainDb".to_owned(), json!(-3));
    assert!(validate_project_file_json(
        &serde_json::to_vec(&project).unwrap()
    ));

    project["tracks"][1]["clips"][0]["sourceFrameCount"] = json!(1);
    assert!(!validate_project_file_json(
        &serde_json::to_vec(&project).unwrap()
    ));
}

fn migration_v2_project_value() -> Value {
    json!({
        "id": "migration-v2",
        "schemaVersion": 2,
        "title": "Migration",
        "bpm": 110,
        "timeSignature": [4, 4],
        "key": "C",
        "scale": "major",
        "lengthBars": 2,
        "tracks": [
            {
                "id": "migrated-tempo-1",
                "name": " Melody ",
                "type": "instrument",
                "clips": [{
                    "id": "legacy-midi",
                    "trackId": "migrated-tempo-1",
                    "type": "midi",
                    "startBeat": 0,
                    "lengthBeats": 2,
                    "loop": false,
                    "notes": [{
                        "id": "legacy-note",
                        "pitch": 60,
                        "startBeat": 0,
                        "durationBeats": 1,
                        "velocity": 100
                    }]
                }],
                "volume": 1,
                "pan": 0,
                "mute": false,
                "solo": false,
                "effects": []
            },
            {
                "id": "migrated-signature-1",
                "name": "melody",
                "type": "instrument",
                "clips": [{
                    "id": "legacy-audio-shared-a",
                    "trackId": "migrated-signature-1",
                    "type": "audio",
                    "startBeat": 2,
                    "lengthBeats": 2,
                    "loop": false,
                    "audioAssetId": "legacy-shared"
                }],
                "volume": 1,
                "pan": 0,
                "mute": false,
                "solo": false,
                "effects": []
            },
            {
                "id": "migrated-audio-1",
                "name": "Legacy audio",
                "type": "instrument",
                "clips": [
                    {
                        "id": "legacy-audio-shared-b",
                        "trackId": "migrated-audio-1",
                        "type": "audio",
                        "startBeat": 4,
                        "lengthBeats": 2,
                        "loop": false,
                        "audioAssetId": "legacy-shared"
                    },
                    {
                        "id": "legacy-audio-missing",
                        "trackId": "migrated-audio-1",
                        "type": "audio",
                        "startBeat": 6,
                        "lengthBeats": 2,
                        "loop": false
                    }
                ],
                "volume": 1,
                "pan": 0,
                "mute": false,
                "solo": false,
                "effects": []
            }
        ],
        "chordTrack": [],
        "sections": [],
        "createdAt": CREATED_AT,
        "updatedAt": CREATED_AT
    })
}

#[test]
fn native_v2_to_v3_proof_is_deterministic_collision_safe_and_sound_preserving() {
    let source = migration_v2_project_value();
    assert!(validate_project_file_json(
        &serde_json::to_vec(&source).unwrap()
    ));
    let migrated = migrate_project_value_v2_to_v3(source.clone()).expect("v2 migrates");
    assert_eq!(migrated["schemaVersion"], 3);
    assert_eq!(migrated["lengthBeats"], json!(8));
    assert_eq!(migrated["tempoMap"][0]["bpm"], json!(110));
    assert_eq!(migrated["tempoMap"][0]["id"], "migrated-tempo-2");
    assert_eq!(
        migrated["timeSignatureMap"][0]["id"],
        "migrated-signature-2"
    );
    assert_eq!(migrated["tracks"][0]["role"], "learning.melody");
    assert_eq!(migrated["tracks"][1]["role"], "general");
    assert_eq!(migrated["audioAssets"].as_array().unwrap().len(), 2);
    assert_eq!(migrated["audioAssets"][0]["id"], "migrated-audio-2");
    assert_eq!(migrated["audioAssets"][1]["id"], "migrated-audio-3");
    assert_eq!(
        migrated["tracks"][1]["clips"][0]["audioAssetId"],
        migrated["tracks"][2]["clips"][0]["audioAssetId"]
    );
    assert_eq!(migrated["tracks"][2]["clips"][1]["sourceFrameCount"], 0);
    assert!(validate_project_file_json(
        &serde_json::to_vec(&migrated).unwrap()
    ));
    assert!(legacy_project_matches_migrated(
        &serde_json::to_string(&source).unwrap(),
        &serde_json::to_string(&migrated).unwrap(),
    ));

    let mut v1 = source;
    v1["schemaVersion"] = json!(1);
    v1["tracks"][0]["clips"][0]["aliasOf"] = json!("inert-v1-link");
    let migrated_v1 = migrate_project_for_legacy_proof(v1, 3).expect("v1 migrates through v2");
    assert!(migrated_v1["tracks"][0]["clips"][0]
        .get("aliasOf")
        .is_none());
    assert!(validate_project_file_json(
        &serde_json::to_vec(&migrated_v1).unwrap()
    ));

    let mut smuggled = migration_v2_project_value();
    smuggled["tracks"][0]["role"] = json!("general");
    assert!(migrate_project_value_v2_to_v3(smuggled).is_none());
}

#[test]
fn native_v2_to_v3_learning_roles_match_javascript_name_normalization() {
    for (name, expected_role) in [
        ("Chord", "learning.chords"),
        ("cHoRdS", "learning.chords"),
        ("コード", "learning.chords"),
        ("\u{feff}Chords\u{feff}", "learning.chords"),
        ("\u{2003}Chord\u{2003}", "learning.chords"),
        // ECMAScript String#trim does not remove NEXT LINE (U+0085).
        ("\u{0085}Chords\u{0085}", "general"),
    ] {
        let mut source = migration_v2_project_value();
        source["tracks"][0]["name"] = json!(name);

        let migrated = migrate_project_value_v2_to_v3(source).expect("v2 fixture migrates");

        assert_eq!(migrated["tracks"][0]["role"], expected_role, "{name:?}");
    }
}

#[test]
fn native_project_validation_preserves_v1_alias_sound_and_enforces_v2_links() {
    assert!(validate_project_file_json(&linked_clip_project(1, true)));
    assert!(validate_project_file_json(&linked_clip_project(2, false)));
    assert!(!validate_project_file_json(&linked_clip_project(2, true)));
}

#[test]
fn native_project_validation_rejects_schema_v2_link_semantic_matrix() {
    let valid_drum_link = mutated_schema_v2_linked_project(convert_linked_fixture_to_drum);
    assert!(
        validate_project_file_json(&valid_drum_link),
        "the payloadless drum-link baseline must remain valid"
    );

    let cases = vec![
        (
            "self reference",
            mutated_schema_v2_linked_project(|project| {
                linked_alias_mut(project).insert("aliasOf".to_owned(), json!("clip-alias"));
            }),
        ),
        (
            "dangling source",
            mutated_schema_v2_linked_project(|project| {
                linked_alias_mut(project).insert("aliasOf".to_owned(), json!("missing-source"));
            }),
        ),
        (
            "cross-track source",
            mutated_schema_v2_linked_project(|project| {
                project["tracks"]
                    .as_array_mut()
                    .expect("tracks fixture must be an array")
                    .push(json!({
                        "id": "track-b",
                        "name": "Second lead",
                        "type": "instrument",
                        "clips": [{
                            "id": "cross-track-source",
                            "trackId": "track-b",
                            "type": "midi",
                            "startBeat": 0,
                            "lengthBeats": 4,
                            "loop": false,
                            "notes": []
                        }],
                        "volume": 1,
                        "pan": 0,
                        "mute": false,
                        "solo": false,
                        "effects": []
                    }));
                linked_alias_mut(project).insert("aliasOf".to_owned(), json!("cross-track-source"));
            }),
        ),
        (
            "cross-type source",
            mutated_schema_v2_linked_project(|project| {
                project
                    .pointer_mut("/tracks/0/clips")
                    .and_then(Value::as_array_mut)
                    .expect("clips fixture must be an array")
                    .push(json!({
                        "id": "cross-type-source",
                        "trackId": "track-a",
                        "type": "drum",
                        "startBeat": 0,
                        "lengthBeats": 4,
                        "loop": false,
                        "drumEvents": []
                    }));
                linked_alias_mut(project).insert("aliasOf".to_owned(), json!("cross-type-source"));
            }),
        ),
        (
            "chained alias",
            mutated_schema_v2_linked_project(|project| {
                project
                    .pointer_mut("/tracks/0/clips")
                    .and_then(Value::as_array_mut)
                    .expect("clips fixture must be an array")
                    .push(json!({
                        "id": "chained-alias",
                        "trackId": "track-a",
                        "type": "midi",
                        "startBeat": 0,
                        "lengthBeats": 4,
                        "loop": false,
                        "aliasOf": "clip-alias"
                    }));
            }),
        ),
        (
            "length mismatch",
            mutated_schema_v2_linked_project(|project| {
                linked_alias_mut(project).insert("lengthBeats".to_owned(), json!(2));
            }),
        ),
        (
            "alias-owned MIDI notes",
            mutated_schema_v2_linked_project(|project| {
                linked_alias_mut(project).insert("notes".to_owned(), json!([]));
            }),
        ),
        (
            "alias-owned drum events",
            mutated_schema_v2_linked_project(|project| {
                convert_linked_fixture_to_drum(project);
                linked_alias_mut(project).insert("drumEvents".to_owned(), json!([]));
            }),
        ),
        (
            "alias-owned drum stepsPerBar",
            mutated_schema_v2_linked_project(|project| {
                convert_linked_fixture_to_drum(project);
                linked_alias_mut(project).insert("stepsPerBar".to_owned(), json!(16));
            }),
        ),
        (
            "alias-owned drum groove",
            mutated_schema_v2_linked_project(|project| {
                convert_linked_fixture_to_drum(project);
                linked_alias_mut(project).insert(
                    "drumGroove".to_owned(),
                    json!({
                        "swing": 0.2,
                        "probability": 0.9,
                        "humanizeVelocity": 4,
                        "seed": 1
                    }),
                );
            }),
        ),
        (
            "alias-owned audio asset id",
            mutated_schema_v2_linked_project(|project| {
                linked_alias_mut(project)
                    .insert("audioAssetId".to_owned(), json!("asset-on-alias"));
            }),
        ),
    ];

    for (name, project) in cases {
        assert!(
            !validate_project_file_json(&project),
            "schema-v2 linked validation must reject {name}"
        );
    }
}

#[test]
fn native_project_validation_rejects_linked_effective_event_amplification() {
    assert!(validate_project_file_json(&linked_amplification_project(
        200, 1_000
    )));
    let mut one_over: Value =
        serde_json::from_slice(&linked_amplification_project(200, 1_000)).unwrap();
    one_over["tracks"][0]["clips"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "one-over-independent",
            "trackId": "amplified-track",
            "type": "midi",
            "startBeat": 0,
            "lengthBeats": 4,
            "loop": false,
            "notes": [{
                "id": "one-over-note",
                "pitch": 60,
                "startBeat": 0,
                "durationBeats": 1,
                "velocity": 90
            }]
        }));
    assert!(!validate_project_file_json(
        &serde_json::to_vec(&one_over).unwrap()
    ));
    assert!(!validate_project_file_json(&linked_amplification_project(
        201, 1_000
    )));
}

#[test]
fn native_project_validation_keeps_large_non_aliased_v1_projects_compatible() {
    let project = large_non_aliased_v1_project();
    assert!(project.len() < MAX_PROJECT_JSON_BYTES);
    assert!(validate_project_file_json(&project));
}

#[test]
fn schema_v2_linked_project_round_trips_exactly_through_sqlite() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("projects.sqlite3");
    let repository = NativeRepository::new(path.clone());
    repository.initialize().expect("repository initializes");
    let project_json = String::from_utf8(linked_clip_project(2, false))
        .expect("linked fixture must be valid UTF-8");

    repository
        .save(SaveRequestDto {
            project_id: "linked-project".to_owned(),
            project_json: project_json.clone(),
            activation_id: "activation-linked".to_owned(),
            revision: 1,
            write_id: "write-linked-1".to_owned(),
            expected_head: ExpectedHeadDto::Empty,
            predecessor_write_id: None,
        })
        .expect("valid schema-v2 linked project saves");
    repository.close().expect("repository closes");

    let reopened = NativeRepository::new(path);
    reopened.initialize().expect("repository reopens");
    let loaded = reopened
        .load("linked-project".to_owned())
        .expect("linked project loads")
        .expect("linked project exists");

    assert_eq!(loaded.project_json, project_json);
    assert!(!loaded.recovered);
}

#[test]
fn schema_v3_project_round_trips_through_save_crash_draft_and_reopen() {
    let directory = tempfile::tempdir().expect("temp directory");
    let path = directory.path().join("projects.sqlite3");
    let repository = NativeRepository::new(path.clone());
    repository.initialize().expect("repository initializes");
    let project_json = schema_v3_project_json();

    repository
        .stage_crash_draft(CrashDraftRequestDto {
            project_id: "schema-v3-project".to_owned(),
            project_json: project_json.clone(),
            activation_id: "activation-v3".to_owned(),
            revision: 1,
            write_id: "write-v3-1".to_owned(),
            expected_head: ExpectedHeadDto::Empty,
            predecessor_write_id: None,
        })
        .expect("schema-v3 crash draft stages");
    repository
        .save(SaveRequestDto {
            project_id: "schema-v3-project".to_owned(),
            project_json: project_json.clone(),
            activation_id: "activation-v3".to_owned(),
            revision: 1,
            write_id: "write-v3-1".to_owned(),
            expected_head: ExpectedHeadDto::Empty,
            predecessor_write_id: None,
        })
        .expect("schema-v3 project saves");
    repository.close().expect("repository closes");

    let reopened = NativeRepository::new(path);
    reopened.initialize().expect("repository reopens");
    let loaded = reopened
        .load("schema-v3-project".to_owned())
        .expect("schema-v3 project loads")
        .expect("schema-v3 project exists");
    assert_eq!(
        serde_json::from_str::<Value>(&loaded.project_json).unwrap(),
        serde_json::from_str::<Value>(&project_json).unwrap()
    );
    assert!(!loaded.recovered);
}

fn save_request(
    project_id: &str,
    title: &str,
    revision: u64,
    write_id: &str,
    expected_head: ExpectedHeadDto,
) -> SaveRequestDto {
    SaveRequestDto {
        project_id: project_id.to_owned(),
        project_json: project_json(project_id, title, revision),
        activation_id: "activation-a".to_owned(),
        revision,
        write_id: write_id.to_owned(),
        expected_head,
        predecessor_write_id: None,
    }
}

fn crash_draft_request(
    project_id: &str,
    title: &str,
    revision: u64,
    write_id: &str,
    expected_head: ExpectedHeadDto,
) -> CrashDraftRequestDto {
    CrashDraftRequestDto {
        project_id: project_id.to_owned(),
        project_json: project_json(project_id, title, revision),
        activation_id: "activation-a".to_owned(),
        revision,
        write_id: write_id.to_owned(),
        expected_head,
        predecessor_write_id: None,
    }
}

fn save_for_crash_draft(request: &CrashDraftRequestDto) -> SaveRequestDto {
    SaveRequestDto {
        project_id: request.project_id.clone(),
        project_json: request.project_json.clone(),
        activation_id: request.activation_id.clone(),
        revision: request.revision,
        write_id: request.write_id.clone(),
        expected_head: request.expected_head.clone(),
        predecessor_write_id: request.predecessor_write_id.clone(),
    }
}

fn initialized_repository() -> (TempDir, NativeRepository) {
    let directory = tempfile::tempdir().expect("temp directory");
    let repository = NativeRepository::new(directory.path().join("projects.sqlite3"));
    repository.initialize().expect("repository initializes");
    (directory, repository)
}

fn connection_value<T>(repository: &NativeRepository, query: impl FnOnce(&Connection) -> T) -> T {
    let guard = repository.runtime.lock().expect("connection lock");
    query(guard.connection.as_ref().expect("initialized connection"))
}

fn prepare_unfinalized_raw_statement(
    repository: &NativeRepository,
) -> *mut rusqlite::ffi::sqlite3_stmt {
    let guard = repository.runtime.lock().unwrap();
    let connection = guard.connection.as_ref().unwrap();
    let mut statement = std::ptr::null_mut();
    let result = unsafe {
        rusqlite::ffi::sqlite3_prepare_v2(
            connection.handle(),
            c"SELECT name FROM sqlite_master".as_ptr(),
            -1,
            &mut statement,
            std::ptr::null_mut(),
        )
    };
    assert_eq!(result, rusqlite::ffi::SQLITE_OK);
    assert!(!statement.is_null());
    statement
}

fn mark_generation_as_branch(
    repository: &NativeRepository,
    project_id: &str,
    write_id: &str,
    source: &str,
) -> i64 {
    connection_value(repository, |connection| {
        let mut generation =
            read_generation_by_operation(connection, project_id, GenerationKind::Save, write_id)
                .unwrap()
                .unwrap();
        generation.branch_source = Some(source.to_owned());
        let digest = GenerationDigest {
            project_id: &generation.project_id,
            kind: &generation.kind,
            operation_id: &generation.operation_id,
            head_version: &generation.head_version,
            parent_head_version: generation.parent_head_version.as_deref(),
            activation_id: generation.activation_id.as_deref(),
            revision: generation.revision,
            predecessor_write_id: generation.predecessor_write_id.as_deref(),
            saved_at: &generation.saved_at,
            payload_crc32: generation.payload_crc32.as_deref(),
            payload_bytes: generation.payload_bytes,
            title: generation.title.as_deref(),
            updated_at: generation.updated_at.as_deref(),
            branch_source: generation.branch_source.as_deref(),
        };
        generation.record_crc32 = digest_crc32(&digest);
        connection
            .execute(
                "UPDATE project_generations
                 SET branch_source = ?1, record_crc32 = ?2
                 WHERE seq = ?3",
                params![source, generation.record_crc32, generation.seq],
            )
            .unwrap();
        generation.seq
    })
}

fn legacy_snapshot(entries: &[(&str, &str)], created_at: &str) -> LegacyStorageSnapshotDto {
    let mut records = entries
        .iter()
        .map(|(key, value)| LegacyStorageSnapshotRecordDto {
            key: (*key).to_owned(),
            value: (*value).to_owned(),
            value_bytes: u64::try_from(value.len()).unwrap(),
            checksum: digest_crc32(&LegacyRecordChecksum { key, value }),
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| js_string_cmp(&left.key, &right.key));
    let total_bytes = records
        .iter()
        .map(|record| u64::try_from(record.key.len() + record.value.len()).unwrap())
        .sum();
    let content_checksum = digest_crc32(&LegacyStableContentChecksum {
        storage_version: 1,
        entries: &records,
        total_bytes,
    });
    let checksum = digest_crc32(&LegacyEnvelopeChecksum {
        storage_version: 1,
        created_at,
        entries: &records,
        total_bytes,
        content_checksum: &content_checksum,
    });
    LegacyStorageSnapshotDto {
        storage_version: 1,
        created_at: created_at.to_owned(),
        entries: records,
        total_bytes,
        content_checksum,
        checksum,
    }
}

fn legacy_head_request(
    snapshot: &LegacyStorageSnapshotDto,
    project_id: &str,
    title: &str,
    revision: u64,
) -> LegacyProjectImportRequestDto {
    legacy_head_request_at_version(snapshot, 1, project_id, title, revision)
}

fn legacy_head_request_at_version(
    snapshot: &LegacyStorageSnapshotDto,
    migration_version: u64,
    project_id: &str,
    title: &str,
    revision: u64,
) -> LegacyProjectImportRequestDto {
    let persistence_prefix = format!(
        "cts.persistence.v1.project.{}.",
        encoded_storage_part(project_id)
    );
    LegacyProjectImportRequestDto {
        content_checksum: snapshot.content_checksum.clone(),
        migration_version,
        project_id: project_id.to_owned(),
        source_keys: snapshot
            .entries
            .iter()
            .filter(|entry| {
                entry.key == format!("cts.project.{project_id}")
                    || entry.key.starts_with(&persistence_prefix)
            })
            .map(|entry| entry.key.clone())
            .collect(),
        project_json: Some(project_json(project_id, title, revision)),
        branch: None,
        diagnostic: None,
    }
}

fn legacy_completion(
    snapshot: &LegacyStorageSnapshotDto,
    ready_project_count: u64,
    unreadable_project_count: u64,
    branch_count: u64,
) -> LegacyMigrationCompletionDto {
    legacy_completion_at_version(
        snapshot,
        1,
        ready_project_count,
        unreadable_project_count,
        branch_count,
    )
}

fn legacy_completion_at_version(
    snapshot: &LegacyStorageSnapshotDto,
    migration_version: u64,
    ready_project_count: u64,
    unreadable_project_count: u64,
    branch_count: u64,
) -> LegacyMigrationCompletionDto {
    LegacyMigrationCompletionDto {
        content_checksum: snapshot.content_checksum.clone(),
        migration_version,
        record_count: u64::try_from(snapshot.entries.len()).unwrap(),
        total_bytes: snapshot.total_bytes,
        ready_project_count,
        unreadable_project_count,
        branch_count,
    }
}

fn legacy_diagnostic_request_at_version(
    snapshot: &LegacyStorageSnapshotDto,
    migration_version: u64,
    project_id: &str,
    error_code: UnreadableProjectErrorCode,
) -> LegacyProjectImportRequestDto {
    let mut source_keys = snapshot
        .entries
        .iter()
        .filter(|entry| {
            entry.key == format!("cts.project.{project_id}")
                || entry.key.starts_with(&format!(
                    "cts.persistence.v1.project.{}.",
                    encoded_storage_part(project_id)
                ))
        })
        .map(|entry| entry.key.clone())
        .collect::<Vec<_>>();
    source_keys.sort_by(|left, right| js_string_cmp(left, right));
    LegacyProjectImportRequestDto {
        content_checksum: snapshot.content_checksum.clone(),
        migration_version,
        project_id: project_id.to_owned(),
        source_keys,
        project_json: None,
        branch: None,
        diagnostic: Some(LegacyDiagnosticDto { error_code }),
    }
}

fn seed_completed_legacy_diagnostic(
    repository: &NativeRepository,
    snapshot: &LegacyStorageSnapshotDto,
    migration_version: i64,
    project_id: &str,
    error_code: UnreadableProjectErrorCode,
) {
    let request = legacy_diagnostic_request_at_version(
        snapshot,
        u64::try_from(migration_version).unwrap(),
        project_id,
        error_code,
    );
    let source_keys_json = serde_json::to_vec(&request.source_keys).unwrap();
    connection_value(repository, |connection| {
        let transaction = connection.unchecked_transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO legacy_project_staging (
                   content_checksum, migration_version, project_id, source_keys_json,
                   candidate_kind, candidate_operation_id, diagnostic_error_code, staged_at
                 ) VALUES (?1, ?2, ?3, ?4, 'diagnostic', 'diagnostic', ?5, ?6)",
                params![
                    snapshot.content_checksum,
                    migration_version,
                    project_id,
                    source_keys_json,
                    unreadable_error_code_name(error_code),
                    CREATED_AT,
                ],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO legacy_migration_runs (
                   content_checksum, migration_version, completed_at, record_count,
                   total_bytes, ready_project_count, unreadable_project_count, branch_count
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, 0)",
                params![
                    snapshot.content_checksum,
                    migration_version,
                    CREATED_AT,
                    i64::try_from(snapshot.entries.len()).unwrap(),
                    i64::try_from(snapshot.total_bytes).unwrap(),
                ],
            )
            .unwrap();
        transaction.commit().unwrap();
    });
}

fn complete_legacy_diagnostic_fixture(
    repository: &NativeRepository,
    project_id: &str,
    error_code: UnreadableProjectErrorCode,
    token: &str,
) {
    let mirror_key = format!("cts.project.{project_id}");
    let mirror = if error_code == UnreadableProjectErrorCode::UnsupportedVersion {
        serde_json::to_string(&json!({
            "id": project_id,
            "schemaVersion": 999,
            "fixtureToken": token,
        }))
        .unwrap()
    } else {
        format!("{{broken-{token}")
    };
    let snapshot = legacy_snapshot(&[(mirror_key.as_str(), mirror.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: snapshot.content_checksum.clone(),
            migration_version: 1,
            project_id: project_id.to_owned(),
            source_keys: vec![mirror_key],
            project_json: None,
            branch: None,
            diagnostic: Some(LegacyDiagnosticDto { error_code }),
        })
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 0, 1, 0))
        .unwrap();
}

fn raw_native_rows(
    repository: &NativeRepository,
    project_id: &str,
) -> (Option<HeadRow>, Vec<GenerationRow>) {
    connection_value(repository, |connection| {
        let head = read_head_row(connection, project_id).unwrap();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {GENERATION_COLUMNS}
                 FROM project_generations
                 WHERE project_id = ?1
                 ORDER BY seq ASC"
            ))
            .unwrap();
        let generations = statement
            .query_map(params![project_id], generation_from_row)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        (head, generations)
    })
}

fn legacy_audit_fingerprint(
    repository: &NativeRepository,
) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    connection_value(repository, legacy_audit_fingerprint_from_connection)
}

fn legacy_audit_fingerprint_from_connection(
    connection: &Connection,
) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    [
        "SELECT content_checksum, storage_version, created_at, record_count,
                    total_bytes, envelope_checksum, backup_crc32, backed_up_at
             FROM legacy_migration_snapshots ORDER BY content_checksum",
        "SELECT content_checksum, ordinal, storage_key, storage_value, value_bytes,
                    source_checksum, record_crc32
             FROM legacy_migration_records ORDER BY content_checksum, ordinal",
        "SELECT content_checksum, migration_version, completed_at, record_count,
                    total_bytes, ready_project_count, unreadable_project_count, branch_count
             FROM legacy_migration_runs ORDER BY content_checksum, migration_version",
        "SELECT content_checksum, migration_version, project_id, source_keys_json,
                    candidate_kind, candidate_operation_id, payload_crc32, payload_bytes,
                    payload_json, title, updated_at, source, activation_id, revision,
                    write_id, saved_at, diagnostic_error_code, staged_at
             FROM legacy_project_staging
             ORDER BY content_checksum, migration_version, project_id,
                      candidate_kind, candidate_operation_id",
    ]
    .iter()
    .map(|sql| {
        let mut statement = connection.prepare(sql).unwrap();
        let column_count = statement.column_count();
        statement
            .query_map([], |row| {
                (0..column_count)
                    .map(|index| row.get(index))
                    .collect::<Result<Vec<rusqlite::types::Value>, _>>()
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    })
    .collect()
}

fn rewrite_save_generation_as_future(
    repository: &NativeRepository,
    project_id: &str,
    write_id: &str,
) -> GenerationRow {
    connection_value(repository, |connection| {
        let mut generation =
            read_generation_by_operation(connection, project_id, GenerationKind::Save, write_id)
                .unwrap()
                .unwrap();
        let mut project: Value =
            serde_json::from_slice(generation.payload_json.as_ref().unwrap()).unwrap();
        project["schemaVersion"] = json!(999);
        let payload = serde_json::to_vec(&project).unwrap();
        generation.payload_crc32 = Some(crc32(&payload));
        generation.payload_bytes = i64::try_from(payload.len()).unwrap();
        generation.payload_json = Some(payload);
        let digest = GenerationDigest {
            project_id: &generation.project_id,
            kind: &generation.kind,
            operation_id: &generation.operation_id,
            head_version: &generation.head_version,
            parent_head_version: generation.parent_head_version.as_deref(),
            activation_id: generation.activation_id.as_deref(),
            revision: generation.revision,
            predecessor_write_id: generation.predecessor_write_id.as_deref(),
            saved_at: &generation.saved_at,
            payload_crc32: generation.payload_crc32.as_deref(),
            payload_bytes: generation.payload_bytes,
            title: generation.title.as_deref(),
            updated_at: generation.updated_at.as_deref(),
            branch_source: generation.branch_source.as_deref(),
        };
        generation.record_crc32 = digest_crc32(&digest);
        connection
            .execute(
                "UPDATE project_generations
                 SET payload_json = ?1, payload_crc32 = ?2, payload_bytes = ?3,
                     record_crc32 = ?4
                 WHERE seq = ?5",
                params![
                    generation.payload_json,
                    generation.payload_crc32,
                    generation.payload_bytes,
                    generation.record_crc32,
                    generation.seq,
                ],
            )
            .unwrap();
        read_generation_by_seq(connection, generation.seq)
            .unwrap()
            .unwrap()
    })
}

fn repoint_active_head(repository: &NativeRepository, project_id: &str, write_id: &str) -> HeadRow {
    connection_value(repository, |connection| {
        let generation =
            read_generation_by_operation(connection, project_id, GenerationKind::Save, write_id)
                .unwrap()
                .unwrap();
        let checksum = head_crc32(project_id, generation.seq, &generation.head_version, false);
        connection
            .execute(
                "UPDATE project_heads
                 SET generation_seq = ?1, head_version = ?2, deleted = 0, head_crc32 = ?3
                 WHERE project_id = ?4",
                params![
                    generation.seq,
                    generation.head_version,
                    checksum,
                    project_id,
                ],
            )
            .unwrap();
        read_head_row(connection, project_id).unwrap().unwrap()
    })
}

fn legacy_recovery_raw(
    project_id: &str,
    project_json: &str,
    activation_id: &str,
    revision: u64,
    write_id: &str,
    saved_at: &str,
) -> String {
    let proof = LegacyRecoveryProof {
        storage_version: 1,
        project_id,
        base_head_known: false,
        base_head_version: None,
        predecessor_write_id: None,
        activation_id,
        revision,
        write_id,
        saved_at,
        bytes: u64::try_from(project_json.len()).unwrap(),
        project_json,
    };
    let checksum = digest_crc32(&proof);
    serde_json::to_string(&json!({
        "storageVersion": 1,
        "projectId": project_id,
        "baseHeadKnown": false,
        "baseHeadVersion": null,
        "activationId": activation_id,
        "revision": revision,
        "writeId": write_id,
        "savedAt": saved_at,
        "bytes": project_json.len(),
        "projectJson": project_json,
        "checksum": checksum,
    }))
    .unwrap()
}

fn legacy_recovery_raw_with_base(
    project_id: &str,
    project_json: &str,
    activation_id: &str,
    revision: u64,
    write_id: &str,
    saved_at: &str,
    base_head_version: &str,
) -> String {
    let proof = LegacyRecoveryProof {
        storage_version: 1,
        project_id,
        base_head_known: true,
        base_head_version: Some(base_head_version),
        predecessor_write_id: None,
        activation_id,
        revision,
        write_id,
        saved_at,
        bytes: u64::try_from(project_json.len()).unwrap(),
        project_json,
    };
    let checksum = digest_crc32(&proof);
    serde_json::to_string(&json!({
        "storageVersion": 1,
        "projectId": project_id,
        "baseHeadKnown": true,
        "baseHeadVersion": base_head_version,
        "activationId": activation_id,
        "revision": revision,
        "writeId": write_id,
        "savedAt": saved_at,
        "bytes": project_json.len(),
        "projectJson": project_json,
        "checksum": checksum,
    }))
    .unwrap()
}

fn legacy_recovery_raw_known_empty(
    project_id: &str,
    project_json: &str,
    activation_id: &str,
    revision: u64,
    write_id: &str,
    saved_at: &str,
) -> String {
    let proof = LegacyRecoveryProof {
        storage_version: 1,
        project_id,
        base_head_known: true,
        base_head_version: None,
        predecessor_write_id: None,
        activation_id,
        revision,
        write_id,
        saved_at,
        bytes: u64::try_from(project_json.len()).unwrap(),
        project_json,
    };
    let checksum = digest_crc32(&proof);
    serde_json::to_string(&json!({
        "storageVersion": 1,
        "projectId": project_id,
        "baseHeadKnown": true,
        "baseHeadVersion": null,
        "activationId": activation_id,
        "revision": revision,
        "writeId": write_id,
        "savedAt": saved_at,
        "bytes": project_json.len(),
        "projectJson": project_json,
        "checksum": checksum,
    }))
    .unwrap()
}

fn legacy_intent_raw(
    project_id: &str,
    generation_key: &str,
    operation_id: &str,
    parent_head_version: Option<&str>,
) -> String {
    let proof = LegacyIntentProof {
        storage_version: 1,
        project_id,
        kind: "project",
        generation_key,
        operation_id,
        parent_head_version,
    };
    let checksum = digest_crc32(&proof);
    serde_json::to_string(&json!({
        "storageVersion": 1,
        "projectId": project_id,
        "kind": "project",
        "generationKey": generation_key,
        "operationId": operation_id,
        "parentHeadVersion": parent_head_version,
        "checksum": checksum,
    }))
    .unwrap()
}

#[allow(clippy::too_many_arguments)]
fn legacy_generation_raw(
    project_id: &str,
    project_json: &str,
    ordinal: u64,
    parent_head_version: Option<&str>,
    activation_id: &str,
    revision: u64,
    write_id: &str,
    saved_at: &str,
) -> String {
    let proof = LegacyProjectGenerationProof {
        storage_version: 1,
        kind: "project",
        project_id,
        ordinal,
        parent_head_version,
        write_id,
        activation_id,
        revision,
        saved_at,
        bytes: u64::try_from(project_json.len()).unwrap(),
        project_json,
    };
    let checksum = digest_crc32(&proof);
    serde_json::to_string(&json!({
        "storageVersion": 1,
        "kind": "project",
        "projectId": project_id,
        "ordinal": ordinal,
        "parentHeadVersion": parent_head_version,
        "writeId": write_id,
        "activationId": activation_id,
        "revision": revision,
        "savedAt": saved_at,
        "bytes": project_json.len(),
        "projectJson": project_json,
        "checksum": checksum,
    }))
    .unwrap()
}

fn legacy_tombstone_raw(
    project_id: &str,
    ordinal: u64,
    parent_head_version: Option<&str>,
    delete_id: &str,
    deleted_at: &str,
) -> String {
    let proof = LegacyTombstoneGenerationProof {
        storage_version: 1,
        kind: "tombstone",
        project_id,
        ordinal,
        parent_head_version,
        delete_id,
        deleted_at,
    };
    let checksum = digest_crc32(&proof);
    serde_json::to_string(&json!({
        "storageVersion": 1,
        "kind": "tombstone",
        "projectId": project_id,
        "ordinal": ordinal,
        "parentHeadVersion": parent_head_version,
        "deleteId": delete_id,
        "deletedAt": deleted_at,
        "checksum": checksum,
    }))
    .unwrap()
}

#[allow(clippy::too_many_arguments)]
fn legacy_head_raw(
    project_id: &str,
    state: &str,
    ordinal: u64,
    generation_key: &str,
    operation_id: &str,
    parent_head_version: Option<&str>,
    payload_checksum: Option<&str>,
    committed_at: &str,
    include_payload_checksum: bool,
) -> String {
    let proof = LegacyHeadProof {
        storage_version: 1,
        state,
        project_id,
        ordinal,
        generation_key,
        operation_id,
        parent_head_version: Some(parent_head_version),
        payload_checksum: include_payload_checksum.then_some(payload_checksum),
        committed_at,
    };
    let checksum = digest_crc32(&proof);
    let mut value = json!({
        "storageVersion": 1,
        "state": state,
        "projectId": project_id,
        "ordinal": ordinal,
        "generationKey": generation_key,
        "operationId": operation_id,
        "parentHeadVersion": parent_head_version,
        "committedAt": committed_at,
        "checksum": checksum,
    });
    if include_payload_checksum {
        value["payloadChecksum"] = payload_checksum.map_or(Value::Null, |value| json!(value));
    }
    serde_json::to_string(&value).unwrap()
}

#[test]
fn initializes_hardened_schema_and_reopens_after_close() {
    let (_directory, repository) = initialized_repository();
    connection_value(&repository, |connection| {
        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let application_id: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .unwrap();
        let journal_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        let synchronous: i64 = connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .unwrap();
        let foreign_keys: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        let trusted_schema: i64 = connection
            .pragma_query_value(None, "trusted_schema", |row| row.get(0))
            .unwrap();
        let locking_mode: String = connection
            .pragma_query_value(None, "locking_mode", |row| row.get(0))
            .unwrap();
        let temp_store: i64 = connection
            .pragma_query_value(None, "temp_store", |row| row.get(0))
            .unwrap();
        assert_eq!(user_version, DATABASE_SCHEMA_VERSION);
        assert_eq!(application_id, APPLICATION_ID);
        assert_eq!(journal_mode, "wal");
        assert_eq!(synchronous, 2);
        assert_eq!(foreign_keys, 1);
        assert_eq!(trusted_schema, 0);
        assert_eq!(locking_mode, "exclusive");
        assert_eq!(temp_store, 2);
    });
    assert!(
        !append_path_suffix(&repository.path, "-shm").exists(),
        "exclusive WAL must keep its shared-memory index in process memory"
    );

    repository.close().unwrap();
    assert_eq!(
        repository.list().unwrap_err().code,
        PersistenceErrorCode::StorageUnavailable
    );
    repository.initialize().unwrap();
    assert!(repository.list().unwrap().is_empty());
    assert!(!append_path_suffix(&repository.path, "-shm").exists());
}

#[test]
fn version_one_database_migrates_atomically_to_crash_draft_schema() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("projects.sqlite3");
    let mut connection = Connection::open(&path).unwrap();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    transaction.execute_batch(MIGRATION_V1).unwrap();
    transaction
        .pragma_update(None, "application_id", APPLICATION_ID)
        .unwrap();
    transaction
        .pragma_update(None, "user_version", 1_i64)
        .unwrap();
    transaction.commit().unwrap();
    connection.close().unwrap();

    let repository = NativeRepository::new(path);
    repository.initialize().unwrap();
    connection_value(&repository, |connection| {
        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let table: String = connection
            .query_row(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name = 'project_crash_drafts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(user_version, DATABASE_SCHEMA_VERSION);
        assert_eq!(table, "project_crash_drafts");
    });
}

#[test]
fn guarded_vfs_runtime_and_dependency_contract_is_exact() {
    ensure_safe_sqlite_vfs_registered().unwrap();
    assert_eq!(
        unsafe { rusqlite::ffi::sqlite3_libversion_number() },
        EXPECTED_BUNDLED_SQLITE_VERSION
    );
    let original = ORIGINAL_SQLITE_VFS.load(Ordering::Acquire);
    assert!(!original.is_null());
    let original_name = unsafe { std::ffi::CStr::from_ptr((*original).zName) }.to_bytes();
    assert!(sqlite_vfs_name_is_platform(original_name));
    let registered = unsafe { rusqlite::ffi::sqlite3_vfs_find(c"cts-safe-vfs-v1".as_ptr()) };
    assert!(!registered.is_null());

    let cargo_manifest = include_str!("../../Cargo.toml");
    assert!(cargo_manifest.contains(
        "rusqlite = { version = \"=0.40.1\", default-features = false, features = [\"bundled\"] }"
    ));
    let cargo_lock = include_str!("../../Cargo.lock").replace("\r\n", "\n");
    assert!(cargo_lock.contains("name = \"libsqlite3-sys\"\nversion = \"0.38.1\""));
}

#[test]
fn guarded_vfs_never_deletes_a_path_outside_the_registered_database_family() {
    let (directory, _repository) = initialized_repository();
    let outside = directory.path().join("outside-boundary-file");
    let bytes = b"outside boundary bytes must remain";
    fs::write(&outside, bytes).unwrap();
    let outside_name = std::ffi::CString::new(outside.to_str().unwrap()).unwrap();

    let result = unsafe { safe_sqlite_vfs_delete(std::ptr::null_mut(), outside_name.as_ptr(), 0) };
    assert_eq!(result, rusqlite::ffi::SQLITE_IOERR_DELETE);
    assert_eq!(fs::read(outside).unwrap(), bytes);
}

#[test]
fn guarded_vfs_reopens_existing_wal_without_shared_memory_sidecar() {
    let (_directory, repository) = initialized_repository();
    connection_value(&repository, |connection| {
        let mut persist_wal = 1_i32;
        let result = unsafe {
            rusqlite::ffi::sqlite3_file_control(
                connection.handle(),
                c"main".as_ptr(),
                rusqlite::ffi::SQLITE_FCNTL_PERSIST_WAL,
                (&mut persist_wal as *mut i32).cast(),
            )
        };
        assert_eq!(result, rusqlite::ffi::SQLITE_OK);
    });
    repository
        .save(save_request(
            "project-a",
            "Persistent WAL",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository.close().unwrap();
    let wal_path = append_path_suffix(&repository.path, "-wal");
    assert!(wal_path.exists(), "fixture must retain an existing WAL");
    assert!(!append_path_suffix(&repository.path, "-shm").exists());

    repository.initialize().unwrap();
    let loaded = repository.load("project-a".to_owned()).unwrap().unwrap();
    let loaded_json: Value = serde_json::from_str(&loaded.project_json).unwrap();
    assert_eq!(loaded_json["title"], "Persistent WAL");
    assert!(!append_path_suffix(&repository.path, "-shm").exists());
}

#[test]
fn crash_draft_stage_is_idempotent_monotonic_and_single_slot_per_activation() {
    let (_directory, repository) = initialized_repository();
    let first = crash_draft_request(
        "project-a",
        "Protected one",
        1,
        "draft-1",
        ExpectedHeadDto::Empty,
    );
    let first_receipt = repository.stage_crash_draft(first.clone()).unwrap();
    assert_eq!(
        repository.stage_crash_draft(first.clone()).unwrap(),
        first_receipt
    );
    assert_eq!(
        repository
            .stage_crash_draft(crash_draft_request(
                "project-a",
                "Reused write id",
                2,
                "draft-1",
                ExpectedHeadDto::Empty,
            ))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict,
        "one write id must identify exactly one immutable revision"
    );

    let same_revision_different_bytes = crash_draft_request(
        "project-a",
        "Must conflict",
        1,
        "draft-other",
        ExpectedHeadDto::Empty,
    );
    assert_eq!(
        repository
            .stage_crash_draft(same_revision_different_bytes)
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );

    let second = crash_draft_request(
        "project-a",
        "Protected two",
        2,
        "draft-2",
        ExpectedHeadDto::Empty,
    );
    repository.stage_crash_draft(second).unwrap();
    assert_eq!(
        repository.stage_crash_draft(first).unwrap_err().code,
        PersistenceErrorCode::Conflict
    );
    connection_value(&repository, |connection| {
        let drafts = all_crash_drafts(connection).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].revision, 2);
        assert_eq!(drafts[0].write_id, "draft-2");
        assert_eq!(
            validate_crash_draft(&drafts[0]).unwrap().title,
            "Protected two"
        );
    });
}

#[test]
fn canonical_save_consumes_only_matching_or_older_crash_drafts() {
    let (_directory, repository) = initialized_repository();
    let first = crash_draft_request(
        "project-a",
        "First protected",
        1,
        "draft-1",
        ExpectedHeadDto::Empty,
    );
    repository.stage_crash_draft(first.clone()).unwrap();
    let first_saved = repository.save(save_for_crash_draft(&first)).unwrap();
    connection_value(&repository, |connection| {
        assert!(all_crash_drafts(connection).unwrap().is_empty());
    });

    let second = crash_draft_request(
        "project-a",
        "Second protected",
        2,
        "draft-2",
        ExpectedHeadDto::Match {
            version: first_saved.head_version.clone(),
        },
    );
    repository.stage_crash_draft(second.clone()).unwrap();
    let mut third = crash_draft_request(
        "project-a",
        "Third protected",
        3,
        "draft-3",
        ExpectedHeadDto::Match {
            version: first_saved.head_version.clone(),
        },
    );
    third.predecessor_write_id = Some("draft-2".to_owned());
    repository.stage_crash_draft(third.clone()).unwrap();

    let second_saved = repository.save(save_for_crash_draft(&second)).unwrap();
    connection_value(&repository, |connection| {
        let drafts = all_crash_drafts(connection).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].revision, 3, "save N must retain staged N+1");
    });
    let third_saved = repository.save(save_for_crash_draft(&third)).unwrap();
    assert_ne!(second_saved.head_version, third_saved.head_version);
    connection_value(&repository, |connection| {
        assert!(all_crash_drafts(connection).unwrap().is_empty());
    });
}

#[test]
fn canonical_save_rejects_cross_table_write_id_reuse_without_poisoning_replay() {
    let (_directory, repository) = initialized_repository();
    let mut other_activation = crash_draft_request(
        "project-a",
        "Protected activation B",
        1,
        "shared-write",
        ExpectedHeadDto::Empty,
    );
    other_activation.activation_id = "activation-b".to_owned();
    repository.stage_crash_draft(other_activation).unwrap();
    assert_eq!(
        repository
            .save(save_request(
                "project-a",
                "Conflicting activation A",
                1,
                "shared-write",
                ExpectedHeadDto::Empty,
            ))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );

    repository
        .stage_crash_draft(crash_draft_request(
            "project-b",
            "Protected revision two",
            2,
            "shared-revision-write",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    assert_eq!(
        repository
            .save(save_request(
                "project-b",
                "Conflicting revision one",
                1,
                "shared-revision-write",
                ExpectedHeadDto::Empty,
            ))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    repository.close().unwrap();

    repository.initialize().unwrap();
    for (project_id, title) in [
        ("project-a", "Protected activation B"),
        ("project-b", "Protected revision two"),
    ] {
        let loaded = repository.load(project_id.to_owned()).unwrap().unwrap();
        assert_eq!(
            loaded.recovery_reason,
            Some(ProjectRecoveryReason::InterruptedSave)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&loaded.project_json).unwrap()["title"],
            title
        );
    }
}

#[test]
fn initialize_promotes_one_causal_crash_draft_and_marks_the_recovery_reason() {
    let (_directory, repository) = initialized_repository();
    repository
        .stage_crash_draft(crash_draft_request(
            "project-a",
            "Recovered exact draft",
            1,
            "draft-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository.close().unwrap();

    repository.initialize().unwrap();
    let loaded = repository.load("project-a".to_owned()).unwrap().unwrap();
    assert!(loaded.recovered);
    assert_eq!(
        loaded.recovery_reason,
        Some(ProjectRecoveryReason::InterruptedSave)
    );
    assert!(loaded
        .head_version
        .as_deref()
        .unwrap()
        .starts_with("sqlite:v1:interrupted-save:"));
    assert_eq!(
        serde_json::from_str::<Value>(&loaded.project_json).unwrap()["title"],
        "Recovered exact draft"
    );
    connection_value(&repository, |connection| {
        assert!(all_crash_drafts(connection).unwrap().is_empty());
    });
}

#[test]
fn initialize_keeps_divergent_activations_as_interrupted_save_branches() {
    let (_directory, repository) = initialized_repository();
    let base = repository
        .save(save_request(
            "project-a",
            "Canonical base",
            1,
            "base-write",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let mut first = crash_draft_request(
        "project-a",
        "Draft A",
        2,
        "draft-a",
        ExpectedHeadDto::Match {
            version: base.head_version.clone(),
        },
    );
    first.activation_id = "activation-a".to_owned();
    repository.stage_crash_draft(first).unwrap();
    let mut second = crash_draft_request(
        "project-a",
        "Draft B",
        2,
        "draft-b",
        ExpectedHeadDto::Match {
            version: base.head_version,
        },
    );
    second.activation_id = "activation-b".to_owned();
    repository.stage_crash_draft(second).unwrap();
    repository.close().unwrap();

    repository.initialize().unwrap();
    let summaries = repository.list().unwrap();
    let ProjectSummaryDto::Ready {
        title, branches, ..
    } = &summaries[0]
    else {
        panic!("canonical project remains ready");
    };
    assert_eq!(title, "Canonical base");
    assert_eq!(branches.len(), 2);
    assert!(branches
        .iter()
        .all(|branch| branch.source == ProjectBranchSource::InterruptedSave));
    connection_value(&repository, |connection| {
        assert!(all_crash_drafts(connection).unwrap().is_empty());
    });
}

#[test]
fn initialize_never_promotes_a_crash_draft_over_a_changed_base_head() {
    let (_directory, repository) = initialized_repository();
    let base = repository
        .save(save_request(
            "project-a",
            "Canonical base",
            1,
            "base-write",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository
        .stage_crash_draft(crash_draft_request(
            "project-a",
            "Stale protected draft",
            2,
            "draft-stale",
            ExpectedHeadDto::Match {
                version: base.head_version.clone(),
            },
        ))
        .unwrap();
    let mut concurrent = save_request(
        "project-a",
        "Concurrent canonical",
        1,
        "write-concurrent",
        ExpectedHeadDto::Match {
            version: base.head_version,
        },
    );
    concurrent.activation_id = "activation-b".to_owned();
    repository.save(concurrent).unwrap();
    repository.close().unwrap();

    repository.initialize().unwrap();
    let summaries = repository.list().unwrap();
    let ProjectSummaryDto::Ready {
        title, branches, ..
    } = &summaries[0]
    else {
        panic!("changed canonical head remains authoritative");
    };
    assert_eq!(title, "Concurrent canonical");
    assert_eq!(branches.len(), 1);
    assert_eq!(branches[0].source, ProjectBranchSource::InterruptedSave);
    assert_eq!(branches[0].title, "Stale protected draft");
}

#[test]
fn remove_atomically_deletes_crash_drafts_and_tombstone_blocks_late_stage() {
    let (_directory, repository) = initialized_repository();
    let saved = repository
        .save(save_request(
            "project-a",
            "Canonical",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository
        .stage_crash_draft(crash_draft_request(
            "project-a",
            "Pending delete",
            2,
            "draft-2",
            ExpectedHeadDto::Match {
                version: saved.head_version.clone(),
            },
        ))
        .unwrap();
    repository
        .remove(RemoveRequestDto {
            project_id: "project-a".to_owned(),
            delete_id: "delete-1".to_owned(),
            expected_head: ExpectedHeadDto::Match {
                version: saved.head_version,
            },
        })
        .unwrap();
    connection_value(&repository, |connection| {
        assert!(all_crash_drafts(connection).unwrap().is_empty());
    });
    assert_eq!(
        repository
            .stage_crash_draft(crash_draft_request(
                "project-a",
                "Must not resurrect",
                3,
                "draft-3",
                ExpectedHeadDto::Repair,
            ))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
}

#[test]
fn verified_tombstone_purges_length_mismatched_residual_draft_on_reopen() {
    let (_directory, repository) = initialized_repository();
    let saved = repository
        .save(save_request(
            "project-a",
            "Canonical",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository
        .stage_crash_draft(crash_draft_request(
            "project-a",
            "Private residual",
            2,
            "draft-2",
            ExpectedHeadDto::Match {
                version: saved.head_version.clone(),
            },
        ))
        .unwrap();
    let draft = connection_value(&repository, |connection| {
        read_crash_draft(connection, "project-a", "activation-a")
            .unwrap()
            .unwrap()
    });
    repository
        .remove(RemoveRequestDto {
            project_id: "project-a".to_owned(),
            delete_id: "delete-1".to_owned(),
            expected_head: ExpectedHeadDto::Match {
                version: saved.head_version,
            },
        })
        .unwrap();
    connection_value(&repository, |connection| {
        connection
            .execute(
                "INSERT INTO project_crash_drafts (
                   project_id, activation_id, revision, write_id, base_head_known,
                   base_head_version, predecessor_write_id, saved_at, payload_json,
                   payload_crc32, payload_bytes, title, updated_at, format_version,
                   record_crc32
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    draft.project_id,
                    draft.activation_id,
                    draft.revision,
                    draft.write_id,
                    i64::from(draft.base_head_known),
                    draft.base_head_version,
                    draft.predecessor_write_id,
                    draft.saved_at,
                    draft.payload_json,
                    draft.payload_crc32,
                    draft.payload_bytes - 1,
                    draft.title,
                    draft.updated_at,
                    draft.format_version,
                    draft.record_crc32,
                ],
            )
            .unwrap();
    });
    repository.close().unwrap();

    repository.initialize().unwrap();
    assert!(repository.load("project-a".to_owned()).unwrap().is_none());
    connection_value(&repository, |connection| {
        assert!(all_crash_drafts(connection).unwrap().is_empty());
    });
}

#[test]
fn corrupt_crash_draft_fails_closed_and_remains_for_diagnosis() {
    let (_directory, repository) = initialized_repository();
    repository
        .stage_crash_draft(crash_draft_request(
            "project-a",
            "Protected",
            1,
            "draft-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    connection_value(&repository, |connection| {
        connection
            .execute(
                "UPDATE project_crash_drafts SET record_crc32 = 'crc32:00000000'",
                [],
            )
            .unwrap();
    });
    repository.close().unwrap();

    assert_eq!(
        repository.initialize().unwrap_err().code,
        PersistenceErrorCode::CorruptData
    );
    assert_eq!(
        repository.initialize().unwrap_err().code,
        PersistenceErrorCode::CorruptData,
        "a retry must not silently discard the protected bytes"
    );
}

#[test]
fn saves_idempotently_lists_loads_and_retains_three_generations() {
    let (_directory, repository) = initialized_repository();
    let first_request = save_request("project-a", "First", 1, "write-1", ExpectedHeadDto::Empty);
    let first = repository.save(first_request.clone()).unwrap();
    assert_eq!(first.retained_generations, 1);
    assert_eq!(first.bytes, first_request.project_json.len());
    assert_eq!(repository.save(first_request).unwrap(), first);

    let mut head_version = first.head_version;
    for revision in 2..=4 {
        let receipt = repository
            .save(save_request(
                "project-a",
                &format!("Revision {revision}"),
                revision,
                &format!("write-{revision}"),
                ExpectedHeadDto::Match {
                    version: head_version,
                },
            ))
            .unwrap();
        head_version = receipt.head_version;
    }

    let loaded = repository
        .load("project-a".to_owned())
        .unwrap()
        .expect("saved project");
    let loaded_json: Value = serde_json::from_str(&loaded.project_json).unwrap();
    assert_eq!(loaded_json["title"], "Revision 4");
    assert_eq!(loaded.head_version.as_deref(), Some(head_version.as_str()));
    assert!(!loaded.recovered);

    let summaries = repository.list().unwrap();
    assert!(matches!(
        summaries.as_slice(),
        [ProjectSummaryDto::Ready { id, recovered: false, .. }] if id == "project-a"
    ));
    assert_eq!(
        connection_value(&repository, |connection| {
            generation_count(connection, "project-a").unwrap()
        }),
        RETAIN_GENERATIONS
    );
}

#[test]
fn rejects_stale_heads_and_reused_write_ids_with_different_payloads() {
    let (_directory, repository) = initialized_repository();
    let first = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let stale = repository
        .save(save_request(
            "project-a",
            "Stale",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: "not-current".to_owned(),
            },
        ))
        .unwrap_err();
    assert_eq!(stale.code, PersistenceErrorCode::Conflict);

    let reused = repository
        .save(save_request(
            "project-a",
            "Different bytes",
            1,
            "write-1",
            ExpectedHeadDto::Match {
                version: first.head_version,
            },
        ))
        .unwrap_err();
    assert_eq!(reused.code, PersistenceErrorCode::Conflict);
}

#[test]
fn identical_save_retry_ignores_changed_base_routing_metadata() {
    let (_directory, repository) = initialized_repository();
    let original = save_request("project-a", "First", 1, "write-1", ExpectedHeadDto::Empty);
    let receipt = repository.save(original.clone()).unwrap();
    let mut retry = original;
    retry.expected_head = ExpectedHeadDto::Match {
        version: "stale-observation".to_owned(),
    };
    retry.predecessor_write_id = Some("pagehide-predecessor".to_owned());
    assert_eq!(repository.save(retry).unwrap(), receipt);
    let stored_predecessor = connection_value(&repository, |connection| {
        read_generation_by_operation(connection, "project-a", GenerationKind::Save, "write-1")
            .unwrap()
            .unwrap()
            .predecessor_write_id
    });
    assert_eq!(stored_predecessor, None);
}

#[test]
fn identical_save_retry_requires_the_exact_crc_valid_pointed_row() {
    for mode in ["bad-crc", "wrong-sequence"] {
        let (_directory, repository) = initialized_repository();
        let project_id = format!("same-save-token-{mode}");
        let original = save_request(
            &project_id,
            "Original",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        );
        let first = repository.save(original.clone()).unwrap();
        if mode == "wrong-sequence" {
            repository
                .save(save_request(
                    &project_id,
                    "Different row",
                    2,
                    "write-2",
                    ExpectedHeadDto::Match {
                        version: first.head_version.clone(),
                    },
                ))
                .unwrap();
        }
        connection_value(&repository, |connection| {
            if mode == "bad-crc" {
                connection
                    .execute(
                        "UPDATE project_heads SET head_crc32 = 'crc32:00000000'
                         WHERE project_id = ?1",
                        params![project_id],
                    )
                    .unwrap();
            } else {
                let other = read_generation_by_operation(
                    connection,
                    &project_id,
                    GenerationKind::Save,
                    "write-2",
                )
                .unwrap()
                .unwrap();
                let checksum = head_crc32(&project_id, other.seq, &first.head_version, false);
                connection
                    .execute(
                        "UPDATE project_heads
                         SET generation_seq = ?1, head_version = ?2, deleted = 0,
                             head_crc32 = ?3
                         WHERE project_id = ?4",
                        params![other.seq, first.head_version, checksum, project_id,],
                    )
                    .unwrap();
            }
        });
        let before = raw_native_rows(&repository, &project_id);
        assert_eq!(
            repository.save(original).unwrap_err(),
            PersistenceErrorDto::new(
                RepositoryOperation::Save,
                PersistenceErrorCode::Conflict,
                RetryPolicy::Manual,
                Some(&project_id),
            )
        );
        assert_eq!(raw_native_rows(&repository, &project_id), before);
    }
}

#[test]
fn repair_expected_head_cannot_create_or_delete_a_truly_empty_project() {
    let (_directory, repository) = initialized_repository();
    assert_eq!(
        repository
            .save(save_request(
                "project-a",
                "Unknown-base recovery",
                1,
                "write-repair",
                ExpectedHeadDto::Repair,
            ))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    assert_eq!(
        repository
            .remove(RemoveRequestDto {
                project_id: "project-a".to_owned(),
                delete_id: "delete-repair".to_owned(),
                expected_head: ExpectedHeadDto::Repair,
            })
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    assert_eq!(
        repository
            .get_project_state("project-a".to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Missing
    );
}

#[test]
fn rejects_malformed_or_noncanonical_project_v1_payloads() {
    let cases = [
        {
            let mut value: Value =
                serde_json::from_str(&project_json("project-a", "A", 1)).unwrap();
            value["unknownRoot"] = json!(true);
            serde_json::to_string(&value).unwrap()
        },
        {
            let mut value: Value =
                serde_json::from_str(&project_json("project-a", "A", 1)).unwrap();
            value.as_object_mut().unwrap().remove("tracks");
            serde_json::to_string(&value).unwrap()
        },
        {
            let mut value: Value =
                serde_json::from_str(&project_json("project-a", "A", 1)).unwrap();
            value["key"] = json!("H");
            serde_json::to_string(&value).unwrap()
        },
        {
            let mut value: Value =
                serde_json::from_str(&project_json("project-a", "A", 1)).unwrap();
            value["createdAt"] = json!("2026-7-10");
            serde_json::to_string(&value).unwrap()
        },
        {
            let mut value: Value =
                serde_json::from_str(&project_json("project-a", "A", 1)).unwrap();
            value["tracks"] = json!([{
                "id": "duplicate",
                "name": "Track",
                "type": "instrument",
                "clips": [{
                    "id": "duplicate",
                    "trackId": "wrong-track",
                    "type": "midi",
                    "startBeat": 0,
                    "lengthBeats": 1,
                    "loop": false,
                    "notes": []
                }],
                "volume": 1,
                "pan": 0,
                "mute": false,
                "solo": false,
                "effects": []
            }]);
            serde_json::to_string(&value).unwrap()
        },
        {
            let mut value: Value =
                serde_json::from_str(&project_json("project-a", "A", 1)).unwrap();
            value["tracks"] = json!([{
                "id": "track-1",
                "name": "Track",
                "type": "instrument",
                "color": null,
                "clips": [],
                "volume": 1,
                "pan": 0,
                "mute": false,
                "solo": false,
                "effects": []
            }]);
            serde_json::to_string(&value).unwrap()
        },
        {
            let mut value: Value =
                serde_json::from_str(&project_json("project-a", "A", 1)).unwrap();
            value["chordTrack"] = json!([{
                "id": "chord-1",
                "startBeat": 0,
                "durationBeats": 1,
                "symbol": "C",
                "root": "C",
                "quality": "major",
                "notes": vec![60; 100_001]
            }]);
            serde_json::to_string(&value).unwrap()
        },
        {
            let mut value: Value =
                serde_json::from_str(&project_json("project-a", "A", 1)).unwrap();
            value["chordTrack"] = json!([{
                "id": "chord-1",
                "startBeat": 0,
                "durationBeats": 1,
                "symbol": "C",
                "root": "C",
                "quality": "major",
                "notes": [60, 64, 67],
                "tags": vec!["tag"; 100_001]
            }]);
            serde_json::to_string(&value).unwrap()
        },
        project_json("project-a", "A", 1).replace("\"bpm\":120", "\"bpm\":1e400"),
    ];
    for (index, payload) in cases.into_iter().enumerate() {
        let (_directory, repository) = initialized_repository();
        let error = repository
            .save(SaveRequestDto {
                project_id: "project-a".to_owned(),
                project_json: payload,
                activation_id: "activation-a".to_owned(),
                revision: 1,
                write_id: format!("write-{index}"),
                expected_head: ExpectedHeadDto::Empty,
                predecessor_write_id: None,
            })
            .unwrap_err();
        assert_eq!(
            error.code,
            PersistenceErrorCode::InvalidProject,
            "case {index}"
        );
    }
}

#[test]
fn legacy_import_rejects_explicit_null_optional_fields_before_staging() {
    let (_directory, repository) = initialized_repository();
    let mut value: Value = serde_json::from_str(&project_json("legacy-a", "A", 1)).unwrap();
    value["tracks"] = json!([{
        "id": "track-1",
        "name": "Track",
        "type": "instrument",
        "clips": [],
        "volume": 1,
        "pan": 0,
        "mute": false,
        "solo": false,
        "instrument": null,
        "effects": []
    }]);
    let invalid = serde_json::to_string(&value).unwrap();
    let snapshot = legacy_snapshot(&[("cts.project.legacy-a", invalid.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let mut request = legacy_head_request(&snapshot, "legacy-a", "A", 1);
    request.project_json = Some(invalid);
    assert_eq!(
        repository.import_legacy_project(request).unwrap_err().code,
        PersistenceErrorCode::InvalidProject
    );
    assert_eq!(
        connection_value(&repository, |connection| {
            connection
                .query_row("SELECT COUNT(*) FROM legacy_project_staging", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        }),
        0
    );
}

#[test]
fn predecessor_allows_only_a_causal_newer_revision_in_the_same_activation() {
    let (_directory, repository) = initialized_repository();
    repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();

    let mut recovery = save_request(
        "project-a",
        "Recovered",
        2,
        "write-2",
        ExpectedHeadDto::Match {
            version: "older-observed-head".to_owned(),
        },
    );
    recovery.predecessor_write_id = Some("write-1".to_owned());
    let recovered = repository.save(recovery).unwrap();

    let mut wrong_activation = save_request(
        "project-a",
        "Wrong activation",
        3,
        "write-3",
        ExpectedHeadDto::Match {
            version: "still-stale".to_owned(),
        },
    );
    wrong_activation.activation_id = "activation-b".to_owned();
    wrong_activation.predecessor_write_id = Some("write-2".to_owned());
    assert_eq!(
        repository.save(wrong_activation).unwrap_err().code,
        PersistenceErrorCode::Conflict
    );

    let mut non_newer = save_request(
        "project-a",
        "Non newer",
        2,
        "write-4",
        ExpectedHeadDto::Match {
            version: "still-stale".to_owned(),
        },
    );
    non_newer.predecessor_write_id = Some("write-2".to_owned());
    assert_eq!(
        repository.save(non_newer).unwrap_err().code,
        PersistenceErrorCode::Conflict
    );
    assert_eq!(
        repository
            .load("project-a".to_owned())
            .unwrap()
            .unwrap()
            .head_version,
        Some(recovered.head_version)
    );
}

#[test]
fn tombstone_is_idempotent_and_blocks_blind_repair() {
    let (_directory, repository) = initialized_repository();
    let saved = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let remove_request = RemoveRequestDto {
        project_id: "project-a".to_owned(),
        delete_id: "delete-1".to_owned(),
        expected_head: ExpectedHeadDto::Match {
            version: saved.head_version,
        },
    };
    let removed = repository.remove(remove_request.clone()).unwrap();
    assert!(removed.removed);
    assert_eq!(repository.remove(remove_request).unwrap(), removed);
    assert!(repository.load("project-a".to_owned()).unwrap().is_none());
    assert!(repository.list().unwrap().is_empty());

    let repair = repository
        .save(save_request(
            "project-a",
            "Must not resurrect",
            2,
            "write-2",
            ExpectedHeadDto::Repair,
        ))
        .unwrap_err();
    assert_eq!(repair.code, PersistenceErrorCode::Conflict);
}

#[test]
fn identical_delete_retry_rejects_a_corrupt_or_non_deleted_head_without_mutation() {
    for mode in ["bad-crc", "not-deleted"] {
        let (_directory, repository) = initialized_repository();
        let project_id = format!("same-delete-token-{mode}");
        let saved = repository
            .save(save_request(
                &project_id,
                "Delete me",
                1,
                "write-1",
                ExpectedHeadDto::Empty,
            ))
            .unwrap();
        let remove_request = RemoveRequestDto {
            project_id: project_id.clone(),
            delete_id: "delete-1".to_owned(),
            expected_head: ExpectedHeadDto::Match {
                version: saved.head_version,
            },
        };
        repository.remove(remove_request.clone()).unwrap();
        connection_value(&repository, |connection| {
            let head = read_head_row(connection, &project_id).unwrap().unwrap();
            if mode == "bad-crc" {
                connection
                    .execute(
                        "UPDATE project_heads SET head_crc32 = 'crc32:00000000'
                         WHERE project_id = ?1",
                        params![project_id],
                    )
                    .unwrap();
            } else {
                let checksum =
                    head_crc32(&project_id, head.generation_seq, &head.head_version, false);
                connection
                    .execute(
                        "UPDATE project_heads SET deleted = 0, head_crc32 = ?1
                         WHERE project_id = ?2",
                        params![checksum, project_id],
                    )
                    .unwrap();
            }
        });
        let before = raw_native_rows(&repository, &project_id);
        assert_eq!(
            repository.remove(remove_request).unwrap_err(),
            PersistenceErrorDto::new(
                RepositoryOperation::Remove,
                PersistenceErrorCode::Conflict,
                RetryPolicy::Manual,
                Some(&project_id),
            )
        );
        assert_eq!(raw_native_rows(&repository, &project_id), before);
    }
}

#[test]
fn crc_valid_deleted_head_is_sticky_even_when_tombstone_record_is_broken() {
    let (_directory, repository) = initialized_repository();
    let saved = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let remove_request = RemoveRequestDto {
        project_id: "project-a".to_owned(),
        delete_id: "delete-1".to_owned(),
        expected_head: ExpectedHeadDto::Match {
            version: saved.head_version,
        },
    };
    repository.remove(remove_request.clone()).unwrap();
    connection_value(&repository, |connection| {
        connection
            .execute(
                "UPDATE project_generations SET record_crc32 = 'crc32:00000000'
                 WHERE project_id = 'project-a' AND operation_id = 'delete-1'",
                [],
            )
            .unwrap();
    });
    let hidden_branch =
        mark_generation_as_branch(&repository, "project-a", "write-1", "recovery-journal");

    assert!(repository.load("project-a".to_owned()).unwrap().is_none());
    assert!(repository.list().unwrap().is_empty());
    assert!(repository
        .load_branch(
            "project-a".to_owned(),
            format!("sqlite-generation:{hidden_branch}"),
        )
        .unwrap()
        .is_none());
    assert_eq!(
        repository
            .get_project_state("project-a".to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );
    assert_eq!(
        repository
            .save(save_request(
                "project-a",
                "Must remain deleted",
                2,
                "write-2",
                ExpectedHeadDto::Repair,
            ))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    assert!(repository.remove(remove_request).unwrap().cleanup_complete);
}

#[test]
fn missing_corrupt_or_relationship_bad_head_still_honors_a_valid_tombstone() {
    for mode in ["missing", "bad-crc", "bad-relationship"] {
        let (_directory, repository) = initialized_repository();
        let saved = repository
            .save(save_request(
                "project-a",
                "First",
                1,
                "write-1",
                ExpectedHeadDto::Empty,
            ))
            .unwrap();
        repository
            .remove(RemoveRequestDto {
                project_id: "project-a".to_owned(),
                delete_id: "delete-1".to_owned(),
                expected_head: ExpectedHeadDto::Match {
                    version: saved.head_version,
                },
            })
            .unwrap();
        connection_value(&repository, |connection| {
            if mode == "missing" {
                connection
                    .execute(
                        "DELETE FROM project_heads WHERE project_id = 'project-a'",
                        [],
                    )
                    .unwrap();
            } else if mode == "bad-crc" {
                connection
                    .execute(
                        "UPDATE project_heads SET head_crc32 = 'crc32:00000000'
                         WHERE project_id = 'project-a'",
                        [],
                    )
                    .unwrap();
            } else {
                let head = read_head_row(connection, "project-a").unwrap().unwrap();
                let checksum =
                    head_crc32("project-a", head.generation_seq, &head.head_version, false);
                connection
                    .execute(
                        "UPDATE project_heads SET deleted = 0, head_crc32 = ?1
                         WHERE project_id = 'project-a'",
                        params![checksum],
                    )
                    .unwrap();
            }
        });
        assert!(repository.load("project-a".to_owned()).unwrap().is_none());
        assert!(repository.list().unwrap().is_empty());
        assert_eq!(
            repository
                .save(save_request(
                    "project-a",
                    "Must remain deleted",
                    2,
                    &format!("repair-{mode}"),
                    ExpectedHeadDto::Repair,
                ))
                .unwrap_err()
                .code,
            PersistenceErrorCode::Conflict,
            "{mode}"
        );
    }
}

#[test]
fn repair_cannot_overwrite_future_generation_evidence_when_head_is_missing_or_corrupt() {
    for mode in ["missing", "bad-crc"] {
        let (_directory, repository) = initialized_repository();
        repository
            .save(save_request(
                "project-a",
                "Current",
                1,
                "write-1",
                ExpectedHeadDto::Empty,
            ))
            .unwrap();
        connection_value(&repository, |connection| {
            let mut generation = read_generation_by_operation(
                connection,
                "project-a",
                GenerationKind::Save,
                "write-1",
            )
            .unwrap()
            .unwrap();
            let mut future: Value =
                serde_json::from_str(&project_json("project-a", "Future", 2)).unwrap();
            future["schemaVersion"] = json!(999);
            let payload = serde_json::to_vec(&future).unwrap();
            generation.payload_crc32 = Some(crc32(&payload));
            generation.payload_bytes = i64::try_from(payload.len()).unwrap();
            generation.payload_json = Some(payload);
            generation.title = Some("Future".to_owned());
            generation.updated_at = Some("2026-07-10T00:00:02.000Z".to_owned());
            let digest = GenerationDigest {
                project_id: &generation.project_id,
                kind: &generation.kind,
                operation_id: &generation.operation_id,
                head_version: &generation.head_version,
                parent_head_version: generation.parent_head_version.as_deref(),
                activation_id: generation.activation_id.as_deref(),
                revision: generation.revision,
                predecessor_write_id: generation.predecessor_write_id.as_deref(),
                saved_at: &generation.saved_at,
                payload_crc32: generation.payload_crc32.as_deref(),
                payload_bytes: generation.payload_bytes,
                title: generation.title.as_deref(),
                updated_at: generation.updated_at.as_deref(),
                branch_source: generation.branch_source.as_deref(),
            };
            generation.record_crc32 = digest_crc32(&digest);
            connection
                .execute(
                    "UPDATE project_generations
                     SET payload_json = ?1, payload_crc32 = ?2, payload_bytes = ?3,
                         title = ?4, updated_at = ?5, record_crc32 = ?6
                     WHERE seq = ?7",
                    params![
                        generation.payload_json,
                        generation.payload_crc32,
                        generation.payload_bytes,
                        generation.title,
                        generation.updated_at,
                        generation.record_crc32,
                        generation.seq,
                    ],
                )
                .unwrap();
            if mode == "missing" {
                connection
                    .execute(
                        "DELETE FROM project_heads WHERE project_id = 'project-a'",
                        [],
                    )
                    .unwrap();
            } else {
                connection
                    .execute(
                        "UPDATE project_heads SET head_crc32 = 'crc32:00000000'
                         WHERE project_id = 'project-a'",
                        [],
                    )
                    .unwrap();
            }
        });
        assert_eq!(
            repository
                .save(save_request(
                    "project-a",
                    "Overwrite denied",
                    3,
                    &format!("repair-{mode}"),
                    ExpectedHeadDto::Repair,
                ))
                .unwrap_err()
                .code,
            PersistenceErrorCode::UnsupportedVersion,
            "{mode} save"
        );
        assert_eq!(
            repository
                .remove(RemoveRequestDto {
                    project_id: "project-a".to_owned(),
                    delete_id: format!("delete-{mode}"),
                    expected_head: ExpectedHeadDto::Repair,
                })
                .unwrap_err()
                .code,
            PersistenceErrorCode::UnsupportedVersion,
            "{mode} remove"
        );
    }
}

#[test]
fn recovers_previous_valid_generation_when_current_payload_is_corrupt() {
    let (_directory, repository) = initialized_repository();
    let first = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository
        .save(save_request(
            "project-a",
            "Second",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: first.head_version,
            },
        ))
        .unwrap();

    connection_value(&repository, |connection| {
        connection
            .execute(
                "UPDATE project_generations SET payload_json = x'7b7d'
                 WHERE project_id = 'project-a' AND operation_id = 'write-2'",
                [],
            )
            .unwrap();
    });
    let recovered = repository
        .load("project-a".to_owned())
        .unwrap()
        .expect("older generation recovers");
    let recovered_json: Value = serde_json::from_str(&recovered.project_json).unwrap();
    assert_eq!(recovered_json["title"], "First");
    assert!(recovered.recovered);
    assert_eq!(recovered.head_version, None);
    assert_eq!(
        recovered.recovery_reason,
        Some(ProjectRecoveryReason::GenerationCorrupt)
    );
    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Ready {
            recovered: true,
            ..
        }]
    ));
}

#[test]
fn recovers_latest_valid_generation_when_head_is_missing() {
    let (_directory, repository) = initialized_repository();
    repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    connection_value(&repository, |connection| {
        connection
            .execute(
                "DELETE FROM project_heads WHERE project_id = 'project-a'",
                [],
            )
            .unwrap();
    });
    let recovered = repository
        .load("project-a".to_owned())
        .unwrap()
        .expect("generation recovers");
    assert_eq!(
        recovered.recovery_reason,
        Some(ProjectRecoveryReason::HeadMissing)
    );
    assert_eq!(recovered.head_version, None);
}

#[test]
fn newer_project_schema_is_sticky_and_does_not_fall_back() {
    let (_directory, repository) = initialized_repository();
    let first = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository
        .save(save_request(
            "project-a",
            "Second",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: first.head_version,
            },
        ))
        .unwrap();

    connection_value(&repository, |connection| {
        let mut generation =
            read_generation_by_operation(connection, "project-a", GenerationKind::Save, "write-2")
                .unwrap()
                .unwrap();
        let mut value: Value =
            serde_json::from_slice(generation.payload_json.as_ref().unwrap()).unwrap();
        value["schemaVersion"] = json!(999);
        let payload = serde_json::to_vec(&value).unwrap();
        generation.payload_crc32 = Some(crc32(&payload));
        generation.payload_bytes = i64::try_from(payload.len()).unwrap();
        generation.payload_json = Some(payload.clone());
        let digest = GenerationDigest {
            project_id: &generation.project_id,
            kind: &generation.kind,
            operation_id: &generation.operation_id,
            head_version: &generation.head_version,
            parent_head_version: generation.parent_head_version.as_deref(),
            activation_id: generation.activation_id.as_deref(),
            revision: generation.revision,
            predecessor_write_id: generation.predecessor_write_id.as_deref(),
            saved_at: &generation.saved_at,
            payload_crc32: generation.payload_crc32.as_deref(),
            payload_bytes: generation.payload_bytes,
            title: generation.title.as_deref(),
            updated_at: generation.updated_at.as_deref(),
            branch_source: generation.branch_source.as_deref(),
        };
        generation.record_crc32 = digest_crc32(&digest);
        connection
            .execute(
                "UPDATE project_generations
                 SET payload_json = ?1, payload_crc32 = ?2, payload_bytes = ?3, record_crc32 = ?4
                 WHERE seq = ?5",
                params![
                    payload,
                    generation.payload_crc32,
                    generation.payload_bytes,
                    generation.record_crc32,
                    generation.seq,
                ],
            )
            .unwrap();
    });

    assert_eq!(
        repository.load("project-a".to_owned()).unwrap_err().code,
        PersistenceErrorCode::UnsupportedVersion
    );
    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Unreadable {
            error_code: UnreadableProjectErrorCode::UnsupportedVersion,
            ..
        }]
    ));
}

#[test]
fn active_head_scans_all_newer_rows_for_unsupported_evidence_without_mutation() {
    let (_directory, repository) = initialized_repository();
    let project_id = "future-above-active";
    let first = repository
        .save(save_request(
            project_id,
            "Head H1",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let second = repository
        .save(save_request(
            project_id,
            "Future H2",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: first.head_version.clone(),
            },
        ))
        .unwrap();
    let third = repository
        .save(save_request(
            project_id,
            "Valid unpointed H3",
            3,
            "write-3",
            ExpectedHeadDto::Match {
                version: second.head_version,
            },
        ))
        .unwrap();
    assert_eq!(third.write_id, "write-3");
    let future = rewrite_save_generation_as_future(&repository, project_id, "write-2");
    assert_eq!(
        validate_generation(&future),
        Err(GenerationIssue::Unsupported),
        "the future row must retain valid record and payload checksums"
    );
    let pointed_head = repoint_active_head(&repository, project_id, "write-1");
    assert_eq!(pointed_head.head_version, first.head_version);
    let before = raw_native_rows(&repository, project_id);

    let summaries = repository.list().unwrap();
    let [ProjectSummaryDto::Unreadable {
        id,
        error_code: UnreadableProjectErrorCode::UnsupportedVersion,
        branches,
    }] = summaries.as_slice()
    else {
        panic!("future canonical evidence must be sticky")
    };
    assert_eq!(id, project_id);
    assert!(branches.is_empty());
    let expected_load = PersistenceErrorDto::new(
        RepositoryOperation::Load,
        PersistenceErrorCode::UnsupportedVersion,
        RetryPolicy::Never,
        Some(project_id),
    );
    assert_eq!(
        repository.load(project_id.to_owned()).unwrap_err(),
        expected_load
    );
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Unreadable
    );
    assert_eq!(
        repository
            .save(save_request(
                project_id,
                "Blocked save",
                5,
                "blocked-write",
                ExpectedHeadDto::Match {
                    version: first.head_version.clone(),
                },
            ))
            .unwrap_err(),
        PersistenceErrorDto::new(
            RepositoryOperation::Save,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            Some(project_id),
        )
    );
    assert_eq!(
        repository
            .remove(RemoveRequestDto {
                project_id: project_id.to_owned(),
                delete_id: "blocked-delete".to_owned(),
                expected_head: ExpectedHeadDto::Match {
                    version: first.head_version,
                },
            })
            .unwrap_err(),
        PersistenceErrorDto::new(
            RepositoryOperation::Remove,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            Some(project_id),
        )
    );
    assert_eq!(raw_native_rows(&repository, project_id), before);
}

#[test]
fn future_branch_is_project_wide_sticky_and_blocks_idempotent_save_retry() {
    let (_directory, repository) = initialized_repository();
    let project_id = "future-branch-active";
    let original = save_request(
        project_id,
        "Active H1",
        1,
        "write-1",
        ExpectedHeadDto::Empty,
    );
    let active = repository.save(original.clone()).unwrap();
    repository
        .save(save_request(
            project_id,
            "Future branch",
            2,
            "branch-write",
            ExpectedHeadDto::Match {
                version: active.head_version.clone(),
            },
        ))
        .unwrap();
    let branch_sequence =
        mark_generation_as_branch(&repository, project_id, "branch-write", "recovery-journal");
    let future = rewrite_save_generation_as_future(&repository, project_id, "branch-write");
    assert_eq!(future.branch_source.as_deref(), Some("recovery-journal"));
    assert_eq!(
        validate_generation(&future),
        Err(GenerationIssue::Unsupported)
    );
    repoint_active_head(&repository, project_id, "write-1");
    let before = raw_native_rows(&repository, project_id);
    let expected_load = PersistenceErrorDto::new(
        RepositoryOperation::Load,
        PersistenceErrorCode::UnsupportedVersion,
        RetryPolicy::Never,
        Some(project_id),
    );

    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Unreadable {
            error_code: UnreadableProjectErrorCode::UnsupportedVersion,
            branches,
            ..
        }] if branches.is_empty()
    ));
    assert_eq!(
        repository.load(project_id.to_owned()).unwrap_err(),
        expected_load
    );
    assert_eq!(
        repository
            .load_branch(
                project_id.to_owned(),
                format!("sqlite-generation:{branch_sequence}"),
            )
            .unwrap_err(),
        expected_load
    );
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Unreadable
    );
    assert_eq!(
        repository.save(original).unwrap_err(),
        PersistenceErrorDto::new(
            RepositoryOperation::Save,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            Some(project_id),
        ),
        "a response-loss retry must not bypass later sticky evidence"
    );
    assert_eq!(
        repository
            .remove(RemoveRequestDto {
                project_id: project_id.to_owned(),
                delete_id: "blocked-delete".to_owned(),
                expected_head: ExpectedHeadDto::Match {
                    version: active.head_version,
                },
            })
            .unwrap_err(),
        PersistenceErrorDto::new(
            RepositoryOperation::Remove,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            Some(project_id),
        )
    );
    assert_eq!(raw_native_rows(&repository, project_id), before);
}

#[test]
fn verified_deleted_head_preserves_future_branch_on_same_delete_retry() {
    let (_directory, repository) = initialized_repository();
    let project_id = "deleted-with-future-branch";
    let branch_candidate = repository
        .save(save_request(
            project_id,
            "Will become a future branch",
            1,
            "branch-write",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let canonical_candidate = repository
        .save(save_request(
            project_id,
            "Will remain future canonical history",
            2,
            "canonical-write",
            ExpectedHeadDto::Match {
                version: branch_candidate.head_version,
            },
        ))
        .unwrap();
    let remove_request = RemoveRequestDto {
        project_id: project_id.to_owned(),
        delete_id: "delete-1".to_owned(),
        expected_head: ExpectedHeadDto::Match {
            version: canonical_candidate.head_version,
        },
    };
    assert!(
        repository
            .remove(remove_request.clone())
            .unwrap()
            .cleanup_complete
    );
    let branch_sequence =
        mark_generation_as_branch(&repository, project_id, "branch-write", "legacy-migration");
    rewrite_save_generation_as_future(&repository, project_id, "branch-write");
    let future_canonical =
        rewrite_save_generation_as_future(&repository, project_id, "canonical-write");
    assert_eq!(future_canonical.branch_source, None);
    let before = raw_native_rows(&repository, project_id);

    assert!(repository.list().unwrap().is_empty());
    assert!(repository.load(project_id.to_owned()).unwrap().is_none());
    assert!(repository
        .load_branch(
            project_id.to_owned(),
            format!("sqlite-generation:{branch_sequence}"),
        )
        .unwrap()
        .is_none());
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );
    let retry = repository.remove(remove_request).unwrap();
    assert!(retry.removed);
    assert!(!retry.cleanup_complete);
    assert_eq!(raw_native_rows(&repository, project_id), before);
}

#[test]
fn unsupported_history_older_than_the_pointed_active_head_is_still_sticky() {
    let (_directory, repository) = initialized_repository();
    let project_id = "older-future-history";
    let first = repository
        .save(save_request(
            project_id,
            "H1",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let second = repository
        .save(save_request(
            project_id,
            "Future H2",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: first.head_version,
            },
        ))
        .unwrap();
    let third_request = save_request(
        project_id,
        "Pointed H3",
        3,
        "write-3",
        ExpectedHeadDto::Match {
            version: second.head_version,
        },
    );
    let third = repository.save(third_request.clone()).unwrap();
    rewrite_save_generation_as_future(&repository, project_id, "write-2");
    let before = raw_native_rows(&repository, project_id);

    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Unreadable {
            error_code: UnreadableProjectErrorCode::UnsupportedVersion,
            ..
        }]
    ));
    assert_eq!(
        repository.load(project_id.to_owned()).unwrap_err().code,
        PersistenceErrorCode::UnsupportedVersion
    );
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Unreadable
    );
    assert_eq!(
        repository.save(third_request).unwrap_err(),
        PersistenceErrorDto::new(
            RepositoryOperation::Save,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            Some(project_id),
        )
    );
    assert_eq!(
        repository
            .remove(RemoveRequestDto {
                project_id: project_id.to_owned(),
                delete_id: "blocked-delete".to_owned(),
                expected_head: ExpectedHeadDto::Match {
                    version: third.head_version,
                },
            })
            .unwrap_err()
            .code,
        PersistenceErrorCode::UnsupportedVersion
    );
    assert_eq!(raw_native_rows(&repository, project_id), before);
}

#[test]
fn unsupported_history_dominates_missing_corrupt_and_relationship_bad_heads() {
    for (head_mode, newer_kind) in [
        ("missing", "save"),
        ("bad-crc", "delete"),
        ("bad-relationship", "save"),
    ] {
        let (_directory, repository) = initialized_repository();
        let project_id = format!("future-{head_mode}-{newer_kind}");
        let first = repository
            .save(save_request(
                &project_id,
                "Future H1",
                1,
                "write-1",
                ExpectedHeadDto::Empty,
            ))
            .unwrap();
        if newer_kind == "save" {
            repository
                .save(save_request(
                    &project_id,
                    "Newer save",
                    2,
                    "write-2",
                    ExpectedHeadDto::Match {
                        version: first.head_version,
                    },
                ))
                .unwrap();
        } else {
            repository
                .remove(RemoveRequestDto {
                    project_id: project_id.clone(),
                    delete_id: "delete-2".to_owned(),
                    expected_head: ExpectedHeadDto::Match {
                        version: first.head_version,
                    },
                })
                .unwrap();
        }
        let future = rewrite_save_generation_as_future(&repository, &project_id, "write-1");
        connection_value(&repository, |connection| match head_mode {
            "missing" => {
                connection
                    .execute(
                        "DELETE FROM project_heads WHERE project_id = ?1",
                        params![project_id],
                    )
                    .unwrap();
            }
            "bad-crc" => {
                connection
                    .execute(
                        "UPDATE project_heads SET head_crc32 = 'crc32:00000000'
                         WHERE project_id = ?1",
                        params![project_id],
                    )
                    .unwrap();
            }
            "bad-relationship" => {
                let head = read_head_row(connection, &project_id).unwrap().unwrap();
                let checksum =
                    head_crc32(&project_id, future.seq, &head.head_version, head.deleted);
                connection
                    .execute(
                        "UPDATE project_heads
                         SET generation_seq = ?1, head_crc32 = ?2
                         WHERE project_id = ?3",
                        params![future.seq, checksum, project_id],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        });
        let before = raw_native_rows(&repository, &project_id);

        assert!(matches!(
            repository.list().unwrap().as_slice(),
            [ProjectSummaryDto::Unreadable {
                error_code: UnreadableProjectErrorCode::UnsupportedVersion,
                ..
            }]
        ));
        assert_eq!(
            repository.load(project_id.clone()).unwrap_err().code,
            PersistenceErrorCode::UnsupportedVersion
        );
        assert_eq!(
            repository
                .get_project_state(project_id.clone())
                .unwrap()
                .state,
            ProjectStateValue::Unreadable
        );
        assert_eq!(
            repository
                .save(save_request(
                    &project_id,
                    "Blocked repair",
                    3,
                    "blocked-write",
                    ExpectedHeadDto::Repair,
                ))
                .unwrap_err()
                .code,
            PersistenceErrorCode::UnsupportedVersion
        );
        assert_eq!(
            repository
                .remove(RemoveRequestDto {
                    project_id: project_id.clone(),
                    delete_id: "blocked-delete".to_owned(),
                    expected_head: ExpectedHeadDto::Repair,
                })
                .unwrap_err()
                .code,
            PersistenceErrorCode::UnsupportedVersion
        );
        assert_eq!(raw_native_rows(&repository, &project_id), before);
    }
}

#[test]
fn valid_unpointed_save_and_delete_rows_do_not_replace_a_verified_active_head() {
    for newer_kind in ["save", "delete"] {
        let (_directory, repository) = initialized_repository();
        let project_id = format!("unpointed-{newer_kind}");
        let first = repository
            .save(save_request(
                &project_id,
                "Pointed H1",
                1,
                "write-1",
                ExpectedHeadDto::Empty,
            ))
            .unwrap();
        if newer_kind == "save" {
            repository
                .save(save_request(
                    &project_id,
                    "Unpointed H2",
                    2,
                    "write-2",
                    ExpectedHeadDto::Match {
                        version: first.head_version.clone(),
                    },
                ))
                .unwrap();
        } else {
            repository
                .remove(RemoveRequestDto {
                    project_id: project_id.clone(),
                    delete_id: "delete-2".to_owned(),
                    expected_head: ExpectedHeadDto::Match {
                        version: first.head_version.clone(),
                    },
                })
                .unwrap();
        }
        repoint_active_head(&repository, &project_id, "write-1");
        let before = raw_native_rows(&repository, &project_id);

        let loaded = repository
            .load(project_id.clone())
            .unwrap()
            .expect("the verified H1 remains authoritative");
        assert_eq!(loaded.head_version, Some(first.head_version));
        assert_eq!(
            serde_json::from_str::<Value>(&loaded.project_json).unwrap()["title"],
            "Pointed H1"
        );
        assert!(matches!(
            repository.list().unwrap().as_slice(),
            [ProjectSummaryDto::Ready {
                title,
                recovered: false,
                ..
            }] if title == "Pointed H1"
        ));
        assert_eq!(
            repository
                .get_project_state(project_id.clone())
                .unwrap()
                .state,
            ProjectStateValue::Active
        );
        assert_eq!(raw_native_rows(&repository, &project_id), before);
    }
}

#[test]
fn loads_an_explicit_retained_generation_branch() {
    let (_directory, repository) = initialized_repository();
    let saved = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let current = repository
        .save(save_request(
            "project-a",
            "Second",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: saved.head_version,
            },
        ))
        .unwrap();
    let sequence =
        mark_generation_as_branch(&repository, "project-a", "write-1", "interrupted-save");
    let branch_id = format!("sqlite-generation:{sequence}");
    let branch = repository
        .load_branch("project-a".to_owned(), branch_id.clone())
        .unwrap()
        .expect("retained branch");
    assert_eq!(branch.branch_id, branch_id);
    assert_eq!(branch.source, ProjectBranchSource::InterruptedSave);
    assert_eq!(branch.write_id, "write-1");
    assert_eq!(
        serde_json::from_str::<Value>(&branch.project_json).unwrap()["id"],
        "project-a"
    );
    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Ready { branches, .. }]
            if branches.len() == 1 && branches[0].branch_id == branch_id
    ));
    let current_sequence = connection_value(&repository, |connection| {
        read_generation_by_operation(connection, "project-a", GenerationKind::Save, "write-2")
            .unwrap()
            .unwrap()
            .seq
    });
    assert!(repository
        .load_branch(
            "project-a".to_owned(),
            format!("sqlite-generation:{current_sequence}"),
        )
        .unwrap()
        .is_none());
    assert_eq!(
        repository
            .load("project-a".to_owned())
            .unwrap()
            .unwrap()
            .head_version,
        Some(current.head_version)
    );
}

#[test]
fn canonical_history_is_hidden_but_corrupt_head_pointer_does_not_hide_explicit_branch() {
    let (_directory, repository) = initialized_repository();
    let first = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository
        .save(save_request(
            "project-a",
            "Second",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: first.head_version,
            },
        ))
        .unwrap();
    let first_sequence = connection_value(&repository, |connection| {
        read_generation_by_operation(connection, "project-a", GenerationKind::Save, "write-1")
            .unwrap()
            .unwrap()
            .seq
    });
    assert!(repository
        .load_branch(
            "project-a".to_owned(),
            format!("sqlite-generation:{first_sequence}"),
        )
        .unwrap()
        .is_none());
    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Ready { branches, .. }] if branches.is_empty()
    ));

    let branch_sequence =
        mark_generation_as_branch(&repository, "project-a", "write-2", "interrupted-save");
    connection_value(&repository, |connection| {
        let branch = read_generation_by_seq(connection, branch_sequence)
            .unwrap()
            .unwrap();
        let checksum = head_crc32("project-a", branch_sequence, &branch.head_version, false);
        connection
            .execute(
                "UPDATE project_heads
                 SET generation_seq = ?1, head_version = ?2, deleted = 0, head_crc32 = ?3
                 WHERE project_id = 'project-a'",
                params![branch_sequence, branch.head_version, checksum],
            )
            .unwrap();
    });
    let summaries = repository.list().unwrap();
    let [ProjectSummaryDto::Ready {
        recovered: true,
        branches,
        ..
    }] = summaries.as_slice()
    else {
        panic!("canonical ancestor should recover");
    };
    assert_eq!(branches.len(), 1);
    assert!(repository
        .load_branch("project-a".to_owned(), branches[0].branch_id.clone())
        .unwrap()
        .is_some());
}

#[test]
fn retained_generation_count_excludes_explicit_branches_and_remove_cleans_them() {
    let (_directory, repository) = initialized_repository();
    let first = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let second = repository
        .save(save_request(
            "project-a",
            "Second",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: first.head_version,
            },
        ))
        .unwrap();
    mark_generation_as_branch(&repository, "project-a", "write-1", "recovery-journal");
    let third = repository
        .save(save_request(
            "project-a",
            "Third",
            3,
            "write-3",
            ExpectedHeadDto::Match {
                version: second.head_version,
            },
        ))
        .unwrap();
    assert_eq!(third.retained_generations, 2);
    repository
        .remove(RemoveRequestDto {
            project_id: "project-a".to_owned(),
            delete_id: "delete-1".to_owned(),
            expected_head: ExpectedHeadDto::Match {
                version: third.head_version,
            },
        })
        .unwrap();
    assert_eq!(
        connection_value(&repository, |connection| {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM project_generations
                     WHERE project_id = 'project-a' AND branch_source IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        }),
        0
    );
}

#[test]
fn legacy_snapshot_stages_then_applies_atomically_and_marks_versioned_completion() {
    let (_directory, repository) = initialized_repository();
    let legacy_json = project_json("legacy-a", "Legacy", 1);
    let snapshot = legacy_snapshot(
        &[("cts.project.legacy-a", legacy_json.as_str())],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let recaptured = legacy_snapshot(
        &[("cts.project.legacy-a", legacy_json.as_str())],
        "2026-07-10T00:01:00.000Z",
    );
    assert_eq!(recaptured.content_checksum, snapshot.content_checksum);
    assert_ne!(recaptured.checksum, snapshot.checksum);
    repository.backup_legacy_snapshot(recaptured).unwrap();
    assert!(
        !repository
            .get_legacy_migration_status(snapshot.content_checksum.clone(), 1)
            .unwrap()
            .complete
    );

    let request = legacy_head_request(&snapshot, "legacy-a", "Legacy", 1);
    assert_eq!(
        repository
            .import_legacy_project(request.clone())
            .unwrap()
            .status,
        LegacyProjectImportStatus::Imported
    );
    assert_eq!(
        repository.import_legacy_project(request).unwrap().status,
        LegacyProjectImportStatus::Imported
    );
    assert!(repository.load("legacy-a".to_owned()).unwrap().is_none());

    let wrong = legacy_completion(&snapshot, 0, 0, 0);
    assert_eq!(
        repository
            .complete_legacy_migration(wrong)
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    assert!(repository.load("legacy-a".to_owned()).unwrap().is_none());

    let completion = legacy_completion(&snapshot, 1, 0, 0);
    repository
        .complete_legacy_migration(completion.clone())
        .unwrap();
    repository.complete_legacy_migration(completion).unwrap();
    assert_eq!(
        repository
            .import_legacy_project(legacy_head_request(&snapshot, "legacy-a", "Legacy", 1,))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    assert!(
        repository
            .get_legacy_migration_status(snapshot.content_checksum.clone(), 1)
            .unwrap()
            .complete
    );
    let loaded = repository
        .load("legacy-a".to_owned())
        .unwrap()
        .expect("completed stage is promoted");
    assert_eq!(
        serde_json::from_str::<Value>(&loaded.project_json).unwrap()["title"],
        "Legacy"
    );
}

#[test]
fn higher_completed_head_retires_same_snapshot_diagnostic_and_reopens_without_mutation() {
    let (_directory, repository) = initialized_repository();
    let project_id = "superseded-diagnostic";
    let project = project_json(project_id, "Migrated by v2", 2);
    let mirror_key = format!("cts.project.{project_id}");
    let snapshot = legacy_snapshot(&[(mirror_key.as_str(), project.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();

    // This represents an already-completed older migrator whose diagnosis is retained for audit.
    // Current import validation intentionally would not diagnose a valid v1 project.
    seed_completed_legacy_diagnostic(
        &repository,
        &snapshot,
        1,
        project_id,
        UnreadableProjectErrorCode::MigrationFailed,
    );
    assert_eq!(
        repository.load(project_id.to_owned()).unwrap_err().code,
        PersistenceErrorCode::MigrationFailed
    );

    repository
        .import_legacy_project(legacy_head_request_at_version(
            &snapshot,
            2,
            project_id,
            "Migrated by v2",
            2,
        ))
        .unwrap();
    assert_eq!(
        repository.load(project_id.to_owned()).unwrap_err().code,
        PersistenceErrorCode::MigrationFailed,
        "an incomplete higher migration must not supersede the completed v1 diagnosis"
    );
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 2, 1, 0, 0))
        .unwrap();

    let loaded = repository
        .load(project_id.to_owned())
        .unwrap()
        .expect("v2 head becomes canonical");
    assert_eq!(
        loaded.head_version.as_deref(),
        Some(format!("sqlite:v1:legacy:v2:{}", snapshot.content_checksum).as_str())
    );
    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Ready {
            id,
            title,
            branches,
            ..
        }] if id == project_id && title == "Migrated by v2" && branches.is_empty()
    ));
    connection_value(&repository, |connection| {
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM legacy_project_staging
                     WHERE content_checksum = ?1 AND project_id = ?2",
                    params![snapshot.content_checksum, project_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2,
            "both versioned staging records remain as immutable audit input"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT storage_value FROM legacy_migration_records
                     WHERE content_checksum = ?1 AND storage_key = ?2",
                    params![snapshot.content_checksum, mirror_key.as_bytes()],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .unwrap(),
            project.as_bytes()
        );
    });

    let audit_before_reads = legacy_audit_fingerprint(&repository);
    let native_before_reads = raw_native_rows(&repository, project_id);
    repository.list().unwrap();
    repository.load(project_id.to_owned()).unwrap();
    repository.get_project_state(project_id.to_owned()).unwrap();
    assert_eq!(legacy_audit_fingerprint(&repository), audit_before_reads);
    assert_eq!(
        raw_native_rows(&repository, project_id),
        native_before_reads
    );

    repository.close().unwrap();
    repository.initialize().unwrap();
    assert!(repository.load(project_id.to_owned()).unwrap().is_some());
    assert_eq!(legacy_audit_fingerprint(&repository), audit_before_reads);
    assert_eq!(
        raw_native_rows(&repository, project_id),
        native_before_reads
    );
}

#[test]
fn higher_completed_corrupt_diagnostic_retires_same_snapshot_unsupported_diagnostic() {
    let (_directory, repository) = initialized_repository();
    let project_id = "unsupported-then-corrupt";
    let mirror_key = format!("cts.project.{project_id}");
    let future = serde_json::to_string(&json!({
        "id": project_id,
        "schemaVersion": 999,
        "title": "Future",
    }))
    .unwrap();
    let snapshot = legacy_snapshot(&[(mirror_key.as_str(), future.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_diagnostic_request_at_version(
            &snapshot,
            1,
            project_id,
            UnreadableProjectErrorCode::UnsupportedVersion,
        ))
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 1, 0, 1, 0))
        .unwrap();
    assert_eq!(
        repository.load(project_id.to_owned()).unwrap_err().code,
        PersistenceErrorCode::UnsupportedVersion
    );

    repository
        .import_legacy_project(legacy_diagnostic_request_at_version(
            &snapshot,
            2,
            project_id,
            UnreadableProjectErrorCode::CorruptData,
        ))
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 2, 0, 1, 0))
        .unwrap();
    assert_eq!(
        repository.load(project_id.to_owned()).unwrap_err().code,
        PersistenceErrorCode::CorruptData
    );
    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Unreadable {
            id,
            error_code: UnreadableProjectErrorCode::CorruptData,
            ..
        }] if id == project_id
    ));
    connection_value(&repository, |connection| {
        let diagnostics = connection
            .prepare(
                "SELECT migration_version, diagnostic_error_code
                 FROM legacy_project_staging
                 WHERE content_checksum = ?1 AND project_id = ?2
                 ORDER BY migration_version",
            )
            .unwrap()
            .query_map(params![snapshot.content_checksum, project_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            diagnostics,
            vec![
                (1, "unsupported-version".to_owned()),
                (2, "corrupt-data".to_owned()),
            ]
        );
    });
}

#[test]
fn incomplete_higher_migration_never_supersedes_completed_lower_authority_after_reopen() {
    let (_directory, repository) = initialized_repository();
    let project_id = "incomplete-v2";
    let mirror_key = format!("cts.project.{project_id}");
    let future = serde_json::to_string(&json!({
        "id": project_id,
        "schemaVersion": 999,
    }))
    .unwrap();
    let snapshot = legacy_snapshot(&[(mirror_key.as_str(), future.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_diagnostic_request_at_version(
            &snapshot,
            1,
            project_id,
            UnreadableProjectErrorCode::UnsupportedVersion,
        ))
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 1, 0, 1, 0))
        .unwrap();
    repository
        .import_legacy_project(legacy_diagnostic_request_at_version(
            &snapshot,
            2,
            project_id,
            UnreadableProjectErrorCode::CorruptData,
        ))
        .unwrap();
    assert!(
        !repository
            .get_legacy_migration_status(snapshot.content_checksum.clone(), 2)
            .unwrap()
            .complete
    );

    let audit_before_reads = legacy_audit_fingerprint(&repository);
    let native_before_reads = raw_native_rows(&repository, project_id);
    for _ in 0..2 {
        assert_eq!(
            repository.load(project_id.to_owned()).unwrap_err().code,
            PersistenceErrorCode::UnsupportedVersion
        );
        assert!(matches!(
            repository.list().unwrap().as_slice(),
            [ProjectSummaryDto::Unreadable {
                error_code: UnreadableProjectErrorCode::UnsupportedVersion,
                ..
            }]
        ));
    }
    assert_eq!(legacy_audit_fingerprint(&repository), audit_before_reads);
    assert_eq!(
        raw_native_rows(&repository, project_id),
        native_before_reads
    );

    repository.close().unwrap();
    repository.initialize().unwrap();
    assert_eq!(
        repository.load(project_id.to_owned()).unwrap_err().code,
        PersistenceErrorCode::UnsupportedVersion
    );
    assert_eq!(legacy_audit_fingerprint(&repository), audit_before_reads);
    assert_eq!(
        raw_native_rows(&repository, project_id),
        native_before_reads
    );
}

#[test]
fn higher_completed_head_replaces_same_snapshot_lower_head_as_canonical() {
    let (_directory, repository) = initialized_repository();
    let project_id = "head-v1-to-v2";
    let project = project_json(project_id, "Same payload", 1);
    let mirror_key = format!("cts.project.{project_id}");
    let snapshot = legacy_snapshot(&[(mirror_key.as_str(), project.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_head_request_at_version(
            &snapshot,
            1,
            project_id,
            "Same payload",
            1,
        ))
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 1, 1, 0, 0))
        .unwrap();
    repository
        .import_legacy_project(legacy_head_request_at_version(
            &snapshot,
            2,
            project_id,
            "Same payload",
            1,
        ))
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 2, 1, 0, 0))
        .unwrap();

    let loaded = repository.load(project_id.to_owned()).unwrap().unwrap();
    assert_eq!(
        loaded.head_version,
        Some(format!("sqlite:v1:legacy:v2:{}", snapshot.content_checksum))
    );
    let (head, generations) = raw_native_rows(&repository, project_id);
    assert!(head.is_some_and(|head| head.head_version.contains(":legacy:v2:")));
    assert_eq!(
        generations.len(),
        2,
        "the v1 materialization remains auditable"
    );
    assert!(generations
        .iter()
        .any(|generation| generation.head_version.contains(":legacy:v1:")));
    assert!(generations
        .iter()
        .any(|generation| generation.head_version.contains(":legacy:v2:")));
}

#[test]
fn unknown_future_migration_version_is_rejected_without_staging_or_completion() {
    let (_directory, repository) = initialized_repository();
    let future_version = LEGACY_MIGRATION_VERSION + 1;
    let project_id = "future-migrator";
    let project = project_json(project_id, "Future", 1);
    let mirror_key = format!("cts.project.{project_id}");
    let snapshot = legacy_snapshot(&[(mirror_key.as_str(), project.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let audit_before = legacy_audit_fingerprint(&repository);

    assert_eq!(
        repository
            .import_legacy_project(legacy_head_request_at_version(
                &snapshot,
                future_version,
                project_id,
                "Future",
                1,
            ))
            .unwrap_err()
            .code,
        PersistenceErrorCode::UnsupportedVersion
    );
    assert_eq!(
        repository
            .complete_legacy_migration(legacy_completion_at_version(
                &snapshot,
                future_version,
                1,
                0,
                0,
            ))
            .unwrap_err()
            .code,
        PersistenceErrorCode::UnsupportedVersion
    );
    assert_eq!(
        repository
            .get_legacy_migration_status(snapshot.content_checksum, future_version)
            .unwrap_err()
            .code,
        PersistenceErrorCode::UnsupportedVersion
    );
    assert_eq!(legacy_audit_fingerprint(&repository), audit_before);
}

#[test]
fn persisted_future_migration_evidence_blocks_runtime_and_reopen_without_mutation() {
    let future_version = i64::try_from(LEGACY_MIGRATION_VERSION + 1).unwrap();
    for evidence in ["staging", "run"] {
        let (directory, repository) = initialized_repository();
        let path = directory.path().join("projects.sqlite3");
        let project_id = format!("persisted-future-{evidence}");
        let mirror_key = format!("cts.project.{project_id}");
        let raw = format!("{{broken-{evidence}");
        let snapshot = legacy_snapshot(&[(mirror_key.as_str(), raw.as_str())], CREATED_AT);
        repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
        connection_value(&repository, |connection| match evidence {
            "staging" => {
                connection
                    .execute(
                        "INSERT INTO legacy_project_staging (
                           content_checksum, migration_version, project_id, source_keys_json,
                           candidate_kind, candidate_operation_id,
                           diagnostic_error_code, staged_at
                         ) VALUES (?1, ?2, ?3, ?4, 'diagnostic', 'diagnostic',
                                   'migration-failed', ?5)",
                        params![
                            snapshot.content_checksum,
                            future_version,
                            project_id,
                            serde_json::to_vec(&vec![mirror_key]).unwrap(),
                            CREATED_AT,
                        ],
                    )
                    .unwrap();
            }
            "run" => {
                connection
                    .execute(
                        "INSERT INTO legacy_migration_runs (
                           content_checksum, migration_version, completed_at, record_count,
                           total_bytes, ready_project_count, unreadable_project_count, branch_count
                         ) VALUES (?1, ?2, ?3, 1, ?4, 0, 0, 0)",
                        params![
                            snapshot.content_checksum,
                            future_version,
                            CREATED_AT,
                            i64::try_from(snapshot.total_bytes).unwrap(),
                        ],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        });
        let audit_before = legacy_audit_fingerprint(&repository);
        assert_eq!(
            repository.list().unwrap_err(),
            PersistenceErrorDto::new(
                RepositoryOperation::List,
                PersistenceErrorCode::UnsupportedVersion,
                RetryPolicy::Never,
                None,
            ),
            "{evidence} must fail closed at runtime"
        );
        assert_eq!(legacy_audit_fingerprint(&repository), audit_before);

        repository.close().unwrap();
        let connection = Connection::open(&path).unwrap();
        let audit_before_reopen = legacy_audit_fingerprint_from_connection(&connection);
        drop(connection);
        let reopened = NativeRepository::new(path.clone());
        assert_eq!(
            reopened.initialize().unwrap_err(),
            PersistenceErrorDto::new(
                RepositoryOperation::Initialize,
                PersistenceErrorCode::UnsupportedVersion,
                RetryPolicy::Never,
                None,
            ),
            "{evidence} must fail closed before reopening the repository"
        );
        let connection = Connection::open(path).unwrap();
        assert_eq!(
            legacy_audit_fingerprint_from_connection(&connection),
            audit_before_reopen,
            "failed initialization must not rewrite future evidence"
        );
    }
}

#[test]
fn higher_completed_branch_is_the_only_live_branch_for_the_same_snapshot() {
    let (_directory, repository) = initialized_repository();
    let project_id = "branch-v1-to-v2";
    let branch_json = project_json(project_id, "Recovered", 2);
    let recovery_key = format!("cts.persistence.v1.project.{project_id}.recovery.activation-a");
    let recovery_raw = legacy_recovery_raw(
        project_id,
        &branch_json,
        "activation-a",
        2,
        "recovery-write",
        CREATED_AT,
    );
    let snapshot = legacy_snapshot(
        &[(recovery_key.as_str(), recovery_raw.as_str())],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let request = |migration_version| LegacyProjectImportRequestDto {
        content_checksum: snapshot.content_checksum.clone(),
        migration_version,
        project_id: project_id.to_owned(),
        source_keys: vec![recovery_key.clone()],
        project_json: Some(branch_json.clone()),
        branch: Some(LegacyBranchCandidateDto {
            source: ProjectBranchSource::RecoveryJournal,
            activation_id: "activation-a".to_owned(),
            revision: 2,
            write_id: "recovery-write".to_owned(),
            saved_at: CREATED_AT.to_owned(),
        }),
        diagnostic: None,
    };
    repository.import_legacy_project(request(1)).unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 1, 0, 0, 1))
        .unwrap();
    let first_branch_id = match repository.list().unwrap().as_slice() {
        [ProjectSummaryDto::Unreadable { branches, .. }] if branches.len() == 1 => {
            branches[0].branch_id.clone()
        }
        summaries => panic!("expected exactly one v1 branch, got {summaries:?}"),
    };

    repository.import_legacy_project(request(2)).unwrap();
    assert!(repository
        .load_branch(project_id.to_owned(), first_branch_id.clone())
        .unwrap()
        .is_some());
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 2, 0, 0, 1))
        .unwrap();

    let summaries = repository.list().unwrap();
    let [ProjectSummaryDto::Unreadable { branches, .. }] = summaries.as_slice() else {
        panic!("branch-only project remains recoverable");
    };
    assert_eq!(branches.len(), 1);
    assert_ne!(branches[0].branch_id, first_branch_id);
    assert!(repository
        .load_branch(project_id.to_owned(), first_branch_id)
        .unwrap()
        .is_none());
    let live_branch = repository
        .load_branch(project_id.to_owned(), branches[0].branch_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(live_branch.write_id, "recovery-write");
    connection_value(&repository, |connection| {
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM legacy_project_staging
                     WHERE content_checksum = ?1 AND project_id = ?2
                       AND candidate_kind = 'branch'",
                    params![snapshot.content_checksum, project_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
    });
}

#[test]
fn deleted_only_snapshot_remains_deleted_across_v1_v2_reopen_and_idempotent_completion() {
    let (directory, repository) = initialized_repository();
    let project_id = "deleted-v1-to-v2";
    let prefix = format!("cts.persistence.v1.project.{project_id}.");
    let generation_key = format!("{prefix}gen.000000000001.delete-1");
    let tombstone = legacy_tombstone_raw(project_id, 1, None, "delete-1", CREATED_AT);
    let head = legacy_head_raw(
        project_id,
        "deleted",
        1,
        &generation_key,
        "delete-1",
        None,
        None,
        CREATED_AT,
        true,
    );
    let head_key = format!("{prefix}head");
    let snapshot = legacy_snapshot(
        &[
            (generation_key.as_str(), tombstone.as_str()),
            (head_key.as_str(), head.as_str()),
        ],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 1, 0, 0, 0))
        .unwrap();
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );
    let native_after_v1 = raw_native_rows(&repository, project_id);

    let completion_v2 = legacy_completion_at_version(&snapshot, 2, 0, 0, 0);
    repository
        .complete_legacy_migration(completion_v2.clone())
        .unwrap();
    let audit_after_v2 = legacy_audit_fingerprint(&repository);
    repository.complete_legacy_migration(completion_v2).unwrap();
    assert_eq!(raw_native_rows(&repository, project_id), native_after_v1);
    assert_eq!(legacy_audit_fingerprint(&repository), audit_after_v2);
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );

    repository.close().unwrap();
    let reopened = NativeRepository::new(directory.path().join("projects.sqlite3"));
    reopened.initialize().unwrap();
    assert_eq!(
        reopened
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );
    assert_eq!(raw_native_rows(&reopened, project_id), native_after_v1);
    assert_eq!(legacy_audit_fingerprint(&reopened), audit_after_v2);
}

#[test]
fn deleted_project_and_v2_diagnostic_overlap_rolls_back_without_mutation() {
    let (_directory, repository) = initialized_repository();
    let project_id = "deleted-diagnostic-overlap";
    let prefix = format!("cts.persistence.v1.project.{project_id}.");
    let generation_key = format!("{prefix}gen.000000000001.delete-1");
    let tombstone = legacy_tombstone_raw(project_id, 1, None, "delete-1", CREATED_AT);
    let head = legacy_head_raw(
        project_id,
        "deleted",
        1,
        &generation_key,
        "delete-1",
        None,
        None,
        CREATED_AT,
        true,
    );
    let head_key = format!("{prefix}head");
    let snapshot = legacy_snapshot(
        &[
            (generation_key.as_str(), tombstone.as_str()),
            (head_key.as_str(), head.as_str()),
        ],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 1, 0, 0, 0))
        .unwrap();
    repository
        .import_legacy_project(legacy_diagnostic_request_at_version(
            &snapshot,
            2,
            project_id,
            UnreadableProjectErrorCode::CorruptData,
        ))
        .unwrap();
    let audit_before = legacy_audit_fingerprint(&repository);
    let native_before = raw_native_rows(&repository, project_id);

    assert_eq!(
        repository
            .complete_legacy_migration(legacy_completion_at_version(&snapshot, 2, 0, 1, 0))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    assert_eq!(legacy_audit_fingerprint(&repository), audit_before);
    assert_eq!(raw_native_rows(&repository, project_id), native_before);
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );
}

#[test]
fn deleted_project_and_v2_branch_overlap_rolls_back_without_mutation() {
    let (_directory, repository) = initialized_repository();
    let project_id = "deleted-branch-overlap";
    let prefix = format!("cts.persistence.v1.project.{project_id}.");
    let generation_key = format!("{prefix}gen.000000000001.delete-1");
    let recovery_key = format!("{prefix}recovery.activation-next");
    let tombstone = legacy_tombstone_raw(project_id, 1, None, "delete-1", CREATED_AT);
    let head = legacy_head_raw(
        project_id,
        "deleted",
        1,
        &generation_key,
        "delete-1",
        None,
        None,
        CREATED_AT,
        true,
    );
    let recovery_project = project_json(project_id, "Must stay deleted", 2);
    let recovery = legacy_recovery_raw(
        project_id,
        &recovery_project,
        "activation-next",
        2,
        "write-next",
        CREATED_AT,
    );
    let head_key = format!("{prefix}head");
    let snapshot = legacy_snapshot(
        &[
            (generation_key.as_str(), tombstone.as_str()),
            (head_key.as_str(), head.as_str()),
            (recovery_key.as_str(), recovery.as_str()),
        ],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .complete_legacy_migration(legacy_completion_at_version(&snapshot, 1, 0, 0, 0))
        .unwrap();
    repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: snapshot.content_checksum.clone(),
            migration_version: 2,
            project_id: project_id.to_owned(),
            source_keys: snapshot
                .entries
                .iter()
                .map(|entry| entry.key.clone())
                .collect(),
            project_json: Some(recovery_project),
            branch: Some(LegacyBranchCandidateDto {
                source: ProjectBranchSource::RecoveryJournal,
                activation_id: "activation-next".to_owned(),
                revision: 2,
                write_id: "write-next".to_owned(),
                saved_at: CREATED_AT.to_owned(),
            }),
            diagnostic: None,
        })
        .unwrap();
    let audit_before = legacy_audit_fingerprint(&repository);
    let native_before = raw_native_rows(&repository, project_id);

    assert_eq!(
        repository
            .complete_legacy_migration(legacy_completion_at_version(&snapshot, 2, 0, 0, 1))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    assert_eq!(legacy_audit_fingerprint(&repository), audit_before);
    assert_eq!(raw_native_rows(&repository, project_id), native_before);
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );
}

#[test]
fn causal_recovery_and_interrupted_intent_are_authoritative_legacy_heads() {
    for recovery_mode in [true, false] {
        let (_directory, repository) = initialized_repository();
        let project_id = if recovery_mode {
            "recovery-a"
        } else {
            "intent-a"
        };
        let committed_json = project_json(project_id, "Committed", 1);
        let recovered_json = project_json(project_id, "Recovered", 2);
        let prefix = format!("cts.persistence.v1.project.{project_id}.");
        let committed_key = format!("{prefix}gen.000000000001.write-head");
        let next_key = format!("{prefix}gen.000000000002.write-next");
        let head_version = "1:active:write-head";
        let committed_raw = legacy_generation_raw(
            project_id,
            &committed_json,
            1,
            None,
            "activation-head",
            1,
            "write-head",
            CREATED_AT,
        );
        let committed_payload_checksum = crc32(committed_json.as_bytes());
        let head_raw = legacy_head_raw(
            project_id,
            "active",
            1,
            &committed_key,
            "write-head",
            None,
            Some(&committed_payload_checksum),
            CREATED_AT,
            true,
        );
        let mut entries = vec![
            (committed_key.clone(), committed_raw),
            (format!("{prefix}head"), head_raw),
            (format!("cts.project.{project_id}"), committed_json.clone()),
        ];
        if recovery_mode {
            entries.push((
                format!("{prefix}recovery.activation-next"),
                legacy_recovery_raw_with_base(
                    project_id,
                    &recovered_json,
                    "activation-next",
                    2,
                    "write-next",
                    CREATED_AT,
                    head_version,
                ),
            ));
        } else {
            entries.push((
                next_key.clone(),
                legacy_generation_raw(
                    project_id,
                    &recovered_json,
                    2,
                    Some(head_version),
                    "activation-next",
                    2,
                    "write-next",
                    CREATED_AT,
                ),
            ));
            entries.push((
                format!("{prefix}intent"),
                legacy_intent_raw(project_id, &next_key, "write-next", Some(head_version)),
            ));
        }
        let borrowed = entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        let snapshot = legacy_snapshot(&borrowed, CREATED_AT);
        repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
        let mut request = legacy_head_request(&snapshot, project_id, "Recovered", 2);
        request.project_json = Some(recovered_json);
        repository.import_legacy_project(request).unwrap();
        repository
            .complete_legacy_migration(legacy_completion(&snapshot, 1, 0, 0))
            .unwrap();
        let loaded = repository
            .load(project_id.to_owned())
            .unwrap()
            .expect("causal candidate promoted");
        assert_eq!(
            serde_json::from_str::<Value>(&loaded.project_json).unwrap()["title"],
            "Recovered"
        );
    }
}

#[test]
fn known_empty_first_save_recovery_is_an_authoritative_legacy_head() {
    let (_directory, repository) = initialized_repository();
    let project_id = "first-save-recovery";
    let recovered = project_json(project_id, "First save", 1);
    let recovery_key = format!("cts.persistence.v1.project.{project_id}.recovery.activation-a");
    let recovery = legacy_recovery_raw_known_empty(
        project_id,
        &recovered,
        "activation-a",
        1,
        "write-a",
        CREATED_AT,
    );
    let snapshot = legacy_snapshot(&[(recovery_key.as_str(), recovery.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let mut request = legacy_head_request(&snapshot, project_id, "First save", 1);
    request.project_json = Some(recovered);
    repository.import_legacy_project(request).unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 1, 0, 0))
        .unwrap();
    let loaded = repository
        .load(project_id.to_owned())
        .unwrap()
        .expect("known-empty recovery is promoted");
    assert_eq!(
        serde_json::from_str::<Value>(&loaded.project_json).unwrap()["title"],
        "First save"
    );
}

#[test]
fn causal_recovery_can_replace_a_corrupt_pointed_generation() {
    let (_directory, repository) = initialized_repository();
    let project_id = "corrupt-pointed-recovery";
    let committed = project_json(project_id, "Committed", 1);
    let recovered = project_json(project_id, "Recovered", 2);
    let prefix = format!("cts.persistence.v1.project.{project_id}.");
    let generation_key = format!("{prefix}gen.000000000001.write-head");
    let payload_checksum = crc32(committed.as_bytes());
    let head = legacy_head_raw(
        project_id,
        "active",
        1,
        &generation_key,
        "write-head",
        None,
        Some(&payload_checksum),
        CREATED_AT,
        true,
    );
    let recovery = legacy_recovery_raw_with_base(
        project_id,
        &recovered,
        "activation-next",
        2,
        "write-next",
        CREATED_AT,
        "1:active:write-head",
    );
    let entries = [
        (generation_key, "{corrupt".to_owned()),
        (format!("{prefix}head"), head),
        (format!("{prefix}recovery.activation-next"), recovery),
    ];
    let borrowed = entries
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let snapshot = legacy_snapshot(&borrowed, CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let mut request = legacy_head_request(&snapshot, project_id, "Recovered", 2);
    request.project_json = Some(recovered);
    repository.import_legacy_project(request).unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 1, 0, 0))
        .unwrap();
    let loaded = repository
        .load(project_id.to_owned())
        .unwrap()
        .expect("causal recovery replaces corrupt pointed generation");
    assert_eq!(
        serde_json::from_str::<Value>(&loaded.project_json).unwrap()["title"],
        "Recovered"
    );
}

#[test]
fn missing_head_intent_historical_recovery_and_parent_fallback_are_authoritative() {
    for mode in ["intent", "historical-recovery", "parent-fallback"] {
        let (_directory, repository) = initialized_repository();
        let project_id = format!("authority-{mode}");
        let prefix = format!("cts.persistence.v1.project.{project_id}.");
        let canonical = project_json(&project_id, "Recovered authority", 2);
        let entries = match mode {
            "intent" => {
                let generation_key = format!("{prefix}gen.000000000001.write-intent");
                vec![
                    (
                        generation_key.clone(),
                        legacy_generation_raw(
                            &project_id,
                            &canonical,
                            1,
                            None,
                            "activation-intent",
                            2,
                            "write-intent",
                            CREATED_AT,
                        ),
                    ),
                    (
                        format!("{prefix}intent"),
                        legacy_intent_raw(&project_id, &generation_key, "write-intent", None),
                    ),
                ]
            }
            "historical-recovery" => {
                let historical = project_json(&project_id, "Historical", 1);
                let generation_key = format!("{prefix}gen.000000000001.write-history");
                vec![
                    (
                        generation_key,
                        legacy_generation_raw(
                            &project_id,
                            &historical,
                            1,
                            None,
                            "activation-history",
                            1,
                            "write-history",
                            CREATED_AT,
                        ),
                    ),
                    (format!("{prefix}head"), "{corrupt".to_owned()),
                    (
                        format!("{prefix}recovery.activation-next"),
                        legacy_recovery_raw_with_base(
                            &project_id,
                            &canonical,
                            "activation-next",
                            2,
                            "write-next",
                            CREATED_AT,
                            "1:active:write-history",
                        ),
                    ),
                ]
            }
            "parent-fallback" => {
                let parent_key = format!("{prefix}gen.000000000001.write-parent");
                let corrupt_key = format!("{prefix}gen.000000000002.write-corrupt");
                let corrupt_payload = project_json(&project_id, "Corrupt current", 3);
                vec![
                    (
                        parent_key,
                        legacy_generation_raw(
                            &project_id,
                            &canonical,
                            1,
                            None,
                            "activation-parent",
                            2,
                            "write-parent",
                            CREATED_AT,
                        ),
                    ),
                    (corrupt_key.clone(), "{corrupt".to_owned()),
                    (
                        format!("{prefix}head"),
                        legacy_head_raw(
                            &project_id,
                            "active",
                            2,
                            &corrupt_key,
                            "write-corrupt",
                            Some("1:active:write-parent"),
                            Some(&crc32(corrupt_payload.as_bytes())),
                            CREATED_AT,
                            true,
                        ),
                    ),
                ]
            }
            _ => unreachable!(),
        };
        let borrowed = entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        let snapshot = legacy_snapshot(&borrowed, CREATED_AT);
        repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
        let mut request = legacy_head_request(&snapshot, &project_id, "Recovered authority", 2);
        request.project_json = Some(canonical.clone());
        repository.import_legacy_project(request).unwrap();
        repository
            .complete_legacy_migration(legacy_completion(&snapshot, 1, 0, 0))
            .unwrap();
        assert_eq!(
            repository
                .load(project_id)
                .unwrap()
                .map(|loaded| loaded.project_json),
            Some(canonical),
            "{mode}"
        );
    }
}

#[test]
fn conflicting_eligible_recoveries_cannot_be_authorized_by_filtering_requested_payload() {
    let (_directory, repository) = initialized_repository();
    let project_id = "recovery-conflict";
    let committed = project_json(project_id, "Committed", 1);
    let first = project_json(project_id, "First recovery", 2);
    let second = project_json(project_id, "Second recovery", 3);
    let prefix = format!("cts.persistence.v1.project.{project_id}.");
    let generation_key = format!("{prefix}gen.000000000001.write-head");
    let generation = legacy_generation_raw(
        project_id,
        &committed,
        1,
        None,
        "activation-head",
        1,
        "write-head",
        CREATED_AT,
    );
    let payload_checksum = crc32(committed.as_bytes());
    let head = legacy_head_raw(
        project_id,
        "active",
        1,
        &generation_key,
        "write-head",
        None,
        Some(&payload_checksum),
        CREATED_AT,
        true,
    );
    let first_recovery = legacy_recovery_raw_with_base(
        project_id,
        &first,
        "activation-a",
        2,
        "write-a",
        CREATED_AT,
        "1:active:write-head",
    );
    let second_recovery = legacy_recovery_raw_with_base(
        project_id,
        &second,
        "activation-b",
        3,
        "write-b",
        CREATED_AT,
        "1:active:write-head",
    );
    let entries = [
        (generation_key, generation),
        (format!("{prefix}head"), head),
        (format!("{prefix}recovery.activation-a"), first_recovery),
        (format!("{prefix}recovery.activation-b"), second_recovery),
        (format!("cts.project.{project_id}"), committed),
    ];
    let borrowed = entries
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let snapshot = legacy_snapshot(&borrowed, CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let mut request = legacy_head_request(&snapshot, project_id, "First recovery", 2);
    request.project_json = Some(first);
    assert_eq!(
        repository.import_legacy_project(request).unwrap_err().code,
        PersistenceErrorCode::MigrationFailed
    );
}

#[test]
fn divergent_recoveries_can_complete_as_one_diagnostic_with_two_branches() {
    let (_directory, repository) = initialized_repository();
    let project_id = "divergent-recoveries";
    let first = project_json(project_id, "Draft A", 1);
    let second = project_json(project_id, "Draft B", 2);
    let prefix = format!("cts.persistence.v1.project.{project_id}.");
    let first_recovery = legacy_recovery_raw_known_empty(
        project_id,
        &first,
        "activation-a",
        1,
        "write-a",
        CREATED_AT,
    );
    let second_saved_at = "2026-07-10T00:00:02.000Z";
    let second_recovery = legacy_recovery_raw_known_empty(
        project_id,
        &second,
        "activation-b",
        2,
        "write-b",
        second_saved_at,
    );
    let entries = [
        (format!("{prefix}recovery.activation-a"), first_recovery),
        (format!("{prefix}recovery.activation-b"), second_recovery),
    ];
    let borrowed = entries
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let snapshot = legacy_snapshot(&borrowed, CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let source_keys = snapshot
        .entries
        .iter()
        .map(|entry| entry.key.clone())
        .collect::<Vec<_>>();
    repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: snapshot.content_checksum.clone(),
            migration_version: 1,
            project_id: project_id.to_owned(),
            source_keys: source_keys.clone(),
            project_json: None,
            branch: None,
            diagnostic: Some(LegacyDiagnosticDto {
                error_code: UnreadableProjectErrorCode::Conflict,
            }),
        })
        .unwrap();
    for (project_json, activation_id, revision, write_id, saved_at) in [
        (first, "activation-a", 1, "write-a", CREATED_AT),
        (second, "activation-b", 2, "write-b", second_saved_at),
    ] {
        repository
            .import_legacy_project(LegacyProjectImportRequestDto {
                content_checksum: snapshot.content_checksum.clone(),
                migration_version: 1,
                project_id: project_id.to_owned(),
                source_keys: source_keys.clone(),
                project_json: Some(project_json),
                branch: Some(LegacyBranchCandidateDto {
                    source: ProjectBranchSource::RecoveryJournal,
                    activation_id: activation_id.to_owned(),
                    revision,
                    write_id: write_id.to_owned(),
                    saved_at: saved_at.to_owned(),
                }),
                diagnostic: None,
            })
            .unwrap();
    }
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 0, 1, 2))
        .unwrap();
    let summaries = repository.list().unwrap();
    let [ProjectSummaryDto::Unreadable {
        error_code,
        branches,
        ..
    }] = summaries.as_slice()
    else {
        panic!("divergent recoveries remain quarantined");
    };
    assert_eq!(*error_code, UnreadableProjectErrorCode::Conflict);
    assert_eq!(branches.len(), 2);
}

#[test]
fn bare_legacy_tombstone_generation_blocks_project_promotion() {
    for head_mode in ["missing", "corrupt"] {
        let (_directory, repository) = initialized_repository();
        let project_id = format!("legacy-tombstone-{head_mode}");
        let old = project_json(&project_id, "Old", 1);
        let recovery = project_json(&project_id, "Must stay hidden", 2);
        let prefix = format!("cts.persistence.v1.project.{project_id}.");
        let old_key = format!("{prefix}gen.000000000001.write-old");
        let tombstone_key = format!("{prefix}gen.000000000002.delete-1");
        let mut entries = vec![
            (
                old_key,
                legacy_generation_raw(
                    &project_id,
                    &old,
                    1,
                    None,
                    "activation-old",
                    1,
                    "write-old",
                    CREATED_AT,
                ),
            ),
            (
                tombstone_key,
                legacy_tombstone_raw(
                    &project_id,
                    2,
                    Some("1:active:write-old"),
                    "delete-1",
                    CREATED_AT,
                ),
            ),
            (
                format!("{prefix}recovery.activation-next"),
                legacy_recovery_raw_with_base(
                    &project_id,
                    &recovery,
                    "activation-next",
                    2,
                    "write-next",
                    CREATED_AT,
                    "1:active:write-old",
                ),
            ),
            (format!("cts.project.{project_id}"), old),
        ];
        if head_mode == "corrupt" {
            entries.push((format!("{prefix}head"), "{corrupt".to_owned()));
        }
        let borrowed = entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        let snapshot = legacy_snapshot(&borrowed, CREATED_AT);
        repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
        repository
            .import_legacy_project(LegacyProjectImportRequestDto {
                content_checksum: snapshot.content_checksum.clone(),
                migration_version: 1,
                project_id: project_id.clone(),
                source_keys: snapshot
                    .entries
                    .iter()
                    .map(|entry| entry.key.clone())
                    .collect(),
                project_json: None,
                branch: None,
                diagnostic: Some(LegacyDiagnosticDto {
                    error_code: UnreadableProjectErrorCode::CorruptData,
                }),
            })
            .unwrap();
        repository
            .complete_legacy_migration(legacy_completion(&snapshot, 0, 1, 0))
            .unwrap();
        assert_eq!(
            repository.get_project_state(project_id).unwrap().state,
            ProjectStateValue::Unreadable,
            "{head_mode}"
        );
    }
}

#[test]
fn malformed_deleted_heads_do_not_authorize_legacy_tombstones() {
    for (operation_id, ordinal) in [("", 1), ("delete-1", JS_MAX_SAFE_INTEGER + 1)] {
        let (_directory, repository) = initialized_repository();
        let project_id = format!("bad-deleted-{ordinal}");
        let prefix = format!("cts.persistence.v1.project.{project_id}.");
        let head = legacy_head_raw(
            &project_id,
            "deleted",
            ordinal,
            &format!("{prefix}gen.{ordinal}.delete-1"),
            operation_id,
            None,
            None,
            CREATED_AT,
            true,
        );
        let head_key = format!("{prefix}head");
        let snapshot = legacy_snapshot(&[(head_key.as_str(), head.as_str())], CREATED_AT);
        repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
        repository
            .import_legacy_project(LegacyProjectImportRequestDto {
                content_checksum: snapshot.content_checksum.clone(),
                migration_version: 1,
                project_id: project_id.clone(),
                source_keys: vec![head_key],
                project_json: None,
                branch: None,
                diagnostic: Some(LegacyDiagnosticDto {
                    error_code: UnreadableProjectErrorCode::CorruptData,
                }),
            })
            .unwrap();
        repository
            .complete_legacy_migration(legacy_completion(&snapshot, 0, 1, 0))
            .unwrap();
        assert_eq!(
            repository.get_project_state(project_id).unwrap().state,
            ProjectStateValue::Unreadable
        );
    }
}

#[test]
fn legacy_deleted_head_is_sticky_without_a_valid_tombstone_and_never_overwrites_native() {
    let project_id = "deleted-legacy";
    let prefix = format!("cts.persistence.v1.project.{project_id}.");
    let head_raw = legacy_head_raw(
        project_id,
        "deleted",
        1,
        &format!("{prefix}gen.000000000001.delete-1"),
        "delete-1",
        None,
        None,
        CREATED_AT,
        true,
    );
    let head_key = format!("{prefix}head");
    let snapshot = legacy_snapshot(&[(head_key.as_str(), &head_raw)], CREATED_AT);

    let (_directory, repository) = initialized_repository();
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 0, 0, 0))
        .unwrap();
    assert_eq!(
        repository
            .get_project_state(project_id.to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );

    let (_directory, repository) = initialized_repository();
    let native = repository
        .save(save_request(
            project_id,
            "Native",
            1,
            "native-write",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 0, 0, 0))
        .unwrap();
    assert_eq!(
        repository
            .load(project_id.to_owned())
            .unwrap()
            .unwrap()
            .head_version,
        Some(native.head_version)
    );
}

#[test]
fn older_active_head_without_payload_checksum_still_authorizes_pointed_generation() {
    let (_directory, repository) = initialized_repository();
    let project_id = "older-head";
    let project = project_json(project_id, "Older", 1);
    let prefix = format!("cts.persistence.v1.project.{project_id}.");
    let generation_key = format!("{prefix}gen.000000000001.write-1");
    let generation = legacy_generation_raw(
        project_id,
        &project,
        1,
        None,
        "activation-1",
        1,
        "write-1",
        CREATED_AT,
    );
    let head = legacy_head_raw(
        project_id,
        "active",
        1,
        &generation_key,
        "write-1",
        None,
        None,
        CREATED_AT,
        false,
    );
    let head_key = format!("{prefix}head");
    let snapshot = legacy_snapshot(
        &[
            (generation_key.as_str(), &generation),
            (head_key.as_str(), &head),
        ],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_head_request(&snapshot, project_id, "Older", 1))
        .unwrap();
}

#[test]
fn javascript_snapshot_checksum_fixtures_and_blob_bytes_match_exactly() {
    let (_directory, repository) = initialized_repository();
    let simple = LegacyStorageSnapshotDto {
        storage_version: 1,
        created_at: CREATED_AT.to_owned(),
        entries: vec![
            LegacyStorageSnapshotRecordDto {
                key: "cts.persistence.v1.project.alpha.head".to_owned(),
                value: "{\"storageVersion\":1}".to_owned(),
                value_bytes: 20,
                checksum: "crc32:6fe01f32".to_owned(),
            },
            LegacyStorageSnapshotRecordDto {
                key: "cts.project.alpha".to_owned(),
                value: "{\"id\":\"alpha\",\"title\":\"A\"}".to_owned(),
                value_bytes: 26,
                checksum: "crc32:7316318e".to_owned(),
            },
        ],
        total_bytes: 100,
        content_checksum: "crc32:ae3448e0".to_owned(),
        checksum: "crc32:584a4702".to_owned(),
    };
    repository.backup_legacy_snapshot(simple.clone()).unwrap();
    connection_value(&repository, |connection| {
        let rows = connection
            .prepare(
                "SELECT storage_key, storage_value, typeof(storage_key), typeof(storage_value)
                 FROM legacy_migration_records WHERE content_checksum = ?1 ORDER BY ordinal",
            )
            .unwrap()
            .query_map(params![simple.content_checksum], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows[0].0, simple.entries[0].key.as_bytes());
        assert_eq!(rows[0].1, simple.entries[0].value.as_bytes());
        assert_eq!(rows[0].2, "blob");
        assert_eq!(rows[0].3, "blob");
    });

    let complex_value = "{\"id\":\"日.本😀\",\"title\":\"引用\\\" 逆\\\\ 改行\\n 制御\\u0001\",\"separators\":\"\u{2028}\u{2029}\"}";
    let complex = LegacyStorageSnapshotDto {
        storage_version: 1,
        created_at: CREATED_AT.to_owned(),
        entries: vec![
            LegacyStorageSnapshotRecordDto {
                key: "cts.persistence.v1.project.%E6%97%A5%2E%E6%9C%AC%F0%9F%98%80.head".to_owned(),
                value: "{\"storageVersion\":1,\"projectId\":\"日.本😀\"}".to_owned(),
                value_bytes: 46,
                checksum: "crc32:128ab326".to_owned(),
            },
            LegacyStorageSnapshotRecordDto {
                key: "cts.project.日.本😀".to_owned(),
                value: complex_value.to_owned(),
                value_bytes: 89,
                checksum: "crc32:c1301c70".to_owned(),
            },
            LegacyStorageSnapshotRecordDto {
                key: "cts.project.\u{10000}".to_owned(),
                value: "supplementary".to_owned(),
                value_bytes: 13,
                checksum: "crc32:14015cca".to_owned(),
            },
            LegacyStorageSnapshotRecordDto {
                key: "cts.project.\u{e000}".to_owned(),
                value: "bmp-private".to_owned(),
                value_bytes: 11,
                checksum: "crc32:764902f3".to_owned(),
            },
        ],
        total_bytes: 278,
        content_checksum: "crc32:e7b735f6".to_owned(),
        checksum: "crc32:b8341226".to_owned(),
    };
    repository.backup_legacy_snapshot(complex.clone()).unwrap();
    repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: complex.content_checksum.clone(),
            migration_version: 1,
            project_id: "日.本😀".to_owned(),
            source_keys: vec![
                complex.entries[0].key.clone(),
                complex.entries[1].key.clone(),
            ],
            project_json: None,
            branch: None,
            diagnostic: Some(LegacyDiagnosticDto {
                error_code: UnreadableProjectErrorCode::CorruptData,
            }),
        })
        .unwrap();
}

#[test]
fn shared_typescript_and_rust_legacy_authority_corpus_stays_in_parity() {
    let corpus: LegacyParityCorpus = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../fixtures/persistence/legacy-migration-v1.json"
    )))
    .expect("shared legacy fixture corpus parses");
    let migration_version = corpus.version;
    assert_eq!(migration_version, LEGACY_MIGRATION_VERSION);
    for fixture in corpus.cases {
        let (_directory, repository) = initialized_repository();
        let borrowed = fixture
            .storage_entries
            .iter()
            .map(|entry| (entry.key.as_str(), entry.value.as_str()))
            .collect::<Vec<_>>();
        let snapshot = legacy_snapshot(&borrowed, &corpus.created_at);
        repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
        let source_keys = snapshot
            .entries
            .iter()
            .map(|entry| entry.key.clone())
            .collect::<Vec<_>>();
        for expected_import in fixture.expected_imports {
            let (project_json, branch, diagnostic) = match expected_import {
                LegacyParityImport::Head { project_json } => (Some(project_json), None, None),
                LegacyParityImport::Diagnostic { error_code } => {
                    (None, None, Some(LegacyDiagnosticDto { error_code }))
                }
                LegacyParityImport::Branch {
                    project_json,
                    source,
                    activation_id,
                    revision,
                    write_id,
                    saved_at,
                } => (
                    Some(project_json),
                    Some(LegacyBranchCandidateDto {
                        source,
                        activation_id,
                        revision,
                        write_id,
                        saved_at,
                    }),
                    None,
                ),
            };
            repository
                .import_legacy_project(LegacyProjectImportRequestDto {
                    content_checksum: snapshot.content_checksum.clone(),
                    migration_version,
                    project_id: fixture.project_id.clone(),
                    source_keys: source_keys.clone(),
                    project_json,
                    branch,
                    diagnostic,
                })
                .unwrap_or_else(|error| panic!("{} import failed: {error:?}", fixture.name));
        }
        repository
            .complete_legacy_migration(legacy_completion_at_version(
                &snapshot,
                migration_version,
                fixture.expected_completion.ready_project_count,
                fixture.expected_completion.unreadable_project_count,
                fixture.expected_completion.branch_count,
            ))
            .unwrap_or_else(|error| panic!("{} completion failed: {error:?}", fixture.name));
        match fixture.expected.status.as_str() {
            "ready" => {
                let loaded = repository
                    .load(fixture.project_id.clone())
                    .unwrap()
                    .map(|loaded| serde_json::from_str::<Value>(&loaded.project_json).unwrap());
                let expected = fixture
                    .expected
                    .canonical_project_json
                    .as_deref()
                    .map(|project_json| serde_json::from_str::<Value>(project_json).unwrap());
                assert_eq!(loaded, expected, "{}", fixture.name);
            }
            "unreadable" => {
                let summaries = repository.list().unwrap();
                let summary = summaries.iter().find(|summary| match summary {
                    ProjectSummaryDto::Ready { id, .. }
                    | ProjectSummaryDto::Unreadable { id, .. } => id == &fixture.project_id,
                });
                assert!(
                    matches!(
                        summary,
                        Some(ProjectSummaryDto::Unreadable { error_code, .. })
                            if Some(*error_code) == fixture.expected.error_code
                    ),
                    "{}",
                    fixture.name
                );
            }
            "deleted" => {
                assert!(repository
                    .load(fixture.project_id.clone())
                    .unwrap()
                    .is_none());
                assert_eq!(
                    repository
                        .get_project_state(fixture.project_id)
                        .unwrap()
                        .state,
                    ProjectStateValue::Deleted,
                    "{}",
                    fixture.name
                );
            }
            status => panic!("{} has unknown expected status {status}", fixture.name),
        }
    }
}

#[test]
fn legacy_completion_rolls_back_all_projects_when_one_stage_is_corrupt() {
    let (_directory, repository) = initialized_repository();
    let first_json = project_json("legacy-a", "A", 1);
    let second_json = project_json("legacy-b", "B", 1);
    let snapshot = legacy_snapshot(
        &[
            ("cts.project.legacy-a", first_json.as_str()),
            ("cts.project.legacy-b", second_json.as_str()),
        ],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_head_request(&snapshot, "legacy-a", "A", 1))
        .unwrap();
    repository
        .import_legacy_project(legacy_head_request(&snapshot, "legacy-b", "B", 1))
        .unwrap();
    connection_value(&repository, |connection| {
        connection
            .execute(
                "UPDATE legacy_project_staging SET payload_crc32 = 'crc32:00000000'
                 WHERE project_id = 'legacy-b'",
                [],
            )
            .unwrap();
    });
    assert!(repository
        .complete_legacy_migration(legacy_completion(&snapshot, 2, 0, 0))
        .is_err());
    assert!(repository.load("legacy-a".to_owned()).unwrap().is_none());
    assert!(repository.load("legacy-b".to_owned()).unwrap().is_none());
    assert!(
        !repository
            .get_legacy_migration_status(snapshot.content_checksum, 1)
            .unwrap()
            .complete
    );
}

#[test]
fn legacy_backup_gc_keeps_completed_audit_and_only_three_incomplete_snapshots() {
    let (_directory, repository) = initialized_repository();
    let completed = legacy_snapshot(&[("cts.project.done", "broken-done")], CREATED_AT);
    repository
        .backup_legacy_snapshot(completed.clone())
        .unwrap();
    repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: completed.content_checksum.clone(),
            migration_version: 1,
            project_id: "done".to_owned(),
            source_keys: vec!["cts.project.done".to_owned()],
            project_json: None,
            branch: None,
            diagnostic: Some(LegacyDiagnosticDto {
                error_code: UnreadableProjectErrorCode::CorruptData,
            }),
        })
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&completed, 0, 1, 0))
        .unwrap();

    let mut newest = String::new();
    for index in 0..5 {
        let key = format!("cts.project.incomplete-{index}");
        let value = format!("raw-{index}");
        let snapshot = legacy_snapshot(
            &[(key.as_str(), value.as_str())],
            &format!("2026-07-10T00:00:{index:02}.000Z"),
        );
        newest = snapshot.content_checksum.clone();
        repository.backup_legacy_snapshot(snapshot).unwrap();
    }
    connection_value(&repository, |connection| {
        let snapshot_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM legacy_migration_snapshots",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let incomplete_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM legacy_migration_snapshots AS snapshot
                 WHERE NOT EXISTS (
                   SELECT 1 FROM legacy_migration_runs AS run
                   WHERE run.content_checksum = snapshot.content_checksum
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(snapshot_count, 4);
        assert_eq!(incomplete_count, 3);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM legacy_migration_snapshots
                     WHERE content_checksum IN (?1, ?2)",
                    params![completed.content_checksum, newest],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
    });
}

#[test]
fn legacy_stage_rejects_unrelated_or_unproven_snapshot_sources() {
    let (_directory, repository) = initialized_repository();
    let other_json = project_json("other", "Other", 1);
    let snapshot = legacy_snapshot(&[("cts.project.other", other_json.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let mut request = LegacyProjectImportRequestDto {
        content_checksum: snapshot.content_checksum,
        migration_version: 1,
        project_id: "arbitrary".to_owned(),
        source_keys: vec!["cts.project.other".to_owned()],
        project_json: Some(project_json("arbitrary", "Injected", 1)),
        branch: None,
        diagnostic: None,
    };
    assert_eq!(
        repository
            .import_legacy_project(request.clone())
            .unwrap_err()
            .code,
        PersistenceErrorCode::MigrationFailed
    );
    request.source_keys = vec!["cts.project.arbitrary".to_owned()];
    assert_eq!(
        repository.import_legacy_project(request).unwrap_err().code,
        PersistenceErrorCode::MigrationFailed
    );

    let project = project_json("same", "Same", 1);
    let snapshot = legacy_snapshot(
        &[
            ("cts.persistence.v1.project.same.unknown", "archived"),
            ("cts.project.same", project.as_str()),
        ],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    let mut request = legacy_head_request(&snapshot, "same", "Same", 1);
    request.source_keys = vec!["cts.project.same".to_owned()];
    assert_eq!(
        repository.import_legacy_project(request).unwrap_err().code,
        PersistenceErrorCode::MigrationFailed
    );
}

#[test]
fn completion_rejects_omitting_any_project_represented_by_the_snapshot() {
    let (_directory, repository) = initialized_repository();
    let first = project_json("legacy-a", "A", 1);
    let second = project_json("legacy-b", "B", 1);
    let snapshot = legacy_snapshot(
        &[
            ("cts.project.legacy-a", first.as_str()),
            ("cts.project.legacy-b", second.as_str()),
        ],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_head_request(&snapshot, "legacy-a", "A", 1))
        .unwrap();
    assert_eq!(
        repository
            .complete_legacy_migration(legacy_completion(&snapshot, 1, 0, 0))
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
    assert!(repository.load("legacy-a".to_owned()).unwrap().is_none());
}

#[test]
fn tampered_archived_snapshot_fails_closed_for_every_migration_operation() {
    let (_directory, repository) = initialized_repository();
    let project = project_json("legacy-a", "Legacy", 1);
    let snapshot = legacy_snapshot(&[("cts.project.legacy-a", project.as_str())], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    connection_value(&repository, |connection| {
        connection
            .execute(
                "UPDATE legacy_migration_records SET storage_value = x'00'
                 WHERE content_checksum = ?1",
                params![snapshot.content_checksum],
            )
            .unwrap();
    });
    assert_eq!(
        repository
            .get_legacy_migration_status(snapshot.content_checksum.clone(), 1)
            .unwrap_err()
            .code,
        PersistenceErrorCode::MigrationFailed
    );
    assert_eq!(
        repository
            .import_legacy_project(legacy_head_request(&snapshot, "legacy-a", "Legacy", 1,))
            .unwrap_err()
            .code,
        PersistenceErrorCode::MigrationFailed
    );
    assert_eq!(
        repository
            .complete_legacy_migration(legacy_completion(&snapshot, 1, 0, 0))
            .unwrap_err()
            .code,
        PersistenceErrorCode::MigrationFailed
    );
    assert_eq!(
        repository
            .backup_legacy_snapshot(snapshot)
            .unwrap_err()
            .code,
        PersistenceErrorCode::MigrationFailed
    );
}

#[test]
fn legacy_head_conflict_becomes_visible_explicit_branch_without_moving_native_head() {
    let (_directory, repository) = initialized_repository();
    let native = repository
        .save(save_request(
            "project-a",
            "Native",
            1,
            "native-write",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    let legacy_json = project_json("project-a", "Legacy", 2);
    let snapshot = legacy_snapshot(
        &[("cts.project.project-a", legacy_json.as_str())],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_head_request(&snapshot, "project-a", "Legacy", 2))
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 1, 0, 0))
        .unwrap();

    let summaries = repository.list().unwrap();
    let [ProjectSummaryDto::Ready { branches, .. }] = summaries.as_slice() else {
        panic!("native head must remain ready");
    };
    assert_eq!(branches.len(), 1);
    assert_eq!(branches[0].source, ProjectBranchSource::LegacyMigration);
    let branch = repository
        .load_branch("project-a".to_owned(), branches[0].branch_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(branch.source, ProjectBranchSource::LegacyMigration);
    assert_eq!(
        serde_json::from_str::<Value>(&branch.project_json).unwrap()["title"],
        "Legacy"
    );
    assert_eq!(
        repository
            .load("project-a".to_owned())
            .unwrap()
            .unwrap()
            .head_version,
        Some(native.head_version)
    );
}

#[test]
fn migrated_recovery_branch_preserves_source_and_never_becomes_canonical() {
    let (_directory, repository) = initialized_repository();
    let branch_json = project_json("project-a", "Recovery", 2);
    let recovery_key = "cts.persistence.v1.project.project-a.recovery.activation-a";
    let recovery_raw = legacy_recovery_raw(
        "project-a",
        &branch_json,
        "activation-a",
        2,
        "recovery-write",
        CREATED_AT,
    );
    let snapshot = legacy_snapshot(&[(recovery_key, &recovery_raw)], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: snapshot.content_checksum.clone(),
            migration_version: 1,
            project_id: "project-a".to_owned(),
            source_keys: vec![recovery_key.to_owned()],
            project_json: Some(branch_json),
            branch: Some(LegacyBranchCandidateDto {
                source: ProjectBranchSource::RecoveryJournal,
                activation_id: "activation-a".to_owned(),
                revision: 2,
                write_id: "recovery-write".to_owned(),
                saved_at: CREATED_AT.to_owned(),
            }),
            diagnostic: None,
        })
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 0, 0, 1))
        .unwrap();

    assert!(repository.load("project-a".to_owned()).unwrap().is_none());
    let summaries = repository.list().unwrap();
    let [ProjectSummaryDto::Unreadable {
        error_code,
        branches,
        ..
    }] = summaries.as_slice()
    else {
        panic!("branch-only project must be recoverable but non-canonical");
    };
    assert_eq!(*error_code, UnreadableProjectErrorCode::Conflict);
    assert_eq!(branches.len(), 1);
    assert_eq!(branches[0].source, ProjectBranchSource::RecoveryJournal);
    assert_eq!(
        repository
            .load_branch("project-a".to_owned(), branches[0].branch_id.clone())
            .unwrap()
            .unwrap()
            .source,
        ProjectBranchSource::RecoveryJournal
    );
}

#[test]
fn completed_nonsticky_legacy_diagnostic_is_visible_without_canonical_state() {
    let (_directory, repository) = initialized_repository();
    let snapshot = legacy_snapshot(&[("cts.project.broken", "{broken")], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: snapshot.content_checksum.clone(),
            migration_version: 1,
            project_id: "broken".to_owned(),
            source_keys: vec!["cts.project.broken".to_owned()],
            project_json: None,
            branch: None,
            diagnostic: Some(LegacyDiagnosticDto {
                error_code: UnreadableProjectErrorCode::CorruptData,
            }),
        })
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 0, 1, 0))
        .unwrap();
    assert!(matches!(
        repository.list().unwrap().as_slice(),
        [ProjectSummaryDto::Unreadable {
            error_code: UnreadableProjectErrorCode::CorruptData,
            ..
        }]
    ));
    assert_eq!(
        repository.load("broken".to_owned()).unwrap_err().code,
        PersistenceErrorCode::CorruptData
    );
    assert_eq!(
        repository
            .get_project_state("broken".to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Unreadable
    );
}

#[test]
fn sticky_completed_diagnostics_dominate_active_head_and_hide_branches_without_mutation() {
    let scenarios = [
        (
            "sticky-migration",
            [
                UnreadableProjectErrorCode::MigrationFailed,
                UnreadableProjectErrorCode::CorruptData,
                UnreadableProjectErrorCode::Conflict,
            ],
            UnreadableProjectErrorCode::MigrationFailed,
            PersistenceErrorCode::MigrationFailed,
        ),
        (
            "sticky-unsupported",
            [
                UnreadableProjectErrorCode::MigrationFailed,
                UnreadableProjectErrorCode::UnsupportedVersion,
                UnreadableProjectErrorCode::CorruptData,
            ],
            UnreadableProjectErrorCode::UnsupportedVersion,
            PersistenceErrorCode::UnsupportedVersion,
        ),
    ];
    for (project_id, diagnostics, expected_unreadable, expected_error) in scenarios {
        let (_directory, repository) = initialized_repository();
        let first = repository
            .save(save_request(
                project_id,
                "Retained branch",
                1,
                "branch-write",
                ExpectedHeadDto::Empty,
            ))
            .unwrap();
        let active = repository
            .save(save_request(
                project_id,
                "Native active",
                2,
                "active-write",
                ExpectedHeadDto::Match {
                    version: first.head_version,
                },
            ))
            .unwrap();
        let branch_sequence =
            mark_generation_as_branch(&repository, project_id, "branch-write", "recovery-journal");
        for (index, diagnostic) in diagnostics.into_iter().enumerate() {
            complete_legacy_diagnostic_fixture(
                &repository,
                project_id,
                diagnostic,
                &format!("{project_id}-{index}"),
            );
        }
        let before = raw_native_rows(&repository, project_id);
        let branch_id = format!("sqlite-generation:{branch_sequence}");

        assert!(matches!(
            repository.list().unwrap().as_slice(),
            [ProjectSummaryDto::Unreadable {
                error_code,
                branches,
                ..
            }] if *error_code == expected_unreadable && branches.is_empty()
        ));
        let expected_load = PersistenceErrorDto::new(
            RepositoryOperation::Load,
            expected_error,
            RetryPolicy::Never,
            Some(project_id),
        );
        assert_eq!(
            repository.load(project_id.to_owned()).unwrap_err(),
            expected_load
        );
        assert_eq!(
            repository
                .load_branch(project_id.to_owned(), branch_id)
                .unwrap_err(),
            expected_load
        );
        assert_eq!(
            repository
                .get_project_state(project_id.to_owned())
                .unwrap()
                .state,
            ProjectStateValue::Unreadable
        );
        assert_eq!(
            repository
                .save(save_request(
                    project_id,
                    "Native active",
                    2,
                    "active-write",
                    ExpectedHeadDto::Match {
                        version: active.head_version.clone(),
                    },
                ))
                .unwrap_err(),
            PersistenceErrorDto::new(
                RepositoryOperation::Save,
                expected_error,
                RetryPolicy::Never,
                Some(project_id),
            ),
            "an idempotent retry must not bypass completed sticky evidence"
        );
        assert_eq!(
            repository
                .save(save_request(
                    project_id,
                    "Blocked",
                    3,
                    "blocked-write",
                    ExpectedHeadDto::Match {
                        version: active.head_version.clone(),
                    },
                ))
                .unwrap_err(),
            PersistenceErrorDto::new(
                RepositoryOperation::Save,
                expected_error,
                RetryPolicy::Never,
                Some(project_id),
            )
        );
        assert_eq!(
            repository
                .remove(RemoveRequestDto {
                    project_id: project_id.to_owned(),
                    delete_id: "blocked-delete".to_owned(),
                    expected_head: ExpectedHeadDto::Match {
                        version: active.head_version,
                    },
                })
                .unwrap_err(),
            PersistenceErrorDto::new(
                RepositoryOperation::Remove,
                expected_error,
                RetryPolicy::Never,
                Some(project_id),
            )
        );
        assert_eq!(raw_native_rows(&repository, project_id), before);
    }
}

#[test]
fn completed_corrupt_and_conflict_diagnostics_do_not_override_active_head_or_branches() {
    for diagnostic in [
        UnreadableProjectErrorCode::CorruptData,
        UnreadableProjectErrorCode::Conflict,
    ] {
        let (_directory, repository) = initialized_repository();
        let suffix = unreadable_error_code_name(diagnostic);
        let project_id = format!("nonsticky-active-{suffix}");
        let first = repository
            .save(save_request(
                &project_id,
                "Retained branch",
                1,
                "branch-write",
                ExpectedHeadDto::Empty,
            ))
            .unwrap();
        let active = repository
            .save(save_request(
                &project_id,
                "Native active",
                2,
                "active-write",
                ExpectedHeadDto::Match {
                    version: first.head_version,
                },
            ))
            .unwrap();
        let branch_sequence =
            mark_generation_as_branch(&repository, &project_id, "branch-write", "interrupted-save");
        complete_legacy_diagnostic_fixture(&repository, &project_id, diagnostic, &project_id);
        let before_reads = raw_native_rows(&repository, &project_id);
        let branch_id = format!("sqlite-generation:{branch_sequence}");

        assert!(matches!(
            repository.list().unwrap().as_slice(),
            [ProjectSummaryDto::Ready {
                title,
                branches,
                ..
            }] if title == "Native active" && branches.len() == 1
        ));
        assert_eq!(
            repository
                .load(project_id.clone())
                .unwrap()
                .unwrap()
                .head_version,
            Some(active.head_version.clone())
        );
        assert!(repository
            .load_branch(project_id.clone(), branch_id)
            .unwrap()
            .is_some());
        assert_eq!(
            repository
                .get_project_state(project_id.clone())
                .unwrap()
                .state,
            ProjectStateValue::Active
        );
        assert_eq!(raw_native_rows(&repository, &project_id), before_reads);

        let next = repository
            .save(save_request(
                &project_id,
                "Native next",
                3,
                "next-write",
                ExpectedHeadDto::Match {
                    version: active.head_version,
                },
            ))
            .unwrap();
        assert!(
            repository
                .remove(RemoveRequestDto {
                    project_id: project_id.clone(),
                    delete_id: "native-delete".to_owned(),
                    expected_head: ExpectedHeadDto::Match {
                        version: next.head_version,
                    },
                })
                .unwrap()
                .cleanup_complete
        );
        assert_eq!(
            repository.get_project_state(project_id).unwrap().state,
            ProjectStateValue::Deleted
        );
    }
}

#[test]
fn verified_deleted_head_outranks_sticky_diagnostics_but_reports_incomplete_cleanup() {
    for diagnostic in [
        UnreadableProjectErrorCode::UnsupportedVersion,
        UnreadableProjectErrorCode::MigrationFailed,
    ] {
        let (_directory, repository) = initialized_repository();
        let suffix = unreadable_error_code_name(diagnostic);
        let project_id = format!("deleted-with-{suffix}");
        let saved = repository
            .save(save_request(
                &project_id,
                "Deleted",
                1,
                "write-1",
                ExpectedHeadDto::Empty,
            ))
            .unwrap();
        let remove_request = RemoveRequestDto {
            project_id: project_id.clone(),
            delete_id: "delete-1".to_owned(),
            expected_head: ExpectedHeadDto::Match {
                version: saved.head_version.clone(),
            },
        };
        assert!(
            repository
                .remove(remove_request.clone())
                .unwrap()
                .cleanup_complete
        );
        complete_legacy_diagnostic_fixture(&repository, &project_id, diagnostic, &project_id);
        let before = raw_native_rows(&repository, &project_id);
        let retained_sequence = before.1[0].seq;

        assert!(repository.list().unwrap().is_empty());
        assert!(repository.load(project_id.clone()).unwrap().is_none());
        assert!(repository
            .load_branch(
                project_id.clone(),
                format!("sqlite-generation:{retained_sequence}"),
            )
            .unwrap()
            .is_none());
        assert_eq!(
            repository
                .get_project_state(project_id.clone())
                .unwrap()
                .state,
            ProjectStateValue::Deleted
        );
        let retry = repository.remove(remove_request).unwrap();
        assert!(retry.removed);
        assert!(!retry.cleanup_complete);
        for (operation, error) in [
            (
                RepositoryOperation::Save,
                repository
                    .save(save_request(
                        &project_id,
                        "Must stay deleted",
                        2,
                        "blocked-write",
                        ExpectedHeadDto::Match {
                            version: retry.head_version.clone(),
                        },
                    ))
                    .unwrap_err(),
            ),
            (
                RepositoryOperation::Remove,
                repository
                    .remove(RemoveRequestDto {
                        project_id: project_id.clone(),
                        delete_id: "delete-2".to_owned(),
                        expected_head: ExpectedHeadDto::Match {
                            version: retry.head_version.clone(),
                        },
                    })
                    .unwrap_err(),
            ),
        ] {
            assert_eq!(
                error,
                PersistenceErrorDto::new(
                    operation,
                    PersistenceErrorCode::Conflict,
                    RetryPolicy::Manual,
                    Some(&project_id),
                )
            );
        }
        assert_eq!(raw_native_rows(&repository, &project_id), before);
    }
}

#[test]
fn completed_legacy_diagnostics_participate_in_save_and_remove_cas() {
    for error_code in [
        UnreadableProjectErrorCode::CorruptData,
        UnreadableProjectErrorCode::Conflict,
        UnreadableProjectErrorCode::UnsupportedVersion,
        UnreadableProjectErrorCode::MigrationFailed,
    ] {
        let (_directory, repository) = initialized_repository();
        let suffix = unreadable_error_code_name(error_code);
        let project_id = format!("diagnostic-cas-{suffix}");
        let mirror_key = format!("cts.project.{project_id}");
        let mirror = if error_code == UnreadableProjectErrorCode::UnsupportedVersion {
            serde_json::to_string(&json!({ "id": project_id.clone(), "schemaVersion": 999 }))
                .unwrap()
        } else {
            "{broken".to_owned()
        };
        let snapshot = legacy_snapshot(&[(mirror_key.as_str(), mirror.as_str())], CREATED_AT);
        repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
        repository
            .import_legacy_project(LegacyProjectImportRequestDto {
                content_checksum: snapshot.content_checksum.clone(),
                migration_version: 1,
                project_id: project_id.clone(),
                source_keys: vec![mirror_key],
                project_json: None,
                branch: None,
                diagnostic: Some(LegacyDiagnosticDto { error_code }),
            })
            .unwrap();
        repository
            .complete_legacy_migration(legacy_completion(&snapshot, 0, 1, 0))
            .unwrap();
        let expected = match error_code {
            UnreadableProjectErrorCode::UnsupportedVersion => {
                PersistenceErrorCode::UnsupportedVersion
            }
            UnreadableProjectErrorCode::MigrationFailed => PersistenceErrorCode::MigrationFailed,
            UnreadableProjectErrorCode::CorruptData | UnreadableProjectErrorCode::Conflict => {
                PersistenceErrorCode::Conflict
            }
        };
        for (mode, expected_head) in [
            ("empty", ExpectedHeadDto::Empty),
            ("repair", ExpectedHeadDto::Repair),
        ] {
            assert_eq!(
                repository
                    .save(save_request(
                        &project_id,
                        "Must not hide diagnostic",
                        1,
                        &format!("write-{mode}"),
                        expected_head.clone(),
                    ))
                    .unwrap_err()
                    .code,
                expected,
                "{suffix} {mode} save"
            );
        }
        assert_eq!(
            repository
                .remove(RemoveRequestDto {
                    project_id: project_id.clone(),
                    delete_id: "delete-empty".to_owned(),
                    expected_head: ExpectedHeadDto::Empty,
                })
                .unwrap_err()
                .code,
            expected,
            "{suffix} empty remove"
        );
        if matches!(
            error_code,
            UnreadableProjectErrorCode::CorruptData | UnreadableProjectErrorCode::Conflict
        ) {
            repository
                .remove(RemoveRequestDto {
                    project_id: project_id.clone(),
                    delete_id: "delete-repair".to_owned(),
                    expected_head: ExpectedHeadDto::Repair,
                })
                .unwrap();
            assert_eq!(
                repository.get_project_state(project_id).unwrap().state,
                ProjectStateValue::Deleted,
                "{suffix} repair remove"
            );
        } else {
            assert_eq!(
                repository
                    .remove(RemoveRequestDto {
                        project_id: project_id.clone(),
                        delete_id: "delete-repair".to_owned(),
                        expected_head: ExpectedHeadDto::Repair,
                    })
                    .unwrap_err()
                    .code,
                expected,
                "{suffix} repair remove"
            );
            assert_eq!(
                repository.get_project_state(project_id).unwrap().state,
                ProjectStateValue::Unreadable,
                "{suffix} state"
            );
        }
    }
}

#[test]
fn diagnostic_cannot_downgrade_a_valid_mirror_and_never_overrides_tombstone() {
    let (_directory, repository) = initialized_repository();
    let project = project_json("same", "Same", 1);
    let snapshot = legacy_snapshot(
        &[
            ("cts.persistence.v1.project.same.head", "{}"),
            ("cts.project.same", project.as_str()),
        ],
        CREATED_AT,
    );
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_head_request(&snapshot, "same", "Same", 1))
        .unwrap();
    let downgrade = repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: snapshot.content_checksum.clone(),
            migration_version: 1,
            project_id: "same".to_owned(),
            source_keys: vec![
                "cts.persistence.v1.project.same.head".to_owned(),
                "cts.project.same".to_owned(),
            ],
            project_json: None,
            branch: None,
            diagnostic: Some(LegacyDiagnosticDto {
                error_code: UnreadableProjectErrorCode::CorruptData,
            }),
        })
        .unwrap_err();
    assert_eq!(downgrade.code, PersistenceErrorCode::Conflict);
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 1, 0, 0))
        .unwrap();
    let loaded = repository.load("same".to_owned()).unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&loaded.project_json).unwrap()["title"],
        "Same"
    );

    let (_directory, repository) = initialized_repository();
    let saved = repository
        .save(save_request(
            "deleted",
            "Deleted",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository
        .remove(RemoveRequestDto {
            project_id: "deleted".to_owned(),
            delete_id: "delete-1".to_owned(),
            expected_head: ExpectedHeadDto::Match {
                version: saved.head_version,
            },
        })
        .unwrap();
    let snapshot = legacy_snapshot(&[("cts.project.deleted", "broken")], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(LegacyProjectImportRequestDto {
            content_checksum: snapshot.content_checksum.clone(),
            migration_version: 1,
            project_id: "deleted".to_owned(),
            source_keys: vec!["cts.project.deleted".to_owned()],
            project_json: None,
            branch: None,
            diagnostic: Some(LegacyDiagnosticDto {
                error_code: UnreadableProjectErrorCode::CorruptData,
            }),
        })
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 0, 1, 0))
        .unwrap();
    assert!(repository.list().unwrap().is_empty());
    assert_eq!(
        repository
            .get_project_state("deleted".to_owned())
            .unwrap()
            .state,
        ProjectStateValue::Deleted
    );
}

#[test]
fn refuses_future_database_schema_without_migrating_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("future.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "user_version", 99_i64)
        .unwrap();
    drop(connection);

    let repository = NativeRepository::new(path.clone());
    let error = repository.initialize().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::UnsupportedVersion);
    let connection = Connection::open(path).unwrap();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 99);
}

#[test]
fn refuses_to_adopt_unowned_or_partially_initialized_sqlite_databases() {
    for setup in ["unrelated", "versioned-unowned", "partial-owned"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(format!("{setup}.sqlite3"));
        let connection = Connection::open(&path).unwrap();
        match setup {
            "unrelated" => {
                connection
                    .execute("CREATE TABLE customer_data (value TEXT)", [])
                    .unwrap();
            }
            "versioned-unowned" => {
                connection
                    .pragma_update(None, "user_version", 1_i64)
                    .unwrap();
            }
            "partial-owned" => {
                connection
                    .pragma_update(None, "application_id", APPLICATION_ID)
                    .unwrap();
                connection
                    .execute("CREATE TABLE project_heads (value TEXT)", [])
                    .unwrap();
            }
            _ => unreachable!(),
        }
        drop(connection);

        let repository = NativeRepository::new(path.clone());
        let error = repository.initialize().unwrap_err();
        assert_eq!(error.code, PersistenceErrorCode::MigrationFailed, "{setup}");
        let connection = Connection::open(path).unwrap();
        let application_id: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .unwrap();
        if setup != "partial-owned" {
            assert_eq!(application_id, 0, "must not claim {setup}");
        }
    }
}

#[test]
fn initialize_rejects_hardlinked_database_without_mutating_any_alias() {
    let app_directory = tempfile::tempdir().unwrap();
    let external_directory = tempfile::tempdir().unwrap();
    let external = external_directory.path().join("external.sqlite3");
    let path = app_directory.path().join("projects.sqlite3");
    let bytes = b"external database bytes must remain unchanged";
    fs::write(&external, bytes).unwrap();
    fs::hard_link(&external, &path).unwrap();

    let repository = NativeRepository::new(path.clone());
    let error = repository.initialize().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::StorageUnavailable);
    assert_eq!(fs::read(&external).unwrap(), bytes);
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[cfg(unix)]
#[test]
fn initialize_rejects_database_symlink_without_mutating_external_target() {
    use std::os::unix::fs::symlink;

    let app_directory = tempfile::tempdir().unwrap();
    let external_directory = tempfile::tempdir().unwrap();
    let external = external_directory.path().join("external.sqlite3");
    let path = app_directory.path().join("projects.sqlite3");
    let bytes = b"external database bytes must remain unchanged";
    fs::write(&external, bytes).unwrap();
    symlink(&external, &path).unwrap();

    let repository = NativeRepository::new(path.clone());
    let error = repository.initialize().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::StorageUnavailable);
    assert_eq!(fs::read(&external).unwrap(), bytes);
    assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
}

#[test]
fn initialize_rejects_unsafe_sidecar_before_opening_or_mutating_database() {
    let app_directory = tempfile::tempdir().unwrap();
    let external_directory = tempfile::tempdir().unwrap();
    let path = app_directory.path().join("projects.sqlite3");
    let external = external_directory.path().join("external-wal");
    let sidecar = append_path_suffix(&path, "-wal");
    let connection = Connection::open(&path).unwrap();
    drop(connection);
    let database_bytes = fs::read(&path).unwrap();
    let sidecar_bytes = b"external sidecar bytes must remain unchanged";
    fs::write(&external, sidecar_bytes).unwrap();
    fs::hard_link(&external, &sidecar).unwrap();

    let repository = NativeRepository::new(path.clone());
    let error = repository.initialize().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::StorageUnavailable);
    assert_eq!(fs::read(&path).unwrap(), database_bytes);
    assert_eq!(fs::read(&external).unwrap(), sidecar_bytes);
    assert_eq!(fs::read(&sidecar).unwrap(), sidecar_bytes);
}

#[test]
fn initialize_rejects_nonregular_sidecar_before_mutating_database() {
    let app_directory = tempfile::tempdir().unwrap();
    let path = app_directory.path().join("projects.sqlite3");
    let sidecar = append_path_suffix(&path, "-journal");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("VACUUM").unwrap();
    drop(connection);
    let database_bytes = fs::read(&path).unwrap();
    fs::create_dir(&sidecar).unwrap();
    let sentinel = sidecar.join("must-remain");
    fs::write(&sentinel, b"directory contents must remain unchanged").unwrap();

    let repository = NativeRepository::new(path.clone());
    let error = repository.initialize().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::StorageUnavailable);
    assert_eq!(fs::read(&path).unwrap(), database_bytes);
    assert_eq!(
        fs::read(sentinel).unwrap(),
        b"directory contents must remain unchanged"
    );
    assert!(sidecar.is_dir());
}

#[cfg(unix)]
#[test]
fn initialize_rejects_sidecar_symlink_without_mutating_external_target() {
    use std::os::unix::fs::symlink;

    let app_directory = tempfile::tempdir().unwrap();
    let external_directory = tempfile::tempdir().unwrap();
    let path = app_directory.path().join("projects.sqlite3");
    let external = external_directory.path().join("external-shm");
    let sidecar = append_path_suffix(&path, "-shm");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("VACUUM").unwrap();
    drop(connection);
    let database_bytes = fs::read(&path).unwrap();
    let sidecar_bytes = b"external sidecar bytes must remain unchanged";
    fs::write(&external, sidecar_bytes).unwrap();
    symlink(&external, &sidecar).unwrap();

    let repository = NativeRepository::new(path.clone());
    let error = repository.initialize().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::StorageUnavailable);
    assert_eq!(fs::read(&path).unwrap(), database_bytes);
    assert_eq!(fs::read(&external).unwrap(), sidecar_bytes);
    assert!(fs::symlink_metadata(sidecar)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[cfg(unix)]
#[test]
fn sqlite_actual_main_and_wal_handles_detect_post_open_path_substitution() {
    let (_directory, repository) = initialized_repository();
    let inspection = repository.inspect_and_harden_database_family().unwrap();
    let main_identity = inspection.identities[0].expect("main database identity");
    let wal_identity = inspection.identities[1].expect("open WAL identity");
    let guard = repository.runtime.lock().unwrap();
    let connection = guard.connection.as_ref().unwrap();
    ensure_sqlite_main_file_identity(connection, main_identity).unwrap();
    ensure_sqlite_wal_file_identity(connection, Some(wal_identity)).unwrap();

    let moved_main = repository.path.with_extension("sqlite3.open-handle");
    fs::rename(&repository.path, &moved_main).unwrap();
    fs::write(&repository.path, b"replacement main must not be accepted").unwrap();
    let replacement_main_identity = repository
        .inspect_and_harden_database_family()
        .unwrap()
        .identities[0]
        .unwrap();
    assert_eq!(
        ensure_sqlite_main_file_identity(connection, replacement_main_identity)
            .unwrap_err()
            .code,
        PersistenceErrorCode::StorageUnavailable
    );
    fs::remove_file(&repository.path).unwrap();
    fs::rename(&moved_main, &repository.path).unwrap();
    ensure_sqlite_main_file_identity(connection, main_identity).unwrap();

    let wal_path = append_path_suffix(&repository.path, "-wal");
    let moved_wal = append_path_suffix(&repository.path, "-wal.open-handle");
    fs::rename(&wal_path, &moved_wal).unwrap();
    fs::write(&wal_path, b"replacement WAL must not be accepted").unwrap();
    let replacement_wal_identity = repository
        .inspect_and_harden_database_family()
        .unwrap()
        .identities[1]
        .unwrap();
    assert_eq!(
        ensure_sqlite_wal_file_identity(connection, Some(replacement_wal_identity))
            .unwrap_err()
            .code,
        PersistenceErrorCode::StorageUnavailable
    );
    fs::remove_file(&wal_path).unwrap();
    fs::rename(&moved_wal, &wal_path).unwrap();
    ensure_sqlite_wal_file_identity(connection, Some(wal_identity)).unwrap();
}

#[cfg(unix)]
#[test]
fn guarded_vfs_rejects_transient_main_substitution_before_sqlite_io() {
    let _serial = safe_sqlite_vfs_test_serial().lock().unwrap();
    let (directory, repository) = initialized_repository();
    repository.close().unwrap();
    let original_bytes = fs::read(&repository.path).unwrap();
    let external = directory.path().join("external-main");
    let replacement = directory.path().join("replacement-main-link");
    let saved_original = directory.path().join("saved-original-main");
    let sqlite_target = sqlite_open_path(&repository.path).unwrap();
    let external_bytes = b"external main must never be read or written";
    fs::write(&external, external_bytes).unwrap();
    fs::hard_link(&external, &replacement).unwrap();
    *safe_sqlite_vfs_test_hook().lock().unwrap() = Some(SafeVfsTestHook {
        target: sqlite_target,
        replacement: replacement.clone(),
        saved_original: Some(saved_original.clone()),
        swapped: false,
    });

    let error = repository.initialize().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::StorageUnavailable);
    assert_eq!(fs::read(&external).unwrap(), external_bytes);
    assert_eq!(fs::read(&replacement).unwrap(), external_bytes);
    assert_eq!(fs::read(&repository.path).unwrap(), original_bytes);
    assert!(!saved_original.exists());
    assert!(safe_sqlite_vfs_test_hook().lock().unwrap().is_none());

    fs::remove_file(replacement).unwrap();
    repository.initialize().unwrap();
}

#[cfg(unix)]
#[test]
fn guarded_vfs_rejects_wal_hardlink_inserted_during_xopen_without_mutation() {
    let _serial = safe_sqlite_vfs_test_serial().lock().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("projects.sqlite3");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let sqlite_path = sqlite_open_path(&path).unwrap();
    let wal_path = append_path_suffix(&sqlite_path, "-wal");
    let external = directory.path().join("external-wal");
    let replacement = directory.path().join("replacement-wal-link");
    let external_bytes = b"external WAL must never be read or written";
    fs::write(&external, external_bytes).unwrap();
    fs::hard_link(&external, &replacement).unwrap();
    *safe_sqlite_vfs_test_hook().lock().unwrap() = Some(SafeVfsTestHook {
        target: wal_path.clone(),
        replacement: replacement.clone(),
        saved_original: None,
        swapped: false,
    });
    let repository = NativeRepository::new(path);

    let error = repository.initialize().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::StorageUnavailable);
    assert_eq!(fs::read(&external).unwrap(), external_bytes);
    assert_eq!(fs::read(&replacement).unwrap(), external_bytes);
    assert!(!wal_path.exists());
    assert!(safe_sqlite_vfs_test_hook().lock().unwrap().is_none());

    fs::remove_file(replacement).unwrap();
    repository.initialize().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_reparse_app_data_directory_is_rejected_before_lock_or_database_creation() {
    use std::os::windows::fs::symlink_dir;

    let root = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let reparse = root.path().join("app-data-link");
    if symlink_dir(target.path(), &reparse).is_err() {
        // Some Windows runners require Developer Mode or explicit symlink privilege.
        return;
    }
    let database_path = reparse.join("projects.sqlite3");
    assert!(matches!(
        ProcessLock::acquire(&database_path),
        Err(PersistenceSetupError::UnsafeDataDirectory)
    ));
    assert!(!target.path().join(PROCESS_LOCK_FILE_NAME).exists());
    assert!(!target.path().join("projects.sqlite3").exists());
}

#[cfg(unix)]
#[test]
fn app_owned_directory_and_files_are_tightened_to_private_modes() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let app_directory = root.path().join("app-data");
    fs::create_dir(&app_directory).unwrap();
    fs::set_permissions(&app_directory, fs::Permissions::from_mode(0o777)).unwrap();
    let path = app_directory.join("projects.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("VACUUM").unwrap();
    drop(connection);

    let family = [
        path.clone(),
        append_path_suffix(&path, "-wal"),
        append_path_suffix(&path, "-shm"),
        append_path_suffix(&path, "-journal"),
    ];
    for member in &family {
        if !member.exists() {
            fs::write(member, b"sidecar").unwrap();
        }
        fs::set_permissions(member, fs::Permissions::from_mode(0o666)).unwrap();
    }

    harden_app_data_directory_permissions(&app_directory).unwrap();
    inspect_and_harden_database_family(&family).unwrap();
    assert_eq!(
        fs::metadata(&app_directory).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    for member in &family {
        assert_eq!(
            fs::metadata(member).unwrap().permissions().mode() & 0o7777,
            0o600,
            "private mode was not applied to {member:?}"
        );
    }

    for member in &family[1..] {
        fs::remove_file(member).unwrap();
    }
    let process_lock = ProcessLock::acquire(&path).unwrap();
    let lock_path = app_directory.join(PROCESS_LOCK_FILE_NAME);
    assert_eq!(
        fs::metadata(&lock_path).unwrap().permissions().mode() & 0o7777,
        0o600
    );

    let repository = NativeRepository::new(path.clone());
    repository.initialize().unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
        0o600
    );
    repository
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
    let marker_path = repository.marker_path().unwrap();
    assert_eq!(
        fs::metadata(marker_path).unwrap().permissions().mode() & 0o7777,
        0o600
    );
    drop(process_lock);
}

#[test]
fn wire_dtos_use_exact_camel_case_and_structured_error_shape() {
    let save: SaveRequestDto = serde_json::from_value(json!({
        "projectId": "project-a",
        "projectJson": project_json("project-a", "First", 1),
        "activationId": "activation-a",
        "revision": 1,
        "writeId": "write-1",
        "expectedHead": { "kind": "match", "version": "head-1" }
    }))
    .unwrap();
    assert!(matches!(
        save.expected_head,
        ExpectedHeadDto::Match { version } if version == "head-1"
    ));
    let crash: CrashDraftRequestDto = serde_json::from_value(json!({
        "projectId": "project-a",
        "projectJson": project_json("project-a", "Protected", 2),
        "activationId": "activation-a",
        "revision": 2,
        "writeId": "draft-2",
        "expectedHead": { "kind": "empty" },
        "predecessorWriteId": "write-1"
    }))
    .unwrap();
    assert_eq!(crash.predecessor_write_id.as_deref(), Some("write-1"));
    assert!(serde_json::from_value::<CrashDraftRequestDto>(json!({
        "projectId": "project-a",
        "projectJson": project_json("project-a", "Protected", 2),
        "activationId": "activation-a",
        "revision": 2,
        "writeId": "draft-2",
        "expectedHead": { "kind": "empty", "unexpected": true }
    }))
    .is_err());
    assert_eq!(
        serde_json::to_value(CrashDraftReceiptDto {
            project_id: "project-a".to_owned(),
            activation_id: "activation-a".to_owned(),
            revision: 2,
            write_id: "draft-2".to_owned(),
            protected_at: CREATED_AT.to_owned(),
            bytes: 123,
        })
        .unwrap(),
        json!({
            "projectId": "project-a",
            "activationId": "activation-a",
            "revision": 2,
            "writeId": "draft-2",
            "protectedAt": CREATED_AT,
            "bytes": 123
        })
    );

    let error = persistence_error(
        RepositoryOperation::Save,
        PersistenceErrorCode::Conflict,
        RetryPolicy::Manual,
        Some("project-a"),
    );
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        json!({
            "code": "conflict",
            "retry": "manual",
            "projectId": "project-a"
        })
    );

    let request: EraseAllRequestDto = serde_json::from_value(json!({
        "eraseId": ERASE_ID_A
    }))
    .unwrap();
    assert_eq!(request.erase_id, ERASE_ID_A);
    assert!(serde_json::from_value::<EraseAllRequestDto>(json!({
        "eraseId": ERASE_ID_A,
        "unexpected": true
    }))
    .is_err());
    assert_eq!(
        serde_json::to_value(EraseAllStatusDto::Idle).unwrap(),
        json!({ "state": "idle" })
    );
    assert_eq!(
        serde_json::to_value(EraseAllStatusDto::Pending {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap(),
        json!({ "state": "pending", "eraseId": ERASE_ID_A })
    );
    assert_eq!(
        serde_json::to_value(erase_receipt(ERASE_ID_A.to_owned())).unwrap(),
        json!({ "eraseId": ERASE_ID_A, "nativeDataRemoved": true })
    );
    assert_eq!(
        serde_json::to_value(RepositoryOperation::EraseAll).unwrap(),
        json!("erase-all")
    );
}

#[test]
fn erase_all_removes_every_database_record_class_and_exact_sidecars() {
    let (directory, repository) = initialized_repository();
    let first = repository
        .save(save_request(
            "project-a",
            "First",
            1,
            "write-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    repository
        .save(save_request(
            "project-a",
            "Second",
            2,
            "write-2",
            ExpectedHeadDto::Match {
                version: first.head_version,
            },
        ))
        .unwrap();
    mark_generation_as_branch(&repository, "project-a", "write-1", "interrupted-save");

    let snapshot = legacy_snapshot(&[("cts.project.diagnostic", "broken")], CREATED_AT);
    repository.backup_legacy_snapshot(snapshot.clone()).unwrap();
    repository
        .import_legacy_project(legacy_diagnostic_request_at_version(
            &snapshot,
            1,
            "diagnostic",
            UnreadableProjectErrorCode::CorruptData,
        ))
        .unwrap();
    repository
        .complete_legacy_migration(legacy_completion(&snapshot, 0, 1, 0))
        .unwrap();
    repository
        .stage_crash_draft(crash_draft_request(
            "project-draft",
            "Crash draft",
            1,
            "draft-erase",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();

    connection_value(&repository, |connection| {
        let generations: i64 = connection
            .query_row("SELECT COUNT(*) FROM project_generations", [], |row| {
                row.get(0)
            })
            .unwrap();
        let branches: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM project_generations WHERE branch_source IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let raw_records: i64 = connection
            .query_row("SELECT COUNT(*) FROM legacy_migration_records", [], |row| {
                row.get(0)
            })
            .unwrap();
        let diagnostics: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM legacy_project_staging WHERE candidate_kind = 'diagnostic'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let crash_drafts: i64 = connection
            .query_row("SELECT COUNT(*) FROM project_crash_drafts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(generations, 2, "canonical and history generations exist");
        assert_eq!(branches, 1);
        assert_eq!(raw_records, 1);
        assert_eq!(diagnostics, 1);
        assert_eq!(crash_drafts, 1);
    });

    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = append_path_suffix(&repository.path, suffix);
        if !sidecar.exists() {
            fs::write(&sidecar, b"sidecar").unwrap();
        }
    }
    let unrelated = directory.path().join("unrelated.sqlite3");
    let near_collision = append_path_suffix(&repository.path, "-wal.backup");
    fs::write(&unrelated, b"keep").unwrap();
    fs::write(&near_collision, b"also keep").unwrap();

    let receipt = repository
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
    assert!(receipt.native_data_removed);
    assert_eq!(receipt.erase_id, ERASE_ID_A);
    for path in repository.database_family_paths() {
        assert!(!path.exists(), "database family member survived: {path:?}");
    }
    assert_eq!(fs::read(unrelated).unwrap(), b"keep");
    assert_eq!(fs::read(near_collision).unwrap(), b"also keep");
    assert!(repository.marker_path().unwrap().exists());
    assert_eq!(
        repository.get_erase_all_status().unwrap(),
        EraseAllStatusDto::Pending {
            erase_id: ERASE_ID_A.to_owned()
        }
    );
    let sealed = repository.list().unwrap_err();
    assert_eq!(sealed.code, PersistenceErrorCode::StorageUnavailable);
    assert_eq!(sealed.retry, RetryPolicy::Never);
    assert_eq!(
        repository
            .load_branch("project-a".to_owned(), "not-a-branch".to_owned())
            .unwrap_err()
            .code,
        PersistenceErrorCode::StorageUnavailable
    );

    repository
        .complete_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
    assert!(!repository.marker_path().unwrap().exists());
    assert_eq!(
        repository.get_erase_all_status().unwrap(),
        EraseAllStatusDto::Idle
    );
    assert_eq!(
        repository.initialize().unwrap_err().code,
        PersistenceErrorCode::StorageUnavailable,
        "the erasing process must remain sealed"
    );
}

#[test]
fn erase_all_retries_are_idempotent_and_other_ids_conflict() {
    let (_directory, repository) = initialized_repository();
    let request_a = || EraseAllRequestDto {
        erase_id: ERASE_ID_A.to_owned(),
    };
    let request_b = || EraseAllRequestDto {
        erase_id: ERASE_ID_B.to_owned(),
    };

    repository.prepare_erase_all(request_a()).unwrap();
    repository.prepare_erase_all(request_a()).unwrap();
    assert_eq!(
        repository.prepare_erase_all(request_b()).unwrap_err().code,
        PersistenceErrorCode::Conflict
    );
    assert_eq!(
        repository.complete_erase_all(request_b()).unwrap_err().code,
        PersistenceErrorCode::Conflict
    );
    repository.complete_erase_all(request_a()).unwrap();
    repository.complete_erase_all(request_a()).unwrap();
    repository.prepare_erase_all(request_a()).unwrap();
    assert_eq!(
        repository.prepare_erase_all(request_b()).unwrap_err().code,
        PersistenceErrorCode::Conflict
    );
}

#[test]
fn marker_unlink_sync_failure_keeps_process_sealed_and_same_id_retryable() {
    let (_directory, repository) = initialized_repository();
    let request = || EraseAllRequestDto {
        erase_id: ERASE_ID_A.to_owned(),
    };
    repository.prepare_erase_all(request()).unwrap();
    let error = repository
        .complete_erase_all_with_marker_sync(request(), |_| {
            Err(std::io::Error::other("injected directory sync failure"))
        })
        .unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::DeleteFailed);
    assert!(!repository.marker_path().unwrap().exists());
    repository.complete_erase_all(request()).unwrap();
    assert_eq!(
        repository.list().unwrap_err().code,
        PersistenceErrorCode::StorageUnavailable
    );
    assert_eq!(
        repository
            .complete_erase_all(EraseAllRequestDto {
                erase_id: ERASE_ID_B.to_owned(),
            })
            .unwrap_err()
            .code,
        PersistenceErrorCode::Conflict
    );
}

#[test]
fn completed_erase_retries_fail_closed_if_marker_or_database_reappears() {
    for reappearing_entry in ["marker", "database"] {
        let (_directory, repository) = initialized_repository();
        let request = || EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        };
        repository.prepare_erase_all(request()).unwrap();
        repository.complete_erase_all(request()).unwrap();
        if reappearing_entry == "marker" {
            fs::write(repository.marker_path().unwrap(), b"{corrupt").unwrap();
            assert_eq!(
                repository.get_erase_all_status().unwrap_err().code,
                PersistenceErrorCode::CorruptData
            );
            assert_eq!(
                repository.complete_erase_all(request()).unwrap_err().code,
                PersistenceErrorCode::CorruptData
            );
        } else {
            fs::write(&repository.path, b"unexpected database").unwrap();
            assert_eq!(
                repository.get_erase_all_status().unwrap_err().code,
                PersistenceErrorCode::DeleteFailed
            );
            assert_eq!(
                repository.prepare_erase_all(request()).unwrap_err().code,
                PersistenceErrorCode::DeleteFailed
            );
            assert_eq!(
                repository.complete_erase_all(request()).unwrap_err().code,
                PersistenceErrorCode::DeleteFailed
            );
        }
    }
}

#[test]
fn pending_erase_survives_repository_reopen_and_blocks_initialize() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("projects.sqlite3");
    let repository = NativeRepository::new(path.clone());
    repository.initialize().unwrap();
    repository
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
    drop(repository);

    let reopened = NativeRepository::new(path.clone());
    assert_eq!(
        reopened.get_erase_all_status().unwrap(),
        EraseAllStatusDto::Pending {
            erase_id: ERASE_ID_A.to_owned()
        }
    );
    assert_eq!(
        reopened.initialize().unwrap_err().code,
        PersistenceErrorCode::StorageUnavailable
    );
    assert!(
        !path.exists(),
        "initialize must check the pending marker before opening SQLite"
    );
    reopened
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
    reopened
        .complete_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
    drop(reopened);

    let next_process = NativeRepository::new(path);
    assert_eq!(
        next_process.get_erase_all_status().unwrap(),
        EraseAllStatusDto::Idle
    );
    next_process.initialize().unwrap();
    assert!(next_process.list().unwrap().is_empty());
}

#[test]
fn erase_all_handles_uninitialized_corrupt_and_future_databases() {
    for setup in ["uninitialized", "corrupt", "future"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("projects.sqlite3");
        match setup {
            "uninitialized" => {}
            "corrupt" => fs::write(&path, b"not a sqlite database").unwrap(),
            "future" => {
                let connection = Connection::open(&path).unwrap();
                connection.pragma_update(None, "user_version", 99).unwrap();
            }
            _ => unreachable!(),
        }
        let repository = NativeRepository::new(path.clone());
        repository
            .prepare_erase_all(EraseAllRequestDto {
                erase_id: ERASE_ID_A.to_owned(),
            })
            .unwrap();
        assert!(!path.exists(), "{setup} database survived");
        assert!(repository.marker_path().unwrap().exists());
    }
}

#[test]
fn corrupt_and_future_erase_markers_fail_closed_without_touching_database() {
    for setup in ["corrupt", "future"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("projects.sqlite3");
        fs::write(&path, b"must remain").unwrap();
        let repository = NativeRepository::new(path.clone());
        let marker_path = repository.marker_path().unwrap();
        if setup == "corrupt" {
            fs::write(&marker_path, b"{broken").unwrap();
        } else {
            let marker = EraseMarker {
                storage_version: ERASE_MARKER_VERSION + 1,
                erase_id: ERASE_ID_A.to_owned(),
                checksum: erase_marker_checksum(ERASE_MARKER_VERSION + 1, ERASE_ID_A),
            };
            fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();
        }

        let expected = if setup == "corrupt" {
            PersistenceErrorCode::CorruptData
        } else {
            PersistenceErrorCode::UnsupportedVersion
        };
        assert_eq!(
            repository.get_erase_all_status().unwrap_err().code,
            expected
        );
        assert_eq!(repository.initialize().unwrap_err().code, expected);
        assert_eq!(
            repository
                .prepare_erase_all(EraseAllRequestDto {
                    erase_id: ERASE_ID_A.to_owned(),
                })
                .unwrap_err()
                .code,
            expected
        );
        assert_eq!(fs::read(&path).unwrap(), b"must remain");
        assert!(marker_path.exists());
    }
}

#[test]
fn hardlinked_erase_marker_is_rejected_without_mutating_either_alias() {
    let app_directory = tempfile::tempdir().unwrap();
    let external_directory = tempfile::tempdir().unwrap();
    let repository = NativeRepository::new(app_directory.path().join("projects.sqlite3"));
    let marker = EraseMarker {
        storage_version: ERASE_MARKER_VERSION,
        erase_id: ERASE_ID_A.to_owned(),
        checksum: erase_marker_checksum(ERASE_MARKER_VERSION, ERASE_ID_A),
    };
    let bytes = serde_json::to_vec(&marker).unwrap();
    let external = external_directory.path().join("external-marker.json");
    fs::write(&external, &bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&external, fs::Permissions::from_mode(0o666)).unwrap();
    }
    let marker_path = repository.marker_path().unwrap();
    fs::hard_link(&external, &marker_path).unwrap();

    let error = repository.get_erase_all_status().unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::CorruptData);
    assert_eq!(fs::read(&external).unwrap(), bytes);
    assert_eq!(fs::read(&marker_path).unwrap(), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&external).unwrap().permissions().mode() & 0o7777,
            0o666,
            "unsafe marker must be rejected before chmod"
        );
    }
}

#[test]
fn invalid_erase_ids_are_rejected_without_creating_a_marker() {
    for erase_id in [
        "",
        "erase-12345678-1234-4abc-8def-1234567890AB",
        "erase-12345678-1234-5abc-8def-1234567890ab",
        "erase-12345678-1234-4abc-7def-1234567890ab",
        "12345678-1234-4abc-8def-1234567890ab",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let repository = NativeRepository::new(directory.path().join("projects.sqlite3"));
        assert_eq!(
            repository
                .prepare_erase_all(EraseAllRequestDto {
                    erase_id: erase_id.to_owned(),
                })
                .unwrap_err()
                .code,
            PersistenceErrorCode::InvalidProject
        );
        assert!(!repository.marker_path().unwrap().exists());
    }
}

#[cfg(unix)]
#[test]
fn erase_all_unlinks_database_symlinks_without_following_targets() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("outside-target.sqlite3");
    let sidecar_target = directory.path().join("outside-sidecar");
    fs::write(&target, b"outside database").unwrap();
    fs::write(&sidecar_target, b"outside sidecar").unwrap();
    let path = directory.path().join("projects.sqlite3");
    symlink(&target, &path).unwrap();
    symlink(&sidecar_target, append_path_suffix(&path, "-wal")).unwrap();

    let repository = NativeRepository::new(path.clone());
    repository
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
    assert_eq!(fs::read(target).unwrap(), b"outside database");
    assert_eq!(fs::read(sidecar_target).unwrap(), b"outside sidecar");
    assert!(!path.exists());
    assert!(!append_path_suffix(&path, "-wal").exists());
}

#[test]
fn erase_error_on_sidecar_leaves_marker_for_safe_retry() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("projects.sqlite3");
    fs::write(&path, b"database").unwrap();
    let blocking_sidecar = append_path_suffix(&path, "-wal");
    fs::create_dir(&blocking_sidecar).unwrap();
    let repository = NativeRepository::new(path.clone());

    let error = repository
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::DeleteFailed);
    assert!(repository.marker_path().unwrap().exists());
    assert!(
        !path.exists(),
        "partial deletion is resumable under the marker"
    );
    assert!(blocking_sidecar.is_dir());
    assert_eq!(
        repository.get_erase_all_status().unwrap(),
        EraseAllStatusDto::Pending {
            erase_id: ERASE_ID_A.to_owned()
        }
    );

    fs::remove_dir(blocking_sidecar).unwrap();
    repository
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
}

#[test]
fn erase_rejects_hardlinked_database_family_without_unlinking_any_alias() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("projects.sqlite3");
    let alias = directory.path().join("database-hardlink-alias");
    let bytes = b"database bytes must remain";
    fs::write(&path, bytes).unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let repository = NativeRepository::new(path.clone());

    let error = repository
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::DeleteFailed);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::read(&alias).unwrap(), bytes);
    assert!(repository.marker_path().unwrap().exists());
}

#[test]
fn close_busy_restores_connection_and_vfs_boundary_until_retry_succeeds() {
    let (_directory, repository) = initialized_repository();
    let sqlite_path = sqlite_open_path(&repository.path).unwrap();
    let statement = prepare_unfinalized_raw_statement(&repository);

    assert!(repository.close().is_err());
    {
        let runtime = repository.runtime.lock().unwrap();
        assert!(runtime.connection.is_some());
        assert!(runtime.vfs_boundary.is_some());
    }
    assert!(safe_sqlite_boundaries()
        .lock()
        .unwrap()
        .contains_key(&sqlite_path));
    assert!(repository.list().unwrap().is_empty());

    assert_eq!(
        unsafe { rusqlite::ffi::sqlite3_finalize(statement) },
        rusqlite::ffi::SQLITE_OK
    );
    repository.close().unwrap();
    assert!(!safe_sqlite_boundaries()
        .lock()
        .unwrap()
        .contains_key(&sqlite_path));
}

#[test]
fn erase_close_busy_keeps_database_and_same_id_retryable() {
    let (_directory, repository) = initialized_repository();
    let sqlite_path = sqlite_open_path(&repository.path).unwrap();
    let statement = prepare_unfinalized_raw_statement(&repository);
    let request = || EraseAllRequestDto {
        erase_id: ERASE_ID_A.to_owned(),
    };

    assert!(repository.prepare_erase_all(request()).is_err());
    assert!(repository.path.exists());
    assert!(repository.marker_path().unwrap().exists());
    assert_eq!(
        repository.get_erase_all_status().unwrap(),
        EraseAllStatusDto::Pending {
            erase_id: ERASE_ID_A.to_owned()
        }
    );
    {
        let runtime = repository.runtime.lock().unwrap();
        assert!(runtime.connection.is_some());
        assert!(runtime.vfs_boundary.is_some());
    }
    assert!(safe_sqlite_boundaries()
        .lock()
        .unwrap()
        .contains_key(&sqlite_path));

    assert_eq!(
        unsafe { rusqlite::ffi::sqlite3_finalize(statement) },
        rusqlite::ffi::SQLITE_OK
    );
    repository.prepare_erase_all(request()).unwrap();
    assert!(!repository.path.exists());
    assert!(!safe_sqlite_boundaries()
        .lock()
        .unwrap()
        .contains_key(&sqlite_path));
    repository.complete_erase_all(request()).unwrap();
}

#[test]
fn normal_close_does_not_clear_or_accept_a_pending_erase() {
    let (_directory, repository) = initialized_repository();
    repository
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap();
    assert_eq!(
        repository.close().unwrap_err().code,
        PersistenceErrorCode::StorageUnavailable
    );
    assert!(repository.marker_path().unwrap().exists());
}

#[test]
fn process_lock_child() {
    let Some(database_path) = std::env::var_os("CTS_PROCESS_LOCK_CHILD_DATABASE") else {
        return;
    };
    let ready_path = std::env::var_os("CTS_PROCESS_LOCK_CHILD_READY").unwrap();
    let release_path = std::env::var_os("CTS_PROCESS_LOCK_CHILD_RELEASE").unwrap();
    let _lock = ProcessLock::acquire(Path::new(&database_path)).unwrap();
    fs::write(&ready_path, b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !Path::new(&release_path).exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn crash_draft_sigkill_child() {
    let Some(database_path) = std::env::var_os("CTS_CRASH_DRAFT_CHILD_DATABASE") else {
        return;
    };
    let ready_path = std::env::var_os("CTS_CRASH_DRAFT_CHILD_READY").unwrap();
    let state = NativePersistenceState::acquire(PathBuf::from(database_path)).unwrap();
    let repository = state.repository();
    repository.initialize().unwrap();
    repository
        .stage_crash_draft(crash_draft_request(
            "project-crash",
            "Acknowledged before SIGKILL",
            1,
            "draft-kill-1",
            ExpectedHeadDto::Empty,
        ))
        .unwrap();
    fs::write(&ready_path, b"durable-ack").unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    panic!("SIGKILL child was not terminated by its parent");
}

#[test]
fn process_lock_rejects_nonempty_or_hardlinked_entries_without_mutating_database() {
    for setup in ["nonempty", "hardlink"] {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("projects.sqlite3");
        let lock_path = directory.path().join(PROCESS_LOCK_FILE_NAME);
        let database_bytes = b"database bytes must remain";
        fs::write(&database_path, database_bytes).unwrap();
        if setup == "nonempty" {
            fs::write(&lock_path, b"unexpected lock payload").unwrap();
        } else {
            fs::hard_link(&database_path, &lock_path).unwrap();
        }

        assert!(matches!(
            ProcessLock::acquire(&database_path),
            Err(PersistenceSetupError::UnsafeLockEntry)
        ));
        assert!(matches!(
            NativePersistenceState::acquire(database_path.clone()),
            Err(PersistenceSetupError::UnsafeLockEntry)
        ));
        assert_eq!(fs::read(&database_path).unwrap(), database_bytes, "{setup}");
        let expected_lock = if setup == "nonempty" {
            b"unexpected lock payload".as_slice()
        } else {
            database_bytes.as_slice()
        };
        assert_eq!(fs::read(&lock_path).unwrap(), expected_lock, "{setup}");
    }
}

#[cfg(unix)]
#[test]
fn process_lock_rejects_symlink_and_post_acquire_hardlink_substitution() {
    use std::os::unix::fs::symlink;

    let symlink_directory = tempfile::tempdir().unwrap();
    let symlink_database = symlink_directory.path().join("projects.sqlite3");
    let symlink_target = symlink_directory.path().join("lock-target");
    fs::write(&symlink_target, b"").unwrap();
    symlink(
        &symlink_target,
        symlink_directory.path().join(PROCESS_LOCK_FILE_NAME),
    )
    .unwrap();
    assert!(matches!(
        ProcessLock::acquire(&symlink_database),
        Err(PersistenceSetupError::UnsafeLockEntry)
    ));

    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("projects.sqlite3");
    let lock_path = directory.path().join(PROCESS_LOCK_FILE_NAME);
    let state = NativePersistenceState::acquire(database_path.clone()).unwrap();
    fs::remove_file(&lock_path).unwrap();
    fs::write(&database_path, b"database bytes").unwrap();
    fs::hard_link(&database_path, &lock_path).unwrap();
    let error = state
        .repository()
        .prepare_erase_all(EraseAllRequestDto {
            erase_id: ERASE_ID_A.to_owned(),
        })
        .unwrap_err();
    assert_eq!(error.code, PersistenceErrorCode::DeleteFailed);
    assert_eq!(fs::read(&database_path).unwrap(), b"database bytes");
    assert_eq!(fs::read(&lock_path).unwrap(), b"database bytes");
}

#[test]
fn process_lock_is_exclusive_across_processes_but_not_stale() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("projects.sqlite3");
    let ready_path = directory.path().join("ready");
    let release_path = directory.path().join("release");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "native_persistence::repository::tests::process_lock_child",
            "--nocapture",
        ])
        .env("CTS_PROCESS_LOCK_CHILD_DATABASE", &database_path)
        .env("CTS_PROCESS_LOCK_CHILD_READY", &ready_path)
        .env("CTS_PROCESS_LOCK_CHILD_RELEASE", &release_path)
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready_path.exists() && Instant::now() < deadline {
        assert!(
            child.try_wait().unwrap().is_none(),
            "lock child exited early"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ready_path.exists(), "lock child did not become ready");
    assert!(matches!(
        ProcessLock::acquire(&database_path),
        Err(PersistenceSetupError::AlreadyRunning)
    ));
    fs::write(&release_path, b"release").unwrap();
    assert!(child.wait().unwrap().success());

    let lock = ProcessLock::acquire(&database_path).expect("stale lock file must not block");
    drop(lock);
    let lock_path = directory.path().join(PROCESS_LOCK_FILE_NAME);
    assert!(lock_path.exists());
    assert_eq!(fs::metadata(lock_path).unwrap().len(), 0);
}

#[cfg(unix)]
#[test]
fn acknowledged_crash_draft_survives_sigkill_and_reopens_writable() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("projects.sqlite3");
    let ready_path = directory.path().join("crash-draft-ready");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "native_persistence::repository::tests::crash_draft_sigkill_child",
            "--nocapture",
        ])
        .env("CTS_CRASH_DRAFT_CHILD_DATABASE", &database_path)
        .env("CTS_CRASH_DRAFT_CHILD_READY", &ready_path)
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready_path.exists() && Instant::now() < deadline {
        assert!(
            child.try_wait().unwrap().is_none(),
            "crash-draft child exited before its durable acknowledgement"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ready_path.exists(), "crash-draft child did not acknowledge");
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());

    let state = NativePersistenceState::acquire(database_path).unwrap();
    let repository = state.repository();
    repository.initialize().unwrap();
    let recovered = repository
        .load("project-crash".to_owned())
        .unwrap()
        .unwrap();
    assert!(recovered.recovered);
    assert_eq!(
        recovered.recovery_reason,
        Some(ProjectRecoveryReason::InterruptedSave)
    );
    assert_eq!(
        serde_json::from_str::<Value>(&recovered.project_json).unwrap()["title"],
        "Acknowledged before SIGKILL"
    );
    let next = repository
        .save(save_request(
            "project-crash",
            "Writable after recovery",
            2,
            "write-after-kill",
            ExpectedHeadDto::Match {
                version: recovered.head_version.unwrap(),
            },
        ))
        .unwrap();
    assert_eq!(next.revision, 2);
    connection_value(&repository, |connection| {
        assert!(all_crash_drafts(connection).unwrap().is_empty());
    });
}
