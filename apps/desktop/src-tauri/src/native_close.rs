use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{State, WebviewWindow};

use crate::native_persistence::NativePersistenceState;

const MAIN_WINDOW_LABEL: &str = "main";
// The command response must reach the renderer before destroying its WebView.
// Tauri does not expose an "IPC response flushed" callback, so destruction is
// handed to a detached thread after a short, bounded response grace period.
const CLOSE_RESPONSE_GRACE_PERIOD: Duration = Duration::from_millis(50);
#[cfg(feature = "native-test")]
const MAX_NATIVE_TEST_CLOSE_RESPONSE_GRACE_MS: u64 = 5_000;
#[cfg(feature = "native-test")]
const NATIVE_TEST_CLOSE_RESPONSE_GRACE_ENV: &str = "CTS_NATIVE_TEST_CLOSE_GRACE_MS";

#[cfg(not(feature = "native-test"))]
fn close_response_grace_period() -> Duration {
    CLOSE_RESPONSE_GRACE_PERIOD
}

#[cfg(feature = "native-test")]
fn native_test_close_response_grace_period(value: Option<&str>) -> Duration {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|milliseconds| {
            (CLOSE_RESPONSE_GRACE_PERIOD.as_millis() as u64
                ..=MAX_NATIVE_TEST_CLOSE_RESPONSE_GRACE_MS)
                .contains(milliseconds)
        })
        .map(Duration::from_millis)
        .unwrap_or(CLOSE_RESPONSE_GRACE_PERIOD)
}

#[cfg(feature = "native-test")]
fn close_response_grace_period() -> Duration {
    native_test_close_response_grace_period(
        std::env::var(NATIVE_TEST_CLOSE_RESPONSE_GRACE_ENV)
            .ok()
            .as_deref(),
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum CloseAuthorization {
    Normal(String),
    Erase(String),
    Bootstrap,
}

#[derive(Debug, Eq, PartialEq)]
enum ClosePhase {
    Bootstrap,
    BootstrapIdleVerified,
    Running,
    NormalRequested(String),
    NormalRepositoryClosing(String),
    NormalRepositoryClosed(String),
    EraseReady(String),
    DestroyScheduling(CloseAuthorization),
    DestroyScheduled,
}

#[derive(Debug)]
struct CloseRuntime {
    next_request_id: u64,
    phase: ClosePhase,
}

#[derive(Clone, Debug)]
pub(crate) struct NativeCloseState {
    runtime: Arc<Mutex<CloseRuntime>>,
}

impl Default for NativeCloseState {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(CloseRuntime {
                next_request_id: 1,
                phase: ClosePhase::Bootstrap,
            })),
        }
    }
}

impl NativeCloseState {
    /// Records user/OS close intent. Calling the IPC command cannot create it.
    pub(crate) fn note_main_window_close_requested(&self) {
        let Ok(mut runtime) = self.runtime.lock() else {
            return;
        };
        match &runtime.phase {
            ClosePhase::Running => {
                let request_id = format!("close-{:016x}", runtime.next_request_id);
                runtime.next_request_id = runtime.next_request_id.wrapping_add(1).max(1);
                runtime.phase = ClosePhase::NormalRequested(request_id);
            }
            // A duplicate native event belongs to the same in-flight pipeline.
            ClosePhase::NormalRequested(_)
            | ClosePhase::NormalRepositoryClosing(_)
            | ClosePhase::NormalRepositoryClosed(_)
            | ClosePhase::DestroyScheduling(_)
            | ClosePhase::DestroyScheduled
            | ClosePhase::Bootstrap
            | ClosePhase::BootstrapIdleVerified
            | ClosePhase::EraseReady(_) => {}
        }
    }

    pub(crate) fn claim_normal_request(&self) -> Option<String> {
        let runtime = self.runtime.lock().ok()?;
        match &runtime.phase {
            ClosePhase::NormalRequested(request_id) => Some(request_id.clone()),
            _ => None,
        }
    }

    /// Revokes bootstrap-only shutdown as soon as repository initialization is attempted.
    pub(crate) fn enter_running(&self) {
        let Ok(mut runtime) = self.runtime.lock() else {
            return;
        };
        if matches!(
            runtime.phase,
            ClosePhase::Bootstrap | ClosePhase::BootstrapIdleVerified
        ) {
            runtime.phase = ClosePhase::Running;
        }
    }

