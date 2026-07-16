use super::models::{
    CrashDraftReceiptDto, CrashDraftRequestDto, EraseAllReceiptDto, EraseAllRequestDto,
    EraseAllStatusDto, ExpectedHeadDto, LegacyBranchCandidateDto, LegacyMigrationCompletionDto,
    LegacyMigrationStatusDto, LegacyProjectImportReceiptDto, LegacyProjectImportRequestDto,
    LegacyProjectImportStatus, LegacyStorageSnapshotDto, LegacyStorageSnapshotRecordDto,
    LoadedProjectDto, PersistenceErrorCode, PersistenceErrorDto, ProjectBranchDto,
    ProjectBranchSource, ProjectBranchSummaryDto, ProjectRecoveryReason, ProjectSource,
    ProjectStateDto, ProjectStateValue, ProjectSummaryDto, RemoveReceiptDto, RemoveRequestDto,
    RepositoryOperation, RetryPolicy, SaveReceiptDto, SaveRequestDto, UnreadableProjectErrorCode,
};
use atomicwrites::{AllowOverwrite, AtomicFile};
use fs4::{FileExt, TryLockError};
use rusqlite::{
    params, Connection, Error as SqliteError, ErrorCode as SqliteErrorCode, OpenFlags,
    OptionalExtension, Row, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{ErrorKind as IoErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicPtr, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    time::Duration,
};
use tauri::{Manager, Runtime};

const DATABASE_FILE_NAME: &str = "projects-v1.sqlite3";
const ERASE_MARKER_FILE_NAME: &str = "erase-all-v1.json";
const PROCESS_LOCK_FILE_NAME: &str = ".compose-tutor-studio.lock";
const ERASE_MARKER_VERSION: u64 = 1;
const MAX_ERASE_MARKER_BYTES: u64 = 4 * 1024;
const DATABASE_SCHEMA_VERSION: i64 = 2;
const PROJECT_SCHEMA_VERSION: u64 = 3;
const MIN_PROJECT_SCHEMA_VERSION: u64 = 1;
const MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS: usize = 200_000;
const CRASH_DRAFT_FORMAT_VERSION: i64 = 1;
const LEGACY_STORAGE_VERSION: u64 = 1;
const LEGACY_MIGRATION_VERSION: u64 = 3;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const APPLICATION_ID: i64 = 0x4354_5331; // "CTS1"
const MAX_PROJECT_JSON_BYTES: usize = 16 * 1024 * 1024;
const MAX_ID_BYTES: usize = 1_024;
const MAX_OPERATION_ID_BYTES: usize = 256;
const MAX_LEGACY_SNAPSHOT_ENTRIES: usize = 4_096;
const MAX_LEGACY_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_CRASH_DRAFT_ENTRIES: usize = 64;
const MAX_CRASH_DRAFT_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const RETAIN_GENERATIONS: usize = 3;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const SAFE_SQLITE_VFS_NAME: &str = "cts-safe-vfs-v1";
const EXPECTED_BUNDLED_SQLITE_VERSION: i32 = 3_053_002;
const MIGRATION_V1: &str = include_str!("../../migrations/0001_init.sql");
const MIGRATION_V2: &str = include_str!("../../migrations/0002_crash_drafts.sql");
const GENERATION_COLUMNS: &str = "seq, project_id, kind, operation_id, head_version, \
    parent_head_version, activation_id, revision, predecessor_write_id, saved_at, \
    payload_json, payload_crc32, payload_bytes, title, updated_at, record_crc32, branch_source";
const CRASH_DRAFT_COLUMNS: &str = "project_id, activation_id, revision, write_id, \
    base_head_known, base_head_version, predecessor_write_id, saved_at, payload_json, \
    payload_crc32, payload_bytes, title, updated_at, format_version, record_crc32";

#[derive(Debug, thiserror::Error)]
pub enum DatabasePathError {
    #[error("could not resolve the application data directory")]
    Resolve(#[from] tauri::Error),
    #[cfg(feature = "native-test")]
    #[error("CTS_NATIVE_TEST_DATA_DIR must be an absolute path")]
    RelativeTestOverride,
}

#[derive(Debug, thiserror::Error)]
pub enum PersistenceSetupError {
    #[error("the application data directory is unsafe")]
    UnsafeDataDirectory,
    #[error("the application data directory has an unsafe process lock entry")]
    UnsafeLockEntry,
    #[error("another Compose Tutor Studio process owns the application data directory")]
    AlreadyRunning,
    #[error("could not acquire the application data process lock")]
    Io(#[source] std::io::Error),
}

pub fn database_path<R: Runtime>(app: &tauri::App<R>) -> Result<PathBuf, DatabasePathError> {
    #[cfg(feature = "native-test")]
    if let Some(path) = std::env::var_os("CTS_NATIVE_TEST_DATA_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(DatabasePathError::RelativeTestOverride);
        }
        return Ok(path.join(DATABASE_FILE_NAME));
    }

    Ok(app.path().app_data_dir()?.join(DATABASE_FILE_NAME))
}

pub struct NativePersistenceState {
    repository: Arc<NativeRepository>,
    _process_lock: ProcessLock,
}

impl NativePersistenceState {
    pub fn acquire(path: PathBuf) -> Result<Self, PersistenceSetupError> {
        let process_lock = ProcessLock::acquire(&path)?;
        Ok(Self {
            repository: Arc::new(NativeRepository::new(path)),
            _process_lock: process_lock,
        })
    }

    pub(crate) fn repository(&self) -> Arc<NativeRepository> {
        Arc::clone(&self.repository)
    }
}

pub(crate) struct NativeRepository {
    path: PathBuf,
    runtime: Mutex<RepositoryRuntime>,
}

struct RepositoryRuntime {
    connection: Option<Connection>,
    vfs_boundary: Option<SafeVfsBoundaryGuard>,
    seal: RepositorySeal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RepositorySeal {
    Open,
    Pending(String),
    Completed(String),
}

struct ProcessLock {
    file: File,
    _directory: File,
}

impl ProcessLock {
    fn acquire(database_path: &Path) -> Result<Self, PersistenceSetupError> {
        let parent = database_path.parent().ok_or_else(|| {
            PersistenceSetupError::Io(std::io::Error::from(IoErrorKind::NotFound))
        })?;
        fs::create_dir_all(parent).map_err(PersistenceSetupError::Io)?;
        harden_app_data_directory_permissions(parent).map_err(|error| {
            if error.kind() == IoErrorKind::InvalidData {
                PersistenceSetupError::UnsafeDataDirectory
            } else {
                PersistenceSetupError::Io(error)
            }
        })?;
        let (directory, _) = open_retained_data_directory(parent).map_err(|error| {
            if error.kind() == IoErrorKind::InvalidData {
                PersistenceSetupError::UnsafeDataDirectory
            } else {
                PersistenceSetupError::Io(error)
            }
        })?;
        let lock_path = parent.join(PROCESS_LOCK_FILE_NAME);
        match fs::symlink_metadata(&lock_path) {
            Ok(metadata) if !lock_path_metadata_is_safe(&metadata) => {
                return Err(PersistenceSetupError::UnsafeLockEntry);
            }
            Ok(_) => {}
            Err(error) if error.kind() == IoErrorKind::NotFound => {}
            Err(error) => return Err(PersistenceSetupError::Io(error)),
        }
        let file = open_path_without_following(&lock_path, true, true)
            .map_err(PersistenceSetupError::Io)?;
        if !opened_file_is_safe_lock_entry(&file, &lock_path).map_err(PersistenceSetupError::Io)? {
            return Err(PersistenceSetupError::UnsafeLockEntry);
        }
        harden_private_file_permissions(&file).map_err(PersistenceSetupError::Io)?;
        if !opened_file_is_safe_lock_entry(&file, &lock_path).map_err(PersistenceSetupError::Io)? {
            return Err(PersistenceSetupError::UnsafeLockEntry);
        }
        match FileExt::try_lock(&file) {
            Ok(()) => {
                harden_private_file_permissions(&file).map_err(PersistenceSetupError::Io)?;
                if !opened_file_is_safe_lock_entry(&file, &lock_path)
                    .map_err(PersistenceSetupError::Io)?
                {
                    return Err(PersistenceSetupError::UnsafeLockEntry);
                }
                Ok(Self {
                    file,
                    _directory: directory,
                })
            }
            Err(TryLockError::WouldBlock) => Err(PersistenceSetupError::AlreadyRunning),
            Err(TryLockError::Error(error)) => Err(PersistenceSetupError::Io(error)),
        }
    }
}

impl Drop for ProcessLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EraseMarker {
    storage_version: u64,
    erase_id: String,
    checksum: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EraseMarkerChecksum<'a> {
    storage_version: u64,
    erase_id: &'a str,
}

enum EraseMarkerRemovalError {
    BeforeUnlink(PersistenceErrorDto),
    AfterUnlink(PersistenceErrorDto),
}

#[derive(Clone, Debug)]
struct CanonicalProject {
    value: Value,
    json: Vec<u8>,
    project_id: String,
    title: String,
    updated_at: String,
    payload_crc32: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GenerationKind {
    Save,
    Delete,
}

impl GenerationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Save => "save",
            Self::Delete => "delete",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "save" => Some(Self::Save),
            "delete" => Some(Self::Delete),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GenerationRow {
    seq: i64,
    project_id: String,
    kind: String,
    operation_id: String,
    head_version: String,
    parent_head_version: Option<String>,
    activation_id: Option<String>,
    revision: Option<i64>,
    predecessor_write_id: Option<String>,
    saved_at: String,
    payload_json: Option<Vec<u8>>,
    payload_crc32: Option<String>,
    payload_bytes: i64,
    title: Option<String>,
    updated_at: Option<String>,
    record_crc32: String,
    branch_source: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CrashDraftRow {
    project_id: String,
    activation_id: String,
    revision: i64,
    write_id: String,
    base_head_known: bool,
    base_head_version: Option<String>,
    predecessor_write_id: Option<String>,
    saved_at: String,
    payload_json: Vec<u8>,
    payload_crc32: String,
    payload_bytes: i64,
    title: String,
    updated_at: String,
    format_version: i64,
    record_crc32: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HeadRow {
    project_id: String,
    generation_seq: i64,
    head_version: String,
    deleted: bool,
    head_crc32: String,
}

#[derive(Clone, Debug, PartialEq)]
enum ValidatedGeneration {
    Save { project: Value },
    Delete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GenerationIssue {
    Corrupt,
    Unsupported,
}

#[derive(Clone, Debug)]
struct ResolvedActive {
    generation: GenerationRow,
    project: Value,
    head_version: Option<String>,
    recovered: bool,
    recovery_reason: Option<ProjectRecoveryReason>,
}

#[derive(Clone, Debug)]
enum ProjectResolution {
    Active(Box<ResolvedActive>),
    Deleted,
    Missing,
    Unreadable(UnreadableProjectErrorCode),
}

#[derive(Clone, Debug)]
enum CurrentHeadState {
    Empty,
    DeletedEvidence,
    Valid {
        head: HeadRow,
        row: Box<GenerationRow>,
        value: ValidatedGeneration,
    },
    Corrupt(Option<HeadRow>),
    Unsupported(HeadRow),
    UnsupportedEvidence,
    DiagnosticEvidence(UnreadableProjectErrorCode),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CanonicalGenerationEvidence {
    None,
    Save,
    Delete,
    Unsupported,
}

#[derive(Clone, Copy)]
struct PredecessorExpectation<'a> {
    write_id: &'a str,
    activation_id: &'a str,
    revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationDigest<'a> {
    project_id: &'a str,
    kind: &'a str,
    operation_id: &'a str,
    head_version: &'a str,
    parent_head_version: Option<&'a str>,
    activation_id: Option<&'a str>,
    revision: Option<i64>,
    predecessor_write_id: Option<&'a str>,
    saved_at: &'a str,
    payload_crc32: Option<&'a str>,
    payload_bytes: i64,
    title: Option<&'a str>,
    updated_at: Option<&'a str>,
    branch_source: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashDraftDigest<'a> {
    project_id: &'a str,
    activation_id: &'a str,
    revision: i64,
    write_id: &'a str,
    base_head_known: bool,
    base_head_version: Option<&'a str>,
    predecessor_write_id: Option<&'a str>,
    saved_at: &'a str,
    payload_crc32: &'a str,
    payload_bytes: i64,
    title: &'a str,
    updated_at: &'a str,
    format_version: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadDigest<'a> {
    project_id: &'a str,
    generation_seq: i64,
    head_version: &'a str,
    deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRecordChecksum<'a> {
    key: &'a str,
    value: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyStableContentChecksum<'a> {
    storage_version: u64,
    entries: &'a [LegacyStorageSnapshotRecordDto],
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEnvelopeChecksum<'a> {
    storage_version: u64,
    created_at: &'a str,
    entries: &'a [LegacyStorageSnapshotRecordDto],
    total_bytes: u64,
    content_checksum: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProjectGenerationProof<'a> {
    storage_version: u64,
    kind: &'a str,
    project_id: &'a str,
    ordinal: u64,
    parent_head_version: Option<&'a str>,
    write_id: &'a str,
    activation_id: &'a str,
    revision: u64,
    saved_at: &'a str,
    bytes: u64,
    project_json: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTombstoneGenerationProof<'a> {
    storage_version: u64,
    kind: &'a str,
    project_id: &'a str,
    ordinal: u64,
    parent_head_version: Option<&'a str>,
    delete_id: &'a str,
    deleted_at: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRecoveryProof<'a> {
    storage_version: u64,
    project_id: &'a str,
    base_head_known: bool,
    base_head_version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    predecessor_write_id: Option<&'a str>,
    activation_id: &'a str,
    revision: u64,
    write_id: &'a str,
    saved_at: &'a str,
    bytes: u64,
    project_json: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHeadProof<'a> {
    storage_version: u64,
    state: &'a str,
    project_id: &'a str,
    ordinal: u64,
    generation_key: &'a str,
    operation_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_head_version: Option<Option<&'a str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload_checksum: Option<Option<&'a str>>,
    committed_at: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyIntentProof<'a> {
    storage_version: u64,
    project_id: &'a str,
    kind: &'a str,
    generation_key: &'a str,
    operation_id: &'a str,
    parent_head_version: Option<&'a str>,
}

#[derive(Clone, Debug)]
struct LegacyActiveHeadEvidence {
    ordinal: u64,
    generation_key: String,
    operation_id: String,
    head_version: String,
    parent_head_version: Option<Option<String>>,
    payload_checksum: Option<Option<String>>,
}

#[derive(Clone, Debug)]
struct LegacyProjectCandidate {
    project_json: String,
    activation_id: String,
    revision: u64,
    write_id: String,
    saved_at: String,
}

#[derive(Clone, Debug)]
struct LegacyGenerationCandidate {
    candidate: LegacyProjectCandidate,
    key: String,
    ordinal: u64,
    head_version: String,
    parent_head_version: Option<String>,
}

#[derive(Clone, Debug)]
enum LegacyCandidateSelection {
    None,
    Candidate(LegacyProjectCandidate),
    Conflict,
}

#[derive(Clone, Debug)]
enum LegacyCanonicalAuthority {
    None,
    Candidate(String),
    Conflict,
    Deleted,
    Unsupported,
}

#[derive(Clone, Debug)]
struct LegacyDeletedEvidence {
    project_id: String,
    delete_id: String,
    deleted_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectDto {
    id: String,
    schema_version: u64,
    title: String,
    bpm: f64,
    time_signature: [u64; 2],
    key: String,
    scale: String,
    length_bars: u64,
    length_beats: Option<f64>,
    tempo_map: Option<Vec<TempoMapEventDto>>,
    time_signature_map: Option<Vec<TimeSignatureMapEventDto>>,
    audio_assets: Option<Vec<AudioAssetDto>>,
    automation_lanes: Option<Vec<AutomationLaneDto>>,
    tracks: Vec<TrackDto>,
    chord_track: Vec<ChordDto>,
    sections: Vec<SectionDto>,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrackDto {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    role: Option<String>,
    color: Option<String>,
    clips: Vec<ClipDto>,
    volume: f64,
    pan: f64,
    #[serde(rename = "mute")]
    _mute: bool,
    #[serde(rename = "solo")]
    _solo: bool,
    instrument: Option<InstrumentDto>,
    effects: Vec<EffectDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstrumentDto {
    #[serde(rename = "type")]
    kind: String,
    preset: String,
    params: Option<HashMap<String, f64>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectDto {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "enabled")]
    _enabled: bool,
    params: HashMap<String, f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClipDto {
    id: String,
    track_id: String,
    #[serde(rename = "type")]
    kind: String,
    start_beat: f64,
    length_beats: f64,
    #[serde(rename = "loop")]
    _loop: bool,
    alias_of: Option<String>,
    notes: Option<Vec<NoteDto>>,
    drum_events: Option<Vec<DrumEventDto>>,
    steps_per_bar: Option<u64>,
    drum_groove: Option<DrumGrooveDto>,
    audio_asset_id: Option<String>,
    source_start_frame: Option<u64>,
    source_frame_count: Option<u64>,
    fade_in_frames: Option<u64>,
    fade_out_frames: Option<u64>,
    gain_db: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteDto {
    id: String,
    pitch: i64,
    start_beat: f64,
    duration_beats: f64,
    velocity: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DrumEventDto {
    id: String,
    lane: String,
    step_index: i64,
    velocity: i64,
    probability: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DrumGrooveDto {
    swing: f64,
    probability: f64,
    humanize_velocity: i64,
    seed: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChordDto {
    id: String,
    start_beat: f64,
    duration_beats: f64,
    symbol: String,
    root: String,
    quality: String,
    notes: Vec<i64>,
    degree: Option<String>,
    function: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SectionDto {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    start_bar: i64,
    length_bars: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TempoMapEventDto {
    id: String,
    beat: f64,
    bpm: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimeSignatureMapEventDto {
    id: String,
    beat: f64,
    numerator: u64,
    denominator: u64,
}

#[derive(Deserialize)]
#[serde(
    tag = "availability",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum AudioAssetDto {
    Ready {
        id: String,
        checksum_sha256: String,
        original_name: String,
        media_type: String,
        byte_length: u64,
        sample_rate: u64,
        channel_count: u64,
        frame_count: u64,
    },
    Unresolved {
        id: String,
        legacy_asset_id: Option<String>,
        reason: String,
    },
}

impl AudioAssetDto {
    fn id(&self) -> &str {
        match self {
            Self::Ready { id, .. } | Self::Unresolved { id, .. } => id,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationLaneDto {
    id: String,
    target: AutomationTargetDto,
    points: Vec<AutomationPointDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationTargetDto {
    #[serde(rename = "type")]
    kind: String,
    track_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationPointDto {
    id: String,
    beat: f64,
    value: f64,
    interpolation: String,
}

#[derive(Clone, Debug)]
struct LegacySnapshotRow {
    storage_version: i64,
    created_at: String,
    record_count: i64,
    total_bytes: i64,
    envelope_checksum: String,
    backup_crc32: String,
}

#[derive(Clone, Debug)]
struct LegacyMigrationRunRow {
    record_count: i64,
    total_bytes: i64,
    ready_project_count: i64,
    unreadable_project_count: i64,
    branch_count: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LegacyGenerationProvenance {
    content_checksum: String,
    migration_version: i64,
}

#[derive(Clone, Debug)]
struct LegacySnapshotRecordRow {
    ordinal: i64,
    key: Vec<u8>,
    value: Vec<u8>,
    value_bytes: i64,
    source_checksum: String,
    record_crc32: String,
}

#[derive(Clone, Debug)]
struct LegacyImportRow {
    project_id: String,
    source_keys: Vec<String>,
    candidate_kind: String,
    candidate_operation_id: String,
    payload_crc32: Option<String>,
    payload_bytes: Option<i64>,
    payload_json: Option<Vec<u8>>,
    title: Option<String>,
    updated_at: Option<String>,
    source: Option<String>,
    activation_id: Option<String>,
    revision: Option<i64>,
    write_id: Option<String>,
    saved_at: Option<String>,
    diagnostic_error_code: Option<String>,
}

impl NativeRepository {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            runtime: Mutex::new(RepositoryRuntime {
                connection: None,
                vfs_boundary: None,
                seal: RepositorySeal::Open,
            }),
        }
    }

    pub(crate) fn initialize(&self) -> Result<(), PersistenceErrorDto> {
        let mut runtime = self.lock(RepositoryOperation::Initialize, None)?;
        self.ensure_normal_operation_allowed(&mut runtime, RepositoryOperation::Initialize, None)?;
        if runtime.connection.is_some() {
            return Ok(());
        }

        let parent = self.path.parent().ok_or_else(|| {
            persistence_error(
                RepositoryOperation::Initialize,
                PersistenceErrorCode::StorageUnavailable,
                RetryPolicy::Manual,
                None,
            )
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            io_error_to_persistence(error, RepositoryOperation::Initialize, None)
        })?;

        harden_app_data_directory_permissions(parent).map_err(|_| database_boundary_error())?;
        let mut before_open = self.inspect_and_harden_database_family()?;
        if before_open.main_identity().is_none() {
            create_private_database_file(&self.path).map_err(|_| database_boundary_error())?;
            before_open = self.inspect_and_harden_database_family()?;
        }
        let sqlite_path = sqlite_open_path(&self.path).map_err(|_| database_boundary_error())?;
        ensure_safe_sqlite_vfs_registered()?;
        let vfs_boundary = SafeVfsBoundaryGuard::register(sqlite_path.clone())?;

        let mut connection = Connection::open_with_flags_and_vfs(
            sqlite_path,
            OpenFlags::default() | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            SAFE_SQLITE_VFS_NAME,
        )
        .map_err(|error| {
            sqlite_error_to_persistence(
                error,
                RepositoryOperation::Initialize,
                None,
                PersistenceErrorCode::StorageUnavailable,
            )
        })?;
        let after_open = self.inspect_and_harden_database_family()?;
        ensure_stable_main_database_identity(
            before_open.main_identity(),
            after_open.main_identity(),
        )?;
        let opened_main_identity = after_open
            .main_identity()
            .ok_or_else(database_boundary_error)?;
        ensure_sqlite_main_file_identity(&connection, opened_main_identity)?;

        let configuration = configure_and_migrate(&mut connection);
        let after_configuration = self.inspect_and_harden_database_family()?;
        ensure_stable_main_database_identity(
            Some(opened_main_identity),
            after_configuration.main_identity(),
        )?;
        ensure_sqlite_main_file_identity(&connection, opened_main_identity)?;
        if configuration.is_ok() {
            ensure_sqlite_wal_file_identity(&connection, after_configuration.identities[1])?;
        }
        configuration?;
        replay_crash_drafts(&mut connection)?;
        runtime.connection = Some(connection);
        runtime.vfs_boundary = Some(vfs_boundary);
        Ok(())
    }

    pub(crate) fn list(&self) -> Result<Vec<ProjectSummaryDto>, PersistenceErrorDto> {
        self.with_connection(RepositoryOperation::List, None, |connection| {
            let mut statement = connection
                .prepare(
                    "SELECT project_id, MAX(recent_seq) AS recent_seq
                     FROM (
                       SELECT project_id, generation_seq AS recent_seq FROM project_heads
                       UNION ALL
                       SELECT project_id, seq AS recent_seq FROM project_generations
                       UNION ALL
                       SELECT staging.project_id, 0 AS recent_seq
                       FROM legacy_project_staging AS staging
                       INNER JOIN legacy_migration_runs AS run
                         ON run.content_checksum = staging.content_checksum
                        AND run.migration_version = staging.migration_version
                       WHERE staging.candidate_kind = 'diagnostic'
                     )
                     GROUP BY project_id
                     ORDER BY recent_seq DESC, project_id ASC",
                )
                .map_err(|error| read_sql_error(error, RepositoryOperation::List, None))?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| read_sql_error(error, RepositoryOperation::List, None))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| read_sql_error(error, RepositoryOperation::List, None))?;
            drop(statement);

            let mut summaries = Vec::with_capacity(ids.len());
            for project_id in ids {
                let resolution = resolve_project(connection, &project_id).map_err(|error| {
                    read_sql_error(error, RepositoryOperation::List, Some(&project_id))
                })?;
                let branches = if matches!(
                    &resolution,
                    ProjectResolution::Unreadable(
                        UnreadableProjectErrorCode::UnsupportedVersion
                            | UnreadableProjectErrorCode::MigrationFailed
                    )
                ) {
                    Vec::new()
                } else {
                    branch_summaries(connection, &project_id).map_err(|error| {
                        read_sql_error(error, RepositoryOperation::List, Some(&project_id))
                    })?
                };
                match resolution {
                    ProjectResolution::Active(active) => {
                        summaries.push(ProjectSummaryDto::Ready {
                            id: project_id,
                            title: active.generation.title.clone().unwrap_or_default(),
                            updated_at: active.generation.updated_at.clone().unwrap_or_default(),
                            recovered: active.recovered,
                            branches,
                        });
                    }
                    ProjectResolution::Unreadable(error_code) => {
                        summaries.push(ProjectSummaryDto::Unreadable {
                            id: project_id,
                            error_code,
                            branches,
                        });
                    }
                    ProjectResolution::Missing if !branches.is_empty() => {
                        summaries.push(ProjectSummaryDto::Unreadable {
                            id: project_id,
                            error_code: UnreadableProjectErrorCode::Conflict,
                            branches,
                        });
                    }
                    ProjectResolution::Deleted | ProjectResolution::Missing => {}
                }
            }
            summaries.sort_by(
                |left, right| match (left.updated_at(), right.updated_at()) {
                    (Some(left), Some(right)) => right.cmp(left),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                },
            );
            Ok(summaries)
        })
    }

    pub(crate) fn load(
        &self,
        project_id: String,
    ) -> Result<Option<LoadedProjectDto>, PersistenceErrorDto> {
        validate_identifier(
            &project_id,
            MAX_ID_BYTES,
            RepositoryOperation::Load,
            Some(&project_id),
        )?;
        self.with_connection(RepositoryOperation::Load, Some(&project_id), |connection| {
            loaded_project_result(connection, &project_id)
        })
    }

    pub(crate) fn get_project_state(
        &self,
        project_id: String,
    ) -> Result<ProjectStateDto, PersistenceErrorDto> {
        validate_identifier(
            &project_id,
            MAX_ID_BYTES,
            RepositoryOperation::Load,
            Some(&project_id),
        )?;
        self.with_connection(RepositoryOperation::Load, Some(&project_id), |connection| {
            let state = match resolve_project(connection, &project_id).map_err(|error| {
                read_sql_error(error, RepositoryOperation::Load, Some(&project_id))
            })? {
                ProjectResolution::Active(_) => ProjectStateValue::Active,
                ProjectResolution::Deleted => ProjectStateValue::Deleted,
                ProjectResolution::Missing => ProjectStateValue::Missing,
                ProjectResolution::Unreadable(_) => ProjectStateValue::Unreadable,
            };
            Ok(ProjectStateDto { state })
        })
    }

    pub(crate) fn load_branch(
        &self,
        project_id: String,
        branch_id: String,
    ) -> Result<Option<ProjectBranchDto>, PersistenceErrorDto> {
        {
            let mut runtime = self.lock(RepositoryOperation::Load, Some(&project_id))?;
            self.ensure_normal_operation_allowed(
                &mut runtime,
                RepositoryOperation::Load,
                Some(&project_id),
            )?;
        }
        validate_identifier(
            &project_id,
            MAX_ID_BYTES,
            RepositoryOperation::Load,
            Some(&project_id),
        )?;
        let sequence = branch_id
            .strip_prefix("sqlite-generation:")
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value > 0);
        let Some(sequence) = sequence else {
            return Ok(None);
        };

        self.with_connection(RepositoryOperation::Load, Some(&project_id), |connection| {
            match resolve_project(connection, &project_id).map_err(|error| {
                read_sql_error(error, RepositoryOperation::Load, Some(&project_id))
            })? {
                ProjectResolution::Deleted => return Ok(None),
                ProjectResolution::Unreadable(UnreadableProjectErrorCode::UnsupportedVersion) => {
                    return Err(persistence_error(
                        RepositoryOperation::Load,
                        PersistenceErrorCode::UnsupportedVersion,
                        RetryPolicy::Never,
                        Some(&project_id),
                    ));
                }
                ProjectResolution::Unreadable(UnreadableProjectErrorCode::MigrationFailed) => {
                    return Err(persistence_error(
                        RepositoryOperation::Load,
                        PersistenceErrorCode::MigrationFailed,
                        RetryPolicy::Never,
                        Some(&project_id),
                    ));
                }
                ProjectResolution::Active(_)
                | ProjectResolution::Missing
                | ProjectResolution::Unreadable(
                    UnreadableProjectErrorCode::CorruptData | UnreadableProjectErrorCode::Conflict,
                ) => {}
            }
            let Some(generation) =
                read_generation_by_seq(connection, sequence).map_err(|error| {
                    read_sql_error(error, RepositoryOperation::Load, Some(&project_id))
                })?
            else {
                return Ok(None);
            };
            if generation.project_id != project_id || generation.branch_source.is_none() {
                return Ok(None);
            }
            if !legacy_generation_is_live(connection, &generation).map_err(|error| {
                read_sql_error(error, RepositoryOperation::Load, Some(&project_id))
            })? {
                return Ok(None);
            }
            let ValidatedGeneration::Save { .. } =
                validate_generation(&generation).map_err(|issue| match issue {
                    GenerationIssue::Corrupt => persistence_error(
                        RepositoryOperation::Load,
                        PersistenceErrorCode::CorruptData,
                        RetryPolicy::Never,
                        Some(&project_id),
                    ),
                    GenerationIssue::Unsupported => persistence_error(
                        RepositoryOperation::Load,
                        PersistenceErrorCode::UnsupportedVersion,
                        RetryPolicy::Never,
                        Some(&project_id),
                    ),
                })?
            else {
                return Ok(None);
            };
            let Some(source) = generation
                .branch_source
                .as_deref()
                .and_then(project_branch_source)
            else {
                return Ok(None);
            };
            let Some(activation_id) = generation.activation_id else {
                return Ok(None);
            };
            let Some(revision) = generation
                .revision
                .and_then(|value| u64::try_from(value).ok())
            else {
                return Ok(None);
            };
            let project_json = generation
                .payload_json
                .as_deref()
                .and_then(|payload| std::str::from_utf8(payload).ok())
                .map(str::to_owned)
                .ok_or_else(|| {
                    persistence_error(
                        RepositoryOperation::Load,
                        PersistenceErrorCode::CorruptData,
                        RetryPolicy::Never,
                        Some(&project_id),
                    )
                })?;
            Ok(Some(ProjectBranchDto {
                branch_id,
                source,
                activation_id,
                revision,
                write_id: generation.operation_id,
                saved_at: generation.saved_at,
                title: generation.title.unwrap_or_default(),
                updated_at: generation.updated_at.unwrap_or_default(),
                project_json,
            }))
        })
    }

    pub(crate) fn load_most_recent(&self) -> Result<Option<LoadedProjectDto>, PersistenceErrorDto> {
        let summaries = self.list()?;
        if let Some(project_id) = summaries.iter().find_map(|summary| match summary {
            ProjectSummaryDto::Ready { id, .. } => Some(id.clone()),
            ProjectSummaryDto::Unreadable { .. } => None,
        }) {
            return self.load(project_id);
        }
        if let Some((project_id, error_code)) = summaries.iter().find_map(|summary| match summary {
            ProjectSummaryDto::Unreadable { id, error_code, .. } => {
                Some((id.as_str(), *error_code))
            }
            ProjectSummaryDto::Ready { .. } => None,
        }) {
            let code = match error_code {
                UnreadableProjectErrorCode::CorruptData => PersistenceErrorCode::CorruptData,
                UnreadableProjectErrorCode::UnsupportedVersion => {
                    PersistenceErrorCode::UnsupportedVersion
                }
                UnreadableProjectErrorCode::MigrationFailed => {
                    PersistenceErrorCode::MigrationFailed
                }
                UnreadableProjectErrorCode::Conflict => PersistenceErrorCode::Conflict,
            };
            return Err(persistence_error(
                RepositoryOperation::Load,
                code,
                RetryPolicy::Never,
                Some(project_id),
            ));
        }
        Ok(None)
    }

    pub(crate) fn stage_crash_draft(
        &self,
        request: CrashDraftRequestDto,
    ) -> Result<CrashDraftReceiptDto, PersistenceErrorDto> {
        validate_identifier(
            &request.project_id,
            MAX_ID_BYTES,
            RepositoryOperation::Save,
            Some(&request.project_id),
        )?;
        let canonical = canonical_project_json(
            &request.project_json,
            RepositoryOperation::Save,
            Some(&request.project_id),
        )?;
        let project_id = request.project_id.clone();
        if canonical.project_id != project_id {
            return Err(persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::InvalidProject,
                RetryPolicy::Never,
                Some(&project_id),
            ));
        }
        validate_identifier(
            &request.activation_id,
            MAX_OPERATION_ID_BYTES,
            RepositoryOperation::Save,
            Some(&project_id),
        )?;
        validate_identifier(
            &request.write_id,
            MAX_OPERATION_ID_BYTES,
            RepositoryOperation::Save,
            Some(&project_id),
        )?;
        validate_expected_head(&request.expected_head, &project_id)?;
        if let Some(predecessor) = &request.predecessor_write_id {
            validate_identifier(
                predecessor,
                MAX_OPERATION_ID_BYTES,
                RepositoryOperation::Save,
                Some(&project_id),
            )?;
        }
        let revision = i64::try_from(request.revision).map_err(|_| {
            persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::InvalidProject,
                RetryPolicy::Never,
                Some(&project_id),
            )
        })?;

        self.with_connection(RepositoryOperation::Save, Some(&project_id), |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            preflight_crash_draft_storage(
                &transaction,
                RepositoryOperation::Save,
                Some(&project_id),
            )?;

            ensure_crash_draft_write_allowed(&transaction, &project_id)?;
            if let Some(existing_generation) = read_generation_by_operation(
                &transaction,
                &project_id,
                GenerationKind::Save,
                &request.write_id,
            )
            .map_err(|error| write_sql_error(error, Some(&project_id)))?
            {
                if canonical_generation_matches_crash_request(
                    &existing_generation,
                    &request,
                    revision,
                    &canonical,
                ) {
                    delete_crash_drafts_through(
                        &transaction,
                        &project_id,
                        &request.activation_id,
                        revision,
                        Some((
                            &request.write_id,
                            &canonical.payload_crc32,
                            canonical.json.as_slice(),
                        )),
                    )?;
                    let receipt =
                        crash_draft_receipt_from_generation(&request, &existing_generation);
                    transaction
                        .commit()
                        .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                    return Ok(receipt);
                }
                return Err(conflict(RepositoryOperation::Save, &project_id));
            }

            if latest_canonical_revision_for_activation(
                &transaction,
                &project_id,
                &request.activation_id,
            )
            .map_err(|error| write_sql_error(error, Some(&project_id)))?
            .is_some_and(|persisted| persisted >= revision)
            {
                return Err(conflict(RepositoryOperation::Save, &project_id));
            }

            let existing = read_crash_draft(&transaction, &project_id, &request.activation_id)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            if let Some(existing) = &existing {
                validate_crash_draft(existing).map_err(|issue| {
                    crash_draft_issue_error(issue, RepositoryOperation::Save, &project_id)
                })?;
                if existing.revision > revision {
                    return Err(conflict(RepositoryOperation::Save, &project_id));
                }
                if existing.revision == revision {
                    if crash_draft_matches_request(existing, &request, &canonical) {
                        let receipt = crash_draft_receipt(&request, existing);
                        transaction
                            .commit()
                            .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                        return Ok(receipt);
                    }
                    return Err(conflict(RepositoryOperation::Save, &project_id));
                }
                if existing.write_id == request.write_id {
                    return Err(conflict(RepositoryOperation::Save, &project_id));
                }
            }
            if let Some(same_write) =
                read_crash_draft_by_write_id(&transaction, &project_id, &request.write_id)
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?
            {
                if same_write.activation_id != request.activation_id {
                    return Err(conflict(RepositoryOperation::Save, &project_id));
                }
            }

            enforce_crash_draft_bounds(
                &transaction,
                existing.as_ref(),
                canonical.json.len(),
                &project_id,
            )?;
            let protected_at = database_now(&transaction)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            let (base_head_known, base_head_version) = crash_draft_base(&request.expected_head);
            let payload_bytes = i64::try_from(canonical.json.len()).map_err(|_| {
                persistence_error(
                    RepositoryOperation::Save,
                    PersistenceErrorCode::TooLarge,
                    RetryPolicy::Never,
                    Some(&project_id),
                )
            })?;
            let digest = CrashDraftDigest {
                project_id: &project_id,
                activation_id: &request.activation_id,
                revision,
                write_id: &request.write_id,
                base_head_known,
                base_head_version,
                predecessor_write_id: request.predecessor_write_id.as_deref(),
                saved_at: &protected_at,
                payload_crc32: &canonical.payload_crc32,
                payload_bytes,
                title: &canonical.title,
                updated_at: &canonical.updated_at,
                format_version: CRASH_DRAFT_FORMAT_VERSION,
            };
            let record_crc32 = digest_crc32(&digest);
            let changed = transaction
                .execute(
                    "INSERT INTO project_crash_drafts (
                           project_id, activation_id, revision, write_id, base_head_known,
                           base_head_version, predecessor_write_id, saved_at, payload_json,
                           payload_crc32, payload_bytes, title, updated_at, format_version,
                           record_crc32
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                         ON CONFLICT(project_id, activation_id) DO UPDATE SET
                           revision = excluded.revision,
                           write_id = excluded.write_id,
                           base_head_known = excluded.base_head_known,
                           base_head_version = excluded.base_head_version,
                           predecessor_write_id = excluded.predecessor_write_id,
                           saved_at = excluded.saved_at,
                           payload_json = excluded.payload_json,
                           payload_crc32 = excluded.payload_crc32,
                           payload_bytes = excluded.payload_bytes,
                           title = excluded.title,
                           updated_at = excluded.updated_at,
                           format_version = excluded.format_version,
                           record_crc32 = excluded.record_crc32
                         WHERE excluded.revision > project_crash_drafts.revision",
                    params![
                        project_id,
                        request.activation_id,
                        revision,
                        request.write_id,
                        i64::from(base_head_known),
                        base_head_version,
                        request.predecessor_write_id,
                        protected_at,
                        canonical.json,
                        canonical.payload_crc32,
                        payload_bytes,
                        canonical.title,
                        canonical.updated_at,
                        CRASH_DRAFT_FORMAT_VERSION,
                        record_crc32,
                    ],
                )
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            if changed != 1 {
                return Err(conflict(RepositoryOperation::Save, &project_id));
            }
            transaction
                .commit()
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            Ok(CrashDraftReceiptDto {
                project_id: project_id.clone(),
                activation_id: request.activation_id,
                revision: request.revision,
                write_id: request.write_id,
                protected_at,
                bytes: usize::try_from(payload_bytes).unwrap_or(0),
            })
        })
    }

    pub(crate) fn save(
        &self,
        request: SaveRequestDto,
    ) -> Result<SaveReceiptDto, PersistenceErrorDto> {
        validate_identifier(
            &request.project_id,
            MAX_ID_BYTES,
            RepositoryOperation::Save,
            Some(&request.project_id),
        )?;
        let canonical = canonical_project_json(
            &request.project_json,
            RepositoryOperation::Save,
            Some(&request.project_id),
        )?;
        let project_id = request.project_id.clone();
        if canonical.project_id != project_id {
            return Err(persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::InvalidProject,
                RetryPolicy::Never,
                Some(&project_id),
            ));
        }
        validate_identifier(
            &request.activation_id,
            MAX_OPERATION_ID_BYTES,
            RepositoryOperation::Save,
            Some(&project_id),
        )?;
        validate_identifier(
            &request.write_id,
            MAX_OPERATION_ID_BYTES,
            RepositoryOperation::Save,
            Some(&project_id),
        )?;
        if let Some(predecessor) = &request.predecessor_write_id {
            validate_identifier(
                predecessor,
                MAX_OPERATION_ID_BYTES,
                RepositoryOperation::Save,
                Some(&project_id),
            )?;
        }
        let revision = i64::try_from(request.revision).map_err(|_| {
            persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::InvalidProject,
                RetryPolicy::Never,
                Some(&project_id),
            )
        })?;

        self.with_connection(
            RepositoryOperation::Save,
            Some(&project_id),
            |connection| {
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                preflight_crash_draft_storage(
                    &transaction,
                    RepositoryOperation::Save,
                    Some(&project_id),
                )?;
                if let Some(draft) = read_crash_draft_by_write_id(
                    &transaction,
                    &project_id,
                    &request.write_id,
                )
                .map_err(|error| write_sql_error(error, Some(&project_id)))?
                {
                    validate_crash_draft(&draft).map_err(|issue| {
                        crash_draft_issue_error(issue, RepositoryOperation::Save, &project_id)
                    })?;
                    if !crash_draft_matches_save_request(
                        &draft,
                        &request,
                        revision,
                        &canonical,
                    ) {
                        return Err(conflict(RepositoryOperation::Save, &project_id));
                    }
                }

                if let Some(existing) = read_generation_by_operation(
                    &transaction,
                    &project_id,
                    GenerationKind::Save,
                    &request.write_id,
                )
                .map_err(|error| write_sql_error(error, Some(&project_id)))?
                {
                    let request_matches = existing.activation_id.as_deref()
                        == Some(request.activation_id.as_str())
                        && existing.revision == Some(revision)
                        && existing.payload_crc32.as_deref()
                            == Some(canonical.payload_crc32.as_str())
                        && existing.payload_json.as_deref() == Some(canonical.json.as_slice());
                    let state = current_head_state(&transaction, &project_id)
                        .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                    match state {
                        CurrentHeadState::Valid {
                            head,
                            row,
                            value: ValidatedGeneration::Save { .. },
                        } if request_matches
                            && head.generation_seq == existing.seq
                            && row.as_ref() == &existing => {}
                        CurrentHeadState::Unsupported(_)
                        | CurrentHeadState::UnsupportedEvidence
                        | CurrentHeadState::DiagnosticEvidence(
                            UnreadableProjectErrorCode::UnsupportedVersion,
                        ) => {
                            return Err(persistence_error(
                                RepositoryOperation::Save,
                                PersistenceErrorCode::UnsupportedVersion,
                                RetryPolicy::Never,
                                Some(&project_id),
                            ));
                        }
                        CurrentHeadState::DiagnosticEvidence(
                            UnreadableProjectErrorCode::MigrationFailed,
                        ) => {
                            return Err(persistence_error(
                                RepositoryOperation::Save,
                                PersistenceErrorCode::MigrationFailed,
                                RetryPolicy::Never,
                                Some(&project_id),
                            ));
                        }
                        CurrentHeadState::Empty
                        | CurrentHeadState::DeletedEvidence
                        | CurrentHeadState::Valid { .. }
                        | CurrentHeadState::Corrupt(_)
                        | CurrentHeadState::DiagnosticEvidence(
                            UnreadableProjectErrorCode::CorruptData
                            | UnreadableProjectErrorCode::Conflict,
                        ) => {
                            return Err(conflict(RepositoryOperation::Save, &project_id));
                        }
                    }
                    delete_crash_drafts_through(
                        &transaction,
                        &project_id,
                        &request.activation_id,
                        revision,
                        Some((
                            &request.write_id,
                            &canonical.payload_crc32,
                            canonical.json.as_slice(),
                        )),
                    )?;
                    let retained = canonical_generation_count(&transaction, &project_id)
                        .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                    transaction
                        .commit()
                        .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                    return Ok(save_receipt(&request, &existing, retained));
                }

                let parent_head_version = check_expected_head(
                    &transaction,
                    &project_id,
                    &request.expected_head,
                    RepositoryOperation::Save,
                    request.predecessor_write_id.as_deref().map(|write_id| {
                        PredecessorExpectation {
                            write_id,
                            activation_id: &request.activation_id,
                            revision,
                        }
                    }),
                )?;
                delete_crash_drafts_through(
                    &transaction,
                    &project_id,
                    &request.activation_id,
                    revision,
                    Some((
                        &request.write_id,
                        &canonical.payload_crc32,
                        canonical.json.as_slice(),
                    )),
                )?;
                let saved_at = database_now(&transaction)
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                let head_version = format!("sqlite:v1:save:{}", request.write_id);
                let payload_bytes = i64::try_from(canonical.json.len()).map_err(|_| {
                    persistence_error(
                        RepositoryOperation::Save,
                        PersistenceErrorCode::TooLarge,
                        RetryPolicy::Never,
                        Some(&project_id),
                    )
                })?;
                let digest = GenerationDigest {
                    project_id: &project_id,
                    kind: GenerationKind::Save.as_str(),
                    operation_id: &request.write_id,
                    head_version: &head_version,
                    parent_head_version: parent_head_version.as_deref(),
                    activation_id: Some(&request.activation_id),
                    revision: Some(revision),
                    predecessor_write_id: request.predecessor_write_id.as_deref(),
                    saved_at: &saved_at,
                    payload_crc32: Some(&canonical.payload_crc32),
                    payload_bytes,
                    title: Some(&canonical.title),
                    updated_at: Some(&canonical.updated_at),
                    branch_source: None,
                };
                let record_crc32 = digest_crc32(&digest);
                transaction
                    .execute(
                        "INSERT INTO project_generations (
                           project_id, kind, operation_id, head_version, parent_head_version,
                           activation_id, revision, predecessor_write_id, saved_at, payload_json,
                           payload_crc32, payload_bytes, title, updated_at, record_crc32
                         ) VALUES (?1, 'save', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        params![
                            project_id,
                            request.write_id,
                            head_version,
                            parent_head_version,
                            request.activation_id,
                            revision,
                            request.predecessor_write_id,
                            saved_at,
                            canonical.json,
                            canonical.payload_crc32,
                            payload_bytes,
                            canonical.title,
                            canonical.updated_at,
                            record_crc32,
                        ],
                    )
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                let sequence = transaction.last_insert_rowid();
                let head_crc32 = head_crc32(&project_id, sequence, &head_version, false);
                transaction
                    .execute(
                        "INSERT INTO project_heads (
                           project_id, generation_seq, head_version, deleted, head_crc32
                         ) VALUES (?1, ?2, ?3, 0, ?4)
                         ON CONFLICT(project_id) DO UPDATE SET
                           generation_seq = excluded.generation_seq,
                           head_version = excluded.head_version,
                           deleted = excluded.deleted,
                           head_crc32 = excluded.head_crc32",
                        params![project_id, sequence, head_version, head_crc32],
                    )
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                prune_generations(&transaction, &project_id)
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                let retained = canonical_generation_count(&transaction, &project_id)
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                let generation = read_generation_by_seq(&transaction, sequence)
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?
                    .ok_or_else(|| {
                        persistence_error(
                            RepositoryOperation::Save,
                            PersistenceErrorCode::WriteFailed,
                            RetryPolicy::Automatic,
                            Some(&project_id),
                        )
                    })?;
                transaction
                    .commit()
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                Ok(save_receipt(&request, &generation, retained))
            },
        )
    }

    pub(crate) fn remove(
        &self,
        request: RemoveRequestDto,
    ) -> Result<RemoveReceiptDto, PersistenceErrorDto> {
        validate_identifier(
            &request.project_id,
            MAX_ID_BYTES,
            RepositoryOperation::Remove,
            Some(&request.project_id),
        )?;
        validate_identifier(
            &request.delete_id,
            MAX_OPERATION_ID_BYTES,
            RepositoryOperation::Remove,
            Some(&request.project_id),
        )?;
        let project_id = request.project_id.clone();
        let error_project_id = project_id.clone();

        self.with_connection(
            RepositoryOperation::Remove,
            Some(&error_project_id),
            |connection| {
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?;

                if read_head_row(&transaction, &project_id)
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?
                    .is_some_and(|head| {
                        head.deleted
                            && head.head_crc32
                                == head_crc32(
                                    &head.project_id,
                                    head.generation_seq,
                                    &head.head_version,
                                    true,
                                )
                            && head.head_version
                                == format!("sqlite:v1:delete:{}", request.delete_id)
                    })
                {
                    let head_version = format!("sqlite:v1:delete:{}", request.delete_id);
                    let cleanup_complete = remove_explicit_branches(&transaction, &project_id)
                        .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                    remove_crash_drafts(&transaction, &project_id)
                        .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                    transaction
                        .commit()
                        .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                    return Ok(RemoveReceiptDto {
                        project_id,
                        delete_id: request.delete_id,
                        head_version,
                        removed: true,
                        cleanup_complete,
                    });
                }

                if let Some(existing) = read_generation_by_operation(
                    &transaction,
                    &project_id,
                    GenerationKind::Delete,
                    &request.delete_id,
                )
                .map_err(|error| delete_sql_error(error, Some(&project_id)))?
                {
                    let current = read_head_row(&transaction, &project_id)
                        .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                    if !current.as_ref().is_some_and(|head| {
                        head.deleted
                            && head.generation_seq == existing.seq
                            && head.head_version == existing.head_version
                            && head.head_crc32
                                == head_crc32(
                                    &head.project_id,
                                    head.generation_seq,
                                    &head.head_version,
                                    true,
                                )
                    })
                        || validate_generation(&existing) != Ok(ValidatedGeneration::Delete)
                    {
                        return Err(conflict(RepositoryOperation::Remove, &project_id));
                    }
                    let cleanup_complete = remove_explicit_branches(&transaction, &project_id)
                        .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                    remove_crash_drafts(&transaction, &project_id)
                        .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                    transaction
                        .commit()
                        .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                    return Ok(RemoveReceiptDto {
                        project_id,
                        delete_id: request.delete_id,
                        head_version: existing.head_version,
                        removed: true,
                        cleanup_complete,
                    });
                }

                let removed = read_head_row(&transaction, &project_id)
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?
                    .is_some()
                    || generation_count(&transaction, &project_id)
                        .map_err(|error| delete_sql_error(error, Some(&project_id)))?
                        > 0;
                let parent_head_version = check_expected_head(
                    &transaction,
                    &project_id,
                    &request.expected_head,
                    RepositoryOperation::Remove,
                    None,
                )?;
                let saved_at = database_now(&transaction)
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                let head_version = format!("sqlite:v1:delete:{}", request.delete_id);
                let digest = GenerationDigest {
                    project_id: &project_id,
                    kind: GenerationKind::Delete.as_str(),
                    operation_id: &request.delete_id,
                    head_version: &head_version,
                    parent_head_version: parent_head_version.as_deref(),
                    activation_id: None,
                    revision: None,
                    predecessor_write_id: None,
                    saved_at: &saved_at,
                    payload_crc32: None,
                    payload_bytes: 0,
                    title: None,
                    updated_at: None,
                    branch_source: None,
                };
                let record_crc32 = digest_crc32(&digest);
                transaction
                    .execute(
                        "INSERT INTO project_generations (
                           project_id, kind, operation_id, head_version, parent_head_version,
                           activation_id, revision, predecessor_write_id, saved_at, payload_json,
                           payload_crc32, payload_bytes, title, updated_at, record_crc32
                         ) VALUES (?1, 'delete', ?2, ?3, ?4, NULL, NULL, NULL, ?5, NULL, NULL, 0, NULL, NULL, ?6)",
                        params![
                            project_id,
                            request.delete_id,
                            head_version,
                            parent_head_version,
                            saved_at,
                            record_crc32,
                        ],
                    )
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                let sequence = transaction.last_insert_rowid();
                let head_crc32 = head_crc32(&project_id, sequence, &head_version, true);
                transaction
                    .execute(
                        "INSERT INTO project_heads (
                           project_id, generation_seq, head_version, deleted, head_crc32
                         ) VALUES (?1, ?2, ?3, 1, ?4)
                         ON CONFLICT(project_id) DO UPDATE SET
                           generation_seq = excluded.generation_seq,
                           head_version = excluded.head_version,
                           deleted = excluded.deleted,
                           head_crc32 = excluded.head_crc32",
                        params![project_id, sequence, head_version, head_crc32],
                    )
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                let cleanup_complete = remove_explicit_branches(&transaction, &project_id)
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                remove_crash_drafts(&transaction, &project_id)
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                prune_generations(&transaction, &project_id)
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                transaction
                    .commit()
                    .map_err(|error| delete_sql_error(error, Some(&project_id)))?;
                Ok(RemoveReceiptDto {
                    project_id,
                    delete_id: request.delete_id,
                    head_version,
                    removed,
                    cleanup_complete,
                })
            },
        )
    }

    pub(crate) fn get_legacy_migration_status(
        &self,
        content_checksum: String,
        migration_version: u64,
    ) -> Result<LegacyMigrationStatusDto, PersistenceErrorDto> {
        validate_legacy_checksum(&content_checksum, RepositoryOperation::List)?;
        let migration_version =
            checked_migration_version(migration_version, RepositoryOperation::List)?;
        self.with_connection(RepositoryOperation::List, None, |connection| {
            let backup = require_valid_legacy_backup(
                connection,
                &content_checksum,
                RepositoryOperation::List,
            )?;
            let run = read_legacy_migration_run(connection, &content_checksum, migration_version)
                .map_err(|error| read_sql_error(error, RepositoryOperation::List, None))?;
            if let Some(run) = &run {
                validate_completed_legacy_run(
                    connection,
                    &content_checksum,
                    migration_version,
                    &backup,
                    run,
                )?;
            }
            Ok(LegacyMigrationStatusDto {
                complete: run.is_some(),
            })
        })
    }

    pub(crate) fn backup_legacy_snapshot(
        &self,
        snapshot: LegacyStorageSnapshotDto,
    ) -> Result<(), PersistenceErrorDto> {
        validate_legacy_snapshot(&snapshot, RepositoryOperation::Save)?;
        let content_checksum = snapshot.content_checksum.clone();
        self.with_connection(RepositoryOperation::Save, None, |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| write_sql_error(error, None))?;

            if read_legacy_snapshot_row(&transaction, &content_checksum)
                .map_err(|error| write_sql_error(error, None))?
                .is_some()
            {
                let stored = require_valid_legacy_backup(
                    &transaction,
                    &content_checksum,
                    RepositoryOperation::Save,
                )?;
                let same_content = stored.row.storage_version
                    == i64::try_from(snapshot.storage_version).unwrap_or(i64::MAX)
                    && stored.row.record_count
                        == i64::try_from(snapshot.entries.len()).unwrap_or(i64::MAX)
                    && stored.row.total_bytes
                        == i64::try_from(snapshot.total_bytes).unwrap_or(i64::MAX)
                    && stored.entries == snapshot.entries;
                if !same_content {
                    return Err(migration_conflict(RepositoryOperation::Save));
                }
                gc_incomplete_legacy_snapshots(&transaction, &content_checksum)
                    .map_err(|error| write_sql_error(error, None))?;
                transaction
                    .commit()
                    .map_err(|error| write_sql_error(error, None))?;
                return Ok(());
            }

            let backed_up_at =
                database_now(&transaction).map_err(|error| write_sql_error(error, None))?;
            let backup_crc32 = legacy_backup_crc32(
                &snapshot.content_checksum,
                snapshot.storage_version,
                &snapshot.created_at,
                snapshot.total_bytes,
                &snapshot.checksum,
                &snapshot.entries,
            );
            transaction
                .execute(
                    "INSERT INTO legacy_migration_snapshots (
                       content_checksum, storage_version, created_at, record_count,
                       total_bytes, envelope_checksum, backup_crc32, backed_up_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        snapshot.content_checksum,
                        i64::try_from(snapshot.storage_version).unwrap_or(i64::MAX),
                        snapshot.created_at,
                        i64::try_from(snapshot.entries.len()).unwrap_or(i64::MAX),
                        i64::try_from(snapshot.total_bytes).unwrap_or(i64::MAX),
                        snapshot.checksum,
                        backup_crc32,
                        backed_up_at,
                    ],
                )
                .map_err(|error| write_sql_error(error, None))?;

            for (ordinal, entry) in snapshot.entries.iter().enumerate() {
                let ordinal = i64::try_from(ordinal).unwrap_or(i64::MAX);
                let value_bytes = i64::try_from(entry.value_bytes).unwrap_or(i64::MAX);
                let record_crc32 = legacy_backup_record_crc32(
                    &snapshot.content_checksum,
                    ordinal,
                    entry.key.as_bytes(),
                    entry.value.as_bytes(),
                    value_bytes,
                    &entry.checksum,
                );
                transaction
                    .execute(
                        "INSERT INTO legacy_migration_records (
                           content_checksum, ordinal, storage_key, storage_value,
                           value_bytes, source_checksum, record_crc32
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![
                            snapshot.content_checksum,
                            ordinal,
                            entry.key.as_bytes(),
                            entry.value.as_bytes(),
                            value_bytes,
                            entry.checksum,
                            record_crc32,
                        ],
                    )
                    .map_err(|error| write_sql_error(error, None))?;
            }

            gc_incomplete_legacy_snapshots(&transaction, &content_checksum)
                .map_err(|error| write_sql_error(error, None))?;

            transaction
                .commit()
                .map_err(|error| write_sql_error(error, None))?;
            Ok(())
        })
    }

    pub(crate) fn import_legacy_project(
        &self,
        request: LegacyProjectImportRequestDto,
    ) -> Result<LegacyProjectImportReceiptDto, PersistenceErrorDto> {
        validate_legacy_checksum(&request.content_checksum, RepositoryOperation::Save)?;
        let migration_version =
            checked_migration_version(request.migration_version, RepositoryOperation::Save)?;
        validate_identifier(
            &request.project_id,
            MAX_ID_BYTES,
            RepositoryOperation::Save,
            Some(&request.project_id),
        )?;
        if let Some(diagnostic) = request.diagnostic {
            if request.project_json.is_some() || request.branch.is_some() {
                return Err(migration_failure(
                    RepositoryOperation::Save,
                    RetryPolicy::Never,
                ));
            }
            return self.stage_legacy_diagnostic(
                request.content_checksum,
                migration_version,
                request.project_id,
                request.source_keys,
                diagnostic.error_code,
            );
        }
        let project_json = request
            .project_json
            .as_deref()
            .ok_or_else(|| migration_failure(RepositoryOperation::Save, RetryPolicy::Never))?;
        let canonical = canonical_project_json(
            project_json,
            RepositoryOperation::Save,
            Some(&request.project_id),
        )?;
        if canonical.project_id != request.project_id {
            return Err(persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::InvalidProject,
                RetryPolicy::Never,
                Some(&request.project_id),
            ));
        }
        let payload_bytes = i64::try_from(canonical.json.len()).map_err(|_| {
            persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::TooLarge,
                RetryPolicy::Never,
                Some(&request.project_id),
            )
        })?;
        let (
            candidate_kind,
            candidate_operation_id,
            source,
            activation_id,
            revision,
            write_id,
            saved_at,
        ) = if let Some(branch) = request.branch.as_ref() {
            if !matches!(
                branch.source,
                ProjectBranchSource::RecoveryJournal | ProjectBranchSource::InterruptedSave
            ) || !canonical_utc_timestamp(&branch.saved_at)
            {
                return Err(persistence_error(
                    RepositoryOperation::Save,
                    PersistenceErrorCode::InvalidProject,
                    RetryPolicy::Never,
                    Some(&request.project_id),
                ));
            }
            validate_identifier(
                &branch.activation_id,
                MAX_OPERATION_ID_BYTES,
                RepositoryOperation::Save,
                Some(&request.project_id),
            )?;
            validate_identifier(
                &branch.write_id,
                MAX_OPERATION_ID_BYTES,
                RepositoryOperation::Save,
                Some(&request.project_id),
            )?;
            let revision = i64::try_from(branch.revision).map_err(|_| {
                persistence_error(
                    RepositoryOperation::Save,
                    PersistenceErrorCode::InvalidProject,
                    RetryPolicy::Never,
                    Some(&request.project_id),
                )
            })?;
            (
                "branch",
                branch.write_id.as_str(),
                Some(branch_source_name(branch.source)),
                Some(branch.activation_id.as_str()),
                Some(revision),
                Some(branch.write_id.as_str()),
                Some(branch.saved_at.as_str()),
            )
        } else {
            ("head", "legacy-head", None, None, None, None, None)
        };
        let source_keys_json = serde_json::to_vec(&request.source_keys)
            .map_err(|_| migration_failure(RepositoryOperation::Save, RetryPolicy::Never))?;
        let project_id = request.project_id.clone();
        self.with_connection(RepositoryOperation::Save, Some(&project_id), |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            let backup = require_valid_legacy_backup(
                &transaction,
                &request.content_checksum,
                RepositoryOperation::Save,
            )?;
            if read_legacy_migration_run(&transaction, &request.content_checksum, migration_version)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?
                .is_some()
            {
                return Err(conflict(RepositoryOperation::Save, &project_id));
            }
            validate_legacy_provenance(
                &backup.entries,
                &project_id,
                &request.source_keys,
                Some(project_json),
                request.branch.as_ref(),
            )?;

            if let Some(existing) = read_legacy_import(
                &transaction,
                &request.content_checksum,
                migration_version,
                &project_id,
                candidate_kind,
                candidate_operation_id,
            )
            .map_err(|error| write_sql_error(error, Some(&project_id)))?
            {
                if existing.payload_crc32.as_deref() != Some(&canonical.payload_crc32)
                    || existing.payload_bytes != Some(payload_bytes)
                    || existing.payload_json.as_deref() != Some(canonical.json.as_slice())
                    || existing.title.as_deref() != Some(&canonical.title)
                    || existing.updated_at.as_deref() != Some(&canonical.updated_at)
                    || existing.activation_id.as_deref() != activation_id
                    || existing.revision != revision
                    || existing.write_id.as_deref() != write_id
                    || existing.source_keys != request.source_keys
                {
                    return Err(conflict(RepositoryOperation::Save, &project_id));
                }
                transaction
                    .commit()
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                return Ok(LegacyProjectImportReceiptDto {
                    project_id: project_id.clone(),
                    status: LegacyProjectImportStatus::Imported,
                    branch_id: None,
                });
            }
            let staged_at = database_now(&transaction)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            transaction
                .execute(
                    "INSERT INTO legacy_project_staging (
                       content_checksum, migration_version, project_id, source_keys_json,
                       candidate_kind, candidate_operation_id,
                       payload_crc32, payload_bytes, payload_json, title, updated_at,
                       source, activation_id, revision, write_id, saved_at, staged_at
                     ) VALUES (
                       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
                     )",
                    params![
                        request.content_checksum,
                        migration_version,
                        project_id,
                        source_keys_json,
                        candidate_kind,
                        candidate_operation_id,
                        canonical.payload_crc32,
                        payload_bytes,
                        canonical.json,
                        canonical.title,
                        canonical.updated_at,
                        source,
                        activation_id,
                        revision,
                        write_id,
                        saved_at,
                        staged_at,
                    ],
                )
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            transaction
                .commit()
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            Ok(LegacyProjectImportReceiptDto {
                project_id: project_id.clone(),
                status: LegacyProjectImportStatus::Imported,
                branch_id: None,
            })
        })
    }

    fn stage_legacy_diagnostic(
        &self,
        content_checksum: String,
        migration_version: i64,
        project_id: String,
        source_keys: Vec<String>,
        error_code: UnreadableProjectErrorCode,
    ) -> Result<LegacyProjectImportReceiptDto, PersistenceErrorDto> {
        self.with_connection(RepositoryOperation::Save, Some(&project_id), |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            let backup = require_valid_legacy_backup(
                &transaction,
                &content_checksum,
                RepositoryOperation::Save,
            )?;
            if read_legacy_migration_run(&transaction, &content_checksum, migration_version)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?
                .is_some()
            {
                return Err(conflict(RepositoryOperation::Save, &project_id));
            }
            validate_legacy_diagnostic_provenance(&backup.entries, &project_id, &source_keys)?;
            let source_keys_json = serde_json::to_vec(&source_keys)
                .map_err(|_| migration_failure(RepositoryOperation::Save, RetryPolicy::Never))?;
            let error_code = unreadable_error_code_name(error_code);
            if let Some(existing) = read_legacy_import(
                &transaction,
                &content_checksum,
                migration_version,
                &project_id,
                "diagnostic",
                "diagnostic",
            )
            .map_err(|error| write_sql_error(error, Some(&project_id)))?
            {
                if existing.diagnostic_error_code.as_deref() != Some(error_code)
                    || existing.source_keys != source_keys
                {
                    return Err(conflict(RepositoryOperation::Save, &project_id));
                }
                transaction
                    .commit()
                    .map_err(|error| write_sql_error(error, Some(&project_id)))?;
                return Ok(LegacyProjectImportReceiptDto {
                    project_id: project_id.clone(),
                    status: LegacyProjectImportStatus::Imported,
                    branch_id: None,
                });
            }
            let staged_at = database_now(&transaction)
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            transaction
                .execute(
                    "INSERT INTO legacy_project_staging (
                       content_checksum, migration_version, project_id, source_keys_json,
                       candidate_kind, candidate_operation_id, diagnostic_error_code, staged_at
                     ) VALUES (?1, ?2, ?3, ?4, 'diagnostic', 'diagnostic', ?5, ?6)",
                    params![
                        content_checksum,
                        migration_version,
                        project_id,
                        source_keys_json,
                        error_code,
                        staged_at,
                    ],
                )
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            transaction
                .commit()
                .map_err(|error| write_sql_error(error, Some(&project_id)))?;
            Ok(LegacyProjectImportReceiptDto {
                project_id: project_id.clone(),
                status: LegacyProjectImportStatus::Imported,
                branch_id: None,
            })
        })
    }

    pub(crate) fn complete_legacy_migration(
        &self,
        request: LegacyMigrationCompletionDto,
    ) -> Result<(), PersistenceErrorDto> {
        validate_legacy_checksum(&request.content_checksum, RepositoryOperation::Save)?;
        let migration_version =
            checked_migration_version(request.migration_version, RepositoryOperation::Save)?;
        let record_count = checked_legacy_count(request.record_count)?;
        let total_bytes = checked_legacy_bytes(request.total_bytes)?;
        let ready_project_count = checked_legacy_count(request.ready_project_count)?;
        let unreadable_project_count = checked_legacy_count(request.unreadable_project_count)?;
        let branch_count = checked_legacy_count(request.branch_count)?;

        self.with_connection(RepositoryOperation::Save, None, |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| write_sql_error(error, None))?;
            let backup = require_valid_legacy_backup(
                &transaction,
                &request.content_checksum,
                RepositoryOperation::Save,
            )?;
            if backup.row.record_count != record_count || backup.row.total_bytes != total_bytes {
                return Err(migration_conflict(RepositoryOperation::Save));
            }
            if let Some(run) = read_legacy_migration_run(
                &transaction,
                &request.content_checksum,
                migration_version,
            )
            .map_err(|error| write_sql_error(error, None))?
            {
                validate_completed_legacy_run(
                    &transaction,
                    &request.content_checksum,
                    migration_version,
                    &backup,
                    &run,
                )?;
                let matches = run.record_count == record_count
                    && run.total_bytes == total_bytes
                    && run.ready_project_count == ready_project_count
                    && run.unreadable_project_count == unreadable_project_count
                    && run.branch_count == branch_count;
                if !matches {
                    return Err(migration_conflict(RepositoryOperation::Save));
                }
                transaction
                    .commit()
                    .map_err(|error| write_sql_error(error, None))?;
                return Ok(());
            }

            let stages =
                read_legacy_stages(&transaction, &request.content_checksum, migration_version)
                    .map_err(|error| write_sql_error(error, None))?;
            let deleted_evidence = legacy_snapshot_coverage(&backup.entries, &stages)?;
            let derived_ready = i64::try_from(
                stages
                    .iter()
                    .filter(|stage| stage.candidate_kind == "head")
                    .count(),
            )
            .unwrap_or(i64::MAX);
            let derived_unreadable = i64::try_from(
                stages
                    .iter()
                    .filter(|stage| stage.candidate_kind == "diagnostic")
                    .count(),
            )
            .unwrap_or(i64::MAX);
            let derived_branches = i64::try_from(
                stages
                    .iter()
                    .filter(|stage| stage.candidate_kind == "branch")
                    .count(),
            )
            .unwrap_or(i64::MAX);
            if (derived_ready, derived_unreadable, derived_branches)
                != (ready_project_count, unreadable_project_count, branch_count)
            {
                return Err(migration_conflict(RepositoryOperation::Save));
            }
            if stages.iter().any(|stage| {
                stage.candidate_kind == "head"
                    && stages.iter().any(|candidate| {
                        candidate.project_id == stage.project_id
                            && candidate.candidate_kind == "diagnostic"
                    })
            }) {
                return Err(migration_conflict(RepositoryOperation::Save));
            }
            for stage in &stages {
                validate_staged_legacy_provenance(&backup.entries, stage)?;
            }
            let completed_at =
                database_now(&transaction).map_err(|error| write_sql_error(error, None))?;
            transaction
                .execute(
                    "INSERT INTO legacy_migration_runs (
                       content_checksum, migration_version, completed_at, record_count,
                       total_bytes, ready_project_count, unreadable_project_count, branch_count
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        request.content_checksum,
                        migration_version,
                        completed_at,
                        record_count,
                        total_bytes,
                        ready_project_count,
                        unreadable_project_count,
                        branch_count,
                    ],
                )
                .map_err(|error| write_sql_error(error, None))?;
            for evidence in &deleted_evidence {
                apply_legacy_deleted_evidence(
                    &transaction,
                    &request.content_checksum,
                    migration_version,
                    evidence,
                )?;
            }
            for stage in &stages {
                apply_legacy_stage(
                    &transaction,
                    &request.content_checksum,
                    migration_version,
                    stage,
                )?;
            }
            transaction
                .commit()
                .map_err(|error| write_sql_error(error, None))?;
            Ok(())
        })
    }

    pub(crate) fn get_erase_all_status(&self) -> Result<EraseAllStatusDto, PersistenceErrorDto> {
        let mut runtime = self.lock(RepositoryOperation::EraseAll, None)?;
        if let RepositorySeal::Completed(completed_id) = runtime.seal.clone() {
            match self.read_erase_marker()? {
                None => {
                    self.ensure_database_family_absent()?;
                    return Ok(EraseAllStatusDto::Idle);
                }
                Some(marker) if marker.erase_id == completed_id => {
                    runtime.seal = RepositorySeal::Pending(marker.erase_id);
                }
                Some(_) => return Err(erase_marker_corrupt()),
            }
        }
        match self.read_erase_marker()? {
            Some(marker) => {
                if let RepositorySeal::Pending(erase_id) = &runtime.seal {
                    if erase_id != &marker.erase_id {
                        return Err(erase_marker_corrupt());
                    }
                }
                runtime.seal = RepositorySeal::Pending(marker.erase_id.clone());
                Ok(EraseAllStatusDto::Pending {
                    erase_id: marker.erase_id,
                })
            }
            None => match &runtime.seal {
                RepositorySeal::Open => Ok(EraseAllStatusDto::Idle),
                RepositorySeal::Pending(_) => Err(erase_marker_corrupt()),
                RepositorySeal::Completed(_) => Ok(EraseAllStatusDto::Idle),
            },
        }
    }

    pub(crate) fn prepare_erase_all(
        &self,
        request: EraseAllRequestDto,
    ) -> Result<EraseAllReceiptDto, PersistenceErrorDto> {
        validate_erase_id(&request.erase_id)?;
        let mut runtime = self.lock(RepositoryOperation::EraseAll, None)?;
        if let RepositorySeal::Completed(completed_id) = runtime.seal.clone() {
            if completed_id != request.erase_id {
                return Err(erase_conflict());
            }
            match self.read_erase_marker()? {
                None => {
                    self.ensure_database_family_absent()?;
                    return Ok(erase_receipt(request.erase_id));
                }
                Some(marker) if marker.erase_id == completed_id => {
                    runtime.seal = RepositorySeal::Pending(marker.erase_id);
                }
                Some(_) => return Err(erase_marker_corrupt()),
            }
        }

        match self.read_erase_marker()? {
            Some(marker) if marker.erase_id != request.erase_id => return Err(erase_conflict()),
            Some(marker) => {
                if let RepositorySeal::Pending(erase_id) = &runtime.seal {
                    if erase_id != &marker.erase_id {
                        return Err(erase_marker_corrupt());
                    }
                }
                runtime.seal = RepositorySeal::Pending(marker.erase_id);
            }
            None => match &runtime.seal {
                RepositorySeal::Open => {
                    self.write_erase_marker(&request.erase_id)?;
                    // Seal while still holding the repository mutex. A failed verification
                    // therefore still leaves every later normal operation fail-closed on disk.
                    runtime.seal = RepositorySeal::Pending(request.erase_id.clone());
                    let verified = self.read_erase_marker()?.ok_or_else(erase_marker_corrupt)?;
                    if verified.erase_id != request.erase_id {
                        return Err(erase_marker_corrupt());
                    }
                }
                RepositorySeal::Pending(_) => return Err(erase_marker_corrupt()),
                RepositorySeal::Completed(_) => unreachable!("completed handled above"),
            },
        }

        if let RepositorySeal::Pending(erase_id) = &runtime.seal {
            if erase_id != &request.erase_id {
                return Err(erase_conflict());
            }
        }

        if let Some(connection) = runtime.connection.take() {
            let close_result = connection.close();
            if let Err((connection, error)) = close_result {
                // sqlite3_close can report BUSY while an outstanding statement
                // still owns the handle. Restore both connection and boundary
                // so the same erase ID can retry without deleting live files.
                runtime.connection = Some(connection);
                return Err(sqlite_error_to_persistence(
                    error,
                    RepositoryOperation::EraseAll,
                    None,
                    PersistenceErrorCode::DeleteFailed,
                ));
            }
            runtime.vfs_boundary.take();
        } else {
            runtime.vfs_boundary.take();
        }
        self.remove_database_family()?;
        Ok(erase_receipt(request.erase_id))
    }

    pub(crate) fn complete_erase_all(
        &self,
        request: EraseAllRequestDto,
    ) -> Result<(), PersistenceErrorDto> {
        self.complete_erase_all_with_marker_sync(request, sync_parent_directory)
    }

    fn complete_erase_all_with_marker_sync(
        &self,
        request: EraseAllRequestDto,
        sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), PersistenceErrorDto> {
        validate_erase_id(&request.erase_id)?;
        let mut runtime = self.lock(RepositoryOperation::EraseAll, None)?;
        if let RepositorySeal::Completed(completed_id) = runtime.seal.clone() {
            if completed_id != request.erase_id {
                return Err(erase_conflict());
            }
            match self.read_erase_marker()? {
                None => {
                    self.ensure_database_family_absent()?;
                    return Ok(());
                }
                Some(marker) if marker.erase_id == completed_id => {
                    runtime.seal = RepositorySeal::Pending(marker.erase_id);
                }
                Some(_) => return Err(erase_marker_corrupt()),
            }
        }

        let marker = self
            .read_erase_marker()?
            .ok_or_else(|| match &runtime.seal {
                RepositorySeal::Open => erase_conflict(),
                RepositorySeal::Pending(_) => erase_marker_corrupt(),
                RepositorySeal::Completed(_) => unreachable!("completed handled above"),
            })?;
        if marker.erase_id != request.erase_id {
            return Err(erase_conflict());
        }
        if let RepositorySeal::Pending(erase_id) = &runtime.seal {
            if erase_id != &marker.erase_id {
                return Err(erase_marker_corrupt());
            }
        }
        runtime.seal = RepositorySeal::Pending(marker.erase_id);
        self.ensure_database_family_absent()?;
        match self.remove_erase_marker_with(sync_parent) {
            Ok(()) => {
                runtime.seal = RepositorySeal::Completed(request.erase_id);
                Ok(())
            }
            Err(EraseMarkerRemovalError::BeforeUnlink(error)) => Err(error),
            Err(EraseMarkerRemovalError::AfterUnlink(error)) => {
                // Once unlink succeeds, the only crash outcomes are a reappearing marker
                // (which safely resumes on the next launch) or an absent marker with an
                // already-absent database family. Keep this process sealed and make a
                // same-ID retry idempotent even when directory fsync itself reports failure.
                runtime.seal = RepositorySeal::Completed(request.erase_id);
                Err(error)
            }
        }
    }

    pub(crate) fn close(&self) -> Result<(), PersistenceErrorDto> {
        let mut runtime = self.lock(RepositoryOperation::Close, None)?;
        self.ensure_normal_operation_allowed(&mut runtime, RepositoryOperation::Close, None)?;
        let Some(connection) = runtime.connection.take() else {
            runtime.vfs_boundary.take();
            return Ok(());
        };
        let close_result = connection.close();
        match close_result {
            Ok(()) => {
                runtime.vfs_boundary.take();
                Ok(())
            }
            Err((connection, error)) => {
                // Preserve the live SQLite handle and exact-path VFS boundary;
                // callers may finalize the blocking work and retry close.
                runtime.connection = Some(connection);
                Err(sqlite_error_to_persistence(
                    error,
                    RepositoryOperation::Close,
                    None,
                    PersistenceErrorCode::WriteFailed,
                ))
            }
        }
    }

    fn lock(
        &self,
        operation: RepositoryOperation,
        project_id: Option<&str>,
    ) -> Result<MutexGuard<'_, RepositoryRuntime>, PersistenceErrorDto> {
        self.runtime.lock().map_err(|_| {
            persistence_error(
                operation,
                PersistenceErrorCode::StorageUnavailable,
                RetryPolicy::Manual,
                project_id,
            )
        })
    }

    fn with_connection<T>(
        &self,
        operation: RepositoryOperation,
        project_id: Option<&str>,
        action: impl FnOnce(&mut Connection) -> Result<T, PersistenceErrorDto>,
    ) -> Result<T, PersistenceErrorDto> {
        let mut runtime = self.lock(operation, project_id)?;
        self.ensure_normal_operation_allowed(&mut runtime, operation, project_id)?;
        let connection = runtime.connection.as_mut().ok_or_else(|| {
            persistence_error(
                operation,
                PersistenceErrorCode::StorageUnavailable,
                RetryPolicy::Manual,
                project_id,
            )
        })?;
        ensure_supported_legacy_migration_versions(connection, operation, project_id)?;
        action(connection)
    }

    fn ensure_normal_operation_allowed(
        &self,
        runtime: &mut RepositoryRuntime,
        operation: RepositoryOperation,
        project_id: Option<&str>,
    ) -> Result<(), PersistenceErrorDto> {
        match &runtime.seal {
            RepositorySeal::Completed(_) => return Err(repository_sealed(operation, project_id)),
            RepositorySeal::Open | RepositorySeal::Pending(_) => {}
        }
        match self.read_erase_marker() {
            Ok(Some(marker)) => {
                if let RepositorySeal::Pending(erase_id) = &runtime.seal {
                    if erase_id != &marker.erase_id {
                        return Err(erase_marker_corrupt_for(operation, project_id));
                    }
                }
                runtime.seal = RepositorySeal::Pending(marker.erase_id);
                Err(repository_sealed(operation, project_id))
            }
            Ok(None) => match runtime.seal {
                RepositorySeal::Open => Ok(()),
                RepositorySeal::Pending(_) => Err(erase_marker_corrupt_for(operation, project_id)),
                RepositorySeal::Completed(_) => Err(repository_sealed(operation, project_id)),
            },
            Err(error) => Err(PersistenceErrorDto::new(
                operation,
                error.code,
                error.retry,
                project_id,
            )),
        }
    }

    fn marker_path(&self) -> Result<PathBuf, PersistenceErrorDto> {
        self.path
            .parent()
            .map(|parent| parent.join(ERASE_MARKER_FILE_NAME))
            .ok_or_else(|| {
                erase_error(PersistenceErrorCode::StorageUnavailable, RetryPolicy::Never)
            })
    }

    fn read_erase_marker(&self) -> Result<Option<EraseMarker>, PersistenceErrorDto> {
        let path = self.marker_path()?;
        let validated = inspect_existing_owned_regular_file(&path, false)
            .map_err(marker_read_boundary_error)?;
        let Some(validated) = validated else {
            return Ok(None);
        };
        if validated.facts.length == 0 || validated.facts.length > MAX_ERASE_MARKER_BYTES {
            return Err(erase_marker_corrupt());
        }
        harden_validated_owned_file(&validated, false).map_err(marker_read_boundary_error)?;
        let mut bytes = Vec::with_capacity(validated.facts.length as usize);
        let file = validated.file;
        file.take(MAX_ERASE_MARKER_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| erase_error(PersistenceErrorCode::ReadFailed, RetryPolicy::Manual))?;
        if bytes.len() as u64 > MAX_ERASE_MARKER_BYTES {
            return Err(erase_marker_corrupt());
        }
        let marker: EraseMarker =
            serde_json::from_slice(&bytes).map_err(|_| erase_marker_corrupt())?;
        if marker.storage_version > ERASE_MARKER_VERSION {
            return Err(erase_error(
                PersistenceErrorCode::UnsupportedVersion,
                RetryPolicy::Never,
            ));
        }
        if marker.storage_version != ERASE_MARKER_VERSION {
            return Err(erase_marker_corrupt());
        }
        validate_erase_id(&marker.erase_id).map_err(|_| erase_marker_corrupt())?;
        if marker.checksum != erase_marker_checksum(marker.storage_version, &marker.erase_id) {
            return Err(erase_marker_corrupt());
        }
        Ok(Some(marker))
    }

    fn write_erase_marker(&self, erase_id: &str) -> Result<(), PersistenceErrorDto> {
        let path = self.marker_path()?;
        let parent = path.parent().ok_or_else(|| {
            erase_error(PersistenceErrorCode::StorageUnavailable, RetryPolicy::Never)
        })?;
        fs::create_dir_all(parent)
            .map_err(|_| erase_error(PersistenceErrorCode::WriteFailed, RetryPolicy::Manual))?;
        harden_app_data_directory_permissions(parent)
            .map_err(|_| erase_error(PersistenceErrorCode::WriteFailed, RetryPolicy::Manual))?;
        let marker = EraseMarker {
            storage_version: ERASE_MARKER_VERSION,
            erase_id: erase_id.to_owned(),
            checksum: erase_marker_checksum(ERASE_MARKER_VERSION, erase_id),
        };
        let bytes = serde_json::to_vec(&marker)
            .map_err(|_| erase_error(PersistenceErrorCode::WriteFailed, RetryPolicy::Never))?;
        AtomicFile::new(&path, AllowOverwrite)
            .write(|file| {
                harden_private_file_permissions(file)?;
                file.write_all(&bytes)?;
                file.sync_all()
            })
            .map_err(|_| erase_error(PersistenceErrorCode::WriteFailed, RetryPolicy::Manual))?;
        let written = inspect_existing_owned_regular_file(&path, false)
            .map_err(|_| erase_error(PersistenceErrorCode::WriteFailed, RetryPolicy::Manual))?
            .ok_or_else(|| erase_error(PersistenceErrorCode::WriteFailed, RetryPolicy::Manual))?;
        harden_validated_owned_file(&written, false)
            .map_err(|_| erase_error(PersistenceErrorCode::WriteFailed, RetryPolicy::Manual))?;
        sync_parent_directory(parent)
            .map_err(|_| erase_error(PersistenceErrorCode::WriteFailed, RetryPolicy::Manual))
    }

    fn database_family_paths(&self) -> [PathBuf; 4] {
        [
            self.path.clone(),
            append_path_suffix(&self.path, "-wal"),
            append_path_suffix(&self.path, "-shm"),
            append_path_suffix(&self.path, "-journal"),
        ]
    }

    fn inspect_and_harden_database_family(
        &self,
    ) -> Result<DatabaseFamilyInspection, PersistenceErrorDto> {
        inspect_and_harden_database_family(&self.database_family_paths())
            .map_err(|_| database_boundary_error())
    }

    fn remove_database_family(&self) -> Result<(), PersistenceErrorDto> {
        for path in self.database_family_paths() {
            remove_path_without_following(&path)?;
        }
        self.sync_database_parent()?;
        self.ensure_database_family_absent()
    }

    fn ensure_database_family_absent(&self) -> Result<(), PersistenceErrorDto> {
        for path in self.database_family_paths() {
            match fs::symlink_metadata(path) {
                Err(error) if error.kind() == IoErrorKind::NotFound => {}
                Ok(_) | Err(_) => {
                    return Err(erase_error(
                        PersistenceErrorCode::DeleteFailed,
                        RetryPolicy::Manual,
                    ));
                }
            }
        }
        Ok(())
    }

    fn remove_erase_marker_with(
        &self,
        sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), EraseMarkerRemovalError> {
        let path = self
            .marker_path()
            .map_err(EraseMarkerRemovalError::BeforeUnlink)?;
        let marker = inspect_existing_owned_regular_file(&path, false)
            .map_err(|_| EraseMarkerRemovalError::BeforeUnlink(erase_marker_corrupt()))?
            .ok_or_else(|| EraseMarkerRemovalError::BeforeUnlink(erase_marker_corrupt()))?;
        harden_validated_owned_file(&marker, false)
            .map_err(|_| EraseMarkerRemovalError::BeforeUnlink(erase_marker_corrupt()))?;
        fs::remove_file(&path).map_err(|_| {
            EraseMarkerRemovalError::BeforeUnlink(erase_error(
                PersistenceErrorCode::DeleteFailed,
                RetryPolicy::Manual,
            ))
        })?;
        let parent = path.parent().ok_or_else(|| {
            EraseMarkerRemovalError::AfterUnlink(erase_error(
                PersistenceErrorCode::StorageUnavailable,
                RetryPolicy::Never,
            ))
        })?;
        sync_parent(parent).map_err(|_| {
            EraseMarkerRemovalError::AfterUnlink(erase_error(
                PersistenceErrorCode::DeleteFailed,
                RetryPolicy::Manual,
            ))
        })
    }

    fn sync_database_parent(&self) -> Result<(), PersistenceErrorDto> {
        let parent = self.path.parent().ok_or_else(|| {
            erase_error(PersistenceErrorCode::StorageUnavailable, RetryPolicy::Never)
        })?;
        sync_parent_directory(parent)
            .map_err(|_| erase_error(PersistenceErrorCode::DeleteFailed, RetryPolicy::Manual))
    }
}

