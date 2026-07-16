fn main() {
    const APPLICATION_COMMANDS: &[&str] = &[
        "file_open_project",
        "file_open_midi",
        "file_open_audio",
        "file_export_project",
        "file_export_midi",
        "file_export_wav",
        "app_claim_close_request",
        "app_finish_close",
        "persistence_initialize",
        "persistence_list",
        "persistence_load",
        "persistence_get_project_state",
        "persistence_load_branch",
        "persistence_load_most_recent",
        "persistence_stage_crash_draft",
        "persistence_save",
        "persistence_remove",
        "persistence_get_legacy_migration_status",
        "persistence_backup_legacy_snapshot",
        "persistence_import_legacy_project",
        "persistence_complete_legacy_migration",
        "persistence_get_erase_all_status",
        "persistence_prepare_erase_all",
        "persistence_complete_erase_all",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APPLICATION_COMMANDS)),
    )
    .expect("failed to build the Compose Tutor Studio Tauri manifest");
}
