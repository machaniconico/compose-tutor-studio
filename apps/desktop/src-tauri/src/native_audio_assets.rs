use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    State, WebviewWindow,
};

use crate::native_persistence::{NativePersistenceState, NativeRepository};

pub(crate) const AUDIO_ASSET_MAX_BYTES: usize = 128 * 1024 * 1024;
const MAIN_WINDOW_LABEL: &str = "main";
const CHECKSUM_HEADER: &str = "x-cts-audio-checksum-sha256";
const BYTE_LENGTH_HEADER: &str = "x-cts-audio-byte-length";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AudioAssetErrorCode {
    InvalidRequest,
    TooLarge,
    ChecksumMismatch,
    LengthMismatch,
    Missing,
    Corrupt,
    StorageUnavailable,
    AccessDenied,
    ReadFailed,
    WriteFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct AudioAssetErrorDto {
    pub(crate) code: AudioAssetErrorCode,
}

impl AudioAssetErrorDto {
    pub(crate) const fn new(code: AudioAssetErrorCode) -> Self {
        Self { code }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AudioAssetReadRequest {
    pub(crate) checksum_sha256: String,
    pub(crate) expected_byte_length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioAssetStoreReceipt {
    pub(crate) checksum_sha256: String,
    pub(crate) byte_length: u64,
    pub(crate) deduplicated: bool,
}

type AudioAssetResult<T> = Result<T, AudioAssetErrorDto>;

fn ensure_main_caller_label(label: &str) -> AudioAssetResult<()> {
    if label == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err(AudioAssetErrorDto::new(AudioAssetErrorCode::AccessDenied))
    }
}

fn ensure_main_caller(window: &WebviewWindow) -> AudioAssetResult<()> {
    ensure_main_caller_label(window.label())
}

fn exact_header(request: &Request<'_>, name: &str) -> AudioAssetResult<String> {
    let values = request.headers().get_all(name);
    let mut iter = values.iter();
    let value = iter
        .next()
        .ok_or_else(|| AudioAssetErrorDto::new(AudioAssetErrorCode::InvalidRequest))?;
    if iter.next().is_some() {
        return Err(AudioAssetErrorDto::new(AudioAssetErrorCode::InvalidRequest));
    }
    value
        .to_str()
        .map(str::to_owned)
        .map_err(|_| AudioAssetErrorDto::new(AudioAssetErrorCode::InvalidRequest))
}

fn request_identity(request: &Request<'_>) -> AudioAssetResult<(String, usize)> {
    let checksum = exact_header(request, CHECKSUM_HEADER)?;
    if !valid_checksum(&checksum) {
        return Err(AudioAssetErrorDto::new(AudioAssetErrorCode::InvalidRequest));
    }
    let length = exact_header(request, BYTE_LENGTH_HEADER)?;
    let parsed = length
        .parse::<usize>()
        .map_err(|_| AudioAssetErrorDto::new(AudioAssetErrorCode::InvalidRequest))?;
    if parsed == 0 || parsed > AUDIO_ASSET_MAX_BYTES || length != parsed.to_string() {
        return Err(AudioAssetErrorDto::new(if parsed > AUDIO_ASSET_MAX_BYTES {
            AudioAssetErrorCode::TooLarge
        } else {
            AudioAssetErrorCode::InvalidRequest
        }));
    }
    Ok((checksum, parsed))
}

fn raw_body(request: &Request<'_>, expected_length: usize) -> AudioAssetResult<Vec<u8>> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err(AudioAssetErrorDto::new(AudioAssetErrorCode::InvalidRequest)),
    };
    if bytes.len() > AUDIO_ASSET_MAX_BYTES {
        return Err(AudioAssetErrorDto::new(AudioAssetErrorCode::TooLarge));
    }
    if bytes.len() != expected_length {
        return Err(AudioAssetErrorDto::new(AudioAssetErrorCode::LengthMismatch));
    }
    Ok(bytes.clone())
}

pub(crate) fn valid_checksum(checksum: &str) -> bool {
    checksum.len() == 64
        && checksum
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn validate_read_request(request: &AudioAssetReadRequest) -> AudioAssetResult<usize> {
    if !valid_checksum(&request.checksum_sha256) {
        return Err(AudioAssetErrorDto::new(AudioAssetErrorCode::InvalidRequest));
    }
    let length = usize::try_from(request.expected_byte_length)
        .map_err(|_| AudioAssetErrorDto::new(AudioAssetErrorCode::TooLarge))?;
    if length == 0 || length > AUDIO_ASSET_MAX_BYTES {
        return Err(AudioAssetErrorDto::new(if length > AUDIO_ASSET_MAX_BYTES {
            AudioAssetErrorCode::TooLarge
        } else {
            AudioAssetErrorCode::InvalidRequest
        }));
    }
    Ok(length)
}

async fn run_blocking<T: Send + 'static>(
    repository: Arc<NativeRepository>,
    fallback: AudioAssetErrorCode,
    action: impl FnOnce(Arc<NativeRepository>) -> AudioAssetResult<T> + Send + 'static,
) -> AudioAssetResult<T> {
    tauri::async_runtime::spawn_blocking(move || action(repository))
        .await
        .map_err(|_| AudioAssetErrorDto::new(fallback))?
}

#[tauri::command]
pub(crate) async fn audio_asset_store(
    window: WebviewWindow,
    request: Request<'_>,
    state: State<'_, NativePersistenceState>,
) -> AudioAssetResult<AudioAssetStoreReceipt> {
    ensure_main_caller(&window)?;
    let (checksum, expected_length) = request_identity(&request)?;
    let bytes = raw_body(&request, expected_length)?;
    run_blocking(
        state.repository(),
        AudioAssetErrorCode::WriteFailed,
        move |repository| repository.store_audio_asset(checksum, expected_length, bytes),
    )
    .await
}

#[tauri::command]
pub(crate) async fn audio_asset_read(
    window: WebviewWindow,
    state: State<'_, NativePersistenceState>,
    request: AudioAssetReadRequest,
) -> AudioAssetResult<Response> {
    ensure_main_caller(&window)?;
    let expected_length = validate_read_request(&request)?;
    let checksum = request.checksum_sha256;
    let bytes = run_blocking(
        state.repository(),
        AudioAssetErrorCode::ReadFailed,
        move |repository| repository.read_audio_asset(checksum, expected_length),
    )
    .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub(crate) async fn audio_asset_verify(
    window: WebviewWindow,
    state: State<'_, NativePersistenceState>,
    request: AudioAssetReadRequest,
) -> AudioAssetResult<()> {
    ensure_main_caller(&window)?;
    let expected_length = validate_read_request(&request)?;
    let checksum = request.checksum_sha256;
    run_blocking(
        state.repository(),
        AudioAssetErrorCode::ReadFailed,
        move |repository| repository.verify_audio_asset(checksum, expected_length),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::{HeaderMap, HeaderValue};

    #[test]
    fn checksum_contract_is_lowercase_sha256_only() {
        assert!(valid_checksum(&"a0".repeat(32)));
        assert!(!valid_checksum(&"A0".repeat(32)));
        assert!(!valid_checksum("../asset"));
        assert!(!valid_checksum(&"a".repeat(63)));
    }

    #[test]
    fn only_the_main_webview_can_access_audio_assets() {
        assert_eq!(ensure_main_caller_label("main"), Ok(()));
        assert_eq!(
            ensure_main_caller_label("settings"),
            Err(AudioAssetErrorDto::new(AudioAssetErrorCode::AccessDenied))
        );
        assert!(ensure_main_caller_label("Main").is_err());
    }

    #[test]
    fn exact_headers_reject_duplicates() {
        let mut headers = HeaderMap::new();
        headers.append(CHECKSUM_HEADER, HeaderValue::from_static("a"));
        headers.append(CHECKSUM_HEADER, HeaderValue::from_static("b"));
        assert_eq!(
            headers.get_all(CHECKSUM_HEADER).iter().count(),
            2,
            "test must exercise the duplicate-header boundary"
        );
    }
}