#[derive(Debug)]
struct ValidatedStoredLegacyBackup {
    row: LegacySnapshotRow,
    entries: Vec<LegacyStorageSnapshotRecordDto>,
}

fn validate_legacy_checksum(
    checksum: &str,
    operation: RepositoryOperation,
) -> Result<(), PersistenceErrorDto> {
    let bytes = checksum.as_bytes();
    if bytes.len() == 14
        && bytes.starts_with(b"crc32:")
        && bytes[6..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Ok(());
    }
    Err(migration_failure(operation, RetryPolicy::Never))
}

fn checked_legacy_count(value: u64) -> Result<i64, PersistenceErrorDto> {
    if value <= u64::try_from(MAX_LEGACY_SNAPSHOT_ENTRIES).unwrap_or(u64::MAX) {
        return i64::try_from(value)
            .map_err(|_| migration_failure(RepositoryOperation::Save, RetryPolicy::Never));
    }
    Err(persistence_error(
        RepositoryOperation::Save,
        PersistenceErrorCode::TooLarge,
        RetryPolicy::Never,
        None,
    ))
}

fn checked_migration_version(
    value: u64,
    operation: RepositoryOperation,
) -> Result<i64, PersistenceErrorDto> {
    if value == 0 || value > LEGACY_MIGRATION_VERSION {
        return Err(persistence_error(
            operation,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            None,
        ));
    }
    i64::try_from(value).map_err(|_| {
        persistence_error(
            operation,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            None,
        )
    })
}

