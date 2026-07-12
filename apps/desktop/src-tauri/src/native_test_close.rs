//! Native-E2E-only external trigger for a real Tauri close request.
//!
//! WebDriver's W3C close endpoint calls `destroy()` directly, so it cannot
//! prove the production `CloseRequested` authorization pipeline. This module
//! is compiled only with `native-test`: the harness atomically creates a fresh
//! unpredictable token file after the renderer has a known dirty edit. The
//! resulting `close()` is the same cancellable request produced by an OS close.

use std::{
    ffi::OsString,
    fs, io,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

use tauri::{Runtime, WebviewWindow};

const REQUEST_PATH_ENV: &str = "CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_PATH";
const REQUEST_TOKEN_ENV: &str = "CTS_NATIVE_E2E_NORMAL_CLOSE_REQUEST_TOKEN";
const REQUEST_DEADLINE: Duration = Duration::from_secs(90);
const REQUEST_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, PartialEq, Eq)]
struct NativeTestCloseRequest {
    path: PathBuf,
    token: String,
}

fn invalid_configuration(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn decode_configuration(
    path: Option<OsString>,
    token: Option<OsString>,
) -> io::Result<Option<NativeTestCloseRequest>> {
    let (path, token) = match (path, token) {
        (None, None) => return Ok(None),
        (Some(path), Some(token)) => (path, token),
        _ => {
            return Err(invalid_configuration(
                "native E2E close request path and token must be configured together",
            ));
        }
    };
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(invalid_configuration(
            "native E2E close request path must be absolute",
        ));
    }
    let token = token
        .into_string()
        .map_err(|_| invalid_configuration("native E2E close request token must be valid UTF-8"))?;
    if token.len() != 64
        || !token
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(invalid_configuration(
            "native E2E close request token must be 64 lowercase hexadecimal characters",
        ));
    }
    Ok(Some(NativeTestCloseRequest { path, token }))
}

fn wait_for_request<R: Runtime>(window: WebviewWindow<R>, request: NativeTestCloseRequest) {
    let deadline = Instant::now() + REQUEST_DEADLINE;
    loop {
        match fs::symlink_metadata(&request.path) {
            Ok(metadata) => {
                if !metadata.file_type().is_file() || metadata.len() != 64 {
                    eprintln!("native E2E close request was not an exact regular token file");
                    return;
                }
                match fs::read_to_string(&request.path) {
                    Ok(token) if token == request.token => {
                        if let Err(error) = window.close() {
                            eprintln!("native E2E close request failed: {error}");
                        }
                    }
                    Ok(_) => eprintln!("native E2E close request token did not match"),
                    Err(error) => eprintln!("native E2E close request could not be read: {error}"),
                }
                return;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                eprintln!("native E2E close request could not be inspected: {error}");
                return;
            }
        }
        if Instant::now() >= deadline {
            eprintln!("native E2E close request timed out");
            return;
        }
        thread::sleep(REQUEST_POLL_INTERVAL);
    }
}

pub(crate) fn install<R: Runtime>(window: WebviewWindow<R>) -> io::Result<()> {
    let Some(request) = decode_configuration(
        std::env::var_os(REQUEST_PATH_ENV),
        std::env::var_os(REQUEST_TOKEN_ENV),
    )?
    else {
        return Ok(());
    };
    match fs::symlink_metadata(&request.path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(invalid_configuration(
                "native E2E close request path must not exist at startup",
            ));
        }
        Err(error) => return Err(error),
    }
    thread::Builder::new()
        .name("cts-native-e2e-close-request".to_owned())
        .spawn(move || wait_for_request(window, request))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> OsString {
        OsString::from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
    }

    fn absolute_request_path() -> OsString {
        if cfg!(windows) {
            OsString::from(r"C:\request")
        } else {
            OsString::from("/request")
        }
    }

    #[test]
    fn configuration_is_disabled_only_when_both_values_are_absent() {
        assert_eq!(decode_configuration(None, None).unwrap(), None);
        assert!(decode_configuration(Some(absolute_request_path()), None).is_err());
        assert!(decode_configuration(None, Some(token())).is_err());
    }

    #[test]
    fn configuration_requires_an_absolute_path_and_exact_lowercase_token() {
        assert!(decode_configuration(Some(OsString::from("relative")), Some(token())).is_err());
        assert!(decode_configuration(
            Some(absolute_request_path()),
            Some(OsString::from("A".repeat(64))),
        )
        .is_err());
        assert!(decode_configuration(
            Some(absolute_request_path()),
            Some(OsString::from("a".repeat(63))),
        )
        .is_err());
    }

    #[test]
    fn configuration_accepts_a_fresh_absolute_request() {
        let decoded = decode_configuration(Some(absolute_request_path()), Some(token()))
            .unwrap()
            .unwrap();
        assert_eq!(decoded.path, PathBuf::from(absolute_request_path()));
        assert_eq!(decoded.token, token().into_string().unwrap());
    }
}
