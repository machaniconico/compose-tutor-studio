use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;

const MAIN_WINDOW_LABEL: &str = "main";
const SUGGESTED_FILENAME_HEADER: &str = "x-cts-suggested-filename";
const MAX_OPEN_FILENAME_UTF8_BYTES: usize = 1_024;
const MAX_SUGGESTED_FILENAME_UTF8_BYTES: usize = 240;
const MAX_SUGGESTED_FILENAME_HEADER_BYTES: usize = MAX_SUGGESTED_FILENAME_UTF8_BYTES * 3;
const PROJECT_MAX_BYTES: usize = 16 * 1024 * 1024;
const MIDI_MAX_BYTES: usize = 8 * 1024 * 1024;
const WAV_MAX_BYTES: usize = 192 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileFormat {
    Project,
    Midi,
    Wav,
}

impl FileFormat {
    fn maximum_bytes(self) -> usize {
        match self {
            Self::Project => PROJECT_MAX_BYTES,
            Self::Midi => MIDI_MAX_BYTES,
            Self::Wav => WAV_MAX_BYTES,
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            Self::Project => "Compose Tutor project",
            Self::Midi => "MIDI file",
            Self::Wav => "WAV audio",
        }
    }

    fn filter_extensions(self) -> &'static [&'static str] {
        match self {
            Self::Project => &["ctsproj.json", "json"],
            Self::Midi => &["mid", "midi"],
            Self::Wav => &["wav"],
        }
    }

    fn open_title(self) -> &'static str {
        match self {
            Self::Project => "Open a Compose Tutor project",
            Self::Midi => "Import a MIDI file",
            Self::Wav => "Open a WAV file",
        }
    }

    fn save_title(self) -> &'static str {
        match self {
            Self::Project => "Export Compose Tutor project",
            Self::Midi => "Export MIDI file",
            Self::Wav => "Export WAV audio",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeFileErrorCode {
    CallerNotAllowed,
    InvalidRequest,
    InvalidFilename,
    InvalidFile,
    FileTooLarge,
    DialogUnavailable,
    ReadFailed,
    WriteFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct NativeFileErrorDto {
    code: NativeFileErrorCode,
}

impl NativeFileErrorDto {
    const fn new(code: NativeFileErrorCode) -> Self {
        Self { code }
    }
}

type FileResult<T> = Result<T, NativeFileErrorDto>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SaveStatus {
    Saved,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct SaveFileResult {
    status: SaveStatus,
}

impl SaveFileResult {
    const fn saved() -> Self {
        Self {
            status: SaveStatus::Saved,
        }
    }

    const fn cancelled() -> Self {
        Self {
            status: SaveStatus::Cancelled,
        }
    }
}

fn ensure_main_caller_label(label: &str) -> FileResult<()> {
    if label == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err(NativeFileErrorDto::new(
            NativeFileErrorCode::CallerNotAllowed,
        ))
    }
}

fn ensure_main_caller(window: &WebviewWindow) -> FileResult<()> {
    ensure_main_caller_label(window.label())
}

fn ascii_suffix_start(value: &str, expected: &str) -> Option<usize> {
    let value = value.as_bytes();
    let expected = expected.as_bytes();
    let start = value.len().checked_sub(expected.len())?;
    value[start..]
        .eq_ignore_ascii_case(expected)
        .then_some(start)
}

fn extension_start(format: FileFormat, file_name: &str) -> Option<usize> {
    match format {
        FileFormat::Project => ascii_suffix_start(file_name, ".ctsproj.json")
            .or_else(|| ascii_suffix_start(file_name, ".json")),
        FileFormat::Midi => {
            ascii_suffix_start(file_name, ".midi").or_else(|| ascii_suffix_start(file_name, ".mid"))
        }
        FileFormat::Wav => ascii_suffix_start(file_name, ".wav"),
    }
}

fn has_expected_extension(format: FileFormat, file_name: &str) -> bool {
    match format {
        // The renderer deliberately accepts any JSON project filename on open.
        FileFormat::Project => ascii_suffix_start(file_name, ".json").is_some(),
        FileFormat::Midi => extension_start(format, file_name).is_some(),
        FileFormat::Wav => ascii_suffix_start(file_name, ".wav").is_some(),
    }
}

fn contains_open_filename_forbidden_character(file_name: &str) -> bool {
    file_name
        .chars()
        .any(|character| matches!(character, '\0'..='\u{1f}' | '\u{7f}' | '/' | '\\'))
}

fn contains_suggested_filename_forbidden_character(file_name: &str) -> bool {
    file_name.chars().any(|character| {
        matches!(
            character,
            '\0'..='\u{1f}' | '\u{7f}' | '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'
        )
    })
}

fn validate_open_file_name(format: FileFormat, file_name: &str) -> FileResult<()> {
    if file_name.is_empty()
        || matches!(file_name, "." | "..")
        || file_name.len() > MAX_OPEN_FILENAME_UTF8_BYTES
        || contains_open_filename_forbidden_character(file_name)
        || !has_expected_extension(format, file_name)
    {
        return Err(NativeFileErrorDto::new(
            NativeFileErrorCode::InvalidFilename,
        ));
    }
    Ok(())
}

fn is_windows_reserved_base(base: &str) -> bool {
    let bytes = base.as_bytes();
    ["con", "prn", "aux", "nul"]
        .iter()
        .any(|reserved| base.eq_ignore_ascii_case(reserved))
        || (bytes.len() == 4
            && (bytes[..3].eq_ignore_ascii_case(b"com") || bytes[..3].eq_ignore_ascii_case(b"lpt"))
            && matches!(bytes[3], b'1'..=b'9'))
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> &str {
    if value.len() <= maximum_bytes {
        return value;
    }

    let mut boundary = 0;
    for (offset, character) in value.char_indices() {
        let next = offset + character.len_utf8();
        if next > maximum_bytes {
            break;
        }
        boundary = next;
    }
    &value[..boundary]
}

fn normalize_suggested_file_name(format: FileFormat, file_name: &str) -> FileResult<String> {
    if file_name.is_empty()
        || matches!(file_name, "." | "..")
        || contains_suggested_filename_forbidden_character(file_name)
    {
        return Err(NativeFileErrorDto::new(
            NativeFileErrorCode::InvalidFilename,
        ));
    }

    let extension_start = extension_start(format, file_name)
        .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
    let extension = &file_name[extension_start..];
    let base = file_name[..extension_start].trim_end_matches(['.', ' ']);
    let base = if base.is_empty() { "project" } else { base };
    let safe_base = if is_windows_reserved_base(base) {
        format!("_{base}")
    } else {
        base.to_owned()
    };
    let base_budget = MAX_SUGGESTED_FILENAME_UTF8_BYTES
        .checked_sub(extension.len())
        .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
    let bounded_base = truncate_utf8(&safe_base, base_budget);
    let bounded_base = if bounded_base.is_empty() {
        "project"
    } else {
        bounded_base
    };
    let normalized = format!("{bounded_base}{extension}");
    validate_open_file_name(format, &normalized)?;
    Ok(normalized)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_encode_uri_component_literal(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

fn strict_percent_decode(value: &str) -> FileResult<String> {
    let source = value.as_bytes();
    let mut decoded = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            if index + 2 >= source.len() {
                return Err(NativeFileErrorDto::new(
                    NativeFileErrorCode::InvalidFilename,
                ));
            }
            let high = hex_value(source[index + 1])
                .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
            let low = hex_value(source[index + 2])
                .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
            decoded.push((high << 4) | low);
            index += 3;
        } else if source[index].is_ascii() && is_encode_uri_component_literal(source[index]) {
            decoded.push(source[index]);
            index += 1;
        } else {
            return Err(NativeFileErrorDto::new(
                NativeFileErrorCode::InvalidFilename,
            ));
        }
    }

    String::from_utf8(decoded)
        .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))
}

fn decode_suggested_file_name_header(encoded: &str, format: FileFormat) -> FileResult<String> {
    // `encodeURIComponent` can expand every UTF-8 byte to three ASCII bytes.
    // Reject overlong or non-ASCII input before allocating the decoded buffer.
    if encoded.is_empty()
        || encoded.len() > MAX_SUGGESTED_FILENAME_HEADER_BYTES
        || !encoded.is_ascii()
    {
        return Err(NativeFileErrorDto::new(
            NativeFileErrorCode::InvalidFilename,
        ));
    }
    normalize_suggested_file_name(format, &strict_percent_decode(encoded)?)
}

fn suggested_file_name_from_headers(
    headers: &tauri::http::HeaderMap,
    format: FileFormat,
) -> FileResult<String> {
    let values = headers.get_all(SUGGESTED_FILENAME_HEADER);
    let mut values = values.iter();
    let encoded = values
        .next()
        .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
    if values.next().is_some() {
        return Err(NativeFileErrorDto::new(
            NativeFileErrorCode::InvalidFilename,
        ));
    }
    let encoded = encoded
        .to_str()
        .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
    // Multiple values are rejected above. A proxy-combined value contains a
    // comma, which the strict encodeURIComponent grammar also rejects here.
    decode_suggested_file_name_header(encoded, format)
}

fn suggested_file_name(request: &Request<'_>, format: FileFormat) -> FileResult<String> {
    suggested_file_name_from_headers(request.headers(), format)
}

fn validate_payload_size(format: FileFormat, byte_length: usize) -> FileResult<()> {
    if byte_length > format.maximum_bytes() {
        return Err(NativeFileErrorDto::new(NativeFileErrorCode::FileTooLarge));
    }
    if byte_length == 0 {
        return Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidFile));
    }
    Ok(())
}