fn checked_legacy_bytes(value: u64) -> Result<i64, PersistenceErrorDto> {
    if value <= u64::try_from(MAX_LEGACY_SNAPSHOT_BYTES).unwrap_or(u64::MAX) {
        return i64::try_from(value)
            .map_err(|_| migration_failure(RepositoryOperation::Save, RetryPolicy::Never));
    }
    Err(persistence_error(
        RepositoryOperation::Save,
        PersistenceErrorCode::TooLarge,
        RetryPolicy::Never,
        None,
    ))
}

fn validate_legacy_snapshot(
    snapshot: &LegacyStorageSnapshotDto,
    operation: RepositoryOperation,
) -> Result<(), PersistenceErrorDto> {
    validate_legacy_checksum(&snapshot.content_checksum, operation)?;
    validate_legacy_checksum(&snapshot.checksum, operation)?;
    if snapshot.storage_version != 1
        || !canonical_utc_timestamp(&snapshot.created_at)
        || snapshot.entries.len() > MAX_LEGACY_SNAPSHOT_ENTRIES
        || snapshot.total_bytes > u64::try_from(MAX_LEGACY_SNAPSHOT_BYTES).unwrap_or(u64::MAX)
    {
        return Err(migration_failure(operation, RetryPolicy::Never));
    }

    let mut total_bytes = 0_u64;
    let mut previous_key: Option<&str> = None;
    for entry in &snapshot.entries {
        validate_legacy_checksum(&entry.checksum, operation)?;
        if !(entry.key.starts_with("cts.persistence.v1.") || entry.key.starts_with("cts.project."))
            || previous_key.is_some_and(|previous| js_string_cmp(previous, &entry.key).is_ge())
        {
            return Err(migration_failure(operation, RetryPolicy::Never));
        }
        previous_key = Some(&entry.key);
        let value_bytes = u64::try_from(entry.value.len()).unwrap_or(u64::MAX);
        if entry.value_bytes != value_bytes
            || entry.checksum
                != digest_crc32(&LegacyRecordChecksum {
                    key: &entry.key,
                    value: &entry.value,
                })
        {
            return Err(migration_failure(operation, RetryPolicy::Never));
        }
        let key_bytes = u64::try_from(entry.key.len()).unwrap_or(u64::MAX);
        total_bytes = total_bytes
            .checked_add(key_bytes)
            .and_then(|total| total.checked_add(value_bytes))
            .ok_or_else(|| migration_failure(operation, RetryPolicy::Never))?;
        if total_bytes > u64::try_from(MAX_LEGACY_SNAPSHOT_BYTES).unwrap_or(u64::MAX) {
            return Err(persistence_error(
                operation,
                PersistenceErrorCode::TooLarge,
                RetryPolicy::Never,
                None,
            ));
        }
    }
    if total_bytes != snapshot.total_bytes
        || snapshot.content_checksum
            != digest_crc32(&LegacyStableContentChecksum {
                storage_version: snapshot.storage_version,
                entries: &snapshot.entries,
                total_bytes: snapshot.total_bytes,
            })
        || snapshot.checksum
            != digest_crc32(&LegacyEnvelopeChecksum {
                storage_version: snapshot.storage_version,
                created_at: &snapshot.created_at,
                entries: &snapshot.entries,
                total_bytes: snapshot.total_bytes,
                content_checksum: &snapshot.content_checksum,
            })
    {
        return Err(migration_failure(operation, RetryPolicy::Never));
    }
    Ok(())
}

fn js_string_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn encoded_storage_part(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
        {
            encoded.push(char::from(*byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn decoded_storage_part(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            let hex = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            decoded.push(hex(high)? * 16 + hex(low)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn legacy_snapshot_project_ids(
    entries: &[LegacyStorageSnapshotRecordDto],
) -> Result<HashSet<String>, PersistenceErrorDto> {
    let mut projects = HashSet::new();
    for entry in entries {
        if let Some(project_id) = entry.key.strip_prefix("cts.project.") {
            if project_id.is_empty() {
                continue;
            }
            projects.insert(project_id.to_owned());
            continue;
        }
        let Some(remainder) = entry.key.strip_prefix("cts.persistence.v1.project.") else {
            continue;
        };
        let Some((encoded_id, suffix)) = remainder.split_once('.') else {
            continue;
        };
        if suffix != "head"
            && suffix != "intent"
            && suffix != "recovery"
            && !suffix.starts_with("recovery.")
            && !suffix.starts_with("gen.")
        {
            continue;
        }
        let Some(project_id) =
            decoded_storage_part(encoded_id).filter(|project_id| !project_id.is_empty())
        else {
            continue;
        };
        if encoded_storage_part(&project_id) != encoded_id {
            continue;
        }
        projects.insert(project_id);
    }
    Ok(projects)
}

fn legacy_snapshot_coverage(
    entries: &[LegacyStorageSnapshotRecordDto],
    stages: &[LegacyImportRow],
) -> Result<Vec<LegacyDeletedEvidence>, PersistenceErrorDto> {
    let represented = legacy_snapshot_project_ids(entries)?;
    let deleted = legacy_deleted_evidences(entries, &represented);
    let deleted_projects = deleted
        .iter()
        .map(|evidence| evidence.project_id.as_str())
        .collect::<HashSet<_>>();
    if stages
        .iter()
        .any(|stage| deleted_projects.contains(stage.project_id.as_str()))
    {
        return Err(migration_conflict(RepositoryOperation::Save));
    }
    let mut covered = stages
        .iter()
        .map(|stage| stage.project_id.clone())
        .collect::<HashSet<_>>();
    covered.extend(deleted.iter().map(|evidence| evidence.project_id.clone()));
    if represented == covered {
        Ok(deleted)
    } else {
        Err(migration_conflict(RepositoryOperation::Save))
    }
}

fn validate_legacy_provenance(
    entries: &[LegacyStorageSnapshotRecordDto],
    project_id: &str,
    source_keys: &[String],
    project_json: Option<&str>,
    branch: Option<&LegacyBranchCandidateDto>,
) -> Result<(), PersistenceErrorDto> {
    if source_keys.is_empty()
        || source_keys.len() > MAX_LEGACY_SNAPSHOT_ENTRIES
        || source_keys
            .windows(2)
            .any(|keys| js_string_cmp(&keys[0], &keys[1]).is_ge())
    {
        return Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        ));
    }
    let legacy_key = format!("cts.project.{project_id}");
    let persistence_prefix = format!(
        "cts.persistence.v1.project.{}.",
        encoded_storage_part(project_id)
    );
    let archived_keys = entries
        .iter()
        .filter(|entry| entry.key == legacy_key || entry.key.starts_with(&persistence_prefix))
        .map(|entry| entry.key.as_str())
        .collect::<Vec<_>>();
    if source_keys.len() != archived_keys.len()
        || source_keys
            .iter()
            .zip(archived_keys)
            .any(|(source, archived)| source != archived)
    {
        return Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        ));
    }
    let mut payload_proven = project_json.is_none();
    let mut branch_proven = branch.is_none();
    let mut authoritative_head_proven = project_json.is_none() || branch.is_some();
    for source_key in source_keys {
        if source_key != &legacy_key && !source_key.starts_with(&persistence_prefix) {
            return Err(migration_failure(
                RepositoryOperation::Save,
                RetryPolicy::Never,
            ));
        }
        let entry = entries
            .iter()
            .find(|entry| entry.key == *source_key)
            .ok_or_else(|| migration_failure(RepositoryOperation::Save, RetryPolicy::Never))?;
        let Some(expected_project_json) = project_json else {
            continue;
        };
        if source_key == &legacy_key
            && legacy_project_matches_migrated(&entry.value, expected_project_json)
        {
            payload_proven = true;
            continue;
        }
        if source_key.contains(".gen.")
            && legacy_generation_proves(&entry.value, project_id, expected_project_json, branch)
        {
            payload_proven = true;
            if branch.is_none_or(|branch| branch.source == ProjectBranchSource::InterruptedSave) {
                branch_proven = true;
            }
        }
        if source_key.contains(".recovery")
            && legacy_recovery_proves(&entry.value, project_id, expected_project_json, branch)
        {
            payload_proven = true;
            if branch.is_none_or(|branch| branch.source == ProjectBranchSource::RecoveryJournal) {
                branch_proven = true;
            }
        }
    }
    if !authoritative_head_proven {
        authoritative_head_proven = project_json.is_some_and(|project_json| {
            matches!(
                resolve_legacy_canonical_authority(entries, project_id),
                LegacyCanonicalAuthority::Candidate(candidate)
                    if legacy_project_matches_migrated(&candidate, project_json)
            )
        });
    }
    if payload_proven && branch_proven && authoritative_head_proven {
        Ok(())
    } else {
        Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        ))
    }
}

/** Prove every released Project migration without weakening archived-byte provenance. */
fn legacy_project_matches_migrated(source: &str, expected: &str) -> bool {
    if source == expected {
        return true;
    }
    let (Ok(source), Ok(expected)) = (
        serde_json::from_str::<Value>(source),
        serde_json::from_str::<Value>(expected),
    ) else {
        return false;
    };
    let Some(expected_record) = expected.as_object() else {
        return false;
    };
    let Some(target_version) = expected_record.get("schemaVersion").and_then(Value::as_u64) else {
        return false;
    };
    migrate_project_for_legacy_proof(source, target_version).is_some_and(|value| value == expected)
}

fn migrate_project_for_legacy_proof(mut project: Value, target_version: u64) -> Option<Value> {
    let mut version = project.get("schemaVersion")?.as_u64()?;
    if !(MIN_PROJECT_SCHEMA_VERSION..=PROJECT_SCHEMA_VERSION).contains(&target_version)
        || version >= target_version
    {
        return None;
    }
    while version < target_version {
        project = match version {
            1 => migrate_project_value_v1_to_v2(project)?,
            2 => migrate_project_value_v2_to_v3(project)?,
            _ => return None,
        };
        version += 1;
    }
    Some(project)
}

/** v1 `aliasOf` was inert, so v2 makes every legacy clip independent. */
fn migrate_project_value_v1_to_v2(mut project: Value) -> Option<Value> {
    let project_record = project.as_object_mut()?;
    if project_record.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    if let Some(Value::Array(tracks)) = project_record.get_mut("tracks") {
        for track in tracks {
            let Some(track) = track.as_object_mut() else {
                continue;
            };
            let Some(Value::Array(clips)) = track.get_mut("clips") else {
                continue;
            };
            for clip in clips {
                if let Some(clip) = clip.as_object_mut() {
                    clip.remove("aliasOf");
                }
            }
        }
    }
    project_record.insert("schemaVersion".to_owned(), Value::from(2));
    Some(project)
}

fn value_contains_v3_project_fields(project: &serde_json::Map<String, Value>) -> bool {
    const ROOT_FIELDS: &[&str] = &[
        "lengthBeats",
        "tempoMap",
        "timeSignatureMap",
        "audioAssets",
        "automationLanes",
    ];
    const CLIP_FIELDS: &[&str] = &[
        "sourceStartFrame",
        "sourceFrameCount",
        "fadeInFrames",
        "fadeOutFrames",
        "gainDb",
    ];
    ROOT_FIELDS.iter().any(|key| project.contains_key(*key))
        || project
            .get("tracks")
            .and_then(Value::as_array)
            .is_some_and(|tracks| {
                tracks.iter().any(|track| {
                    track.as_object().is_some_and(|track| {
                        track.contains_key("role")
                            || track
                                .get("clips")
                                .and_then(Value::as_array)
                                .is_some_and(|clips| {
                                    clips.iter().any(|clip| {
                                        clip.as_object().is_some_and(|clip| {
                                            CLIP_FIELDS.iter().any(|key| clip.contains_key(*key))
                                        })
                                    })
                                })
                    })
                })
            })
}

fn collect_value_ids(value: &Value, ids: &mut HashSet<String>) {
    match value {
        Value::Object(record) => {
            if let Some(id) = record.get("id").and_then(Value::as_str) {
                ids.insert(id.to_owned());
            }
            for child in record.values() {
                collect_value_ids(child, ids);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_value_ids(item, ids);
            }
        }
        _ => {}
    }
}

fn next_migrated_id(base: &str, counter: &mut u64, ids: &mut HashSet<String>) -> String {
    loop {
        *counter = counter.saturating_add(1);
        let candidate = format!("{base}-{counter}");
        if ids.insert(candidate.clone()) {
            return candidate;
        }
    }
}

fn is_javascript_trim_character(value: char) -> bool {
    matches!(
        value,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn migrated_learning_role(track: &serde_json::Map<String, Value>) -> Option<&'static str> {
    if track.get("type").and_then(Value::as_str) != Some("instrument") {
        return None;
    }
    let normalized = track
        .get("name")?
        .as_str()?
        .trim_matches(is_javascript_trim_character)
        .to_lowercase();
    match normalized.as_str() {
        "chord" | "chords" | "コード" => Some("learning.chords"),
        "bass" => Some("learning.bass"),
        "melody" => Some("learning.melody"),
        _ => None,
    }
}

/** Match JSON.stringify's integer representation for finite JavaScript numbers. */
fn migrated_json_number(value: f64) -> Option<Value> {
    if !value.is_finite() || value.abs() > JS_MAX_SAFE_INTEGER as f64 {
        return None;
    }
    if value.fract() == 0.0 {
        return Some(if value >= 0.0 {
            Value::from(value as u64)
        } else {
            Value::from(value as i64)
        });
    }
    serde_json::Number::from_f64(value).map(Value::Number)
}

/**
 * v3 adds explicit timeline maps, semantic track roles, managed/unresolved
 * audio assets, and automation storage. Migration preserves v2's first-match
 * learning-track resolver and never fabricates ready audio metadata.
 */
fn migrate_project_value_v2_to_v3(mut project: Value) -> Option<Value> {
    let project_record = project.as_object()?;
    if project_record.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || value_contains_v3_project_fields(project_record)
    {
        return None;
    }
    let bpm = project_record.get("bpm")?.as_f64()?;
    let length_bars = project_record.get("lengthBars")?.as_u64()?;
    let signature = project_record.get("timeSignature")?.as_array()?;
    if signature.len() != 2 {
        return None;
    }
    let numerator = signature[0].as_u64()?;
    let denominator = signature[1].as_u64()?;
    if denominator == 0 {
        return None;
    }
    let length_beats = length_bars as f64 * numerator as f64 * 4.0 / denominator as f64;
    let length_beats_value = migrated_json_number(length_beats)?;
    let bpm_value = migrated_json_number(bpm)?;

    let mut ids = HashSet::new();
    collect_value_ids(&project, &mut ids);
    let mut tempo_counter = 0;
    let mut signature_counter = 0;
    let mut audio_counter = 0;
    let tempo_id = next_migrated_id("migrated-tempo", &mut tempo_counter, &mut ids);
    let signature_id = next_migrated_id("migrated-signature", &mut signature_counter, &mut ids);
    let mut migrated_assets = Vec::new();
    let mut assets_by_legacy_id = HashMap::<String, String>::new();
    let mut assigned_roles = HashSet::<&'static str>::new();

    let project_record = project.as_object_mut()?;
    let tracks = project_record.get_mut("tracks")?.as_array_mut()?;
    for track in tracks {
        let track = track.as_object_mut()?;
        let role = migrated_learning_role(track)
            .filter(|role| assigned_roles.insert(*role))
            .unwrap_or("general");
        track.insert("role".to_owned(), Value::String(role.to_owned()));
        let clips = track.get_mut("clips")?.as_array_mut()?;
        for clip in clips {
            let clip = clip.as_object_mut()?;
            if clip.get("type").and_then(Value::as_str) != Some("audio") {
                continue;
            }
            let legacy_asset_id = clip
                .get("audioAssetId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            let migrated_asset_id = legacy_asset_id
                .as_ref()
                .and_then(|legacy| assets_by_legacy_id.get(legacy).cloned())
                .unwrap_or_else(|| {
                    let id = next_migrated_id("migrated-audio", &mut audio_counter, &mut ids);
                    let asset = if let Some(legacy) = legacy_asset_id.as_ref() {
                        assets_by_legacy_id.insert(legacy.clone(), id.clone());
                        serde_json::json!({
                            "id": id,
                            "availability": "unresolved",
                            "legacyAssetId": legacy,
                            "reason": "legacy-reference"
                        })
                    } else {
                        serde_json::json!({
                            "id": id,
                            "availability": "unresolved",
                            "reason": "missing-reference"
                        })
                    };
                    migrated_assets.push(asset);
                    id
                });
            clip.insert("audioAssetId".to_owned(), Value::String(migrated_asset_id));
            clip.insert("sourceStartFrame".to_owned(), Value::from(0));
            clip.insert("sourceFrameCount".to_owned(), Value::from(0));
            clip.insert("fadeInFrames".to_owned(), Value::from(0));
            clip.insert("fadeOutFrames".to_owned(), Value::from(0));
            clip.insert("gainDb".to_owned(), Value::from(0));
        }
    }

    project_record.insert("schemaVersion".to_owned(), Value::from(3));
    project_record.insert("lengthBeats".to_owned(), length_beats_value);
    project_record.insert(
        "tempoMap".to_owned(),
        serde_json::json!([{ "id": tempo_id, "beat": 0, "bpm": bpm_value }]),
    );
    project_record.insert(
        "timeSignatureMap".to_owned(),
        serde_json::json!([{
            "id": signature_id,
            "beat": 0,
            "numerator": numerator,
            "denominator": denominator
        }]),
    );
    project_record.insert("audioAssets".to_owned(), Value::Array(migrated_assets));
    project_record.insert("automationLanes".to_owned(), Value::Array(Vec::new()));
    Some(project)
}

fn validate_legacy_diagnostic_provenance(
    entries: &[LegacyStorageSnapshotRecordDto],
    project_id: &str,
    source_keys: &[String],
) -> Result<(), PersistenceErrorDto> {
    validate_legacy_provenance(entries, project_id, source_keys, None, None)?;
    let LegacyCanonicalAuthority::Candidate(project_json) =
        resolve_legacy_canonical_authority(entries, project_id)
    else {
        return Ok(());
    };
    let current =
        canonical_project_json(&project_json, RepositoryOperation::Save, Some(project_id));
    if current.is_ok_and(|candidate| candidate.project_id == project_id) {
        Err(conflict(RepositoryOperation::Save, project_id))
    } else {
        Ok(())
    }
}

fn legacy_generation_proves(
    raw: &str,
    project_id: &str,
    project_json: &str,
    branch: Option<&LegacyBranchCandidateDto>,
) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    let Some(record) = value.as_object() else {
        return false;
    };
    let (
        Some(storage_version),
        Some(kind),
        Some(source_project_id),
        Some(ordinal),
        Some(write_id),
        Some(activation_id),
        Some(revision),
        Some(saved_at),
        Some(bytes),
        Some(source_project_json),
        Some(checksum),
    ) = (
        record.get("storageVersion").and_then(Value::as_u64),
        record.get("kind").and_then(Value::as_str),
        record.get("projectId").and_then(Value::as_str),
        record.get("ordinal").and_then(Value::as_u64),
        record.get("writeId").and_then(Value::as_str),
        record.get("activationId").and_then(Value::as_str),
        record.get("revision").and_then(Value::as_u64),
        record.get("savedAt").and_then(Value::as_str),
        record.get("bytes").and_then(Value::as_u64),
        record.get("projectJson").and_then(Value::as_str),
        record.get("checksum").and_then(Value::as_str),
    )
    else {
        return false;
    };
    let parent_head_version = match record.get("parentHeadVersion") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return false,
    };
    let proof = LegacyProjectGenerationProof {
        storage_version,
        kind,
        project_id: source_project_id,
        ordinal,
        parent_head_version,
        write_id,
        activation_id,
        revision,
        saved_at,
        bytes,
        project_json: source_project_json,
    };
    storage_version == 1
        && kind == "project"
        && source_project_id == project_id
        && legacy_project_matches_migrated(source_project_json, project_json)
        && usize::try_from(bytes).ok() == Some(source_project_json.len())
        && checksum == digest_crc32(&proof)
        && branch.is_none_or(|branch| {
            branch.source == ProjectBranchSource::InterruptedSave
                && branch.activation_id == activation_id
                && branch.revision == revision
                && branch.write_id == write_id
                && branch.saved_at == saved_at
        })
}

fn legacy_tombstone_generation_proves(
    entry: &LegacyStorageSnapshotRecordDto,
    persistence_prefix: &str,
    project_id: &str,
) -> bool {
    let Some(remainder) = entry.key.strip_prefix(&format!("{persistence_prefix}gen.")) else {
        return false;
    };
    let Some((ordinal_raw, encoded_operation_id)) = remainder.split_once('.') else {
        return false;
    };
    let (Ok(key_ordinal), Some(key_operation_id)) = (
        ordinal_raw.parse::<u64>(),
        decoded_storage_part(encoded_operation_id),
    ) else {
        return false;
    };
    if key_ordinal == 0 || key_ordinal > JS_MAX_SAFE_INTEGER || key_operation_id.is_empty() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(&entry.value) else {
        return false;
    };
    let Some(record) = value.as_object() else {
        return false;
    };
    let (
        Some(storage_version),
        Some(kind),
        Some(source_project_id),
        Some(ordinal),
        Some(delete_id),
        Some(deleted_at),
        Some(checksum),
    ) = (
        record.get("storageVersion").and_then(Value::as_u64),
        record.get("kind").and_then(Value::as_str),
        record.get("projectId").and_then(Value::as_str),
        record.get("ordinal").and_then(Value::as_u64),
        record.get("deleteId").and_then(Value::as_str),
        record.get("deletedAt").and_then(Value::as_str),
        record.get("checksum").and_then(Value::as_str),
    )
    else {
        return false;
    };
    let parent_head_version = match record.get("parentHeadVersion") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return false,
    };
    let proof = LegacyTombstoneGenerationProof {
        storage_version,
        kind,
        project_id: source_project_id,
        ordinal,
        parent_head_version,
        delete_id,
        deleted_at,
    };
    storage_version == LEGACY_STORAGE_VERSION
        && kind == "tombstone"
        && source_project_id == project_id
        && ordinal == key_ordinal
        && delete_id == key_operation_id
        && canonical_utc_timestamp(deleted_at)
        && checksum == digest_crc32(&proof)
}

fn legacy_has_valid_tombstone_generation(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
) -> bool {
    entries
        .iter()
        .any(|entry| legacy_tombstone_generation_proves(entry, persistence_prefix, project_id))
}

fn legacy_active_head_evidence(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
) -> Option<LegacyActiveHeadEvidence> {
    let head_key = format!("{persistence_prefix}head");
    let head_entry = entries.iter().find(|entry| entry.key == head_key)?;
    let value = serde_json::from_str::<Value>(&head_entry.value).ok()?;
    let record = value.as_object()?;
    let storage_version = record.get("storageVersion")?.as_u64()?;
    let state = record.get("state")?.as_str()?;
    let source_project_id = record.get("projectId")?.as_str()?;
    let ordinal = record.get("ordinal")?.as_u64()?;
    let generation_key = record.get("generationKey")?.as_str()?;
    let operation_id = record.get("operationId")?.as_str()?;
    let committed_at = record.get("committedAt")?.as_str()?;
    let checksum = record.get("checksum")?.as_str()?;
    let parent_head_version = match record.get("parentHeadVersion") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value.as_str())),
        _ => return None,
    };
    let payload_checksum = match record.get("payloadChecksum") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value.as_str())),
        _ => return None,
    };
    let proof = LegacyHeadProof {
        storage_version,
        state,
        project_id: source_project_id,
        ordinal,
        generation_key,
        operation_id,
        parent_head_version,
        payload_checksum,
        committed_at,
    };
    if storage_version != 1
        || state != "active"
        || source_project_id != project_id
        || ordinal == 0
        || operation_id.is_empty()
        || !canonical_utc_timestamp(committed_at)
        || payload_checksum == Some(None)
        || checksum != digest_crc32(&proof)
    {
        return None;
    }
    Some(LegacyActiveHeadEvidence {
        ordinal,
        generation_key: generation_key.to_owned(),
        operation_id: operation_id.to_owned(),
        head_version: format!("{ordinal}:active:{operation_id}"),
        parent_head_version: parent_head_version.map(|version| version.map(str::to_owned)),
        payload_checksum: payload_checksum.map(|checksum| checksum.map(str::to_owned)),
    })
}

