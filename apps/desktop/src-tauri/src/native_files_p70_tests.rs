// P70 acceptance tests (desktop open reaches the wave5 conversion dialog). Written BEFORE the implementation; do not edit.
// This file is a child module of `native_files` (registered by the two lines appended at the end of native_files.rs:
// `#[cfg(test)] #[path = "native_files_p70_tests.rs"] mod p70_wave5_open_tests;`). The implementer keeps those lines.
//
// CONTRACT. `open_selected_file(FileFormat::Project, Some(path))` for a wave5 v3 file (a JSON object with schemaVersion 3 and NONE of the five
// main-v3 keys lengthBeats / tempoMap / timeSignatureMap / audioAssets / automationLanes) returns Ok(envelope) with
//   envelope[0] == 2                      the new "legacy wave5" tag (0 = cancelled, 1 = opened; no other tag is used)
//   envelope[1..5]                        u32 little-endian file-name length, then the file name  (the same layout as tag 1)
//   envelope[5 + name_len ..]             the file's bytes, UNCHANGED (byte for byte)
// It must NOT validate or store the file as a main project and must never write anything (no file, no directory, no change to the source).
// Everything that is neither a main project nor a wave5 v3 file keeps today's rejection (InvalidFile). Only FileFormat::Project may produce tag 2.
use super::*;
use std::{fs, path::Path};
use tempfile::tempdir;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../studio/tests/acceptance/fixtures/p70/inputs"
);
const REPO_FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/project-model/tests/fixtures"
);

const LEGACY_WAVE5_TAG: u8 = 2;

fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut entries: Vec<(String, Vec<u8>)> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().to_string_lossy().into_owned(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect();
    entries.sort();
    entries
}

#[test]
fn native_open_of_a_wave5_v3_file_returns_its_bytes_with_the_legacy_marker_and_writes_nothing() {
    for (source, name) in [
        (
            format!("{FIXTURES}/template-8bar-pop.json"),
            "old-song.ctsproj.json",
        ),
        (
            format!("{FIXTURES}/realistic-song.json"),
            "realistic.ctsproj.json",
        ),
        (
            format!("{REPO_FIXTURES}/wave5-v3/project-full.json"),
            "full.ctsproj.json",
        ),
        (
            format!("{REPO_FIXTURES}/wave5-v3/project-base-only.json"),
            "base.ctsproj.json",
        ),
    ] {
        let bytes = fs::read(&source).unwrap();
        let directory = tempdir().unwrap();
        let path = directory.path().join(name);
        fs::write(&path, &bytes).unwrap();
        let before = snapshot(directory.path());

        let envelope = open_selected_file(FileFormat::Project, Some(path)).unwrap();

        assert_eq!(envelope[0], LEGACY_WAVE5_TAG, "{name}: tag");
        let name_length = u32::from_le_bytes(envelope[1..5].try_into().unwrap()) as usize;
        assert_eq!(
            &envelope[5..5 + name_length],
            name.as_bytes(),
            "{name}: file name"
        );
        assert_eq!(
            &envelope[5 + name_length..],
            bytes.as_slice(),
            "{name}: bytes unchanged"
        );
        assert!(
            !String::from_utf8_lossy(&envelope)
                .contains(directory.path().to_string_lossy().as_ref()),
            "{name}: the selected path must not leak"
        );
        assert_eq!(
            snapshot(directory.path()),
            before,
            "{name}: nothing was written or changed"
        );
    }
}

#[test]
fn native_open_of_a_main_project_keeps_the_normal_tag() {
    let bytes = fs::read(format!("{REPO_FIXTURES}/main/project-v3.json")).unwrap();
    let directory = tempdir().unwrap();
    let path = directory.path().join("song.ctsproj.json");
    fs::write(&path, &bytes).unwrap();
    let envelope = open_selected_file(FileFormat::Project, Some(path)).unwrap();
    assert_eq!(envelope[0], 1);
    assert_eq!(&envelope[envelope.len() - bytes.len()..], bytes.as_slice());
}

#[test]
fn native_open_still_rejects_what_is_neither_a_main_project_nor_a_wave5_v3_file() {
    let wave5: serde_json::Value =
        serde_json::from_slice(&fs::read(format!("{FIXTURES}/template-8bar-pop.json")).unwrap())
            .unwrap();
    let mut one_main_key = wave5.clone();
    one_main_key["lengthBeats"] = serde_json::json!(32);
    let mut four_main_keys = wave5.clone();
    for key in ["lengthBeats", "tempoMap", "timeSignatureMap", "audioAssets"] {
        four_main_keys[key] = serde_json::json!([]);
    }
    let mut wave5_v2 = wave5.clone();
    wave5_v2["schemaVersion"] = serde_json::json!(2);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("one-main-key", serde_json::to_vec(&one_main_key).unwrap()),
        (
            "four-main-keys",
            serde_json::to_vec(&four_main_keys).unwrap(),
        ),
        ("wave5-v2", serde_json::to_vec(&wave5_v2).unwrap()),
        ("not-json", b"not json at all".to_vec()),
        ("empty-object", b"{}".to_vec()),
        ("array", b"[3]".to_vec()),
    ];
    for (label, bytes) in cases {
        let directory = tempdir().unwrap();
        let path = directory.path().join("bad.ctsproj.json");
        fs::write(&path, &bytes).unwrap();
        let result = open_selected_file(FileFormat::Project, Some(path));
        assert_eq!(
            result,
            Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidFile)),
            "{label}: must still be rejected"
        );
    }
}

#[test]
fn native_open_never_marks_other_formats_as_legacy_wave5() {
    // The same wave5 bytes under a MIDI name are just a bad MIDI file.
    let directory = tempdir().unwrap();
    let path = directory.path().join("piece.mid");
    fs::write(
        &path,
        fs::read(format!("{FIXTURES}/template-8bar-pop.json")).unwrap(),
    )
    .unwrap();
    assert!(open_selected_file(FileFormat::Midi, Some(path)).is_err());
}
