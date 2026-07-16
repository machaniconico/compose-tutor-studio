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
const SOURCE_AUDIO_MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_SOURCE_AUDIO_STRUCTURE_ITEMS: usize = 100_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileFormat {
    Project,
    Midi,
    Wav,
    SourceAudio,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceAudioFormat {
    Wav,
    Mp3,
    M4a,
    Aac,
}

impl FileFormat {
    fn maximum_bytes(self) -> usize {
        match self {
            Self::Project => PROJECT_MAX_BYTES,
            Self::Midi => MIDI_MAX_BYTES,
            Self::Wav => WAV_MAX_BYTES,
            Self::SourceAudio => SOURCE_AUDIO_MAX_BYTES,
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            Self::Project => "Compose Tutor project",
            Self::Midi => "MIDI file",
            Self::Wav => "WAV audio",
            Self::SourceAudio => "Supported audio",
        }
    }

    fn filter_extensions(self) -> &'static [&'static str] {
        match self {
            Self::Project => &["ctsproj.json", "json"],
            Self::Midi => &["mid", "midi"],
            Self::Wav => &["wav"],
            Self::SourceAudio => &["wav", "mp3", "m4a", "aac"],
        }
    }

    fn open_title(self) -> &'static str {
        match self {
            Self::Project => "Open a Compose Tutor project",
            Self::Midi => "Import a MIDI file",
            Self::Wav => "Open a WAV file",
            Self::SourceAudio => "Open source audio",
        }
    }

    fn save_title(self) -> &'static str {
        match self {
            Self::Project => "Export Compose Tutor project",
            Self::Midi => "Export MIDI file",
            Self::Wav => "Export WAV audio",
            Self::SourceAudio => "Export source audio",
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
        FileFormat::SourceAudio => source_audio_format(file_name).map(|(_, start)| start),
    }
}

fn source_audio_format(file_name: &str) -> Option<(SourceAudioFormat, usize)> {
    [
        (SourceAudioFormat::Wav, ".wav"),
        (SourceAudioFormat::Mp3, ".mp3"),
        (SourceAudioFormat::M4a, ".m4a"),
        (SourceAudioFormat::Aac, ".aac"),
    ]
    .into_iter()
    .find_map(|(format, extension)| {
        ascii_suffix_start(file_name, extension).map(|start| (format, start))
    })
}