fn legacy_head_authorizes(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
    project_json: &str,
) -> bool {
    let head_key = format!("{persistence_prefix}head");
    let Some(head_entry) = entries.iter().find(|entry| entry.key == head_key) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&head_entry.value) else {
        return false;
    };
    let Some(record) = value.as_object() else {
        return false;
    };
    let (
        Some(storage_version),
        Some(state),
        Some(source_project_id),
        Some(ordinal),
        Some(generation_key),
        Some(operation_id),
        Some(committed_at),
        Some(checksum),
    ) = (
        record.get("storageVersion").and_then(Value::as_u64),
        record.get("state").and_then(Value::as_str),
        record.get("projectId").and_then(Value::as_str),
        record.get("ordinal").and_then(Value::as_u64),
        record.get("generationKey").and_then(Value::as_str),
        record.get("operationId").and_then(Value::as_str),
        record.get("committedAt").and_then(Value::as_str),
        record.get("checksum").and_then(Value::as_str),
    )
    else {
        return false;
    };
    let parent_head_version = match record.get("parentHeadVersion") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value.as_str())),
        _ => return false,
    };
    let payload_checksum = match record.get("payloadChecksum") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value.as_str())),
        _ => return false,
    };
    let proof = LegacyHeadProof {
        storage_version,
        state,
        project_id: source_project_id,
        ordinal,
        generation_key,
        operation_id,
        parent_head_version,
        payload_checksum,
        committed_at,
    };
    let expected_payload_checksum = crc32(project_json.as_bytes());
    if storage_version != 1
        || state != "active"
        || source_project_id != project_id
        || ordinal == 0
        || operation_id.is_empty()
        || !canonical_utc_timestamp(committed_at)
        || checksum != digest_crc32(&proof)
        || payload_checksum
            .is_some_and(|checksum| checksum != Some(expected_payload_checksum.as_str()))
    {
        return false;
    }
    let Some(generation_entry) = entries.iter().find(|entry| entry.key == generation_key) else {
        return false;
    };
    let Ok(generation_value) = serde_json::from_str::<Value>(&generation_entry.value) else {
        return false;
    };
    let Some(generation) = generation_value.as_object() else {
        return false;
    };
    generation.get("ordinal").and_then(Value::as_u64) == Some(ordinal)
        && generation.get("writeId").and_then(Value::as_str) == Some(operation_id)
        && legacy_generation_proves(&generation_entry.value, project_id, project_json, None)
}

fn legacy_recovery_selection(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
    head: Option<&LegacyActiveHeadEvidence>,
    base_generation: Option<&LegacyGenerationCandidate>,
    generations: &[LegacyGenerationCandidate],
) -> LegacyCandidateSelection {
    let missing_head_mirror = if head.is_none() {
        entries
            .iter()
            .find(|entry| entry.key == format!("cts.project.{project_id}"))
            .map(|entry| entry.value.as_str())
    } else {
        None
    };
    let newest_missing_head_generation = if head.is_none() {
        let max_ordinal = generations
            .iter()
            .map(|generation| generation.ordinal)
            .max();
        max_ordinal.and_then(|max_ordinal| {
            let mut newest = generations
                .iter()
                .filter(|generation| generation.ordinal == max_ordinal);
            let candidate = newest.next()?;
            newest.next().is_none().then_some(candidate)
        })
    } else {
        None
    };
    let mut latest_by_activation: HashMap<String, LegacyProjectCandidate> = HashMap::new();
    for entry in entries.iter().filter(|entry| {
        entry
            .key
            .strip_prefix(persistence_prefix)
            .is_some_and(|suffix| suffix == "recovery" || suffix.starts_with("recovery."))
    }) {
        let Ok(value) = serde_json::from_str::<Value>(&entry.value) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };
        let (
            Some(base_head_known),
            Some(activation_id),
            Some(revision),
            Some(write_id),
            Some(saved_at),
            Some(source_project_json),
        ) = (
            record.get("baseHeadKnown").and_then(Value::as_bool),
            record.get("activationId").and_then(Value::as_str),
            record.get("revision").and_then(Value::as_u64),
            record.get("writeId").and_then(Value::as_str),
            record.get("savedAt").and_then(Value::as_str),
            record.get("projectJson").and_then(Value::as_str),
        )
        else {
            continue;
        };
        let base_head_version = match record.get("baseHeadVersion") {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.as_str()),
            _ => continue,
        };
        let predecessor = match record.get("predecessorWriteId") {
            None => None,
            Some(Value::String(value)) => Some(value.as_str()),
            _ => continue,
        };
        let matches_newest_generation = newest_missing_head_generation.is_some_and(|generation| {
            generation.candidate.project_json == source_project_json
                && generation.candidate.activation_id == activation_id
                && generation.candidate.revision == revision
                && generation.candidate.write_id == write_id
        });
        let follows = match head {
            Some(head) => {
                (base_head_known && base_head_version == Some(head.head_version.as_str()))
                    || predecessor == Some(head.operation_id.as_str())
            }
            None => match base_generation {
                Some(evidence) => {
                    (base_head_known && base_head_version == Some(evidence.head_version.as_str()))
                        || predecessor == Some(evidence.candidate.write_id.as_str())
                }
                None => {
                    predecessor.is_some_and(|predecessor| {
                        newest_missing_head_generation
                            .is_some_and(|generation| generation.candidate.write_id == predecessor)
                    }) || matches_newest_generation
                        || (base_head_known
                            && match base_head_version {
                                None => {
                                    matches_newest_generation
                                        || (newest_missing_head_generation.is_none()
                                            && generations.is_empty()
                                            && missing_head_mirror
                                                .is_none_or(|mirror| mirror == source_project_json))
                                }
                                Some(version) => newest_missing_head_generation
                                    .is_some_and(|generation| generation.head_version == version),
                            })
                }
            },
        };
        let outranks = base_generation.is_none_or(|base| {
            activation_id != base.candidate.activation_id || revision > base.candidate.revision
        });
        if !follows
            || !outranks
            || activation_id.is_empty()
            || write_id.is_empty()
            || !canonical_utc_timestamp(saved_at)
            || !legacy_recovery_proves(&entry.value, project_id, source_project_json, None)
        {
            continue;
        }
        let candidate = LegacyProjectCandidate {
            project_json: source_project_json.to_owned(),
            activation_id: activation_id.to_owned(),
            revision,
            write_id: write_id.to_owned(),
            saved_at: saved_at.to_owned(),
        };
        match latest_by_activation.get(activation_id) {
            Some(latest)
                if latest.revision > candidate.revision
                    || (latest.revision == candidate.revision
                        && latest.saved_at > candidate.saved_at) => {}
            Some(latest)
                if latest.revision == candidate.revision
                    && latest.saved_at == candidate.saved_at =>
            {
                if latest.project_json != candidate.project_json {
                    return LegacyCandidateSelection::Conflict;
                }
                if candidate.write_id > latest.write_id {
                    latest_by_activation.insert(activation_id.to_owned(), candidate);
                }
            }
            _ => {
                latest_by_activation.insert(activation_id.to_owned(), candidate);
            }
        }
    }
    let payloads = latest_by_activation
        .values()
        .map(|candidate| candidate.project_json.as_str())
        .collect::<HashSet<_>>();
    if payloads.len() > 1 {
        return LegacyCandidateSelection::Conflict;
    }
    latest_by_activation
        .into_values()
        .max_by(|left, right| {
            left.saved_at
                .cmp(&right.saved_at)
                .then(left.revision.cmp(&right.revision))
                .then(left.write_id.cmp(&right.write_id))
        })
        .map_or(
            LegacyCandidateSelection::None,
            LegacyCandidateSelection::Candidate,
        )
}

fn legacy_generation_candidates(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
) -> Vec<LegacyGenerationCandidate> {
    let mut candidates = Vec::new();
    for entry in entries.iter().filter(|entry| {
        entry
            .key
            .strip_prefix(persistence_prefix)
            .is_some_and(|suffix| suffix.starts_with("gen."))
    }) {
        let Ok(value) = serde_json::from_str::<Value>(&entry.value) else {
            continue;
        };
        let Some(generation) = value.as_object() else {
            continue;
        };
        let (
            Some(project_json),
            Some(ordinal),
            Some(activation_id),
            Some(revision),
            Some(write_id),
            Some(saved_at),
        ) = (
            generation.get("projectJson").and_then(Value::as_str),
            generation.get("ordinal").and_then(Value::as_u64),
            generation.get("activationId").and_then(Value::as_str),
            generation.get("revision").and_then(Value::as_u64),
            generation.get("writeId").and_then(Value::as_str),
            generation.get("savedAt").and_then(Value::as_str),
        )
        else {
            continue;
        };
        let parent_head_version = match generation.get("parentHeadVersion") {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.as_str()),
            _ => continue,
        };
        if ordinal == 0
            || activation_id.is_empty()
            || write_id.is_empty()
            || !canonical_utc_timestamp(saved_at)
            || !legacy_generation_proves(&entry.value, project_id, project_json, None)
        {
            continue;
        }
        candidates.push(LegacyGenerationCandidate {
            candidate: LegacyProjectCandidate {
                project_json: project_json.to_owned(),
                activation_id: activation_id.to_owned(),
                revision,
                write_id: write_id.to_owned(),
                saved_at: saved_at.to_owned(),
            },
            key: entry.key.clone(),
            ordinal,
            head_version: format!("{ordinal}:active:{write_id}"),
            parent_head_version: parent_head_version.map(str::to_owned),
        });
    }
    candidates
}

fn legacy_pointed_candidate(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
    head: &LegacyActiveHeadEvidence,
    generations: &[LegacyGenerationCandidate],
) -> Option<LegacyGenerationCandidate> {
    let candidate = generations.iter().find(|candidate| {
        candidate.key == head.generation_key
            && candidate.ordinal == head.ordinal
            && candidate.candidate.write_id == head.operation_id
    })?;
    legacy_head_authorizes(
        entries,
        persistence_prefix,
        project_id,
        &candidate.candidate.project_json,
    )
    .then(|| candidate.clone())
}

fn legacy_intent_generation_candidate(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
    generations: &[LegacyGenerationCandidate],
) -> Option<LegacyGenerationCandidate> {
    let intent_key = format!("{persistence_prefix}intent");
    let intent_entry = entries.iter().find(|entry| entry.key == intent_key)?;
    let intent_value = serde_json::from_str::<Value>(&intent_entry.value).ok()?;
    let intent = intent_value.as_object()?;
    let storage_version = intent.get("storageVersion")?.as_u64()?;
    let source_project_id = intent.get("projectId")?.as_str()?;
    let kind = intent.get("kind")?.as_str()?;
    let generation_key = intent.get("generationKey")?.as_str()?;
    let operation_id = intent.get("operationId")?.as_str()?;
    let checksum = intent.get("checksum")?.as_str()?;
    let parent_head_version = match intent.get("parentHeadVersion") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return None,
    };
    let proof = LegacyIntentProof {
        storage_version,
        project_id: source_project_id,
        kind,
        generation_key,
        operation_id,
        parent_head_version,
    };
    if storage_version != 1
        || source_project_id != project_id
        || kind != "project"
        || checksum != digest_crc32(&proof)
    {
        return None;
    }
    generations
        .iter()
        .find(|candidate| {
            candidate.key == generation_key
                && candidate.candidate.write_id == operation_id
                && candidate.parent_head_version.as_deref() == parent_head_version
        })
        .cloned()
}

fn legacy_intent_candidate(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
    head: &LegacyActiveHeadEvidence,
    generations: &[LegacyGenerationCandidate],
) -> Option<LegacyProjectCandidate> {
    let generation =
        legacy_intent_generation_candidate(entries, persistence_prefix, project_id, generations)?;
    (generation.ordinal > head.ordinal
        && generation.parent_head_version.as_deref() == Some(head.head_version.as_str()))
    .then_some(generation.candidate)
}

fn select_legacy_interrupted_candidate(
    recovery: LegacyCandidateSelection,
    intent: Option<LegacyProjectCandidate>,
) -> LegacyCandidateSelection {
    match (recovery, intent) {
        (LegacyCandidateSelection::Conflict, _) => LegacyCandidateSelection::Conflict,
        (LegacyCandidateSelection::None, None) => LegacyCandidateSelection::None,
        (LegacyCandidateSelection::None, Some(intent)) => {
            LegacyCandidateSelection::Candidate(intent)
        }
        (LegacyCandidateSelection::Candidate(recovery), None) => {
            LegacyCandidateSelection::Candidate(recovery)
        }
        (LegacyCandidateSelection::Candidate(recovery), Some(intent)) => {
            if recovery.activation_id != intent.activation_id
                && recovery.project_json != intent.project_json
            {
                return LegacyCandidateSelection::Conflict;
            }
            let intent_is_preferred = (recovery.activation_id == intent.activation_id
                && recovery.revision <= intent.revision)
                || (recovery.activation_id != intent.activation_id
                    && recovery.saved_at <= intent.saved_at);
            if intent_is_preferred {
                LegacyCandidateSelection::Candidate(intent)
            } else {
                LegacyCandidateSelection::Candidate(recovery)
            }
        }
    }
}

fn legacy_snapshot_has_future_evidence(
    entries: &[LegacyStorageSnapshotRecordDto],
    persistence_prefix: &str,
    project_id: &str,
) -> bool {
    let mirror_key = format!("cts.project.{project_id}");
    entries.iter().any(|entry| {
        if entry.key != mirror_key && !entry.key.starts_with(persistence_prefix) {
            return false;
        }
        let Ok(value) = serde_json::from_str::<Value>(&entry.value) else {
            return false;
        };
        if entry.key == mirror_key {
            return value
                .get("schemaVersion")
                .and_then(Value::as_u64)
                .is_some_and(|version| version > PROJECT_SCHEMA_VERSION);
        }
        if value
            .get("storageVersion")
            .and_then(Value::as_u64)
            .is_some_and(|version| version > LEGACY_STORAGE_VERSION)
        {
            return true;
        }
        value
            .get("projectJson")
            .and_then(Value::as_str)
            .and_then(|project_json| serde_json::from_str::<Value>(project_json).ok())
            .and_then(|project| project.get("schemaVersion").and_then(Value::as_u64))
            .is_some_and(|version| version > PROJECT_SCHEMA_VERSION)
    })
}

fn resolve_legacy_canonical_authority(
    entries: &[LegacyStorageSnapshotRecordDto],
    project_id: &str,
) -> LegacyCanonicalAuthority {
    if legacy_deleted_evidence(entries, project_id).is_some() {
        return LegacyCanonicalAuthority::Deleted;
    }
    let persistence_prefix = format!(
        "cts.persistence.v1.project.{}.",
        encoded_storage_part(project_id)
    );
    if legacy_snapshot_has_future_evidence(entries, &persistence_prefix, project_id) {
        return LegacyCanonicalAuthority::Unsupported;
    }
    if legacy_has_valid_tombstone_generation(entries, &persistence_prefix, project_id) {
        return LegacyCanonicalAuthority::Conflict;
    }
    let mirror = entries
        .iter()
        .find(|entry| entry.key == format!("cts.project.{project_id}"));
    let generations = legacy_generation_candidates(entries, &persistence_prefix, project_id);
    let Some(head) = legacy_active_head_evidence(entries, &persistence_prefix, project_id) else {
        let evidenced_generation = mirror.and_then(|entry| {
            generations
                .iter()
                .find(|generation| generation.candidate.project_json == entry.value)
        });
        let recovery = legacy_recovery_selection(
            entries,
            &persistence_prefix,
            project_id,
            None,
            evidenced_generation,
            &generations,
        );
        let intent = legacy_intent_generation_candidate(
            entries,
            &persistence_prefix,
            project_id,
            &generations,
        )
        .filter(|intent| {
            evidenced_generation.is_none_or(|evidence| {
                intent.ordinal > evidence.ordinal
                    && intent.parent_head_version.as_deref() == Some(evidence.head_version.as_str())
            })
        })
        .map(|generation| generation.candidate);
        return match select_legacy_interrupted_candidate(recovery, intent) {
            LegacyCandidateSelection::Conflict => LegacyCanonicalAuthority::Conflict,
            LegacyCandidateSelection::Candidate(candidate) => {
                LegacyCanonicalAuthority::Candidate(candidate.project_json)
            }
            LegacyCandidateSelection::None => mirror
                .map_or(LegacyCanonicalAuthority::None, |entry| {
                    LegacyCanonicalAuthority::Candidate(entry.value.clone())
                }),
        };
    };
    let pointed = legacy_pointed_candidate(
        entries,
        &persistence_prefix,
        project_id,
        &head,
        &generations,
    );
    let recovery = legacy_recovery_selection(
        entries,
        &persistence_prefix,
        project_id,
        Some(&head),
        pointed.as_ref(),
        &generations,
    );
    let intent = legacy_intent_candidate(
        entries,
        &persistence_prefix,
        project_id,
        &head,
        &generations,
    );
    match select_legacy_interrupted_candidate(recovery, intent) {
        LegacyCandidateSelection::Conflict => LegacyCanonicalAuthority::Conflict,
        LegacyCandidateSelection::Candidate(candidate) => {
            LegacyCanonicalAuthority::Candidate(candidate.project_json)
        }
        LegacyCandidateSelection::None => {
            if let Some(pointed) = pointed.as_ref() {
                return LegacyCanonicalAuthority::Candidate(pointed.candidate.project_json.clone());
            }
            let mirror_matches = mirror.is_some_and(|entry| match head.payload_checksum.as_ref() {
                None => true,
                Some(Some(expected)) => crc32(entry.value.as_bytes()) == *expected,
                Some(None) => false,
            });
            if mirror_matches {
                LegacyCanonicalAuthority::Candidate(
                    mirror.expect("mirror presence checked").value.clone(),
                )
            } else if let Some(parent) = head
                .parent_head_version
                .as_ref()
                .and_then(|version| version.as_ref())
                .and_then(|parent| {
                    generations
                        .iter()
                        .find(|generation| generation.head_version == *parent)
                })
            {
                LegacyCanonicalAuthority::Candidate(parent.candidate.project_json.clone())
            } else {
                LegacyCanonicalAuthority::None
            }
        }
    }
}

fn legacy_deleted_evidences(
    entries: &[LegacyStorageSnapshotRecordDto],
    projects: &HashSet<String>,
) -> Vec<LegacyDeletedEvidence> {
    projects
        .iter()
        .filter_map(|project_id| legacy_deleted_evidence(entries, project_id))
        .collect()
}

fn legacy_deleted_evidence(
    entries: &[LegacyStorageSnapshotRecordDto],
    project_id: &str,
) -> Option<LegacyDeletedEvidence> {
    let prefix = format!(
        "cts.persistence.v1.project.{}.",
        encoded_storage_part(project_id)
    );
    let head_entry = entries
        .iter()
        .find(|entry| entry.key == format!("{prefix}head"))?;
    let head_value: Value = serde_json::from_str(&head_entry.value).ok()?;
    let head = head_value.as_object()?;
    let storage_version = head.get("storageVersion")?.as_u64()?;
    let state = head.get("state")?.as_str()?;
    let source_project_id = head.get("projectId")?.as_str()?;
    let ordinal = head.get("ordinal")?.as_u64()?;
    let generation_key = head.get("generationKey")?.as_str()?;
    let operation_id = head.get("operationId")?.as_str()?;
    let committed_at = head.get("committedAt")?.as_str()?;
    let head_checksum = head.get("checksum")?.as_str()?;
    let parent_head_version = match head.get("parentHeadVersion") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value.as_str())),
        _ => return None,
    };
    let payload_checksum = match head.get("payloadChecksum") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value.as_str())),
        _ => return None,
    };
    let head_proof = LegacyHeadProof {
        storage_version,
        state,
        project_id: source_project_id,
        ordinal,
        generation_key,
        operation_id,
        parent_head_version,
        payload_checksum,
        committed_at,
    };
    if storage_version != 1
        || state != "deleted"
        || source_project_id != project_id
        || ordinal == 0
        || ordinal > JS_MAX_SAFE_INTEGER
        || operation_id.is_empty()
        || !canonical_utc_timestamp(committed_at)
        || payload_checksum.is_some_and(|checksum| checksum.is_some())
        || head_checksum != digest_crc32(&head_proof)
    {
        return None;
    }
    Some(LegacyDeletedEvidence {
        project_id: project_id.to_owned(),
        delete_id: operation_id.to_owned(),
        deleted_at: committed_at.to_owned(),
    })
}

fn legacy_recovery_proves(
    raw: &str,
    project_id: &str,
    project_json: &str,
    branch: Option<&LegacyBranchCandidateDto>,
) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    let Some(record) = value.as_object() else {
        return false;
    };
    let (
        Some(storage_version),
        Some(source_project_id),
        Some(base_head_known),
        Some(activation_id),
        Some(revision),
        Some(write_id),
        Some(saved_at),
        Some(bytes),
        Some(source_project_json),
        Some(checksum),
    ) = (
        record.get("storageVersion").and_then(Value::as_u64),
        record.get("projectId").and_then(Value::as_str),
        record.get("baseHeadKnown").and_then(Value::as_bool),
        record.get("activationId").and_then(Value::as_str),
        record.get("revision").and_then(Value::as_u64),
        record.get("writeId").and_then(Value::as_str),
        record.get("savedAt").and_then(Value::as_str),
        record.get("bytes").and_then(Value::as_u64),
        record.get("projectJson").and_then(Value::as_str),
        record.get("checksum").and_then(Value::as_str),
    )
    else {
        return false;
    };
    let base_head_version = match record.get("baseHeadVersion") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return false,
    };
    if !base_head_known && base_head_version.is_some() {
        return false;
    }
    let predecessor_write_id = match record.get("predecessorWriteId") {
        None => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return false,
    };
    let proof = LegacyRecoveryProof {
        storage_version,
        project_id: source_project_id,
        base_head_known,
        base_head_version,
        predecessor_write_id,
        activation_id,
        revision,
        write_id,
        saved_at,
        bytes,
        project_json: source_project_json,
    };
    storage_version == 1
        && source_project_id == project_id
        && legacy_project_matches_migrated(source_project_json, project_json)
        && usize::try_from(bytes).ok() == Some(source_project_json.len())
        && checksum == digest_crc32(&proof)
        && branch.is_none_or(|branch| {
            branch.source == ProjectBranchSource::RecoveryJournal
                && branch.activation_id == activation_id
                && branch.revision == revision
                && branch.write_id == write_id
                && branch.saved_at == saved_at
        })
}

fn read_legacy_snapshot_row(
    connection: &Connection,
    content_checksum: &str,
) -> Result<Option<LegacySnapshotRow>, SqliteError> {
    connection
        .query_row(
            "SELECT storage_version, created_at, record_count, total_bytes,
                    envelope_checksum, backup_crc32
             FROM legacy_migration_snapshots WHERE content_checksum = ?1",
            params![content_checksum],
            |row| {
                Ok(LegacySnapshotRow {
                    storage_version: row.get(0)?,
                    created_at: row.get(1)?,
                    record_count: row.get(2)?,
                    total_bytes: row.get(3)?,
                    envelope_checksum: row.get(4)?,
                    backup_crc32: row.get(5)?,
                })
            },
        )
        .optional()
}

fn read_legacy_snapshot_records(
    connection: &Connection,
    content_checksum: &str,
) -> Result<Vec<LegacySnapshotRecordRow>, SqliteError> {
    let mut statement = connection.prepare(
        "SELECT ordinal, storage_key, storage_value, value_bytes,
                source_checksum, record_crc32
         FROM legacy_migration_records
         WHERE content_checksum = ?1
         ORDER BY ordinal ASC",
    )?;
    let records = statement
        .query_map(params![content_checksum], |row| {
            Ok(LegacySnapshotRecordRow {
                ordinal: row.get(0)?,
                key: row.get(1)?,
                value: row.get(2)?,
                value_bytes: row.get(3)?,
                source_checksum: row.get(4)?,
                record_crc32: row.get(5)?,
            })
        })?
        .collect();
    records
}

fn read_legacy_migration_run(
    connection: &Connection,
    content_checksum: &str,
    migration_version: i64,
) -> Result<Option<LegacyMigrationRunRow>, SqliteError> {
    connection
        .query_row(
            "SELECT record_count, total_bytes, ready_project_count,
                    unreadable_project_count, branch_count
             FROM legacy_migration_runs
             WHERE content_checksum = ?1 AND migration_version = ?2",
            params![content_checksum, migration_version],
            |row| {
                Ok(LegacyMigrationRunRow {
                    record_count: row.get(0)?,
                    total_bytes: row.get(1)?,
                    ready_project_count: row.get(2)?,
                    unreadable_project_count: row.get(3)?,
                    branch_count: row.get(4)?,
                })
            },
        )
        .optional()
}

fn gc_incomplete_legacy_snapshots(
    connection: &Connection,
    current_content_checksum: &str,
) -> Result<(), SqliteError> {
    connection.execute(
        "DELETE FROM legacy_migration_snapshots AS snapshot
         WHERE snapshot.content_checksum != ?1
           AND NOT EXISTS (
             SELECT 1 FROM legacy_migration_runs AS run
             WHERE run.content_checksum = snapshot.content_checksum
           )
           AND snapshot.content_checksum NOT IN (
             SELECT recent.content_checksum
             FROM legacy_migration_snapshots AS recent
             WHERE recent.content_checksum != ?1
               AND NOT EXISTS (
                 SELECT 1 FROM legacy_migration_runs AS run
                 WHERE run.content_checksum = recent.content_checksum
               )
             ORDER BY recent.backed_up_at DESC, recent.rowid DESC,
                      recent.content_checksum DESC
             LIMIT 2
           )",
        params![current_content_checksum],
    )?;
    Ok(())
}

fn require_valid_legacy_backup(
    connection: &Connection,
    content_checksum: &str,
    operation: RepositoryOperation,
) -> Result<ValidatedStoredLegacyBackup, PersistenceErrorDto> {
    let row = read_legacy_snapshot_row(connection, content_checksum)
        .map_err(|error| sqlite_error_for_operation(error, operation, None))?
        .ok_or_else(|| migration_failure(operation, RetryPolicy::Never))?;
    let records = read_legacy_snapshot_records(connection, content_checksum)
        .map_err(|error| sqlite_error_for_operation(error, operation, None))?;
    if row.storage_version != 1
        || row.record_count < 0
        || usize::try_from(row.record_count).ok() != Some(records.len())
        || row.total_bytes < 0
    {
        return Err(migration_failure(operation, RetryPolicy::Never));
    }

    let mut entries = Vec::with_capacity(records.len());
    for (expected_ordinal, record) in records.into_iter().enumerate() {
        let expected_ordinal = i64::try_from(expected_ordinal).unwrap_or(i64::MAX);
        if record.ordinal != expected_ordinal
            || record.value_bytes < 0
            || record.record_crc32
                != legacy_backup_record_crc32(
                    content_checksum,
                    record.ordinal,
                    &record.key,
                    &record.value,
                    record.value_bytes,
                    &record.source_checksum,
                )
        {
            return Err(migration_failure(operation, RetryPolicy::Never));
        }
        let key = String::from_utf8(record.key)
            .map_err(|_| migration_failure(operation, RetryPolicy::Never))?;
        let value = String::from_utf8(record.value)
            .map_err(|_| migration_failure(operation, RetryPolicy::Never))?;
        entries.push(LegacyStorageSnapshotRecordDto {
            key,
            value,
            value_bytes: u64::try_from(record.value_bytes)
                .map_err(|_| migration_failure(operation, RetryPolicy::Never))?,
            checksum: record.source_checksum,
        });
    }

    let snapshot = LegacyStorageSnapshotDto {
        storage_version: u64::try_from(row.storage_version)
            .map_err(|_| migration_failure(operation, RetryPolicy::Never))?,
        created_at: row.created_at.clone(),
        entries,
        total_bytes: u64::try_from(row.total_bytes)
            .map_err(|_| migration_failure(operation, RetryPolicy::Never))?,
        content_checksum: content_checksum.to_owned(),
        checksum: row.envelope_checksum.clone(),
    };
    validate_legacy_snapshot(&snapshot, operation)?;
    if row.backup_crc32
        != legacy_backup_crc32(
            content_checksum,
            snapshot.storage_version,
            &snapshot.created_at,
            snapshot.total_bytes,
            &snapshot.checksum,
            &snapshot.entries,
        )
    {
        return Err(migration_failure(operation, RetryPolicy::Never));
    }

    Ok(ValidatedStoredLegacyBackup {
        row,
        entries: snapshot.entries,
    })
}

fn update_framed_checksum(hasher: &mut crc32fast::Hasher, value: &[u8]) {
    hasher.update(&u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn finish_checksum(hasher: crc32fast::Hasher) -> String {
    format!("crc32:{:08x}", hasher.finalize())
}

fn legacy_backup_record_crc32(
    content_checksum: &str,
    ordinal: i64,
    key: &[u8],
    value: &[u8],
    value_bytes: i64,
    source_checksum: &str,
) -> String {
    let mut hasher = crc32fast::Hasher::new();
    update_framed_checksum(&mut hasher, b"cts-legacy-backup-record-v1");
    update_framed_checksum(&mut hasher, content_checksum.as_bytes());
    hasher.update(&ordinal.to_be_bytes());
    update_framed_checksum(&mut hasher, key);
    update_framed_checksum(&mut hasher, value);
    hasher.update(&value_bytes.to_be_bytes());
    update_framed_checksum(&mut hasher, source_checksum.as_bytes());
    finish_checksum(hasher)
}

fn legacy_backup_crc32(
    content_checksum: &str,
    storage_version: u64,
    created_at: &str,
    total_bytes: u64,
    envelope_checksum: &str,
    entries: &[LegacyStorageSnapshotRecordDto],
) -> String {
    let mut hasher = crc32fast::Hasher::new();
    update_framed_checksum(&mut hasher, b"cts-legacy-backup-v1");
    update_framed_checksum(&mut hasher, content_checksum.as_bytes());
    hasher.update(&storage_version.to_be_bytes());
    update_framed_checksum(&mut hasher, created_at.as_bytes());
    hasher.update(
        &u64::try_from(entries.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    hasher.update(&total_bytes.to_be_bytes());
    update_framed_checksum(&mut hasher, envelope_checksum.as_bytes());
    for (ordinal, entry) in entries.iter().enumerate() {
        hasher.update(&u64::try_from(ordinal).unwrap_or(u64::MAX).to_be_bytes());
        update_framed_checksum(&mut hasher, entry.key.as_bytes());
        update_framed_checksum(&mut hasher, entry.value.as_bytes());
        hasher.update(&entry.value_bytes.to_be_bytes());
        update_framed_checksum(&mut hasher, entry.checksum.as_bytes());
    }
    finish_checksum(hasher)
}

fn read_legacy_import(
    connection: &Connection,
    content_checksum: &str,
    migration_version: i64,
    project_id: &str,
    candidate_kind: &str,
    candidate_operation_id: &str,
) -> Result<Option<LegacyImportRow>, SqliteError> {
    connection
        .query_row(
            "SELECT project_id, source_keys_json, candidate_kind, candidate_operation_id,
                    payload_crc32, payload_bytes, payload_json, title, updated_at,
                    source, activation_id, revision, write_id, saved_at,
                    diagnostic_error_code
             FROM legacy_project_staging
             WHERE content_checksum = ?1 AND migration_version = ?2
               AND project_id = ?3 AND candidate_kind = ?4
               AND candidate_operation_id = ?5",
            params![
                content_checksum,
                migration_version,
                project_id,
                candidate_kind,
                candidate_operation_id,
            ],
            legacy_import_from_row,
        )
        .optional()
}

fn read_legacy_stages(
    connection: &Connection,
    content_checksum: &str,
    migration_version: i64,
) -> Result<Vec<LegacyImportRow>, SqliteError> {
    let mut statement = connection.prepare(
        "SELECT project_id, source_keys_json, candidate_kind, candidate_operation_id,
                payload_crc32, payload_bytes, payload_json, title, updated_at,
                source, activation_id, revision, write_id, saved_at,
                diagnostic_error_code
         FROM legacy_project_staging
         WHERE content_checksum = ?1 AND migration_version = ?2
         ORDER BY project_id ASC,
                  CASE candidate_kind WHEN 'head' THEN 0 WHEN 'branch' THEN 1 ELSE 2 END,
                  candidate_operation_id ASC",
    )?;
    let stages = statement
        .query_map(
            params![content_checksum, migration_version],
            legacy_import_from_row,
        )?
        .collect();
    stages
}

fn legacy_import_from_row(row: &Row<'_>) -> Result<LegacyImportRow, SqliteError> {
    let source_keys_json: Vec<u8> = row.get(1)?;
    let source_keys = serde_json::from_slice(&source_keys_json).map_err(|error| {
        SqliteError::FromSqlConversionFailure(1, rusqlite::types::Type::Blob, Box::new(error))
    })?;
    Ok(LegacyImportRow {
        project_id: row.get(0)?,
        source_keys,
        candidate_kind: row.get(2)?,
        candidate_operation_id: row.get(3)?,
        payload_crc32: row.get(4)?,
        payload_bytes: row.get(5)?,
        payload_json: row.get(6)?,
        title: row.get(7)?,
        updated_at: row.get(8)?,
        source: row.get(9)?,
        activation_id: row.get(10)?,
        revision: row.get(11)?,
        write_id: row.get(12)?,
        saved_at: row.get(13)?,
        diagnostic_error_code: row.get(14)?,
    })
}

fn validate_completed_legacy_run(
    connection: &Connection,
    content_checksum: &str,
    migration_version: i64,
    backup: &ValidatedStoredLegacyBackup,
    run: &LegacyMigrationRunRow,
) -> Result<(), PersistenceErrorDto> {
    if run.record_count != backup.row.record_count || run.total_bytes != backup.row.total_bytes {
        return Err(migration_failure(
            RepositoryOperation::List,
            RetryPolicy::Never,
        ));
    }
    let stages = read_legacy_stages(connection, content_checksum, migration_version)
        .map_err(|error| read_sql_error(error, RepositoryOperation::List, None))?;
    legacy_snapshot_coverage(&backup.entries, &stages)?;
    let count = |kind: &str| {
        i64::try_from(
            stages
                .iter()
                .filter(|stage| stage.candidate_kind == kind)
                .count(),
        )
        .unwrap_or(i64::MAX)
    };
    if (count("head"), count("diagnostic"), count("branch"))
        != (
            run.ready_project_count,
            run.unreadable_project_count,
            run.branch_count,
        )
        || stages.iter().any(|stage| {
            stage.candidate_kind == "head"
                && stages.iter().any(|candidate| {
                    candidate.project_id == stage.project_id
                        && candidate.candidate_kind == "diagnostic"
                })
        })
    {
        return Err(migration_failure(
            RepositoryOperation::List,
            RetryPolicy::Never,
        ));
    }
    for stage in &stages {
        validate_staged_legacy_provenance(&backup.entries, stage)?;
    }
    Ok(())
}

fn insert_legacy_generation(
    connection: &Connection,
    content_checksum: &str,
    migration_version: i64,
    canonical: &CanonicalProject,
    parent_head_version: Option<&str>,
    branch_source: Option<&str>,
) -> Result<GenerationRow, PersistenceErrorDto> {
    let operation_id = format!("legacy-import:v{migration_version}:{content_checksum}");
    let head_version = format!("sqlite:v1:legacy:v{migration_version}:{content_checksum}");
    let activation_id = operation_id.clone();
    let saved_at = database_now(connection)
        .map_err(|error| write_sql_error(error, Some(&canonical.project_id)))?;
    let payload_bytes = i64::try_from(canonical.json.len()).map_err(|_| {
        persistence_error(
            RepositoryOperation::Save,
            PersistenceErrorCode::TooLarge,
            RetryPolicy::Never,
            Some(&canonical.project_id),
        )
    })?;
    let digest = GenerationDigest {
        project_id: &canonical.project_id,
        kind: GenerationKind::Save.as_str(),
        operation_id: &operation_id,
        head_version: &head_version,
        parent_head_version,
        activation_id: Some(&activation_id),
        revision: Some(0),
        predecessor_write_id: None,
        saved_at: &saved_at,
        payload_crc32: Some(&canonical.payload_crc32),
        payload_bytes,
        title: Some(&canonical.title),
        updated_at: Some(&canonical.updated_at),
        branch_source,
    };
    let record_crc32 = digest_crc32(&digest);
    connection
        .execute(
            "INSERT INTO project_generations (
               project_id, kind, operation_id, head_version, parent_head_version,
               activation_id, revision, predecessor_write_id, saved_at, payload_json,
               payload_crc32, payload_bytes, title, updated_at, record_crc32, branch_source
             ) VALUES (?1, 'save', ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                canonical.project_id,
                operation_id,
                head_version,
                parent_head_version,
                activation_id,
                saved_at,
                canonical.json,
                canonical.payload_crc32,
                payload_bytes,
                canonical.title,
                canonical.updated_at,
                record_crc32,
                branch_source,
            ],
        )
        .map_err(|error| write_sql_error(error, Some(&canonical.project_id)))?;
    let sequence = connection.last_insert_rowid();
    read_generation_by_seq(connection, sequence)
        .map_err(|error| write_sql_error(error, Some(&canonical.project_id)))?
        .ok_or_else(|| {
            persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::WriteFailed,
                RetryPolicy::Automatic,
                Some(&canonical.project_id),
            )
        })
}

fn apply_legacy_stage(
    connection: &Connection,
    content_checksum: &str,
    migration_version: i64,
    stage: &LegacyImportRow,
) -> Result<(), PersistenceErrorDto> {
    match stage.candidate_kind.as_str() {
        "diagnostic" => {
            if stage.candidate_operation_id != "diagnostic"
                || stage
                    .diagnostic_error_code
                    .as_deref()
                    .and_then(parse_unreadable_error_code)
                    .is_none()
                || stage.payload_json.is_some()
            {
                return Err(migration_failure(
                    RepositoryOperation::Save,
                    RetryPolicy::Never,
                ));
            }
            Ok(())
        }
        "head" | "branch" => {
            let canonical = canonical_legacy_stage(stage)?;
            if matches!(
                resolve_project(connection, &stage.project_id)
                    .map_err(|error| { write_sql_error(error, Some(&stage.project_id)) })?,
                ProjectResolution::Deleted
            ) {
                return Ok(());
            }
            if stage.candidate_kind == "branch" {
                return apply_staged_legacy_branch(
                    connection,
                    content_checksum,
                    migration_version,
                    stage,
                    &canonical,
                );
            }
            if stage.candidate_operation_id != "legacy-head"
                || stage.source.is_some()
                || stage.activation_id.is_some()
                || stage.revision.is_some()
                || stage.write_id.is_some()
                || stage.saved_at.is_some()
            {
                return Err(migration_failure(
                    RepositoryOperation::Save,
                    RetryPolicy::Never,
                ));
            }
            match current_head_state(connection, &stage.project_id)
                .map_err(|error| write_sql_error(error, Some(&stage.project_id)))?
            {
                CurrentHeadState::Empty => {
                    let generation = insert_legacy_generation(
                        connection,
                        content_checksum,
                        migration_version,
                        &canonical,
                        None,
                        None,
                    )?;
                    let head_crc32 = head_crc32(
                        &stage.project_id,
                        generation.seq,
                        &generation.head_version,
                        false,
                    );
                    connection
                        .execute(
                            "INSERT INTO project_heads (
                               project_id, generation_seq, head_version, deleted, head_crc32
                             ) VALUES (?1, ?2, ?3, 0, ?4)
                             ON CONFLICT(project_id) DO UPDATE SET
                               generation_seq = excluded.generation_seq,
                               head_version = excluded.head_version,
                               deleted = excluded.deleted,
                               head_crc32 = excluded.head_crc32",
                            params![
                                stage.project_id,
                                generation.seq,
                                generation.head_version,
                                head_crc32,
                            ],
                        )
                        .map_err(|error| write_sql_error(error, Some(&stage.project_id)))?;
                    Ok(())
                }
                CurrentHeadState::Valid {
                    row,
                    value: ValidatedGeneration::Save { .. },
                    ..
                } if row.payload_json.as_deref() == Some(canonical.json.as_slice()) => Ok(()),
                CurrentHeadState::DeletedEvidence
                | CurrentHeadState::Valid {
                    value: ValidatedGeneration::Delete,
                    ..
                } => Ok(()),
                CurrentHeadState::Valid { head, .. } | CurrentHeadState::Unsupported(head) => {
                    insert_legacy_generation(
                        connection,
                        content_checksum,
                        migration_version,
                        &canonical,
                        Some(&head.head_version),
                        Some("legacy-migration"),
                    )?;
                    Ok(())
                }
                CurrentHeadState::UnsupportedEvidence | CurrentHeadState::DiagnosticEvidence(_) => {
                    insert_legacy_generation(
                        connection,
                        content_checksum,
                        migration_version,
                        &canonical,
                        None,
                        Some("legacy-migration"),
                    )?;
                    Ok(())
                }
                CurrentHeadState::Corrupt(head) => {
                    let parent_head_version = head.as_ref().map(|head| head.head_version.as_str());
                    insert_legacy_generation(
                        connection,
                        content_checksum,
                        migration_version,
                        &canonical,
                        parent_head_version,
                        Some("legacy-migration"),
                    )?;
                    Ok(())
                }
            }
        }
        _ => Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        )),
    }
}

