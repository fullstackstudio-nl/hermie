//! The Hermie desktop shell.
//!
//! One window, one webview, pointed at a Hermie Web instance — see
//! `docs/adr/0027-desktop-is-a-webview-over-hermie-web.md` for why this shape
//! and not a bundled export.
//!
//! What is here so far: the window (Task 1) and the bridge — the marker the
//! page feature-detects, the six commands it may call, and the origin guard that
//! decides whether the page asking is the app (Task 2, `bridge.rs`). The gateway
//! list's persistence and the connect page, the navigation policy,
//! notifications, the full menu and deep links are later tasks; each of the
//! stubbed commands names the one that finishes it.

mod bridge;
mod gateways;

use serde::Serialize;
use tauri::menu::{Menu, MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, EventTarget, Manager, Runtime, Webview, Wry};

use gateways::{GatewayList, GatewayState};

/// The version of the `window.__HERMIE_DESKTOP__` marker's own shape.
///
/// Separate from `bridge::BRIDGE_VERSION` on purpose: the marker says "a Hermie
/// shell is hosting this page, and here is which desktop", which the app uses to
/// decide whether to pause its socket and which modifier `command` means —
/// answers it needs even against a shell whose bridge it cannot reach. The
/// bridge version describes the commands. They can move independently.
const MARKER_VERSION: u32 = 1;

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(marker_plugin())
        .manage(GatewayState::new(GatewayList::from_env()))
        .invoke_handler(tauri::generate_handler![
            bridge::hermie_shell_info,
            bridge::hermie_set_menu,
            bridge::hermie_notify,
            bridge::hermie_set_badge,
            bridge::hermie_open_gateways,
            bridge::hermie_close_handled
        ]);

    // Desktop-only: the plugin does not build for the mobile targets Tauri
    // also supports (see the matching `[target.'cfg(...)'.dependencies]` in
    // Cargo.toml).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the running window rather than opening
            // a second one. Task 6 forwards the deep link a second launch's
            // argv carries on Windows/Linux through this same hook; Task 1
            // only needs the "one running instance" half.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;
            navigate_to_active_gateway(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Hermie desktop shell");
}

/// The marker the app page feature-detects, injected before any page script.
///
/// `window.__HERMIE_DESKTOP__ = { version, platform }`, and nothing else. The
/// app reads it through `apps/hermie/src/platform/desktop-shell.ts`, treats its
/// absence as "not in the shell", and treats every bridge call as optional.
///
/// A plugin because a window declared in `tauri.conf.json` has no place to hang
/// an initialization script, and `js_init_script` is the one hook that runs on
/// every top-level navigation — which is what this needs: the shell navigates
/// its one webview from the connect page to Hermie Web and, during a sign-in
/// chain, to an identity provider and back. A marker set once at startup would
/// be gone by the time the app page loaded.
///
/// **Top frame only.** `js_init_script` sets `for_main_frame_only: true`, and
/// the alternative (`js_init_script_on_all_frames`) would hand the marker to
/// every iframe the app page embeds. An iframe cannot reach the bridge either
/// way — the guard reads the WEBVIEW's URL, not the frame's, and a cross-origin
/// iframe has no path to `__TAURI_INTERNALS__` — but telling a third-party frame
/// that it is inside a desktop app is information it has no use for.
///
/// It runs on pages that are not the app, too: the identity provider's, the
/// connect page's. That is safe and is not an oversight. The marker is an
/// announcement, not a credential, and the thing that actually gates the bridge
/// is `bridge::guard`, which no script can influence.
fn marker_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let marker = serde_json::json!({
        "version": MARKER_VERSION,
        "platform": bridge::Platform::current(),
    });

    tauri::plugin::Builder::new("hermie-marker")
        .js_init_script(format!(
            "window.__HERMIE_DESKTOP__ = Object.freeze({marker});"
        ))
        .build()
}

/// Emit one of the shell's events to the app page — and only to the app page.
///
/// The counterpart of `bridge::guard`, and needed for the same reason: Tauri's
/// `emit` delivers to whatever is listening in that webview, and what is
/// listening depends on which page is loaded, which the shell changes on every
/// sign-in hop. Without this check a shortcut, a deep link or the name of the
/// active gateway would be delivered to an identity provider's page that had
/// registered a listener — and `capabilities/remote-app.json` grants
/// `core:event:allow-listen` to any http(s) origin, so registering one is
/// something any such page can do.
///
/// Silent when the current page is not a configured origin: there is no caller
/// to report to (the shell emits from a menu click or an OS event, not from a
/// request), and a dropped event is exactly the intended outcome.
///
/// Unused until Tasks 5 and 6 emit the four events; it lives here now because it
/// is the other half of this task's contract and the place where forgetting the
/// check would be invisible.
#[allow(dead_code)]
pub(crate) fn emit_to_app<R: Runtime, S: Serialize + Clone>(
    webview: &Webview<R>,
    event: &str,
    payload: S,
) {
    if !bridge::guard(webview) {
        return;
    }

    // Label-scoped rather than `emit`: `emit` reaches every webview in the app,
    // and "every webview" is a set this shell intends to keep at one but should
    // not depend on. `labeled` matches whatever kind of target the page's
    // `listen()` registered under this label, which is the page itself.
    let _ = webview.emit_to(EventTarget::labeled(webview.label()), event, payload);
}

/// Point the window at the active gateway, if there is one.
///
/// In Task 2 the list holds at most the one entry `HERMIE_WEB_URL` names, so
/// this is still the dev path Task 1 had — but it now goes through the same
/// `GatewayList` the origin guard reads, which is the property that matters:
/// the page the window is navigated to and the page the bridge trusts come from
/// one source. Task 3 replaces the list's contents, not this function's shape.
///
/// With nothing configured the window stays on the bundled `connect.html`
/// placeholder rather than opening blank.
fn navigate_to_active_gateway(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let Some(url) = app
        .state::<GatewayState>()
        .read(|list| list.active().map(|entry| entry.url.clone()))
        .flatten()
    else {
        return Ok(());
    };

    if let Some(window) = app.get_webview_window("main") {
        window.navigate(url)?;
    }

    Ok(())
}

/// The App and Edit menus.
///
/// Edit is not decorative: without native roles for Cut/Copy/Paste, ⌘C and
/// ⌘V never reach the webview at all (plan D6) — this is the one thing Task 1
/// must get right for the drag-select-and-copy acceptance criterion to mean
/// anything. The rest of the native menu (Gateway, Window, Help, the page's
/// own Chats section from `hermie_set_menu`) is Task 6; this is only enough
/// for the window to behave like an ordinary macOS app.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = SubmenuBuilder::new(app, "Hermie")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu])
        .build()
}
