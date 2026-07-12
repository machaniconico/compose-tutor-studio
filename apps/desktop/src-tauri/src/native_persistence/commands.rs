use super::{
    models::{
        CrashDraftReceiptDto, CrashDraftRequestDto, EraseAllReceiptDto, EraseAllRequestDto,
        EraseAllStatusDto, LegacyMigrationCompletionDto, LegacyMigrationStatusDto,
        LegacyProjectImportReceiptDto, LegacyProjectImportRequestDto, LegacyStorageSnapshotDto,
        LoadedProjectDto, PersistenceErrorCode, PersistenceErrorDto, ProjectBranchDto,
        ProjectStateDto, ProjectSummaryDto, RemoveReceiptDto, RemoveRequestDto,
        RepositoryOperation, RetryPolicy, SaveReceiptDto, SaveRequestDto,
    },
    repository::{NativePersistenceState, NativeRepository},
};
use std::sync::Arc;
use tauri::State;

use crate::native_close::NativeCloseState;

async fn run_blocking<T: Send + 'static>(
    repository: Arc<NativeRepository>,
    operation: RepositoryOperation,
    project_id: Option<String>,
    action: impl FnOnce(Arc<NativeRepository>) -> Result<T, PersistenceErrorDto> + Send + 'static,
) -> Result<T, PersistenceErrorDto> {
    tauri::async_runtime::spawn_blocking(move || action(repository))
        .await
        .map_err(|_| {
            let code = match operation {
                RepositoryOperation::Save => PersistenceErrorCode::WriteFailed,
                RepositoryOperation::Remove | RepositoryOperation::EraseAll => {
                    PersistenceErrorCode::DeleteFailed
                }
                RepositoryOperation::Initialize | RepositoryOperation::Close => {
                    PersistenceErrorCode::StorageUnavailable
                }
                RepositoryOperation::List | RepositoryOperation::Load => {
                    PersistenceErrorCode::ReadFailed
                }
            };
            PersistenceErrorDto::new(
                operation,
                code,
                RetryPolicy::Automatic,
                project_id.as_deref(),
            )
        })?
}

#[tauri::command]
pub async fn persistence_initialize(
    state: State<'_, NativePersistenceState>,
    close_state: State<'_, NativeCloseState>,
) -> Result<(), PersistenceErrorDto> {
    // Bootstrap-only close authorization must disappear before any editable
    // repository can be opened, including when initialization later fails.
    close_state.enter_running();
    run_blocking(
        state.repository(),
        RepositoryOperation::Initialize,
        None,
        |repository| repository.initialize(),
    )
    .await
}

#[tauri::command]
pub async fn persistence_list(
    state: State<'_, NativePersistenceState>,
) -> Result<Vec<ProjectSummaryDto>, PersistenceErrorDto> {
    run_blocking(
        state.repository(),
        RepositoryOperation::List,
        None,
        |repository| repository.list(),
    )
    .await
}

#[tauri::command]
pub async fn persistence_load(
    state: State<'_, NativePersistenceState>,
    project_id: String,
) -> Result<Option<LoadedProjectDto>, PersistenceErrorDto> {
    let error_project_id = project_id.clone();
    run_blocking(
        state.repository(),
        RepositoryOperation::Load,
        Some(error_project_id),
        move |repository| repository.load(project_id),
    )
    .await
}

#[tauri::command]
pub async fn persistence_get_project_state(
    state: State<'_, NativePersistenceState>,
    project_id: String,
) -> Result<ProjectStateDto, PersistenceErrorDto> {
    let error_project_id = project_id.clone();
    run_blocking(
        state.repository(),
        RepositoryOperation::Load,
        Some(error_project_id),
        move |repository| repository.get_project_state(project_id),
    )
    .await
}

#[tauri::command]
pub async fn persistence_load_branch(
    state: State<'_, NativePersistenceState>,
    project_id: String,
    branch_id: String,
) -> Result<Option<ProjectBranchDto>, PersistenceErrorDto> {
    let error_project_id = project_id.clone();
    run_blocking(
        state.repository(),
        RepositoryOperation::Load,
        Some(error_project_id),
        move |repository| repository.load_branch(project_id, branch_id),
    )
    .await
}

#[tauri::command]
pub async fn persistence_load_most_recent(
    state: State<'_, NativePersistenceState>,
) -> Result<Option<LoadedProjectDto>, PersistenceErrorDto> {
    run_blocking(
        state.repository(),
        RepositoryOperation::Load,
        None,
        |repository| repository.load_most_recent(),
    )
    .await
}