fn apply_legacy_deleted_evidence(
    connection: &Connection,
    content_checksum: &str,
    migration_version: i64,
    evidence: &LegacyDeletedEvidence,
) -> Result<(), PersistenceErrorDto> {
    if !matches!(
        current_head_state(connection, &evidence.project_id)
            .map_err(|error| write_sql_error(error, Some(&evidence.project_id)))?,
        CurrentHeadState::Empty
    ) {
        return Ok(());
    }
    let operation_id = format!(
        "legacy-delete:v{migration_version}:{content_checksum}:{}",
        evidence.delete_id
    );
    let head_version = format!("sqlite:v1:{operation_id}");
    let digest = GenerationDigest {
        project_id: &evidence.project_id,
        kind: GenerationKind::Delete.as_str(),
        operation_id: &operation_id,
        head_version: &head_version,
        parent_head_version: None,
        activation_id: None,
        revision: None,
        predecessor_write_id: None,
        saved_at: &evidence.deleted_at,
        payload_crc32: None,
        payload_bytes: 0,
        title: None,
        updated_at: None,
        branch_source: None,
    };
    let record_crc32 = digest_crc32(&digest);
    connection
        .execute(
            "INSERT INTO project_generations (
               project_id, kind, operation_id, head_version, parent_head_version,
               activation_id, revision, predecessor_write_id, saved_at, payload_json,
               payload_crc32, payload_bytes, title, updated_at, record_crc32, branch_source
             ) VALUES (?1, 'delete', ?2, ?3, NULL, NULL, NULL, NULL, ?4,
                       NULL, NULL, 0, NULL, NULL, ?5, NULL)",
            params![
                evidence.project_id,
                operation_id,
                head_version,
                evidence.deleted_at,
                record_crc32,
            ],
        )
        .map_err(|error| write_sql_error(error, Some(&evidence.project_id)))?;
    let sequence = connection.last_insert_rowid();
    let head_crc32 = head_crc32(&evidence.project_id, sequence, &head_version, true);
    connection
        .execute(
            "INSERT INTO project_heads (
               project_id, generation_seq, head_version, deleted, head_crc32
             ) VALUES (?1, ?2, ?3, 1, ?4)",
            params![evidence.project_id, sequence, head_version, head_crc32],
        )
        .map_err(|error| write_sql_error(error, Some(&evidence.project_id)))?;
    Ok(())
}

fn validate_staged_legacy_provenance(
    entries: &[LegacyStorageSnapshotRecordDto],
    stage: &LegacyImportRow,
) -> Result<(), PersistenceErrorDto> {
    match stage.candidate_kind.as_str() {
        "diagnostic" => {
            validate_legacy_diagnostic_provenance(entries, &stage.project_id, &stage.source_keys)
                .and_then(|()| {
                    if stage.candidate_operation_id == "diagnostic"
                        && stage
                            .diagnostic_error_code
                            .as_deref()
                            .and_then(parse_unreadable_error_code)
                            .is_some()
                        && stage.payload_json.is_none()
                        && stage.source.is_none()
                        && stage.activation_id.is_none()
                        && stage.revision.is_none()
                        && stage.write_id.is_none()
                        && stage.saved_at.is_none()
                    {
                        Ok(())
                    } else {
                        Err(migration_failure(
                            RepositoryOperation::Save,
                            RetryPolicy::Never,
                        ))
                    }
                })
        }
        "head" => {
            canonical_legacy_stage(stage)?;
            let project_json = stage
                .payload_json
                .as_deref()
                .and_then(|value| std::str::from_utf8(value).ok())
                .ok_or_else(|| migration_failure(RepositoryOperation::Save, RetryPolicy::Never))?;
            validate_legacy_provenance(
                entries,
                &stage.project_id,
                &stage.source_keys,
                Some(project_json),
                None,
            )
        }
        "branch" => {
            canonical_legacy_stage(stage)?;
            let (Some(source), Some(activation_id), Some(revision), Some(write_id), Some(saved_at)) = (
                stage.source.as_deref().and_then(project_branch_source),
                stage.activation_id.clone(),
                stage.revision.and_then(|value| u64::try_from(value).ok()),
                stage.write_id.clone(),
                stage.saved_at.clone(),
            ) else {
                return Err(migration_failure(
                    RepositoryOperation::Save,
                    RetryPolicy::Never,
                ));
            };
            if !matches!(
                source,
                ProjectBranchSource::RecoveryJournal | ProjectBranchSource::InterruptedSave
            ) {
                return Err(migration_failure(
                    RepositoryOperation::Save,
                    RetryPolicy::Never,
                ));
            }
            let project_json = stage
                .payload_json
                .as_deref()
                .and_then(|value| std::str::from_utf8(value).ok())
                .ok_or_else(|| migration_failure(RepositoryOperation::Save, RetryPolicy::Never))?;
            let branch = LegacyBranchCandidateDto {
                source,
                activation_id,
                revision,
                write_id,
                saved_at,
            };
            validate_legacy_provenance(
                entries,
                &stage.project_id,
                &stage.source_keys,
                Some(project_json),
                Some(&branch),
            )
        }
        _ => Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        )),
    }
}

fn canonical_legacy_stage(
    stage: &LegacyImportRow,
) -> Result<CanonicalProject, PersistenceErrorDto> {
    let (
        Some(payload_crc32),
        Some(payload_bytes),
        Some(payload_json),
        Some(title),
        Some(updated_at),
    ) = (
        stage.payload_crc32.as_deref(),
        stage.payload_bytes,
        stage.payload_json.as_deref(),
        stage.title.as_deref(),
        stage.updated_at.as_deref(),
    )
    else {
        return Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        ));
    };
    let project_json = std::str::from_utf8(payload_json)
        .map_err(|_| migration_failure(RepositoryOperation::Save, RetryPolicy::Never))?;
    let canonical = canonical_project_json(
        project_json,
        RepositoryOperation::Save,
        Some(&stage.project_id),
    )?;
    if canonical.project_id != stage.project_id
        || canonical.payload_crc32 != payload_crc32
        || i64::try_from(canonical.json.len()).ok() != Some(payload_bytes)
        || canonical.title != title
        || canonical.updated_at != updated_at
    {
        return Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        ));
    }
    Ok(canonical)
}

fn apply_staged_legacy_branch(
    connection: &Connection,
    content_checksum: &str,
    migration_version: i64,
    stage: &LegacyImportRow,
    canonical: &CanonicalProject,
) -> Result<(), PersistenceErrorDto> {
    let (Some(source), Some(activation_id), Some(revision), Some(write_id), Some(saved_at)) = (
        stage.source.as_deref(),
        stage.activation_id.as_deref(),
        stage.revision,
        stage.write_id.as_deref(),
        stage.saved_at.as_deref(),
    ) else {
        return Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        ));
    };
    if stage.candidate_operation_id != write_id
        || !matches!(source, "recovery-journal" | "interrupted-save")
        || revision < 0
        || saved_at.is_empty()
    {
        return Err(migration_failure(
            RepositoryOperation::Save,
            RetryPolicy::Never,
        ));
    }
    match current_head_state(connection, &stage.project_id)
        .map_err(|error| write_sql_error(error, Some(&stage.project_id)))?
    {
        CurrentHeadState::DeletedEvidence
        | CurrentHeadState::Valid {
            value: ValidatedGeneration::Delete,
            ..
        } => return Ok(()),
        CurrentHeadState::Valid {
            row,
            value: ValidatedGeneration::Save { .. },
            ..
        } if row.payload_json.as_deref() == Some(canonical.json.as_slice()) => return Ok(()),
        _ => {}
    }
    if let Some(existing) = read_generation_by_operation(
        connection,
        &stage.project_id,
        GenerationKind::Save,
        write_id,
    )
    .map_err(|error| write_sql_error(error, Some(&stage.project_id)))?
    {
        let request_matches = existing.activation_id.as_deref() == Some(activation_id)
            && existing.revision == Some(revision)
            && existing.payload_json.as_deref() == Some(canonical.json.as_slice())
            && validate_generation(&existing).is_ok();
        if request_matches {
            let superseded_same_snapshot = legacy_generation_provenance(&existing.head_version)
                .is_some_and(|provenance| {
                    provenance.content_checksum == content_checksum
                        && provenance.migration_version < migration_version
                });
            if superseded_same_snapshot {
                connection
                    .execute(
                        "DELETE FROM project_generations WHERE seq = ?1",
                        params![existing.seq],
                    )
                    .map_err(|error| write_sql_error(error, Some(&stage.project_id)))?;
            } else {
                return Ok(());
            }
        } else {
            return Err(conflict(RepositoryOperation::Save, &stage.project_id));
        }
    }

    let parent_head_version = read_head_row(connection, &stage.project_id)
        .map_err(|error| write_sql_error(error, Some(&stage.project_id)))?
        .map(|head| head.head_version);
    let head_version =
        format!("sqlite:v1:legacy-branch:v{migration_version}:{content_checksum}:{write_id}");
    let payload_bytes = i64::try_from(canonical.json.len()).map_err(|_| {
        persistence_error(
            RepositoryOperation::Save,
            PersistenceErrorCode::TooLarge,
            RetryPolicy::Never,
            Some(&stage.project_id),
        )
    })?;
    let digest = GenerationDigest {
        project_id: &stage.project_id,
        kind: GenerationKind::Save.as_str(),
        operation_id: write_id,
        head_version: &head_version,
        parent_head_version: parent_head_version.as_deref(),
        activation_id: Some(activation_id),
        revision: Some(revision),
        predecessor_write_id: None,
        saved_at,
        payload_crc32: Some(&canonical.payload_crc32),
        payload_bytes,
        title: Some(&canonical.title),
        updated_at: Some(&canonical.updated_at),
        branch_source: Some(source),
    };
    let record_crc32 = digest_crc32(&digest);
    connection
        .execute(
            "INSERT INTO project_generations (
               project_id, kind, operation_id, head_version, parent_head_version,
               activation_id, revision, predecessor_write_id, saved_at, payload_json,
               payload_crc32, payload_bytes, title, updated_at, record_crc32, branch_source
             ) VALUES (?1, 'save', ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                stage.project_id,
                write_id,
                head_version,
                parent_head_version,
                activation_id,
                revision,
                saved_at,
                canonical.json,
                canonical.payload_crc32,
                payload_bytes,
                canonical.title,
                canonical.updated_at,
                record_crc32,
                source,
            ],
        )
        .map_err(|error| write_sql_error(error, Some(&stage.project_id)))?;
    Ok(())
}

fn project_branch_source(source: &str) -> Option<ProjectBranchSource> {
    match source {
        "recovery-journal" => Some(ProjectBranchSource::RecoveryJournal),
        "interrupted-save" => Some(ProjectBranchSource::InterruptedSave),
        "legacy-migration" => Some(ProjectBranchSource::LegacyMigration),
        _ => None,
    }
}

fn branch_source_name(source: ProjectBranchSource) -> &'static str {
    match source {
        ProjectBranchSource::RecoveryJournal => "recovery-journal",
        ProjectBranchSource::InterruptedSave => "interrupted-save",
        ProjectBranchSource::LegacyMigration => "legacy-migration",
    }
}

fn unreadable_error_code_name(error_code: UnreadableProjectErrorCode) -> &'static str {
    match error_code {
        UnreadableProjectErrorCode::CorruptData => "corrupt-data",
        UnreadableProjectErrorCode::UnsupportedVersion => "unsupported-version",
        UnreadableProjectErrorCode::MigrationFailed => "migration-failed",
        UnreadableProjectErrorCode::Conflict => "conflict",
    }
}

fn parse_unreadable_error_code(value: &str) -> Option<UnreadableProjectErrorCode> {
    match value {
        "corrupt-data" => Some(UnreadableProjectErrorCode::CorruptData),
        "unsupported-version" => Some(UnreadableProjectErrorCode::UnsupportedVersion),
        "migration-failed" => Some(UnreadableProjectErrorCode::MigrationFailed),
        "conflict" => Some(UnreadableProjectErrorCode::Conflict),
        _ => None,
    }
}

fn legacy_generation_provenance(head_version: &str) -> Option<LegacyGenerationProvenance> {
    const CANONICAL_PREFIX: &str = "sqlite:v1:legacy:v";
    const BRANCH_PREFIX: &str = "sqlite:v1:legacy-branch:v";
    const DELETE_PREFIX: &str = "sqlite:v1:legacy-delete:v";

    let (remainder, requires_operation_suffix) =
        if let Some(remainder) = head_version.strip_prefix(BRANCH_PREFIX) {
            (remainder, true)
        } else if let Some(remainder) = head_version.strip_prefix(DELETE_PREFIX) {
            (remainder, true)
        } else {
            (head_version.strip_prefix(CANONICAL_PREFIX)?, false)
        };
    let (version, remainder) = remainder.split_once(':')?;
    if version.is_empty() || !version.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let migration_version = version.parse::<i64>().ok().filter(|value| *value >= 1)?;
    let checksum = remainder.get(..14)?;
    let checksum_bytes = checksum.as_bytes();
    if checksum_bytes.len() != 14
        || !checksum_bytes.starts_with(b"crc32:")
        || !checksum_bytes[6..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        || if requires_operation_suffix {
            remainder.as_bytes().get(14) != Some(&b':') || remainder.len() == 15
        } else {
            remainder.len() != 14
        }
    {
        return None;
    }
    Some(LegacyGenerationProvenance {
        content_checksum: checksum.to_owned(),
        migration_version,
    })
}

fn highest_completed_legacy_project_version(
    connection: &Connection,
    content_checksum: &str,
    project_id: &str,
) -> Result<Option<i64>, SqliteError> {
    connection.query_row(
        "SELECT MAX(staging.migration_version)
         FROM legacy_project_staging AS staging
         INNER JOIN legacy_migration_runs AS run
           ON run.content_checksum = staging.content_checksum
          AND run.migration_version = staging.migration_version
         WHERE staging.content_checksum = ?1
           AND staging.project_id = ?2",
        params![content_checksum, project_id],
        |row| row.get(0),
    )
}

fn legacy_generation_is_live(
    connection: &Connection,
    generation: &GenerationRow,
) -> Result<bool, SqliteError> {
    let Some(provenance) = legacy_generation_provenance(&generation.head_version) else {
        return Ok(true);
    };
    Ok(highest_completed_legacy_project_version(
        connection,
        &provenance.content_checksum,
        &generation.project_id,
    )?
    .is_none_or(|version| version == provenance.migration_version))
}

fn legacy_head_is_live(connection: &Connection, head: &HeadRow) -> Result<bool, SqliteError> {
    let Some(provenance) = legacy_generation_provenance(&head.head_version) else {
        return Ok(true);
    };
    Ok(highest_completed_legacy_project_version(
        connection,
        &provenance.content_checksum,
        &head.project_id,
    )?
    .is_none_or(|version| version == provenance.migration_version))
}

fn completed_legacy_diagnostic(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<UnreadableProjectErrorCode>, SqliteError> {
    let mut statement = connection.prepare(
        "SELECT staging.diagnostic_error_code
         FROM legacy_project_staging AS staging
         INNER JOIN legacy_migration_runs AS run
           ON run.content_checksum = staging.content_checksum
          AND run.migration_version = staging.migration_version
         WHERE staging.project_id = ?1
           AND staging.candidate_kind = 'diagnostic'
           AND staging.migration_version = (
             SELECT MAX(candidate.migration_version)
             FROM legacy_project_staging AS candidate
             INNER JOIN legacy_migration_runs AS candidate_run
               ON candidate_run.content_checksum = candidate.content_checksum
              AND candidate_run.migration_version = candidate.migration_version
             WHERE candidate.content_checksum = staging.content_checksum
               AND candidate.project_id = staging.project_id
           )
         ORDER BY run.completed_at DESC, staging.content_checksum DESC",
    )?;
    let values = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut latest_nonsticky = None;
    let mut saw_migration_failure = false;
    for value in values {
        match parse_unreadable_error_code(&value) {
            Some(UnreadableProjectErrorCode::UnsupportedVersion) => {
                return Ok(Some(UnreadableProjectErrorCode::UnsupportedVersion));
            }
            Some(UnreadableProjectErrorCode::MigrationFailed) => {
                saw_migration_failure = true;
            }
            Some(error_code) => {
                latest_nonsticky.get_or_insert(error_code);
            }
            None => continue,
        };
    }
    Ok(if saw_migration_failure {
        Some(UnreadableProjectErrorCode::MigrationFailed)
    } else {
        latest_nonsticky
    })
}

fn sticky_completed_legacy_diagnostic(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<UnreadableProjectErrorCode>, SqliteError> {
    Ok(
        completed_legacy_diagnostic(connection, project_id)?.filter(|error_code| {
            matches!(
                error_code,
                UnreadableProjectErrorCode::UnsupportedVersion
                    | UnreadableProjectErrorCode::MigrationFailed
            )
        }),
    )
}

fn branch_summaries(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ProjectBranchSummaryDto>, SqliteError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {GENERATION_COLUMNS}
         FROM project_generations AS generation
         WHERE generation.project_id = ?1
           AND generation.branch_source IS NOT NULL
         ORDER BY generation.seq DESC"
    ))?;
    let generations = statement
        .query_map(params![project_id], generation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut summaries = Vec::with_capacity(generations.len());
    for generation in generations {
        if !legacy_generation_is_live(connection, &generation)? {
            continue;
        }
        if !matches!(
            validate_generation(&generation),
            Ok(ValidatedGeneration::Save { .. })
        ) {
            continue;
        }
        let Some(source) = generation
            .branch_source
            .as_deref()
            .and_then(project_branch_source)
        else {
            continue;
        };
        let (Some(activation_id), Some(revision), Some(title), Some(updated_at)) = (
            generation.activation_id,
            generation
                .revision
                .and_then(|value| u64::try_from(value).ok()),
            generation.title,
            generation.updated_at,
        ) else {
            continue;
        };
        summaries.push(ProjectBranchSummaryDto {
            branch_id: format!("sqlite-generation:{}", generation.seq),
            source,
            activation_id,
            revision,
            write_id: generation.operation_id,
            saved_at: generation.saved_at,
            title,
            updated_at,
        });
    }
    Ok(summaries)
}

fn replay_crash_drafts(connection: &mut Connection) -> Result<(), PersistenceErrorDto> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(initialize_sql_error)?;
    let (draft_count, _) =
        preflight_crash_draft_storage(&transaction, RepositoryOperation::Initialize, None)?;
    let drafts = all_crash_drafts(&transaction).map_err(initialize_sql_error)?;
    if i64::try_from(drafts.len()).ok() != Some(draft_count) {
        return Err(persistence_error(
            RepositoryOperation::Initialize,
            PersistenceErrorCode::CorruptData,
            RetryPolicy::Never,
            None,
        ));
    }

    let mut by_project = HashMap::<String, Vec<CrashDraftRow>>::new();
    for draft in drafts {
        if !valid_identifier(&draft.project_id, MAX_ID_BYTES) {
            return Err(persistence_error(
                RepositoryOperation::Initialize,
                PersistenceErrorCode::CorruptData,
                RetryPolicy::Never,
                None,
            ));
        }
        by_project
            .entry(draft.project_id.clone())
            .or_default()
            .push(draft);
    }
    let mut project_ids = by_project.keys().cloned().collect::<Vec<_>>();
    project_ids.sort();

    for project_id in project_ids {
        let mut project_drafts = by_project.remove(&project_id).unwrap_or_default();
        let state = current_head_state(&transaction, &project_id)
            .map_err(|error| initialize_project_sql_error(error, &project_id))?;
        if matches!(state, CurrentHeadState::DeletedEvidence) {
            remove_crash_drafts(&transaction, &project_id)
                .map_err(|error| initialize_project_sql_error(error, &project_id))?;
            continue;
        }

        for draft in &project_drafts {
            validate_crash_draft(draft).map_err(|issue| {
                crash_draft_issue_error(issue, RepositoryOperation::Initialize, &project_id)
            })?;
        }

        let mut unresolved = Vec::with_capacity(project_drafts.len());
        for draft in project_drafts.drain(..) {
            if let Some(generation) = read_generation_by_operation(
                &transaction,
                &project_id,
                GenerationKind::Save,
                &draft.write_id,
            )
            .map_err(|error| initialize_project_sql_error(error, &project_id))?
            {
                if canonical_generation_matches_crash_draft(&generation, &draft) {
                    delete_exact_crash_draft(&transaction, &draft)?;
                    continue;
                }
                return Err(conflict(RepositoryOperation::Initialize, &project_id));
            }
            if latest_canonical_generation_for_activation(
                &transaction,
                &project_id,
                &draft.activation_id,
            )
            .map_err(|error| initialize_project_sql_error(error, &project_id))?
            .and_then(|generation| generation.revision)
            .is_some_and(|revision| revision > draft.revision)
            {
                delete_exact_crash_draft(&transaction, &draft)?;
                continue;
            }
            unresolved.push(draft);
        }

        if unresolved.len() != 1 {
            for draft in unresolved {
                materialize_crash_draft_branch(&transaction, &draft)?;
            }
            continue;
        }

        let draft = unresolved.pop().expect("one unresolved crash draft");
        let expected = expected_head_for_crash_draft(&draft);
        let parent_head_version = check_expected_head(
            &transaction,
            &project_id,
            &expected,
            RepositoryOperation::Initialize,
            draft
                .predecessor_write_id
                .as_deref()
                .map(|write_id| PredecessorExpectation {
                    write_id,
                    activation_id: &draft.activation_id,
                    revision: draft.revision,
                }),
        );
        match parent_head_version {
            Ok(parent_head_version) => {
                promote_crash_draft(&transaction, &draft, parent_head_version.as_deref())?;
            }
            Err(error) if error.code == PersistenceErrorCode::Conflict => {
                materialize_crash_draft_branch(&transaction, &draft)?;
            }
            Err(error) => return Err(error),
        }
    }

    transaction.commit().map_err(initialize_sql_error)?;
    Ok(())
}

fn expected_head_for_crash_draft(draft: &CrashDraftRow) -> ExpectedHeadDto {
    if !draft.base_head_known {
        ExpectedHeadDto::Repair
    } else if let Some(version) = &draft.base_head_version {
        ExpectedHeadDto::Match {
            version: version.clone(),
        }
    } else {
        ExpectedHeadDto::Empty
    }
}

fn canonical_generation_matches_crash_draft(
    generation: &GenerationRow,
    draft: &CrashDraftRow,
) -> bool {
    generation.branch_source.is_none()
        && generation.project_id == draft.project_id
        && generation.operation_id == draft.write_id
        && generation.activation_id.as_deref() == Some(draft.activation_id.as_str())
        && generation.revision == Some(draft.revision)
        && generation.payload_crc32.as_deref() == Some(draft.payload_crc32.as_str())
        && generation.payload_json.as_deref() == Some(draft.payload_json.as_slice())
        && matches!(
            validate_generation(generation),
            Ok(ValidatedGeneration::Save { .. })
        )
}

fn delete_exact_crash_draft(
    connection: &Connection,
    draft: &CrashDraftRow,
) -> Result<(), PersistenceErrorDto> {
    let changed = connection
        .execute(
            "DELETE FROM project_crash_drafts
             WHERE project_id = ?1
               AND activation_id = ?2
               AND revision = ?3
               AND write_id = ?4
               AND payload_crc32 = ?5
               AND payload_bytes = ?6
               AND record_crc32 = ?7",
            params![
                draft.project_id,
                draft.activation_id,
                draft.revision,
                draft.write_id,
                draft.payload_crc32,
                draft.payload_bytes,
                draft.record_crc32,
            ],
        )
        .map_err(|error| initialize_project_sql_error(error, &draft.project_id))?;
    if changed != 1 {
        return Err(conflict(RepositoryOperation::Initialize, &draft.project_id));
    }
    Ok(())
}

fn insert_generation_from_crash_draft(
    connection: &Connection,
    draft: &CrashDraftRow,
    head_version: &str,
    parent_head_version: Option<&str>,
    branch_source: Option<&str>,
) -> Result<GenerationRow, PersistenceErrorDto> {
    let digest = GenerationDigest {
        project_id: &draft.project_id,
        kind: GenerationKind::Save.as_str(),
        operation_id: &draft.write_id,
        head_version,
        parent_head_version,
        activation_id: Some(&draft.activation_id),
        revision: Some(draft.revision),
        predecessor_write_id: draft.predecessor_write_id.as_deref(),
        saved_at: &draft.saved_at,
        payload_crc32: Some(&draft.payload_crc32),
        payload_bytes: draft.payload_bytes,
        title: Some(&draft.title),
        updated_at: Some(&draft.updated_at),
        branch_source,
    };
    let record_crc32 = digest_crc32(&digest);
    connection
        .execute(
            "INSERT INTO project_generations (
               project_id, kind, operation_id, head_version, parent_head_version,
               activation_id, revision, predecessor_write_id, saved_at, payload_json,
               payload_crc32, payload_bytes, title, updated_at, record_crc32, branch_source
             ) VALUES (?1, 'save', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                draft.project_id,
                draft.write_id,
                head_version,
                parent_head_version,
                draft.activation_id,
                draft.revision,
                draft.predecessor_write_id,
                draft.saved_at,
                draft.payload_json,
                draft.payload_crc32,
                draft.payload_bytes,
                draft.title,
                draft.updated_at,
                record_crc32,
                branch_source,
            ],
        )
        .map_err(|error| initialize_project_sql_error(error, &draft.project_id))?;
    let sequence = connection.last_insert_rowid();
    read_generation_by_seq(connection, sequence)
        .map_err(|error| initialize_project_sql_error(error, &draft.project_id))?
        .ok_or_else(|| {
            persistence_error(
                RepositoryOperation::Initialize,
                PersistenceErrorCode::WriteFailed,
                RetryPolicy::Automatic,
                Some(&draft.project_id),
            )
        })
}

fn promote_crash_draft(
    connection: &Connection,
    draft: &CrashDraftRow,
    parent_head_version: Option<&str>,
) -> Result<(), PersistenceErrorDto> {
    let head_version = format!("sqlite:v1:interrupted-save:{}", draft.write_id);
    let generation = insert_generation_from_crash_draft(
        connection,
        draft,
        &head_version,
        parent_head_version,
        None,
    )?;
    let head_crc32 = head_crc32(&draft.project_id, generation.seq, &head_version, false);
    connection
        .execute(
            "INSERT INTO project_heads (
               project_id, generation_seq, head_version, deleted, head_crc32
             ) VALUES (?1, ?2, ?3, 0, ?4)
             ON CONFLICT(project_id) DO UPDATE SET
               generation_seq = excluded.generation_seq,
               head_version = excluded.head_version,
               deleted = excluded.deleted,
               head_crc32 = excluded.head_crc32",
            params![draft.project_id, generation.seq, head_version, head_crc32],
        )
        .map_err(|error| initialize_project_sql_error(error, &draft.project_id))?;
    prune_generations(connection, &draft.project_id)
        .map_err(|error| initialize_project_sql_error(error, &draft.project_id))?;
    delete_exact_crash_draft(connection, draft)
}

fn materialize_crash_draft_branch(
    connection: &Connection,
    draft: &CrashDraftRow,
) -> Result<(), PersistenceErrorDto> {
    let head_version = format!("sqlite:v1:interrupted-branch:{}", draft.write_id);
    insert_generation_from_crash_draft(
        connection,
        draft,
        &head_version,
        draft
            .base_head_known
            .then_some(draft.base_head_version.as_deref())
            .flatten(),
        Some("interrupted-save"),
    )?;
    delete_exact_crash_draft(connection, draft)
}

fn initialize_project_sql_error(error: SqliteError, project_id: &str) -> PersistenceErrorDto {
    sqlite_error_to_persistence(
        error,
        RepositoryOperation::Initialize,
        Some(project_id),
        PersistenceErrorCode::WriteFailed,
    )
}

fn configure_and_migrate(connection: &mut Connection) -> Result<(), PersistenceErrorDto> {
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(initialize_sql_error)?;
    let locking_mode: String = connection
        .pragma_update_and_check(None, "locking_mode", "EXCLUSIVE", |row| row.get(0))
        .map_err(initialize_sql_error)?;
    if !locking_mode.eq_ignore_ascii_case("exclusive") {
        return Err(database_boundary_error());
    }
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .map_err(initialize_sql_error)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(initialize_sql_error)?;
    connection
        .pragma_update(None, "trusted_schema", false)
        .map_err(initialize_sql_error)?;

    let mut user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(initialize_sql_error)?;
    if user_version > DATABASE_SCHEMA_VERSION {
        return Err(persistence_error(
            RepositoryOperation::Initialize,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            None,
        ));
    }
    let application_id: i64 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(initialize_sql_error)?;
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(persistence_error(
            RepositoryOperation::Initialize,
            PersistenceErrorCode::MigrationFailed,
            RetryPolicy::Never,
            None,
        ));
    }
    let user_schema_objects: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type IN ('table', 'index', 'trigger', 'view')
               AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
            [],
            |row| row.get(0),
        )
        .map_err(initialize_sql_error)?;
    if (user_version == 0 && user_schema_objects != 0)
        || (user_version > 0 && application_id != APPLICATION_ID)
    {
        return Err(persistence_error(
            RepositoryOperation::Initialize,
            PersistenceErrorCode::MigrationFailed,
            RetryPolicy::Never,
            None,
        ));
    }
    if user_version > 0 {
        ensure_supported_legacy_migration_versions(
            connection,
            RepositoryOperation::Initialize,
            None,
        )?;
    }

    let journal_mode: String = connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .map_err(initialize_sql_error)?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(persistence_error(
            RepositoryOperation::Initialize,
            PersistenceErrorCode::StorageUnavailable,
            RetryPolicy::Manual,
            None,
        ));
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(initialize_sql_error)?;
    connection
        .pragma_update(None, "wal_autocheckpoint", 1_000_i64)
        .map_err(initialize_sql_error)?;

    if user_version == 0 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(initialize_sql_error)?;
        transaction
            .execute_batch(MIGRATION_V1)
            .map_err(migration_sql_error)?;
        transaction
            .pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(migration_sql_error)?;
        transaction
            .pragma_update(None, "user_version", 1_i64)
            .map_err(migration_sql_error)?;
        transaction.commit().map_err(migration_sql_error)?;
        user_version = 1;
    }

    if user_version == 1 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(initialize_sql_error)?;
        transaction
            .execute_batch(MIGRATION_V2)
            .map_err(migration_sql_error)?;
        transaction
            .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
            .map_err(migration_sql_error)?;
        transaction.commit().map_err(migration_sql_error)?;
        user_version = DATABASE_SCHEMA_VERSION;
    }

    if user_version != DATABASE_SCHEMA_VERSION {
        return Err(persistence_error(
            RepositoryOperation::Initialize,
            PersistenceErrorCode::MigrationFailed,
            RetryPolicy::Never,
            None,
        ));
    }

    let foreign_keys: i64 = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(initialize_sql_error)?;
    let synchronous: i64 = connection
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(initialize_sql_error)?;
    if foreign_keys != 1 || synchronous != 2 {
        return Err(persistence_error(
            RepositoryOperation::Initialize,
            PersistenceErrorCode::StorageUnavailable,
            RetryPolicy::Manual,
            None,
        ));
    }
    let quick_check: String = connection
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(initialize_sql_error)?;
    let foreign_key_violation = connection
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut statement| statement.exists([]))
        .map_err(initialize_sql_error)?;
    if quick_check != "ok" || foreign_key_violation {
        return Err(persistence_error(
            RepositoryOperation::Initialize,
            PersistenceErrorCode::CorruptData,
            RetryPolicy::Never,
            None,
        ));
    }
    Ok(())
}