fn has_ascii(bytes: &[u8], offset: usize, expected: &[u8]) -> bool {
    bytes.get(offset..offset.saturating_add(expected.len())) == Some(expected)
}

fn validate_file_bytes(format: FileFormat, bytes: &[u8]) -> FileResult<()> {
    validate_payload_size(format, bytes.len())?;
    let valid = match format {
        FileFormat::Project => crate::native_persistence::validate_project_file_json(bytes),
        FileFormat::Midi => bytes.len() >= 14 && has_ascii(bytes, 0, b"MThd"),
        FileFormat::Wav => {
            bytes.len() >= 12 && has_ascii(bytes, 0, b"RIFF") && has_ascii(bytes, 8, b"WAVE")
        }
    };
    if !valid {
        return Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidFile));
    }
    Ok(())
}

fn clone_bounded_raw_body(body: &InvokeBody, format: FileFormat) -> FileResult<Vec<u8>> {
    let InvokeBody::Raw(bytes) = body else {
        return Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidRequest));
    };
    // `Request` deliberately exposes only a borrowed body. A single bounded
    // copy is therefore required to move validation and writing to blocking
    // workers without retaining an IPC borrow across `.await` points.
    validate_payload_size(format, bytes.len())?;
    Ok(bytes.clone())
}

fn cancelled_open_envelope() -> Vec<u8> {
    vec![0]
}