    /// Allows the recovery shell to exit only before the editable repository starts.
    pub(crate) fn note_bootstrap_idle_verified(&self) {
        let Ok(mut runtime) = self.runtime.lock() else {
            return;
        };
        if runtime.phase == ClosePhase::Bootstrap {
            runtime.phase = ClosePhase::BootstrapIdleVerified;
        }
    }

    /// A completed erase is stronger than any close request that raced with it.
    pub(crate) fn note_erase_completed(&self, erase_id: &str) {
        let Ok(mut runtime) = self.runtime.lock() else {
            return;
        };
        if !matches!(
            runtime.phase,
            ClosePhase::DestroyScheduling(_) | ClosePhase::DestroyScheduled
        ) {
            runtime.phase = ClosePhase::EraseReady(erase_id.to_owned());
        }
    }

    fn begin_normal_repository_close(&self, request_id: &str) -> bool {
        let Ok(mut runtime) = self.runtime.lock() else {
            return false;
        };
        match &runtime.phase {
            ClosePhase::NormalRequested(expected) if expected == request_id => {
                runtime.phase = ClosePhase::NormalRepositoryClosing(request_id.to_owned());
                true
            }
            _ => false,
        }
    }

    fn normal_repository_close_failed(&self, request_id: &str) {
        let Ok(mut runtime) = self.runtime.lock() else {
            return;
        };
        if matches!(
            &runtime.phase,
            ClosePhase::NormalRepositoryClosing(expected) if expected == request_id
        ) {
            // No destroy can follow a failed close. A later real close event may retry
            // with the same request id, while the renderer remains fail-closed.
            runtime.phase = ClosePhase::NormalRequested(request_id.to_owned());
        }
    }

    fn normal_repository_close_succeeded(&self, request_id: &str) -> bool {
        let Ok(mut runtime) = self.runtime.lock() else {
            return false;
        };
        match &runtime.phase {
            ClosePhase::NormalRepositoryClosing(expected) if expected == request_id => {
                runtime.phase = ClosePhase::NormalRepositoryClosed(request_id.to_owned());
                true
            }
            _ => false,
        }
    }

    fn begin_destroy(&self, authorization: &CloseAuthorization) -> bool {
        let Ok(mut runtime) = self.runtime.lock() else {
            return false;
        };
        let authorized = match (&runtime.phase, authorization) {
            (ClosePhase::NormalRepositoryClosed(expected), CloseAuthorization::Normal(actual)) => {
                expected == actual
            }
            (ClosePhase::EraseReady(expected), CloseAuthorization::Erase(actual)) => {
                expected == actual
            }
            (ClosePhase::BootstrapIdleVerified, CloseAuthorization::Bootstrap) => true,
            _ => false,
        };
        if authorized {
            runtime.phase = ClosePhase::DestroyScheduling(authorization.clone());
        }
        authorized
    }

    fn destroy_schedule_succeeded(&self, authorization: &CloseAuthorization) -> bool {
        let Ok(mut runtime) = self.runtime.lock() else {
            return false;
        };
        if matches!(
            &runtime.phase,
            ClosePhase::DestroyScheduling(expected) if expected == authorization
        ) {
            runtime.phase = ClosePhase::DestroyScheduled;
            true
        } else {
            false
        }
    }

