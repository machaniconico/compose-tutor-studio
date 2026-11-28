use super::validate_project_file_json;
use std::{fs, path::Path};

#[test]
fn p70_sub_tick_conversions_pass_native_validation() {
    let directory =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../studio/test-results/p70-sub-tick");
    if !directory.exists()
        && !std::env::var("CTS_P70_REQUIRE_CONVERTED").is_ok_and(|value| value == "1")
    {
        eprintln!("Run wave5-converter-regression.test.ts to generate P70 sub-tick projects");
        return;
    }

    let fixtures = ["note-boundary.json", "last-tick.json", "pan-crossing.json"]
        .into_iter()
        .map(str::to_owned)
        .chain((0..300).map(|round| format!("round-{round}.json")))
        .chain((1..=200).map(|round| format!("pan-round-{round}.json")));
    for file in fixtures {
        let path = directory.join(file);
        let bytes = fs::read(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
        assert!(
            validate_project_file_json(&bytes),
            "native validator rejected {}",
            path.display()
        );
    }
}