fn opened_file_envelope(format: FileFormat, file_name: &str, bytes: &[u8]) -> FileResult<Vec<u8>> {
    validate_open_file_name(format, file_name)?;
    validate_file_bytes(format, bytes)?;
    let file_name_length = u32::try_from(file_name.len())
        .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
    let mut envelope = Vec::with_capacity(5 + file_name.len() + bytes.len());
    envelope.push(1);
    envelope.extend_from_slice(&file_name_length.to_le_bytes());
    envelope.extend_from_slice(file_name.as_bytes());
    envelope.extend_from_slice(bytes);
    Ok(envelope)
}

fn read_selected_file(format: FileFormat, path: &Path) -> FileResult<Vec<u8>> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
    validate_open_file_name(format, file_name)?;

    // Open first and inspect that exact handle. Looking up metadata by path and
    // opening later would permit the selected entry to change between checks.
    let mut file =
        File::open(path).map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::ReadFailed))?;
    let metadata = file
        .metadata()
        .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::ReadFailed))?;
    if !metadata.is_file() {
        return Err(NativeFileErrorDto::new(NativeFileErrorCode::ReadFailed));
    }
    if metadata.len() == 0 {
        return Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidFile));
    }
    if metadata.len() > format.maximum_bytes() as u64 {
        return Err(NativeFileErrorDto::new(NativeFileErrorCode::FileTooLarge));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(format.maximum_bytes() as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::ReadFailed))?;
    opened_file_envelope(format, file_name, &bytes)
}

