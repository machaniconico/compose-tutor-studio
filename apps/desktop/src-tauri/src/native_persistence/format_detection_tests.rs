use super::*;

const MAIN_V3: &str =
    include_str!("../../../../../packages/project-model/tests/fixtures/main/project-v3.json");
const WAVE5_V3: &str =
    include_str!("../../../../../packages/project-model/tests/fixtures/wave5-v3/project-full.json");

#[test]
fn main_v3_file_keeps_integer_only_schema_version_validation() {
    let mut project: Value = serde_json::from_str(MAIN_V3).unwrap();
    assert!(check_project_file_json(MAIN_V3.as_bytes()).is_ok());

    project["schemaVersion"] = serde_json::json!(3.0);
    let decimal = serde_json::to_vec(&project).unwrap();
    assert!(matches!(
        check_project_file_json(&decimal),
        Err(ProjectFileIssue::InvalidProject)
    ));
}

#[test]
fn wave5_v3_file_classifies_integer_and_decimal_schema_versions_alike() {
    let mut project: Value = serde_json::from_str(WAVE5_V3).unwrap();
    for version in [serde_json::json!(3), serde_json::json!(3.0)] {
        project["schemaVersion"] = version;
        let bytes = serde_json::to_vec(&project).unwrap();
        assert!(matches!(
            check_project_file_json(&bytes),
            Err(ProjectFileIssue::LegacyWave5Format)
        ));
    }
}