fn has_expected_extension(format: FileFormat, file_name: &str) -> bool {
    match format {
        // The renderer deliberately accepts any JSON project filename on open.
        FileFormat::Project => ascii_suffix_start(file_name, ".json").is_some(),
        FileFormat::Midi => extension_start(format, file_name).is_some(),
        FileFormat::Wav => ascii_suffix_start(file_name, ".wav").is_some(),
        FileFormat::SourceAudio => source_audio_format(file_name).is_some(),
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

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn read_u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn read_u64_be(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_be_bytes(
        bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?,
    ))
}

#[derive(Debug)]
struct StructureScanBudget {
    remaining: usize,
}

impl StructureScanBudget {
    const fn new(maximum_items: usize) -> Self {
        Self {
            remaining: maximum_items,
        }
    }

    fn consume(&mut self) -> Option<()> {
        self.remaining = self.remaining.checked_sub(1)?;
        Some(())
    }
}

fn source_wav_magic_matches(bytes: &[u8]) -> bool {
    let mut budget = StructureScanBudget::new(MAX_SOURCE_AUDIO_STRUCTURE_ITEMS);
    source_wav_magic_matches_with_budget(bytes, &mut budget)
}

fn source_wav_magic_matches_with_budget(bytes: &[u8], budget: &mut StructureScanBudget) -> bool {
    if bytes.len() < 12 || !has_ascii(bytes, 0, b"RIFF") || !has_ascii(bytes, 8, b"WAVE") {
        return false;
    }
    let Some(riff_end) = read_u32_le(bytes, 4)
        .and_then(|size| usize::try_from(size).ok())
        .and_then(|size| size.checked_add(8))
    else {
        return false;
    };
    if riff_end != bytes.len() {
        return false;
    }

    let mut offset = 12usize;
    let mut has_format = false;
    let mut has_audio_data = false;
    while offset < riff_end {
        if budget.consume().is_none() {
            return false;
        }
        let Some(chunk_size) =
            read_u32_le(bytes, offset + 4).and_then(|size| usize::try_from(size).ok())
        else {
            return false;
        };
        let Some(data_start) = offset.checked_add(8) else {
            return false;
        };
        let Some(data_end) = data_start.checked_add(chunk_size) else {
            return false;
        };
        if data_end > riff_end {
            return false;
        }
        if has_ascii(bytes, offset, b"fmt ") && chunk_size >= 16 {
            has_format = true;
        }
        if has_ascii(bytes, offset, b"data") && chunk_size > 0 {
            has_audio_data = true;
        }
        let Some(next) = data_end.checked_add(chunk_size & 1) else {
            return false;
        };
        if next > riff_end {
            return false;
        }
        offset = next;
    }
    offset == riff_end && has_format && has_audio_data
}

fn id3_audio_offset(bytes: &[u8]) -> Option<usize> {
    if !has_ascii(bytes, 0, b"ID3") {
        return Some(0);
    }
    if bytes.len() < 10 {
        return None;
    }
    let version = bytes[3];
    let allowed_flags = match version {
        2 => 0xc0,
        3 => 0xe0,
        4 => 0xf0,
        _ => return None,
    };
    if bytes[4] == 0xff || bytes[5] & !allowed_flags != 0 {
        return None;
    }
    let encoded_size = &bytes[6..10];
    if encoded_size.iter().any(|byte| byte & 0x80 != 0) {
        return None;
    }
    let tag_size = encoded_size
        .iter()
        .fold(0usize, |size, byte| (size << 7) | usize::from(*byte));
    let tag_end = 10usize.checked_add(tag_size)?;
    let audio_offset = if version == 4 && bytes[5] & 0x10 != 0 {
        let footer_end = tag_end.checked_add(10)?;
        let footer = bytes.get(tag_end..footer_end)?;
        if &footer[..3] != b"3DI"
            || footer[3] != bytes[3]
            || footer[4] != bytes[4]
            || footer[5] != bytes[5]
            || footer[6..10] != bytes[6..10]
        {
            return None;
        }
        footer_end
    } else {
        tag_end
    };
    (audio_offset < bytes.len()).then_some(audio_offset)
}

fn mpeg_audio_bitrate_kbps(version: u32, layer: u32, index: usize) -> Option<u32> {
    if !(1..=14).contains(&index) {
        return None;
    }
    const MPEG1_LAYER1: [u32; 15] = [
        0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
    ];
    const MPEG1_LAYER2: [u32; 15] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
    ];
    const MPEG1_LAYER3: [u32; 15] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    ];
    const MPEG2_LAYER1: [u32; 15] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
    ];
    const MPEG2_LAYER2_OR_3: [u32; 15] =
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    Some(match (version, layer) {
        (3, 3) => MPEG1_LAYER1[index],
        (3, 2) => MPEG1_LAYER2[index],
        (3, 1) => MPEG1_LAYER3[index],
        (0 | 2, 3) => MPEG2_LAYER1[index],
        (0 | 2, 1 | 2) => MPEG2_LAYER2_OR_3[index],
        _ => return None,
    })
}