fn open_selected_file(format: FileFormat, path: Option<PathBuf>) -> FileResult<Vec<u8>> {
    match path {
        Some(path) => read_selected_file(format, &path),
        None => Ok(cancelled_open_envelope()),
    }
}

fn validate_selected_save_path(format: FileFormat, path: &Path) -> FileResult<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
    validate_open_file_name(format, file_name)?;
    if file_name.len() > MAX_SUGGESTED_FILENAME_UTF8_BYTES
        || contains_suggested_filename_forbidden_character(file_name)
    {
        return Err(NativeFileErrorDto::new(
            NativeFileErrorCode::InvalidFilename,
        ));
    }
    let extension_start = extension_start(format, file_name)
        .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
    let base = &file_name[..extension_start];
    if base.is_empty()
        || base.ends_with(['.', ' '])
        || base.split('.').next().is_some_and(is_windows_reserved_base)
    {
        return Err(NativeFileErrorDto::new(
            NativeFileErrorCode::InvalidFilename,
        ));
    }
    Ok(())
}

fn atomic_replace_with(
    path: &Path,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> FileResult<()> {
    AtomicFile::new(path, AllowOverwrite)
        .write(write)
        .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::WriteFailed))
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> FileResult<()> {
    atomic_replace_with(path, |file| file.write_all(bytes))
}

fn write_selected_file(
    format: FileFormat,
    path: Option<PathBuf>,
    bytes: &[u8],
) -> FileResult<SaveFileResult> {
    let Some(path) = path else {
        return Ok(SaveFileResult::cancelled());
    };
    // The native dialog already returns the path the user chose. Never append,
    // replace, or otherwise retarget that path after selection.
    validate_selected_save_path(format, &path)?;
    atomic_replace(&path, bytes)?;
    Ok(SaveFileResult::saved())
}

async fn choose_open_path(
    window: &WebviewWindow,
    format: FileFormat,
) -> FileResult<Option<PathBuf>> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let dialog = window
        .dialog()
        .file()
        .add_filter(format.filter_name(), format.filter_extensions())
        .set_title(format.open_title());
    #[cfg(desktop)]
    let dialog = dialog.set_parent(window);
    dialog.pick_file(move |selected| {
        let _ = sender.blocking_send(selected);
    });
    receiver
        .recv()
        .await
        .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::DialogUnavailable))?
        .map(|path| {
            path.into_path()
                .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::DialogUnavailable))
        })
        .transpose()
}

async fn choose_save_path(
    window: &WebviewWindow,
    format: FileFormat,
    suggested_file_name: String,
) -> FileResult<Option<PathBuf>> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let dialog = window
        .dialog()
        .file()
        .add_filter(format.filter_name(), format.filter_extensions())
        .set_file_name(suggested_file_name)
        .set_title(format.save_title());
    #[cfg(desktop)]
    let dialog = dialog.set_parent(window);
    dialog.save_file(move |selected| {
        let _ = sender.blocking_send(selected);
    });
    receiver
        .recv()
        .await
        .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::DialogUnavailable))?
        .map(|path| {
            path.into_path()
                .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::DialogUnavailable))
        })
        .transpose()
}

async fn open_file(window: WebviewWindow, format: FileFormat) -> FileResult<Response> {
    ensure_main_caller(&window)?;
    let path = choose_open_path(&window, format).await?;
    let envelope = tauri::async_runtime::spawn_blocking(move || open_selected_file(format, path))
        .await
        .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::ReadFailed))??;
    Ok(Response::new(envelope))
}