fn ensure_supported_legacy_migration_versions(
    connection: &Connection,
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> Result<(), PersistenceErrorDto> {
    let max_version = connection
        .query_row(
            "SELECT MAX(migration_version)
             FROM (
               SELECT migration_version FROM legacy_migration_runs
               UNION ALL
               SELECT migration_version FROM legacy_project_staging
             )",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|error| sqlite_error_for_operation(error, operation, project_id))?;
    if max_version.is_some_and(|version| {
        version > i64::try_from(LEGACY_MIGRATION_VERSION).unwrap_or(i64::MAX)
    }) {
        return Err(persistence_error(
            operation,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            project_id,
        ));
    }
    Ok(())
}

fn loaded_project_result(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<LoadedProjectDto>, PersistenceErrorDto> {
    match resolve_project(connection, project_id)
        .map_err(|error| read_sql_error(error, RepositoryOperation::Load, Some(project_id)))?
    {
        ProjectResolution::Active(active) => Ok(Some(LoadedProjectDto {
            project_json: serde_json::to_string(&active.project).map_err(|_| {
                persistence_error(
                    RepositoryOperation::Load,
                    PersistenceErrorCode::SerializationFailed,
                    RetryPolicy::Never,
                    Some(project_id),
                )
            })?,
            head_version: active.head_version,
            source: ProjectSource::Generation,
            recovered: active.recovered,
            recovery_reason: active.recovery_reason,
        })),
        ProjectResolution::Deleted | ProjectResolution::Missing => Ok(None),
        ProjectResolution::Unreadable(error_code) => {
            let code = match error_code {
                UnreadableProjectErrorCode::CorruptData => PersistenceErrorCode::CorruptData,
                UnreadableProjectErrorCode::UnsupportedVersion => {
                    PersistenceErrorCode::UnsupportedVersion
                }
                UnreadableProjectErrorCode::MigrationFailed => {
                    PersistenceErrorCode::MigrationFailed
                }
                UnreadableProjectErrorCode::Conflict => PersistenceErrorCode::Conflict,
            };
            Err(persistence_error(
                RepositoryOperation::Load,
                code,
                RetryPolicy::Never,
                Some(project_id),
            ))
        }
    }
}

fn resolve_project(
    connection: &Connection,
    project_id: &str,
) -> Result<ProjectResolution, SqliteError> {
    let head = read_head_row(connection, project_id)?;
    let head = match head {
        Some(head) if legacy_head_is_live(connection, &head)? => Some(head),
        Some(_) | None => None,
    };
    if head.as_ref().is_some_and(|head| {
        head.deleted
            && head.head_crc32
                == head_crc32(
                    &head.project_id,
                    head.generation_seq,
                    &head.head_version,
                    head.deleted,
                )
    }) {
        return Ok(ProjectResolution::Deleted);
    }
    if has_unsupported_generation_evidence(connection, project_id)? {
        return Ok(ProjectResolution::Unreadable(
            UnreadableProjectErrorCode::UnsupportedVersion,
        ));
    }
    if let Some(error_code) = sticky_completed_legacy_diagnostic(connection, project_id)? {
        return Ok(ProjectResolution::Unreadable(error_code));
    }
    if let Some(head) = head {
        if head.head_crc32
            != head_crc32(
                &head.project_id,
                head.generation_seq,
                &head.head_version,
                head.deleted,
            )
        {
            return recover_generation(
                connection,
                project_id,
                None,
                ProjectRecoveryReason::HeadCorrupt,
            );
        }
        if head.deleted {
            return Ok(ProjectResolution::Deleted);
        }
        let Some(generation) = read_generation_by_seq(connection, head.generation_seq)? else {
            return recover_generation(
                connection,
                project_id,
                Some(head.generation_seq),
                ProjectRecoveryReason::GenerationCorrupt,
            );
        };
        if generation.project_id != project_id
            || generation.head_version != head.head_version
            || generation.branch_source.is_some()
            || (GenerationKind::parse(&generation.kind) == Some(GenerationKind::Delete))
                != head.deleted
        {
            return recover_generation(
                connection,
                project_id,
                Some(head.generation_seq),
                ProjectRecoveryReason::GenerationCorrupt,
            );
        }
        return match validate_generation(&generation) {
            Ok(ValidatedGeneration::Save { project }) => {
                let interrupted = head.head_version.starts_with("sqlite:v1:interrupted-save:");
                Ok(ProjectResolution::Active(Box::new(ResolvedActive {
                    generation,
                    project,
                    head_version: Some(head.head_version),
                    recovered: interrupted,
                    recovery_reason: interrupted.then_some(ProjectRecoveryReason::InterruptedSave),
                })))
            }
            Ok(ValidatedGeneration::Delete) => Ok(ProjectResolution::Deleted),
            Err(GenerationIssue::Unsupported) => Ok(ProjectResolution::Unreadable(
                UnreadableProjectErrorCode::UnsupportedVersion,
            )),
            Err(GenerationIssue::Corrupt) => recover_generation(
                connection,
                project_id,
                Some(head.generation_seq),
                ProjectRecoveryReason::GenerationCorrupt,
            ),
        };
    }

    let has_canonical_generations = canonical_generation_count(connection, project_id)? > 0;
    if !has_canonical_generations {
        if let Some(error_code) = completed_legacy_diagnostic(connection, project_id)? {
            return Ok(ProjectResolution::Unreadable(error_code));
        }
        return Ok(ProjectResolution::Missing);
    }
    recover_generation(
        connection,
        project_id,
        None,
        ProjectRecoveryReason::HeadMissing,
    )
}

fn recover_generation(
    connection: &Connection,
    project_id: &str,
    excluded_sequence: Option<i64>,
    reason: ProjectRecoveryReason,
) -> Result<ProjectResolution, SqliteError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {GENERATION_COLUMNS}
         FROM project_generations
         WHERE project_id = ?1 AND branch_source IS NULL
         ORDER BY seq DESC"
    ))?;
    let candidates = statement
        .query_map(params![project_id], generation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    for generation in candidates {
        if !legacy_generation_is_live(connection, &generation)? {
            continue;
        }
        if Some(generation.seq) == excluded_sequence {
            if validate_generation(&generation) == Ok(ValidatedGeneration::Delete) {
                return Ok(ProjectResolution::Deleted);
            }
            continue;
        }
        match validate_generation(&generation) {
            Ok(ValidatedGeneration::Save { project }) => {
                return Ok(ProjectResolution::Active(Box::new(ResolvedActive {
                    generation,
                    project,
                    head_version: None,
                    recovered: true,
                    recovery_reason: Some(reason),
                })));
            }
            Ok(ValidatedGeneration::Delete) => return Ok(ProjectResolution::Deleted),
            Err(GenerationIssue::Corrupt) => {}
            Err(GenerationIssue::Unsupported) => {
                return Ok(ProjectResolution::Unreadable(
                    UnreadableProjectErrorCode::UnsupportedVersion,
                ));
            }
        }
    }
    Ok(ProjectResolution::Unreadable(
        UnreadableProjectErrorCode::CorruptData,
    ))
}

fn current_head_state(
    connection: &Connection,
    project_id: &str,
) -> Result<CurrentHeadState, SqliteError> {
    let head = read_head_row(connection, project_id)?;
    let head = match head {
        Some(head) if legacy_head_is_live(connection, &head)? => Some(head),
        Some(_) | None => None,
    };
    if head.as_ref().is_some_and(|head| {
        head.deleted
            && head.head_crc32
                == head_crc32(
                    &head.project_id,
                    head.generation_seq,
                    &head.head_version,
                    head.deleted,
                )
    }) {
        return Ok(CurrentHeadState::DeletedEvidence);
    }
    if has_unsupported_generation_evidence(connection, project_id)? {
        return Ok(CurrentHeadState::UnsupportedEvidence);
    }
    if let Some(error_code) = sticky_completed_legacy_diagnostic(connection, project_id)? {
        return Ok(CurrentHeadState::DiagnosticEvidence(error_code));
    }
    let Some(head) = head else {
        return if canonical_generation_count(connection, project_id)? == 0 {
            Ok(completed_legacy_diagnostic(connection, project_id)?.map_or(
                CurrentHeadState::Empty,
                CurrentHeadState::DiagnosticEvidence,
            ))
        } else {
            recovered_current_head_state(connection, project_id, None)
        };
    };
    if head.head_crc32
        != head_crc32(
            &head.project_id,
            head.generation_seq,
            &head.head_version,
            head.deleted,
        )
    {
        return recovered_current_head_state(connection, project_id, Some(head));
    }
    if head.deleted {
        return Ok(CurrentHeadState::DeletedEvidence);
    }
    let Some(generation) = read_generation_by_seq(connection, head.generation_seq)? else {
        return recovered_current_head_state(connection, project_id, Some(head));
    };
    if generation.project_id != project_id
        || generation.head_version != head.head_version
        || generation.branch_source.is_some()
        || (GenerationKind::parse(&generation.kind) == Some(GenerationKind::Delete)) != head.deleted
    {
        return recovered_current_head_state(connection, project_id, Some(head));
    }
    match validate_generation(&generation) {
        Ok(value) => Ok(CurrentHeadState::Valid {
            head,
            row: Box::new(generation),
            value,
        }),
        Err(GenerationIssue::Corrupt) => {
            recovered_current_head_state(connection, project_id, Some(head))
        }
        Err(GenerationIssue::Unsupported) => Ok(CurrentHeadState::Unsupported(head)),
    }
}

fn recovered_current_head_state(
    connection: &Connection,
    project_id: &str,
    head: Option<HeadRow>,
) -> Result<CurrentHeadState, SqliteError> {
    Ok(
        match latest_canonical_generation_evidence(connection, project_id)? {
            CanonicalGenerationEvidence::Delete => CurrentHeadState::DeletedEvidence,
            CanonicalGenerationEvidence::Unsupported => CurrentHeadState::UnsupportedEvidence,
            CanonicalGenerationEvidence::None | CanonicalGenerationEvidence::Save => {
                CurrentHeadState::Corrupt(head)
            }
        },
    )
}

fn latest_canonical_generation_evidence(
    connection: &Connection,
    project_id: &str,
) -> Result<CanonicalGenerationEvidence, SqliteError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {GENERATION_COLUMNS}
         FROM project_generations
         WHERE project_id = ?1 AND branch_source IS NULL
         ORDER BY seq DESC"
    ))?;
    let generations = statement
        .query_map(params![project_id], generation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut latest_valid = CanonicalGenerationEvidence::None;
    for generation in generations {
        if !legacy_generation_is_live(connection, &generation)? {
            continue;
        }
        match validate_generation(&generation) {
            Ok(ValidatedGeneration::Delete)
                if latest_valid == CanonicalGenerationEvidence::None =>
            {
                latest_valid = CanonicalGenerationEvidence::Delete;
            }
            Ok(ValidatedGeneration::Save { .. })
                if latest_valid == CanonicalGenerationEvidence::None =>
            {
                latest_valid = CanonicalGenerationEvidence::Save;
            }
            Err(GenerationIssue::Unsupported) => {
                return Ok(CanonicalGenerationEvidence::Unsupported);
            }
            Ok(ValidatedGeneration::Save { .. } | ValidatedGeneration::Delete)
            | Err(GenerationIssue::Corrupt) => {}
        }
    }
    Ok(latest_valid)
}

fn has_unsupported_generation_evidence(
    connection: &Connection,
    project_id: &str,
) -> Result<bool, SqliteError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {GENERATION_COLUMNS}
         FROM project_generations
         WHERE project_id = ?1
         ORDER BY seq DESC"
    ))?;
    let generations = statement
        .query_map(params![project_id], generation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    for generation in generations {
        if !legacy_generation_is_live(connection, &generation)? {
            continue;
        }
        if validate_generation(&generation) == Err(GenerationIssue::Unsupported) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_expected_head(
    expected: &ExpectedHeadDto,
    project_id: &str,
) -> Result<(), PersistenceErrorDto> {
    if let ExpectedHeadDto::Match { version } = expected {
        validate_identifier(
            version,
            MAX_ID_BYTES,
            RepositoryOperation::Save,
            Some(project_id),
        )?;
    }
    Ok(())
}

fn crash_draft_base(expected: &ExpectedHeadDto) -> (bool, Option<&str>) {
    match expected {
        ExpectedHeadDto::Repair => (false, None),
        ExpectedHeadDto::Empty => (true, None),
        ExpectedHeadDto::Match { version } => (true, Some(version.as_str())),
    }
}

fn ensure_crash_draft_write_allowed(
    connection: &Connection,
    project_id: &str,
) -> Result<(), PersistenceErrorDto> {
    let state = current_head_state(connection, project_id)
        .map_err(|error| write_sql_error(error, Some(project_id)))?;
    match state {
        CurrentHeadState::DeletedEvidence => Err(conflict(RepositoryOperation::Save, project_id)),
        CurrentHeadState::Unsupported(_) | CurrentHeadState::UnsupportedEvidence => {
            Err(persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::UnsupportedVersion,
                RetryPolicy::Never,
                Some(project_id),
            ))
        }
        CurrentHeadState::DiagnosticEvidence(UnreadableProjectErrorCode::UnsupportedVersion) => {
            Err(persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::UnsupportedVersion,
                RetryPolicy::Never,
                Some(project_id),
            ))
        }
        CurrentHeadState::DiagnosticEvidence(UnreadableProjectErrorCode::MigrationFailed) => {
            Err(persistence_error(
                RepositoryOperation::Save,
                PersistenceErrorCode::MigrationFailed,
                RetryPolicy::Never,
                Some(project_id),
            ))
        }
        CurrentHeadState::Empty
        | CurrentHeadState::Valid { .. }
        | CurrentHeadState::Corrupt(_)
        | CurrentHeadState::DiagnosticEvidence(
            UnreadableProjectErrorCode::CorruptData | UnreadableProjectErrorCode::Conflict,
        ) => Ok(()),
    }
}

fn latest_canonical_revision_for_activation(
    connection: &Connection,
    project_id: &str,
    activation_id: &str,
) -> Result<Option<i64>, SqliteError> {
    Ok(
        latest_canonical_generation_for_activation(connection, project_id, activation_id)?
            .and_then(|generation| generation.revision),
    )
}

fn latest_canonical_generation_for_activation(
    connection: &Connection,
    project_id: &str,
    activation_id: &str,
) -> Result<Option<GenerationRow>, SqliteError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {GENERATION_COLUMNS}
         FROM project_generations
         WHERE project_id = ?1
           AND kind = 'save'
           AND branch_source IS NULL
           AND activation_id = ?2
         ORDER BY revision DESC, seq DESC"
    ))?;
    let generations = statement
        .query_map(params![project_id, activation_id], generation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(generations.into_iter().find(|generation| {
        matches!(
            validate_generation(generation),
            Ok(ValidatedGeneration::Save { .. })
        )
    }))
}

fn canonical_generation_matches_crash_request(
    generation: &GenerationRow,
    request: &CrashDraftRequestDto,
    revision: i64,
    canonical: &CanonicalProject,
) -> bool {
    generation.branch_source.is_none()
        && generation.project_id == request.project_id
        && generation.operation_id == request.write_id
        && generation.activation_id.as_deref() == Some(request.activation_id.as_str())
        && generation.revision == Some(revision)
        && generation.payload_crc32.as_deref() == Some(canonical.payload_crc32.as_str())
        && generation.payload_json.as_deref() == Some(canonical.json.as_slice())
        && matches!(
            validate_generation(generation),
            Ok(ValidatedGeneration::Save { .. })
        )
}

fn crash_draft_matches_request(
    draft: &CrashDraftRow,
    request: &CrashDraftRequestDto,
    canonical: &CanonicalProject,
) -> bool {
    let (base_head_known, base_head_version) = crash_draft_base(&request.expected_head);
    draft.project_id == request.project_id
        && draft.activation_id == request.activation_id
        && u64::try_from(draft.revision).ok() == Some(request.revision)
        && draft.write_id == request.write_id
        && draft.base_head_known == base_head_known
        && draft.base_head_version.as_deref() == base_head_version
        && draft.predecessor_write_id == request.predecessor_write_id
        && draft.payload_crc32 == canonical.payload_crc32
        && draft.payload_json == canonical.json
}

fn crash_draft_matches_save_request(
    draft: &CrashDraftRow,
    request: &SaveRequestDto,
    revision: i64,
    canonical: &CanonicalProject,
) -> bool {
    draft.project_id == request.project_id
        && draft.activation_id == request.activation_id
        && draft.revision == revision
        && draft.write_id == request.write_id
        && draft.payload_crc32 == canonical.payload_crc32
        && draft.payload_json == canonical.json
}

fn crash_draft_receipt(
    request: &CrashDraftRequestDto,
    draft: &CrashDraftRow,
) -> CrashDraftReceiptDto {
    CrashDraftReceiptDto {
        project_id: draft.project_id.clone(),
        activation_id: draft.activation_id.clone(),
        revision: request.revision,
        write_id: draft.write_id.clone(),
        protected_at: draft.saved_at.clone(),
        bytes: usize::try_from(draft.payload_bytes).unwrap_or(0),
    }
}

fn crash_draft_receipt_from_generation(
    request: &CrashDraftRequestDto,
    generation: &GenerationRow,
) -> CrashDraftReceiptDto {
    CrashDraftReceiptDto {
        project_id: generation.project_id.clone(),
        activation_id: request.activation_id.clone(),
        revision: request.revision,
        write_id: generation.operation_id.clone(),
        protected_at: generation.saved_at.clone(),
        bytes: usize::try_from(generation.payload_bytes).unwrap_or(0),
    }
}

fn enforce_crash_draft_bounds(
    connection: &Connection,
    existing: Option<&CrashDraftRow>,
    next_payload_bytes: usize,
    project_id: &str,
) -> Result<(), PersistenceErrorDto> {
    let (count, actual_bytes) =
        preflight_crash_draft_storage(connection, RepositoryOperation::Save, Some(project_id))?;
    let existing_bytes = existing.map_or(0, |draft| draft.payload_bytes);
    let next_count = count.saturating_add(i64::from(existing.is_none()));
    let next_total = actual_bytes
        .saturating_sub(existing_bytes)
        .saturating_add(i64::try_from(next_payload_bytes).unwrap_or(i64::MAX));
    if next_count > i64::try_from(MAX_CRASH_DRAFT_ENTRIES).unwrap_or(i64::MAX)
        || next_total > i64::try_from(MAX_CRASH_DRAFT_TOTAL_BYTES).unwrap_or(i64::MAX)
    {
        return Err(persistence_error(
            RepositoryOperation::Save,
            PersistenceErrorCode::QuotaExceeded,
            RetryPolicy::Manual,
            Some(project_id),
        ));
    }
    Ok(())
}

fn delete_crash_drafts_through(
    connection: &Connection,
    project_id: &str,
    activation_id: &str,
    revision: i64,
    exact_revision: Option<(&str, &str, &[u8])>,
) -> Result<(), PersistenceErrorDto> {
    let Some(draft) = read_crash_draft(connection, project_id, activation_id)
        .map_err(|error| write_sql_error(error, Some(project_id)))?
    else {
        return Ok(());
    };
    validate_crash_draft(&draft)
        .map_err(|issue| crash_draft_issue_error(issue, RepositoryOperation::Save, project_id))?;
    if draft.revision > revision {
        return Ok(());
    }
    if draft.revision == revision {
        let Some((write_id, payload_crc32, payload_json)) = exact_revision else {
            return Ok(());
        };
        if draft.write_id != write_id
            || draft.payload_crc32 != payload_crc32
            || draft.payload_json != payload_json
        {
            return Err(conflict(RepositoryOperation::Save, project_id));
        }
    }
    connection
        .execute(
            "DELETE FROM project_crash_drafts
             WHERE project_id = ?1 AND activation_id = ?2 AND revision <= ?3",
            params![project_id, activation_id, revision],
        )
        .map_err(|error| write_sql_error(error, Some(project_id)))?;
    Ok(())
}

fn check_expected_head(
    connection: &Connection,
    project_id: &str,
    expected: &ExpectedHeadDto,
    operation: RepositoryOperation,
    predecessor: Option<PredecessorExpectation<'_>>,
) -> Result<Option<String>, PersistenceErrorDto> {
    let state = current_head_state(connection, project_id)
        .map_err(|error| sqlite_error_for_operation(error, operation, Some(project_id)))?;
    match (expected, state) {
        (ExpectedHeadDto::Empty, CurrentHeadState::Empty) => Ok(None),
        (ExpectedHeadDto::Repair, CurrentHeadState::Corrupt(head)) => {
            Ok(head.map(|head| head.head_version))
        }
        (
            ExpectedHeadDto::Repair,
            CurrentHeadState::DiagnosticEvidence(
                UnreadableProjectErrorCode::CorruptData | UnreadableProjectErrorCode::Conflict,
            ),
        ) if operation == RepositoryOperation::Remove => Ok(None),
        (ExpectedHeadDto::Match { version }, CurrentHeadState::Valid { head, .. })
            if version == &head.head_version =>
        {
            Ok(Some(head.head_version))
        }
        (
            _,
            CurrentHeadState::Valid {
                head,
                row,
                value: ValidatedGeneration::Save { .. },
            },
        ) if predecessor.is_some_and(|predecessor| {
            row.operation_id == predecessor.write_id
                && row.activation_id.as_deref() == Some(predecessor.activation_id)
                && row
                    .revision
                    .is_some_and(|revision| revision < predecessor.revision)
        }) =>
        {
            Ok(Some(head.head_version))
        }
        (_, CurrentHeadState::Unsupported(_) | CurrentHeadState::UnsupportedEvidence) => {
            Err(persistence_error(
                operation,
                PersistenceErrorCode::UnsupportedVersion,
                RetryPolicy::Never,
                Some(project_id),
            ))
        }
        (_, CurrentHeadState::DiagnosticEvidence(error_code)) => match error_code {
            UnreadableProjectErrorCode::UnsupportedVersion => Err(persistence_error(
                operation,
                PersistenceErrorCode::UnsupportedVersion,
                RetryPolicy::Never,
                Some(project_id),
            )),
            UnreadableProjectErrorCode::MigrationFailed => Err(persistence_error(
                operation,
                PersistenceErrorCode::MigrationFailed,
                RetryPolicy::Never,
                Some(project_id),
            )),
            UnreadableProjectErrorCode::CorruptData | UnreadableProjectErrorCode::Conflict => {
                Err(conflict(operation, project_id))
            }
        },
        _ => Err(conflict(operation, project_id)),
    }
}

fn validate_generation(generation: &GenerationRow) -> Result<ValidatedGeneration, GenerationIssue> {
    let Some(kind) = GenerationKind::parse(&generation.kind) else {
        return Err(GenerationIssue::Corrupt);
    };
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
    if generation.record_crc32 != digest_crc32(&digest) {
        return Err(GenerationIssue::Corrupt);
    }

    match kind {
        GenerationKind::Delete => {
            if generation.activation_id.is_some()
                || generation.revision.is_some()
                || generation.predecessor_write_id.is_some()
                || generation.payload_json.is_some()
                || generation.payload_crc32.is_some()
                || generation.payload_bytes != 0
                || generation.title.is_some()
                || generation.updated_at.is_some()
                || generation.branch_source.is_some()
            {
                return Err(GenerationIssue::Corrupt);
            }
            Ok(ValidatedGeneration::Delete)
        }
        GenerationKind::Save => {
            let (Some(payload), Some(payload_crc32), Some(title), Some(updated_at)) = (
                generation.payload_json.as_ref(),
                generation.payload_crc32.as_ref(),
                generation.title.as_ref(),
                generation.updated_at.as_ref(),
            ) else {
                return Err(GenerationIssue::Corrupt);
            };
            if generation.activation_id.is_none()
                || match generation.revision {
                    Some(revision) => revision < 0,
                    None => true,
                }
                || generation.payload_bytes != i64::try_from(payload.len()).unwrap_or(i64::MAX)
                || payload_crc32 != &crc32(payload)
            {
                return Err(GenerationIssue::Corrupt);
            }
            if generation
                .branch_source
                .as_deref()
                .is_some_and(|source| project_branch_source(source).is_none())
            {
                return Err(GenerationIssue::Corrupt);
            }
            let value: Value =
                serde_json::from_slice(payload).map_err(|_| GenerationIssue::Corrupt)?;
            let canonical = canonical_project_for_validation(value)?;
            if canonical.project_id != generation.project_id
                || canonical.title != *title
                || canonical.updated_at != *updated_at
            {
                return Err(GenerationIssue::Corrupt);
            }
            Ok(ValidatedGeneration::Save {
                project: canonical.value,
            })
        }
    }
}

fn validate_crash_draft(draft: &CrashDraftRow) -> Result<CanonicalProject, GenerationIssue> {
    if draft.format_version > CRASH_DRAFT_FORMAT_VERSION {
        return Err(GenerationIssue::Unsupported);
    }
    if draft.format_version != CRASH_DRAFT_FORMAT_VERSION
        || !valid_identifier(&draft.project_id, MAX_ID_BYTES)
        || !valid_identifier(&draft.activation_id, MAX_OPERATION_ID_BYTES)
        || !valid_identifier(&draft.write_id, MAX_OPERATION_ID_BYTES)
        || draft.revision < 0
        || (!draft.base_head_known && draft.base_head_version.is_some())
        || draft
            .base_head_version
            .as_deref()
            .is_some_and(|value| !valid_identifier(value, MAX_ID_BYTES))
        || draft
            .predecessor_write_id
            .as_deref()
            .is_some_and(|value| !valid_identifier(value, MAX_OPERATION_ID_BYTES))
        || !canonical_utc_timestamp(&draft.saved_at)
        || draft.payload_json.len() > MAX_PROJECT_JSON_BYTES
        || draft.payload_bytes != i64::try_from(draft.payload_json.len()).unwrap_or(i64::MAX)
        || draft.payload_crc32 != crc32(&draft.payload_json)
    {
        return Err(GenerationIssue::Corrupt);
    }
    let digest = CrashDraftDigest {
        project_id: &draft.project_id,
        activation_id: &draft.activation_id,
        revision: draft.revision,
        write_id: &draft.write_id,
        base_head_known: draft.base_head_known,
        base_head_version: draft.base_head_version.as_deref(),
        predecessor_write_id: draft.predecessor_write_id.as_deref(),
        saved_at: &draft.saved_at,
        payload_crc32: &draft.payload_crc32,
        payload_bytes: draft.payload_bytes,
        title: &draft.title,
        updated_at: &draft.updated_at,
        format_version: draft.format_version,
    };
    if draft.record_crc32 != digest_crc32(&digest) {
        return Err(GenerationIssue::Corrupt);
    }
    let value: Value =
        serde_json::from_slice(&draft.payload_json).map_err(|_| GenerationIssue::Corrupt)?;
    let canonical = canonical_project_for_validation(value)?;
    if canonical.project_id != draft.project_id
        || canonical.title != draft.title
        || canonical.updated_at != draft.updated_at
    {
        return Err(GenerationIssue::Corrupt);
    }
    Ok(canonical)
}

fn crash_draft_issue_error(
    issue: GenerationIssue,
    operation: RepositoryOperation,
    project_id: &str,
) -> PersistenceErrorDto {
    match issue {
        GenerationIssue::Unsupported => persistence_error(
            operation,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            Some(project_id),
        ),
        GenerationIssue::Corrupt => persistence_error(
            operation,
            PersistenceErrorCode::CorruptData,
            RetryPolicy::Never,
            Some(project_id),
        ),
    }
}

fn canonical_project(
    value: Value,
    operation: RepositoryOperation,
) -> Result<CanonicalProject, PersistenceErrorDto> {
    let project_id = value.get("id").and_then(Value::as_str).map(str::to_owned);
    canonical_project_for_validation(value).map_err(|issue| match issue {
        GenerationIssue::Unsupported => persistence_error(
            operation,
            PersistenceErrorCode::UnsupportedVersion,
            RetryPolicy::Never,
            project_id.as_deref(),
        ),
        GenerationIssue::Corrupt => persistence_error(
            operation,
            PersistenceErrorCode::InvalidProject,
            RetryPolicy::Never,
            project_id.as_deref(),
        ),
    })
}

fn canonical_project_json(
    project_json: &str,
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> Result<CanonicalProject, PersistenceErrorDto> {
    if project_json.len() > MAX_PROJECT_JSON_BYTES {
        return Err(persistence_error(
            operation,
            PersistenceErrorCode::TooLarge,
            RetryPolicy::Never,
            project_id,
        ));
    }
    let value: Value = serde_json::from_str(project_json).map_err(|_| {
        persistence_error(
            operation,
            PersistenceErrorCode::InvalidProject,
            RetryPolicy::Never,
            project_id,
        )
    })?;
    let mut canonical = canonical_project(value, operation)?;
    canonical.json = project_json.as_bytes().to_vec();
    canonical.payload_crc32 = crc32(&canonical.json);
    Ok(canonical)
}

pub(crate) fn validate_project_file_json(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    if bytes.len() > MAX_PROJECT_JSON_BYTES || std::str::from_utf8(bytes).is_err() {
        return false;
    }
    serde_json::from_slice(bytes)
        .ok()
        .and_then(|value| canonical_project_for_validation(value).ok())
        .is_some()
}

fn canonical_project_for_validation(value: Value) -> Result<CanonicalProject, GenerationIssue> {
    let record = value.as_object().ok_or(GenerationIssue::Corrupt)?;
    let schema_version = record
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or(GenerationIssue::Corrupt)?;
    if schema_version > PROJECT_SCHEMA_VERSION {
        return Err(GenerationIssue::Unsupported);
    }
    if !(MIN_PROJECT_SCHEMA_VERSION..=PROJECT_SCHEMA_VERSION).contains(&schema_version) {
        return Err(GenerationIssue::Corrupt);
    }
    validate_project(&value)?;
    let project_id = record
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| valid_identifier(value, MAX_ID_BYTES))
        .ok_or(GenerationIssue::Corrupt)?
        .to_owned();
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .ok_or(GenerationIssue::Corrupt)?
        .to_owned();
    let updated_at = record
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(GenerationIssue::Corrupt)?
        .to_owned();
    let json = serde_json::to_vec(&value).map_err(|_| GenerationIssue::Corrupt)?;
    if json.len() > MAX_PROJECT_JSON_BYTES {
        return Err(GenerationIssue::Corrupt);
    }
    let payload_crc32 = crc32(&json);
    Ok(CanonicalProject {
        value,
        json,
        project_id,
        title,
        updated_at,
        payload_crc32,
    })
}

