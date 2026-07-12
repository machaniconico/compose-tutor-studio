use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryOperation {
    Initialize,
    List,
    Load,
    Save,
    Remove,
    EraseAll,
    Close,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PersistenceErrorCode {
    StorageUnavailable,
    QuotaExceeded,
    AccessDenied,
    InvalidProject,
    SerializationFailed,
    TooLarge,
    CorruptData,
    UnsupportedVersion,
    Conflict,
    ReadFailed,
    WriteFailed,
    DeleteFailed,
    MigrationFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetryPolicy {
    Automatic,
    Manual,
    Never,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceErrorDto {
    #[serde(skip_serializing)]
    pub operation: RepositoryOperation,
    pub code: PersistenceErrorCode,
    pub retry: RetryPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

impl PersistenceErrorDto {
    pub fn new(
        operation: RepositoryOperation,
        code: PersistenceErrorCode,
        retry: RetryPolicy,
        project_id: Option<&str>,
    ) -> Self {
        Self {
            operation,
            code,
            retry,
            project_id: project_id.map(str::to_owned),
        }
    }
}

#[derive(Clone, Debug)]
pub enum ExpectedHeadDto {
    Repair,
    Empty,
    Match { version: String },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum ExpectedHeadWireDto {
    Repair {},
    Empty {},
    Match { version: String },
}

impl<'de> Deserialize<'de> for ExpectedHeadDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match ExpectedHeadWireDto::deserialize(deserializer)? {
            ExpectedHeadWireDto::Repair {} => Self::Repair,
            ExpectedHeadWireDto::Empty {} => Self::Empty,
            ExpectedHeadWireDto::Match { version } => Self::Match { version },
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequestDto {
    pub project_id: String,
    pub project_json: String,
    pub activation_id: String,
    pub revision: u64,
    pub write_id: String,
    pub expected_head: ExpectedHeadDto,
    #[serde(default)]
    pub predecessor_write_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrashDraftRequestDto {
    pub project_id: String,
    pub project_json: String,
    pub activation_id: String,
    pub revision: u64,
    pub write_id: String,
    pub expected_head: ExpectedHeadDto,
    #[serde(default)]
    pub predecessor_write_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRequestDto {
    pub project_id: String,
    pub delete_id: String,
    pub expected_head: ExpectedHeadDto,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReceiptDto {
    pub project_id: String,
    pub activation_id: String,
    pub revision: u64,
    pub write_id: String,
    pub head_version: String,
    pub saved_at: String,
    pub bytes: usize,
    pub retained_generations: usize,
    pub legacy_mirror_written: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashDraftReceiptDto {
    pub project_id: String,
    pub activation_id: String,
    pub revision: u64,
    pub write_id: String,
    pub protected_at: String,
    pub bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveReceiptDto {
    pub project_id: String,
    pub delete_id: String,
    pub head_version: String,
    pub removed: bool,
    pub cleanup_complete: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EraseAllRequestDto {
    pub erase_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EraseAllReceiptDto {
    pub erase_id: String,
    pub native_data_removed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum EraseAllStatusDto {
    Idle,
    Pending { erase_id: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum ProjectBranchSource {
    RecoveryJournal,
    InterruptedSave,
    LegacyMigration,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBranchSummaryDto {
    pub branch_id: String,
    pub source: ProjectBranchSource,
    pub activation_id: String,
    pub revision: u64,
    pub write_id: String,
    pub saved_at: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBranchDto {
    pub branch_id: String,
    pub source: ProjectBranchSource,
    pub activation_id: String,
    pub revision: u64,
    pub write_id: String,
    pub saved_at: String,
    pub title: String,
    pub updated_at: String,
    pub project_json: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum UnreadableProjectErrorCode {
    CorruptData,
    UnsupportedVersion,
    MigrationFailed,
    Conflict,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectSummaryDto {
    Ready {
        id: String,
        title: String,
        updated_at: String,
        recovered: bool,
        branches: Vec<ProjectBranchSummaryDto>,
    },
    Unreadable {
        id: String,
        error_code: UnreadableProjectErrorCode,
        branches: Vec<ProjectBranchSummaryDto>,
    },
}

impl ProjectSummaryDto {
    pub fn updated_at(&self) -> Option<&str> {
        match self {
            Self::Ready { updated_at, .. } => Some(updated_at),
            Self::Unreadable { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum ProjectSource {
    Generation,
    Legacy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum ProjectRecoveryReason {
    HeadMissing,
    HeadCorrupt,
    HeadStale,
    GenerationCorrupt,
    LegacyProject,
    RecoveryJournal,
    InterruptedSave,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProjectDto {
    pub project_json: String,
    pub head_version: Option<String>,
    pub source: ProjectSource,
    pub recovered: bool,
    pub recovery_reason: Option<ProjectRecoveryReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectStateValue {
    Missing,
    Active,
    Deleted,
    Unreadable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStateDto {
    pub state: ProjectStateValue,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyStorageSnapshotRecordDto {
    pub key: String,
    pub value: String,
    pub value_bytes: u64,
    pub checksum: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyStorageSnapshotDto {
    pub storage_version: u64,
    pub created_at: String,
    pub entries: Vec<LegacyStorageSnapshotRecordDto>,
    pub total_bytes: u64,
    pub content_checksum: String,
    pub checksum: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationStatusDto {
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyProjectImportRequestDto {
    pub content_checksum: String,
    pub migration_version: u64,
    pub project_id: String,
    pub source_keys: Vec<String>,
    #[serde(default)]
    pub project_json: Option<String>,
    #[serde(default)]
    pub branch: Option<LegacyBranchCandidateDto>,
    #[serde(default)]
    pub diagnostic: Option<LegacyDiagnosticDto>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyDiagnosticDto {
    pub error_code: UnreadableProjectErrorCode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyBranchCandidateDto {
    pub source: ProjectBranchSource,
    pub activation_id: String,
    pub revision: u64,
    pub write_id: String,
    pub saved_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LegacyProjectImportStatus {
    Imported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProjectImportReceiptDto {
    pub project_id: String,
    pub status: LegacyProjectImportStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationCompletionDto {
    pub content_checksum: String,
    pub migration_version: u64,
    pub record_count: u64,
    pub total_bytes: u64,
    pub ready_project_count: u64,
    pub unreadable_project_count: u64,
    pub branch_count: u64,
}