async fn export_file(
    window: WebviewWindow,
    request: Request<'_>,
    format: FileFormat,
) -> FileResult<SaveFileResult> {
    ensure_main_caller(&window)?;
    let suggested_file_name = suggested_file_name(&request, format)?;
    let bytes = clone_bounded_raw_body(request.body(), format)?;
    // No `Request<'_>` reference is retained across the worker/dialog awaits.
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        validate_file_bytes(format, &bytes)?;
        Ok::<_, NativeFileErrorDto>(bytes)
    })
    .await
    .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFile))??;
    let path = choose_save_path(&window, format, suggested_file_name).await?;
    tauri::async_runtime::spawn_blocking(move || write_selected_file(format, path, &bytes))
        .await
        .map_err(|_| NativeFileErrorDto::new(NativeFileErrorCode::WriteFailed))?
}

#[tauri::command]
pub(crate) async fn file_open_project(window: WebviewWindow) -> FileResult<Response> {
    open_file(window, FileFormat::Project).await
}

#[tauri::command]
pub(crate) async fn file_open_midi(window: WebviewWindow) -> FileResult<Response> {
    open_file(window, FileFormat::Midi).await
}

#[tauri::command]
pub(crate) async fn file_export_project(
    window: WebviewWindow,
    request: Request<'_>,
) -> FileResult<SaveFileResult> {
    export_file(window, request, FileFormat::Project).await
}

#[tauri::command]
pub(crate) async fn file_export_midi(
    window: WebviewWindow,
    request: Request<'_>,
) -> FileResult<SaveFileResult> {
    export_file(window, request, FileFormat::Midi).await
}