fn mpeg_audio_frame_length(bytes: &[u8], offset: usize) -> Option<usize> {
    let header = read_u32_be(bytes, offset)?;
    if header & 0xffe0_0000 != 0xffe0_0000 {
        return None;
    }
    let version = (header >> 19) & 0x03;
    let layer = (header >> 17) & 0x03;
    let bitrate_index = usize::try_from((header >> 12) & 0x0f).ok()?;
    let sample_rate_index = usize::try_from((header >> 10) & 0x03).ok()?;
    if version == 1 || layer == 0 || sample_rate_index == 3 || header & 0x03 == 0x02 {
        return None;
    }
    let bitrate = mpeg_audio_bitrate_kbps(version, layer, bitrate_index)?.checked_mul(1_000)?;
    let sample_rate = match version {
        3 => [44_100u32, 48_000, 32_000][sample_rate_index],
        2 => [22_050u32, 24_000, 16_000][sample_rate_index],
        0 => [11_025u32, 12_000, 8_000][sample_rate_index],
        _ => return None,
    };
    let padding = (header >> 9) & 1;
    let frame_length = match layer {
        3 => (12u32.checked_mul(bitrate)? / sample_rate)
            .checked_add(padding)?
            .checked_mul(4)?,
        2 => 144u32
            .checked_mul(bitrate)?
            .checked_div(sample_rate)?
            .checked_add(padding)?,
        1 => {
            let coefficient = if version == 3 { 144u32 } else { 72u32 };
            coefficient
                .checked_mul(bitrate)?
                .checked_div(sample_rate)?
                .checked_add(padding)?
        }
        _ => return None,
    };
    usize::try_from(frame_length)
        .ok()
        .filter(|length| *length >= 4)
}

fn source_mp3_magic_matches(bytes: &[u8]) -> bool {
    let mut budget = StructureScanBudget::new(MAX_SOURCE_AUDIO_STRUCTURE_ITEMS);
    source_mp3_magic_matches_with_budget(bytes, &mut budget)
}

fn source_mp3_magic_matches_with_budget(bytes: &[u8], budget: &mut StructureScanBudget) -> bool {
    let Some(audio_offset) = id3_audio_offset(bytes) else {
        return false;
    };
    let mut offset = audio_offset;
    let mut has_frame = false;
    while offset < bytes.len() {
        let remaining = bytes.len() - offset;
        if has_frame && remaining == 128 && has_ascii(bytes, offset, b"TAG") {
            offset = bytes.len();
            break;
        }
        if budget.consume().is_none() {
            return false;
        }
        let Some(frame_length) = mpeg_audio_frame_length(bytes, offset) else {
            return false;
        };
        let Some(frame_end) = offset.checked_add(frame_length) else {
            return false;
        };
        if frame_end > bytes.len() {
            return false;
        }
        offset = frame_end;
        has_frame = true;
    }
    has_frame && offset == bytes.len()
}

fn source_aac_magic_matches(bytes: &[u8]) -> bool {
    let mut budget = StructureScanBudget::new(MAX_SOURCE_AUDIO_STRUCTURE_ITEMS);
    source_aac_magic_matches_with_budget(bytes, &mut budget)
}

fn source_aac_magic_matches_with_budget(bytes: &[u8], budget: &mut StructureScanBudget) -> bool {
    let mut offset = 0usize;
    let mut has_frame = false;
    while offset < bytes.len() {
        if budget.consume().is_none() {
            return false;
        }
        let Some(header) = bytes.get(offset..offset.saturating_add(7)) else {
            return false;
        };
        if header[0] != 0xff || header[1] & 0xf6 != 0xf0 {
            return false;
        }
        let sample_rate_index = (header[2] >> 2) & 0x0f;
        if sample_rate_index > 12 {
            return false;
        }
        let header_length = if header[1] & 1 == 0 { 9usize } else { 7usize };
        let frame_length = (usize::from(header[3] & 0x03) << 11)
            | (usize::from(header[4]) << 3)
            | usize::from(header[5] >> 5);
        if frame_length <= header_length {
            return false;
        }
        let Some(frame_end) = offset.checked_add(frame_length) else {
            return false;
        };
        if frame_end > bytes.len() || offset.checked_add(header_length).is_none() {
            return false;
        }
        offset = frame_end;
        has_frame = true;
    }
    has_frame && offset == bytes.len()
}