fn validate_project_versioned_presence(
    value: &Value,
    schema_version: u64,
) -> Result<(), GenerationIssue> {
    const V3_PROJECT_FIELDS: &[&str] = &[
        "lengthBeats",
        "tempoMap",
        "timeSignatureMap",
        "audioAssets",
        "automationLanes",
    ];
    const V3_AUDIO_CLIP_FIELDS: &[&str] = &[
        "sourceStartFrame",
        "sourceFrameCount",
        "fadeInFrames",
        "fadeOutFrames",
        "gainDb",
    ];
    let project = value.as_object().ok_or(GenerationIssue::Corrupt)?;
    let is_v3 = schema_version == 3;
    if V3_PROJECT_FIELDS
        .iter()
        .any(|key| project.contains_key(*key) != is_v3)
    {
        return Err(GenerationIssue::Corrupt);
    }
    let tracks = project
        .get("tracks")
        .and_then(Value::as_array)
        .ok_or(GenerationIssue::Corrupt)?;
    for track in tracks {
        let track = track.as_object().ok_or(GenerationIssue::Corrupt)?;
        if track.contains_key("role") != is_v3 {
            return Err(GenerationIssue::Corrupt);
        }
        let clips = track
            .get("clips")
            .and_then(Value::as_array)
            .ok_or(GenerationIssue::Corrupt)?;
        for clip in clips {
            let clip = clip.as_object().ok_or(GenerationIssue::Corrupt)?;
            let is_v3_audio = is_v3 && clip.get("type").and_then(Value::as_str) == Some("audio");
            if V3_AUDIO_CLIP_FIELDS
                .iter()
                .any(|key| clip.contains_key(*key) != is_v3_audio)
                || (is_v3_audio && !clip.contains_key("audioAssetId"))
            {
                return Err(GenerationIssue::Corrupt);
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
struct DrumStepProjectionSegment {
    start_bar: u64,
    start_beat: f64,
    beats_per_bar: f64,
}

/// Reusable clip-local thresholds for drum-step projection. Compilation walks
/// signature boundaries once; each event performs only a binary search.
struct DrumStepTimelineProjector {
    steps_per_bar: u64,
    segments: Vec<DrumStepProjectionSegment>,
}

impl DrumStepTimelineProjector {
    fn compile(
        steps_per_bar: u64,
        clip_start_beat: f64,
        signature_map: &[TimeSignatureMapEventDto],
    ) -> Option<Self> {
        if steps_per_bar == 0 || !clip_start_beat.is_finite() || signature_map.is_empty() {
            return None;
        }
        let mut segments = Vec::with_capacity(signature_map.len());
        let mut start_bar = 0u64;
        let mut start_beat = clip_start_beat;

        for _ in 0..=signature_map.len() {
            let signature_index = signature_map
                .partition_point(|event| event.beat <= start_beat)
                .checked_sub(1)?;
            let signature = &signature_map[signature_index];
            let beats_per_bar = signature.numerator as f64 * 4.0 / signature.denominator as f64;
            if !beats_per_bar.is_finite() || beats_per_bar <= 0.0 {
                return None;
            }
            segments.push(DrumStepProjectionSegment {
                start_bar,
                start_beat,
                beats_per_bar,
            });

            let Some(next_signature) = signature_map.get(signature_index + 1) else {
                break;
            };
            let beats_until_next_signature = next_signature.beat - start_beat;
            if !beats_until_next_signature.is_finite() || beats_until_next_signature <= 0.0 {
                return None;
            }
            let bars_until_next_signature =
                ((beats_until_next_signature / beats_per_bar).ceil() as u64).max(1);
            start_bar = start_bar.checked_add(bars_until_next_signature)?;
            start_beat += bars_until_next_signature as f64 * beats_per_bar;
            if !start_beat.is_finite() {
                return None;
            }
        }

        (!segments.is_empty()).then_some(Self {
            steps_per_bar,
            segments,
        })
    }

    fn project(&self, step_index: i64) -> Option<f64> {
        let safe_step = u64::try_from(step_index).ok()?;
        let local_bar = safe_step / self.steps_per_bar;
        let step_in_bar = safe_step - local_bar * self.steps_per_bar;
        let segment_index = self
            .segments
            .partition_point(|segment| segment.start_bar <= local_bar)
            .checked_sub(1)?;
        let segment = self.segments.get(segment_index)?;
        let bar_start_beat =
            segment.start_beat + (local_bar - segment.start_bar) as f64 * segment.beats_per_bar;
        let beat = bar_start_beat
            + step_in_bar as f64 * (segment.beats_per_bar / self.steps_per_bar as f64);
        beat.is_finite().then_some(beat)
    }
}

/// Compatibility wrapper for one-off callers.
#[allow(dead_code)]
fn drum_step_to_beat_on_timeline(
    step_index: i64,
    steps_per_bar: u64,
    clip_start_beat: f64,
    signature_map: &[TimeSignatureMapEventDto],
) -> Option<f64> {
    DrumStepTimelineProjector::compile(steps_per_bar, clip_start_beat, signature_map)?
        .project(step_index)
}

fn validate_project(value: &Value) -> Result<(), GenerationIssue> {
    const MAX_STRING_CHARS: usize = 4_096;
    const MAX_ARRAY_ITEMS: usize = 100_000;
    const MAX_TOTAL_ITEMS: usize = 200_000;
    const MAX_TIMELINE_BEATS: f64 = 8_192.0;
    const MIN_DURATION: f64 = 1.0 / 960.0;
    const MAX_TEMPO_MAP_EVENTS: usize = 4_096;
    const MAX_TIME_SIGNATURE_MAP_EVENTS: usize = 1_024;
    const MAX_AUDIO_ASSETS: usize = 4_096;
    const MAX_AUTOMATION_LANES: usize = 2_048;
    const MAX_AUTOMATION_POINTS: usize = 20_000;
    if project_has_explicit_null_optionals(value) {
        return Err(GenerationIssue::Corrupt);
    }
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or(GenerationIssue::Corrupt)?;
    validate_project_versioned_presence(value, schema_version)?;
    let project: ProjectDto =
        serde_json::from_value(value.clone()).map_err(|_| GenerationIssue::Corrupt)?;
    if !(MIN_PROJECT_SCHEMA_VERSION..=PROJECT_SCHEMA_VERSION).contains(&project.schema_version)
        || !valid_project_string(&project.id, MAX_STRING_CHARS, false)
        || !valid_project_string(&project.title, MAX_STRING_CHARS, true)
        || !project.bpm.is_finite()
        || !(20.0..=300.0).contains(&project.bpm)
        || project.time_signature[0] == 0
        || project.time_signature[0] > 32
        || !matches!(project.time_signature[1], 2 | 4 | 8 | 16)
        || project.length_bars == 0
        || project.length_bars > 256
        || !matches!(
            project.key.as_str(),
            "C" | "C#"
                | "Db"
                | "D"
                | "D#"
                | "Eb"
                | "E"
                | "F"
                | "F#"
                | "Gb"
                | "G"
                | "G#"
                | "Ab"
                | "A"
                | "A#"
                | "Bb"
                | "B"
        )
        || !matches!(
            project.scale.as_str(),
            "major"
                | "naturalMinor"
                | "harmonicMinor"
                | "melodicMinor"
                | "majorPentatonic"
                | "minorPentatonic"
                | "blues"
        )
        || !canonical_utc_timestamp(&project.created_at)
        || !canonical_utc_timestamp(&project.updated_at)
        || project.tracks.len() > 128
        || project.chord_track.len() > 4_096
        || project.sections.len() > 256
    {
        return Err(GenerationIssue::Corrupt);
    }
    let beats_per_bar = project.time_signature[0] as f64 * 4.0 / project.time_signature[1] as f64;
    let project_length_beats = if project.schema_version == 3 {
        project.length_beats.ok_or(GenerationIssue::Corrupt)?
    } else {
        project.length_bars as f64 * beats_per_bar
    };
    if !project_length_beats.is_finite()
        || project_length_beats <= 0.0
        || project_length_beats > MAX_TIMELINE_BEATS
    {
        return Err(GenerationIssue::Corrupt);
    }

    let mut ids = HashSet::new();
    if !ids.insert(project.id.as_str()) {
        return Err(GenerationIssue::Corrupt);
    }
    let mut total_items = project.tracks.len() + project.chord_track.len() + project.sections.len();
    let mut audio_assets_by_id = HashMap::<&str, &AudioAssetDto>::new();
    if project.schema_version == 3 {
        let tempo_map = project
            .tempo_map
            .as_deref()
            .ok_or(GenerationIssue::Corrupt)?;
        let signature_map = project
            .time_signature_map
            .as_deref()
            .ok_or(GenerationIssue::Corrupt)?;
        let audio_assets = project
            .audio_assets
            .as_deref()
            .ok_or(GenerationIssue::Corrupt)?;
        let automation_lanes = project
            .automation_lanes
            .as_deref()
            .ok_or(GenerationIssue::Corrupt)?;
        if tempo_map.is_empty()
            || tempo_map.len() > MAX_TEMPO_MAP_EVENTS
            || signature_map.is_empty()
            || signature_map.len() > MAX_TIME_SIGNATURE_MAP_EVENTS
            || audio_assets.len() > MAX_AUDIO_ASSETS
            || automation_lanes.len() > MAX_AUTOMATION_LANES
        {
            return Err(GenerationIssue::Corrupt);
        }
        total_items = total_items
            .checked_add(
                tempo_map.len() + signature_map.len() + audio_assets.len() + automation_lanes.len(),
            )
            .ok_or(GenerationIssue::Corrupt)?;

        let mut previous_beat = None;
        for event in tempo_map {
            if !valid_project_string(&event.id, MAX_STRING_CHARS, false)
                || !ids.insert(event.id.as_str())
                || !event.beat.is_finite()
                || event.beat < 0.0
                || event.beat > project_length_beats
                || previous_beat.is_some_and(|previous| event.beat <= previous)
                || !event.bpm.is_finite()
                || !(20.0..=300.0).contains(&event.bpm)
            {
                return Err(GenerationIssue::Corrupt);
            }
            previous_beat = Some(event.beat);
        }
        if tempo_map
            .first()
            .is_none_or(|event| event.beat != 0.0 || event.bpm != project.bpm)
        {
            return Err(GenerationIssue::Corrupt);
        }

        let mut previous_beat = None;
        let mut derived_bars = 0u64;
        for (index, event) in signature_map.iter().enumerate() {
            if !valid_project_string(&event.id, MAX_STRING_CHARS, false)
                || !ids.insert(event.id.as_str())
                || !event.beat.is_finite()
                || event.beat < 0.0
                || event.beat > project_length_beats
                || previous_beat.is_some_and(|previous| event.beat <= previous)
                || event.numerator == 0
                || event.numerator > 32
                || !matches!(event.denominator, 2 | 4 | 8 | 16)
            {
                return Err(GenerationIssue::Corrupt);
            }
            let next_beat = signature_map
                .get(index + 1)
                .map_or(project_length_beats, |next| next.beat);
            let segment_beats = next_beat - event.beat;
            let segment_beats_per_bar = event.numerator as f64 * 4.0 / event.denominator as f64;
            let segment_bars = segment_beats / segment_beats_per_bar;
            if !segment_bars.is_finite()
                || segment_bars < 0.0
                || segment_bars.fract() != 0.0
                || segment_bars > JS_MAX_SAFE_INTEGER as f64
            {
                return Err(GenerationIssue::Corrupt);
            }
            derived_bars = derived_bars
                .checked_add(segment_bars as u64)
                .ok_or(GenerationIssue::Corrupt)?;
            previous_beat = Some(event.beat);
        }
        if signature_map.first().is_none_or(|event| {
            event.beat != 0.0
                || event.numerator != project.time_signature[0]
                || event.denominator != project.time_signature[1]
        }) || derived_bars != project.length_bars
        {
            return Err(GenerationIssue::Corrupt);
        }

        for asset in audio_assets {
            if !valid_project_string(asset.id(), MAX_STRING_CHARS, false)
                || !ids.insert(asset.id())
                || audio_assets_by_id.insert(asset.id(), asset).is_some()
            {
                return Err(GenerationIssue::Corrupt);
            }
            match asset {
                AudioAssetDto::Ready {
                    checksum_sha256,
                    original_name,
                    media_type,
                    byte_length,
                    sample_rate,
                    channel_count,
                    frame_count,
                    ..
                } => {
                    if !valid_sha256(checksum_sha256)
                        || !valid_project_string(original_name, MAX_STRING_CHARS, false)
                        || !matches!(
                            media_type.as_str(),
                            "audio/wav" | "audio/mpeg" | "audio/mp4" | "audio/aac"
                        )
                        || *byte_length == 0
                        || *byte_length > JS_MAX_SAFE_INTEGER
                        || !(8_000..=384_000).contains(sample_rate)
                        || !(1..=32).contains(channel_count)
                        || *frame_count == 0
                        || *frame_count > JS_MAX_SAFE_INTEGER
                    {
                        return Err(GenerationIssue::Corrupt);
                    }
                }
                AudioAssetDto::Unresolved {
                    legacy_asset_id,
                    reason,
                    ..
                } => {
                    if legacy_asset_id.as_deref().is_some_and(|legacy| {
                        !valid_project_string(legacy, MAX_STRING_CHARS, false)
                    }) || !matches!(reason.as_str(), "legacy-reference" | "missing-reference")
                        || (reason == "legacy-reference" && legacy_asset_id.is_none())
                        || (reason == "missing-reference" && legacy_asset_id.is_some())
                    {
                        return Err(GenerationIssue::Corrupt);
                    }
                }
            }
        }
    } else if project.length_beats.is_some()
        || project.tempo_map.is_some()
        || project.time_signature_map.is_some()
        || project.audio_assets.is_some()
        || project.automation_lanes.is_some()
    {
        return Err(GenerationIssue::Corrupt);
    }

    let mut track_ids = HashSet::new();
    let mut track_kinds_by_id = HashMap::new();
    let mut learning_roles = HashSet::new();
    for track in &project.tracks {
        if !valid_project_string(&track.id, MAX_STRING_CHARS, false)
            || !valid_project_string(&track.name, MAX_STRING_CHARS, true)
            || !matches!(
                track.kind.as_str(),
                "instrument" | "drum" | "audio" | "bus" | "master"
            )
            || !track.volume.is_finite()
            || !(0.0..=2.0).contains(&track.volume)
            || !track.pan.is_finite()
            || !(-1.0..=1.0).contains(&track.pan)
            || track.clips.len() > 1_024
            || track.effects.len() > 64
            || !ids.insert(track.id.as_str())
            || !track_ids.insert(track.id.as_str())
            || track_kinds_by_id
                .insert(track.id.as_str(), track.kind.as_str())
                .is_some()
            || track
                .color
                .as_deref()
                .is_some_and(|color| !valid_track_color(color))
            || (project.schema_version == 3
                && match track.role.as_deref() {
                    Some("general") => false,
                    Some(role @ ("learning.chords" | "learning.bass" | "learning.melody")) => {
                        track.kind != "instrument" || !learning_roles.insert(role)
                    }
                    _ => true,
                })
            || (project.schema_version < 3 && track.role.is_some())
        {
            return Err(GenerationIssue::Corrupt);
        }
        total_items = total_items
            .checked_add(track.clips.len() + track.effects.len())
            .ok_or(GenerationIssue::Corrupt)?;
        if let Some(instrument) = &track.instrument {
            if !matches!(instrument.kind.as_str(), "synth" | "drumkit")
                || !valid_project_string(&instrument.preset, MAX_STRING_CHARS, true)
                || !valid_number_map(instrument.params.as_ref(), MAX_STRING_CHARS)
            {
                return Err(GenerationIssue::Corrupt);
            }
            total_items = total_items
                .checked_add(instrument.params.as_ref().map_or(0, HashMap::len))
                .ok_or(GenerationIssue::Corrupt)?;
        }
        for effect in &track.effects {
            if !valid_project_string(&effect.id, MAX_STRING_CHARS, false)
                || !ids.insert(effect.id.as_str())
                || !matches!(
                    effect.kind.as_str(),
                    "filter" | "delay" | "reverb" | "compressor" | "eq"
                )
                || !valid_number_map(Some(&effect.params), MAX_STRING_CHARS)
            {
                return Err(GenerationIssue::Corrupt);
            }
            total_items = total_items
                .checked_add(effect.params.len())
                .ok_or(GenerationIssue::Corrupt)?;
        }
    }

    if project.schema_version == 3 {
        let automation_lanes = project
            .automation_lanes
            .as_deref()
            .ok_or(GenerationIssue::Corrupt)?;
        let mut automation_targets = HashSet::new();
        for lane in automation_lanes {
            if !valid_project_string(&lane.id, MAX_STRING_CHARS, false)
                || !ids.insert(lane.id.as_str())
                || !valid_project_string(&lane.target.track_id, MAX_STRING_CHARS, false)
                || !track_ids.contains(lane.target.track_id.as_str())
                || !matches!(lane.target.kind.as_str(), "track-volume" | "track-pan")
                || track_kinds_by_id.get(lane.target.track_id.as_str()) == Some(&"master")
                || !automation_targets
                    .insert((lane.target.track_id.as_str(), lane.target.kind.as_str()))
                || lane.points.len() > MAX_AUTOMATION_POINTS
            {
                return Err(GenerationIssue::Corrupt);
            }
            total_items = total_items
                .checked_add(lane.points.len())
                .ok_or(GenerationIssue::Corrupt)?;
            let mut previous_beat = None;
            for point in &lane.points {
                let valid_value = match lane.target.kind.as_str() {
                    "track-volume" => (0.0..=2.0).contains(&point.value),
                    "track-pan" => (-1.0..=1.0).contains(&point.value),
                    _ => false,
                };
                if !valid_project_string(&point.id, MAX_STRING_CHARS, false)
                    || !ids.insert(point.id.as_str())
                    || !point.beat.is_finite()
                    || point.beat < 0.0
                    || point.beat > project_length_beats
                    || previous_beat.is_some_and(|previous| point.beat <= previous)
                    || !point.value.is_finite()
                    || !valid_value
                    || !matches!(point.interpolation.as_str(), "hold" | "linear")
                {
                    return Err(GenerationIssue::Corrupt);
                }
                previous_beat = Some(point.beat);
            }
        }
    }

    let mut clip_index = HashMap::new();
    for track in &project.tracks {
        for clip in &track.clips {
            let stored_event_count = clip
                .notes
                .as_ref()
                .map_or(0, Vec::len)
                .checked_add(clip.drum_events.as_ref().map_or(0, Vec::len))
                .ok_or(GenerationIssue::Corrupt)?;
            if clip_index
                .insert(
                    clip.id.as_str(),
                    (
                        track.id.as_str(),
                        clip.kind.as_str(),
                        clip.alias_of.as_deref(),
                        clip.length_beats,
                        stored_event_count,
                    ),
                )
                .is_some()
            {
                return Err(GenerationIssue::Corrupt);
            }
        }
    }

    let mut effective_schedule_events = 0usize;
    for track in &project.tracks {
        for clip in &track.clips {
            if !valid_project_string(&clip.id, MAX_STRING_CHARS, false)
                || !valid_project_string(&clip.track_id, MAX_STRING_CHARS, false)
                || !ids.insert(clip.id.as_str())
                || clip.track_id != track.id
                || !track_ids.contains(clip.track_id.as_str())
                || !matches!(clip.kind.as_str(), "midi" | "drum" | "audio" | "automation")
                || !valid_timeline_span(
                    clip.start_beat,
                    clip.length_beats,
                    project_length_beats,
                    MIN_DURATION,
                )
                || clip
                    .alias_of
                    .as_deref()
                    .is_some_and(|value| !valid_project_string(value, MAX_STRING_CHARS, true))
                || clip
                    .audio_asset_id
                    .as_deref()
                    .is_some_and(|value| !valid_project_string(value, MAX_STRING_CHARS, true))
                || clip.notes.as_ref().is_some_and(|_| clip.kind != "midi")
                || clip
                    .drum_events
                    .as_ref()
                    .is_some_and(|_| clip.kind != "drum")
                || clip
                    .steps_per_bar
                    .is_some_and(|steps| clip.kind != "drum" || steps == 0 || steps > 128)
                || clip
                    .drum_groove
                    .as_ref()
                    .is_some_and(|_| clip.kind != "drum")
                || clip.audio_asset_id.is_some() && clip.kind != "audio"
                || clip.source_start_frame.is_some() && clip.kind != "audio"
                || clip.source_frame_count.is_some() && clip.kind != "audio"
                || clip.fade_in_frames.is_some() && clip.kind != "audio"
                || clip.fade_out_frames.is_some() && clip.kind != "audio"
                || clip.gain_db.is_some() && clip.kind != "audio"
            {
                return Err(GenerationIssue::Corrupt);
            }
            if project.schema_version >= 2 {
                if let Some(source_id) = clip.alias_of.as_deref() {
                    let Some((source_track_id, source_kind, source_alias, source_length, _)) =
                        clip_index.get(source_id)
                    else {
                        return Err(GenerationIssue::Corrupt);
                    };
                    if !matches!(clip.kind.as_str(), "midi" | "drum")
                        || source_id == clip.id
                        || *source_track_id != track.id
                        || *source_kind != clip.kind
                        || source_alias.is_some()
                        || *source_length != clip.length_beats
                        || clip.notes.is_some()
                        || clip.drum_events.is_some()
                        || clip.steps_per_bar.is_some()
                        || clip.drum_groove.is_some()
                        || clip.audio_asset_id.is_some()
                        || clip.source_start_frame.is_some()
                        || clip.source_frame_count.is_some()
                        || clip.fade_in_frames.is_some()
                        || clip.fade_out_frames.is_some()
                        || clip.gain_db.is_some()
                    {
                        return Err(GenerationIssue::Corrupt);
                    }
                }
            }
            if project.schema_version == 3 && clip.kind == "audio" {
                let asset_id = clip
                    .audio_asset_id
                    .as_deref()
                    .filter(|value| valid_project_string(value, MAX_STRING_CHARS, false))
                    .ok_or(GenerationIssue::Corrupt)?;
                let asset = audio_assets_by_id
                    .get(asset_id)
                    .copied()
                    .ok_or(GenerationIssue::Corrupt)?;
                let source_start = clip.source_start_frame.ok_or(GenerationIssue::Corrupt)?;
                let source_count = clip.source_frame_count.ok_or(GenerationIssue::Corrupt)?;
                let fade_in = clip.fade_in_frames.ok_or(GenerationIssue::Corrupt)?;
                let fade_out = clip.fade_out_frames.ok_or(GenerationIssue::Corrupt)?;
                let gain_db = clip.gain_db.ok_or(GenerationIssue::Corrupt)?;
                if source_start > JS_MAX_SAFE_INTEGER
                    || source_count > JS_MAX_SAFE_INTEGER
                    || fade_in > JS_MAX_SAFE_INTEGER
                    || fade_out > JS_MAX_SAFE_INTEGER
                    || !gain_db.is_finite()
                    || !(-96.0..=24.0).contains(&gain_db)
                {
                    return Err(GenerationIssue::Corrupt);
                }
                match asset {
                    AudioAssetDto::Ready { frame_count, .. } => {
                        if track.kind != "audio"
                            || source_count == 0
                            || source_start
                                .checked_add(source_count)
                                .is_none_or(|end| end > *frame_count)
                            || fade_in
                                .checked_add(fade_out)
                                .is_none_or(|fade| fade > source_count)
                        {
                            return Err(GenerationIssue::Corrupt);
                        }
                    }
                    AudioAssetDto::Unresolved { .. } => {
                        if source_start != 0 || source_count != 0 || fade_in != 0 || fade_out != 0 {
                            return Err(GenerationIssue::Corrupt);
                        }
                    }
                }
            }
            let notes = clip.notes.as_deref().unwrap_or_default();
            let drums = clip.drum_events.as_deref().unwrap_or_default();
            if notes.len() > 20_000 || drums.len() > 20_000 {
                return Err(GenerationIssue::Corrupt);
            }
            if track.kind != "master" {
                let effective_clip_events = if project.schema_version >= 2 {
                    match clip.alias_of.as_deref() {
                        Some(source_id) => clip_index
                            .get(source_id)
                            .map(|(_, _, _, _, event_count)| *event_count)
                            .ok_or(GenerationIssue::Corrupt)?,
                        None => notes
                            .len()
                            .checked_add(drums.len())
                            .ok_or(GenerationIssue::Corrupt)?,
                    }
                } else {
                    // v1 aliasOf was inert: its own payload is the sounding data.
                    notes
                        .len()
                        .checked_add(drums.len())
                        .ok_or(GenerationIssue::Corrupt)?
                };
                effective_schedule_events = effective_schedule_events
                    .checked_add(effective_clip_events)
                    .ok_or(GenerationIssue::Corrupt)?;
                if effective_schedule_events > MAX_PERSISTED_EFFECTIVE_SCHEDULE_EVENTS {
                    return Err(GenerationIssue::Corrupt);
                }
            }
            total_items = total_items
                .checked_add(notes.len() + drums.len())
                .ok_or(GenerationIssue::Corrupt)?;
            if let Some(groove) = &clip.drum_groove {
                if !unit_interval(groove.swing)
                    || !unit_interval(groove.probability)
                    || !(0..=127).contains(&groove.humanize_velocity)
                    || groove.seed == 0
                    || groove.seed > 9_007_199_254_740_991
                {
                    return Err(GenerationIssue::Corrupt);
                }
            }
            for note in notes {
                if !valid_project_string(&note.id, MAX_STRING_CHARS, false)
                    || !ids.insert(note.id.as_str())
                    || !(0..=127).contains(&note.pitch)
                    || !(1..=127).contains(&note.velocity)
                    || !valid_timeline_span(
                        note.start_beat,
                        note.duration_beats,
                        clip.length_beats,
                        MIN_DURATION,
                    )
                {
                    return Err(GenerationIssue::Corrupt);
                }
            }
            let steps_per_bar = clip.steps_per_bar.unwrap_or(16);
            let drum_projector = if project.schema_version == 3 && !drums.is_empty() {
                Some(
                    DrumStepTimelineProjector::compile(
                        steps_per_bar,
                        clip.start_beat,
                        project
                            .time_signature_map
                            .as_deref()
                            .ok_or(GenerationIssue::Corrupt)?,
                    )
                    .ok_or(GenerationIssue::Corrupt)?,
                )
            } else {
                None
            };
            for drum in drums {
                let drum_beat_in_clip = if project.schema_version == 3 {
                    drum_projector
                        .as_ref()
                        .and_then(|projector| projector.project(drum.step_index))
                        .map(|beat| beat - clip.start_beat)
                } else {
                    Some(drum.step_index as f64 * (beats_per_bar / steps_per_bar as f64))
                };
                if !valid_project_string(&drum.id, MAX_STRING_CHARS, false)
                    || !ids.insert(drum.id.as_str())
                    || !matches!(
                        drum.lane.as_str(),
                        "kick" | "snare" | "closedHat" | "openHat" | "clap" | "perc"
                    )
                    || drum.step_index < 0
                    || !(1..=127).contains(&drum.velocity)
                    || drum.probability.is_some_and(|value| !unit_interval(value))
                    || drum_beat_in_clip
                        .is_none_or(|beat| !beat.is_finite() || beat >= clip.length_beats)
                {
                    return Err(GenerationIssue::Corrupt);
                }
            }
        }
    }

    for chord in &project.chord_track {
        if !valid_project_string(&chord.id, MAX_STRING_CHARS, false)
            || !ids.insert(chord.id.as_str())
            || !valid_timeline_span(
                chord.start_beat,
                chord.duration_beats,
                project_length_beats,
                MIN_DURATION,
            )
            || !valid_project_string(&chord.symbol, MAX_STRING_CHARS, true)
            || !valid_project_string(&chord.root, MAX_STRING_CHARS, true)
            || !valid_project_string(&chord.quality, MAX_STRING_CHARS, true)
            || chord.notes.len() > MAX_ARRAY_ITEMS
            || chord.notes.iter().any(|pitch| !(0..=127).contains(pitch))
            || chord
                .degree
                .as_deref()
                .is_some_and(|value| !valid_project_string(value, MAX_STRING_CHARS, true))
            || chord
                .function
                .as_deref()
                .is_some_and(|value| !matches!(value, "T" | "SD" | "D" | "Other"))
            || chord.tags.as_ref().is_some_and(|tags| {
                tags.len() > MAX_ARRAY_ITEMS
                    || tags
                        .iter()
                        .any(|tag| !valid_project_string(tag, MAX_STRING_CHARS, true))
            })
        {
            return Err(GenerationIssue::Corrupt);
        }
        total_items = total_items
            .checked_add(chord.notes.len() + chord.tags.as_ref().map_or(0, Vec::len))
            .ok_or(GenerationIssue::Corrupt)?;
    }
    for section in &project.sections {
        if !valid_project_string(&section.id, MAX_STRING_CHARS, false)
            || !valid_project_string(&section.name, MAX_STRING_CHARS, true)
            || !ids.insert(section.id.as_str())
            || !matches!(
                section.kind.as_str(),
                "intro" | "verse" | "preChorus" | "chorus" | "bridge" | "outro"
            )
            || section.start_bar < 0
            || section.start_bar >= 256
            || !(1..=256).contains(&section.length_bars)
            || section.start_bar + section.length_bars > project.length_bars as i64
        {
            return Err(GenerationIssue::Corrupt);
        }
    }
    if total_items > MAX_TOTAL_ITEMS {
        return Err(GenerationIssue::Corrupt);
    }
    Ok(())
}

fn project_has_explicit_null_optionals(value: &Value) -> bool {
    let Some(project) = value.as_object() else {
        return true;
    };
    let has_null = |record: &serde_json::Map<String, Value>, keys: &[&str]| {
        keys.iter()
            .any(|key| record.get(*key).is_some_and(Value::is_null))
    };
    if has_null(
        project,
        &[
            "lengthBeats",
            "tempoMap",
            "timeSignatureMap",
            "audioAssets",
            "automationLanes",
        ],
    ) {
        return true;
    }
    if let Some(Value::Array(tracks)) = project.get("tracks") {
        for track in tracks {
            let Some(track) = track.as_object() else {
                continue;
            };
            if has_null(track, &["role", "color", "instrument"]) {
                return true;
            }
            if let Some(Value::Object(instrument)) = track.get("instrument") {
                if has_null(instrument, &["params"]) {
                    return true;
                }
            }
            if let Some(Value::Array(clips)) = track.get("clips") {
                for clip in clips {
                    let Some(clip) = clip.as_object() else {
                        continue;
                    };
                    if has_null(
                        clip,
                        &[
                            "aliasOf",
                            "notes",
                            "drumEvents",
                            "stepsPerBar",
                            "drumGroove",
                            "audioAssetId",
                            "sourceStartFrame",
                            "sourceFrameCount",
                            "fadeInFrames",
                            "fadeOutFrames",
                            "gainDb",
                        ],
                    ) {
                        return true;
                    }
                    if let Some(Value::Array(drums)) = clip.get("drumEvents") {
                        if drums.iter().any(|drum| {
                            drum.as_object()
                                .is_some_and(|drum| has_null(drum, &["probability"]))
                        }) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    if let Some(Value::Array(assets)) = project.get("audioAssets") {
        if assets.iter().any(|asset| {
            asset
                .as_object()
                .is_some_and(|asset| has_null(asset, &["legacyAssetId"]))
        }) {
            return true;
        }
    }
    if let Some(Value::Array(chords)) = project.get("chordTrack") {
        if chords.iter().any(|chord| {
            chord
                .as_object()
                .is_some_and(|chord| has_null(chord, &["degree", "function", "tags"]))
        }) {
            return true;
        }
    }
    false
}

fn valid_project_string(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty()) && value.encode_utf16().count() <= max_chars
}

fn valid_number_map(value: Option<&HashMap<String, f64>>, max_chars: usize) -> bool {
    value.is_none_or(|params| {
        params.len() <= 2_048
            && params
                .iter()
                .all(|(key, value)| valid_project_string(key, max_chars, true) && value.is_finite())
    })
}

fn unit_interval(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn valid_timeline_span(start: f64, duration: f64, limit: f64, minimum: f64) -> bool {
    start.is_finite()
        && duration.is_finite()
        && start >= 0.0
        && duration >= minimum
        && duration <= 8_192.0
        && start + duration <= limit
}

fn valid_track_color(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
        || bytes.iter().enumerate().any(|(index, byte)| {
            !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit()
        })
    {
        return false;
    }
    let parse = |range: std::ops::Range<usize>| {
        std::str::from_utf8(&bytes[range]).ok()?.parse::<u32>().ok()
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        parse(0..4),
        parse(5..7),
        parse(8..10),
        parse(11..13),
        parse(14..16),
        parse(17..19),
    ) else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=max_day).contains(&day)
}

fn read_head_row(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<HeadRow>, SqliteError> {
    connection
        .query_row(
            "SELECT project_id, generation_seq, head_version, deleted, head_crc32
             FROM project_heads WHERE project_id = ?1",
            params![project_id],
            |row| {
                Ok(HeadRow {
                    project_id: row.get(0)?,
                    generation_seq: row.get(1)?,
                    head_version: row.get(2)?,
                    deleted: row.get::<_, i64>(3)? != 0,
                    head_crc32: row.get(4)?,
                })
            },
        )
        .optional()
}

fn read_generation_by_seq(
    connection: &Connection,
    sequence: i64,
) -> Result<Option<GenerationRow>, SqliteError> {
    connection
        .query_row(
            &format!("SELECT {GENERATION_COLUMNS} FROM project_generations WHERE seq = ?1"),
            params![sequence],
            generation_from_row,
        )
        .optional()
}

fn read_generation_by_operation(
    connection: &Connection,
    project_id: &str,
    kind: GenerationKind,
    operation_id: &str,
) -> Result<Option<GenerationRow>, SqliteError> {
    connection
        .query_row(
            &format!(
                "SELECT {GENERATION_COLUMNS}
                 FROM project_generations
                 WHERE project_id = ?1 AND kind = ?2 AND operation_id = ?3"
            ),
            params![project_id, kind.as_str(), operation_id],
            generation_from_row,
        )
        .optional()
}

fn read_crash_draft(
    connection: &Connection,
    project_id: &str,
    activation_id: &str,
) -> Result<Option<CrashDraftRow>, SqliteError> {
    connection
        .query_row(
            &format!(
                "SELECT {CRASH_DRAFT_COLUMNS}
                 FROM project_crash_drafts
                 WHERE project_id = ?1 AND activation_id = ?2"
            ),
            params![project_id, activation_id],
            crash_draft_from_row,
        )
        .optional()
}

fn read_crash_draft_by_write_id(
    connection: &Connection,
    project_id: &str,
    write_id: &str,
) -> Result<Option<CrashDraftRow>, SqliteError> {
    connection
        .query_row(
            &format!(
                "SELECT {CRASH_DRAFT_COLUMNS}
                 FROM project_crash_drafts
                 WHERE project_id = ?1 AND write_id = ?2"
            ),
            params![project_id, write_id],
            crash_draft_from_row,
        )
        .optional()
}

fn crash_draft_from_row(row: &Row<'_>) -> Result<CrashDraftRow, SqliteError> {
    Ok(CrashDraftRow {
        project_id: row.get(0)?,
        activation_id: row.get(1)?,
        revision: row.get(2)?,
        write_id: row.get(3)?,
        base_head_known: row.get::<_, i64>(4)? != 0,
        base_head_version: row.get(5)?,
        predecessor_write_id: row.get(6)?,
        saved_at: row.get(7)?,
        payload_json: row.get(8)?,
        payload_crc32: row.get(9)?,
        payload_bytes: row.get(10)?,
        title: row.get(11)?,
        updated_at: row.get(12)?,
        format_version: row.get(13)?,
        record_crc32: row.get(14)?,
    })
}

fn crash_draft_storage_bounds(connection: &Connection) -> Result<(i64, i64), SqliteError> {
    connection.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(length(payload_json)), 0)
         FROM project_crash_drafts",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

fn preflight_crash_draft_storage(
    connection: &Connection,
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> Result<(i64, i64), PersistenceErrorDto> {
    let (count, actual_bytes) = crash_draft_storage_bounds(connection)
        .map_err(|error| sqlite_error_for_operation(error, operation, project_id))?;
    if count < 0 || actual_bytes < 0 {
        return Err(persistence_error(
            operation,
            PersistenceErrorCode::CorruptData,
            RetryPolicy::Never,
            project_id,
        ));
    }
    if count > i64::try_from(MAX_CRASH_DRAFT_ENTRIES).unwrap_or(i64::MAX)
        || actual_bytes > i64::try_from(MAX_CRASH_DRAFT_TOTAL_BYTES).unwrap_or(i64::MAX)
    {
        return Err(persistence_error(
            operation,
            PersistenceErrorCode::QuotaExceeded,
            RetryPolicy::Manual,
            project_id,
        ));
    }
    Ok((count, actual_bytes))
}

fn all_crash_drafts(connection: &Connection) -> Result<Vec<CrashDraftRow>, SqliteError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {CRASH_DRAFT_COLUMNS}
         FROM project_crash_drafts
         ORDER BY project_id, activation_id"
    ))?;
    let drafts = statement
        .query_map([], crash_draft_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(drafts)
}

fn generation_from_row(row: &Row<'_>) -> Result<GenerationRow, SqliteError> {
    Ok(GenerationRow {
        seq: row.get(0)?,
        project_id: row.get(1)?,
        kind: row.get(2)?,
        operation_id: row.get(3)?,
        head_version: row.get(4)?,
        parent_head_version: row.get(5)?,
        activation_id: row.get(6)?,
        revision: row.get(7)?,
        predecessor_write_id: row.get(8)?,
        saved_at: row.get(9)?,
        payload_json: row.get(10)?,
        payload_crc32: row.get(11)?,
        payload_bytes: row.get(12)?,
        title: row.get(13)?,
        updated_at: row.get(14)?,
        record_crc32: row.get(15)?,
        branch_source: row.get(16)?,
    })
}

fn generation_count(connection: &Connection, project_id: &str) -> Result<usize, SqliteError> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM project_generations WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

fn canonical_generation_count(
    connection: &Connection,
    project_id: &str,
) -> Result<usize, SqliteError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {GENERATION_COLUMNS}
         FROM project_generations
         WHERE project_id = ?1 AND branch_source IS NULL"
    ))?;
    let generations = statement
        .query_map(params![project_id], generation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let mut count = 0_usize;
    for generation in generations {
        if legacy_generation_is_live(connection, &generation)? {
            count = count.saturating_add(1);
        }
    }
    Ok(count)
}

fn prune_generations(connection: &Connection, project_id: &str) -> Result<(), SqliteError> {
    connection.execute(
        "DELETE FROM project_generations
         WHERE project_id = ?1
           AND branch_source IS NULL
           AND seq NOT IN (
             SELECT seq FROM project_generations
             WHERE project_id = ?1 AND branch_source IS NULL
             ORDER BY seq DESC
             LIMIT ?2
           )
           AND seq NOT IN (
             SELECT generation_seq FROM project_heads WHERE project_id = ?1
           )
           ",
        params![project_id, i64::try_from(RETAIN_GENERATIONS).unwrap_or(3)],
    )?;
    Ok(())
}

fn remove_explicit_branches(
    connection: &Connection,
    project_id: &str,
) -> Result<bool, SqliteError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {GENERATION_COLUMNS}
         FROM project_generations
         WHERE project_id = ?1 AND branch_source IS NOT NULL"
    ))?;
    let branches = statement
        .query_map(params![project_id], generation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for branch in branches {
        if validate_generation(&branch) != Err(GenerationIssue::Unsupported) {
            connection.execute(
                "DELETE FROM project_generations WHERE seq = ?1",
                params![branch.seq],
            )?;
        }
    }
    let has_sticky_diagnostic =
        sticky_completed_legacy_diagnostic(connection, project_id)?.is_some();
    Ok(!has_unsupported_generation_evidence(connection, project_id)? && !has_sticky_diagnostic)
}

fn remove_crash_drafts(connection: &Connection, project_id: &str) -> Result<(), SqliteError> {
    connection.execute(
        "DELETE FROM project_crash_drafts WHERE project_id = ?1",
        params![project_id],
    )?;
    Ok(())
}

fn database_now(connection: &Connection) -> Result<String, SqliteError> {
    connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
        row.get(0)
    })
}

fn save_receipt(
    request: &SaveRequestDto,
    generation: &GenerationRow,
    retained_generations: usize,
) -> SaveReceiptDto {
    SaveReceiptDto {
        project_id: generation.project_id.clone(),
        activation_id: request.activation_id.clone(),
        revision: request.revision,
        write_id: generation.operation_id.clone(),
        head_version: generation.head_version.clone(),
        saved_at: generation.saved_at.clone(),
        bytes: usize::try_from(generation.payload_bytes).unwrap_or(0),
        retained_generations,
        legacy_mirror_written: false,
    }
}

fn crc32(bytes: &[u8]) -> String {
    format!("crc32:{:08x}", crc32fast::hash(bytes))
}

fn digest_crc32(value: &impl Serialize) -> String {
    let bytes = serde_json::to_vec(value).expect("checksum DTO serialization cannot fail");
    crc32(&bytes)
}

fn head_crc32(project_id: &str, generation_seq: i64, head_version: &str, deleted: bool) -> String {
    digest_crc32(&HeadDigest {
        project_id,
        generation_seq,
        head_version,
        deleted,
    })
}

fn valid_identifier(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.contains('\0')
}

fn validate_identifier(
    value: &str,
    max_bytes: usize,
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> Result<(), PersistenceErrorDto> {
    if valid_identifier(value, max_bytes) {
        Ok(())
    } else {
        Err(persistence_error(
            operation,
            PersistenceErrorCode::InvalidProject,
            RetryPolicy::Never,
            project_id,
        ))
    }
}

fn validate_erase_id(erase_id: &str) -> Result<(), PersistenceErrorDto> {
    let bytes = erase_id.as_bytes();
    if bytes.len() != 42 || !bytes.starts_with(b"erase-") {
        return Err(erase_error(
            PersistenceErrorCode::InvalidProject,
            RetryPolicy::Never,
        ));
    }
    for (index, byte) in bytes.iter().copied().enumerate() {
        let valid = match index {
            0..=5 => true,
            14 | 19 | 24 | 29 => byte == b'-',
            20 => byte == b'4',
            25 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        };
        if !valid {
            return Err(erase_error(
                PersistenceErrorCode::InvalidProject,
                RetryPolicy::Never,
            ));
        }
    }
    Ok(())
}

fn erase_marker_checksum(storage_version: u64, erase_id: &str) -> String {
    digest_crc32(&EraseMarkerChecksum {
        storage_version,
        erase_id,
    })
}

fn erase_receipt(erase_id: String) -> EraseAllReceiptDto {
    EraseAllReceiptDto {
        erase_id,
        native_data_removed: true,
    }
}

fn append_path_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OpenedFileIdentity {
    volume: u64,
    file: [u8; 16],
}

#[cfg(unix)]
fn file_identity_from_u64(value: u64) -> [u8; 16] {
    let mut identity = [0_u8; 16];
    identity[..8].copy_from_slice(&value.to_le_bytes());
    identity
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OpenedFileFacts {
    identity: OpenedFileIdentity,
    links: u64,
    length: u64,
    regular: bool,
}

struct ValidatedOwnedFile {
    path: PathBuf,
    file: File,
    facts: OpenedFileFacts,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DatabaseFamilyInspection {
    identities: [Option<OpenedFileIdentity>; 4],
}

impl DatabaseFamilyInspection {
    fn main_identity(self) -> Option<OpenedFileIdentity> {
        self.identities[0]
    }
}

fn database_boundary_error() -> PersistenceErrorDto {
    persistence_error(
        RepositoryOperation::Initialize,
        PersistenceErrorCode::StorageUnavailable,
        RetryPolicy::Manual,
        None,
    )
}

fn ensure_stable_main_database_identity(
    previous: Option<OpenedFileIdentity>,
    current: Option<OpenedFileIdentity>,
) -> Result<(), PersistenceErrorDto> {
    if previous.is_some() && previous != current {
        return Err(database_boundary_error());
    }
    Ok(())
}

static SAFE_SQLITE_VFS_REGISTRATION: OnceLock<Result<(), ()>> = OnceLock::new();
static ORIGINAL_SQLITE_VFS: AtomicPtr<rusqlite::ffi::sqlite3_vfs> =
    AtomicPtr::new(std::ptr::null_mut());
static SAFE_SQLITE_BOUNDARIES: OnceLock<Mutex<HashMap<PathBuf, Arc<SafeVfsBoundary>>>> =
    OnceLock::new();
#[cfg(test)]
static SAFE_SQLITE_VFS_TEST_HOOK: OnceLock<Mutex<Option<SafeVfsTestHook>>> = OnceLock::new();
#[cfg(all(test, unix))]
static SAFE_SQLITE_VFS_TEST_SERIAL: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
struct SafeVfsTestHook {
    target: PathBuf,
    replacement: PathBuf,
    saved_original: Option<PathBuf>,
    swapped: bool,
}

struct SafeVfsBoundary {
    main_path: PathBuf,
    directory_path: PathBuf,
    directory: File,
    directory_identity: OpenedFileIdentity,
}

struct SafeVfsBoundaryGuard {
    main_path: PathBuf,
}

struct SafeVfsOpenBoundary {
    boundary: Arc<SafeVfsBoundary>,
    path: PathBuf,
    before: Option<ValidatedOwnedFile>,
}

impl SafeVfsBoundaryGuard {
    fn register(main_path: PathBuf) -> Result<Self, PersistenceErrorDto> {
        let directory_path = main_path
            .parent()
            .ok_or_else(database_boundary_error)?
            .to_owned();
        let (directory, directory_identity) =
            open_retained_data_directory(&directory_path).map_err(|_| database_boundary_error())?;
        let boundary = Arc::new(SafeVfsBoundary {
            main_path: main_path.clone(),
            directory_path,
            directory,
            directory_identity,
        });
        let mut boundaries = safe_sqlite_boundaries()
            .lock()
            .map_err(|_| database_boundary_error())?;
        if boundaries.contains_key(&main_path) {
            return Err(database_boundary_error());
        }
        boundaries.insert(main_path.clone(), boundary);
        Ok(Self { main_path })
    }
}

impl Drop for SafeVfsBoundaryGuard {
    fn drop(&mut self) {
        if let Ok(mut boundaries) = safe_sqlite_boundaries().lock() {
            boundaries.remove(&self.main_path);
        }
    }
}

impl SafeVfsBoundary {
    fn matches_open(&self, path: &Path, flags: i32) -> bool {
        (flags & rusqlite::ffi::SQLITE_OPEN_MAIN_DB != 0 && path == self.main_path)
            || (flags & rusqlite::ffi::SQLITE_OPEN_MAIN_JOURNAL != 0
                && path == append_path_suffix(&self.main_path, "-journal"))
            || (flags & rusqlite::ffi::SQLITE_OPEN_WAL != 0
                && path == append_path_suffix(&self.main_path, "-wal"))
    }

    fn owns_path(&self, path: &Path) -> bool {
        path == self.main_path
            || path == append_path_suffix(&self.main_path, "-journal")
            || path == append_path_suffix(&self.main_path, "-wal")
            || path == append_path_suffix(&self.main_path, "-shm")
    }

    fn directory_is_current(&self) -> bool {
        opened_file_facts(&self.directory).is_ok_and(|facts| {
            facts.identity == self.directory_identity
                && open_retained_data_directory(&self.directory_path)
                    .is_ok_and(|(_, identity)| identity == self.directory_identity)
        })
    }
}

fn safe_sqlite_boundaries() -> &'static Mutex<HashMap<PathBuf, Arc<SafeVfsBoundary>>> {
    SAFE_SQLITE_BOUNDARIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn safe_vfs_boundary_for_open(path: &Path, flags: i32) -> Option<Arc<SafeVfsBoundary>> {
    safe_sqlite_boundaries()
        .lock()
        .ok()?
        .values()
        .find(|boundary| boundary.matches_open(path, flags))
        .cloned()
}

fn safe_vfs_boundary_for_path(path: &Path) -> Option<Arc<SafeVfsBoundary>> {
    safe_sqlite_boundaries()
        .lock()
        .ok()?
        .values()
        .find(|boundary| boundary.owns_path(path))
        .cloned()
}

#[cfg(test)]
fn safe_sqlite_vfs_test_hook() -> &'static Mutex<Option<SafeVfsTestHook>> {
    SAFE_SQLITE_VFS_TEST_HOOK.get_or_init(|| Mutex::new(None))
}

#[cfg(all(test, unix))]
fn safe_sqlite_vfs_test_serial() -> &'static Mutex<()> {
    SAFE_SQLITE_VFS_TEST_SERIAL.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
fn run_safe_sqlite_vfs_test_hook(path: &Path, before_delegate: bool) -> bool {
    let Ok(mut slot) = safe_sqlite_vfs_test_hook().lock() else {
        return false;
    };
    let Some(hook) = slot.as_mut() else {
        return true;
    };
    if hook.target != path {
        return true;
    }
    if before_delegate {
        if let Some(saved) = &hook.saved_original {
            if fs::rename(&hook.target, saved).is_err() {
                return false;
            }
        }
        if fs::rename(&hook.replacement, &hook.target).is_err() {
            return false;
        }
        hook.swapped = true;
        true
    } else {
        if !hook.swapped || fs::rename(&hook.target, &hook.replacement).is_err() {
            return false;
        }
        if let Some(saved) = &hook.saved_original {
            if fs::rename(saved, &hook.target).is_err() {
                return false;
            }
        }
        slot.take();
        true
    }
}

fn ensure_safe_sqlite_vfs_registered() -> Result<(), PersistenceErrorDto> {
    let registration = SAFE_SQLITE_VFS_REGISTRATION.get_or_init(|| {
        // SAFETY: SQLite serializes VFS registration during initialization. The
        // cloned descriptor is leaked intentionally because SQLite requires a
        // registered VFS and its name to remain alive process-wide.
        unsafe {
            if rusqlite::ffi::sqlite3_initialize() != rusqlite::ffi::SQLITE_OK {
                return Err(());
            }
            if rusqlite::ffi::sqlite3_libversion_number() != EXPECTED_BUNDLED_SQLITE_VERSION {
                return Err(());
            }
            let original = rusqlite::ffi::sqlite3_vfs_find(std::ptr::null());
            if original.is_null()
                || (*original).xOpen.is_none()
                || (*original).xDelete.is_none()
                || (*original).xAccess.is_none()
                || (*original).xFullPathname.is_none()
            {
                return Err(());
            }
            let original_name = (*original).zName;
            if original_name.is_null()
                || !sqlite_vfs_name_is_platform(std::ffi::CStr::from_ptr(original_name).to_bytes())
            {
                return Err(());
            }
            ORIGINAL_SQLITE_VFS.store(original, Ordering::Release);
            let mut safe_vfs = Box::new(*original);
            safe_vfs.pNext = std::ptr::null_mut();
            safe_vfs.zName = c"cts-safe-vfs-v1".as_ptr();
            // Preserve the original pAppData for every copied callback. The
            // forwarding callbacks obtain the original descriptor atomically.
            safe_vfs.xOpen = Some(safe_sqlite_vfs_open);
            safe_vfs.xDelete = Some(safe_sqlite_vfs_delete);
            safe_vfs.xAccess = Some(safe_sqlite_vfs_access);
            safe_vfs.xFullPathname = Some(safe_sqlite_vfs_full_pathname);
            let safe_vfs = Box::into_raw(safe_vfs);
            let result = rusqlite::ffi::sqlite3_vfs_register(safe_vfs, 0);
            if result != rusqlite::ffi::SQLITE_OK {
                drop(Box::from_raw(safe_vfs));
                return Err(());
            }
            Ok(())
        }
    });
    if registration.is_ok() {
        Ok(())
    } else {
        Err(database_boundary_error())
    }
}

unsafe extern "C" fn safe_sqlite_vfs_open(
    _safe_vfs: *mut rusqlite::ffi::sqlite3_vfs,
    name: rusqlite::ffi::sqlite3_filename,
    file: *mut rusqlite::ffi::sqlite3_file,
    flags: i32,
    output_flags: *mut i32,
) -> i32 {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        safe_sqlite_vfs_open_inner(name, file, flags, output_flags)
    }))
    .unwrap_or(rusqlite::ffi::SQLITE_CANTOPEN)
}

fn safe_sqlite_vfs_open_inner(
    name: rusqlite::ffi::sqlite3_filename,
    file: *mut rusqlite::ffi::sqlite3_file,
    flags: i32,
    output_flags: *mut i32,
) -> i32 {
    let original = ORIGINAL_SQLITE_VFS.load(Ordering::Acquire);
    if original.is_null() || file.is_null() {
        return rusqlite::ffi::SQLITE_CANTOPEN;
    }
    let persistent = flags
        & (rusqlite::ffi::SQLITE_OPEN_MAIN_DB
            | rusqlite::ffi::SQLITE_OPEN_MAIN_JOURNAL
            | rusqlite::ffi::SQLITE_OPEN_WAL)
        != 0;
    if flags & (rusqlite::ffi::SQLITE_OPEN_SUPER_JOURNAL | rusqlite::ffi::SQLITE_OPEN_SUBJOURNAL)
        != 0
    {
        return rusqlite::ffi::SQLITE_CANTOPEN;
    }
    let open_boundary = if persistent {
        match sqlite_vfs_path(name) {
            Some(path) => match safe_sqlite_vfs_pre_open(path, flags) {
                Some(boundary) => Some(boundary),
                None => return rusqlite::ffi::SQLITE_CANTOPEN,
            },
            _ => return rusqlite::ffi::SQLITE_CANTOPEN,
        }
    } else {
        None
    };
    #[cfg(test)]
    if open_boundary
        .as_ref()
        .is_some_and(|boundary| !run_safe_sqlite_vfs_test_hook(&boundary.path, true))
    {
        return rusqlite::ffi::SQLITE_CANTOPEN;
    }
    // SAFETY: registration verified the original VFS and xOpen callback, and
    // SQLite supplied the correctly sized file buffer and output flag pointer.
    let result = unsafe {
        ((*original).xOpen.expect("verified xOpen"))(
            original,
            name,
            file,
            flags | rusqlite::ffi::SQLITE_OPEN_NOFOLLOW,
            output_flags,
        )
    };
    #[cfg(test)]
    if open_boundary
        .as_ref()
        .is_some_and(|boundary| !run_safe_sqlite_vfs_test_hook(&boundary.path, false))
    {
        if result == rusqlite::ffi::SQLITE_OK {
            close_sqlite_vfs_file(file);
        }
        return rusqlite::ffi::SQLITE_CANTOPEN;
    }
    if result != rusqlite::ffi::SQLITE_OK {
        return result;
    }
    if let Some(open_boundary) = open_boundary {
        if !safe_sqlite_vfs_post_open(file, &open_boundary) {
            close_sqlite_vfs_file(file);
            return rusqlite::ffi::SQLITE_CANTOPEN;
        }
    }
    result
}

unsafe extern "C" fn safe_sqlite_vfs_delete(
    _safe_vfs: *mut rusqlite::ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    sync_directory: i32,
) -> i32 {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let original = ORIGINAL_SQLITE_VFS.load(Ordering::Acquire);
        if original.is_null() {
            return rusqlite::ffi::SQLITE_IOERR_DELETE;
        }
        let Some(path) = sqlite_vfs_path(name) else {
            return rusqlite::ffi::SQLITE_IOERR_DELETE;
        };
        let Some(boundary) = safe_vfs_boundary_for_path(&path) else {
            return rusqlite::ffi::SQLITE_IOERR_DELETE;
        };
        if !boundary.directory_is_current() {
            return rusqlite::ffi::SQLITE_IOERR_DELETE;
        }
        match inspect_existing_owned_regular_file(&path, false) {
            Ok(Some(validated)) if harden_validated_owned_file(&validated, false).is_ok() => {}
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => return rusqlite::ffi::SQLITE_IOERR_DELETE,
        }
        unsafe { ((*original).xDelete.expect("verified xDelete"))(original, name, sync_directory) }
    }))
    .unwrap_or(rusqlite::ffi::SQLITE_IOERR_DELETE)
}