#[tauri::command]
pub async fn persistence_save(
    state: State<'_, NativePersistenceState>,
    request: SaveRequestDto,
) -> Result<SaveReceiptDto, PersistenceErrorDto> {
    let project_id = request.project_id.clone();
    run_blocking(
        state.repository(),
        RepositoryOperation::Save,
        Some(project_id),
        move |repository| repository.save(request),
    )
    .await
}

#[tauri::command]
pub async fn persistence_stage_crash_draft(
    state: State<'_, NativePersistenceState>,
    request: CrashDraftRequestDto,
) -> Result<CrashDraftReceiptDto, PersistenceErrorDto> {
    let project_id = request.project_id.clone();
    run_blocking(
        state.repository(),
        RepositoryOperation::Save,
        Some(project_id),
        move |repository| repository.stage_crash_draft(request),
    )
    .await
}

#[tauri::command]
pub async fn persistence_remove(
    state: State<'_, NativePersistenceState>,
    request: RemoveRequestDto,
) -> Result<RemoveReceiptDto, PersistenceErrorDto> {
    let project_id = request.project_id.clone();
    run_blocking(
        state.repository(),
        RepositoryOperation::Remove,
        Some(project_id),
        move |repository| repository.remove(request),
    )
    .await
}

#[tauri::command]
pub async fn persistence_get_legacy_migration_status(
    state: State<'_, NativePersistenceState>,
    content_checksum: String,
    migration_version: u64,
) -> Result<LegacyMigrationStatusDto, PersistenceErrorDto> {
    run_blocking(
        state.repository(),
        RepositoryOperation::List,
        None,
        move |repository| {
            repository.get_legacy_migration_status(content_checksum, migration_version)
        },
    )
    .await
}

#[tauri::command]
pub async fn persistence_backup_legacy_snapshot(
    state: State<'_, NativePersistenceState>,
    snapshot: LegacyStorageSnapshotDto,
) -> Result<(), PersistenceErrorDto> {
    run_blocking(
        state.repository(),
        RepositoryOperation::Save,
        None,
        move |repository| repository.backup_legacy_snapshot(snapshot),
    )
    .await
}

#[tauri::command]
pub async fn persistence_import_legacy_project(
    state: State<'_, NativePersistenceState>,
    request: LegacyProjectImportRequestDto,
) -> Result<LegacyProjectImportReceiptDto, PersistenceErrorDto> {
    run_blocking(
        state.repository(),
        RepositoryOperation::Save,
        None,
        move |repository| repository.import_legacy_project(request),
    )
    .await
}

#[tauri::command]
pub async fn persistence_complete_legacy_migration(
    state: State<'_, NativePersistenceState>,
    request: LegacyMigrationCompletionDto,
) -> Result<(), PersistenceErrorDto> {
    run_blocking(
        state.repository(),
        RepositoryOperation::Save,
        None,
        move |repository| repository.complete_legacy_migration(request),
    )
    .await
}

#[tauri::command]
pub async fn persistence_get_erase_all_status(
    state: State<'_, NativePersistenceState>,
    close_state: State<'_, NativeCloseState>,
) -> Result<EraseAllStatusDto, PersistenceErrorDto> {
    let status = run_blocking(
        state.repository(),
        RepositoryOperation::EraseAll,
        None,
        |repository| repository.get_erase_all_status(),
    )
    .await?;
    if matches!(status, EraseAllStatusDto::Idle) {
        close_state.note_bootstrap_idle_verified();
    }
    Ok(status)
}

#[tauri::command]
pub async fn persistence_prepare_erase_all(
    state: State<'_, NativePersistenceState>,
    request: EraseAllRequestDto,
) -> Result<EraseAllReceiptDto, PersistenceErrorDto> {
    run_blocking(
        state.repository(),
        RepositoryOperation::EraseAll,
        None,
        move |repository| repository.prepare_erase_all(request),
    )
    .await
}

#[tauri::command]
pub async fn persistence_complete_erase_all(
    state: State<'_, NativePersistenceState>,
    close_state: State<'_, NativeCloseState>,
    request: EraseAllRequestDto,
) -> Result<(), PersistenceErrorDto> {
    let erase_id = request.erase_id.clone();
    run_blocking(
        state.repository(),
        RepositoryOperation::EraseAll,
        None,
        move |repository| repository.complete_erase_all(request),
    )
    .await?;
    close_state.note_erase_completed(&erase_id);
    Ok(())
}