#[derive(Clone, Copy)]
struct IsoBox {
    kind: [u8; 4],
    payload_start: usize,
    end: usize,
}

fn next_iso_box(
    bytes: &[u8],
    offset: usize,
    limit: usize,
    budget: &mut StructureScanBudget,
) -> Option<IsoBox> {
    if limit > bytes.len() || offset.checked_add(8)? > limit {
        return None;
    }
    budget.consume()?;
    let size32 = read_u32_be(bytes, offset)?;
    let kind = bytes.get(offset + 4..offset + 8)?.try_into().ok()?;
    let (header_size, box_size) = match size32 {
        0 => (8usize, limit.checked_sub(offset)?),
        1 => (
            16usize,
            usize::try_from(read_u64_be(bytes, offset + 8)?).ok()?,
        ),
        size => (8usize, usize::try_from(size).ok()?),
    };
    if box_size < header_size {
        return None;
    }
    let end = offset.checked_add(box_size)?;
    if end > limit {
        return None;
    }
    Some(IsoBox {
        kind,
        payload_start: offset.checked_add(header_size)?,
        end,
    })
}

fn is_supported_m4a_brand(brand: &[u8]) -> bool {
    matches!(
        brand,
        b"M4A " | b"M4B " | b"isom" | b"iso2" | b"mp41" | b"mp42" | b"qt  "
    )
}

fn valid_m4a_ftyp(bytes: &[u8], box_: IsoBox, budget: &mut StructureScanBudget) -> bool {
    let Some(payload) = bytes.get(box_.payload_start..box_.end) else {
        return false;
    };
    if payload.len() < 8 || (payload.len() - 8) % 4 != 0 {
        return false;
    }
    if is_supported_m4a_brand(&payload[..4]) {
        return true;
    }
    for brand in payload[8..].chunks_exact(4) {
        if budget.consume().is_none() {
            return false;
        }
        if is_supported_m4a_brand(brand) {
            return true;
        }
    }
    false
}

fn handler_inventory(
    bytes: &[u8],
    start: usize,
    end: usize,
    budget: &mut StructureScanBudget,
) -> Option<(bool, bool)> {
    let mut offset = start;
    let mut has_audio = false;
    let mut has_video = false;
    while offset < end {
        let box_ = next_iso_box(bytes, offset, end, budget)?;
        if box_.kind == *b"hdlr" {
            let payload = bytes.get(box_.payload_start..box_.end)?;
            if payload.len() < 24 {
                return None;
            }
            has_audio |= &payload[8..12] == b"soun";
            has_video |= &payload[8..12] == b"vide";
        }
        offset = box_.end;
    }
    (offset == end).then_some((has_audio, has_video))
}

fn media_inventory(
    bytes: &[u8],
    start: usize,
    end: usize,
    budget: &mut StructureScanBudget,
) -> Option<(bool, bool)> {
    let mut offset = start;
    let mut inventory = (false, false);
    while offset < end {
        let box_ = next_iso_box(bytes, offset, end, budget)?;
        if box_.kind == *b"mdia" {
            let handlers = handler_inventory(bytes, box_.payload_start, box_.end, budget)?;
            inventory.0 |= handlers.0;
            inventory.1 |= handlers.1;
        }
        offset = box_.end;
    }
    (offset == end).then_some(inventory)
}

fn track_inventory(
    bytes: &[u8],
    start: usize,
    end: usize,
    budget: &mut StructureScanBudget,
) -> Option<(bool, bool)> {
    let mut offset = start;
    let mut inventory = (false, false);
    while offset < end {
        let box_ = next_iso_box(bytes, offset, end, budget)?;
        if box_.kind == *b"trak" {
            let media = media_inventory(bytes, box_.payload_start, box_.end, budget)?;
            inventory.0 |= media.0;
            inventory.1 |= media.1;
        }
        offset = box_.end;
    }
    (offset == end).then_some(inventory)
}

