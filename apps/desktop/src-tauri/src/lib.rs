//! The Hermie desktop shell (Task 1: scaffold only).
//!
//! One window, one webview, pointed at a Hermie Web instance — see
//! `docs/adr/0027-desktop-is-a-webview-over-hermie-web.md` for why this shape
//! and not a bundled export. Everything here beyond opening that window
//! (the gateway list, the bridge the app page can call, notifications, the
//! full menu) is later tasks; this module only proves the shell itself
//! stands up correctly on macOS.

use std::env;

use tauri::menu::{Menu, MenuBuilder, SubmenuBuilder};
use tauri::{Manager, Url, Wry};

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init());

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
            navigate_to_dev_url(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Hermie desktop shell");
}

/// Dev convenience only: `npm run desktop` and the fake-gateway integration
/// bed pass the Hermie Web address to point at through the environment. The
/// static window config (`tauri.conf.json`, `windows[0].url`) stays the
/// bundled `connect.html` placeholder, so a production build with nothing
/// set still opens to something rather than a blank window; Task 3 replaces
/// this whole function with the shell's own gateway list.
fn navigate_to_dev_url(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let Ok(dev_url) = env::var("HERMIE_WEB_URL") else {
        return Ok(());
    };
    let url = Url::parse(&dev_url)?;
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

    MenuBuilder::new(app).items(&[&app_menu, &edit_menu]).build()
}