    fn destroy_schedule_failed(&self, authorization: &CloseAuthorization) {
        let Ok(mut runtime) = self.runtime.lock() else {
            return;
        };
        if !matches!(
            &runtime.phase,
            ClosePhase::DestroyScheduling(expected) if expected == authorization
        ) {
            return;
        }
        runtime.phase = match authorization {
            CloseAuthorization::Normal(request_id) => {
                ClosePhase::NormalRepositoryClosed(request_id.clone())
            }
            CloseAuthorization::Erase(erase_id) => ClosePhase::EraseReady(erase_id.clone()),
            CloseAuthorization::Bootstrap => ClosePhase::BootstrapIdleVerified,
        };
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseRequestReceiptDto {
    request_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum FinishCloseRequestDto {
    Normal {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Erase {
        #[serde(rename = "eraseId")]
        erase_id: String,
    },
    Bootstrap,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeCloseErrorCode {
    CallerNotAllowed,
    CloseNotAuthorized,
    RepositoryCloseFailed,
    CloseFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct NativeCloseErrorDto {
    code: NativeCloseErrorCode,
}

impl NativeCloseErrorDto {
    const fn new(code: NativeCloseErrorCode) -> Self {
        Self { code }
    }
}

type CloseResult<T> = Result<T, NativeCloseErrorDto>;

fn ensure_main_caller(window: &WebviewWindow) -> CloseResult<()> {
    if window.label() == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err(NativeCloseErrorDto::new(
            NativeCloseErrorCode::CallerNotAllowed,
        ))
    }
}

#[tauri::command]
pub(crate) fn app_claim_close_request(
    window: WebviewWindow,
    close_state: State<'_, NativeCloseState>,
) -> CloseResult<Option<CloseRequestReceiptDto>> {
    ensure_main_caller(&window)?;
    Ok(close_state
        .claim_normal_request()
        .map(|request_id| CloseRequestReceiptDto { request_id }))
}

fn schedule_destroy(
    window: WebviewWindow,
    close_state: NativeCloseState,
    authorization: CloseAuthorization,
) -> CloseResult<()> {
    if !close_state.begin_destroy(&authorization) {
        return Err(NativeCloseErrorDto::new(
            NativeCloseErrorCode::CloseNotAuthorized,
        ));
    }
    let response_grace_period = close_response_grace_period();
    match thread::Builder::new()
        .name("cts-close-handoff".to_owned())
        .spawn(move || {
            thread::sleep(response_grace_period);
            if let Err(error) = window.destroy() {
                eprintln!("failed to finish the accepted native close request: {error}");
            }
        }) {
        Ok(_) => {
            if close_state.destroy_schedule_succeeded(&authorization) {
                Ok(())
            } else {
                // The thread already owns destruction, so report a terminal failure
                // without making a second schedule possible.
                Err(NativeCloseErrorDto::new(NativeCloseErrorCode::CloseFailed))
            }
        }
        Err(_) => {
            close_state.destroy_schedule_failed(&authorization);
            Err(NativeCloseErrorDto::new(NativeCloseErrorCode::CloseFailed))
        }
    }
}

#[tauri::command]
pub(crate) async fn app_finish_close(
    window: WebviewWindow,
    close_state: State<'_, NativeCloseState>,
    persistence_state: State<'_, NativePersistenceState>,
    request: FinishCloseRequestDto,
) -> CloseResult<()> {
    ensure_main_caller(&window)?;
    let close_state = close_state.inner().clone();
    let authorization = match request {
        FinishCloseRequestDto::Normal { request_id } => {
            if !close_state.begin_normal_repository_close(&request_id) {
                return Err(NativeCloseErrorDto::new(
                    NativeCloseErrorCode::CloseNotAuthorized,
                ));
            }
            let repository = persistence_state.repository();
            let repository_closed =
                tauri::async_runtime::spawn_blocking(move || repository.close())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .is_some();
            if !repository_closed {
                close_state.normal_repository_close_failed(&request_id);
                return Err(NativeCloseErrorDto::new(
                    NativeCloseErrorCode::RepositoryCloseFailed,
                ));
            }
            if !close_state.normal_repository_close_succeeded(&request_id) {
                return Err(NativeCloseErrorDto::new(
                    NativeCloseErrorCode::CloseNotAuthorized,
                ));
            }
            CloseAuthorization::Normal(request_id)
        }
        FinishCloseRequestDto::Erase { erase_id } => CloseAuthorization::Erase(erase_id),
        FinishCloseRequestDto::Bootstrap => CloseAuthorization::Bootstrap,
    };
    schedule_destroy(window, close_state, authorization)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ERASE_ID: &str = "erase-12345678-1234-4abc-8def-1234567890ab";

    #[test]
    fn only_a_running_native_close_event_issues_a_stable_request() {
        let state = NativeCloseState::default();
        state.note_main_window_close_requested();
        assert_eq!(state.claim_normal_request(), None);

        state.enter_running();
        assert_eq!(state.claim_normal_request(), None);
        state.note_main_window_close_requested();
        let request_id = state.claim_normal_request().unwrap();
        assert_eq!(request_id, "close-0000000000000001");

        state.note_main_window_close_requested();
        assert_eq!(state.claim_normal_request(), Some(request_id));
    }

    #[test]
    fn normal_destroy_requires_the_exact_request_and_repository_close() {
        let state = NativeCloseState::default();
        state.enter_running();
        state.note_main_window_close_requested();
        let request_id = state.claim_normal_request().unwrap();
        let authorization = CloseAuthorization::Normal(request_id.clone());

        assert!(!state.begin_destroy(&authorization));
        assert!(!state.begin_normal_repository_close("close-ffffffffffffffff"));
        assert!(state.begin_normal_repository_close(&request_id));
        assert!(!state.begin_normal_repository_close(&request_id));
        assert!(state.normal_repository_close_succeeded(&request_id));
        assert!(state.begin_destroy(&authorization));
        assert!(!state.begin_destroy(&authorization));
        assert!(state.destroy_schedule_succeeded(&authorization));
        assert!(!state.begin_destroy(&authorization));
    }

    #[test]
    fn failed_repository_close_never_authorizes_destroy_and_keeps_the_same_request() {
        let state = NativeCloseState::default();
        state.enter_running();
        state.note_main_window_close_requested();
        let request_id = state.claim_normal_request().unwrap();
        assert!(state.begin_normal_repository_close(&request_id));
        state.normal_repository_close_failed(&request_id);

        assert_eq!(state.claim_normal_request(), Some(request_id.clone()));
        assert!(!state.begin_destroy(&CloseAuthorization::Normal(request_id)));
    }

    #[test]
    fn bootstrap_authorization_is_narrow_and_revoked_by_initialization() {
        let state = NativeCloseState::default();
        let authorization = CloseAuthorization::Bootstrap;
        assert!(!state.begin_destroy(&authorization));
        state.note_bootstrap_idle_verified();
        state.enter_running();
        assert!(!state.begin_destroy(&authorization));

        let recovery = NativeCloseState::default();
        recovery.note_bootstrap_idle_verified();
        assert!(recovery.begin_destroy(&authorization));
    }

    #[test]
    fn erase_authorization_requires_the_exact_completed_id() {
        let state = NativeCloseState::default();
        state.enter_running();
        state.note_erase_completed(ERASE_ID);
        assert!(!state.begin_destroy(&CloseAuthorization::Erase(
            "erase-abcdef01-2345-4abc-9def-1234567890ab".to_owned()
        )));
        assert!(state.begin_destroy(&CloseAuthorization::Erase(ERASE_ID.to_owned())));
    }

    #[test]
    fn close_ipc_wire_format_is_exact_and_rejects_extra_fields() {
        assert_eq!(
            serde_json::to_value(CloseRequestReceiptDto {
                request_id: "close-0000000000000001".to_owned(),
            })
            .unwrap(),
            serde_json::json!({ "requestId": "close-0000000000000001" })
        );
        assert_eq!(
            serde_json::from_value::<FinishCloseRequestDto>(serde_json::json!({
                "kind": "normal",
                "requestId": "close-0000000000000001"
            }))
            .unwrap(),
            FinishCloseRequestDto::Normal {
                request_id: "close-0000000000000001".to_owned()
            }
        );
        assert_eq!(
            serde_json::from_value::<FinishCloseRequestDto>(serde_json::json!({
                "kind": "erase",
                "eraseId": ERASE_ID
            }))
            .unwrap(),
            FinishCloseRequestDto::Erase {
                erase_id: ERASE_ID.to_owned()
            }
        );
        assert_eq!(
            serde_json::from_value::<FinishCloseRequestDto>(serde_json::json!({
                "kind": "bootstrap"
            }))
            .unwrap(),
            FinishCloseRequestDto::Bootstrap
        );
        for invalid in [
            serde_json::json!({ "kind": "normal" }),
            serde_json::json!({
                "kind": "normal",
                "requestId": "close-0000000000000001",
                "extra": true
            }),
            serde_json::json!({ "kind": "unknown" }),
        ] {
            assert!(serde_json::from_value::<FinishCloseRequestDto>(invalid).is_err());
        }
        assert_eq!(
            serde_json::to_value(NativeCloseErrorDto::new(
                NativeCloseErrorCode::CloseNotAuthorized
            ))
            .unwrap(),
            serde_json::json!({ "code": "close-not-authorized" })
        );
    }

    #[cfg(feature = "native-test")]
    #[test]
    fn native_test_close_grace_override_is_bounded_and_fail_closed() {
        assert_eq!(
            native_test_close_response_grace_period(None),
            CLOSE_RESPONSE_GRACE_PERIOD
        );
        assert_eq!(
            native_test_close_response_grace_period(Some("50")),
            Duration::from_millis(50)
        );
        assert_eq!(
            native_test_close_response_grace_period(Some("1750")),
            Duration::from_millis(1_750)
        );
        assert_eq!(
            native_test_close_response_grace_period(Some("5000")),
            Duration::from_millis(5_000)
        );
        for invalid in ["0", "49", "5001", "-1", "not-a-number"] {
            assert_eq!(
                native_test_close_response_grace_period(Some(invalid)),
                CLOSE_RESPONSE_GRACE_PERIOD
            );
        }
    }
}