#[tauri::command]
pub(crate) async fn file_export_wav(
    window: WebviewWindow,
    request: Request<'_>,
) -> FileResult<SaveFileResult> {
    export_file(window, request, FileFormat::Wav).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    const VALID_PROJECT: &[u8] = br#"{
        "id":"project-test",
        "schemaVersion":1,
        "title":"Test",
        "bpm":120,
        "timeSignature":[4,4],
        "key":"C",
        "scale":"major",
        "lengthBars":4,
        "tracks":[],
        "chordTrack":[],
        "sections":[],
        "createdAt":"2026-07-10T00:00:00.000Z",
        "updatedAt":"2026-07-10T00:00:00.000Z"
    }"#;

    fn valid_midi() -> Vec<u8> {
        let mut bytes = b"MThd".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 6, 0, 0, 0, 1, 0, 96]);
        bytes
    }

    fn valid_wav() -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[4, 0, 0, 0]);
        bytes.extend_from_slice(b"WAVE");
        bytes
    }

    #[test]
    fn accepts_only_the_main_window_label() {
        assert_eq!(ensure_main_caller_label("main"), Ok(()));
        assert_eq!(
            ensure_main_caller_label("settings"),
            Err(NativeFileErrorDto::new(
                NativeFileErrorCode::CallerNotAllowed
            ))
        );
        assert!(ensure_main_caller_label("Main").is_err());
    }

    #[test]
    fn serializes_exact_status_and_error_wire_values() {
        assert_eq!(
            serde_json::to_string(&SaveFileResult::saved()).unwrap(),
            r#"{"status":"saved"}"#
        );
        assert_eq!(
            serde_json::to_string(&SaveFileResult::cancelled()).unwrap(),
            r#"{"status":"cancelled"}"#
        );
        for (code, expected) in [
            (NativeFileErrorCode::CallerNotAllowed, "caller-not-allowed"),
            (NativeFileErrorCode::InvalidRequest, "invalid-request"),
            (NativeFileErrorCode::InvalidFilename, "invalid-filename"),
            (NativeFileErrorCode::InvalidFile, "invalid-file"),
            (NativeFileErrorCode::FileTooLarge, "file-too-large"),
            (NativeFileErrorCode::DialogUnavailable, "dialog-unavailable"),
            (NativeFileErrorCode::ReadFailed, "read-failed"),
            (NativeFileErrorCode::WriteFailed, "write-failed"),
        ] {
            assert_eq!(
                serde_json::to_string(&NativeFileErrorDto::new(code)).unwrap(),
                format!(r#"{{"code":"{expected}"}}"#)
            );
        }
        assert_eq!(serde_json::to_string(&()).unwrap(), "null");
    }

    #[test]
    fn builds_exact_open_envelopes_without_paths() {
        assert_eq!(cancelled_open_envelope(), vec![0]);
        let bytes = valid_midi();
        let envelope = opened_file_envelope(FileFormat::Midi, "song.mid", &bytes).unwrap();
        assert_eq!(envelope[0], 1);
        assert_eq!(u32::from_le_bytes(envelope[1..5].try_into().unwrap()), 8);
        assert_eq!(&envelope[5..13], b"song.mid");
        assert_eq!(&envelope[13..], bytes);
        assert!(!String::from_utf8_lossy(&envelope).contains("/tmp/"));
    }

    #[test]
    fn validates_open_filenames_and_utf8_byte_limit() {
        assert!(validate_open_file_name(FileFormat::Project, "song.ctsproj.json").is_ok());
        assert!(validate_open_file_name(FileFormat::Project, "song.JSON").is_ok());
        assert!(validate_open_file_name(FileFormat::Midi, "song.midi").is_ok());
        for invalid in ["", ".", "..", "../song.mid", "folder/song.mid", "song.txt"] {
            assert!(validate_open_file_name(FileFormat::Midi, invalid).is_err());
        }
        let too_long = format!("{}.mid", "界".repeat(341));
        assert!(too_long.len() > MAX_OPEN_FILENAME_UTF8_BYTES);
        assert!(validate_open_file_name(FileFormat::Midi, &too_long).is_err());
    }

    #[test]
    fn percent_decoder_matches_encode_uri_component_literals() {
        assert_eq!(
            strict_percent_decode("My%20Song%20%F0%9F%8E%B5.mid").unwrap(),
            "My Song 🎵.mid"
        );
        assert_eq!(
            strict_percent_decode("AZaz09-_.!~*'().mid").unwrap(),
            "AZaz09-_.!~*'().mid"
        );
        for invalid in ["song%", "song%2", "song%XZ.mid", "song+name.mid", "🎵.mid"] {
            assert!(
                strict_percent_decode(invalid).is_err(),
                "accepted {invalid}"
            );
        }
        assert!(strict_percent_decode("%FF.mid").is_err());
    }

    #[test]
    fn bounds_and_strictly_decodes_the_suggested_filename_header() {
        let exactly_at_limit = format!("{}aa.mid", "%61".repeat(238));
        assert_eq!(exactly_at_limit.len(), MAX_SUGGESTED_FILENAME_HEADER_BYTES);
        let decoded =
            decode_suggested_file_name_header(&exactly_at_limit, FileFormat::Midi).unwrap();
        assert_eq!(decoded.len(), MAX_SUGGESTED_FILENAME_UTF8_BYTES);
        assert!(decoded.ends_with(".mid"));

        let over_limit = format!("{exactly_at_limit}a");
        assert_eq!(over_limit.len(), MAX_SUGGESTED_FILENAME_HEADER_BYTES + 1);
        assert!(decode_suggested_file_name_header(&over_limit, FileFormat::Midi).is_err());
        assert!(decode_suggested_file_name_header("song.mid,song2.mid", FileFormat::Midi).is_err());
        assert!(decode_suggested_file_name_header("song%2.mid", FileFormat::Midi).is_err());
        assert!(decode_suggested_file_name_header("🎵.mid", FileFormat::Midi).is_err());
    }

    #[test]
    fn requires_exactly_one_suggested_filename_header_value() {
        let mut headers = tauri::http::HeaderMap::new();
        assert!(suggested_file_name_from_headers(&headers, FileFormat::Midi).is_err());

        headers.insert(
            SUGGESTED_FILENAME_HEADER,
            tauri::http::HeaderValue::from_static("song.mid"),
        );
        assert_eq!(
            suggested_file_name_from_headers(&headers, FileFormat::Midi).unwrap(),
            "song.mid"
        );

        headers.append(
            SUGGESTED_FILENAME_HEADER,
            tauri::http::HeaderValue::from_static("other.mid"),
        );
        assert!(suggested_file_name_from_headers(&headers, FileFormat::Midi).is_err());

        headers.insert(
            SUGGESTED_FILENAME_HEADER,
            tauri::http::HeaderValue::from_static("song.mid,other.mid"),
        );
        assert!(suggested_file_name_from_headers(&headers, FileFormat::Midi).is_err());
    }

    #[test]
    fn normalizes_suggested_filenames_like_the_renderer() {
        assert_eq!(
            normalize_suggested_file_name(FileFormat::Project, "Sketch... .CTSProj.JSON").unwrap(),
            "Sketch.CTSProj.JSON"
        );
        assert_eq!(
            normalize_suggested_file_name(FileFormat::Midi, "CON.mid").unwrap(),
            "_CON.mid"
        );
        assert_eq!(
            normalize_suggested_file_name(FileFormat::Wav, " .wav").unwrap(),
            "project.wav"
        );
        assert_eq!(
            normalize_suggested_file_name(FileFormat::Midi, "🎵.mid").unwrap(),
            "🎵.mid"
        );
        for invalid in [
            "song",
            "song.exe",
            "../song.mid",
            "bad:name.mid",
            "bad\0.mid",
        ] {
            assert!(
                normalize_suggested_file_name(FileFormat::Midi, invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn truncates_at_utf8_boundaries_and_preserves_exact_suffix() {
        let input = format!("{}.MiDi", "楽".repeat(100));
        let normalized = normalize_suggested_file_name(FileFormat::Midi, &input).unwrap();
        assert!(normalized.len() <= MAX_SUGGESTED_FILENAME_UTF8_BYTES);
        assert!(normalized.ends_with(".MiDi"));
        assert!(normalized.is_char_boundary(normalized.len() - ".MiDi".len()));
        assert_eq!(normalized.len(), 239);

        let exact = format!("{}.mid", "a".repeat(236));
        assert_eq!(exact.len(), MAX_SUGGESTED_FILENAME_UTF8_BYTES);
        assert_eq!(
            normalize_suggested_file_name(FileFormat::Midi, &exact).unwrap(),
            exact
        );
        let truncated =
            normalize_suggested_file_name(FileFormat::Midi, &format!("{}.mid", "a".repeat(237)))
                .unwrap();
        assert_eq!(truncated.len(), MAX_SUGGESTED_FILENAME_UTF8_BYTES);
    }

    #[test]
    fn validates_sizes_without_allocating_limit_sized_buffers() {
        for format in [FileFormat::Project, FileFormat::Midi, FileFormat::Wav] {
            assert!(validate_payload_size(format, 0).is_err());
            assert!(validate_payload_size(format, format.maximum_bytes()).is_ok());
            assert_eq!(
                validate_payload_size(format, format.maximum_bytes() + 1),
                Err(NativeFileErrorDto::new(NativeFileErrorCode::FileTooLarge))
            );
        }
    }

    #[test]
    fn clones_only_prebounded_raw_request_bodies() {
        let midi = valid_midi();
        let cloned =
            clone_bounded_raw_body(&InvokeBody::Raw(midi.clone()), FileFormat::Midi).unwrap();
        assert_eq!(cloned, midi);
        assert_eq!(
            clone_bounded_raw_body(&InvokeBody::Json(serde_json::json!([])), FileFormat::Midi),
            Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidRequest))
        );
    }

    #[test]
    fn validates_project_midi_and_wav_contents() {
        assert!(validate_file_bytes(FileFormat::Project, VALID_PROJECT).is_ok());
        assert!(validate_file_bytes(FileFormat::Project, b"{}").is_err());
        assert!(validate_file_bytes(FileFormat::Project, b"\xff").is_err());

        assert!(validate_file_bytes(FileFormat::Midi, &valid_midi()).is_ok());
        assert!(validate_file_bytes(FileFormat::Midi, b"MThd").is_err());
        let mut wrong_midi = valid_midi();
        wrong_midi[0] = b'X';
        assert!(validate_file_bytes(FileFormat::Midi, &wrong_midi).is_err());

        assert!(validate_file_bytes(FileFormat::Wav, &valid_wav()).is_ok());
        assert!(validate_file_bytes(FileFormat::Wav, b"RIFF1234NOPE").is_err());
    }

    #[test]
    fn bounded_open_reads_file_name_and_bytes_but_not_path() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("piece.mid");
        let bytes = valid_midi();
        fs::write(&path, &bytes).unwrap();

        let envelope = open_selected_file(FileFormat::Midi, Some(path)).unwrap();
        assert_eq!(&envelope[5..14], b"piece.mid");
        assert_eq!(&envelope[14..], bytes);
        assert_eq!(
            open_selected_file(FileFormat::Midi, None).unwrap(),
            cancelled_open_envelope()
        );
    }

    #[test]
    fn rejects_oversized_file_from_metadata_before_reading() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("large.mid");
        let file = File::create(&path).unwrap();
        file.set_len(MIDI_MAX_BYTES as u64 + 1).unwrap();
        assert_eq!(
            read_selected_file(FileFormat::Midi, &path),
            Err(NativeFileErrorDto::new(NativeFileErrorCode::FileTooLarge))
        );
    }

    #[test]
    fn atomically_overwrites_and_handles_cancelled_save() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("song.mid");
        atomic_replace(&path, b"first").unwrap();
        atomic_replace(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");

        assert_eq!(
            write_selected_file(FileFormat::Midi, None, &valid_midi()).unwrap(),
            SaveFileResult::cancelled()
        );
    }

    #[test]
    fn atomic_write_failure_leaves_the_original_file_intact() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("song.mid");
        fs::write(&path, b"original").unwrap();

        let result = atomic_replace_with(&path, |temporary| {
            temporary.write_all(b"partial")?;
            Err(std::io::Error::other("injected write failure"))
        });
        assert_eq!(
            result,
            Err(NativeFileErrorDto::new(NativeFileErrorCode::WriteFailed))
        );
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[test]
    fn writes_only_to_the_exact_valid_selected_path() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("song.mid");
        let bytes = valid_midi();
        assert_eq!(
            write_selected_file(FileFormat::Midi, Some(path.clone()), &bytes).unwrap(),
            SaveFileResult::saved()
        );
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn rejects_invalid_selected_leaf_without_retargeting_or_overwriting() {
        let directory = tempdir().unwrap();
        let wrong_suffix = directory.path().join("song.backup");
        fs::write(&wrong_suffix, b"original").unwrap();

        assert_eq!(
            write_selected_file(FileFormat::Midi, Some(wrong_suffix.clone()), &valid_midi()),
            Err(NativeFileErrorDto::new(
                NativeFileErrorCode::InvalidFilename
            ))
        );
        assert_eq!(fs::read(&wrong_suffix).unwrap(), b"original");
        assert!(!directory.path().join("song.mid").exists());

        let exact_limit = format!("{}.mid", "a".repeat(236));
        assert!(
            validate_selected_save_path(FileFormat::Midi, &directory.path().join(exact_limit))
                .is_ok()
        );
        let over_limit = format!("{}.mid", "a".repeat(237));
        assert!(
            validate_selected_save_path(FileFormat::Midi, &directory.path().join(over_limit))
                .is_err()
        );

        for leaf in [
            ".mid",
            "CON.mid",
            "CON.backup.mid",
            "song .mid",
            "song?.mid",
        ] {
            assert!(
                validate_selected_save_path(FileFormat::Midi, &directory.path().join(leaf))
                    .is_err()
            );
        }
    }
}
