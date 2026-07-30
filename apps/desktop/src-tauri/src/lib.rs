mod native_audio_assets;
mod native_close;
mod native_files;
mod native_persistence;
#[cfg(feature = "native-test")]
mod native_test_close;

use native_close::NativeCloseState;
use native_persistence::NativePersistenceState;
use tauri::{webview::NewWindowResponse, Manager, Url, WindowEvent};

fn navigation_is_allowed(url: &Url, allow_dev_origin: bool) -> bool {
    let bundled_origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "https" && url.host_str() == Some("tauri.localhost"));
    let dev_origin = allow_dev_origin
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(5173);

    bundled_origin || dev_origin
}

#[cfg(any(target_os = "linux", test))]
fn microphone_request_is_allowed(requests_audio: bool, requests_video: bool) -> bool {
    requests_audio && !requests_video
}

#[cfg(target_os = "linux")]
fn install_linux_microphone_permission_handler(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        use webkit2gtk::{
            glib::prelude::Cast, PermissionRequestExt, UserMediaPermissionRequest,
            UserMediaPermissionRequestExt, WebViewExt,
        };

        webview
            .inner()
            .connect_permission_request(|_, permission_request| {
                let Some(media_request) =
                    permission_request.downcast_ref::<UserMediaPermissionRequest>()
                else {
                    return false;
                };

                if microphone_request_is_allowed(
                    media_request.is_for_audio_device(),
                    media_request.is_for_video_device(),
                ) {
                    permission_request.allow();
                } else {
                    permission_request.deny();
                }
                true
            });
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "native-test")]
    let builder = if std::env::var("WDIO_EMBEDDED_SERVER").as_deref() == Ok("true") {
        builder.plugin(tauri_plugin_wdio_webdriver::init())
    } else {
        builder
    };

    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(NativeCloseState::default())
        .invoke_handler(tauri::generate_handler![
            native_audio_assets::audio_asset_store,
            native_audio_assets::audio_asset_read,
            native_audio_assets::audio_asset_verify,
            native_files::file_open_project,
            native_files::file_open_project_bundle,
            native_files::file_open_midi,
            native_files::file_open_audio,
            native_files::file_export_project,
            native_files::file_export_project_bundle,
            native_files::file_export_midi,
            native_files::file_export_wav,
            native_close::app_claim_close_request,
            native_close::app_finish_close,
            native_persistence::commands::persistence_initialize,
            native_persistence::commands::persistence_list,
            native_persistence::commands::persistence_load,
            native_persistence::commands::persistence_get_project_state,
            native_persistence::commands::persistence_load_branch,
            native_persistence::commands::persistence_load_most_recent,
            native_persistence::commands::persistence_stage_crash_draft,
            native_persistence::commands::persistence_save,
            native_persistence::commands::persistence_remove,
            native_persistence::commands::persistence_get_legacy_migration_status,
            native_persistence::commands::persistence_backup_legacy_snapshot,
            native_persistence::commands::persistence_import_legacy_project,
            native_persistence::commands::persistence_complete_legacy_migration,
            native_persistence::commands::persistence_get_erase_all_status,
            native_persistence::commands::persistence_prepare_erase_all,
            native_persistence::commands::persistence_complete_erase_all,
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(close_state) = window.app_handle().try_state::<NativeCloseState>() {
                    close_state.note_main_window_close_requested();
                }
            }
        })
        .setup(|app| {
            let database_path = native_persistence::database_path(app)?;
            let persistence_state = NativePersistenceState::acquire(database_path)?;
            if !app.manage(persistence_state) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "native persistence state was registered twice",
                )
                .into());
            }

            let main_window = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .expect("tauri.conf.json must define the main window");

            let _main_window = tauri::WebviewWindowBuilder::from_config(app, main_window)?
                // Native E2E must never reuse or mutate a developer's persisted
                // production WebView data. Incognito maps to an ephemeral store
                // on WKWebView, WebView2, and WebKitGTK.
                .incognito(cfg!(feature = "native-test"))
                // Tauri's `dev` cfg follows `tauri dev`, including `--release`.
                // `debug_assertions` would incorrectly reject that release-profile devUrl.
                .on_navigation(|url| navigation_is_allowed(url, cfg!(dev)))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;

            #[cfg(target_os = "linux")]
            install_linux_microphone_permission_handler(&_main_window)?;

            #[cfg(feature = "native-test")]
            native_test_close::install(_main_window)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Compose Tutor Studio");
}

#[cfg(test)]
mod tests {
    use super::{microphone_request_is_allowed, navigation_is_allowed};
    use tauri::Url;

    #[test]
    fn allows_only_bundled_and_exact_development_origins() {
        let bundled = Url::parse("tauri://localhost/index.html").unwrap();
        let bundled_windows = Url::parse("https://tauri.localhost/index.html").unwrap();
        let dev = Url::parse("http://127.0.0.1:5173/").unwrap();

        assert!(navigation_is_allowed(&bundled, false));
        assert!(navigation_is_allowed(&bundled_windows, false));
        assert!(navigation_is_allowed(&dev, true));
        assert!(!navigation_is_allowed(&dev, false));
    }

    #[test]
    fn rejects_remote_or_lookalike_origins() {
        for url in [
            "https://example.com/",
            "http://localhost:5173/",
            "http://127.0.0.1:5174/",
            "https://tauri.localhost.example.com/",
            "javascript:alert(1)",
        ] {
            assert!(
                !navigation_is_allowed(&Url::parse(url).unwrap(), true),
                "unexpectedly allowed {url}"
            );
        }
    }

    #[test]
    fn permits_only_audio_only_user_media_requests() {
        assert!(microphone_request_is_allowed(true, false));
        assert!(!microphone_request_is_allowed(false, false));
        assert!(!microphone_request_is_allowed(false, true));
        assert!(!microphone_request_is_allowed(true, true));
    }
}