unsafe extern "C" fn safe_sqlite_vfs_access(
    _safe_vfs: *mut rusqlite::ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    flags: i32,
    result: *mut i32,
) -> i32 {
    let original = ORIGINAL_SQLITE_VFS.load(Ordering::Acquire);
    if original.is_null() {
        return rusqlite::ffi::SQLITE_IOERR_ACCESS;
    }
    unsafe { ((*original).xAccess.expect("verified xAccess"))(original, name, flags, result) }
}

unsafe extern "C" fn safe_sqlite_vfs_full_pathname(
    _safe_vfs: *mut rusqlite::ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    output_bytes: i32,
    output: *mut std::ffi::c_char,
) -> i32 {
    let original = ORIGINAL_SQLITE_VFS.load(Ordering::Acquire);
    if original.is_null() {
        return rusqlite::ffi::SQLITE_CANTOPEN;
    }
    unsafe {
        ((*original).xFullPathname.expect("verified xFullPathname"))(
            original,
            name,
            output_bytes,
            output,
        )
    }
}

fn safe_sqlite_vfs_pre_open(path: PathBuf, flags: i32) -> Option<SafeVfsOpenBoundary> {
    let boundary = safe_vfs_boundary_for_open(&path, flags)?;
    if !boundary.directory_is_current() {
        return None;
    }
    let before = inspect_existing_owned_regular_file(&path, false).ok()?;
    if before.is_none() && flags & rusqlite::ffi::SQLITE_OPEN_MAIN_DB != 0 {
        return None;
    }
    Some(SafeVfsOpenBoundary {
        boundary,
        path,
        before,
    })
}

fn safe_sqlite_vfs_post_open(
    file: *mut rusqlite::ffi::sqlite3_file,
    open_boundary: &SafeVfsOpenBoundary,
) -> bool {
    if !open_boundary.boundary.directory_is_current() {
        return false;
    }
    let Ok(Some(validated)) = inspect_existing_owned_regular_file(&open_boundary.path, false)
    else {
        return false;
    };
    if open_boundary
        .before
        .as_ref()
        .is_some_and(|before| before.facts.identity != validated.facts.identity)
    {
        return false;
    }
    sqlite_vfs_file_matches_identity(file, validated.facts.identity)
        && harden_validated_owned_file(&validated, false).is_ok()
}

fn close_sqlite_vfs_file(file: *mut rusqlite::ffi::sqlite3_file) {
    // SAFETY: this is called only after the original xOpen succeeded. Its
    // methods table remains live and owns the not-yet-published file object.
    let Some(methods) =
        (unsafe { file.as_ref() }).and_then(|file| unsafe { file.pMethods.as_ref() })
    else {
        return;
    };
    if let Some(close) = methods.xClose {
        let _ = unsafe { close(file) };
    }
}

#[cfg(unix)]
fn sqlite_vfs_path(name: *const std::ffi::c_char) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;

    if name.is_null() {
        return None;
    }
    let bytes = unsafe { std::ffi::CStr::from_ptr(name) }.to_bytes();
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(windows)]
fn sqlite_vfs_path(name: *const std::ffi::c_char) -> Option<PathBuf> {
    if name.is_null() {
        return None;
    }
    let name = unsafe { std::ffi::CStr::from_ptr(name) }.to_str().ok()?;
    Some(PathBuf::from(name))
}

#[cfg(not(any(unix, windows)))]
fn sqlite_vfs_path(_name: *const std::ffi::c_char) -> Option<PathBuf> {
    None
}

fn ensure_sqlite_main_file_identity(
    connection: &Connection,
    expected: OpenedFileIdentity,
) -> Result<(), PersistenceErrorDto> {
    let file =
        sqlite_connection_file_pointer(connection, rusqlite::ffi::SQLITE_FCNTL_FILE_POINTER)?
            .ok_or_else(database_boundary_error)?;
    if sqlite_vfs_file_matches_identity(file, expected) {
        Ok(())
    } else {
        Err(database_boundary_error())
    }
}

fn ensure_sqlite_wal_file_identity(
    connection: &Connection,
    expected: Option<OpenedFileIdentity>,
) -> Result<(), PersistenceErrorDto> {
    let file =
        sqlite_connection_file_pointer(connection, rusqlite::ffi::SQLITE_FCNTL_JOURNAL_POINTER)?;
    match (file, expected) {
        (None, None) => Ok(()),
        (Some(file), Some(expected)) if sqlite_vfs_file_matches_identity(file, expected) => Ok(()),
        _ => Err(database_boundary_error()),
    }
}

fn sqlite_connection_file_pointer(
    connection: &Connection,
    opcode: i32,
) -> Result<Option<*mut rusqlite::ffi::sqlite3_file>, PersistenceErrorDto> {
    if !sqlite_connection_uses_platform_vfs(connection) {
        return Err(database_boundary_error());
    }
    let mut file: *mut rusqlite::ffi::sqlite3_file = std::ptr::null_mut();
    // SAFETY: the repository mutex gives this call exclusive access to the live
    // connection, "main" is a static NUL-terminated database name, and SQLite
    // writes only a sqlite3_file pointer into the correctly typed output slot.
    let result = unsafe {
        rusqlite::ffi::sqlite3_file_control(
            connection.handle(),
            c"main".as_ptr(),
            opcode,
            (&mut file as *mut *mut rusqlite::ffi::sqlite3_file).cast(),
        )
    };
    if result != rusqlite::ffi::SQLITE_OK {
        return Err(database_boundary_error());
    }
    if file.is_null() {
        return Ok(None);
    }
    // SAFETY: SQLite returned the pointer for the still-live connection above.
    if unsafe { (*file).pMethods.is_null() } {
        Ok(None)
    } else {
        Ok(Some(file))
    }
}

fn sqlite_connection_uses_platform_vfs(connection: &Connection) -> bool {
    let mut vfs: *mut rusqlite::ffi::sqlite3_vfs = std::ptr::null_mut();
    // SAFETY: the live connection is exclusively held by the repository, and
    // SQLite writes a sqlite3_vfs pointer into the correctly typed output slot.
    let result = unsafe {
        rusqlite::ffi::sqlite3_file_control(
            connection.handle(),
            c"main".as_ptr(),
            rusqlite::ffi::SQLITE_FCNTL_VFS_POINTER,
            (&mut vfs as *mut *mut rusqlite::ffi::sqlite3_vfs).cast(),
        )
    };
    if result != rusqlite::ffi::SQLITE_OK || vfs.is_null() {
        return false;
    }
    // SAFETY: SQLite returned this VFS pointer for the still-live connection.
    let name = unsafe { (*vfs).zName };
    if name.is_null() {
        return false;
    }
    // SAFETY: sqlite3_vfs.zName is required to be a NUL-terminated string for
    // the lifetime of the registered VFS.
    unsafe { std::ffi::CStr::from_ptr(name) }.to_bytes() == SAFE_SQLITE_VFS_NAME.as_bytes()
}

fn sqlite_vfs_name_is_platform(name: &[u8]) -> bool {
    #[cfg(unix)]
    return name == b"unix";
    #[cfg(windows)]
    return name == b"win32";
    #[cfg(not(any(unix, windows)))]
    return false;
}

#[cfg(windows)]
fn invoke_sqlite_file_control(
    file: *mut rusqlite::ffi::sqlite3_file,
    opcode: i32,
    argument: *mut std::ffi::c_void,
) -> Option<i32> {
    // SAFETY: callers pass a sqlite3_file pointer returned by the live
    // connection. The methods table and xFileControl function are checked
    // before invoking the VFS with the opcode-specific output storage.
    let methods = unsafe { file.as_ref()?.pMethods.as_ref()? };
    let control = methods.xFileControl?;
    Some(unsafe { control(file, opcode, argument) })
}

// The OS device identifier is u64 on Linux but a narrower signed type on Apple targets.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
fn sqlite_vfs_file_matches_identity(
    file: *mut rusqlite::ffi::sqlite3_file,
    expected: OpenedFileIdentity,
) -> bool {
    #[repr(C)]
    struct SqliteUnixFilePrefix {
        _methods: *const rusqlite::ffi::sqlite3_io_methods,
        _vfs: *mut rusqlite::ffi::sqlite3_vfs,
        _inode: *mut std::ffi::c_void,
        descriptor: libc::c_int,
    }

    // The bundled SQLite unix VFS is pinned by Cargo.lock. Its unixFile starts
    // with sqlite3_file, sqlite3_vfs*, unixInodeInfo*, then the OS descriptor.
    // sqlite_connection_uses_platform_vfs() rejects wrappers/other VFSes before
    // this version-pinned prefix is read.
    let descriptor = unsafe { (*(file.cast::<SqliteUnixFilePrefix>())).descriptor };
    if descriptor < 0 {
        return false;
    }
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } != 0 {
        return false;
    }
    let metadata = unsafe { metadata.assume_init() };
    let actual = OpenedFileIdentity {
        volume: metadata.st_dev as u64,
        file: file_identity_from_u64(metadata.st_ino),
    };
    actual == expected && metadata.st_nlink == 1 && metadata.st_mode & libc::S_IFMT == libc::S_IFREG
}

#[cfg(not(any(unix, windows)))]
fn sqlite_vfs_file_matches_identity(
    _file: *mut rusqlite::ffi::sqlite3_file,
    _expected: OpenedFileIdentity,
) -> bool {
    false
}

#[cfg(windows)]
fn sqlite_vfs_file_matches_identity(
    file: *mut rusqlite::ffi::sqlite3_file,
    expected: OpenedFileIdentity,
) -> bool {
    use windows_sys::Win32::Foundation::HANDLE;

    let mut handle: HANDLE = std::ptr::null_mut();
    if invoke_sqlite_file_control(
        file,
        rusqlite::ffi::SQLITE_FCNTL_WIN32_GET_HANDLE,
        (&mut handle as *mut HANDLE).cast(),
    ) != Some(rusqlite::ffi::SQLITE_OK)
        || handle.is_null()
    {
        return false;
    }
    opened_windows_handle_facts(handle)
        .is_ok_and(|facts| facts.regular && facts.links == 1 && facts.identity == expected)
}

fn inspect_and_harden_database_family(
    paths: &[PathBuf; 4],
) -> std::io::Result<DatabaseFamilyInspection> {
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        if let Some(file) = inspect_existing_owned_regular_file(path, false)? {
            files.push(file);
        }
    }

    // Do not chmod any member until every existing family entry has passed the
    // no-follow, regular-file, single-link, and path/handle identity checks.
    for file in &files {
        harden_validated_owned_file(file, false)?;
    }

    let mut identities = [None; 4];
    for (index, path) in paths.iter().enumerate() {
        identities[index] = files
            .iter()
            .find(|file| file.path == *path)
            .map(|file| file.facts.identity);
    }
    Ok(DatabaseFamilyInspection { identities })
}

fn inspect_existing_owned_regular_file(
    path: &Path,
    require_empty: bool,
) -> std::io::Result<Option<ValidatedOwnedFile>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == IoErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink()
        || metadata_is_windows_reparse_point(&metadata)
        || !metadata.is_file()
        || !metadata_has_one_link_when_available(&metadata)
        || (require_empty && metadata.len() != 0)
    {
        return Err(unsafe_owned_entry_error());
    }

    let file = open_path_without_following(path, false, false)?;
    if !opened_file_is_single_link_regular_and_matches_path(&file, path, require_empty)? {
        return Err(unsafe_owned_entry_error());
    }
    let facts = opened_file_facts(&file)?;
    Ok(Some(ValidatedOwnedFile {
        path: path.to_owned(),
        file,
        facts,
    }))
}

fn harden_validated_owned_file(
    validated: &ValidatedOwnedFile,
    require_empty: bool,
) -> std::io::Result<()> {
    if !opened_file_is_single_link_regular_and_matches_path(
        &validated.file,
        &validated.path,
        require_empty,
    )? || opened_file_facts(&validated.file)?.identity != validated.facts.identity
    {
        return Err(unsafe_owned_entry_error());
    }
    harden_private_file_permissions(&validated.file)?;
    if !opened_file_is_single_link_regular_and_matches_path(
        &validated.file,
        &validated.path,
        require_empty,
    )? || opened_file_facts(&validated.file)?.identity != validated.facts.identity
    {
        return Err(unsafe_owned_entry_error());
    }
    Ok(())
}

fn unsafe_owned_entry_error() -> std::io::Error {
    std::io::Error::new(
        IoErrorKind::InvalidData,
        "app-owned storage entry is not a single-link regular file",
    )
}

fn create_private_database_file(path: &Path) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .truncate(false);
    configure_open_without_following(&mut options);
    let file = options.open(path)?;
    if !opened_file_is_single_link_regular_and_matches_path(&file, path, true)? {
        return Err(unsafe_owned_entry_error());
    }
    harden_private_file_permissions(&file)?;
    if !opened_file_is_single_link_regular_and_matches_path(&file, path, true)? {
        return Err(unsafe_owned_entry_error());
    }
    Ok(())
}

#[cfg(unix)]
fn sqlite_open_path(path: &Path) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::from(IoErrorKind::NotFound))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::from(IoErrorKind::InvalidInput))?;
    // SQLITE_OPEN_NOFOLLOW rejects a filename containing a symlink in any
    // ancestor. macOS temporary paths commonly pass through /var -> /private/var,
    // so resolve ancestors only after the final app-owned directory itself has
    // been verified as a non-symlink directory.
    let canonical_parent = fs::canonicalize(parent)?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    let original = options.open(parent)?;
    let canonical = options.open(&canonical_parent)?;
    let original_metadata = original.metadata()?;
    let canonical_metadata = canonical.metadata()?;
    if !original_metadata.is_dir()
        || !canonical_metadata.is_dir()
        || original_metadata.dev() != canonical_metadata.dev()
        || original_metadata.ino() != canonical_metadata.ino()
    {
        return Err(unsafe_owned_entry_error());
    }
    Ok(canonical_parent.join(file_name))
}

#[cfg(not(unix))]
fn sqlite_open_path(path: &Path) -> std::io::Result<PathBuf> {
    Ok(path.to_owned())
}

#[cfg(unix)]
fn harden_private_file_permissions(file: &File) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    if file.metadata()?.mode() & 0o7777 != 0o600 {
        return Err(std::io::Error::new(
            IoErrorKind::PermissionDenied,
            "could not restrict app-owned file permissions",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_private_file_permissions(_file: &File) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn open_retained_data_directory(path: &Path) -> std::io::Result<(File, OpenedFileIdentity)> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    let directory = options.open(path)?;
    if !directory.metadata()?.is_dir() {
        return Err(unsafe_owned_entry_error());
    }
    let identity = opened_file_facts(&directory)?.identity;
    Ok((directory, identity))
}

#[cfg(windows)]
fn open_retained_data_directory(path: &Path) -> std::io::Result<(File, OpenedFileIdentity)> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let directory = options.open(path)?;
    let metadata = directory.metadata()?;
    if !metadata.is_dir() || metadata_is_windows_reparse_point(&metadata) {
        return Err(unsafe_owned_entry_error());
    }
    let identity = opened_file_facts(&directory)?.identity;
    Ok((directory, identity))
}

#[cfg(not(any(unix, windows)))]
fn open_retained_data_directory(_path: &Path) -> std::io::Result<(File, OpenedFileIdentity)> {
    Err(std::io::Error::from(IoErrorKind::Unsupported))
}

#[cfg(unix)]
fn harden_app_data_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let path_metadata = fs::symlink_metadata(path)?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_dir() {
        return Err(unsafe_owned_entry_error());
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    let directory = options.open(path)?;
    let opened_metadata = directory.metadata()?;
    if !opened_metadata.is_dir()
        || opened_metadata.dev() != path_metadata.dev()
        || opened_metadata.ino() != path_metadata.ino()
    {
        return Err(unsafe_owned_entry_error());
    }
    directory.set_permissions(fs::Permissions::from_mode(0o700))?;

    let current = options.open(path)?;
    let current_metadata = current.metadata()?;
    let opened_metadata = directory.metadata()?;
    if !current_metadata.is_dir()
        || current_metadata.dev() != opened_metadata.dev()
        || current_metadata.ino() != opened_metadata.ino()
        || opened_metadata.mode() & 0o7777 != 0o700
    {
        return Err(unsafe_owned_entry_error());
    }
    Ok(())
}

#[cfg(windows)]
fn harden_app_data_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    let path_metadata = fs::symlink_metadata(path)?;
    if !path_metadata.is_dir() || metadata_is_windows_reparse_point(&path_metadata) {
        return Err(unsafe_owned_entry_error());
    }
    let open_directory = || {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        options.open(path)
    };
    let directory = open_directory()?;
    let opened_metadata = directory.metadata()?;
    if !opened_metadata.is_dir() || metadata_is_windows_reparse_point(&opened_metadata) {
        return Err(unsafe_owned_entry_error());
    }
    let opened_facts = opened_file_facts(&directory)?;

    let current = open_directory()?;
    let current_metadata = current.metadata()?;
    let current_facts = opened_file_facts(&current)?;
    if !current_metadata.is_dir()
        || metadata_is_windows_reparse_point(&current_metadata)
        || current_facts.identity != opened_facts.identity
    {
        return Err(unsafe_owned_entry_error());
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn harden_app_data_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn lock_path_metadata_is_safe(metadata: &fs::Metadata) -> bool {
    metadata.is_file()
        && !metadata.file_type().is_symlink()
        && !metadata_is_windows_reparse_point(metadata)
        && metadata.len() == 0
        && metadata_has_one_link_when_available(metadata)
}

fn opened_file_is_safe_lock_entry(file: &File, path: &Path) -> std::io::Result<bool> {
    opened_file_is_single_link_regular_and_matches_path(file, path, true)
}

fn regular_path_is_single_link(path: &Path) -> std::io::Result<bool> {
    let file = open_path_without_following(path, false, false)?;
    opened_file_is_single_link_regular_and_matches_path(&file, path, false)
}

fn opened_file_is_single_link_regular_and_matches_path(
    file: &File,
    path: &Path,
    require_empty: bool,
) -> std::io::Result<bool> {
    let opened = opened_file_facts(file)?;
    if !opened.regular || opened.links != 1 || (require_empty && opened.length != 0) {
        return Ok(false);
    }
    let path_file = open_path_without_following(path, false, false)?;
    let current = opened_file_facts(&path_file)?;
    Ok(current.regular
        && current.links == 1
        && (!require_empty || current.length == 0)
        && current.identity == opened.identity)
}

fn open_path_without_following(path: &Path, write: bool, create: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(write)
        .create(create)
        .truncate(false);
    configure_open_without_following(&mut options);
    options.open(path)
}

#[cfg(unix)]
fn configure_open_without_following(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(windows)]
fn configure_open_without_following(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}

#[cfg(not(any(unix, windows)))]
fn configure_open_without_following(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn metadata_has_one_link_when_available(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() == 1
}

#[cfg(not(unix))]
fn metadata_has_one_link_when_available(_metadata: &fs::Metadata) -> bool {
    true
}

#[cfg(unix)]
fn opened_file_facts(file: &File) -> std::io::Result<OpenedFileFacts> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(OpenedFileFacts {
        identity: OpenedFileIdentity {
            volume: metadata.dev(),
            file: file_identity_from_u64(metadata.ino()),
        },
        links: metadata.nlink(),
        length: metadata.len(),
        regular: metadata.is_file(),
    })
}

#[cfg(windows)]
fn opened_file_facts(file: &File) -> std::io::Result<OpenedFileFacts> {
    use std::os::windows::io::AsRawHandle;

    opened_windows_handle_facts(file.as_raw_handle() as _)
}

#[cfg(windows)]
fn opened_windows_handle_facts(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> std::io::Result<OpenedFileFacts> {
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DEVICE, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let result = unsafe { GetFileInformationByHandle(handle, &mut information as *mut _) };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut file_id = FILE_ID_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut file_id as *mut FILE_ID_INFO).cast(),
            u32::try_from(std::mem::size_of::<FILE_ID_INFO>()).unwrap_or(u32::MAX),
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let attributes = information.dwFileAttributes;
    Ok(OpenedFileFacts {
        identity: OpenedFileIdentity {
            volume: file_id.VolumeSerialNumber,
            file: file_id.FileId.Identifier,
        },
        links: u64::from(information.nNumberOfLinks),
        length: (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow),
        regular: attributes
            & (FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            == 0,
    })
}

#[cfg(not(any(unix, windows)))]
fn opened_file_facts(file: &File) -> std::io::Result<OpenedFileFacts> {
    let metadata = file.metadata()?;
    Ok(OpenedFileFacts {
        identity: OpenedFileIdentity {
            volume: 0,
            file: [0; 16],
        },
        links: 1,
        length: metadata.len(),
        regular: metadata.is_file(),
    })
}

fn remove_path_without_following(path: &Path) -> Result<(), PersistenceErrorDto> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == IoErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(erase_error(
                PersistenceErrorCode::DeleteFailed,
                RetryPolicy::Manual,
            ));
        }
    };
    if metadata.file_type().is_symlink() || metadata_is_windows_reparse_point(&metadata) {
        return remove_reparse_entry(path, &metadata)
            .map_err(|_| erase_error(PersistenceErrorCode::DeleteFailed, RetryPolicy::Manual));
    }
    if !metadata.is_file()
        || !metadata_has_one_link_when_available(&metadata)
        || !regular_path_is_single_link(path).unwrap_or(false)
    {
        return Err(erase_error(
            PersistenceErrorCode::DeleteFailed,
            RetryPolicy::Manual,
        ));
    }
    fs::remove_file(path)
        .map_err(|_| erase_error(PersistenceErrorCode::DeleteFailed, RetryPolicy::Manual))
}

#[cfg(windows)]
fn metadata_is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn metadata_is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn remove_reparse_entry(path: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    if metadata.file_attributes() & 0x10 != 0 {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(not(windows))]
fn remove_reparse_entry(path: &Path, _metadata: &fs::Metadata) -> std::io::Result<()> {
    fs::remove_file(path)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    match File::open(parent)?.sync_all() {
        Err(error)
            if matches!(
                error.kind(),
                IoErrorKind::InvalidInput | IoErrorKind::Unsupported
            ) =>
        {
            Ok(())
        }
        result => result,
    }
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

fn erase_error(code: PersistenceErrorCode, retry: RetryPolicy) -> PersistenceErrorDto {
    persistence_error(RepositoryOperation::EraseAll, code, retry, None)
}

fn erase_marker_corrupt() -> PersistenceErrorDto {
    erase_error(PersistenceErrorCode::CorruptData, RetryPolicy::Never)
}

fn marker_read_boundary_error(error: std::io::Error) -> PersistenceErrorDto {
    if error.kind() == IoErrorKind::InvalidData {
        erase_marker_corrupt()
    } else {
        erase_error(PersistenceErrorCode::ReadFailed, RetryPolicy::Manual)
    }
}

fn erase_marker_corrupt_for(
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> PersistenceErrorDto {
    persistence_error(
        operation,
        PersistenceErrorCode::CorruptData,
        RetryPolicy::Never,
        project_id,
    )
}

fn erase_conflict() -> PersistenceErrorDto {
    erase_error(PersistenceErrorCode::Conflict, RetryPolicy::Manual)
}

fn repository_sealed(
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> PersistenceErrorDto {
    persistence_error(
        operation,
        PersistenceErrorCode::StorageUnavailable,
        RetryPolicy::Never,
        project_id,
    )
}

fn conflict(operation: RepositoryOperation, project_id: &str) -> PersistenceErrorDto {
    persistence_error(
        operation,
        PersistenceErrorCode::Conflict,
        RetryPolicy::Manual,
        Some(project_id),
    )
}

fn migration_conflict(operation: RepositoryOperation) -> PersistenceErrorDto {
    persistence_error(
        operation,
        PersistenceErrorCode::Conflict,
        RetryPolicy::Manual,
        None,
    )
}

fn migration_failure(operation: RepositoryOperation, retry: RetryPolicy) -> PersistenceErrorDto {
    persistence_error(
        operation,
        PersistenceErrorCode::MigrationFailed,
        retry,
        None,
    )
}

fn persistence_error(
    operation: RepositoryOperation,
    code: PersistenceErrorCode,
    retry: RetryPolicy,
    project_id: Option<&str>,
) -> PersistenceErrorDto {
    PersistenceErrorDto::new(operation, code, retry, project_id)
}

fn initialize_sql_error(error: SqliteError) -> PersistenceErrorDto {
    sqlite_error_to_persistence(
        error,
        RepositoryOperation::Initialize,
        None,
        PersistenceErrorCode::StorageUnavailable,
    )
}

fn migration_sql_error(_error: SqliteError) -> PersistenceErrorDto {
    persistence_error(
        RepositoryOperation::Initialize,
        PersistenceErrorCode::MigrationFailed,
        RetryPolicy::Never,
        None,
    )
}

fn read_sql_error(
    error: SqliteError,
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> PersistenceErrorDto {
    sqlite_error_to_persistence(
        error,
        operation,
        project_id,
        PersistenceErrorCode::ReadFailed,
    )
}

fn write_sql_error(error: SqliteError, project_id: Option<&str>) -> PersistenceErrorDto {
    sqlite_error_to_persistence(
        error,
        RepositoryOperation::Save,
        project_id,
        PersistenceErrorCode::WriteFailed,
    )
}

fn delete_sql_error(error: SqliteError, project_id: Option<&str>) -> PersistenceErrorDto {
    sqlite_error_to_persistence(
        error,
        RepositoryOperation::Remove,
        project_id,
        PersistenceErrorCode::DeleteFailed,
    )
}

fn sqlite_error_for_operation(
    error: SqliteError,
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> PersistenceErrorDto {
    let fallback = match operation {
        RepositoryOperation::Save => PersistenceErrorCode::WriteFailed,
        RepositoryOperation::Remove => PersistenceErrorCode::DeleteFailed,
        _ => PersistenceErrorCode::ReadFailed,
    };
    sqlite_error_to_persistence(error, operation, project_id, fallback)
}

fn sqlite_error_to_persistence(
    error: SqliteError,
    operation: RepositoryOperation,
    project_id: Option<&str>,
    fallback: PersistenceErrorCode,
) -> PersistenceErrorDto {
    let sqlite_code = match &error {
        SqliteError::SqliteFailure(error, _) => Some(error.code),
        _ => None,
    };
    let (code, retry) = match sqlite_code {
        Some(SqliteErrorCode::PermissionDenied | SqliteErrorCode::ReadOnly) => {
            (PersistenceErrorCode::AccessDenied, RetryPolicy::Manual)
        }
        Some(SqliteErrorCode::DiskFull) => {
            (PersistenceErrorCode::QuotaExceeded, RetryPolicy::Manual)
        }
        Some(SqliteErrorCode::DatabaseCorrupt | SqliteErrorCode::NotADatabase) => {
            (PersistenceErrorCode::CorruptData, RetryPolicy::Never)
        }
        Some(SqliteErrorCode::TooBig) => (PersistenceErrorCode::TooLarge, RetryPolicy::Never),
        Some(SqliteErrorCode::CannotOpen) => (
            PersistenceErrorCode::StorageUnavailable,
            RetryPolicy::Manual,
        ),
        Some(SqliteErrorCode::DatabaseBusy | SqliteErrorCode::DatabaseLocked) => {
            (fallback, RetryPolicy::Automatic)
        }
        _ => (fallback, RetryPolicy::Automatic),
    };
    persistence_error(operation, code, retry, project_id)
}

fn io_error_to_persistence(
    error: std::io::Error,
    operation: RepositoryOperation,
    project_id: Option<&str>,
) -> PersistenceErrorDto {
    let (code, retry) = match error.kind() {
        std::io::ErrorKind::PermissionDenied => {
            (PersistenceErrorCode::AccessDenied, RetryPolicy::Manual)
        }
        _ => (
            PersistenceErrorCode::StorageUnavailable,
            RetryPolicy::Automatic,
        ),
    };
    persistence_error(operation, code, retry, project_id)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