fn source_m4a_magic_matches(bytes: &[u8]) -> bool {
    let mut budget = StructureScanBudget::new(MAX_SOURCE_AUDIO_STRUCTURE_ITEMS);
    source_m4a_magic_matches_with_budget(bytes, &mut budget)
}

fn source_m4a_magic_matches_with_budget(bytes: &[u8], budget: &mut StructureScanBudget) -> bool {
    let mut offset = 0usize;
    let mut box_index = 0usize;
    let mut has_ftyp = false;
    let mut has_audio = false;
    let mut has_video = false;
    let mut has_media_data = false;
    while offset < bytes.len() {
        let Some(box_) = next_iso_box(bytes, offset, bytes.len(), budget) else {
            return false;
        };
        if box_index == 0 && box_.kind != *b"ftyp" {
            return false;
        }
        match &box_.kind {
            b"ftyp" => {
                if has_ftyp || !valid_m4a_ftyp(bytes, box_, budget) {
                    return false;
                }
                has_ftyp = true;
            }
            b"moov" => {
                let Some(inventory) = track_inventory(bytes, box_.payload_start, box_.end, budget)
                else {
                    return false;
                };
                has_audio |= inventory.0;
                has_video |= inventory.1;
            }
            b"mdat" => has_media_data |= box_.payload_start < box_.end,
            _ => {}
        }
        offset = box_.end;
        box_index += 1;
    }
    offset == bytes.len() && has_ftyp && has_audio && !has_video && has_media_data
}

fn source_audio_magic_matches(format: SourceAudioFormat, bytes: &[u8]) -> bool {
    match format {
        SourceAudioFormat::Wav => source_wav_magic_matches(bytes),
        SourceAudioFormat::Mp3 => source_mp3_magic_matches(bytes),
        SourceAudioFormat::M4a => source_m4a_magic_matches(bytes),
        SourceAudioFormat::Aac => source_aac_magic_matches(bytes),
    }
}

fn validate_file_bytes(format: FileFormat, bytes: &[u8]) -> FileResult<()> {
    validate_payload_size(format, bytes.len())?;
    let valid = match format {
        FileFormat::Project => crate::native_persistence::validate_project_file_json(bytes),
        FileFormat::Midi => bytes.len() >= 14 && has_ascii(bytes, 0, b"MThd"),
        FileFormat::Wav => {
            bytes.len() >= 12 && has_ascii(bytes, 0, b"RIFF") && has_ascii(bytes, 8, b"WAVE")
        }
        FileFormat::SourceAudio => [
            SourceAudioFormat::Wav,
            SourceAudioFormat::Mp3,
            SourceAudioFormat::M4a,
            SourceAudioFormat::Aac,
        ]
        .into_iter()
        .any(|source_format| source_audio_magic_matches(source_format, bytes)),
    };
    if !valid {
        return Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidFile));
    }
    Ok(())
}

fn validate_opened_file_bytes(format: FileFormat, file_name: &str, bytes: &[u8]) -> FileResult<()> {
    validate_file_bytes(format, bytes)?;
    if format == FileFormat::SourceAudio {
        let (source_format, _) = source_audio_format(file_name)
            .ok_or_else(|| NativeFileErrorDto::new(NativeFileErrorCode::InvalidFilename))?;
        if !source_audio_magic_matches(source_format, bytes) {
            return Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidFile));
        }
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
    validate_opened_file_bytes(format, file_name, bytes)?;
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
pub(crate) async fn file_open_audio(window: WebviewWindow) -> FileResult<Response> {
    open_file(window, FileFormat::SourceAudio).await
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

    fn riff_chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = kind.to_vec();
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(payload);
        if !payload.len().is_multiple_of(2) {
            bytes.push(0);
        }
        bytes
    }

    fn valid_source_wav() -> Vec<u8> {
        let mut format = Vec::new();
        format.extend_from_slice(&1u16.to_le_bytes());
        format.extend_from_slice(&2u16.to_le_bytes());
        format.extend_from_slice(&44_100u32.to_le_bytes());
        format.extend_from_slice(&176_400u32.to_le_bytes());
        format.extend_from_slice(&4u16.to_le_bytes());
        format.extend_from_slice(&16u16.to_le_bytes());

        let mut payload = b"WAVE".to_vec();
        payload.extend_from_slice(&riff_chunk(b"fmt ", &format));
        payload.extend_from_slice(&riff_chunk(b"data", &[0, 0, 0, 0]));
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn source_wav_with_chunk_count(chunk_count: usize) -> Vec<u8> {
        assert!(chunk_count >= 2);
        let mut format = Vec::new();
        format.extend_from_slice(&1u16.to_le_bytes());
        format.extend_from_slice(&2u16.to_le_bytes());
        format.extend_from_slice(&44_100u32.to_le_bytes());
        format.extend_from_slice(&176_400u32.to_le_bytes());
        format.extend_from_slice(&4u16.to_le_bytes());
        format.extend_from_slice(&16u16.to_le_bytes());

        let mut payload = b"WAVE".to_vec();
        payload.extend_from_slice(&riff_chunk(b"fmt ", &format));
        payload.extend_from_slice(&riff_chunk(b"data", &[0, 0, 0, 0]));
        for _ in 2..chunk_count {
            payload.extend_from_slice(&riff_chunk(b"JUNK", &[]));
        }
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn valid_mp3_frame() -> Vec<u8> {
        let mut bytes = vec![0; 417];
        bytes[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
        bytes
    }

    fn valid_mp3() -> Vec<u8> {
        let mut bytes = b"ID3\x04\x00\x00\x00\x00\x00\x00".to_vec();
        bytes.extend_from_slice(&valid_mp3_frame());
        bytes
    }

    fn valid_mp3_with_id3_footer() -> Vec<u8> {
        let mut bytes = b"ID3\x04\x00\x10\x00\x00\x00\x00".to_vec();
        bytes.extend_from_slice(b"3DI\x04\x00\x10\x00\x00\x00\x00");
        bytes.extend_from_slice(&valid_mp3_frame());
        bytes
    }

    fn iso_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = u32::try_from(payload.len() + 8).unwrap();
        let mut bytes = size.to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(payload);
        bytes
    }

    fn m4a_with_handler(handler: &[u8; 4]) -> Vec<u8> {
        let mut ftyp_payload = b"M4A \x00\x00\x00\x00".to_vec();
        ftyp_payload.extend_from_slice(b"isom");

        let mut handler_payload = vec![0; 24];
        handler_payload[8..12].copy_from_slice(handler);
        let hdlr = iso_box(b"hdlr", &handler_payload);
        let mdia = iso_box(b"mdia", &hdlr);
        let trak = iso_box(b"trak", &mdia);
        let moov = iso_box(b"moov", &trak);

        let mut bytes = iso_box(b"ftyp", &ftyp_payload);
        bytes.extend_from_slice(&moov);
        bytes.extend_from_slice(&iso_box(b"mdat", &[0]));
        bytes
    }

    fn valid_m4a() -> Vec<u8> {
        m4a_with_handler(b"soun")
    }

    fn valid_aac() -> Vec<u8> {
        vec![0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0]
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
    fn accepts_only_allowlisted_source_audio_extensions() {
        for file_name in ["song.wav", "song.MP3", "song.m4a", "song.AAC"] {
            assert!(
                validate_open_file_name(FileFormat::SourceAudio, file_name).is_ok(),
                "rejected {file_name}"
            );
        }
        for file_name in ["song", "song.mp4", "song.flac", "song.ogg", "../song.mp3"] {
            assert!(
                validate_open_file_name(FileFormat::SourceAudio, file_name).is_err(),
                "accepted {file_name}"
            );
        }
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
        for format in [
            FileFormat::Project,
            FileFormat::Midi,
            FileFormat::Wav,
            FileFormat::SourceAudio,
        ] {
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
    fn requires_source_audio_extension_and_magic_to_match() {
        for (file_name, bytes) in [
            ("song.wav", valid_source_wav()),
            ("song.mp3", valid_mp3()),
            ("song.MP3", valid_mp3_frame()),
            ("footer.mp3", valid_mp3_with_id3_footer()),
            ("song.m4a", valid_m4a()),
            ("song.aac", valid_aac()),
        ] {
            assert!(
                opened_file_envelope(FileFormat::SourceAudio, file_name, &bytes).is_ok(),
                "rejected {file_name}"
            );
        }

        for (file_name, bytes) in [
            ("song.wav", valid_mp3()),
            ("song.mp3", valid_source_wav()),
            ("song.m4a", valid_aac()),
            ("song.aac", valid_m4a()),
        ] {
            assert_eq!(
                opened_file_envelope(FileFormat::SourceAudio, file_name, &bytes),
                Err(NativeFileErrorDto::new(NativeFileErrorCode::InvalidFile)),
                "accepted mismatched magic for {file_name}"
            );
        }
        assert_eq!(
            opened_file_envelope(FileFormat::SourceAudio, "song.mp4", &valid_m4a()),
            Err(NativeFileErrorDto::new(
                NativeFileErrorCode::InvalidFilename
            ))
        );
    }

    #[test]
    fn rejects_truncated_or_reserved_source_audio_headers() {
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Wav,
            &valid_wav()
        ));
        let mut wrong_riff_size = valid_source_wav();
        wrong_riff_size[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Wav,
            &wrong_riff_size
        ));

        assert!(!source_audio_magic_matches(SourceAudioFormat::Mp3, b"ID3"));
        let mut invalid_id3_size = valid_mp3();
        invalid_id3_size[6] = 0x80;
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &invalid_id3_size
        ));
        let mut invalid_id3_footer = valid_mp3_with_id3_footer();
        invalid_id3_footer[10] = b'X';
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &invalid_id3_footer
        ));
        let mut reserved_version = vec![0; 417];
        reserved_version[..4].copy_from_slice(&[0xff, 0xea, 0x90, 0x64]);
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &reserved_version
        ));
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &[0xff, 0xfb, 0x90, 0x64]
        ));

        assert!(!source_audio_magic_matches(
            SourceAudioFormat::M4a,
            b"\x00\x00\x00\x14ftypM4A "
        ));
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::M4a,
            &m4a_with_handler(b"vide")
        ));
        let mut oversized_ftyp = valid_m4a();
        oversized_ftyp[..4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::M4a,
            &oversized_ftyp
        ));

        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Aac,
            &[0xff, 0xf1]
        ));
        let mut reserved_sample_rate = valid_aac();
        reserved_sample_rate[2] = 0x74;
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Aac,
            &reserved_sample_rate
        ));
        let mut truncated_frame = valid_aac();
        truncated_frame[4] = 0x02;
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Aac,
            &truncated_frame
        ));
    }

    #[test]
    fn scans_every_mp3_frame_and_rejects_arbitrary_trailing_bytes() {
        let mut two_frames = valid_mp3();
        two_frames.extend_from_slice(&valid_mp3_frame());
        assert!(source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &two_frames
        ));

        let second_frame_start = two_frames.len() - valid_mp3_frame().len();
        two_frames[second_frame_start] = 0;
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &two_frames
        ));

        let mut garbage_tail = valid_mp3();
        garbage_tail.extend_from_slice(b"garbage");
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &garbage_tail
        ));

        let mut id3v1_tail = valid_mp3();
        id3v1_tail.extend_from_slice(b"TAG");
        id3v1_tail.resize(id3v1_tail.len() + 125, 0);
        assert!(source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &id3v1_tail
        ));
        id3v1_tail.push(0);
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Mp3,
            &id3v1_tail
        ));
    }

    #[test]
    fn applies_scan_budgets_to_each_structure_and_shares_the_m4a_budget() {
        let mut wav_budget = StructureScanBudget::new(1);
        assert!(!source_wav_magic_matches_with_budget(
            &valid_source_wav(),
            &mut wav_budget
        ));
        let mut wav_budget = StructureScanBudget::new(2);
        assert!(source_wav_magic_matches_with_budget(
            &valid_source_wav(),
            &mut wav_budget
        ));

        let mut mp3_budget = StructureScanBudget::new(0);
        assert!(!source_mp3_magic_matches_with_budget(
            &valid_mp3(),
            &mut mp3_budget
        ));
        let mut mp3_budget = StructureScanBudget::new(1);
        assert!(source_mp3_magic_matches_with_budget(
            &valid_mp3(),
            &mut mp3_budget
        ));

        let mut aac_budget = StructureScanBudget::new(0);
        assert!(!source_aac_magic_matches_with_budget(
            &valid_aac(),
            &mut aac_budget
        ));
        let mut aac_budget = StructureScanBudget::new(1);
        assert!(source_aac_magic_matches_with_budget(
            &valid_aac(),
            &mut aac_budget
        ));

        // ftyp + moov + trak + mdia + hdlr + mdat: nested boxes consume the
        // same budget as top-level boxes rather than resetting the allowance.
        let mut m4a_budget = StructureScanBudget::new(5);
        assert!(!source_m4a_magic_matches_with_budget(
            &valid_m4a(),
            &mut m4a_budget
        ));
        let mut m4a_budget = StructureScanBudget::new(6);
        assert!(source_m4a_magic_matches_with_budget(
            &valid_m4a(),
            &mut m4a_budget
        ));
    }

    #[test]
    fn rejects_source_audio_above_the_production_structure_limit() {
        let mut too_many_chunks = source_wav_with_chunk_count(MAX_SOURCE_AUDIO_STRUCTURE_ITEMS);
        assert!(source_audio_magic_matches(
            SourceAudioFormat::Wav,
            &too_many_chunks
        ));
        too_many_chunks.extend_from_slice(&riff_chunk(b"JUNK", &[]));
        let riff_size = u32::try_from(too_many_chunks.len() - 8).unwrap();
        too_many_chunks[4..8].copy_from_slice(&riff_size.to_le_bytes());
        assert!(!source_audio_magic_matches(
            SourceAudioFormat::Wav,
            &too_many_chunks
        ));
    }

    #[test]
    fn source_audio_envelope_exposes_basename_but_not_selected_path() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("karaoke-source.m4a");
        let bytes = valid_m4a();
        fs::write(&path, &bytes).unwrap();

        let envelope = open_selected_file(FileFormat::SourceAudio, Some(path)).unwrap();
        let file_name_length = u32::from_le_bytes(envelope[1..5].try_into().unwrap()) as usize;
        assert_eq!(&envelope[5..5 + file_name_length], b"karaoke-source.m4a");
        assert_eq!(&envelope[5 + file_name_length..], bytes);
        assert!(!String::from_utf8_lossy(&envelope)
            .contains(directory.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn rejects_source_audio_over_128_mib_before_reading() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("large.mp3");
        let file = File::create(&path).unwrap();
        file.set_len(SOURCE_AUDIO_MAX_BYTES as u64 + 1).unwrap();
        assert_eq!(
            read_selected_file(FileFormat::SourceAudio, &path),
            Err(NativeFileErrorDto::new(NativeFileErrorCode::FileTooLarge))
        );
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
